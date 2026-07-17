import { randomUUID } from 'crypto'
import { MemorySessionStorage, type SessionStorage } from './storage'
import type {
    CreateSessionInput,
    NexusSession,
    NexusSessionStatus,
    ResolveSessionInput,
    SessionResolution
} from './types'

const DEFAULT_TTLS: Record<NexusSessionStatus, number> = {
    running: 0,
    waiting_confirm: 24 * 60 * 60 * 1000,
    waiting_input: 30 * 60 * 1000,
    completed: 10 * 60 * 1000,
    failed: 10 * 60 * 1000
}

export interface SessionManagerOptions {
    now?: () => number
    createId?: () => string
    ttls?: Partial<Record<NexusSessionStatus, number>>
}

export class SessionManager {
    readonly storage: SessionStorage
    private now: () => number
    private createId: () => string
    private ttls: Record<NexusSessionStatus, number>
    private locks = new Map<string, Promise<void>>()

    constructor(
        storage: SessionStorage = new MemorySessionStorage(),
        options: SessionManagerOptions = {}
    ) {
        this.storage = storage
        this.now = options.now ?? Date.now
        this.createId = options.createId ?? randomUUID
        this.ttls = { ...DEFAULT_TTLS, ...options.ttls }
    }

    async create(input: CreateSessionInput) {
        const now = this.now()
        const status = input.status ?? 'running'
        const session: NexusSession = {
            id: this.createId(),
            userId: input.userId,
            channelId: input.channelId,
            platform: input.platform,
            selfId: input.selfId ?? '',
            agent: input.agent,
            status,
            taskId: input.taskId,
            messages: input.messages ? structuredClone(input.messages) : [],
            pendingAction: input.pendingAction
                ? structuredClone(input.pendingAction)
                : undefined,
            data: input.data ? structuredClone(input.data) : undefined,
            createdAt: now,
            updatedAt: now,
            expireAt: this.expireAt(status, now, input.data)
        }
        await this.storage.create(session)
        return session
    }

    async get(id: string) {
        const session = await this.storage.get(id)
        if (!session) return undefined
        if (this.isExpired(session)) {
            await this.storage.delete(id)
            return undefined
        }
        return session
    }

    async findByUser(userId: string) {
        await this.storage.cleanupExpired(this.now())
        return (await this.storage.findByUser(userId)).sort(
            (a, b) => b.updatedAt - a.updatedAt
        )
    }

    async resolve(input: ResolveSessionInput): Promise<SessionResolution> {
        const lockKey = JSON.stringify([
            input.platform,
            input.selfId ?? '',
            input.userId
        ])
        return this.withLock(lockKey, async () => {
            const candidates = (await this.findByUser(input.userId)).filter(
                (session) =>
                    session.platform === input.platform &&
                    session.selfId === (input.selfId ?? '') &&
                    session.channelId === input.channelId &&
                    (!input.agent ||
                        input.agent === 'auto' ||
                        session.agent === input.agent ||
                        session.agent === 'auto')
            )
            const statuses = input.statuses ?? [
                'running',
                'waiting_confirm',
                'waiting_input'
            ]

            for (const status of statuses) {
                const matches = candidates.filter(
                    (session) => session.status === status
                )
                if (matches.length === 1) {
                    return {
                        session: matches[0],
                        created: false,
                        ambiguous: false
                    }
                }
                if (matches.length > 1) {
                    if (input.createIfMissing === false) {
                        return { created: false, ambiguous: true }
                    }
                    return {
                        session: await this.create({
                            userId: input.userId,
                            channelId: input.channelId,
                            platform: input.platform,
                            agent: input.create?.agent ?? input.agent ?? 'auto',
                            ...input.create
                        }),
                        created: true,
                        ambiguous: true
                    }
                }
            }

            if (!input.statuses) {
                const recent = candidates.find(
                    (session) =>
                        session.status === 'completed' ||
                        session.status === 'failed'
                )
                if (recent) {
                    return {
                        session: recent,
                        created: false,
                        ambiguous: false
                    }
                }
            }

            if (input.createIfMissing === false) {
                return { created: false, ambiguous: false }
            }
            return {
                session: await this.create({
                    userId: input.userId,
                    channelId: input.channelId,
                    platform: input.platform,
                    agent: input.create?.agent ?? input.agent ?? 'auto',
                    ...input.create
                }),
                created: true,
                ambiguous: false
            }
        })
    }

    async update(session: NexusSession) {
        const next = this.prepareUpdate(session)
        await this.storage.update(next)
        return next
    }

    async claim(
        id: string,
        expectedStatuses: NexusSessionStatus[],
        mutate: (session: NexusSession) => NexusSession | void
    ) {
        return this.withLock(`session:${id}`, async () => {
            const current = await this.get(id)
            if (!current || !expectedStatuses.includes(current.status)) {
                return undefined
            }
            const draft = structuredClone(current)
            const mutated = mutate(draft) ?? draft
            const next = this.prepareUpdate(mutated)
            await this.storage.update(next)
            return next
        })
    }

    async delete(id: string) {
        await this.storage.delete(id)
    }

    async cleanupExpired() {
        return this.storage.cleanupExpired(this.now())
    }

    /**
     * Restores persisted tasks into a resumable state. A process-bound running
     * task cannot still be executing after restart, so it becomes waiting_confirm.
     */
    async recoverTasks() {
        await this.cleanupExpired()
        const sessions = this.storage.list ? await this.storage.list() : []
        const recovered: NexusSession[] = []
        for (let session of sessions) {
            if (session.status === 'running') {
                session.status = 'waiting_confirm'
                session.pendingAction = {
                    type: 'confirm',
                    prompt: '任务在 AgentNexus 重启时中断，无法确认远端副作用是否已发生。回复“确认”或“继续”将根据已保存状态重新执行；回复“取消”终止任务。',
                    data: { interruptedAt: this.now() }
                }
                session.data = {
                    ...(session.data ?? {}),
                    interruptedAt: this.now()
                }
                session = await this.update(session)
            }
            if (
                session.status === 'waiting_confirm' ||
                session.status === 'waiting_input'
            ) {
                recovered.push(session)
            }
        }
        return recovered.sort((a, b) => b.updatedAt - a.updatedAt)
    }

    private expireAt(
        status: NexusSessionStatus,
        now: number,
        data?: Record<string, unknown>
    ) {
        const override = status === 'running' ? Number.NaN : Number(data?.ttlMs)
        const ttl =
            Number.isFinite(override) && override > 0
                ? override
                : this.ttls[status]
        return ttl > 0 ? now + ttl : 0
    }

    private isExpired(session: NexusSession) {
        return session.expireAt > 0 && session.expireAt <= this.now()
    }

    private prepareUpdate(session: NexusSession) {
        const now = this.now()
        const next = structuredClone(session)
        next.updatedAt = now
        next.expireAt = this.expireAt(next.status, now, next.data)
        return next
    }

    private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(key) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => {
            release = resolve
        })
        const queued = previous.then(() => current)
        this.locks.set(key, queued)
        await previous
        try {
            return await task()
        } finally {
            release()
            if (this.locks.get(key) === queued) this.locks.delete(key)
        }
    }
}
