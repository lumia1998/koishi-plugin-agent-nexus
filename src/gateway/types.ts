import type { GatewayProtocol } from '../types'

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

export interface GatewayAgentsResponse {
    agents: GatewayAgentView[]
}

export interface GatewayAttachmentView {
    id: string
    name: string
    mediaType?: string
    size: number
}

export interface GatewayArtifactView {
    id?: string
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

export interface GatewayTurnCompletion {
    runId?: string
    protocol: GatewayProtocol
    source:
        | 'acp_prompt_response'
        | 'a2a_task_status'
        | 'a2a_message_stream'
    stopReason: string
    verified: true
    outputPresent: boolean
    artifactCount: number
    completedAt: number
}

export interface GatewaySessionView {
    id: string
    instanceId?: string
    runId?: string
    protocol: GatewayProtocol
    protocolSessionId?: string
    acpSessionId?: string
    agentId: string
    workspace?: string
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
    completion?: GatewayTurnCompletion
    lastEventId?: string
    createdAt: number
    updatedAt: number
}

export interface GatewayPendingResponse {
    message?: string
    optionId?: string
    action?: 'accept' | 'decline' | 'cancel'
    attachments?: string[]
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
        | 'artifact'
        | 'permission_required'
        | 'input_required'
        | 'completed'
        | 'failed'
        | 'canceled'
    timestamp: number
    data?: unknown
}
