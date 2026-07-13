import type { SshHostConfig } from '../types'
import { SshSession } from './session'

export class SshSessionPool {
    private sessions = new Map<string, SshSession>()
    private creating = new Map<string, Promise<SshSession>>()
    private persistent = new Set<string>()
    private idleTimer?: NodeJS.Timeout

    startIdleCleanup(getTimeout: (hostId: string) => number) {
        this.stopIdleCleanup()
        this.idleTimer = setInterval(async () => {
            const now = Date.now()
            for (const [key, session] of this.sessions) {
                if (this.persistent.has(key)) continue
                const timeout = getTimeout(session.hostId)
                if (now - session.lastActiveAt < timeout) continue
                this.sessions.delete(key)
                await session.disconnect().catch(() => undefined)
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
            if (current) {
                await current.disconnect().catch(() => undefined)
                this.sessions.delete(key)
            }
            const session = new SshSession(host)
            await session.connect()
            this.sessions.set(key, session)
            return session
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
        for (const [key, session] of this.sessions) {
            if (session.hostId !== hostId) continue
            this.sessions.delete(key)
            this.persistent.delete(key)
            await session.disconnect().catch(() => undefined)
        }
    }

    async clear() {
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
}
