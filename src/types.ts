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

/**
 * Local artifact cache settings. `directory` is reported relative to the
 * Koishi base directory so the Console shows a portable path instead of
 * leaking the host's absolute layout.
 */
export interface NexusArtifactCacheSettings {
    enabled: boolean
    directory: string
    ttlHours: number
    maxTotalBytes: number
}

/** Read-only snapshot of the connection settings owned by Koishi plugin config. */
export interface NexusPluginSettings {
    commandAuthority: number
    maxResponseBytes: number
    /** Length of the configured Gateway API key. The key itself is never exposed. */
    gatewayKeyLength: number
    artifactCache: NexusArtifactCacheSettings
}

export interface NexusConsoleData {
    config: NexusConfig
    status: NexusStatus
    settings: NexusPluginSettings
    gatewayKeyConfigured: boolean
}
