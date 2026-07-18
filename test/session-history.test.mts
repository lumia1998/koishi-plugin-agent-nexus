import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileSessionStorage } from '../src/sessions/file-storage.ts'
import { SessionManager } from '../src/sessions/manager.ts'
import { MemorySessionStorage } from '../src/sessions/storage.ts'
import {
    buildSummaryPrompt,
    fallbackSummary,
    parseModelSummary
} from '../src/sessions/summary.ts'

test('archives idle sessions and purges them after history retention', async () => {
    let now = 1_000
    const manager = new SessionManager(new MemorySessionStorage(), {
        now: () => now,
        createId: () => 'session-1',
        historyRetentionMs: 5_000
    })
    const session = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        status: 'waiting_input'
    })

    now = session.expireAt
    assert.equal(await manager.cleanupExpired(), 1)
    const archived = await manager.get(session.id)
    assert.equal(archived?.endReason, 'expired')
    assert.equal(archived?.summary?.status, 'pending')
    assert.equal(archived?.purgeAt, now + 5_000)

    now += 5_000
    assert.equal(await manager.cleanupExpired(), 1)
    assert.equal(await manager.get(session.id), undefined)
})

test('does not reuse terminal history and preserves self id on resolve creation', async () => {
    let id = 0
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => `session-${++id}`
    })
    let first = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        selfId: 'bot-a',
        agent: 'hermes'
    })
    first.status = 'completed'
    first = await manager.update(first)

    const next = await manager.resolve({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        selfId: 'bot-a',
        agent: 'hermes'
    })
    assert.equal(next.created, true)
    assert.notEqual(next.session?.id, first.id)
    assert.equal(next.session?.selfId, 'bot-a')
})

test('persists sessions atomically and exposes only sanitized history details', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-nexus-'))
    const file = path.join(directory, 'sessions.json')
    try {
        const storage = new FileSessionStorage(file)
        await storage.init()
        const manager = new SessionManager(storage, {
            createId: () => 'persisted-session'
        })
        let session = await manager.create({
            userId: 'u1',
            channelId: 'c1',
            platform: 'test',
            selfId: 'bot-a',
            agent: 'hermes',
            messages: [
                {
                    role: 'user',
                    content: '搜索漫画',
                    createdAt: 1,
                    data: { private: true }
                }
            ],
            data: {
                providerState: { sessionId: 'secret' },
                execution: { hostId: 'host-1' }
            }
        })
        session.messages.push({
            role: 'assistant',
            content: '找到两个结果',
            createdAt: 2,
            data: { control: { hidden: true } }
        })
        session.status = 'completed'
        await manager.update(session)

        const disk = JSON.parse(await readFile(file, 'utf8'))
        assert.equal(disk.schemaVersion, 1)
        const restoredStorage = new FileSessionStorage(file)
        await restoredStorage.init()
        const restored = new SessionManager(restoredStorage)
        const detail = await restored.getHistoryDetail('persisted-session')
        assert.equal(detail?.title, '搜索漫画')
        assert.deepEqual(detail?.messages, [
            { role: 'user', content: '搜索漫画', createdAt: 1 },
            { role: 'assistant', content: '找到两个结果', createdAt: 2 }
        ])
        assert.equal('data' in (detail as any), false)
        assert.equal('pendingAction' in (detail as any), false)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('builds and parses model summaries with a local fallback', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    const session = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        messages: [
            { role: 'user', content: '搜索漫画', createdAt: 1 },
            { role: 'assistant', content: '找到两个结果，请选择。', createdAt: 2 }
        ]
    })
    const fallback = fallbackSummary(session)
    assert.match(buildSummaryPrompt(session, 12000), /搜索漫画/)
    assert.deepEqual(
        parseModelSummary(
            '```json\n{"title":"漫画搜索与选择","abstract":"用户搜索漫画，Agent 返回两个候选并等待用户选择。","topics":["漫画","搜索"]}\n```',
            fallback
        ),
        {
            title: '漫画搜索与选择',
            abstract: '用户搜索漫画，Agent 返回两个候选并等待用户选择。',
            topics: ['漫画', '搜索']
        }
    )
    assert.equal(parseModelSummary('not json', fallback), undefined)
})

test('protects active sessions from history deletion and stale summary writes', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    let session = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        messages: [{ role: 'user', content: '测试摘要', createdAt: 1 }]
    })
    await assert.rejects(() => manager.deleteHistory(session.id), /活动会话/)
    session.status = 'completed'
    session = await manager.update(session)
    const oldRevision = session.summary?.revision ?? 0
    const retried = await manager.retrySummary(session.id)
    assert.equal(retried?.summary?.revision, oldRevision + 1)
    assert.equal(
        await manager.setSummary(
            session.id,
            {
                status: 'ready',
                revision: oldRevision,
                source: 'model',
                title: '旧摘要',
                abstract: '不应覆盖重试请求',
                topics: []
            },
            oldRevision
        ),
        undefined
    )
    assert.equal((await manager.get(session.id))?.summary?.status, 'pending')
    assert.equal(await manager.deleteHistory(session.id), true)
})
