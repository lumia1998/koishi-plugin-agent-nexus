import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    DelegationManager,
    DelegationProviderRegistry,
    DelegationStore,
    formatDelegationUserReply,
    formatJob,
    type DelegationContext,
    type DelegationJob,
    type DelegationProvider,
    type RemoteAgentInfo
} from '../src/delegation/index.ts'
import {
    formatDelegationWakeup,
    notifyChatLunaDelegation
} from '../src/delegation/wakeup.ts'

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

test('automatically continues the unique pending job for the exact sender route', async () => {
    const fixture = await managerFixture()
    const seen: string[] = []
    fixture.provider.run = async () => ({
        state: 'input_required',
        remoteState: 'input_required',
        text: '请选择套餐',
        pendingRequest: {
            id: 'choose-meal',
            kind: 'input',
            prompt: '请选择套餐',
            inputType: 'choice',
            options: [{ id: 'meal-a', name: '套餐 A' }]
        },
        artifacts: [],
        providerState: { gatewaySessionId: 'session-1' }
    })
    fixture.provider.message = async (_agent, current, request) => {
        seen.push(request.prompt)
        return {
            state: 'input_required',
            remoteState: 'input_required',
            text: '请回复支付完成',
            pendingRequest: {
                id: 'payment-1',
                kind: 'input',
                prompt: '请回复支付完成',
                inputType: 'payment',
                metadata: {
                    orderId: 'order-1',
                    paymentUrl: 'https://pay.example/order-1'
                }
            },
            artifacts: [],
            providerState: structuredClone(current.providerState)
        }
    }
    try {
        await fixture.manager.start()
        await fixture.manager.handle(
            { action: 'run', remote: 'hermes', prompt: '下单', background: false },
            context()
        )
        const continuation = await fixture.manager.continuePendingFromMessage(
            context(),
            '第一个'
        )
        assert.equal(continuation.handled, true)
        assert.equal(continuation.job?.state, 'input_required')
        assert.equal(continuation.job?.pendingRequest?.inputType, 'payment')
        assert.deepEqual(seen, ['第一个'])
        assert.match(formatDelegationUserReply(continuation.job!), /支付完成/)
        assert.match(
            formatDelegationUserReply(continuation.job!),
            /https:\/\/pay\.example\/order-1/
        )

        const otherUser = context()
        otherUser.routing.userId = 'other-user'
        const rejected = await fixture.manager.continuePendingFromMessage(
            otherUser,
            '支付完成'
        )
        assert.equal(rejected.handled, false)
    } finally {
        await fixture.dispose()
    }
})

test('ends a pending job after continuation failure and does not capture later messages', async () => {
    const fixture = await managerFixture()
    fixture.provider.run = async () => ({
        state: 'input_required',
        remoteState: 'input_required',
        text: '请选择套餐',
        pendingRequest: {
            id: 'choose-meal',
            kind: 'input',
            prompt: '请选择套餐',
            inputType: 'choice',
            options: [{ id: 'meal-a', name: '套餐 A' }]
        },
        artifacts: [],
        providerState: {
            gatewaySessionId: 'stale-session',
            protocol: 'acp'
        }
    })
    fixture.provider.message = async () => {
        throw new Error(
            'Nexus Gateway request failed (404): Agent Nexus session not found: stale-session'
        )
    }
    try {
        await fixture.manager.start()
        await fixture.manager.handle(
            { action: 'run', remote: 'hermes', prompt: '下单', background: false },
            context()
        )
        const [before] = await fixture.store.list()
        await assert.rejects(
            () => fixture.manager.continuePendingFromMessage(context(), '同意'),
            /404.*session not found/
        )

        const failed = await fixture.store.get(before.id)
        assert.equal(failed?.state, 'failed')
        assert.equal(failed?.pendingRequest, undefined)
        assert.deepEqual(failed?.providerState, {})
        assert.match(failed?.error || '', /404.*session not found/)

        const nextMessage = await fixture.manager.continuePendingFromMessage(
            context(),
            'chatluna.delete'
        )
        assert.deepEqual(nextMessage, { handled: false })
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
        assert.doesNotMatch(output, /http:\/\/127\.0\.0\.1:5140\/temp\/result\.png/)
        assert.match(formatJob(current), /\{"answer":42\}/)
        assert.match(formatDelegationWakeup(current), /result\.png/)
        assert.doesNotMatch(formatJob(current), /http:\/\/127\.0\.0\.1:5140\/temp\/result\.png/)
        assert.doesNotMatch(formatDelegationWakeup(current), /http:\/\/127\.0\.0\.1:5140\/temp\/result\.png/)
        assert.doesNotMatch(
            formatDelegationUserReply(current),
            /http:\/\/127\.0\.0\.1:5140\/temp\/result\.png/
        )
    } finally {
        await fixture.dispose()
    }
})

test('keeps published files as media while hiding their URLs from the wakeup text', async () => {
    const url = 'http://127.0.0.1:5140/temp/result.zip'
    const current = {
        ...job('background-file', 'gateway'),
        background: true,
        activeRunId: 'run-1',
        artifacts: [{
            artifactId: 'file-1',
            name: 'result.zip',
            filename: 'result.zip',
            mediaType: 'application/zip',
            url
        }]
    } as DelegationJob
    let invocation: any
    await notifyChatLunaDelegation(
        {
            async invoke(input) {
                invocation = input
                return { ok: true }
            }
        },
        current
    )
    assert.ok(Array.isArray(invocation.message))
    assert.doesNotMatch(invocation.message[0].text, /127\.0\.0\.1:5140/)
    assert.match(invocation.message[0].text, /do not print, quote, or expose/)
    assert.deepEqual(invocation.message[1], {
        type: 'file_url',
        file_url: { url, mimeType: 'application/zip' }
    })
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
