export type AgentKind =
    | 'hermes'
    | 'openclaw'
    | 'claude'
    | 'opencode'
    | 'codex'
    | 'pi'

export type SshAuth =
    | { type: 'password'; password: string }
    | { type: 'key'; privateKey: string; passphrase?: string }

export type SshHostKeyPolicy = 'strict' | 'accept-new' | 'insecure'

export interface SshHostConfig {
    id: string
    name: string
    host: string
    port: number
    username: string
    auth: SshAuth
    hostKeyPolicy?: SshHostKeyPolicy
    hostKeyFingerprint?: string
    enabled: boolean
    cwd?: string
    idleTimeoutMs: number
}

export interface AgentEnableConfig {
    hermes: boolean
    openclaw: boolean
    claude: boolean
    opencode: boolean
    codex: boolean
    pi: boolean
}

export interface SkillSourceConfig {
    id: string
    name: string
    repoUrl: string
    branch?: string
    subdir?: string
    enabled: boolean
    lastSyncAt?: number
    lastError?: string
}

export interface A2ARemoteConfig {
    id: string
    name: string
    baseUrl: string
    cardPath?: string
    authToken?: string
    enabled: boolean
    preferredTransport?: 'JSONRPC' | 'HTTP+JSON'
}

export interface A2AConfig {
    remotes: A2ARemoteConfig[]
}

export interface GatewayRemoteConfig {
    id: string
    name: string
    baseUrl: string
    authToken?: string
    enabled: boolean
}

export interface GatewayConfig {
    remotes: GatewayRemoteConfig[]
}

export type DelegationConnectionType = 'a2a' | 'gateway'

export interface DelegationAgentConfig {
    id: string
    name: string
    enabled: boolean
    provider: DelegationConnectionType
    remoteId: string
    agentId?: string
    workspace?: string
    description?: string
    skills?: string[]
}

export interface DelegationConfig {
    agents: DelegationAgentConfig[]
}

export interface A2ACardSkillSummary {
    id: string
    name: string
    description: string
    tags: string[]
}

export interface A2AAgentCardSummary {
    name: string
    description: string
    version: string
    url: string
    protocolVersions: string[]
    streaming: boolean
    skills: A2ACardSkillSummary[]
}

export type A2ARemoteState = 'unknown' | 'checking' | 'ready' | 'error'

export interface A2ARemoteStatus {
    id: string
    name: string
    baseUrl: string
    enabled: boolean
    state: A2ARemoteState
    card?: A2AAgentCardSummary
    lastCheckedAt?: number
    error?: string
}

export interface A2ATaskView {
    remoteId: string
    taskId?: string
    contextId?: string
    state: string
    timedOut?: boolean
    text?: string
    artifacts: Array<{
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
    }>
    raw?: unknown
}

export interface A2AStatus {
    remotes: A2ARemoteStatus[]
}

export interface GatewayAgentSummary {
    id: string
    name: string
    description?: string
    protocol: 'acp'
    ready: boolean
    version?: string
    error?: string
}

export type GatewayRemoteState = 'unknown' | 'checking' | 'ready' | 'error'

export interface GatewayRemoteStatus {
    id: string
    name: string
    baseUrl: string
    enabled: boolean
    state: GatewayRemoteState
    agents: GatewayAgentSummary[]
    lastCheckedAt?: number
    error?: string
}

export interface GatewayStatus {
    remotes: GatewayRemoteStatus[]
}

export interface DelegationAgentStatus extends DelegationAgentConfig {
    state: A2ARemoteState | GatewayRemoteState
    remoteName?: string
    protocolLabel: string
    error?: string
}

export interface DelegationStatus {
    agents: DelegationAgentStatus[]
}

export interface NexusConfig {
    hosts: SshHostConfig[]
    agents: AgentEnableConfig
    skills: SkillSourceConfig[]
    skillRoot: string
    defaultHostId?: string
    a2a: A2AConfig
    gateway: GatewayConfig
    delegation: DelegationConfig
}

export interface DetectedAgent {
    kind: AgentKind
    installed: boolean
    scanned?: boolean
    path?: string
    maintenanceMethod?: string
    skillDirs: string[]
}

export interface AgentMaintenanceInput {
    hostId: string
    kind: AgentKind
}

export interface AgentMaintenanceResult {
    action: 'install'
    method: string
    agent: DetectedAgent
    status: NexusStatus
}

export interface HostStatus {
    id: string
    name: string
    host: string
    state: 'idle' | 'connecting' | 'connected' | 'error'
    error?: string
    agents: DetectedAgent[]
    sessionCount: number
    lastConnectedAt?: number
    environment?: SshEnvironmentInfo
}

export interface SshEnvironmentInfo {
    source: 'interactive' | 'noninteractive' | 'fallback'
    home: string
    shell?: string
    pathEntries: number
    variables: number
    warning?: string
}

export interface NexusStatus {
    enabled: boolean
    defaultHostId?: string
    hosts: HostStatus[]
    skills: {
        total: number
        items: SkillInfo[]
        hostId?: string
    }
    activeSessions: number
    a2a: A2AStatus
    gateway: GatewayStatus
    delegation: DelegationStatus
}

export interface SkillInfo {
    id: string
    name: string
    sourceId?: string
    path: string
    linkedAgents: AgentKind[]
}

export interface TerminalInfo {
    sessionId: string
    terminalId: string
    hostId: string
    url: string
    token: string
}

export type RemoteFileType = 'file' | 'directory' | 'symlink' | 'other'

export interface RemoteFileEntry {
    name: string
    path: string
    type: RemoteFileType
    size: number
    modifiedAt: number
    mode: number
}

export interface RemoteFileListing {
    hostId: string
    root: string
    path: string
    parent?: string
    entries: RemoteFileEntry[]
}

export interface RemoteFilePreview {
    hostId: string
    path: string
    name: string
    size: number
    mimeType: string
    encoding: 'utf8' | 'base64' | 'none'
    content: string
    truncated: boolean
}

export interface RemoteFileDownload {
    hostId: string
    path: string
    name: string
    url: string
}

export interface NexusConsoleData {
    config: NexusConfig
    status: NexusStatus
}

export interface ExecResult {
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
    signal?: string
    truncated?: boolean
}
