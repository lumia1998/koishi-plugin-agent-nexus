import { randomUUID } from 'crypto'
import { MemorySessionStorage, type SessionStorage } from './storage'
import { createPendingSummary, fallbackSummary } from './summary'
import type {
    CreateSessionInput,
    NexusSession,
    NexusSessionStatus,
    ResolveSessionInput,
    SessionEndReason,
    SessionHistoryDetail,
    SessionHistoryItem,
    SessionHistoryPage,
    SessionHistoryQuery,
    SessionResolution,
    SessionSummary
} from './types'

const DEFAULT_TTLS: Record<NexusSessionStatus, number> = {
    running: 0,
    waiting_confirm: 24 * 60 * 60 * 1000,
    waiting_input: 30 * 60 * 1000,
    completed: 0,
    failed: 0
}

const TERMINAL_STATUSES: NexusSessionStatus[] = ['completed', 'failed']

export interface SessionManagerOptions {
    now?: () => number
    createId?: () => string
    ttls?: Partial<Record<NexusSessionStatus, number>>
    historyRetentionMs?: number
    onArchived?: (session: NexusSession) => void
}

export class SessionManager {
    readonly storage: SessionStorage
    private now: () => number
    private createId: () => string
    private ttls: Record<NexusSessionStatus, number>
    private historyRetentionMs: number
    private onArchived?: (session: NexusSession) => void
    private locks = new Map<string, Promise<void>>()

    constructor(
        storage: SessionStorage = new MemorySessionStorage(),
        options: SessionManagerOptions = {}
    ) {
        this.storage = storage
        this.now = options.now ?? Date.now
        this.createId = options.createId ?? randomUUID
        this.ttls = { ...DEFAULT_TTLS, ...options.ttls }
        this.historyRetentionMs =
            options.historyRetentionMs ?? 30 * 24 * 60 * 60 * 1000
        this.onArchived = options.onArchived
    }

    async create(input: CreateSessionInput) {
        const now = this.now()
        const status = input.status ?? 'running'
        const session: NexusSession = {
            schemaVersion: 1,
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
        const next = TERMINAL_STATUSES.includes(status)
            ? this.finalize(session, status === 'completed' ? 'completed' : 'failed')
            : session
        await this.storage.create(next)
        if (next.endedAt) this.onArchived?.(structuredClone(next))
        return next
    }

    async get(id: string) {
        const session = await this.storage.get(id)
        if (!session) return undefined
        return this.archiveIfExpired(session)
    }

    async findByUser(userId: string) {
        await this.cleanupExpired()
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
                    !session.endedAt &&
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
                            selfId: input.selfId,
                            agent: input.create?.agent ?? input.agent ?? 'auto',
                            ...input.create
                        }),
                        created: true,
                        ambiguous: true
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
                    selfId: input.selfId,
                    agent: input.create?.agent ?? input.agent ?? 'auto',
                    ...input.create
                }),
                created: true,
                ambiguous: false
            }
        })
    }

    async update(session: NexusSession) {
        return this.withLock(`session:${session.id}`, async () => {
            const current = await this.storage.get(session.id)
            if (!current) {
                throw new Error(`Session ${session.id} does not exist`)
            }
            if (current.endedAt && !session.endedAt) return current
            const next = this.prepareUpdate(session)
            await this.storage.update(next)
            if (!current.endedAt && next.endedAt) {
                this.onArchived?.(structuredClone(next))
            }
            return next
        })
    }

    async claim(
        id: string,
        expectedStatuses: NexusSessionStatus[],
        mutate: (session: NexusSession) => NexusSession | void
    ) {
        return this.withLock(`session:${id}`, async () => {
            const current = await this.storage.get(id)
            if (
                current &&
                !current.endedAt &&
                current.expireAt > 0 &&
                current.expireAt <= this.now()
            ) {
                current.status = 'failed'
                current.endReason = 'expired'
                const expired = this.prepareUpdate(current)
                await this.storage.update(expired)
                this.onArchived?.(structuredClone(expired))
                return undefined
            }
            if (
                !current ||
                current.endedAt ||
                !expectedStatuses.includes(current.status)
            ) {
                return undefined
            }
            const draft = structuredClone(current)
            const mutated = mutate(draft) ?? draft
            const next = this.prepareUpdate(mutated)
            await this.storage.update(next)
            if (!current.endedAt && next.endedAt) {
                this.onArchived?.(structuredClone(next))
            }
            return next
        })
    }

    async archive(
        session: NexusSession,
        status: Extract<NexusSessionStatus, 'completed' | 'failed'>,
        reason: SessionEndReason
    ) {
        return this.withLock(`session:${session.id}`, async () => {
            const current = await this.storage.get(session.id)
            if (!current) return session
            if (current.endedAt) return current
            const canUseSnapshot =
                current.updatedAt === session.updatedAt &&
                current.status === session.status &&
                session.messages.length >= current.messages.length
            const next = structuredClone(
                canUseSnapshot ? session : current
            )
            next.status = status
            next.endReason = reason
            next.pendingAction = undefined
            const finalized = this.prepareUpdate(next)
            await this.storage.update(finalized)
            this.onArchived?.(structuredClone(finalized))
            return finalized
        })
    }

    async delete(id: string) {
        await this.storage.delete(id)
    }

    async deleteHistory(id: string) {
        return this.withLock(`session:${id}`, async () => {
            const session = await this.storage.get(id)
            if (!session) return false
            if (!session.endedAt) {
                throw new Error('活动会话不能从历史记录中删除，请先取消或退出。')
            }
            await this.storage.delete(id)
            return true
        })
    }

    async cleanupExpired() {
        const now = this.now()
        let archived = 0
        for (const session of await this.storage.list()) {
            if (
                !session.endedAt &&
                session.expireAt > 0 &&
                session.expireAt <= now
            ) {
                await this.archive(session, 'failed', 'expired')
                archived += 1
            }
        }
        return archived + (await this.storage.cleanupExpired(now))
    }

    async listHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
        await this.cleanupExpired()
        const offset = Math.max(0, Math.floor(query.offset ?? 0))
        const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)))
        const needle = query.query?.trim().toLocaleLowerCase()
        let sessions = await this.storage.list()
        if (query.status) {
            sessions = sessions.filter((session) => session.status === query.status)
        }
        if (query.agent) {
            sessions = sessions.filter((session) => session.agent === query.agent)
        }
        if (needle) {
            sessions = sessions.filter((session) => {
                const fallback = fallbackSummary(session)
                const summary = session.summary
                return [
                    summary?.title,
                    summary?.abstract,
                    fallback.title,
                    fallback.abstract,
                    session.agent,
                    session.userId,
                    ...session.messages.map((message) => message.content)
                ].some((value) => value?.toLocaleLowerCase().includes(needle))
            })
        }
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        return {
            items: sessions.slice(offset, offset + limit).map(historyItem),
            total: sessions.length,
            offset,
            limit
        }
    }

    async getHistoryDetail(id: string): Promise<SessionHistoryDetail | undefined> {
        const session = await this.get(id)
        if (!session) return undefined
        return {
            ...historyItem(session),
            messages: session.messages.map(({ role, content, createdAt }) => ({
                role,
                content,
                createdAt
            }))
        }
    }

    async setSummary(
        id: string,
        summary: SessionSummary,
        expectedRevision?: number
    ) {
        return this.withLock(`session:${id}`, async () => {
            const session = await this.storage.get(id)
            if (!session?.endedAt) return undefined
            if (
                expectedRevision !== undefined &&
                (session.summary?.revision ?? 0) !== expectedRevision
            ) {
                return undefined
            }
            session.summary = structuredClone(summary)
            await this.storage.update(session)
            return session
        })
    }

    async retrySummary(id: string) {
        return this.withLock(`session:${id}`, async () => {
            const session = await this.storage.get(id)
            if (!session?.endedAt) return undefined
            const pending = createPendingSummary(session)
            pending.revision = (session.summary?.revision ?? 0) + 1
            session.summary = pending
            await this.storage.update(session)
            return session
        })
    }

    async listPendingSummaries() {
        return (await this.storage.list()).filter(
            (session) =>
                Boolean(session.endedAt) && session.summary?.status === 'pending'
        )
    }

    /** Restores process-bound tasks into a state that can be resumed safely. */
    async recoverTasks() {
        await this.cleanupExpired()
        const recovered: NexusSession[] = []
        for (let session of await this.storage.list()) {
            if (session.endedAt) continue
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

    private async archiveIfExpired(session: NexusSession) {
        if (
            !session.endedAt &&
            session.expireAt > 0 &&
            session.expireAt <= this.now()
        ) {
            return this.archive(session, 'failed', 'expired')
        }
        return session
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

    private prepareUpdate(session: NexusSession) {
        const now = this.now()
        let next = structuredClone(session)
        next.schemaVersion = 1
        next.updatedAt = now
        if (!next.endedAt && TERMINAL_STATUSES.includes(next.status)) {
            next = this.finalize(
                next,
                next.endReason ??
                    (next.status === 'completed' ? 'completed' : 'failed')
            )
        } else if (!next.endedAt) {
            next.expireAt = this.expireAt(next.status, now, next.data)
        }
        return next
    }

    private finalize(session: NexusSession, reason: SessionEndReason) {
        const now = this.now()
        session.endedAt ??= now
        session.endReason = reason
        session.expireAt = 0
        session.purgeAt ??= now + this.historyRetentionMs
        session.pendingAction = undefined
        session.summary ??= createPendingSummary(session)
        return session
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

function historyItem(session: NexusSession): SessionHistoryItem {
    const fallback = fallbackSummary(session)
    return {
        id: session.id,
        title: session.summary?.title || fallback.title,
        abstract: session.summary?.abstract || fallback.abstract,
        topics: session.summary?.topics ?? [],
        summaryStatus: session.summary?.status ?? 'none',
        summarySource: session.summary?.source,
        agent: session.agent,
        status: session.status,
        endReason: session.endReason,
        platform: session.platform,
        userId: session.userId,
        channelId: session.channelId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        endedAt: session.endedAt,
        messageCount: session.messages.length
    }
}
