export type AgentdSessionState =
    | 'created'
    | 'running'
    | 'input_required'
    | 'permission_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export type PermissionPolicy = 'ask' | 'deny'

export const agentdDriverKinds = [
    'opencode',
    'claude',
    'codex',
    'pi',
    'openclaw'
] as const

export type AgentdDriverKind = (typeof agentdDriverKinds)[number]

export interface AgentdDriverConfig {
    driver: AgentdDriverKind
    name?: string
    description?: string
    enabled?: boolean
    command?: string
    args?: string[]
    inheritEnv?: string[]
    env?: Record<string, string>
    permissionPolicy?: PermissionPolicy
    permissionTimeoutMs?: number
}

export interface AgentdConfig {
    listen: {
        host: string
        port: number
    }
    authToken: string
    workspaceRoots: string[]
    maxRequestBytes: number
    maxEventsPerSession: number
    maxOutputChars: number
    sessionTtlMs: number
    agents: Record<string, AgentdDriverConfig>
}

export interface AgentdAgentView {
    id: string
    name: string
    description?: string
    protocol: 'acp'
    ready: boolean
    version?: string
    error?: string
}

export interface AgentdPendingRequest {
    id: string
    kind: 'permission' | 'input'
    prompt: string
    options?: Array<{
        id: string
        name: string
        kind?: string
    }>
}

export interface AgentdArtifact {
    id?: string
    name?: string
    description?: string
    text?: string
    url?: string
    filename?: string
    mediaType?: string
    metadata?: Record<string, unknown>
}

export interface AgentdSessionView {
    id: string
    acpSessionId?: string
    agentId: string
    workspace: string
    state: AgentdSessionState
    output?: string
    error?: string
    artifacts: AgentdArtifact[]
    pendingRequest?: AgentdPendingRequest
    lastEventId?: string
    createdAt: number
    updatedAt: number
}

export type AgentdEventType =
    | 'session_state'
    | 'assistant_chunk'
    | 'thought_chunk'
    | 'plan'
    | 'tool_call'
    | 'tool_update'
    | 'terminal_output'
    | 'file_activity'
    | 'permission_required'
    | 'input_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export interface AgentdEvent {
    id: string
    sessionId: string
    type: AgentdEventType
    timestamp: number
    data?: unknown
}
