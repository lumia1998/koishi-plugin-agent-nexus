import type {
    DelegationAgentConfig,
    GatewayRemoteConfig,
    GatewayRemoteStatus,
    NexusConfig
} from '../types'
import { NexusGatewayClient } from '../gateway/client'
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
    client: NexusGatewayClient
}

export class NexusGatewayProvider implements DelegationProvider {
    readonly type = 'gateway' as const
    private statuses = new Map<string, GatewayRemoteStatus>()

    constructor(private readonly options: NexusGatewayProviderOptions) {}

    getStatus() {
        return this.options.getConfig().gateway.remotes.map(
            (remote) =>
                this.statuses.get(remote.id) || {
                    id: remote.id,
                    name: remote.name,
                    baseUrl: remote.baseUrl,
                    enabled: remote.enabled,
                    state: 'unknown' as const,
                    agents: []
                }
        )
    }

    clearStatus(remoteId?: string) {
        if (remoteId) this.statuses.delete(remoteId)
        else this.statuses.clear()
    }

    async discoverRemote(remoteId: string) {
        const remote = this.requireRemote(remoteId, false)
        const checking: GatewayRemoteStatus = {
            id: remote.id,
            name: remote.name,
            baseUrl: remote.baseUrl,
            enabled: remote.enabled,
            state: 'checking',
            agents: []
        }
        this.statuses.set(remote.id, checking)
        try {
            const result = await this.options.client.listAgents(remote)
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'ready',
                agents: (result.agents || []).map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    description: agent.description,
                    protocol: 'acp',
                    ready: agent.ready,
                    version: agent.version,
                    error: agent.error
                })),
                lastCheckedAt: Date.now()
            }
            this.statuses.set(remote.id, status)
            return status
        } catch (error) {
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'error',
                agents: [],
                lastCheckedAt: Date.now(),
                error: errorMessage(error)
            }
            this.statuses.set(remote.id, status)
            return status
        }
    }

    listAgents(): RemoteAgentInfo[] {
        const config = this.options.getConfig()
        const status = new Map(this.getStatus().map((item) => [item.id, item]))
        return (config.delegation?.agents || [])
            .filter((agent) => agent.provider === 'gateway')
            .map((agent) => this.agentInfo(agent, status.get(agent.remoteId)))
    }

    async discover(agent: RemoteAgentInfo) {
        await this.discoverRemote(agent.remoteId)
    }

    async run(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        const remote = this.requireRemote(agent.remoteId)
        let sessionId = stateString(job, 'gatewaySessionId')
        let session: GatewaySessionView
        if (!sessionId || request.newTask) {
            if (!agent.agentId) {
                throw new Error(`Gateway agent id is missing for ${agent.name}`)
            }
            if (!agent.workspace) {
                throw new Error(`Workspace is required for ACP agent ${agent.name}`)
            }
            session = await this.options.client.createSession(remote, {
                agentId: agent.agentId,
                workspace: agent.workspace
            })
            sessionId = session.id
        }
        session = await this.options.client.sendMessage(
            remote,
            sessionId,
            request.prompt
        )
        return fromGatewaySession(session, job.providerState)
    }

    async message(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        return this.run(agent, job, { ...request, sameTask: true })
    }

    async status(agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        const session = await this.options.client.getSession(
            this.requireRemote(agent.remoteId),
            sessionId
        )
        return fromGatewaySession(session, job.providerState)
    }

    async cancel(agent: RemoteAgentInfo, job: DelegationJob) {
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
            this.requireRemote(agent.remoteId),
            sessionId
        )
        return fromGatewaySession(session, job.providerState)
    }

    private agentInfo(
        route: DelegationAgentConfig,
        remoteStatus?: GatewayRemoteStatus
    ): RemoteAgentInfo {
        const remote = this.options
            .getConfig()
            .gateway.remotes.find((item) => item.id === route.remoteId)
        const discovered = remoteStatus?.agents.find(
            (agent) => agent.id === route.agentId
        )
        const configuredSkills = (route.skills || []).map((skill) => ({
            id: skill,
            name: skill,
            description: '',
            tags: []
        }))
        const missing = !remote
            ? `Nexus Gateway remote does not exist: ${route.remoteId}`
            : !route.agentId
              ? 'Gateway agentId is required'
              : remoteStatus?.state === 'ready' && !discovered
                ? `Gateway does not report agent: ${route.agentId}`
                : undefined
        return {
            id: route.id,
            name: route.name,
            provider: 'gateway',
            remoteId: route.remoteId,
            remoteName: remote?.name || route.remoteId,
            agentId: route.agentId,
            workspace: route.workspace,
            aliases: [route.agentId || ''].filter(Boolean),
            enabled: route.enabled && Boolean(remote?.enabled) && !missing,
            state:
                missing || (discovered && !discovered.ready)
                    ? 'error'
                    : remoteStatus?.state || 'unknown',
            description: route.description || discovered?.description,
            skills: configuredSkills,
            error: missing || discovered?.error || remoteStatus?.error
        }
    }

    private requireRemote(id: string, requireEnabled = true): GatewayRemoteConfig {
        const remote = this.options
            .getConfig()
            .gateway.remotes.find((item) => item.id === id)
        if (!remote) throw new Error(`Nexus Gateway remote not found: ${id}`)
        if (requireEnabled && !remote.enabled) {
            throw new Error(`Nexus Gateway remote is disabled: ${remote.name}`)
        }
        return remote
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
            metadata: artifact.metadata
        })),
        providerState: {
            ...structuredClone(previousState),
            gatewaySessionId: session.id,
            ...(session.acpSessionId ? { acpSessionId: session.acpSessionId } : {}),
            ...(session.lastEventId ? { lastEventId: session.lastEventId } : {}),
            agentId: session.agentId,
            workspace: session.workspace,
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

function gatewayState(value: GatewaySessionView['state']): DelegationProviderResult['state'] {
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
