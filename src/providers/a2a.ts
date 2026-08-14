import type {
    A2ARemoteConfig,
    A2ARemoteStatus,
    A2ATaskView,
    DelegationAgentConfig,
    NexusConfig
} from '../types'
import type { A2AClientService } from '../a2a/client'
import type {
    DelegationJob,
    DelegationProvider,
    DelegationProviderResult,
    DelegationRunRequest,
    RemoteAgentInfo
} from '../delegation/types'

export interface A2ADelegationProviderOptions {
    getConfig(): NexusConfig
    getStatus(): A2ARemoteStatus[]
    discover(remoteId: string): Promise<void>
    client: A2AClientService
}

export class A2ADelegationProvider implements DelegationProvider {
    readonly type = 'a2a' as const

    constructor(private readonly options: A2ADelegationProviderOptions) {}

    listAgents(): RemoteAgentInfo[] {
        const config = this.options.getConfig()
        const statuses = new Map(
            this.options.getStatus().map((status) => [status.id, status])
        )
        const routes = (config.delegation?.agents || []).filter(
            (agent) => agent.provider === 'a2a'
        )
        const routedRemoteIds = new Set(routes.map((route) => route.remoteId))
        const explicit = routes
            .map((route) => {
                const remote = config.a2a.remotes.find(
                    (item) => item.id === route.remoteId
                )
                return remote
                    ? this.agentInfo(remote, statuses.get(remote.id), route)
                    : this.missingRoute(route)
            })
        const implicit = config.a2a.remotes
            .filter((remote) => !routedRemoteIds.has(remote.id))
            .map((remote) => this.agentInfo(remote, statuses.get(remote.id)))
        return [...explicit, ...implicit]
    }

    async discover(agent: RemoteAgentInfo) {
        await this.options.discover(agent.remoteId)
    }

    async run(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        return this.send(agent, job, request)
    }

    async message(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        return this.send(agent, job, { ...request, sameTask: true })
    }

    async status(agent: RemoteAgentInfo, job: DelegationJob) {
        const taskId = stateString(job, 'taskId')
        if (!taskId) throw new Error('A2A remote did not return a task id.')
        const view = await this.options.client.getTask(
            this.requireRemote(agent.remoteId),
            taskId
        )
        return fromA2AView(view, job.providerState)
    }

    async cancel(agent: RemoteAgentInfo, job: DelegationJob) {
        const taskId = stateString(job, 'taskId')
        if (!taskId) {
            return {
                state: 'canceled',
                remoteState: 'TASK_STATE_CANCELED',
                artifacts: [],
                providerState: structuredClone(job.providerState)
            } satisfies DelegationProviderResult
        }
        const view = await this.options.client.cancelTask(
            this.requireRemote(agent.remoteId),
            taskId
        )
        return fromA2AView(view, job.providerState)
    }

    private async send(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        const view = await this.options.client.send(this.requireRemote(agent.remoteId), {
            text: request.prompt,
            taskId: request.sameTask ? stateString(job, 'taskId') : undefined,
            contextId: stateString(job, 'contextId'),
            returnImmediately: request.background,
            metadata: request.skill
                ? { skill: request.skill, skillId: request.skill }
                : undefined
        })
        return fromA2AView(view, job.providerState)
    }

    private requireRemote(id: string) {
        const remote = this.options
            .getConfig()
            .a2a.remotes.find((item) => item.id === id)
        if (!remote) throw new Error(`A2A remote not found: ${id}`)
        if (!remote.enabled) throw new Error(`A2A remote is disabled: ${remote.name}`)
        return remote
    }

    private agentInfo(
        remote: A2ARemoteConfig,
        status?: A2ARemoteStatus,
        route?: DelegationAgentConfig
    ): RemoteAgentInfo {
        const configuredSkills = (route?.skills || []).map((skill) => ({
            id: skill,
            name: skill,
            description: '',
            tags: []
        }))
        return {
            id: route?.id || remote.id,
            name: route?.name || remote.name,
            provider: 'a2a',
            remoteId: remote.id,
            remoteName: remote.name,
            aliases: [remote.id, remote.name],
            enabled: (route?.enabled ?? true) && remote.enabled,
            state: status?.state || 'unknown',
            description: route?.description || status?.card?.description,
            skills: status?.card?.skills?.length
                ? status.card.skills
                : configuredSkills,
            error: status?.error
        }
    }

    private missingRoute(route: DelegationAgentConfig): RemoteAgentInfo {
        return {
            id: route.id,
            name: route.name,
            provider: 'a2a',
            remoteId: route.remoteId,
            remoteName: route.remoteId,
            enabled: false,
            state: 'error',
            description: route.description,
            skills: (route.skills || []).map((skill) => ({
                id: skill,
                name: skill,
                description: '',
                tags: []
            })),
            error: `A2A remote does not exist: ${route.remoteId}`
        }
    }
}

function fromA2AView(
    view: A2ATaskView,
    previousState: Record<string, unknown>
): DelegationProviderResult {
    return {
        state: a2aState(view.state),
        remoteState: view.state,
        text: view.text,
        artifacts: view.artifacts || [],
        providerState: {
            ...structuredClone(previousState),
            ...(view.taskId ? { taskId: view.taskId } : {}),
            ...(view.contextId ? { contextId: view.contextId } : {}),
            remoteState: view.state
        }
    }
}

function a2aState(value: string): DelegationProviderResult['state'] {
    const state = value.toUpperCase()
    if (state.includes('AUTH_REQUIRED')) return 'permission_required'
    if (state.includes('INPUT_REQUIRED')) return 'input_required'
    if (state.includes('COMPLETED')) return 'completed'
    if (state.includes('CANCEL')) return 'canceled'
    if (state.includes('FAILED') || state.includes('REJECTED')) return 'failed'
    return 'running'
}

function stateString(job: DelegationJob, key: string) {
    const value = job.providerState[key]
    return typeof value === 'string' && value ? value : undefined
}
