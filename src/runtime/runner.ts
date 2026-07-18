import type {
    AgentProviderState,
    AgentResult,
    DelegateInput,
    PublishResult
} from '../types'
import { SessionManager } from '../sessions/manager'
import type {
    NexusSession,
    SessionEndReason,
    SessionIdentity
} from '../sessions/types'
import {
    buildSessionContinuationPrompt,
    buildSessionPrompt
} from './prompt'
import {
    formatPendingAction,
    parseAgentControl,
    resolvePendingAction,
    stripAgentControl
} from './protocol'

export type DelegateResult = AgentResult & {
    published?: PublishResult[]
    hostId: string
}

export interface SessionRunOutcome {
    kind:
        | 'completed'
        | 'waiting'
        | 'failed'
        | 'busy'
        | 'invalid_input'
        | 'not_found'
        | 'ambiguous'
        | 'cancelled'
    session?: NexusSession
    result?: DelegateResult
    reply?: string
    created?: boolean
}

export interface SessionInvocationContext {
    requestId?: string
    passive?: boolean
}

type StoredExecution = Omit<DelegateInput, 'prompt' | 'signal'>

export class AgentRunner {
    private active = new Map<string, AbortController>()
    private abortReasons = new Map<string, SessionEndReason>()
    private completions = new Map<
        string,
        { promise: Promise<void>; resolve: () => void }
    >()

    constructor(
        private sessions: SessionManager,
        private execute: (input: DelegateInput) => Promise<DelegateResult>
    ) {}

    async run(
        identity: SessionIdentity,
        input: DelegateInput,
        context: SessionInvocationContext = {}
    ): Promise<SessionRunOutcome> {
        const resolution = await this.sessions.resolve({
            ...identity,
            agent: input.agent,
            create: {
                agent: input.agent ?? 'auto',
                status: 'running',
                data: { execution: executionOptions(input) }
            }
        })
        const session = resolution.session!

        if (!resolution.created && session.status === 'running') {
            return {
                kind: 'busy',
                session,
                created: false,
                reply: '当前任务仍在执行，请等待完成或使用 nexus.cancel。'
            }
        }

        return this.continueSession(
            session,
            input.prompt,
            input,
            resolution.created,
            context
        )
    }

    async resume(
        identity: SessionIdentity,
        message: string,
        signal?: AbortSignal,
        context: SessionInvocationContext = {}
    ): Promise<SessionRunOutcome> {
        const resolution = await this.sessions.resolve({
            ...identity,
            createIfMissing: false,
            statuses: context.passive
                ? ['waiting_confirm', 'waiting_input']
                : ['running', 'waiting_confirm', 'waiting_input']
        })
        if (resolution.ambiguous) {
            return {
                kind: 'ambiguous',
                reply: '当前有多个待处理的 Agent 会话，请使用对应的 nexus.* 命令继续。'
            }
        }
        if (!resolution.session) {
            const interactive = context.passive
                ? await this.findInteractive(identity)
                : undefined
            if (interactive?.status === 'running') {
                return {
                    kind: 'busy',
                    session: interactive,
                    reply: '当前交互会话仍在执行，请稍候。'
                }
            }
            return { kind: 'not_found' }
        }
        if (resolution.session.status === 'running') {
            return {
                kind: 'busy',
                session: resolution.session,
                reply: '当前任务仍在执行，请稍候。'
            }
        }

        const stored = storedExecution(resolution.session)
        return this.continueSession(
            resolution.session,
            message,
            { ...stored, prompt: message, signal },
            false,
            context
        )
    }

    async startInteractive(
        identity: SessionIdentity,
        input: Omit<DelegateInput, 'prompt' | 'signal'>,
        ttlMs: number
    ) {
        const activeSessions = (
            await this.sessions.findByUser(identity.userId)
        ).filter(
            (session) =>
                sameIdentity(session, identity) &&
                (session.status === 'running' ||
                    session.status === 'waiting_confirm' ||
                    session.status === 'waiting_input')
        )
        if (activeSessions.some((session) => session.status === 'running')) {
            throw new Error('当前 Agent 任务仍在执行，请等待完成或使用 nexus.cancel。')
        }
        for (const session of activeSessions) {
            await this.sessions.archive(session, 'failed', 'replaced')
        }

        return this.sessions.create({
            ...identity,
            agent: input.agent ?? 'auto',
            status: 'waiting_input',
            pendingAction: {
                type: 'input',
                prompt: ''
            },
            data: {
                interactive: true,
                ttlMs,
                execution: executionOptions({
                    ...input,
                    prompt: '',
                    publishFiles: input.publishFiles ?? true,
                    sessionMode: 'managed'
                })
            }
        })
    }

    async endInteractive(
        identity: SessionIdentity,
        agent?: DelegateInput['agent'],
        hostId?: string
    ) {
        const sessions = (await this.sessions.findByUser(identity.userId)).filter(
            (session) =>
                sameIdentity(session, identity) &&
                session.data?.interactive === true &&
                (session.status === 'running' ||
                    session.status === 'waiting_confirm' ||
                    session.status === 'waiting_input') &&
                (!agent || agent === 'auto' || session.agent === agent) &&
                (!hostId || storedExecution(session).hostId === hostId)
        )
        let ended = 0
        for (const session of sessions) {
            const controller = this.active.get(session.id)
            if (controller) {
                this.abortReasons.set(session.id, 'user_exit')
                controller.abort()
                await this.sessions.archive(
                    markCancelled(session, 'user_exit'),
                    'completed',
                    'user_exit'
                )
            } else {
                await this.sessions.archive(session, 'completed', 'user_exit')
            }
            ended += 1
        }
        return ended
    }

    async hasWaiting(identity: SessionIdentity) {
        const resolution = await this.sessions.resolve({
            ...identity,
            createIfMissing: false,
            statuses: ['waiting_confirm', 'waiting_input']
        })
        if (resolution.session || resolution.ambiguous) return true
        return (await this.findInteractive(identity))?.status === 'running'
    }

    private async findInteractive(
        identity: SessionIdentity,
        agent?: DelegateInput['agent']
    ) {
        return (await this.sessions.findByUser(identity.userId)).find(
            (session) =>
                sameIdentity(session, identity) &&
                session.data?.interactive === true &&
                (session.status === 'running' ||
                    session.status === 'waiting_confirm' ||
                    session.status === 'waiting_input') &&
                (!agent || agent === 'auto' || session.agent === agent)
        )
    }

    async cancel(identity: SessionIdentity) {
        const sessions = (await this.sessions.findByUser(identity.userId)).filter(
            (session) =>
                session.platform === identity.platform &&
                session.selfId === (identity.selfId ?? '') &&
                (session.channelId === identity.channelId ||
                    session.channelId.startsWith(
                        `${identity.channelId}#chatluna:`
                    )) &&
                (session.status === 'running' ||
                    session.status === 'waiting_confirm' ||
                    session.status === 'waiting_input')
        )
        let cancelled = 0
        for (const session of sessions) {
            const controller = this.active.get(session.id)
            if (controller) {
                this.abortReasons.set(session.id, 'cancelled')
                controller.abort()
                await this.sessions.archive(
                    markCancelled(session, 'cancelled'),
                    'failed',
                    'cancelled'
                )
                cancelled += 1
                continue
            }
            const claimed = await this.sessions.claim(
                session.id,
                [session.status],
                (draft) => markCancelled(draft, 'cancelled')
            )
            if (claimed) cancelled += 1
        }
        return cancelled
    }

    async shutdown(timeoutMs = 5000) {
        const controllers = Array.from(this.active.entries())
        for (const [sessionId, controller] of controllers) {
            this.abortReasons.set(sessionId, 'cancelled')
            controller.abort()
        }
        const pending = controllers
            .map(([sessionId]) => this.completions.get(sessionId)?.promise)
            .filter((promise): promise is Promise<void> => Boolean(promise))
        if (pending.length) {
            await Promise.race([
                Promise.allSettled(pending),
                new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
            ])
        }
        return controllers.length
    }

    private async continueSession(
        session: NexusSession,
        message: string,
        input: DelegateInput,
        created: boolean,
        context: SessionInvocationContext
    ): Promise<SessionRunOutcome> {
        if (
            !created &&
            context.requestId &&
            session.data?.lastRequestId === context.requestId &&
            session.pendingAction
        ) {
            return {
                kind: 'waiting',
                session,
                reply: formatPendingAction(session.pendingAction),
                created: false
            }
        }

        let resumeAction: unknown
        if (!created && session.pendingAction) {
            const resolved = resolvePendingAction(session.pendingAction, message)
            if (!resolved.matched) {
                if (context.passive) return { kind: 'not_found' }
                const refreshed = await this.sessions.claim(
                    session.id,
                    [session.status],
                    (draft) => draft
                )
                return {
                    kind: 'invalid_input',
                    session: refreshed ?? session,
                    reply: resolved.error ?? formatPendingAction(session.pendingAction)
                }
            }
            resumeAction = {
                type: session.pendingAction.type,
                prompt: session.pendingAction.prompt,
                input: message,
                label: resolved.label,
                value: resolved.value,
                data: session.pendingAction.data
            }
            if (
                session.pendingAction.type === 'confirm' &&
                Boolean(
                    session.pendingAction.data &&
                        typeof session.pendingAction.data === 'object' &&
                        'interruptedAt' in session.pendingAction.data
                ) &&
                resolved.value === false
            ) {
                const cancelled = await this.sessions.claim(
                    session.id,
                    [session.status],
                    (draft) => {
                        draft.messages.push({
                            role: 'user',
                            content: message,
                            createdAt: Date.now()
                        })
                        return markCancelled(draft, 'cancelled')
                    }
                )
                return {
                    kind: 'cancelled',
                    session: cancelled ?? session,
                    reply: '已取消重启后待恢复的任务。',
                    created: false
                }
            }
        }

        const providerState = asProviderState(session.data?.providerState)
        const execution: StoredExecution = {
            ...storedExecution(session),
            ...(providerState ? { providerState } : {}),
            ...executionOptions(input)
        }
        const prepare = (draft: NexusSession) => {
            const { resumeAction: _previous, lastError: _error, ...data } =
                draft.data ?? {}
            draft.status = 'running'
            draft.pendingAction = undefined
            draft.data = {
                ...data,
                execution,
                ...(context.requestId
                    ? { lastRequestId: context.requestId }
                    : {}),
                ...(resumeAction === undefined ? {} : { resumeAction })
            }
            draft.messages.push({
                role: 'user',
                content: message,
                createdAt: Date.now(),
                data: resumeAction
            })
            return draft
        }
        const claimed = await this.sessions.claim(
            session.id,
            [session.status],
            prepare
        )
        if (!claimed) {
            return {
                kind: 'busy',
                reply: '当前会话已被另一条消息继续，请稍候。'
            }
        }
        session = claimed

        const controller = new AbortController()
        const abort = () => controller.abort()
        if (input.signal?.aborted) controller.abort()
        else input.signal?.addEventListener('abort', abort, { once: true })
        this.active.set(session.id, controller)
        let complete!: () => void
        const completion = new Promise<void>((resolve) => {
            complete = resolve
        })
        this.completions.set(session.id, {
            promise: completion,
            resolve: complete
        })

        try {
            const useNativeContinuation =
                session.agent === 'hermes' &&
                execution.sessionMode === 'managed' &&
                typeof execution.providerState?.sessionId === 'string'
            const result = await this.execute({
                ...execution,
                prompt: useNativeContinuation
                    ? buildSessionContinuationPrompt(session)
                    : buildSessionPrompt(session),
                signal: controller.signal
            })
            session.agent = result.agent
            const control = parseAgentControl(result)

            if (controller.signal.aborted || result.exitCode === 130) {
                const reason = this.abortReasons.get(session.id) ?? 'cancelled'
                session = await this.sessions.archive(
                    markCancelled(session, reason),
                    reason === 'user_exit' ? 'completed' : 'failed',
                    reason
                )
                return {
                    kind: 'cancelled',
                    session,
                    result: { ...result, text: '' },
                    reply: 'Agent 任务已中止。',
                    created
                }
            }

            if (
                control?.status === 'waiting_confirm' ||
                control?.status === 'waiting_input'
            ) {
                const pendingAction = control.pendingAction!
                const reply = waitingReply(result.text, pendingAction)
                session.status = control.status
                session.pendingAction = pendingAction
                session.taskId = control.taskId ?? session.taskId
                session.data = resultSessionData(session, result, control.data)
                session.messages.push({
                    role: 'assistant',
                    content: reply,
                    createdAt: Date.now(),
                    data: { control }
                })
                session = await this.sessions.update(session)
                return {
                    kind: 'waiting',
                    session,
                    result: { ...result, text: reply },
                    reply,
                    created
                }
            }

            const failed =
                control?.status === 'failed' ||
                result.timedOut ||
                result.exitCode !== 0
            const text =
                control?.output ??
                control?.error ??
                result.text ??
                (failed ? 'Agent task failed.' : '')
            const interactive = session.data?.interactive === true
            session.status = failed
                ? 'failed'
                : interactive
                  ? 'waiting_input'
                  : 'completed'
            session.taskId = control?.taskId ?? session.taskId
            session.pendingAction =
                !failed && interactive
                    ? { type: 'input', prompt: '' }
                    : undefined
            session.data = resultSessionData(
                session,
                result,
                control?.data,
                failed ? text : undefined
            )
            session.messages.push({
                role: 'assistant',
                content: text,
                createdAt: Date.now(),
                data: control ? { control } : undefined
            })
            session = await this.sessions.update(session)
            return {
                kind: failed ? 'failed' : 'completed',
                session,
                result: { ...result, text },
                reply: text,
                created
            }
        } catch (error) {
            if (controller.signal.aborted) {
                const reason = this.abortReasons.get(session.id) ?? 'cancelled'
                session = await this.sessions.archive(
                    markCancelled(session, reason),
                    reason === 'user_exit' ? 'completed' : 'failed',
                    reason
                )
                return {
                    kind: 'cancelled',
                    session,
                    reply: 'Agent 任务已中止。',
                    created
                }
            }
            session.status = 'failed'
            session.pendingAction = undefined
            session.data = {
                ...(session.data ?? {}),
                lastError: error instanceof Error ? error.message : String(error)
            }
            await this.sessions.update(session)
            throw error
        } finally {
            input.signal?.removeEventListener('abort', abort)
            if (this.active.get(session.id) === controller) {
                this.active.delete(session.id)
            }
            this.abortReasons.delete(session.id)
            const tracked = this.completions.get(session.id)
            tracked?.resolve()
            this.completions.delete(session.id)
        }
    }
}

function executionOptions(input: DelegateInput): StoredExecution {
    const options: StoredExecution = {
        hostId: input.hostId,
        agent: input.agent,
        cwd: input.cwd,
        model: input.model,
        timeoutMs: input.timeoutMs,
        openclawAgent: input.openclawAgent,
        publishFiles: input.publishFiles,
        sessionMode: input.sessionMode,
        providerState: input.providerState
    }
    for (const key of Object.keys(options) as Array<keyof StoredExecution>) {
        if (options[key] === undefined) delete options[key]
    }
    return options
}

function storedExecution(session: NexusSession): StoredExecution {
    const execution = session.data?.execution
    if (!execution || typeof execution !== 'object') {
        return { agent: session.agent as DelegateInput['agent'] }
    }
    return structuredClone(execution) as StoredExecution
}

function resultSummary(result: DelegateResult) {
    return {
        agent: result.agent,
        hostId: result.hostId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        files: result.files,
        published: result.published
    }
}

function resultSessionData(
    session: NexusSession,
    result: DelegateResult,
    skillState?: unknown,
    lastError?: string
) {
    const { resumeAction: _used, lastError: _oldError, ...data } =
        session.data ?? {}
    return {
        ...data,
        ...(skillState === undefined ? {} : { skillState }),
        ...(result.providerState
            ? {
                  providerState: {
                      ...((data.providerState as Record<string, unknown>) ?? {}),
                      ...result.providerState
                  }
              }
            : {}),
        lastResult: resultSummary(result),
        ...(lastError ? { lastError } : {})
    }
}

function sameIdentity(session: NexusSession, identity: SessionIdentity) {
    return (
        session.userId === identity.userId &&
        session.channelId === identity.channelId &&
        session.platform === identity.platform &&
        session.selfId === (identity.selfId ?? '')
    )
}

function asProviderState(value: unknown): AgentProviderState | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }
    return value as AgentProviderState
}

function markCancelled(session: NexusSession, reason: SessionEndReason) {
    const { resumeAction: _used, ...data } = session.data ?? {}
    session.status = 'failed'
    session.pendingAction = undefined
    session.endReason = reason
    session.data = { ...data, lastError: reason }
    session.messages.push({
        role: 'assistant',
        content: reason === 'user_exit' ? '交互会话已退出。' : 'Agent 任务已中止。',
        createdAt: Date.now()
    })
    return session
}

function waitingReply(text: string, action: NexusSession['pendingAction']) {
    const visible = stripAgentControl(text)
    const pending = formatPendingAction(action!)
    if (!visible) return pending
    if (visible.includes(pending)) return visible
    if (visible.includes(action!.prompt)) return visible
    if (
        action!.options?.length &&
        action!.options.every((option) => visible.includes(option.label))
    ) {
        return [visible, action!.prompt].filter(Boolean).join('\n')
    }
    return [visible, pending].filter(Boolean).join('\n')
}
