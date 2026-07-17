import { Context, h, type Session } from 'koishi'
import type { AgentNexusService } from './service'
import type { AgentKind, PublishResult } from './types'
import type { Config } from './config'
import { getErrorMessage } from './utils/shell'
import { splitMessage } from './utils/text'
import { resolveHostReference, routeCommandHost } from './utils/config'
import type { SessionIdentity } from './sessions/types'
import type { SessionRunOutcome } from './runtime/runner'
import { parseInteractiveCommandInput } from './utils/command'

const COMMANDS: Array<[name: string, agent: AgentKind, description: string]> = [
    ['nexus.hermes', 'hermes', '直接调用远端 Hermes Code Agent'],
    ['nexus.openclaw', 'openclaw', '直接调用远端 OpenClaw Code Agent'],
    ['nexus.claudecode', 'claude', '直接调用远端 Claude Code'],
    ['nexus.opencode', 'opencode', '直接调用远端 OpenCode'],
    ['nexus.codex', 'codex', '直接调用远端 Codex']
]

export function registerNexusCommands(
    ctx: Context,
    nexus: AgentNexusService,
    config: Config
) {
    const active = new Map<string, Set<AbortController>>()
    const commands: Array<{ dispose(): void }> = []
    let disposed = false
    const disposeMiddleware = ctx.middleware(async (session, next) => {
        if (checkAccess(session, config)) return next()
        const identity = sessionIdentity(session)
        let hasWaiting = false
        try {
            hasWaiting = await nexus.hasWaitingSession(identity)
        } catch (err) {
            ctx.logger.warn(
                `[agent-nexus] session lookup failed: ${getErrorMessage(err)}`
            )
            return next()
        }
        if (!hasWaiting) return next()
        if (!(await canResumeSession(ctx, session, config))) return next()

        const content = String(
            (session as any).stripped?.content ?? session.content ?? ''
        ).trim()
        if (
            !content ||
            isNexusCommand(content) ||
            Boolean((session as any).stripped?.prefix)
        ) {
            return next()
        }

        try {
            const outcome = await nexus.resumeSession(
                identity,
                content,
                undefined,
                { requestId: session.messageId, passive: true }
            )
            if (outcome.kind === 'not_found') return next()
            await sendSessionOutcome(session, outcome)
            return
        } catch (err) {
            ctx.logger.warn(
                `[agent-nexus] passive resume failed: ${getErrorMessage(err)}`
            )
            return next()
        }
    })

    const dispose = () => {
        if (disposed) return
        disposed = true
        disposeMiddleware()
        for (const command of commands.reverse()) command.dispose()
        for (const tasks of active.values()) {
            for (const controller of tasks) controller.abort()
        }
        active.clear()
    }

    for (const [name, agent, description] of COMMANDS) {
        const command = ctx
            .command(`${name} [prompt:text]`, description, {
                authority: config.commandAuthority
            })
            .option('host', '-H <host:string> 指定设备名称、地址或 ID（多机时也可直接写：名称 任务）')
            .option('cwd', '-C <cwd:string> 指定远端工作目录')
            .option('model', '-m <model:string> 指定模型')
            .option('timeout', '-t <seconds:posint> 超时时间（秒）')
            .option('openclawAgent', '-a <name:string> OpenClaw Agent 名称')
            .option('quit', '-q 退出当前 Agent 交互会话')
            .check(({ session }) => checkAccess(session, config))
            .action(async ({ session, options }, prompt) => {
                if (!session) return '当前会话不可用。'
                const identity = sessionIdentity(session)
                const opts = options ?? {}
                const { input, quit } = parseInteractiveCommandInput(
                    prompt,
                    opts.quit
                )
                const enabledHosts = nexus
                    .getConfig()
                    .hosts.filter((host) => host.enabled)
                let exactHost: (typeof enabledHosts)[number] | undefined
                try {
                    exactHost =
                        input && !opts.host
                            ? resolveHostReference(enabledHosts, input)
                            : undefined
                } catch (err) {
                    return getErrorMessage(err)
                }

                if (quit) {
                    let hostId: string | undefined
                    if (opts.host) {
                        let host: ReturnType<typeof resolveHostReference>
                        try {
                            host = resolveHostReference(
                                enabledHosts,
                                opts.host
                            )
                        } catch (err) {
                            return getErrorMessage(err)
                        }
                        if (!host) return `找不到设备：${opts.host}`
                        hostId = host.id
                    } else if (input) {
                        if (!exactHost) return `找不到设备：${input}`
                        hostId = exactHost.id
                    }
                    const ended = await nexus.endInteractiveSession(
                        identity,
                        agent,
                        hostId
                    )
                    return ended
                        ? `已退出 ${agent} 交互模式。`
                        : '当前没有匹配的 Agent 交互会话。'
                }

                if (!input || exactHost) {
                    try {
                        const started = await nexus.startInteractiveSession(
                            identity,
                            {
                                agent,
                                hostId: opts.host ?? exactHost?.id,
                                cwd: opts.cwd,
                                model: opts.model,
                                timeoutMs: opts.timeout
                                    ? opts.timeout * 1000
                                    : undefined,
                                openclawAgent: opts.openclawAgent,
                                publishFiles: true
                            }
                        )
                        return `已进入 ${started.hostName} / ${started.agent} 交互模式。之后发送的消息都会交给该 Agent；空闲 ${formatDuration(config.interactiveSessionTtlMs)} 后自动退出。使用 nexus ${agent} ${started.hostName} -q 可立即退出。`
                    } catch (err) {
                        return `进入交互模式失败：${getErrorMessage(err)}`
                    }
                }

                let route: ReturnType<typeof routeCommandHost>
                try {
                    route = routeCommandHost(
                        nexus.getConfig().hosts,
                        input,
                        opts.host
                    )
                } catch (err) {
                    return getErrorMessage(err)
                }
                const key = userTaskKey(session)
                const tasks = active.get(key) || new Set<AbortController>()
                if (tasks.size >= config.maxConcurrentPerUser) {
                    return `你已有 ${tasks.size} 个 Agent 任务正在执行，请先等待或使用 nexus.cancel。`
                }
                const controller = new AbortController()
                tasks.add(controller)
                active.set(key, tasks)
                await session.send(`正在调用 ${agent}，使用 nexus.cancel 可中止任务。`)
                try {
                    await executeNexusCommand(nexus, session, agent, route.prompt, {
                        hostId: route.hostId,
                        cwd: opts.cwd,
                        model: opts.model,
                        timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
                        openclawAgent: opts.openclawAgent,
                        signal: controller.signal
                    })
                } finally {
                    tasks.delete(controller)
                    if (!tasks.size) active.delete(key)
                }
            })

        commands.push(command)

        if (name === 'nexus.claudecode') command.alias('nexus.claude')
    }

    const cancelCommand = ctx.command('nexus.cancel', '中止当前用户正在执行的 Agent 任务', {
        authority: config.commandAuthority
    }).check(({ session }) => checkAccess(session, config)).action(async ({ session }) => {
        if (!session) return '当前会话不可用。'
        const tasks = active.get(userTaskKey(session))
        for (const controller of tasks || []) controller.abort()
        const runtimeCount = await nexus.cancelSessions(sessionIdentity(session))
        const count = Math.max(tasks?.size || 0, runtimeCount)
        if (!count) return '当前没有正在执行或等待输入的 Agent 任务。'
        return `已请求中止 ${count} 个 Agent 任务。`
    })
    commands.push(cancelCommand)
    return dispose
}

function checkAccess(session: Session | undefined, config: Config) {
    if (!session) return '当前会话不可用。'
    if (
        config.commandUsers.length &&
        !config.commandUsers.includes(session.userId || '')
    ) {
        return '你不在 AgentNexus 命令用户白名单中。'
    }
    if (
        config.commandChannels.length &&
        !config.commandChannels.includes(session.channelId || '')
    ) {
        return '当前频道不允许使用 AgentNexus 命令。'
    }
}

export async function executeNexusCommand(
    nexus: AgentNexusService,
    session: Session,
    agent: AgentKind,
    prompt: string,
    options: {
        hostId?: string
        cwd?: string
        model?: string
        timeoutMs?: number
        openclawAgent?: string
        signal?: AbortSignal
    } = {}
) {
    try {
        const outcome = await nexus.runInSession(
            sessionIdentity(session),
            {
                agent,
                prompt,
                publishFiles: true,
                ...options
            },
            { requestId: session.messageId }
        )
        await sendSessionOutcome(session, outcome)
    } catch (err) {
        await session.send(`AgentNexus 调用失败：${getErrorMessage(err)}`)
    }
}

async function sendSessionOutcome(
    session: Session,
    outcome: SessionRunOutcome
) {
    if (outcome.kind === 'cancelled') {
        await session.send(outcome.reply || 'Agent 任务已中止。')
        return
    }
    if (!outcome.result) {
        if (outcome.reply) await session.send(outcome.reply)
        return
    }

    const result = outcome.result
    const agent = result.agent

    const text = result.text.trim()
    if (text) {
        for (const chunk of splitMessage(text)) {
            await session.send(h.text(chunk))
        }
    } else {
        const status = result.timedOut
            ? `${agent} 执行超时。`
            : `${agent} 执行完成，没有返回文本。`
        await session.send(status)
    }

    for (const file of result.published || []) {
        await sendPublishedFile(session, file)
    }

    if (result.files.length && !result.published?.length) {
        await session.send('Agent 返回了文件路径，但文件未能发布。')
    }

    if (result.exitCode !== 0 && !result.timedOut) {
        await session.send(`${agent} 退出码：${result.exitCode}`)
    }
    if (result.truncated) {
        await session.send('Agent 输出超过捕获上限，以上内容已截断。')
    }
}

async function sendPublishedFile(session: Session, file: PublishResult) {
    if (!file.url) {
        await session.send(`文件 ${file.name} 发送失败：${file.error || '未知错误'}`)
        return
    }

    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) {
        await session.send(h.image(file.url, { title: file.name }))
    } else {
        await session.send(h.file(file.url, { filename: file.name }))
    }
}

function sessionIdentity(session: Session): SessionIdentity {
    return {
        userId: session.userId || '',
        channelId: session.channelId || '',
        platform: session.platform || 'unknown',
        selfId: session.selfId || ''
    }
}

function isNexusCommand(content: string) {
    return /^(?:[./!#]\s*)?nexus(?:\.|\s+)(?:hermes|openclaw|claude(?:code)?|opencode|codex|cancel)\b/i.test(
        content
    )
}

function userTaskKey(session: Session) {
    return JSON.stringify([
        session.platform || 'unknown',
        session.selfId || '',
        session.userId || ''
    ])
}

async function canResumeSession(
    ctx: Context,
    session: Session,
    config: Config
) {
    try {
        if (!session.user) await session.observeUser(['authority'])
        return await ctx.permissions.test(
            [`authority:${config.commandAuthority}`],
            session
        )
    } catch {
        return false
    }
}

function formatDuration(ms: number) {
    if (ms % 60000 === 0) return `${ms / 60000} 分钟`
    return `${Math.ceil(ms / 1000)} 秒`
}
