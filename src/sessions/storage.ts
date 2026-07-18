import type { NexusSession } from './types'

export interface SessionStorage {
    create(session: NexusSession): Promise<void>
    get(id: string): Promise<NexusSession | undefined>
    findByUser(userId: string): Promise<NexusSession[]>
    update(session: NexusSession): Promise<void>
    delete(id: string): Promise<void>
    cleanupExpired(now?: number): Promise<number>
    list(): Promise<NexusSession[]>
}

export class MemorySessionStorage implements SessionStorage {
    private sessions = new Map<string, NexusSession>()

    async create(session: NexusSession) {
        if (this.sessions.has(session.id)) {
            throw new Error(`Session ${session.id} already exists`)
        }
        this.sessions.set(session.id, cloneSession(session))
    }

    async get(id: string) {
        const session = this.sessions.get(id)
        return session ? cloneSession(session) : undefined
    }

    async findByUser(userId: string) {
        return Array.from(this.sessions.values())
            .filter((session) => session.userId === userId)
            .map(cloneSession)
    }

    async update(session: NexusSession) {
        if (!this.sessions.has(session.id)) {
            throw new Error(`Session ${session.id} does not exist`)
        }
        this.sessions.set(session.id, cloneSession(session))
    }

    async delete(id: string) {
        this.sessions.delete(id)
    }

    async cleanupExpired(now = Date.now()) {
        let deleted = 0
        for (const [id, session] of this.sessions) {
            if (session.purgeAt && session.purgeAt <= now) {
                this.sessions.delete(id)
                deleted += 1
            }
        }
        return deleted
    }

    async list() {
        return Array.from(this.sessions.values()).map(cloneSession)
    }
}

function cloneSession(session: NexusSession): NexusSession {
    return structuredClone(session)
}
