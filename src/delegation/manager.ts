import { randomUUID } from 'crypto'
import { DelegationProviderRegistry } from './provider'
import { DelegationStore } from './store'
import type {
    DelegateToolInput,
    DelegationArtifact,
    DelegationContext,
    DelegationJob,
    DelegationProviderResult,
    DelegationState,
    RemoteAgentInfo
} from './types'

export interface DelegationManagerOptions {
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

export class DelegationManager {
    private readonly pollIntervalMs: number
    private readonly activeTtlMs: number
    private readonly retentionMs: number
    private readonly now: () => number
    private monitors = new Map<string, ActiveMonitor>()
    private stopped = true

    constructor(
        private readonly store: DelegationStore,
        private readonly providers: DelegationProviderRegistry,
        private readonly notify: (job: DelegationJob) => Promise<void>,
        options: DelegationManagerOptions = {}
    ) {
        this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 2000)
        this.activeTtlMs = Math.max(60_000, options.activeTtlMs ?? DEFAULT_ACTIVE_TTL)
        this.retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_RETENTION)
        this.now = options.now ?? Date.now
    }

    async start() {
        this.stopped = false
        await this.store.init()
        for (const job of await this.store.list()) {
            if (job.state === 'running') this.startMonitor(job.id)
            else if (shouldNotify(job)) void this.notifyJob(job.id)
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
        input: DelegateToolInput,
        context: DelegationContext,
        signal?: AbortSignal
    ) {
        const action = input.action ?? 'run'
        if (action === 'agents') return this.formatAgents()
        if (action === 'list') return this.formatList(context)
        if (action === 'status') return this.status(input.id, context)
        if (action === 'stop') return this.stopJob(input.id, context)
        if (action === 'message') return this.messageJob(input, context, signal)
        return this.runJob(input, context, signal)
    }

    private async runJob(
        input: DelegateToolInput,
        context: DelegationContext,
        signal?: AbortSignal
    ) {
        const prompt = requiredPrompt(input.prompt)
        if (input.id) {
            const job = await this.ownedJob(input.id, context)
            return this.sendTurn(
                job,
                prompt,
                input,
                signal,
                isInteractive(job.state)
            )
        }

        const agent = await this.resolveAgent(input, context)
        const jobs = (await this.store.list(context.parentConversationId)).filter(
            (job) => job.agentId === agent.id
        )
        if (!input.newTask) {
            const waiting = jobs.find((job) => isInteractive(job.state))
            if (waiting) return this.sendTurn(waiting, prompt, input, signal, true)
            const running = jobs.find((job) => job.state === 'running')
            if (running) return formatRunning(running)
        }

        const previous = input.newTask
            ? undefined
            : jobs.find((job) => canReuseProviderState(job, agent))
        const now = this.now()
        const job: DelegationJob = {
            schemaVersion: 2,
            id: randomUUID(),
            provider: agent.provider,
            agentId: agent.id,
            agentName: agent.name,
            remoteId: agent.remoteId,
            remoteName: agent.remoteName,
            providerAgentId: agent.agentId,
            parentConversationId: context.parentConversationId,
            source: context.source,
            routing: structuredClone(context.routing),
            state: 'running',
            background: input.background !== false,
            prompt: clip(prompt, MAX_STORED_PROMPT_CHARS),
            skill: clean(input.skill),
            providerState: previous
                ? structuredClone(previous.providerState)
                : {},
            artifacts: [],
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            expiresAt: now + this.activeTtlMs
        }
        await this.store.save(job)
        return this.sendTurn(job, prompt, input, signal, false)
    }

    private async messageJob(
        input: DelegateToolInput,
        context: DelegationContext,
        signal?: AbortSignal
    ) {
        const prompt = requiredPrompt(input.prompt)
        const job = input.id
            ? await this.ownedJob(input.id, context)
            : await this.latestJob(context, [
                  'input_required',
                  'permission_required',
                  'running'
              ])
        if (!job) {
            throw new Error('No active AgentNexus job is bound to this conversation.')
        }
        return this.sendTurn(job, prompt, input, signal, true)
    }

    private async sendTurn(
        original: DelegationJob,
        prompt: string,
        input: DelegateToolInput,
        _signal: AbortSignal | undefined,
        sameTask: boolean
    ) {
        if (
            original.state === 'running' &&
            original.activeRunId &&
            input.action !== 'message'
        ) {
            return formatRunning(original)
        }
        const agent = this.agentForJob(original)
        const provider = this.providers.providerFor(agent)
        this.stopMonitor(original.id)
        const now = this.now()
        const background = input.background !== false
        const resetContext = Boolean(input.newTask)
        let job: DelegationJob = {
            ...original,
            background,
            prompt: clip(prompt, MAX_STORED_PROMPT_CHARS),
            skill: clean(input.skill) ?? original.skill,
            state: 'running',
            providerState: resetContext
                ? {}
                : structuredClone(original.providerState),
            remoteState: undefined,
            output: undefined,
            error: undefined,
            pollError: undefined,
            artifacts: [],
            activeRunId: randomUUID(),
            startedAt: now,
            updatedAt: now,
            endedAt: undefined,
            expiresAt: now + this.activeTtlMs
        }
        await this.store.save(job)

        try {
            const request = {
                prompt,
                background,
                newTask: resetContext,
                sameTask: sameTask && !resetContext,
                skill: job.skill
            }
            const result = request.sameTask
                ? await provider.message(agent, job, request)
                : await provider.run(agent, job, request)
            job = applyResult(job, result, this.now(), this.retentionMs)
            if (job.state === 'running') {
                await this.store.save(job)
                this.startMonitor(job.id)
                return formatRunning(job)
            }
            job.notifiedRunId = job.activeRunId
            await this.store.save(job)
            return formatJob(job)
        } catch (error) {
            if (original.state === 'running' || isInteractive(original.state)) {
                const restored: DelegationJob = {
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
            job.state = 'failed'
            job.error = clip(errorMessage(error), 32 * 1024)
            job.endedAt = this.now()
            job.updatedAt = job.endedAt
            job.expiresAt = job.endedAt + this.retentionMs
            job.notifiedRunId = job.activeRunId
            await this.store.save(job)
            throw error
        }
    }

    private async status(id: string | undefined, context: DelegationContext) {
        let job = id ? await this.ownedJob(id, context) : await this.latestJob(context)
        if (!job) return 'No AgentNexus jobs are bound to this conversation.'
        if (isActive(job.state)) {
            try {
                const runId = job.activeRunId
                const agent = this.agentForJob(job)
                const result = await this.providers
                    .providerFor(agent)
                    .status(agent, job)
                const current = await this.store.get(job.id)
                if (!current || current.activeRunId !== runId) {
                    return current ? formatJob(current) : 'AgentNexus job no longer exists.'
                }
                job = applyResult(current, result, this.now(), this.retentionMs)
                if (job.state !== 'running') {
                    job.notifiedRunId = job.activeRunId
                    this.stopMonitor(job.id)
                }
                await this.store.save(job)
            } catch (error) {
                job.pollError = clip(errorMessage(error), 32 * 1024)
                job.updatedAt = this.now()
                await this.store.save(job)
            }
        }
        return formatJob(job)
    }

    private async stopJob(id: string | undefined, context: DelegationContext) {
        let job = id
            ? await this.ownedJob(id, context)
            : await this.latestJob(context, [
                  'running',
                  'input_required',
                  'permission_required'
              ])
        if (!job) return 'No active AgentNexus job is bound to this conversation.'
        this.stopMonitor(job.id)
        if (isActive(job.state)) {
            try {
                const agent = this.agentForJob(job)
                const result = await this.providers
                    .providerFor(agent)
                    .cancel(agent, job)
                job = applyResult(job, result, this.now(), this.retentionMs)
            } catch (error) {
                job.error = clip(errorMessage(error), 32 * 1024)
            }
        }
        const now = this.now()
        job.state = 'canceled'
        job.remoteState ||= 'CANCELED'
        job.endedAt = now
        job.updatedAt = now
        job.expiresAt = now + this.retentionMs
        job.notifiedRunId = job.activeRunId
        await this.store.save(job)
        return formatJob(job)
    }

    private async formatList(context: DelegationContext) {
        const jobs = await this.store.list(context.parentConversationId)
        if (!jobs.length) return 'No AgentNexus jobs are bound to this conversation.'
        return [
            'AgentNexus jobs:',
            ...jobs.slice(0, 20).map(
                (job) =>
                    `- ${job.id} [${job.state}] ${job.agentName} via ${providerLabel(job.provider)} (${job.background ? 'background' : 'foreground'})`
            ),
            '',
            'Use nexus_a2a_delegate action=status id=... or action=stop id=...'
        ].join('\n')
    }

    private async formatAgents() {
        await this.discoverUnknownAgents()
        const agents = this.providers.listAgents().filter((agent) => agent.enabled)
        if (!agents.length) return 'No enabled delegation agents are configured.'
        return agents
            .map((agent) => {
                const skills = agent.skills || []
                return [
                    `${agent.name} (${agent.id}) [${agent.state}] via ${providerLabel(agent.provider)}`,
                    agent.description ? `  ${agent.description}` : undefined,
                    agent.provider === 'gateway' && agent.workspace
                        ? `  workspace: ${agent.workspace}`
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

    private async resolveAgent(input: DelegateToolInput, context: DelegationContext) {
        if (input.skill) await this.discoverUnknownAgents()
        const agents = this.providers.listAgents().filter((agent) => agent.enabled)
        if (input.remote) {
            const agent = this.providers.resolveAgent(input.remote)
            if (!agent.enabled) throw new Error(`Delegation agent is disabled: ${input.remote}`)
            return agent
        }

        const previous = (await this.store.list(context.parentConversationId)).find(
            (job) => agents.some((agent) => agent.id === job.agentId)
        )
        if (previous) {
            const agent = agents.find((item) => item.id === previous.agentId)
            if (agent && (!input.skill || agentMatchesSkill(agent, input.skill))) {
                return agent
            }
        }

        if (input.skill) {
            const matches = agents.filter((agent) => agentMatchesSkill(agent, input.skill!))
            if (matches.length === 1) return matches[0]
            if (matches.length > 1) {
                throw new Error(
                    `Multiple agents expose skill ${input.skill}: ${matches
                        .map((item) => item.name)
                        .join(', ')}. Specify remote.`
                )
            }
        }
        if (agents.length === 1) return agents[0]
        if (!agents.length) throw new Error('No enabled delegation agents are configured.')
        throw new Error(
            `Multiple agents are available: ${agents
                .map((item) => item.name)
                .join(', ')}. Specify remote or skill.`
        )
    }

    private async latestJob(
        context: DelegationContext,
        states?: DelegationState[]
    ) {
        return (await this.store.list(context.parentConversationId)).find(
            (job) => !states || states.includes(job.state)
        )
    }

    private async discoverUnknownAgents() {
        const pending = this.providers
            .listAgents()
            .filter(
                (agent) =>
                    agent.enabled &&
                    (agent.state === 'unknown' || agent.state === 'error')
            )
        await Promise.allSettled(
            pending.map((agent) =>
                this.providers.providerFor(agent).discover?.(agent)
            )
        )
    }

    private async ownedJob(id: string, context: DelegationContext) {
        const job = await this.store.get(id)
        if (!job || job.parentConversationId !== context.parentConversationId) {
            throw new Error(`AgentNexus job is not available in this conversation: ${id}`)
        }
        return job
    }

    private agentForJob(job: DelegationJob) {
        const configured = this.providers.findAgent(job.agentId)
        if (
            configured &&
            configured.provider === job.provider &&
            configured.remoteId === job.remoteId
        ) {
            return configured
        }
        const legacy = this.providers
            .listAgents()
            .find(
                (agent) =>
                    agent.provider === job.provider &&
                    agent.remoteId === job.remoteId &&
                    (!job.providerAgentId || agent.agentId === job.providerAgentId)
            )
        if (legacy) return legacy
        throw new Error(
            `Delegation agent configuration no longer exists: ${job.agentName} (${job.agentId})`
        )
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
            const job = await this.store.get(id)
            if (!job || job.state !== 'running') return
            if (job.expiresAt <= this.now()) {
                job.state = 'failed'
                job.error = 'Delegation background monitoring expired.'
                job.endedAt = this.now()
                job.updatedAt = job.endedAt
                job.expiresAt = job.endedAt + this.retentionMs
                await this.store.save(job)
                await this.notifyJob(job.id)
                return
            }
            try {
                const runId = job.activeRunId
                const agent = this.agentForJob(job)
                const result = await this.providers
                    .providerFor(agent)
                    .status(agent, job)
                const current = await this.store.get(id)
                if (
                    !current ||
                    current.state !== 'running' ||
                    current.activeRunId !== runId
                ) {
                    return
                }
                const updated = applyResult(
                    current,
                    result,
                    this.now(),
                    this.retentionMs
                )
                updated.pollError = undefined
                await this.store.save(updated)
                if (updated.state !== 'running') {
                    await this.notifyJob(updated.id)
                    return
                }
            } catch (error) {
                const current = await this.store.get(id)
                if (
                    !current ||
                    current.state !== 'running' ||
                    current.activeRunId !== job.activeRunId
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

    private async notifyJob(id: string) {
        let job = await this.store.get(id)
        if (!job || !shouldNotify(job)) return
        const runId = job.activeRunId
        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await this.notify(job)
                const current = await this.store.get(id)
                if (!current || current.activeRunId !== runId) return
                job = current
                job.notifiedRunId = runId
                job.pollError = undefined
                job.updatedAt = this.now()
                await this.store.save(job)
                return
            } catch (error) {
                lastError = error
                if (attempt < 2) await delay(1000 * (attempt + 1))
            }
        }
        job.pollError = `ChatLuna wakeup failed: ${errorMessage(lastError)}`
        job.updatedAt = this.now()
        await this.store.save(job)
    }
}

function applyResult(
    job: DelegationJob,
    result: DelegationProviderResult,
    now: number,
    retentionMs: number
): DelegationJob {
    return {
        ...job,
        providerState: structuredClone(result.providerState || job.providerState),
        remoteState: result.remoteState,
        state: result.state,
        output: clip(result.text ?? job.output, MAX_STORED_OUTPUT_CHARS),
        artifacts: storedArtifacts(result.artifacts || []),
        error:
            result.error ||
            (result.state === 'failed'
                ? result.text || `Remote job failed with state ${result.remoteState || result.state}`
                : undefined),
        updatedAt: now,
        ...(isActive(result.state)
            ? {}
            : { endedAt: now, expiresAt: now + retentionMs })
    }
}

function shouldNotify(job: DelegationJob) {
    return Boolean(
        job.background &&
            job.activeRunId &&
            job.activeRunId !== job.notifiedRunId &&
            job.state !== 'running' &&
            job.state !== 'canceled'
    )
}

function agentMatchesSkill(agent: RemoteAgentInfo, value: string) {
    const query = value.trim().toLowerCase()
    if (!query) return false
    return agent.skills.some((skill) =>
        [skill.id, skill.name, skill.description, ...skill.tags].some((item) =>
            item.toLowerCase().includes(query)
        )
    )
}

function canReuseProviderState(job: DelegationJob, agent: RemoteAgentInfo) {
    if (job.provider !== agent.provider || job.remoteId !== agent.remoteId) {
        return false
    }
    if ((job.providerAgentId || agent.agentId) && job.providerAgentId !== agent.agentId) {
        return false
    }
    if (job.provider === 'gateway') {
        const workspace = stateString(job.providerState.workspace)
        if (workspace && workspace !== agent.workspace) return false
    }
    return true
}

function formatRunning(job: DelegationJob) {
    const lines = [
        `AgentNexus job: ${job.id}`,
        `Agent: ${job.agentName}`,
        `Connection: ${providerLabel(job.provider)}`,
        `State: running (${job.background ? 'background' : 'foreground'})`
    ]
    if (job.background) {
        lines.push(
            'The result will be delivered back to this ChatLuna conversation automatically. Do not poll; continue other work or finish the reply.'
        )
    }
    lines.push(
        `Use nexus_a2a_delegate action=message id=${job.id} to send guidance, or action=stop id=${job.id} to cancel.`
    )
    return lines.join('\n')
}

export function formatJob(job: DelegationJob) {
    const lines = [
        `AgentNexus job: ${job.id}`,
        `Agent: ${job.agentName}`,
        `Connection: ${providerLabel(job.provider)}`,
        `State: ${job.state}`
    ]
    if (job.output?.trim()) lines.push('', job.output.trim())
    if (job.error?.trim()) lines.push('', `Error: ${job.error.trim()}`)
    if (job.pollError?.trim()) lines.push('', `Monitor: ${job.pollError.trim()}`)
    if (job.artifacts.length) {
        lines.push('', 'Artifacts:')
        for (const artifact of job.artifacts) {
            lines.push(
                artifact.url
                    ? `- ${artifact.name || artifact.filename || 'file'}: ${artifact.url}`
                    : `- ${artifact.name || 'artifact'}: ${artifact.text || '(no preview)'}`
            )
        }
    }
    if (job.state === 'input_required' || job.state === 'permission_required') {
        lines.push(
            '',
            `The remote agent is waiting for ${job.state === 'permission_required' ? 'a permission decision' : 'input'}. Call nexus_a2a_delegate action=message id=${job.id} prompt="...".`
        )
    } else if (job.state === 'completed') {
        lines.push(
            '',
            `Continue the same remote context with nexus_a2a_delegate action=run id=${job.id} prompt="...".`
        )
    }
    return lines.join('\n')
}

function providerLabel(provider: DelegationJob['provider']) {
    return provider === 'a2a' ? 'A2A' : 'Nexus Gateway + ACP'
}

function requiredPrompt(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Delegation prompt is required.')
    }
    return value
}

function clean(value: unknown) {
    const text = typeof value === 'string' ? value.trim() : ''
    return text || undefined
}

function isInteractive(state: DelegationState) {
    return state === 'input_required' || state === 'permission_required'
}

function isActive(state: DelegationState) {
    return state === 'running' || isInteractive(state)
}

function clip(value: string, maxChars: number): string
function clip(value: string | undefined, maxChars: number): string | undefined
function clip(value: string | undefined, maxChars: number) {
    if (!value || value.length <= maxChars) return value
    return `${value.slice(0, maxChars)}\n…[truncated by AgentNexus]`
}

function storedArtifacts(artifacts: DelegationArtifact[]) {
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

function stateString(value: unknown) {
    return typeof value === 'string' && value ? value : undefined
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

export type {
    DelegateAction,
    DelegateToolInput,
    DelegationContext,
    DelegationJob,
    DelegationState
} from './types'
