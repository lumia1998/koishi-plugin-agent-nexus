import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import path from 'path'
import type { SessionStorage } from './storage'
import type { NexusSession } from './types'

interface SessionFile {
    schemaVersion: 1
    sessions: NexusSession[]
}

export class FileSessionStorage implements SessionStorage {
    private sessions = new Map<string, NexusSession>()
    private initialized = false
    private writeQueue = Promise.resolve()

    constructor(private filePath: string) {}

    async init() {
        if (this.initialized) return
        await mkdir(path.dirname(this.filePath), { recursive: true })
        try {
            const raw = await readFile(this.filePath, 'utf8')
            const parsed = JSON.parse(raw) as SessionFile | NexusSession[]
            const sessions = Array.isArray(parsed) ? parsed : parsed.sessions
            for (const session of sessions ?? []) {
                if (!session?.id) continue
                this.sessions.set(session.id, normalizeSession(session))
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        this.initialized = true
    }

    async create(session: NexusSession) {
        await this.ensureInitialized()
        if (this.sessions.has(session.id)) {
            throw new Error(`Session ${session.id} already exists`)
        }
        this.sessions.set(session.id, cloneSession(session))
        await this.persist()
    }

    async get(id: string) {
        await this.ensureInitialized()
        const session = this.sessions.get(id)
        return session ? cloneSession(session) : undefined
    }

    async findByUser(userId: string) {
        await this.ensureInitialized()
        return Array.from(this.sessions.values())
            .filter((session) => session.userId === userId)
            .map(cloneSession)
    }

    async update(session: NexusSession) {
        await this.ensureInitialized()
        if (!this.sessions.has(session.id)) {
            throw new Error(`Session ${session.id} does not exist`)
        }
        this.sessions.set(session.id, cloneSession(session))
        await this.persist()
    }

    async delete(id: string) {
        await this.ensureInitialized()
        if (!this.sessions.delete(id)) return
        await this.persist()
    }

    async cleanupExpired(now = Date.now()) {
        await this.ensureInitialized()
        let deleted = 0
        for (const [id, session] of this.sessions) {
            if (session.purgeAt && session.purgeAt <= now) {
                this.sessions.delete(id)
                deleted += 1
            }
        }
        if (deleted) await this.persist()
        return deleted
    }

    async list() {
        await this.ensureInitialized()
        return Array.from(this.sessions.values()).map(cloneSession)
    }

    private async ensureInitialized() {
        if (!this.initialized) await this.init()
    }

    private persist() {
        const write = async () => {
            const payload: SessionFile = {
                schemaVersion: 1,
                sessions: Array.from(this.sessions.values())
            }
            const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
            try {
                await writeFile(
                    tempPath,
                    `${JSON.stringify(payload, null, 2)}\n`,
                    'utf8'
                )
                await renameWithRetry(tempPath, this.filePath)
            } catch (error) {
                await unlink(tempPath).catch(() => undefined)
                throw error
            }
        }
        const next = this.writeQueue.then(write, write)
        this.writeQueue = next.catch(() => undefined)
        return next
    }
}

async function renameWithRetry(source: string, target: string) {
    const delays = [0, 25, 75, 150]
    let lastError: unknown
    for (const delay of delays) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        try {
            await rename(source, target)
            return
        } catch (error) {
            lastError = error
            const code = (error as NodeJS.ErrnoException).code
            if (!code || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) {
                throw error
            }
        }
    }
    throw lastError
}

function normalizeSession(session: NexusSession): NexusSession {
    return {
        ...cloneSession(session),
        schemaVersion: 1,
        selfId: session.selfId ?? '',
        messages: Array.isArray(session.messages) ? session.messages : []
    }
}

function cloneSession(session: NexusSession): NexusSession {
    return structuredClone(session)
}
