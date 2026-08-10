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

export interface SshHostConfig {
    id: string
    name: string
    host: string
    port: number
    username: string
    auth: SshAuth
    enabled: boolean
    defaultAgent?: AgentKind | 'auto'
    cwd?: string
    idleTimeoutMs: number
    bridge: SshBridgeConfig
}

export interface AgentEnableConfig {
    hermes: boolean
    openclaw: boolean
    claude: boolean
    opencode: boolean
    codex: boolean
    pi: boolean
}

export interface SshBridgeConfig {
    enabled: boolean
    bindHost: string
    port: number
    publicBaseUrl?: string
    token?: string
    dataDir: string
    cwd?: string
    packageSpec: string
    agents: AgentEnableConfig
    remoteId?: string
}

export interface AgentRuntimeOptions {
    openclawAgent: string
    claudeSkipPermissions: boolean
    codexBypassSandbox: boolean
    opencodeAuto: boolean
    defaultTimeoutMs: number
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

export interface NexusConfig {
    hosts: SshHostConfig[]
    agents: AgentEnableConfig
    runtime: AgentRuntimeOptions
    skills: SkillSourceConfig[]
    skillRoot: string
    defaultHostId?: string
    a2a: A2AConfig
}

export interface DetectedAgent {
    kind: AgentKind
    installed: boolean
    path?: string
    version?: string
    latestVersion?: string
    updateAvailable?: boolean
    maintenanceMethod?: string
    maintenanceError?: string
    skillDirs: string[]
}

export interface AgentMaintenanceInput {
    hostId: string
    kind: AgentKind
}

export interface AgentMaintenanceResult {
    action: 'install' | 'update'
    method: string
    agent: DetectedAgent
    status: NexusStatus
}

export type BridgeMaintenanceAction =
    | 'install'
    | 'update'
    | 'start'
    | 'stop'
    | 'restart'

export interface BridgeMaintenanceInput {
    hostId: string
    action: BridgeMaintenanceAction
    /** Current console form values, persisted before the requested action. */
    bridge?: SshBridgeConfig
}

export type BridgeServiceState =
    | 'disabled'
    | 'unknown'
    | 'installing'
    | 'not-installed'
    | 'starting'
    | 'running'
    | 'stopped'
    | 'error'

export interface BridgeAgentStatus {
    kind: AgentKind
    installed: boolean
    path?: string
    version?: string
}

export interface BridgeHostStatus {
    enabled: boolean
    state: BridgeServiceState
    endpointUrl?: string
    cardUrl?: string
    version?: string
    activeTasks?: number
    agents: BridgeAgentStatus[]
    pid?: number
    lastCheckedAt?: number
    error?: string
}

export interface BridgeMaintenanceResult {
    action: BridgeMaintenanceAction
    method: string
    bridge: BridgeHostStatus
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
    bridge: BridgeHostStatus
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
}

export interface SkillInfo {
    id: string
    name: string
    sourceId?: string
    path: string
    linkedAgents: AgentKind[]
}

export interface DelegateInput {
    hostId?: string
    agent?: AgentKind | 'auto'
    prompt: string
    cwd?: string
    model?: string
    timeoutMs?: number
    openclawAgent?: string
    publishFiles?: boolean
    signal?: AbortSignal
    sessionMode?: 'oneshot' | 'managed'
    providerState?: AgentProviderState
}

export interface AgentProviderState {
    sessionId?: string
    [key: string]: unknown
}

export interface AgentArtifact {
    path: string
    size?: string
    password?: string
    title?: string
}

export interface AgentResult {
    agent: AgentKind
    text: string
    files: string[]
    images: string[]
    artifacts?: AgentArtifact[]
    raw: string
    exitCode: number
    timedOut: boolean
    command: string
    truncated?: boolean
    providerState?: AgentProviderState
}

export interface PublishResult {
    path: string
    url?: string
    name: string
    error?: string
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
