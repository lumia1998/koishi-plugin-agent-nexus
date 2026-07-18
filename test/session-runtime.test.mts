import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionManager } from '../src/sessions/manager.ts'
import { MemorySessionStorage } from '../src/sessions/storage.ts'
import { AgentRunner, type DelegateResult } from '../src/runtime/runner.ts'
import { buildSessionPrompt } from '../src/runtime/prompt.ts'
import {
    cleanHermesCliNoise,
    extractHermesSessionId,
    HermesAdapter
} from '../src/adapters/hermes.ts'
import { parseInteractiveCommandInput } from '../src/utils/command.ts'
import {
    parseAgentControl,
    resolvePendingAction
} from '../src/runtime/protocol.ts'

test('applies state-specific session TTLs and keeps running sessions alive', async () => {
    let now = 1_000
    const storage = new MemorySessionStorage()
    const manager = new SessionManager(storage, {
        now: () => now,
        createId: () => 'session-1'
    })
    let session = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes'
    })
    assert.equal(session.expireAt, 0)

    session.status = 'waiting_input'
    session = await manager.update(session)
    assert.equal(session.expireAt, now + 30 * 60 * 1000)

    now += 30 * 60 * 1000
    assert.equal(await manager.cleanupExpired(), 1)
    const archived = await manager.get(session.id)
    assert.equal(archived?.status, 'failed')
    assert.equal(archived?.endReason, 'expired')
    assert.equal(archived?.endedAt, now)
})

test('supports a per-session idle TTL without expiring active runs', async () => {
    let now = 10_000
    const manager = new SessionManager(new MemorySessionStorage(), {
        now: () => now,
        createId: () => 'session-1'
    })
    let session = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        status: 'waiting_input',
        data: { ttlMs: 15 * 60 * 1000 }
    })
    assert.equal(session.expireAt, now + 15 * 60 * 1000)
    session.status = 'running'
    session = await manager.update(session)
    assert.equal(session.expireAt, 0)
})

test('isolates sessions by bot self id', async () => {
    let id = 0
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => `session-${++id}`
    })
    await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        selfId: 'bot-a',
        agent: 'hermes',
        status: 'waiting_input'
    })
    const otherBot = await manager.resolve({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        selfId: 'bot-b',
        createIfMissing: false
    })
    assert.equal(otherBot.session, undefined)
})

test('resolves sessions by status priority and creates on ambiguity', async () => {
    let id = 0
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => `session-${++id}`
    })
    await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        status: 'waiting_input'
    })
    const running = await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'codex',
        status: 'running'
    })

    const resolved = await manager.resolve({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    })
    assert.equal(resolved.session?.id, running.id)
    assert.equal(resolved.created, false)

    await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'opencode',
        status: 'running'
    })
    const ambiguous = await manager.resolve({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        create: { agent: 'auto' }
    })
    assert.equal(ambiguous.created, true)
    assert.equal(ambiguous.ambiguous, true)
})

test('restores interrupted running tasks behind an explicit retry confirmation', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        status: 'running'
    })
    const recovered = await manager.recoverTasks()
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].status, 'waiting_confirm')
    assert.equal(recovered[0].pendingAction?.type, 'confirm')
})

test('cancels an interrupted task without invoking the agent again', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    await manager.create({
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        status: 'running'
    })
    await manager.recoverTasks()
    let calls = 0
    const runner = new AgentRunner(manager, async () => {
        calls += 1
        return resultFixture('should not run')
    })
    const result = await runner.resume(
        { userId: 'u1', channelId: 'c1', platform: 'test' },
        '取消'
    )
    assert.equal(result.kind, 'cancelled')
    assert.equal(result.session?.endReason, 'cancelled')
    assert.equal(calls, 0)
})

test('parses skill wait responses and resolves numbered choices', () => {
    const raw = JSON.stringify({
        status: 'waiting_confirm',
        prompt: '请选择漫画',
        options: [
            { id: 1, title: '漫画A' },
            { id: 2, title: '漫画B' }
        ],
        data: { query: '漫画' }
    })
    const control = parseAgentControl({ raw, text: raw })
    assert.equal(control?.status, 'waiting_confirm')
    assert.equal(control?.pendingAction?.type, 'select')
    assert.equal(control?.pendingAction?.options?.[1].label, '漫画B')

    const selected = resolvePendingAction(control!.pendingAction!, '2')
    assert.equal(selected.matched, true)
    assert.equal(selected.label, '2. 漫画B')
    assert.deepEqual(selected.value, { id: 2, title: '漫画B' })
})

test('keeps visible skill results when a wait control only contains a prompt', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-visible-results'
    })
    const runner = new AgentRunner(manager, async () =>
        resultFixture(`1. 本子A\n2. 本子B\n\n<nexus_session>\n{"status":"waiting_confirm","prompt":"回复序号或禁漫ID下载花火的本子"}\n</nexus_session>`)
    )
    const outcome = await runner.run(
        { userId: 'u1', channelId: 'c1', platform: 'test' },
        { agent: 'hermes', prompt: '找一个花火的本子' }
    )
    assert.equal(outcome.kind, 'waiting')
    assert.match(outcome.reply || '', /1\. 本子A/)
    assert.match(outcome.reply || '', /2\. 本子B/)
    assert.match(outcome.reply || '', /回复序号或禁漫ID/)
    assert.doesNotMatch(outcome.reply || '', /nexus_session/)
})

test('runner preserves Nexus context across one-shot agent processes', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    const prompts: string[] = []
    let call = 0
    const runner = new AgentRunner(manager, async (input) => {
        prompts.push(input.prompt)
        call += 1
        if (call === 1) {
            const raw = JSON.stringify({
                status: 'waiting_confirm',
                prompt: '请选择漫画',
                options: [
                    { id: 1, title: '漫画A' },
                    { id: 2, title: '漫画B' }
                ],
                data: { skill: 'search_comic', query: '漫画' }
            })
            return resultFixture(raw)
        }
        return resultFixture(
            JSON.stringify({
                status: 'completed',
                output: '开始下载漫画B'
            })
        )
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }

    const waiting = await runner.run(identity, {
        agent: 'hermes',
        prompt: '搜索漫画',
        publishFiles: true
    })
    assert.equal(waiting.kind, 'waiting')
    assert.match(waiting.reply || '', /2\. 漫画B/)
    assert.equal(waiting.session?.status, 'waiting_confirm')

    const resumed = await runner.resume(identity, '2')
    assert.equal(resumed.kind, 'completed')
    assert.equal(resumed.result?.text, '开始下载漫画B')
    assert.equal(call, 2)
    assert.match(prompts[1], /搜索漫画/)
    assert.match(prompts[1], /2\. 漫画B/)
    assert.match(prompts[1], /search_comic/)
})

test('runner keeps waiting when a selection is invalid', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    let calls = 0
    const runner = new AgentRunner(manager, async () => {
        calls += 1
        return resultFixture(
            JSON.stringify({
                status: 'waiting_confirm',
                prompt: '请选择',
                options: [{ id: 1, label: 'A' }]
            })
        )
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }
    await runner.run(identity, { agent: 'hermes', prompt: '开始' })
    const invalid = await runner.resume(identity, '99')
    assert.equal(invalid.kind, 'invalid_input')
    assert.equal(invalid.session?.status, 'waiting_confirm')
    assert.equal(calls, 1)
})

test('atomically claims a waiting session before resuming it', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    let calls = 0
    const runner = new AgentRunner(manager, async () => {
        calls += 1
        if (calls === 1) {
            return resultFixture(
                JSON.stringify({
                    status: 'waiting_confirm',
                    prompt: '确认继续？'
                })
            )
        }
        return resultFixture(
            JSON.stringify({ status: 'completed', output: 'done' })
        )
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }
    await runner.run(identity, { agent: 'hermes', prompt: 'start' })
    const outcomes = await Promise.all([
        runner.resume(identity, '确认'),
        runner.resume(identity, '确认')
    ])
    assert.equal(calls, 2)
    assert.equal(outcomes.filter((item) => item.kind === 'completed').length, 1)
    assert.equal(outcomes.filter((item) => item.kind === 'busy').length, 1)
})

test('does not let the same ChatLuna request confirm its own wait action', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    let calls = 0
    const runner = new AgentRunner(manager, async () => {
        calls += 1
        return resultFixture(
            JSON.stringify({
                status: 'waiting_confirm',
                prompt: '确认继续？'
            })
        )
    })
    const identity = {
        userId: 'u1',
        channelId: 'conversation-1',
        platform: 'test'
    }
    await runner.run(
        identity,
        { agent: 'hermes', prompt: 'start' },
        { requestId: 'message-1' }
    )
    const repeated = await runner.run(
        identity,
        { agent: 'hermes', prompt: '确认' },
        { requestId: 'message-1' }
    )
    assert.equal(repeated.kind, 'waiting')
    assert.equal(repeated.result, undefined)
    assert.equal(calls, 1)
})

test('keeps the newest message and valid JSON when prompt context is large', () => {
    const session = {
        id: 'session-1',
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        agent: 'hermes',
        status: 'running' as const,
        messages: [
            ...Array.from({ length: 29 }, (_, index) => ({
                role: 'assistant' as const,
                content: `${index}:${'x'.repeat(5000)}`,
                createdAt: index
            })),
            {
                role: 'user' as const,
                content: '最新选择：2',
                createdAt: 99
            }
        ],
        data: { skillState: { blob: 'y'.repeat(20000) } },
        createdAt: 1,
        updatedAt: 1,
        expireAt: 0
    }
    const prompt = buildSessionPrompt(session)
    const context = prompt.split('Nexus Session:\n')[1]
    const parsed = JSON.parse(context)
    assert.equal(parsed.messages.at(-1).content, '最新选择：2')
    assert.ok(context.length <= 25000)
})

test('preserves skill state when a later control response omits data', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    let calls = 0
    const runner = new AgentRunner(manager, async () => {
        calls += 1
        return resultFixture(
            calls === 1
                ? JSON.stringify({
                      status: 'waiting_input',
                      prompt: '输入关键词',
                      data: { cursor: 7 }
                  })
                : JSON.stringify({
                      status: 'waiting_input',
                      prompt: '继续输入'
                  })
        )
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }
    await runner.run(identity, { agent: 'hermes', prompt: 'start' })
    const next = await runner.resume(identity, 'keyword')
    assert.deepEqual(next.session?.data?.skillState, { cursor: 7 })
})

test('cancels waiting sessions through the shared runtime', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    const runner = new AgentRunner(manager, async () =>
        resultFixture(
            JSON.stringify({
                status: 'waiting_input',
                prompt: '请输入'
            })
        )
    )
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }
    const waiting = await runner.run(identity, {
        agent: 'hermes',
        prompt: 'start'
    })
    assert.equal(await runner.cancel(identity), 1)
    const cancelled = await manager.get(waiting.session!.id)
    assert.equal(cancelled?.status, 'failed')
    assert.equal(cancelled?.pendingAction, undefined)
})

test('aborts a running executor through the shared runtime', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    const runner = new AgentRunner(manager, async (input) => {
        return await new Promise<DelegateResult>((resolve) => {
            input.signal?.addEventListener(
                'abort',
                () => resolve({ ...resultFixture(''), exitCode: 130 }),
                { once: true }
            )
        })
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }
    const running = runner.run(identity, { agent: 'hermes', prompt: 'start' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(await runner.cancel(identity), 1)
    const outcome = await running
    assert.equal(outcome.kind, 'cancelled')
    assert.equal(outcome.reply, 'Agent 任务已中止。')
})

test('passive message handling ignores unrelated invalid selections', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    let calls = 0
    const runner = new AgentRunner(manager, async () => {
        calls += 1
        return resultFixture(
            JSON.stringify({
                status: 'waiting_confirm',
                prompt: '请选择',
                options: [{ id: 1, label: 'A' }]
            })
        )
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test'
    }
    await runner.run(identity, { agent: 'hermes', prompt: 'start' })
    const ignored = await runner.resume(identity, '今天天气如何', undefined, {
        passive: true
    })
    assert.equal(ignored.kind, 'not_found')
    assert.equal(calls, 1)
})

test('builds and parses Hermes managed chat session commands', () => {
    const adapter = new HermesAdapter()
    const runtime = {
        openclawAgent: 'default',
        claudeSkipPermissions: true,
        codexBypassSandbox: true,
        opencodeAuto: true,
        defaultTimeoutMs: 1000
    }
    const first = adapter.buildInnerCommand('"$PROMPT"', {
        prompt: 'hello',
        runtime,
        sessionMode: 'managed'
    })
    assert.equal(
        first,
        'hermes chat --quiet --yolo --source agent-nexus -q "$PROMPT"'
    )
    const resumed = adapter.buildInnerCommand('"$PROMPT"', {
        prompt: '2',
        runtime,
        sessionMode: 'managed',
        providerState: { sessionId: '20260717_120000_a1b2c3' }
    })
    assert.equal(
        resumed,
        "hermes chat --quiet --yolo --resume '20260717_120000_a1b2c3' -q \"$PROMPT\""
    )
    assert.equal(
        adapter.buildInnerCommand('"$PROMPT"', {
            prompt: 'hello',
            runtime,
            sessionMode: 'managed',
            executablePath: '/opt/hermes/bin/hermes'
        }),
        "'/opt/hermes/bin/hermes' chat --quiet --yolo --source agent-nexus -q \"$PROMPT\""
    )
    assert.equal(
        extractHermesSessionId(
            'warning\nsession_id: old\n\nsession_id: 20260717_120000_a1b2c3\n'
        ),
        '20260717_120000_a1b2c3'
    )
    const result = adapter.parseResult(
        'Warning: Unknown toolsets: messaging\n搜索结果',
        '\nsession_id: 20260717_120000_a1b2c3\n',
        0,
        false,
        first
    )
    assert.equal(result.text, '搜索结果')
    assert.equal(result.providerState?.sessionId, '20260717_120000_a1b2c3')
    const mixed = adapter.parseResult(
        '回复序号',
        '\u001b[36msession_id: mixed-session\u001b[0m\n1. 本子A\n2. 本子B',
        0,
        false,
        first
    )
    assert.match(mixed.text, /1\. 本子A/)
    assert.match(mixed.text, /回复序号/)
    assert.equal(mixed.providerState?.sessionId, 'mixed-session')
    assert.match(mixed.raw, /2\. 本子B/)
    assert.equal(
        cleanHermesCliNoise(
            '\u001b[1;31mWarning: Unknown toolsets: messaging\u001b[0m\n正常回复'
        ),
        '正常回复'
    )
    assert.equal(
        cleanHermesCliNoise('Warning: 模型即将限流\n正常回复'),
        'Warning: 模型即将限流\n正常回复'
    )
})

test('accepts the requested trailing -q interactive exit syntax', () => {
    assert.deepEqual(parseInteractiveCommandInput('开发机 -q'), {
        input: '开发机',
        quit: true
    })
    assert.deepEqual(parseInteractiveCommandInput('开发机', true), {
        input: '开发机',
        quit: true
    })
    assert.deepEqual(parseInteractiveCommandInput('搜索 -q 参数'), {
        input: '搜索 -q 参数',
        quit: false
    })
})

test('keeps an interactive session active and resumes Hermes provider state', async () => {
    const manager = new SessionManager(new MemorySessionStorage(), {
        createId: () => 'session-1'
    })
    const inputs: Array<{ prompt: string; sessionId?: string }> = []
    let call = 0
    const runner = new AgentRunner(manager, async (input) => {
        call += 1
        inputs.push({
            prompt: input.prompt,
            sessionId: input.providerState?.sessionId
        })
        return {
            ...resultFixture(call === 1 ? '这里有两个结果' : '开始下载第二个'),
            text: call === 1 ? '这里有两个结果' : '开始下载第二个',
            providerState: { sessionId: '20260717_120000_a1b2c3' }
        }
    })
    const identity = {
        userId: 'u1',
        channelId: 'c1',
        platform: 'test',
        selfId: 'bot-a'
    }
    await runner.startInteractive(
        identity,
        {
            agent: 'hermes',
            hostId: 'host-1',
            sessionMode: 'managed'
        },
        15 * 60 * 1000
    )
    const first = await runner.resume(identity, '搜索漫画', undefined, {
        passive: true
    })
    assert.equal(first.session?.status, 'waiting_input')
    assert.equal(
        first.session?.data?.providerState &&
            (first.session.data.providerState as any).sessionId,
        '20260717_120000_a1b2c3'
    )

    const second = await runner.resume(identity, '2', undefined, {
        passive: true
    })
    assert.equal(second.result?.text, '开始下载第二个')
    assert.equal(second.session?.status, 'waiting_input')
    assert.equal(inputs[1].sessionId, '20260717_120000_a1b2c3')
    assert.match(inputs[1].prompt, /继续当前 Hermes 会话/)
    assert.equal(await runner.endInteractive(identity, 'hermes', 'host-1'), 1)
    assert.equal(await runner.hasWaiting(identity), false)
})

function resultFixture(raw: string): DelegateResult {
    return {
        agent: 'hermes',
        text: raw,
        raw,
        files: [],
        images: [],
        exitCode: 0,
        timedOut: false,
        command: 'hermes -z "$PROMPT"',
        hostId: 'host-1'
    }
}
