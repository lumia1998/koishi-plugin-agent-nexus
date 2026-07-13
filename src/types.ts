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
    skillDirs: string[]
}

export interface HostStatus {
    id: string
    name: string
    host: string
    state: 'idle' | 'connecting' | 'connected' | 'error'
    error?: string
    agents: DetectedAgent[]
    sessionCount: number
}

export interface NexusStatus {
    enabled: boolean
    defaultHostId?: string
    hosts: HostStatus[]
    skills: {
        total: number
        items: SkillInfo[]
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
}
