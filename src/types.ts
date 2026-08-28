import type { DelegationPendingRequest } from './delegation/types'

export const PRIMARY_GATEWAY_ID = 'primary-gateway'

/** Runtime-only connection assembled from Koishi plugin settings. */
export interface GatewayRemoteConfig {
    id: typeof PRIMARY_GATEWAY_ID
    name: string
    baseUrl: string
    authToken?: string
    enabled: boolean
}

/** Optional per-Agent overrides. Agents are otherwise published automatically. */
export interface DelegationAgentConfig {
    agentId: string
    name: string
    enabled: boolean
    workspace?: string
    description?: string
    skills?: string[]
}

export interface DelegationConfig {
    agents: DelegationAgentConfig[]
}

export type GatewayProtocol = 'acp' | 'a2a'

export interface GatewayAgentSummary {
    id: string
    name: string
    description?: string
    protocol: GatewayProtocol
    driver?: string
    ready: boolean
    enabled?: boolean
    workspace?: string
    version?: string
    error?: string
    checkedAt?: number
    responseMs?: number
}

export type GatewayRemoteState = 'unknown' | 'checking' | 'ready' | 'error'

export interface GatewayRemoteStatus {
    id: typeof PRIMARY_GATEWAY_ID
    name: string
    baseUrl: string
    enabled: boolean
    state: GatewayRemoteState
    agents: GatewayAgentSummary[]
    lastCheckedAt?: number
    error?: string
}

export interface DelegationAgentStatus {
    id: string
    name: string
    toolName?: string
    enabled: boolean
    agentId: string
    workspace?: string
    description?: string
    skills: string[]
    protocol?: GatewayProtocol
    state: GatewayRemoteState
    error?: string
}

export interface DelegationStatus {
    agents: DelegationAgentStatus[]
}

export interface NexusConfig {
    delegation: DelegationConfig
}

export interface NexusStatus {
    gateway: GatewayRemoteStatus
    delegation: DelegationStatus
}

export interface NexusConsoleData {
    config: NexusConfig
    status: NexusStatus
    gatewayKeyConfigured: boolean
}

export type NexusTaskState =
    | 'running'
    | 'input_required'
    | 'permission_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export interface NexusTaskArtifact {
    artifactId?: string
    name: string
    filename?: string
    url?: string
    mediaType?: string
    size?: number
    sha256?: string
    expiresAt?: number
    preview?: string
}

export interface NexusTaskSummary {
    id: string
    agentId: string
    agentName: string
    toolName?: string
    state: NexusTaskState
    background: boolean
    promptPreview: string
    outputPreview?: string
    remoteState?: string
    artifactCount: number
    createdAt: number
    updatedAt: number
    startedAt: number
    endedAt?: number
    expiresAt: number
}

export interface NexusTaskDetail extends NexusTaskSummary {
    prompt: string
    output?: string
    error?: string
    pollError?: string
    pendingRequest?: DelegationPendingRequest
    artifacts: NexusTaskArtifact[]
}
