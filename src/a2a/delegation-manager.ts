import { randomUUID } from 'crypto'
import type {
    A2ARemoteStatus,
    A2ATaskView
} from '../types'
import type { A2ASendInput } from './client'
import {
    A2ADelegationStore,
    type A2ADelegationContext,
    type A2ADelegationState,
    type A2ADelegationTask
} from './delegation-store'

export type A2ADelegateAction =
    | 'run'
    | 'status'
    | 'list'
    | 'agents'
    | 'message'
    | 'stop'

export interface A2ADelegateToolInput {
    action?: A2ADelegateAction
    remote?: string
    id?: string
    prompt?: string
    background?: boolean
    newTask?: boolean
    skill?: string
}

export interface A2ADelegationBackend {
    listRemotes(): A2ARemoteStatus[]
    resolveRemoteId(reference: string): string
    send(remoteId: string, input: A2ASendInput): Promise<A2ATaskView>
    get(remoteId: string, taskId: string): Promise<A2ATaskView>
    cancel(remoteId: string, taskId: string): Promise<A2ATaskView>
    discover?(remoteId: string): Promise<void>
    notify(task: A2ADelegationTask): Promise<void>
}

interface A2ADelegationManagerOptions {
    pollIntervalMs?: number
    activeTtlMs?: number
    retentionMs?: number
    now?: () => number
}

interface ActiveMonitor {
    controller: AbortController
    promise: Promise<void>
}

const DEFAULT_ACTIVE_TTL = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION = 7 * 24 * 60 * 60 * 1000
const MAX_STORED_PROMPT_CHARS = 64 * 1024
const MAX_STORED_OUTPUT_CHARS = 256 * 1024
const MAX_STORED_ARTIFACTS = 64
export class A2ADelegationManager {
    private readonly pollIntervalMs: number
    private readonly activeTtlMs: number
    private readonly retentionMs: number
    private readonly now: () => number
    private monitors = new Map<string, ActiveMonitor>()
    private stopped = true

    constructor(
        private readonly store: A2ADelegationStore,
        private readonly backend: A2ADelegationBackend,
        options: A2ADelegationManagerOptions = {}
    ) {
        this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 2000)
        this.activeTtlMs = Math.max(60_000, options.activeTtlMs ?? DEFAULT_ACTIVE_TTL)
        this.retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_RETENTION)
        this.now = options.now ?? Date.now
    }

    async start() {
        this.stopped = false
        await this.store.init()
        for (const task of await this.store.list()) {
            if (task.state === 'running') {
                this.startMonitor(task.id)
            } else if (shouldNotify(task)) {
                void this.notifyTask(task.id)
            }
        }
    }

    async stop() {
        this.stopped = true
        const monitors = Array.from(this.monitors.values())
        for (const monitor of monitors) monitor.controller.abort()
        await Promise.allSettled(monitors.map((monitor) => monitor.promise))
        this.monitors.clear()
        await this.store.flush()
    }

    async handle(
        input: A2ADelegateToolInput,
        context: A2ADelegationContext,
        signal?: AbortSignal
    ) {
        const action = input.action ?? 'run'
        if (action === 'agents') return this.formatAgents()
        if (action === 'list') return this.formatList(context)
        if (action === 'status') return this.status(input.id, context)
        if (action === 'stop') return this.stopTask(input.id, context)
        if (action === 'message') {
            return this.messageTask(input, context, signal)
        }
        return this.runTask(input, context, signal)
    }

    private async runTask(
        input: A2ADelegateToolInput,
        context: A2ADelegationContext,
        signal?: AbortSignal
    ) {
        const prompt = requiredPrompt(input.prompt)
        if (input.id) {
            const task = await this.ownedTask(input.id, context)
            return this.sendTurn(
                task,
                prompt,
                input,
                signal,
                task.state === 'waiting_input'
            )
        }

        const remote = await this.resolveRemote(input, context)
        const tasks = (await this.store.list(context.parentConversationId)).filter(
            (task) => task.remoteId === remote.id
        )
        if (!input.newTask) {
            const waiting = tasks.find((task) => task.state === 'waiting_input')
            if (waiting) {
                return this.sendTurn(waiting, prompt, input, signal, true)
            }
            const running = tasks.find((task) => task.state === 'running')
            if (running) return formatRunning(running)
        }

        const previous = input.newTask
            ? undefined
            : tasks.find((task) => Boolean(task.contextId))
        const now = this.now()
        const task: A2ADelegationTask = {
            schemaVersion: 1,
            id: randomUUID(),
            remoteId: remote.id,
            remoteName: remote.name,
            parentConversationId: context.parentConversationId,
            source: context.source,
            routing: structuredClone(context.routing),
            state: 'running',
            background: input.background !== false,
            prompt: clip(prompt, MAX_STORED_PROMPT_CHARS),
            skill: clean(input.skill),
            contextId: previous?.contextId,
            artifacts: [],
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            expiresAt: now + this.activeTtlMs
        }
        await this.store.save(task)
        return this.sendTurn(task, prompt, input, signal, false)
    }

    private async messageTask(
        input: A2ADelegateToolInput,
        context: A2ADelegationContext,
        signal?: AbortSignal
    ) {
        const prompt = requiredPrompt(input.prompt)
        const task = input.id
            ? await this.ownedTask(input.id, context)
            : await this.latestTask(context, ['waiting_input', 'running'])
        if (!task) {
            throw new Error('No active A2A background task is bound to this conversation.')
        }
        return this.sendTurn(
            task,
            prompt,
            input,
            signal,
            task.state === 'running' || task.state === 'waiting_input'
        )
    }

    private async sendTurn(
        original: A2ADelegationTask,
        prompt: string,
        input: A2ADelegateToolInput,
        signal: AbortSignal | undefined,
        sameTask: boolean
    ) {
        if (
            original.state === 'running' &&
            original.activeRunId &&
            input.action !== 'message'
        ) {
            return formatRunning(original)
        }
        this.stopMonitor(original.id)
        const now = this.now()
        const background = input.background !== false
        const resetContext = Boolean(input.newTask)
        let task: A2ADelegationTask = {
            ...original,
            background,
            prompt: clip(prompt, MAX_STORED_PROMPT_CHARS),
            skill: clean(input.skill) ?? original.skill,
            state: 'running',
            remoteState: undefined,
            output: undefined,
            error: undefined,
            pollError: undefined,
            artifacts: [],
            a2aTaskId: resetContext ? undefined : original.a2aTaskId,
            contextId: resetContext ? undefined : original.contextId,
            activeRunId: randomUUID(),
            startedAt: now,
            updatedAt: now,
            endedAt: undefined,
            expiresAt: now + this.activeTtlMs
        }
        await this.store.save(task)

        try {
            const view = await this.backend.send(task.remoteId, {
                text: prompt,
                taskId: sameTask && !resetContext ? task.a2aTaskId : undefined,
                contextId: task.contextId,
                returnImmediately: background,
                metadata: {
                    ...(task.skill
                        ? { skill: task.skill, skillId: task.skill }
                        : {})
                }
            })
            task = applyView(task, view, this.now(), this.retentionMs)
            if (task.state === 'running' && background) {
                await this.store.save(task)
                this.startMonitor(task.id)
                return formatRunning(task)
            }
            task.notifiedRunId = task.activeRunId
            await this.store.save(task)
            return formatTask(task)
        } catch (error) {
            if (
                original.state === 'running' ||
                original.state === 'waiting_input'
            ) {
                const restored: A2ADelegationTask = {
                    ...original,
                    pollError: clip(errorMessage(error), 32 * 1024),
                    updatedAt: this.now()
                }
                await this.store.save(restored)
                if (restored.state === 'running' && restored.background) {
                    this.startMonitor(restored.id)
                }
                throw error
            }
            task.state = 'failed'
            task.error = clip(errorMessage(error), 32 * 1024)
            task.endedAt = this.now()
            task.updatedAt = task.endedAt
            task.expiresAt = task.endedAt + this.retentionMs
            task.notifiedRunId = task.activeRunId
            await this.store.save(task)
            throw error
        }
    }

    private async status(id: string | undefined, context: A2ADelegationContext) {
        let task = id
            ? await this.ownedTask(id, context)
            : await this.latestTask(context)
        if (!task) return 'No A2A tasks are bound to this conversation.'
        if (task.state === 'running' && task.a2aTaskId) {
            try {
                const runId = task.activeRunId
                const view = await this.backend.get(task.remoteId, task.a2aTaskId)
                const current = await this.store.get(task.id)
                if (!current || current.activeRunId !== runId) {
                    return current ? formatTask(current) : 'A2A task no longer exists.'
                }
                task = applyView(current, view, this.now(), this.retentionMs)
                if (task.state !== 'running') {
                    task.notifiedRunId = task.activeRunId
                    this.stopMonitor(task.id)
                }
                await this.store.save(task)
            } catch (error) {
                task.pollError = clip(errorMessage(error), 32 * 1024)
                task.updatedAt = this.now()
                await this.store.save(task)
            }
        }
        return formatTask(task)
    }

    private async stopTask(
        id: string | undefined,
        context: A2ADelegationContext
    ) {
        let task = id
            ? await this.ownedTask(id, context)
            : await this.latestTask(context, ['running', 'waiting_input'])
        if (!task) return 'No active A2A task is bound to this conversation.'
        this.stopMonitor(task.id)
        if (task.a2aTaskId && task.state !== 'completed') {
            try {
                const view = await this.backend.cancel(task.remoteId, task.a2aTaskId)
                task = applyView(task, view, this.now(), this.retentionMs)
            } catch (error) {
                task.error = clip(errorMessage(error), 32 * 1024)
            }
        }
        const now = this.now()
        task.state = 'canceled'
        task.remoteState ||= 'TASK_STATE_CANCELED'
        task.endedAt = now
        task.updatedAt = now
        task.expiresAt = now + this.retentionMs
        task.notifiedRunId = task.activeRunId
        await this.store.save(task)
        return formatTask(task)
    }

    private async formatList(context: A2ADelegationContext) {
        const tasks = await this.store.list(context.parentConversationId)
        if (!tasks.length) return 'No A2A tasks are bound to this conversation.'
        return [
            'A2A tasks:',
            ...tasks.slice(0, 20).map(
                (task) =>
                    `- ${task.id} [${task.state}] ${task.remoteName} (${task.background ? 'background' : 'foreground'})`
            ),
            '',
            'Use nexus_a2a_delegate action=status id=... or action=stop id=...'
        ].join('\n')
    }

    private async formatAgents() {
        await this.discoverUnknownRemotes()
        const remotes = this.backend.listRemotes().filter((remote) => remote.enabled)
        if (!remotes.length) return 'No enabled A2A agents are configured.'
        return remotes
            .map((remote) => {
                const skills = remote.card?.skills || []
                return [
                    `${remote.name} (${remote.id}) [${remote.state}]`,
                    remote.card?.description
                        ? `  ${remote.card.description}`
                        : undefined,
                    skills.length
                        ? `  skills: ${skills.map((skill) => `${skill.id} - ${skill.description}`).join('; ')}`
                        : '  skills: not discovered'
                ]
                    .filter(Boolean)
                    .join('\n')
            })
            .join('\n\n')
    }

    private async resolveRemote(
        input: A2ADelegateToolInput,
        context: A2ADelegationContext
    ) {
        if (input.skill) await this.discoverUnknownRemotes()
        const remotes = this.backend.listRemotes().filter((remote) => remote.enabled)
        if (input.remote) {
            const id = this.backend.resolveRemoteId(input.remote)
            const remote = remotes.find((item) => item.id === id)
            if (!remote) throw new Error(`A2A remote is disabled: ${input.remote}`)
            return remote
        }

        const previous = (await this.store.list(context.parentConversationId)).find(
            (task) => remotes.some((remote) => remote.id === task.remoteId)
        )
        if (previous) {
            const remote = remotes.find((item) => item.id === previous.remoteId)
            if (remote && (!input.skill || remoteMatchesSkill(remote, input.skill))) {
                return remote
            }
        }

        if (input.skill) {
            const matches = remotes.filter((remote) =>
                remoteMatchesSkill(remote, input.skill!)
            )
            if (matches.length === 1) return matches[0]
            if (matches.length > 1) {
                throw new Error(
                    `Multiple A2A agents expose skill ${input.skill}: ${matches
                        .map((item) => item.name)
                        .join(', ')}. Specify remote.`
                )
            }
        }
        if (remotes.length === 1) return remotes[0]
        if (!remotes.length) throw new Error('No enabled A2A agents are configured.')
        throw new Error(
            `Multiple A2A agents are available: ${remotes
                .map((item) => item.name)
                .join(', ')}. Specify remote or skill.`
        )
    }

    private async latestTask(
        context: A2ADelegationContext,
        states?: A2ADelegationState[]
    ) {
        return (await this.store.list(context.parentConversationId)).find(
            (task) => !states || states.includes(task.state)
        )
    }

    private async discoverUnknownRemotes() {
        if (!this.backend.discover) return
        const pending = this.backend
            .listRemotes()
            .filter(
                (remote) =>
                    remote.enabled &&
                    (!remote.card || remote.state === 'unknown' || remote.state === 'error')
            )
        await Promise.allSettled(
            pending.map((remote) => this.backend.discover!(remote.id))
        )
    }

    private async ownedTask(id: string, context: A2ADelegationContext) {
        const task = await this.store.get(id)
        if (!task || task.parentConversationId !== context.parentConversationId) {
            throw new Error(`A2A task is not available in this conversation: ${id}`)
        }
        return task
    }

    private startMonitor(id: string) {
        if (this.stopped || this.monitors.has(id)) return
        const controller = new AbortController()
        const promise = this.monitor(id, controller.signal).finally(() => {
            if (this.monitors.get(id)?.controller === controller) {
                this.monitors.delete(id)
            }
        })
        this.monitors.set(id, { controller, promise })
    }

    private stopMonitor(id: string) {
        this.monitors.get(id)?.controller.abort()
    }

    private async monitor(id: string, signal: AbortSignal) {
        await delay(this.pollIntervalMs, signal)
        while (!this.stopped && !signal.aborted) {
            const task = await this.store.get(id)
            if (!task || task.state !== 'running') return
            if (task.expiresAt <= this.now()) {
                task.state = 'failed'
                task.error = 'A2A background task monitoring expired.'
                task.endedAt = this.now()
                task.updatedAt = task.endedAt
                task.expiresAt = task.endedAt + this.retentionMs
                await this.store.save(task)
                await this.notifyTask(task.id)
                return
            }
            if (!task.a2aTaskId) {
                task.state = 'failed'
                task.error = 'A2A remote did not return a task id.'
                task.endedAt = this.now()
                task.updatedAt = task.endedAt
                task.expiresAt = task.endedAt + this.retentionMs
                await this.store.save(task)
                await this.notifyTask(task.id)
                return
            }
            try {
                const runId = task.activeRunId
                const view = await this.backend.get(task.remoteId, task.a2aTaskId)
                const current = await this.store.get(id)
                if (
                    !current ||
                    current.state !== 'running' ||
                    current.activeRunId !== runId
                ) {
                    return
                }
                const updated = applyView(
                    current,
                    view,
                    this.now(),
                    this.retentionMs
                )
                updated.pollError = undefined
                await this.store.save(updated)
                if (updated.state !== 'running') {
                    await this.notifyTask(updated.id)
                    return
                }
            } catch (error) {
                const current = await this.store.get(id)
                if (
                    !current ||
                    current.state !== 'running' ||
                    current.activeRunId !== task.activeRunId
                ) {
                    return
                }
                current.pollError = clip(errorMessage(error), 32 * 1024)
                current.updatedAt = this.now()
                await this.store.save(current)
            }
            await delay(this.pollIntervalMs, signal)
        }
    }

    private async notifyTask(id: string) {
        let task = await this.store.get(id)
        if (!task || !shouldNotify(task)) return
        const runId = task.activeRunId
        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await this.backend.notify(task)
                const current = await this.store.get(id)
                if (!current || current.activeRunId !== runId) return
                task = current
                task.notifiedRunId = runId
                task.pollError = undefined
                task.updatedAt = this.now()
                await this.store.save(task)
                return
            } catch (error) {
                lastError = error
                if (attempt < 2) await delay(1000 * (attempt + 1))
            }
        }
        task.pollError = `ChatLuna wakeup failed: ${errorMessage(lastError)}`
        task.updatedAt = this.now()
        await this.store.save(task)
    }
}

function applyView(
    task: A2ADelegationTask,
    view: A2ATaskView,
    now: number,
    retentionMs: number
) {
    const state = delegationState(view.state)
    return {
        ...task,
        a2aTaskId: view.taskId ?? task.a2aTaskId,
        contextId: view.contextId ?? task.contextId,
        remoteState: view.state,
        state,
        output: clip(view.text ?? task.output, MAX_STORED_OUTPUT_CHARS),
        artifacts: storedArtifacts(view.artifacts || []),
        error:
            state === 'failed'
                ? view.text || `Remote task failed with state ${view.state}`
                : undefined,
        updatedAt: now,
        ...(state === 'running'
            ? {}
            : { endedAt: now, expiresAt: now + retentionMs })
    } satisfies A2ADelegationTask
}

function delegationState(value: string): A2ADelegationState {
    const state = value.toUpperCase()
    if (state.includes('INPUT_REQUIRED') || state.includes('AUTH_REQUIRED')) {
        return 'waiting_input'
    }
    if (state.includes('COMPLETED')) return 'completed'
    if (state.includes('CANCEL')) return 'canceled'
    if (state.includes('FAILED') || state.includes('REJECTED')) return 'failed'
    return 'running'
}

function shouldNotify(task: A2ADelegationTask) {
    return Boolean(
        task.background &&
            task.activeRunId &&
            task.activeRunId !== task.notifiedRunId &&
            task.state !== 'running' &&
            task.state !== 'canceled'
    )
}

function remoteMatchesSkill(remote: A2ARemoteStatus, value: string) {
    const query = value.trim().toLowerCase()
    if (!query) return false
    return Boolean(
        remote.card?.skills.some((skill) =>
            [skill.id, skill.name, skill.description, ...skill.tags].some((item) =>
                item.toLowerCase().includes(query)
            )
        )
    )
}

function formatRunning(task: A2ADelegationTask) {
    const lines = [
        `A2A job: ${task.id}`,
        `Agent: ${task.remoteName}`,
        `State: running (${task.background ? 'background' : 'foreground'})`
    ]
    if (task.background) {
        lines.push(
            'The result will be delivered back to this ChatLuna conversation automatically. Do not poll; continue other work or finish the reply.'
        )
    }
    lines.push(
        `Use nexus_a2a_delegate action=message id=${task.id} to send guidance, or action=stop to cancel.`
    )
    return lines.join('\n')
}

export function formatTask(task: A2ADelegationTask) {
    const lines = [
        `A2A job: ${task.id}`,
        `Agent: ${task.remoteName}`,
        `State: ${task.state}`
    ]
    if (task.output?.trim()) lines.push('', task.output.trim())
    if (task.error?.trim()) lines.push('', `Error: ${task.error.trim()}`)
    if (task.pollError?.trim()) lines.push('', `Monitor: ${task.pollError.trim()}`)
    if (task.artifacts.length) {
        lines.push('', 'Artifacts:')
        for (const artifact of task.artifacts) {
            lines.push(
                artifact.url
                    ? `- ${artifact.name || artifact.filename || 'file'}: ${artifact.url}`
                    : `- ${artifact.name || 'artifact'}: ${artifact.text || '(no preview)'}`
            )
        }
    }
    if (task.state === 'waiting_input') {
        lines.push(
            '',
            `The remote agent is waiting for input. Call nexus_a2a_delegate action=message id=${task.id} prompt="...".`
        )
    } else if (task.state === 'completed') {
        lines.push(
            '',
            `Continue the same remote context with nexus_a2a_delegate action=run id=${task.id} prompt="...".`
        )
    }
    return lines.join('\n')
}

function requiredPrompt(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('A2A task prompt is required.')
    }
    return value
}

function clean(value: unknown) {
    const text = typeof value === 'string' ? value.trim() : ''
    return text || undefined
}

function clip(value: string, maxChars: number): string
function clip(value: string | undefined, maxChars: number): string | undefined
function clip(value: string | undefined, maxChars: number) {
    if (!value || value.length <= maxChars) return value
    return `${value.slice(0, maxChars)}\n…[truncated by AgentNexus]`
}

function storedArtifacts(artifacts: A2ATaskView['artifacts']) {
    return artifacts.slice(0, MAX_STORED_ARTIFACTS).map((artifact) => ({
        artifactId: artifact.artifactId,
        name: clip(artifact.name, 1000),
        description: clip(artifact.description, 4000),
        text: clip(artifact.text, MAX_STORED_OUTPUT_CHARS),
        url: clip(artifact.url, 8192),
        filename: clip(artifact.filename, 1000),
        mediaType: clip(artifact.mediaType, 256),
        metadata: storedMetadata(artifact.metadata)
    }))
}

function storedMetadata(value: Record<string, unknown> | undefined) {
    if (!value) return undefined
    try {
        return JSON.stringify(value).length <= 16 * 1024
            ? structuredClone(value)
            : undefined
    } catch {
        return undefined
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function delay(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
        const finish = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', finish)
            resolve()
        }
        const timer = setTimeout(finish, ms)
        signal?.addEventListener('abort', finish, { once: true })
    })
}
