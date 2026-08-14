import type {
    AgentdEventType,
    AgentdPendingRequest,
    AgentdSessionState
} from './types.js'

export interface AcpSessionSink {
    readonly id: string
    readonly state: AgentdSessionState
    readonly acpSessionId?: string
    setAcpSessionId(id: string): void
    setState(state: AgentdSessionState, error?: string): void
    appendOutput(text: string): void
    setPending(request: AgentdPendingRequest): void
    clearPending(): void
    emit(type: AgentdEventType, data?: unknown): void
}
