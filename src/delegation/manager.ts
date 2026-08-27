import { randomUUID } from 'crypto'
import { DelegationProviderRegistry } from './provider'
import { DelegationStore } from './store'
import {
    buildDelegationToolNames,
    delegationToolNameForAgent,
    delegationToolNameForJob
} from './tool-name'
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
    prepareArtifacts?: (
        artifacts: DelegationArtifact[],
        job: DelegationJob
    ) => Promise<DelegationArtifact[]>
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
    private readonly prepareArtifacts?: DelegationManagerOptions['prepareArtifacts']
    private monitors = new Map<string, ActiveMonitor>()
    private jobLocks = new Map<string, Promise<void>>()
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
        this.prepareArtifacts = options.prepareArtifacts
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
        context?: DelegationContext,
        signal?: AbortSignal
    ) {
        const action = input.action ?? 'run'
        if (action === 'agents') return this.formatAgents()
        if (action === 'list') return this.formatList(context)
        if (action === 'status') return this.status(input.id, context, input.remote)
        if (action === 'stop') return this.stopJob(input.id, context, input.remote)
        if (action === 'message') return this.messageJob(input, context, signal)
        return this.runJob(input, context, signal)
    }

    private async runJob(
        input: DelegateToolInput,
        context?: DelegationContext,
        signal?: AbortSignal
    ) {
        const prompt = requiredPrompt(input.prompt)
        if (input.id) {
            const job = await this.ownedJobForAgent(input.id, context, input.remote)
            return this.sendTurn(
                job,
                prompt,
                input,
                signal,
                isInteractive(job.state)
            )
        }

        const agent = await this.resolveAgent(input, context)
        const jobs = context
            ? (await this.store.list(context.parentConversationId)).filter(
                  (job) => job.agentId === agent.id
              )
            : []
        if (!input.newTask) {
            const waiting = jobs.find((job) => isInteractive(job.state))
            if (waiting) return this.sendTurn(waiting, prompt, input, signal, true)
            const running = jobs.find((job) => job.state === 'running')
            if (running) return formatRunning(running, this.toolNameForJob(running))
        }

        const previous = input.newTask || jobs[0]?.state === 'canceled'
            ? undefined
            : jobs.find((job) => canReuseProviderState(job, agent))
        const now = this.now()
        const job: DelegationJob = {
            schemaVersion: 2,
            id: randomUUID(),
            provider: agent.provider,
            agentId: agent.id,
            agentName: agent.name,
            toolName: this.toolNameForAgent(agent),
            remoteId: agent.remoteId,
            remoteName: agent.remoteName,
            providerAgentId: agent.agentId,
            parentConversationId: context?.parentConversationId,
            source: context?.source ?? 'chatluna',
            routing: context ? structuredClone(context.routing) : undefined,
            state: 'running',
            background: input.background === true,
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
        context?: DelegationContext,
        signal?: AbortSignal
    ) {
        const prompt = requiredPrompt(input.prompt)
        const job = input.id
            ? await this.ownedJobForAgent(input.id, context, input.remote)
            : await this.latestJob(context, [
                  'input_required',
                  'permission_required',
                  'running'
              ], this.agentIdForReference(input.remote))
        if (!job) {
            throw new Error(
                context
                    ? 'No active AgentNexus job is bound to this conversation.'
                    : 'AgentNexus job id is required without a conversation context.'
            )
        }
        return this.sendTurn(job, prompt, input, signal, true)
    }

    private async sendTurn(
        original: DelegationJob,
        prompt: string,
        input: DelegateToolInput,
        signal: AbortSignal | undefined,
        sameTask: boolean
    ) {
        const outcome = await this.withJobLock(original.id, async () => {
            const current = await this.store.get(original.id)
            if (!current) {
                throw new Error(`AgentNexus job no longer exists: ${original.id}`)
            }
            return this.sendTurnLocked(current, prompt, input, sameTask)
        })
        if (outcome.kind === 'output') return outcome.value
        let job = await this.waitForForeground(outcome.id, signal)
        job.notifiedRunId = job.activeRunId
        await this.store.save(job)
        return formatJob(job, this.toolNameForJob(job))
    }

    private async sendTurnLocked(
        original: DelegationJob,
        prompt: string,
        input: DelegateToolInput,
        sameTask: boolean
    ): Promise<
        | { kind: 'output'; value: string }
        | { kind: 'foreground'; id: string }
    > {
        if (
            original.state === 'running' &&
            original.activeRunId
        ) {
            return {
                kind: 'output',
                value: formatRunning(original, this.toolNameForJob(original))
            }
        }
        const agent = this.agentForJob(original)
        const provider = this.providers.providerFor(agent)
        this.stopMonitor(original.id)
        const now = this.now()
        const background = input.background === true
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
            let result = request.sameTask
                ? await provider.message(agent, job, request)
                : await provider.run(agent, job, request)
            result = await this.prepareResultArtifacts(job, result)
            job = applyResult(job, result, this.now(), this.retentionMs)
            if (job.state === 'running') {
                await this.store.save(job)
                if (background) {
                    this.startMonitor(job.id)
                    return {
                        kind: 'output',
                        value: formatRunning(job, this.toolNameForJob(job))
                    }
                }
                return { kind: 'foreground', id: job.id }
            }
            job.notifiedRunId = job.activeRunId
            await this.store.save(job)
            return {
                kind: 'output',
                value: formatJob(job, this.toolNameForJob(job))
            }
        } catch (error) {
            if (
                original.activeRunId &&
                (original.state === 'running' || isInteractive(original.state))
            ) {
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

    private async status(
        id: string | undefined,
        context?: DelegationContext,
        remote?: string
    ) {
        let job = id
            ? await this.ownedJobForAgent(id, context, remote)
            : await this.latestJob(context, undefined, this.agentIdForReference(remote))
        if (!job) {
            return context
                ? 'No AgentNexus jobs are bound to this conversation.'
                : 'AgentNexus job id is required without a conversation context.'
        }
        if (isActive(job.state)) {
            try {
                const runId = job.activeRunId
                const agent = this.agentForJob(job)
                let result = await this.providers
                    .providerFor(agent)
                    .status(agent, job)
                result = await this.prepareResultArtifacts(job, result)
                const current = await this.store.get(job.id)
                if (
                    !current ||
                    !isActive(current.state) ||
                    current.activeRunId !== runId
                ) {
                    return current
                        ? formatJob(current, this.toolNameForJob(current))
                        : 'AgentNexus job no longer exists.'
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
        return formatJob(job, this.toolNameForJob(job))
    }

    private async stopJob(
        id: string | undefined,
        context?: DelegationContext,
        remote?: string
    ) {
        let job = id
            ? await this.ownedJobForAgent(id, context, remote)
            : await this.latestJob(context, [
                  'running',
                  'input_required',
                  'permission_required'
              ], this.agentIdForReference(remote))
        if (!job) {
            return context
                ? 'No active AgentNexus job is bound to this conversation.'
                : 'AgentNexus job id is required without a conversation context.'
        }
        const jobId = job.id
        return this.withJobLock(jobId, async () => {
            job = await this.ownedJobForAgent(jobId, context, remote)
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
            return formatJob(job, this.toolNameForJob(job))
        })
    }

    private async formatList(context?: DelegationContext) {
        if (!context) {
            return 'A conversation context is required to list jobs. Use a job id with action=status instead.'
        }
        const jobs = await this.store.list(context.parentConversationId)
        if (!jobs.length) return 'No AgentNexus jobs are bound to this conversation.'
        return [
            'AgentNexus jobs:',
            ...jobs.slice(0, 20).map(
                (job) =>
                    `- ${job.id} [${job.state}] ${job.agentName} (${job.background ? 'background' : 'foreground'})\n  Tool: ${this.toolNameForJob(job)}`
            ),
            '',
            'Use the Tool shown for the target Agent with action=status or action=stop.'
        ].join('\n')
    }

    private async formatAgents() {
        await this.discoverUnknownAgents()
        const agents = this.providers.listAgents().filter((agent) => agent.enabled)
        if (!agents.length) return 'No enabled delegation agents are configured.'
        const names = buildDelegationToolNames(agents)
        return agents
            .map((agent) => {
                const skills = agent.skills || []
                return [
                    `${agent.name} (${agent.id}) [${agent.state}]`,
                    `  tool: ${names.get(agent.id) || delegationToolNameForAgent(agent)}`,
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

    private async resolveAgent(input: DelegateToolInput, context?: DelegationContext) {
        if (input.skill) await this.discoverUnknownAgents()
        const agents = this.providers.listAgents().filter((agent) => agent.enabled)
        if (input.remote) {
            const agent = this.providers.resolveAgent(input.remote)
            if (!agent.enabled) throw new Error(`Delegation agent is disabled: ${input.remote}`)
            return agent
        }

        const previous = context
            ? (await this.store.list(context.parentConversationId)).find((job) =>
                  agents.some((agent) => agent.id === job.agentId)
              )
            : undefined
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
        context: DelegationContext | undefined,
        states?: DelegationState[],
        agentId?: string
    ) {
        if (!context) return undefined
        return (await this.store.list(context.parentConversationId)).find(
            (job) =>
                (!states || states.includes(job.state)) &&
                (!agentId || job.agentId === agentId)
        )
    }

    private toolNameForAgent(agent: RemoteAgentInfo) {
        return (
            buildDelegationToolNames(
                this.providers.listAgents().filter((item) => item.enabled)
            ).get(agent.id) ||
            delegationToolNameForAgent(agent)
        )
    }

    private toolNameForJob(job: DelegationJob) {
        if (job.toolName) return job.toolName
        const agent = this.providers.findAgent(job.agentId)
        return agent ? this.toolNameForAgent(agent) : delegationToolNameForJob(job)
    }

    private agentIdForReference(reference: string | undefined) {
        if (!reference) return undefined
        return this.providers.resolveAgent(reference).id
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

    private async ownedJob(id: string, context?: DelegationContext) {
        const job = await this.store.get(id)
        if (
            !job ||
            (context && job.parentConversationId !== context.parentConversationId)
        ) {
            throw new Error(`AgentNexus job is not available in this conversation: ${id}`)
        }
        return job
    }

    private async ownedJobForAgent(
        id: string,
        context: DelegationContext | undefined,
        reference?: string
    ) {
        const job = await this.ownedJob(id, context)
        const agentId = this.agentIdForReference(reference)
        if (agentId && job.agentId !== agentId) {
            throw new Error(`AgentNexus job ${id} belongs to another Agent.`)
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

    private async waitForForeground(id: string, signal?: AbortSignal) {
        await delay(this.pollIntervalMs, signal)
        while (!this.stopped) {
            const job = await this.store.get(id)
            if (!job) throw new Error(`AgentNexus job no longer exists: ${id}`)
            if (job.state !== 'running') return job
            if (signal?.aborted) {
                const background = Boolean(
                    job.parentConversationId && job.routing
                )
                await this.store.save({
                    ...job,
                    background,
                    updatedAt: this.now()
                })
                this.startMonitor(id)
                throw new Error(
                    background
                        ? `Waiting for AgentNexus job ${id} was canceled; the remote task continues in the background and its result will be delivered to this conversation.`
                        : `Waiting for AgentNexus job ${id} was canceled; the remote task is still running and can be checked with action=status.`
                )
            }
            if (job.expiresAt <= this.now()) {
                const endedAt = this.now()
                const expired: DelegationJob = {
                    ...job,
                    state: 'failed',
                    error: 'Delegation foreground wait expired.',
                    endedAt,
                    updatedAt: endedAt,
                    expiresAt: endedAt + this.retentionMs
                }
                await this.store.save(expired)
                return expired
            }
            try {
                const runId = job.activeRunId
                const agent = this.agentForJob(job)
                let result = await this.providers
                    .providerFor(agent)
                    .status(agent, job)
                result = await this.prepareResultArtifacts(job, result)
                const current = await this.store.get(id)
                if (!current) {
                    throw new Error(`AgentNexus job no longer exists: ${id}`)
                }
                if (
                    current.state !== 'running' ||
                    current.activeRunId !== runId
                ) {
                    return current
                }
                const updated = applyResult(
                    current,
                    result,
                    this.now(),
                    this.retentionMs
                )
                updated.pollError = undefined
                await this.store.save(updated)
                if (updated.state !== 'running') return updated
            } catch (error) {
                const current = await this.store.get(id)
                if (!current || current.state !== 'running') {
                    if (current) return current
                    throw error
                }
                current.pollError = clip(errorMessage(error), 32 * 1024)
                current.updatedAt = this.now()
                await this.store.save(current)
            }
            await delay(this.pollIntervalMs, signal)
        }
        throw new Error(`AgentNexus stopped while waiting for job ${id}.`)
    }

    private async withJobLock<T>(id: string, operation: () => Promise<T>) {
        const previous = this.jobLocks.get(id) || Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.then(() => gate)
        this.jobLocks.set(id, tail)
        await previous
        try {
            return await operation()
        } finally {
            release()
            if (this.jobLocks.get(id) === tail) this.jobLocks.delete(id)
        }
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
        const monitor = this.monitors.get(id)
        if (!monitor) return
        this.monitors.delete(id)
        monitor.controller.abort()
    }

    private async monitor(id: string, signal: AbortSignal) {
        await delay(this.pollIntervalMs, signal)
        while (!this.stopped && !signal.aborted) {
            const job = await this.store.get(id)
            if (signal.aborted) return
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
                let result = await this.providers
                    .providerFor(agent)
                    .status(agent, job)
                if (signal.aborted) return
                result = await this.prepareResultArtifacts(job, result)
                if (signal.aborted) return
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
                if (signal.aborted) return
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

    private async prepareResultArtifacts(
        job: DelegationJob,
        result: DelegationProviderResult
    ) {
        if (!this.prepareArtifacts || !result.artifacts?.length) return result
        return {
            ...result,
            artifacts: await this.prepareArtifacts(result.artifacts, job)
        }
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
            job.parentConversationId &&
            job.routing &&
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
    if (job.state === 'canceled') return false
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

function formatRunning(
    job: DelegationJob,
    toolName = delegationToolNameForJob(job)
) {
    const lines = [
        `AgentNexus job: ${job.id}`,
        `Agent: ${job.agentName}`,
        `Tool: ${toolName}`,
        `State: running (${job.background ? 'background' : 'foreground'})`
    ]
    if (job.background) {
        lines.push(
            job.parentConversationId && job.routing
                ? 'The result will be delivered back to this ChatLuna conversation automatically. Do not poll; continue other work or finish the reply.'
                : `No conversation delivery context is available. Check this task later with ${toolName} action=status id=${job.id}.`
        )
    }
    lines.push(
        `Use ${toolName} action=message id=${job.id} to send guidance, or action=stop id=${job.id} to cancel.`
    )
    return lines.join('\n')
}

export function formatJob(
    job: DelegationJob,
    toolName = delegationToolNameForJob(job)
) {
    const lines = [
        `AgentNexus job: ${job.id}`,
        `Agent: ${job.agentName}`,
        `Tool: ${toolName}`,
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
                    : `- ${artifact.name || 'artifact'}: ${artifactPreview(artifact)}`
            )
        }
    }
    if (job.state === 'input_required' || job.state === 'permission_required') {
        lines.push(
            '',
            `The remote agent is waiting for ${job.state === 'permission_required' ? 'a permission decision' : 'input'}. Call ${toolName} action=message id=${job.id} prompt="...".`
        )
    } else if (job.state === 'completed') {
        lines.push(
            '',
            `Continue the same context with ${toolName} action=run id=${job.id} prompt="...".`
        )
    }
    return lines.join('\n')
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
    return artifacts.slice(0, MAX_STORED_ARTIFACTS).map((artifact) => {
        const data = storedData(artifact.data)
        const bytesBase64 =
            artifact.bytesBase64 &&
            artifact.bytesBase64.length <= MAX_STORED_OUTPUT_CHARS
                ? artifact.bytesBase64
                : undefined
        const omissions = [
            artifact.data !== undefined && data === undefined
                ? '[structured artifact omitted: payload is invalid or exceeds the storage limit]'
                : undefined,
            artifact.bytesBase64 && !bytesBase64
                ? `[binary artifact omitted: ${artifact.bytesBase64.length} base64 characters exceed the storage limit]`
                : undefined
        ].filter((value): value is string => Boolean(value))
        return {
            artifactId: artifact.artifactId,
            name: clip(artifact.name, 1000),
            description: clip(artifact.description, 4000),
            text: clip(
                [artifact.text, ...omissions].filter(Boolean).join('\n') || undefined,
                MAX_STORED_OUTPUT_CHARS
            ),
            url: clip(artifact.url, 8192),
            filename: clip(artifact.filename, 1000),
            mediaType: clip(artifact.mediaType, 256),
            data,
            bytesBase64,
            metadata: storedMetadata(artifact.metadata)
        }
    })
}

function storedData(value: unknown) {
    if (value === undefined) return undefined
    try {
        const serialized = JSON.stringify(value)
        return serialized !== undefined &&
            serialized.length <= MAX_STORED_OUTPUT_CHARS
            ? (JSON.parse(serialized) as unknown)
            : undefined
    } catch {
        return undefined
    }
}

function artifactPreview(artifact: DelegationArtifact) {
    if (artifact.text) return artifact.text
    if (artifact.data !== undefined) {
        try {
            return JSON.stringify(artifact.data)
        } catch {}
    }
    if (artifact.bytesBase64) {
        return binaryArtifactSummary(artifact)
    }
    return '(no preview)'
}

function binaryArtifactSummary(artifact: DelegationArtifact) {
    const bytes = decodedBase64Size(artifact.bytesBase64 || '')
    const details = [artifact.filename, artifact.mediaType, `${bytes} bytes`]
        .filter(Boolean)
        .join(', ')
    return `[binary artifact${details ? `: ${details}` : ''}]`
}

function decodedBase64Size(value: string) {
    const normalized = value.replace(/\s/g, '')
    if (!normalized) return 0
    const padding = normalized.endsWith('==')
        ? 2
        : normalized.endsWith('=')
          ? 1
          : 0
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
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
