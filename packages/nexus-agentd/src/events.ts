import type { AgentdEvent, AgentdEventType } from './types.js'

export class SessionEventLog {
    private sequence = 0
    private events: AgentdEvent[] = []
    private listeners = new Set<(event: AgentdEvent) => void>()

    constructor(
        private readonly sessionId: string,
        private readonly maxEvents: number
    ) {}

    append(type: AgentdEventType, data?: unknown) {
        const event: AgentdEvent = {
            id: String(++this.sequence),
            sessionId: this.sessionId,
            type,
            timestamp: Date.now(),
            data
        }
        this.events.push(event)
        if (this.events.length > this.maxEvents) {
            this.events.splice(0, this.events.length - this.maxEvents)
        }
        for (const listener of this.listeners) listener(structuredClone(event))
        return event
    }

    after(id?: string) {
        const sequence = Number(id || 0)
        return this.events
            .filter((event) => Number(event.id) > sequence)
            .map((event) => structuredClone(event))
    }

    subscribe(listener: (event: AgentdEvent) => void) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    get lastId() {
        return this.events.at(-1)?.id
    }
}
