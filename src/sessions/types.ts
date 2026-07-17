export type NexusSessionStatus =
    | 'running'
    | 'waiting_input'
    | 'waiting_confirm'
    | 'completed'
    | 'failed'

export type SessionMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface SessionMessage {
    role: SessionMessageRole
    content: string
    createdAt: number
    data?: unknown
}

export interface PendingActionOption {
    id: number
    label: string
    value: unknown
}

export interface PendingAction {
    type: 'confirm' | 'select' | 'input'
    prompt: string
    options?: PendingActionOption[]
    data?: unknown
}

export interface NexusSession {
    id: string
    userId: string
    channelId: string
    platform: string
    selfId: string
    agent: string
    status: NexusSessionStatus
    taskId?: string
    messages: SessionMessage[]
    pendingAction?: PendingAction
    data?: Record<string, unknown>
    createdAt: number
    updatedAt: number
    /** 0 means that the session does not expire in its current state. */
    expireAt: number
}

export interface SessionIdentity {
    userId: string
    channelId: string
    platform: string
    selfId?: string
}

export interface CreateSessionInput extends SessionIdentity {
    agent: string
    status?: NexusSessionStatus
    taskId?: string
    messages?: SessionMessage[]
    pendingAction?: PendingAction
    data?: Record<string, unknown>
}

export interface ResolveSessionInput extends SessionIdentity {
    agent?: string
    createIfMissing?: boolean
    create?: Omit<CreateSessionInput, keyof SessionIdentity>
    statuses?: NexusSessionStatus[]
}

export interface SessionResolution {
    session?: NexusSession
    created: boolean
    ambiguous: boolean
}
