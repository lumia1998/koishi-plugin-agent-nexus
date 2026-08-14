export type GatewaySessionState =
    | 'created'
    | 'running'
    | 'input_required'
    | 'permission_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export interface GatewayAgentView {
    id: string
    name: string
    description?: string
    protocol: 'acp'
    ready: boolean
    version?: string
    error?: string
}

export interface GatewayAgentsResponse {
    agents: GatewayAgentView[]
}

export interface GatewayArtifactView {
    id?: string
    name?: string
    description?: string
    text?: string
    url?: string
    filename?: string
    mediaType?: string
    metadata?: Record<string, unknown>
}

export interface GatewaySessionView {
    id: string
    acpSessionId?: string
    agentId: string
    workspace: string
    state: GatewaySessionState
    output?: string
    error?: string
    artifacts: GatewayArtifactView[]
    pendingRequest?: {
        id: string
        kind: 'permission' | 'input'
        prompt: string
        options?: Array<{
            id: string
            name: string
            kind?: string
        }>
    }
    lastEventId?: string
    createdAt: number
    updatedAt: number
}

export interface GatewayEvent {
    id: string
    sessionId: string
    type:
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
    timestamp: number
    data?: unknown
}
