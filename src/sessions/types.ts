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

export type SessionEndReason =
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired'
    | 'user_exit'
    | 'replaced'

export interface SessionSummary {
    status: 'pending' | 'ready'
    revision?: number
    source?: 'model' | 'fallback'
    title?: string
    abstract?: string
    topics?: string[]
    generatedAt?: number
    error?: string
}

export interface NexusSession {
    schemaVersion?: 1
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
    endedAt?: number
    endReason?: SessionEndReason
    purgeAt?: number
    summary?: SessionSummary
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

export interface SessionHistoryQuery {
    offset?: number
    limit?: number
    query?: string
    status?: NexusSessionStatus
    agent?: string
}

export interface SessionHistoryItem {
    id: string
    title: string
    abstract: string
    topics: string[]
    summaryStatus: SessionSummary['status'] | 'none'
    summarySource?: SessionSummary['source']
    agent: string
    status: NexusSessionStatus
    endReason?: SessionEndReason
    platform: string
    userId: string
    channelId: string
    createdAt: number
    updatedAt: number
    endedAt?: number
    messageCount: number
}

export interface SessionHistoryPage {
    items: SessionHistoryItem[]
    total: number
    offset: number
    limit: number
}

export interface SessionHistoryDetail extends SessionHistoryItem {
    messages: Array<{
        role: SessionMessageRole
        content: string
        createdAt: number
    }>
}
