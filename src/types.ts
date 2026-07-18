export type AgentKind =
    | 'hermes'
    | 'openclaw'
    | 'claude'
    | 'opencode'
    | 'codex'

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
}

export interface AgentEnableConfig {
    hermes: boolean
    openclaw: boolean
    claude: boolean
    opencode: boolean
    codex: boolean
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

export interface NexusConfig {
    hosts: SshHostConfig[]
    agents: AgentEnableConfig
    runtime: AgentRuntimeOptions
    skills: SkillSourceConfig[]
    skillRoot: string
    defaultHostId?: string
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

export interface AgentResult {
    agent: AgentKind
    text: string
    files: string[]
    images: string[]
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
