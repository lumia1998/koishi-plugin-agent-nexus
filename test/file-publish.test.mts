import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentNexusService } from '../src/service.ts'
import type { DelegationJob } from '../src/delegation/index.ts'

test('service binds file publishing to the owning conversation and Gateway session', async () => {
    const now = Date.now()
    const job = {
        schemaVersion: 2,
        id: 'job-1',
        provider: 'gateway',
        agentId: 'codex',
        agentName: 'Codex',
        remoteId: 'primary',
        remoteName: 'Gateway',
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        state: 'completed',
        background: false,
        prompt: 'build',
        providerState: { gatewaySessionId: 'session-1' },
        artifacts: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: now,
        expiresAt: now + 60_000
    } satisfies DelegationJob
    let published: any
    let saved: DelegationJob | undefined
    const service = Object.create(AgentNexusService.prototype) as any
    service.gatewayRemote = { baseUrl: 'http://gateway.local', enabled: true }
    service.gatewayClient = {
        async publishFiles(remote: unknown, sessionId: string, paths: string[]) {
            published = { remote, sessionId, paths }
            return {
                files: [{
                    id: 'file-1',
                    name: 'result.zip',
                    url: 'http://gateway.local/v1/artifacts/token/result.zip',
                    size: 45 * 1024 * 1024,
                    mediaType: 'application/zip',
                    sha256: 'abc',
                    expiresAt: now + 60_000
                }]
            }
        }
    }
    service.delegationStore = {
        async get(id: string) { return id === job.id ? structuredClone(job) : undefined },
        async list(conversationId: string) {
            return conversationId === job.parentConversationId ? [structuredClone(job)] : []
        },
        async save(value: DelegationJob) { saved = structuredClone(value); return value }
    }

    const result = await service.publishDelegationFiles(
        { paths: ['D:\\workspace\\result.zip', 'D:\\workspace\\result.zip'] },
        {
            parentConversationId: 'conversation-1',
            source: 'chatluna',
            routing: { platform: 'test', selfId: 'bot', userId: 'user', isDirect: true }
        }
    )
    assert.deepEqual(published.paths, ['D:\\workspace\\result.zip'])
    assert.equal(published.sessionId, 'session-1')
    assert.equal(result[0].url, 'http://gateway.local/v1/artifacts/token/result.zip')
    assert.equal(saved?.artifacts[0].url, 'http://gateway.local/v1/artifacts/token/result.zip')

    await assert.rejects(
        service.publishDelegationFiles(
            { id: 'job-1', paths: ['result.zip'] },
            {
                parentConversationId: 'conversation-2',
                source: 'chatluna',
                routing: { platform: 'test', selfId: 'bot', userId: 'other', isDirect: true }
            }
        ),
        /未找到 AgentNexus 任务/
    )
})

test('console task records expose safe summaries without provider state or binary payloads', async () => {
    const now = Date.now()
    const stored = {
        schemaVersion: 2,
        id: 'job-console',
        provider: 'gateway',
        agentId: 'codex',
        agentName: 'Codex',
        remoteId: 'primary',
        remoteName: 'Gateway',
        source: 'chatluna',
        state: 'completed',
        background: false,
        prompt: '生成一份项目报告',
        output: '报告已完成',
        providerState: { gatewaySessionId: 'secret-session' },
        artifacts: [{
            artifactId: 'file-1',
            name: 'report.zip',
            filename: 'report.zip',
            url: 'http://gateway.local/v1/artifacts/token/report.zip',
            bytesBase64: 'c2VjcmV0',
            metadata: { size: 7, sha256: 'abc', expiresAt: now + 60_000 }
        }],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: now,
        expiresAt: now + 60_000
    } as DelegationJob
    const service = Object.create(AgentNexusService.prototype) as any
    service.delegationStore = {
        async list() { return [structuredClone(stored)] },
        async get() { return structuredClone(stored) }
    }

    const [summary] = await service.getDelegationJobs()
    assert.equal(summary.id, 'job-console')
    assert.equal(summary.artifactCount, 1)
    assert.equal(summary.promptPreview, '生成一份项目报告')

    const detail = await service.getDelegationJob('job-console')
    assert.equal(detail.providerState, undefined)
    assert.equal(detail.artifacts[0].bytesBase64, undefined)
    assert.equal(detail.artifacts[0].url, 'http://gateway.local/v1/artifacts/token/report.zip')
})
