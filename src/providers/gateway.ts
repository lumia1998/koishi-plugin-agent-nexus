import type {
    DelegationAgentConfig,
    GatewayAgentSummary,
    GatewayRemoteConfig,
    GatewayRemoteStatus,
    NexusConfig
} from '../types'
import type { GatewayClient } from '../gateway/client'
import type { GatewaySessionView } from '../gateway/types'
import type {
    DelegationJob,
    DelegationProvider,
    DelegationProviderResult,
    DelegationRunRequest,
    RemoteAgentInfo
} from '../delegation/types'

export interface NexusGatewayProviderOptions {
    getConfig(): NexusConfig
    remote: GatewayRemoteConfig
    client: GatewayClient
}

export class NexusGatewayProvider implements DelegationProvider {
    readonly type = 'gateway' as const
    private inventoryStatus?: GatewayRemoteStatus
    private discoveryVersion = 0
    private discovery?: {
        version: number
        promise: Promise<GatewayRemoteStatus>
    }

    constructor(private readonly options: NexusGatewayProviderOptions) {}

    getStatus(): GatewayRemoteStatus {
        const remote = this.options.remote
        return (
            this.inventoryStatus || {
                id: remote.id,
                name: remote.name,
                baseUrl: remote.baseUrl,
                enabled: remote.enabled,
                state: 'unknown',
                agents: []
            }
        )
    }

    clearStatus() {
        this.discoveryVersion += 1
        this.discovery = undefined
        this.inventoryStatus = undefined
    }

    async discoverRemote() {
        const version = this.discoveryVersion
        if (this.discovery?.version === version) return this.discovery.promise
        const promise = this.performDiscovery(version)
        this.discovery = { version, promise }
        try {
            return await promise
        } finally {
            if (this.discovery?.promise === promise) this.discovery = undefined
        }
    }

    private async performDiscovery(version: number) {
        const remote = this.options.remote
        const checking: GatewayRemoteStatus = {
            id: remote.id,
            name: remote.name,
            baseUrl: remote.baseUrl,
            enabled: remote.enabled,
            state: 'checking',
            agents: this.inventoryStatus?.agents || []
        }
        this.commitStatus(version, checking)
        if (!remote.enabled) {
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'unknown',
                error: '尚未在 Koishi 插件设置中配置 Gateway API Key。'
            }
            this.commitStatus(version, status)
            return status
        }
        try {
            const result = await this.options.client.listAgents(remote)
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'ready',
                agents: (result.agents || []).map(mapGatewayAgent),
                lastCheckedAt: Date.now()
            }
            this.commitStatus(version, status)
            return status
        } catch (error) {
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'error',
                lastCheckedAt: Date.now(),
                error: errorMessage(error)
            }
            this.commitStatus(version, status)
            return status
        }
    }

    listAgents(): RemoteAgentInfo[] {
        const overrides = new Map(
            this.options
                .getConfig()
                .delegation.agents.map((agent) => [agent.agentId, agent])
        )
        const discovered = new Map(
            this.getStatus().agents.map((agent) => [agent.id, agent])
        )
        const ids = new Set([...discovered.keys(), ...overrides.keys()])
        return Array.from(ids)
            .sort((left, right) => left.localeCompare(right))
            .map((id) => this.agentInfo(id, overrides.get(id), discovered.get(id)))
    }

    async discover() {
        await this.discoverRemote()
    }

    async run(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        const remote = this.requireRemote()
        let sessionId = stateString(job, 'gatewaySessionId')
        let session: GatewaySessionView
        if (!sessionId || request.newTask) {
            if (!agent.agentId) {
                throw new Error(`Gateway agent id is missing for ${agent.name}`)
            }
            session = await this.options.client.createSession(remote, {
                agentId: agent.agentId,
                ...(agent.workspace ? { workspace: agent.workspace } : {})
            })
            sessionId = session.id
        }
        const attachmentIds = request.attachments?.length
            ? await Promise.all(
                  request.attachments.map(async (attachment) =>
                      (
                          await this.options.client.uploadAttachment(
                              remote,
                              sessionId!,
                              attachment
                          )
                      ).id
                  )
              )
            : []
        session = await this.options.client.sendMessage(
            remote,
            sessionId,
            request.prompt,
            attachmentIds
        )
        return fromGatewaySession(session, job.providerState)
    }

    async message(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (request.requestId) {
            if (!sessionId) {
                throw new Error('Nexus Gateway did not return a session id.')
            }
            const session = await this.options.client.resolvePending(
                this.requireRemote(),
                sessionId,
                request.requestId,
                {
                    ...(request.prompt ? { message: request.prompt } : {}),
                    ...(request.optionId ? { optionId: request.optionId } : {}),
                    ...(request.decision ? { action: request.decision } : {})
                }
            )
            return fromGatewaySession(session, job.providerState)
        }
        return this.run(agent, job, { ...request, sameTask: true })
    }

    async *watch(
        _agent: RemoteAgentInfo,
        job: DelegationJob,
        signal: AbortSignal
    ) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        let after = stateString(job, 'lastEventId')
        for await (const event of this.options.client.events(
            this.requireRemote(),
            sessionId,
            after,
            signal
        )) {
            after = event.id || after
            const session = await this.options.client.getSession(
                this.requireRemote(),
                sessionId
            )
            const result = fromGatewaySession(session, {
                ...job.providerState,
                ...(after ? { lastEventId: after } : {})
            })
            yield result
            if (result.state !== 'running') return
        }
    }

    async close(_agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) return
        await this.options.client.closeSession(this.requireRemote(), sessionId)
    }

    async publish(_agent: RemoteAgentInfo, job: DelegationJob, path: string) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        const session = await this.options.client.publishArtifact(
            this.requireRemote(),
            sessionId,
            path
        )
        return fromGatewaySession(session, job.providerState)
    }

    async status(_agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        const session = await this.options.client.getSession(
            this.requireRemote(),
            sessionId
        )
        return fromGatewaySession(session, job.providerState)
    }

    async cancel(_agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) {
            return {
                state: 'canceled',
                remoteState: 'canceled',
                artifacts: [],
                providerState: structuredClone(job.providerState)
            } satisfies DelegationProviderResult
        }
        const session = await this.options.client.cancelSession(
            this.requireRemote(),
            sessionId
        )
        return fromGatewaySession(session, job.providerState)
    }

    private agentInfo(
        id: string,
        override?: DelegationAgentConfig,
        discovered?: GatewayAgentSummary
    ): RemoteAgentInfo {
        const remote = this.options.remote
        const status = this.getStatus()
        const missing =
            status.state === 'ready' && !discovered
                ? `Gateway 没有返回 Agent：${id}`
                : undefined
        const unavailable = discovered && !discovered.ready
        const configuredSkills = (override?.skills || []).map((skill) => ({
            id: skill,
            name: skill,
            description: '',
            tags: []
        }))
        return {
            id,
            name: override?.name || discovered?.name || id,
            provider: 'gateway',
            remoteId: remote.id,
            remoteName: remote.name,
            agentId: id,
            protocol: discovered?.protocol,
            workspace: override?.workspace || discovered?.workspace,
            aliases: [id, discovered?.name || ''].filter(Boolean),
            enabled:
                remote.enabled &&
                (override?.enabled ?? true) &&
                discovered?.enabled !== false &&
                discovered?.ready !== false &&
                !missing,
            state:
                missing || unavailable
                    ? 'error'
                    : discovered
                      ? status.state
                      : status.state === 'error'
                        ? 'error'
                        : 'unknown',
            description: override?.description || discovered?.description,
            skills: configuredSkills,
            error: missing || discovered?.error || status.error
        }
    }

    private requireRemote() {
        const remote = this.options.remote
        if (!remote.enabled) {
            throw new Error('Nexus Gateway API Key 尚未配置。')
        }
        return remote
    }

    private commitStatus(version: number, status: GatewayRemoteStatus) {
        if (this.discoveryVersion === version) this.inventoryStatus = status
    }
}

function mapGatewayAgent(agent: GatewayAgentSummary): GatewayAgentSummary {
    return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        protocol: agent.protocol,
        driver: agent.driver,
        ready: agent.ready,
        enabled: agent.enabled,
        workspace: agent.workspace,
        version: agent.version,
        error: agent.error,
        checkedAt: agent.checkedAt,
        responseMs: agent.responseMs
    }
}

function fromGatewaySession(
    session: GatewaySessionView,
    previousState: Record<string, unknown>
): DelegationProviderResult {
    return {
        state: gatewayState(session.state),
        remoteState: session.state,
        text: session.pendingRequest
            ? formatPendingRequest(session.pendingRequest, session.output)
            : session.output,
        error: session.error,
        artifacts: (session.artifacts || []).map((artifact) => ({
            artifactId: artifact.id,
            name: artifact.name,
            description: artifact.description,
            text: artifact.text,
            url: artifact.url,
            filename: artifact.filename,
            mediaType: artifact.mediaType,
            data: artifact.data,
            bytesBase64: artifact.bytesBase64,
            metadata: artifact.metadata
        })),
        pendingRequest: session.pendingRequest
            ? structuredClone(session.pendingRequest)
            : undefined,
        providerState: {
            ...structuredClone(previousState),
            gatewaySessionId: session.id,
            ...(session.instanceId
                ? { gatewayInstanceId: session.instanceId }
                : {}),
            ...(session.runId ? { gatewayRunId: session.runId } : {}),
            protocol: session.protocol,
            ...(session.protocolSessionId
                ? { protocolSessionId: session.protocolSessionId }
                : {}),
            ...(session.acpSessionId ? { acpSessionId: session.acpSessionId } : {}),
            ...(session.lastEventId ? { lastEventId: session.lastEventId } : {}),
            agentId: session.agentId,
            ...(session.workspace ? { workspace: session.workspace } : {}),
            remoteState: session.state
        }
    }
}

function formatPendingRequest(
    request: NonNullable<GatewaySessionView['pendingRequest']>,
    output?: string
) {
    const options = request.options?.length
        ? `\nOptions:\n${request.options
              .map(
                  (option, index) =>
                      `${index + 1}. ${option.name} (${option.id})${option.kind ? ` [${option.kind}]` : ''}`
              )
              .join('\n')}`
        : ''
    return [output?.trim(), request.prompt.trim(), options.trim()]
        .filter(Boolean)
        .join('\n\n')
}

function gatewayState(
    value: GatewaySessionView['state']
): DelegationProviderResult['state'] {
    if (value === 'input_required') return 'input_required'
    if (value === 'permission_required') return 'permission_required'
    if (value === 'completed') return 'completed'
    if (value === 'failed') return 'failed'
    if (value === 'canceled') return 'canceled'
    return 'running'
}

function stateString(job: DelegationJob, key: string) {
    const value = job.providerState[key]
    return typeof value === 'string' && value ? value : undefined
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
