import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    DelegationManager,
    DelegationProviderRegistry,
    DelegationStore,
    formatJob,
    type DelegationContext,
    type DelegationJob,
    type DelegationProvider,
    type RemoteAgentInfo
} from '../src/delegation/index.ts'
import { formatDelegationWakeup } from '../src/delegation/wakeup.ts'
import { notifyChatLunaDelegation } from '../src/delegation/wakeup.ts'

test('persists only single-Gateway jobs and drops obsolete provider records', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-store-'))
    const file = path.join(directory, 'jobs.json')
    try {
        await writeFile(
            file,
            JSON.stringify({
                schemaVersion: 2,
                jobs: [job('gateway-job', 'gateway'), job('old-a2a-job', 'a2a')]
            })
        )
        const store = new DelegationStore(file, 8)
        await store.init()
        assert.deepEqual((await store.list()).map((item) => item.id), ['gateway-job'])
        const persisted = JSON.parse(await readFile(file, 'utf8'))
        assert.deepEqual(persisted.jobs.map((item: any) => item.id), ['gateway-job'])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('runs through Gateway and reuses completed session state', async () => {
    const fixture = await managerFixture()
    const seen: Array<Record<string, unknown>> = []
    fixture.provider.run = async (_agent, current) => {
        seen.push(structuredClone(current.providerState))
        return completed({ gatewaySessionId: 'session-1', protocol: 'acp' })
    }
    try {
        await fixture.manager.start()
        const first = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '第一轮',
                background: false
            },
            context()
        )
        const second = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '第二轮',
                background: false
            },
            context()
        )
        assert.match(first, /State: completed/)
        assert.match(second, /Tool: nexus_hermes/)
        assert.deepEqual(seen, [
            {},
            { gatewaySessionId: 'session-1', protocol: 'acp' }
        ])
    } finally {
        await fixture.dispose()
    }
})

test('polls background jobs and wakes ChatLuna for permission input', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    let notify!: (job: DelegationJob) => void
    const notification = new Promise<DelegationJob>((resolve) => {
        notify = resolve
    })
    fixture.provider.run = async () => running()
    fixture.provider.status = async (_agent, current) => ({
        state: 'permission_required',
        remoteState: 'permission_required',
        text: '允许修改 package.json 吗？\n\n1. 允许一次',
        artifacts: [],
        providerState: structuredClone(current.providerState)
    })
    fixture.manager = new DelegationManager(
        fixture.store,
        new DelegationProviderRegistry().register(fixture.provider),
        async (current) => notify(structuredClone(current)),
        { pollIntervalMs: 1 }
    )
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '修改项目',
                background: true
            },
            context()
        )
        assert.match(output, /State: running/)
        const current = await Promise.race([
            notification,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('notification timeout')), 1000)
            )
        ])
        assert.equal(current.provider, 'gateway')
        assert.equal(current.state, 'permission_required')
        assert.match(current.output || '', /允许一次/)
    } finally {
        await fixture.dispose()
    }
})

test('relays a Gateway permission request into the originating ChatLuna conversation', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    let resolveInvocation!: (input: any) => void
    const invocation = new Promise<any>((resolve) => {
        resolveInvocation = resolve
    })
    const conversation = {
        async getConversation(id: string) {
            assert.equal(this, conversation)
            assert.equal(id, 'conversation-1')
            return { chatMode: 'chat' }
        }
    }
    fixture.provider.run = async () => running()
    fixture.provider.status = async (_agent, current) => ({
        state: 'permission_required',
        remoteState: 'permission_required',
        text: '是否允许写入 report.svg？',
        artifacts: [],
        pendingRequest: {
            id: 'permission-1',
            kind: 'permission',
            prompt: '是否允许写入 report.svg？',
            options: [
                { id: 'allow_once', name: '允许一次', kind: 'allow_once' },
                { id: 'deny', name: '拒绝', kind: 'reject_once' }
            ]
        },
        providerState: structuredClone(current.providerState)
    })
    fixture.manager = new DelegationManager(
        fixture.store,
        new DelegationProviderRegistry().register(fixture.provider),
        async (job) =>
            notifyChatLunaDelegation(
                {
                    conversation,
                    async invoke(input) {
                        resolveInvocation(input)
                        return { ok: true }
                    }
                },
                job
            ),
        { pollIntervalMs: 1 }
    )
    try {
        await fixture.manager.start()
        await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '生成报告',
                background: true
            },
            context()
        )
        const sent = await Promise.race([
            invocation,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('permission relay timeout')), 1000)
            )
        ])
        assert.deepEqual(sent.conversation, {
            type: 'existing',
            id: 'conversation-1'
        })
        assert.match(String(sent.message), /permission-1/)
        assert.match(String(sent.message), /allow_once/)
        assert.match(String(sent.message), /permission decision/)
    } finally {
        await fixture.dispose()
    }
})

test('preserves background mode when resolving a pending Gateway request', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    let seenRequest: any
    fixture.provider.run = async () => ({
        state: 'permission_required',
        remoteState: 'permission_required',
        text: 'Allow write?',
        artifacts: [],
        pendingRequest: {
            id: 'request-1',
            kind: 'permission',
            prompt: 'Allow write?',
            options: [{ id: 'allow_once', name: 'Allow once' }]
        },
        providerState: { gatewaySessionId: 'session-1', gatewayRunId: 'run-1' }
    })
    fixture.provider.message = async (_agent, current, request) => {
        seenRequest = request
        return completed(current.providerState)
    }
    try {
        await fixture.manager.start()
        const started = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '生成文件',
                background: true
            },
            context()
        )
        const id = jobId(started)
        const resolved = await fixture.manager.handle(
            {
                action: 'message',
                remote: 'hermes',
                id,
                requestId: 'request-1',
                optionId: 'allow_once'
            },
            context()
        )
        assert.equal(seenRequest.background, true)
        assert.equal(seenRequest.sameTask, true)
        assert.match(resolved, /State: completed/)
        assert.equal((await fixture.store.get(id))?.background, true)
    } finally {
        await fixture.dispose()
    }
})

test('exposes task progress with Koishi, Gateway Run, and Session identifiers', async () => {
    const fixture = await managerFixture()
    fixture.provider.run = async () =>
        completed({
            gatewaySessionId: 'gateway-session-1',
            gatewayRunId: 'gateway-run-1',
            protocolSessionId: 'acp-session-1',
            protocol: 'acp'
        })
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '生成报告',
                background: false
            },
            context()
        )
        assert.match(output, /Gateway run: gateway-run-1/)
        assert.match(output, /Gateway session: gateway-session-1/)

        const [view] = await fixture.manager.listJobsForConsole()
        assert.equal(view.id, jobId(output))
        assert.equal(view.gatewayRunId, 'gateway-run-1')
        assert.equal(view.gatewaySessionId, 'gateway-session-1')
        assert.equal(view.protocolSessionId, 'acp-session-1')
        assert.equal(view.protocol, 'acp')
        assert.equal(view.conversationBound, true)
        assert.equal(view.deliveryState, 'not_required')
        assert.equal('routing' in view, false)
    } finally {
        await fixture.dispose()
    }
})

test('queues background guidance and continues in the same Gateway task', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    let completeFirst!: () => void
    const firstTurn = new Promise<void>((resolve) => {
        completeFirst = resolve
    })
    let guidance = ''
    fixture.provider.run = async () => running()
    fixture.provider.status = async (_agent, current) => {
        await firstTurn
        return completed(current.providerState)
    }
    fixture.provider.message = async (_agent, current, request) => {
        guidance = request.prompt
        return completed(current.providerState)
    }
    try {
        await fixture.manager.start()
        const started = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: 'first turn',
                background: true
            },
            context()
        )
        const id = jobId(started)
        const queued = await fixture.manager.handle(
            { action: 'message', id, prompt: 'also update the README' },
            context()
        )
        assert.match(queued, /Guidance queued: 1/)
        completeFirst()
        for (let attempt = 0; attempt < 100 && !guidance; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        assert.equal(guidance, 'also update the README')
        const current = await fixture.store.get(id)
        assert.equal(current?.state, 'completed')
        assert.equal(current?.queuedMessages, undefined)
    } finally {
        await fixture.dispose()
    }
})

test('publishes a workspace file through the existing Gateway task', async () => {
    const fixture = await managerFixture()
    let publishedPath = ''
    fixture.provider.publish = async (_agent, current, filePath) => {
        publishedPath = filePath
        return {
            ...completed(current.providerState),
            artifacts: [{
                artifactId: 'published-1',
                filename: 'report.md',
                mediaType: 'text/plain',
                bytesBase64: Buffer.from('# report').toString('base64')
            }]
        }
    }
    try {
        await fixture.manager.start()
        const started = await fixture.manager.handle(
            { action: 'run', remote: 'hermes', prompt: 'write report' },
            context()
        )
        const output = await fixture.manager.handle(
            {
                action: 'publish',
                id: jobId(started),
                path: 'dist/report.md'
            },
            context()
        )
        assert.equal(publishedPath, 'dist/report.md')
        assert.match(output, /report\.md/)
        assert.equal((await fixture.store.list())[0].artifacts[0].artifactId, 'published-1')
    } finally {
        await fixture.dispose()
    }
})

test('resolves the exact structured pending request and rejects stale replies', async () => {
    const fixture = await managerFixture()
    let seenRequest: any
    fixture.provider.run = async () => ({
        state: 'permission_required',
        remoteState: 'permission_required',
        text: 'Allow write?',
        artifacts: [],
        pendingRequest: {
            id: 'request-current',
            kind: 'permission',
            prompt: 'Allow write?',
            options: [{ id: 'allow_once', name: 'Allow once' }]
        },
        providerState: { gatewaySessionId: 'session-1' }
    })
    fixture.provider.message = async (_agent, current, request) => {
        seenRequest = structuredClone(request)
        return completed(current.providerState)
    }
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle(
            { action: 'run', remote: 'hermes', prompt: 'edit', background: false },
            context()
        )
        const id = jobId(output)
        assert.match(output, /Request: request-current/)
        await assert.rejects(
            fixture.manager.handle(
                {
                    action: 'message',
                    id,
                    requestId: 'request-stale',
                    optionId: 'allow_once'
                },
                context()
            ),
            /stale/
        )
        await assert.rejects(
            fixture.manager.handle(
                {
                    action: 'message',
                    id,
                    optionId: 'allow_once'
                },
                context()
            ),
            /request id is required/i
        )
        const resolved = await fixture.manager.handle(
            {
                action: 'message',
                id,
                requestId: 'request-current',
                optionId: 'allow_once'
            },
            context()
        )
        assert.match(resolved, /State: completed/)
        assert.equal(seenRequest.requestId, 'request-current')
        assert.equal(seenRequest.optionId, 'allow_once')
    } finally {
        await fixture.dispose()
    }
})

test('a late provider response cannot resurrect a canceled conversation task', async () => {
    const fixture = await managerFixture()
    let finish!: (value: ReturnType<typeof completed>) => void
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => {
        started = resolve
    })
    fixture.provider.run = async () => {
        started()
        return new Promise((resolve) => {
            finish = resolve
        })
    }
    try {
        await fixture.manager.start()
        const pending = fixture.manager.handle(
            { action: 'run', remote: 'hermes', prompt: 'long task' },
            context()
        )
        await providerStarted
        assert.equal(await fixture.manager.cancelConversation('conversation-1'), 1)
        finish(completed({ gatewaySessionId: 'session-late' }))
        assert.match(await pending, /State: canceled/)
        assert.equal((await fixture.store.list())[0].state, 'canceled')
    } finally {
        await fixture.dispose()
    }
})

test('releases Gateway sessions and detaches jobs when a conversation is cleared', async () => {
    const fixture = await managerFixture()
    let closes = 0
    fixture.provider.run = async () => running()
    fixture.provider.close = async () => {
        closes += 1
    }
    try {
        await fixture.manager.start()
        await fixture.manager.handle(
            { action: 'run', remote: 'hermes', prompt: 'long work', background: true },
            context()
        )
        assert.equal(await fixture.manager.releaseConversation('conversation-1'), 1)
        const [released] = await fixture.store.list()
        assert.equal(closes, 1)
        assert.equal(released.state, 'canceled')
        assert.equal(released.parentConversationId, undefined)
        assert.equal(released.routing, undefined)
    } finally {
        await fixture.dispose()
    }
})

test('marks a newly created job failed when Gateway startup throws', async () => {
    const fixture = await managerFixture()
    fixture.provider.run = async () => {
        throw new Error('gateway connection failed')
    }
    try {
        await fixture.manager.start()
        await assert.rejects(
            fixture.manager.handle(
                {
                    action: 'run',
                    remote: 'hermes',
                    prompt: '开始',
                    background: false
                },
                context()
            ),
            /gateway connection failed/
        )
        const [current] = await fixture.store.list()
        assert.equal(current.state, 'failed')
        assert.match(current.error || '', /gateway connection failed/)
    } finally {
        await fixture.dispose()
    }
})

test('cancels the remote session and starts the next run with fresh state', async () => {
    const fixture = await managerFixture()
    const seen: Array<Record<string, unknown>> = []
    fixture.provider.run = async (_agent, current) => {
        seen.push(structuredClone(current.providerState))
        return running()
    }
    try {
        await fixture.manager.start()
        const started = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '长任务',
                background: true
            },
            context()
        )
        await fixture.manager.handle(
            { action: 'stop', id: jobId(started) },
            context()
        )
        await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '新任务',
                background: false
            },
            context()
        )
        assert.deepEqual(seen, [{}, {}])
    } finally {
        await fixture.dispose()
    }
})

test('runs without ChatLuna context, preserves the exact prompt, and waits for completion', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    const prompt = '  第一行不要改\n第二行：原样交给 Hermes  '
    let receivedPrompt = ''
    let polls = 0
    fixture.provider.run = async (_agent, _job, request) => {
        receivedPrompt = request.prompt
        return running()
    }
    fixture.provider.status = async (_agent, current) => {
        polls += 1
        return polls < 2
            ? running()
            : {
                  ...completed(current.providerState),
                  text: 'Hermes 已完成'
              }
    }
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle({
            action: 'run',
            remote: 'hermes',
            prompt
        })
        assert.equal(receivedPrompt, prompt)
        assert.ok(polls >= 2)
        assert.match(output, /State: completed/)
        assert.match(output, /Hermes 已完成/)
        const [current] = await fixture.store.list()
        assert.equal(current.parentConversationId, undefined)
        assert.equal(current.routing, undefined)
        assert.equal(current.background, false)
    } finally {
        await fixture.dispose()
    }
})

test('allows context-free background jobs and does not attempt ChatLuna delivery', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    let notifications = 0
    fixture.provider.run = async () => running()
    fixture.provider.status = async (_agent, current) => completed(current.providerState)
    fixture.manager = new DelegationManager(
        fixture.store,
        new DelegationProviderRegistry().register(fixture.provider),
        async () => {
            notifications += 1
        },
        { pollIntervalMs: 1 }
    )
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle({
            action: 'run',
            remote: 'hermes',
            prompt: '后台任务',
            background: true
        })
        assert.match(output, /State: running/)
        assert.match(output, /action=status/)
        await new Promise((resolve) => setTimeout(resolve, 20))
        const [current] = await fixture.store.list()
        assert.equal(current.state, 'completed')
        assert.equal(notifications, 0)
        assert.match(
            await fixture.manager.handle({
                action: 'status',
                remote: 'hermes',
                id: current.id
            }),
            /State: completed/
        )
    } finally {
        await fixture.dispose()
    }
})

test('delivers a synchronously completed background result and its artifacts', async () => {
    const fixture = await managerFixture()
    let notifications = 0
    let delivered: string[] = []
    fixture.provider.run = async () => ({
        ...completed({ gatewaySessionId: 'session-1' }),
        artifacts: [
            {
                artifactId: 'report-1',
                filename: 'report.pptx',
                mediaType:
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                url: 'https://files/report.pptx'
            }
        ]
    })
    fixture.manager = new DelegationManager(
        fixture.store,
        new DelegationProviderRegistry().register(fixture.provider),
        async () => {
            notifications += 1
        },
        {
            pollIntervalMs: 1,
            notifyArtifacts: async (_job, artifacts) => {
                delivered = artifacts.map((artifact) => artifact.artifactId || '')
            }
        }
    )
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '生成文件',
                background: true
            },
            context()
        )
        const id = jobId(output)
        for (let attempt = 0; attempt < 100 && !delivered.length; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        assert.equal(notifications, 1)
        assert.deepEqual(delivered, ['report-1'])
        assert.deepEqual((await fixture.store.get(id))?.notifiedArtifactIds, [
            'report-1'
        ])
    } finally {
        await fixture.dispose()
    }
})

test('serializes concurrent follow-up messages for the same job', async () => {
    const fixture = await managerFixture({ pollIntervalMs: 1 })
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
        releaseFirst = resolve
    })
    let calls = 0
    let active = 0
    let maximumActive = 0
    fixture.provider.run = async () => ({
        state: 'permission_required',
        remoteState: 'permission_required',
        text: '请选择',
        artifacts: [],
        providerState: { gatewaySessionId: 'session-1' }
    })
    fixture.provider.message = async (_agent, current) => {
        calls += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (calls === 1) await firstPending
        active -= 1
        return completed(current.providerState)
    }
    try {
        await fixture.manager.start()
        const started = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '需要授权',
                background: false
            },
            context()
        )
        const id = jobId(started)
        const first = fixture.manager.handle(
            { action: 'message', remote: 'hermes', id, prompt: '允许一次' },
            context()
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
        const second = fixture.manager.handle(
            { action: 'message', remote: 'hermes', id, prompt: '继续' },
            context()
        )
        releaseFirst()
        await Promise.all([first, second])
        assert.equal(calls, 2)
        assert.equal(maximumActive, 1)
    } finally {
        await fixture.dispose()
    }
})

test('stores structured artifacts and replaces prepared binary payloads with URLs', async () => {
    const fixture = await managerFixture({
        prepareArtifacts: async (artifacts) =>
            artifacts.map((artifact) => ({
                ...artifact,
                url: artifact.bytesBase64
                    ? 'http://127.0.0.1:5140/temp/result.png'
                    : artifact.url,
                bytesBase64: undefined
            }))
    })
    fixture.provider.run = async () => ({
        ...completed({ gatewaySessionId: 'session-1' }),
        artifacts: [
            { artifactId: 'data', data: { answer: 42 } },
            {
                artifactId: 'image',
                filename: 'result.png',
                mediaType: 'image/png',
                bytesBase64: 'aGVsbG8='
            }
        ]
    })
    try {
        await fixture.manager.start()
        const output = await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '生成产物',
                background: false
            },
            context()
        )
        const [current] = await fixture.store.list()
        assert.deepEqual(current.artifacts[0].data, { answer: 42 })
        assert.equal(current.artifacts[1].bytesBase64, undefined)
        assert.equal(
            current.artifacts[1].url,
            'http://127.0.0.1:5140/temp/result.png'
        )
        assert.match(output, /http:\/\/127\.0\.0\.1:5140\/temp\/result\.png/)
        assert.match(formatJob(current), /\{"answer":42\}/)
        assert.match(formatDelegationWakeup(current), /result\.png/)
    } finally {
        await fixture.dispose()
    }
})

test('retries failed artifact delivery without repeating the wakeup', async () => {
    const fixture = await managerFixture()
    let notifications = 0
    let artifactAttempts = 0
    fixture.provider.run = async () => ({
        ...completed({ gatewaySessionId: 'session-1' }),
        artifacts: [
            {
                artifactId: 'report-1',
                filename: 'report.pptx',
                mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                url: 'https://files/report.pptx'
            }
        ]
    })
    fixture.manager = new DelegationManager(
        fixture.store,
        new DelegationProviderRegistry().register(fixture.provider),
        async () => {
            notifications += 1
        },
        {
            pollIntervalMs: 1,
            notifyArtifacts: async () => {
                artifactAttempts += 1
                if (artifactAttempts === 1) throw new Error('temporary send failure')
            }
        }
    )
    try {
        await fixture.manager.start()
        await fixture.manager.handle(
            {
                action: 'run',
                remote: 'hermes',
                prompt: '生成文件',
                background: true
            },
            context()
        )
        for (let attempt = 0; attempt < 500 && artifactAttempts < 2; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        assert.equal(notifications, 1)
        assert.equal(artifactAttempts, 2)
    } finally {
        await fixture.dispose()
    }
})

async function managerFixture(options: any = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-manager-'))
    const store = new DelegationStore(path.join(directory, 'jobs.json'), 8)
    const provider = gatewayProvider()
    let manager = new DelegationManager(
        store,
        new DelegationProviderRegistry().register(provider),
        async () => undefined,
        options
    )
    return {
        directory,
        store,
        provider,
        get manager() {
            return manager
        },
        set manager(value: DelegationManager) {
            manager = value
        },
        async dispose() {
            await manager.stop()
            await rm(directory, { recursive: true, force: true })
        }
    }
}

function gatewayProvider(): DelegationProvider {
    return {
        type: 'gateway',
        listAgents: () => [agent()],
        async run() {
            return completed({ gatewaySessionId: 'session-1' })
        },
        async message(_agent, current) {
            return completed(current.providerState)
        },
        async status(_agent, current) {
            return completed(current.providerState)
        },
        async cancel(_agent, current) {
            return {
                state: 'canceled',
                remoteState: 'canceled',
                artifacts: [],
                providerState: structuredClone(current.providerState)
            }
        }
    }
}

function completed(providerState: Record<string, unknown>) {
    return {
        state: 'completed' as const,
        remoteState: 'completed',
        text: 'gateway complete',
        artifacts: [],
        providerState
    }
}

function running() {
    return {
        state: 'running' as const,
        remoteState: 'running',
        artifacts: [],
        providerState: { gatewaySessionId: 'session-1', protocol: 'acp' }
    }
}

function agent(): RemoteAgentInfo {
    return {
        id: 'hermes',
        name: 'Hermes',
        provider: 'gateway',
        remoteId: 'primary-gateway',
        remoteName: 'Nexus Gateway',
        agentId: 'hermes',
        protocol: 'acp',
        workspace: '/workspace',
        enabled: true,
        state: 'ready',
        skills: []
    }
}

function context(): DelegationContext {
    return {
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        routing: {
            platform: 'test',
            selfId: 'bot',
            userId: 'user',
            isDirect: true
        }
    }
}

function job(id: string, provider: string) {
    const now = Date.now()
    return {
        schemaVersion: 2,
        id,
        provider,
        agentId: 'hermes',
        agentName: 'Hermes',
        remoteId: 'primary-gateway',
        remoteName: 'Nexus Gateway',
        providerAgentId: 'hermes',
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        routing: {
            platform: 'test',
            selfId: 'bot',
            userId: 'user',
            isDirect: true
        },
        state: 'completed',
        background: false,
        prompt: 'work',
        providerState: {},
        artifacts: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: now,
        expiresAt: now + 60_000
    }
}

function jobId(value: string) {
    const match = value.match(/AgentNexus job: ([^\s]+)/)
    assert.ok(match, `missing job id in output: ${value}`)
    return match[1]
}
