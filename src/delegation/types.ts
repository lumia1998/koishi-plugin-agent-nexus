export type DelegationProviderType = 'gateway'

export type DelegationState =
    | 'running'
    | 'input_required'
    | 'permission_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export interface DelegationRouting {
    platform: string
    selfId: string
    userId: string
    username?: string
    guildId?: string
    channelId?: string
    isDirect: boolean
}

export interface DelegationContext {
    parentConversationId: string
    source: 'chatluna' | 'character'
    routing: DelegationRouting
}

export interface DelegationSkillSummary {
    id: string
    name: string
    description: string
    tags: string[]
}

export type DelegationAgentState = 'unknown' | 'checking' | 'ready' | 'error'

export interface RemoteAgentInfo {
    id: string
    name: string
    provider: DelegationProviderType
    remoteId: string
    remoteName: string
    agentId?: string
    protocol?: 'acp' | 'a2a'
    workspace?: string
    aliases?: string[]
    enabled: boolean
    state: DelegationAgentState
    description?: string
    skills: DelegationSkillSummary[]
    error?: string
}

export interface DelegationArtifact {
    artifactId?: string
    name?: string
    description?: string
    text?: string
    url?: string
    filename?: string
    mediaType?: string
    data?: unknown
    bytesBase64?: string
    metadata?: Record<string, unknown>
}

export interface DelegationProviderResult {
    state: DelegationState
    remoteState?: string
    text?: string
    error?: string
    artifacts: DelegationArtifact[]
    providerState: Record<string, unknown>
}

export interface DelegationRunRequest {
    prompt: string
    background: boolean
    newTask: boolean
    sameTask: boolean
    skill?: string
}

export interface DelegationJob {
    schemaVersion: 2
    id: string
    provider: DelegationProviderType
    agentId: string
    agentName: string
    /** ChatLuna tool that is dedicated to this logical Agent. */
    toolName?: string
    remoteId: string
    remoteName: string
    providerAgentId?: string
    parentConversationId?: string
    source: 'chatluna' | 'character'
    routing?: DelegationRouting
    state: DelegationState
    background: boolean
    prompt: string
    skill?: string
    providerState: Record<string, unknown>
    remoteState?: string
    output?: string
    error?: string
    pollError?: string
    artifacts: DelegationArtifact[]
    activeRunId?: string
    notifiedRunId?: string
    createdAt: number
    updatedAt: number
    startedAt: number
    endedAt?: number
    expiresAt: number
}

export type DelegateAction =
    | 'run'
    | 'status'
    | 'list'
    | 'agents'
    | 'message'
    | 'stop'

export interface DelegateToolInput {
    action?: DelegateAction
    remote?: string
    id?: string
    prompt?: string
    background?: boolean
    newTask?: boolean
    skill?: string
}

export interface DelegationProvider {
    readonly type: DelegationProviderType

    listAgents(): RemoteAgentInfo[]
    discover?(agent: RemoteAgentInfo): Promise<void>
    run(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ): Promise<DelegationProviderResult>
    message(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ): Promise<DelegationProviderResult>
    status(
        agent: RemoteAgentInfo,
        job: DelegationJob
    ): Promise<DelegationProviderResult>
    cancel(
        agent: RemoteAgentInfo,
        job: DelegationJob
    ): Promise<DelegationProviderResult>
}
