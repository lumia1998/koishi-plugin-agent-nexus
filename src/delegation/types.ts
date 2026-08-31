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

export interface DelegationPendingRequest {
    id: string
    kind: 'permission' | 'input'
    prompt: string
    options?: Array<{
        id: string
        name: string
        kind?: string
    }>
}

export interface DelegationInputAttachment {
    name: string
    mediaType?: string
    bytes: Uint8Array
}

export interface DelegationProviderResult {
    state: DelegationState
    remoteState?: string
    text?: string
    error?: string
    artifacts: DelegationArtifact[]
    pendingRequest?: DelegationPendingRequest
    providerState: Record<string, unknown>
}

export interface DelegationRunRequest {
    prompt: string
    background: boolean
    newTask: boolean
    sameTask: boolean
    skill?: string
    attachments?: DelegationInputAttachment[]
    requestId?: string
    optionId?: string
    decision?: 'accept' | 'decline' | 'cancel'
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
    pendingRequest?: DelegationPendingRequest
    /** Text guidance queued while a background Gateway turn is still running. */
    queuedMessages?: string[]
    activeRunId?: string
    notifiedRunId?: string
    /** Artifact delivery keys already sent for the current notification run. */
    notifiedArtifactIds?: string[]
    notificationAttempts?: number
    notificationNextAt?: number
    createdAt: number
    updatedAt: number
    startedAt: number
    endedAt?: number
    expiresAt: number
}

/** Read-only, routing-safe task data exposed to the Koishi Console. */
export interface DelegationJobView {
    id: string
    agentId: string
    agentName: string
    toolName?: string
    state: DelegationState
    background: boolean
    prompt: string
    skill?: string
    remoteState?: string
    output?: string
    error?: string
    pollError?: string
    pendingRequest?: DelegationPendingRequest
    artifacts: Array<{
        id?: string
        name: string
        url?: string
        filename?: string
        mediaType?: string
    }>
    queuedMessageCount: number
    conversationBound: boolean
    deliveryState: 'not_required' | 'waiting' | 'delivered' | 'retrying'
    notificationAttempts: number
    notificationNextAt?: number
    gatewaySessionId?: string
    gatewayRunId?: string
    protocolSessionId?: string
    protocol?: 'acp' | 'a2a'
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
    | 'publish'
    | 'stop'

export interface DelegateToolInput {
    action?: DelegateAction
    remote?: string
    id?: string
    prompt?: string
    background?: boolean
    newTask?: boolean
    skill?: string
    attachments?: DelegationInputAttachment[]
    requestId?: string
    optionId?: string
    decision?: 'accept' | 'decline' | 'cancel'
    path?: string
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
    watch?(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        signal: AbortSignal
    ): AsyncGenerator<DelegationProviderResult>
    publish?(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        path: string
    ): Promise<DelegationProviderResult>
    close?(agent: RemoteAgentInfo, job: DelegationJob): Promise<void>
}
