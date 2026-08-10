import type { SshHostConfig } from '../types'
import { SshSession } from './session'

export class SshSessionPool {
    private sessions = new Map<string, SshSession>()
    private creating = new Map<string, Promise<SshSession>>()
    private persistent = new Set<string>()
    private generations = new Map<string, number>()
    private idleTimer?: NodeJS.Timeout
    private cleaning = false

    constructor(
        private readonly maxOutputBytes = 4 * 1024 * 1024,
        private readonly onHostKeyLearned?: (
            hostId: string,
            fingerprint: string
        ) => void
    ) {}

    startIdleCleanup(getTimeout: (hostId: string) => number) {
        this.stopIdleCleanup()
        this.idleTimer = setInterval(async () => {
            if (this.cleaning) return
            this.cleaning = true
            const now = Date.now()
            try {
                for (const [key, session] of this.sessions) {
                    if (this.persistent.has(key)) continue
                    if (session.hasActiveOperations()) continue
                    const timeout = getTimeout(session.hostId)
                    if (now - session.lastActiveAt < timeout) continue
                    this.sessions.delete(key)
                    await session.disconnect().catch(() => undefined)
                }
            } finally {
                this.cleaning = false
            }
        }, 30000)
    }

    stopIdleCleanup() {
        if (this.idleTimer) clearInterval(this.idleTimer)
        this.idleTimer = undefined
    }

    list() {
        return Array.from(this.sessions.values())
    }

    get(sessionId: string) {
        for (const session of this.sessions.values()) {
            if (session.sessionId === sessionId) return session
        }
    }

    keepAlive(key: string) {
        this.persistent.add(key)
    }

    release(key: string) {
        this.persistent.delete(key)
    }

    async getOrCreate(host: SshHostConfig, key = host.id): Promise<SshSession> {
        const current = this.sessions.get(key)
        if (current?.isConnected()) {
            current.touch()
            return current
        }

        const pending = this.creating.get(key)
        if (pending) return pending

        const task = (async () => {
            const generation = this.generations.get(host.id) || 0
            if (current) {
                await current.disconnect().catch(() => undefined)
                this.sessions.delete(key)
            }
            const session = new SshSession(
                host,
                this.maxOutputBytes,
                this.onHostKeyLearned
            )
            this.sessions.set(key, session)
            try {
                await session.connect()
                if ((this.generations.get(host.id) || 0) !== generation) {
                    await session.disconnect().catch(() => undefined)
                    this.sessions.delete(key)
                    throw new Error(`SSH host changed while connecting: ${host.name}`)
                }
                return session
            } catch (err) {
                this.sessions.delete(key)
                throw err
            }
        })().finally(() => this.creating.delete(key))

        this.creating.set(key, task)
        return task
    }

    async destroy(sessionId: string) {
        for (const [key, session] of this.sessions) {
            if (session.sessionId !== sessionId) continue
            this.sessions.delete(key)
            await session.disconnect()
            return
        }
    }

    async destroyByHost(hostId: string) {
        this.generations.set(hostId, (this.generations.get(hostId) || 0) + 1)
        for (const [key, session] of this.sessions) {
            if (session.hostId !== hostId) continue
            this.sessions.delete(key)
            this.persistent.delete(key)
            await session.disconnect().catch(() => undefined)
        }
    }

    async clear() {
        for (const session of this.sessions.values()) {
            this.generations.set(
                session.hostId,
                (this.generations.get(session.hostId) || 0) + 1
            )
        }
        const items = Array.from(this.sessions.values())
        this.sessions.clear()
        this.persistent.clear()
        await Promise.all(items.map((s) => s.disconnect().catch(() => undefined)))
    }

    countByHost(hostId: string) {
        let n = 0
        for (const session of this.sessions.values()) {
            if (session.hostId === hostId) n += 1
        }
        return n
    }

    getByHost(hostId: string) {
        return Array.from(this.sessions.values()).filter((session) => session.hostId === hostId)
    }
}
