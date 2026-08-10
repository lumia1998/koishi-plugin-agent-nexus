import assert from 'node:assert/strict'
import test from 'node:test'
import { Message, Task, TaskState } from '@a2a-js/sdk'
import { PiAdapter, parsePiJsonOutput } from '../src/adapters/pi.ts'
import { listAdapters } from '../src/adapters/index.ts'
import {
    limitResponseBody,
    normalizeTaskResult,
    validateRemoteUrl
} from '../src/a2a/client.ts'
import { NexusA2AExecutor } from '../src/a2a/executor.ts'

const runtime = {
    openclawAgent: 'default',
    claudeSkipPermissions: false,
    codexBypassSandbox: false,
    opencodeAuto: true,
    defaultTimeoutMs: 1000
}

test('limits declared and streamed A2A response bodies', async () => {
    assert.throws(
        () =>
            limitResponseBody(
                new Response('12345', {
                    headers: { 'content-length': '5' }
                }),
                4
            ),
        /exceeds 4 bytes/
    )

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('123'))
            controller.enqueue(new TextEncoder().encode('456'))
            controller.close()
        }
    })
    await assert.rejects(
        () => limitResponseBody(new Response(stream), 4).text(),
        /exceeds 4 bytes/
    )
    assert.equal(
        await limitResponseBody(new Response('safe'), 4).text(),
        'safe'
    )
})

test('registers Pi and builds its non-interactive command safely', () => {
    const adapter = new PiAdapter()
    assert.ok(listAdapters().some((item) => item.kind === 'pi'))
    assert.deepEqual(adapter.skillDirs('/home/agent'), [
        '/home/agent/.pi/agent/skills',
        '/home/agent/.pi/skills'
    ])
    assert.equal(
        adapter.buildInnerCommand('"$PROMPT"', {
            prompt: '',
            model: 'provider/model; touch /tmp/unsafe',
            runtime
        }),
        "pi -p --no-session --model 'provider/model; touch /tmp/unsafe' \"$PROMPT\""
    )
    assert.equal(adapter.parseResult('', 'fallback', 0, false, 'pi').text, 'fallback')

    assert.equal(
        adapter.buildInnerCommand('"$PROMPT"', {
            prompt: '',
            sessionMode: 'managed',
            providerState: { sessionId: 'pi-session-1' },
            runtime
        }),
        "pi --mode json --session 'pi-session-1' \"$PROMPT\""
    )

    const jsonl = [
        JSON.stringify({ type: 'session', version: 3, id: 'pi-session-2' }),
        JSON.stringify({
            type: 'message_end',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'managed response' }]
            }
        })
    ].join('\n')
    assert.deepEqual(parsePiJsonOutput(jsonl), {
        sessionId: 'pi-session-2',
        text: 'managed response'
    })
    const managed = adapter.parseResult(jsonl, '', 0, false, 'pi --mode json')
    assert.equal(managed.text, 'managed response')
    assert.deepEqual(managed.providerState, { sessionId: 'pi-session-2' })
})

test('validates A2A remote URLs and normalizes task results', () => {
    assert.equal(validateRemoteUrl('https://agent.example/a2a/'), 'https://agent.example/a2a')
    assert.throws(() => validateRemoteUrl('ftp://agent.example'))
    assert.throws(() => validateRemoteUrl('https://user:pass@agent.example'))
    assert.throws(() => validateRemoteUrl('not a url'))

    const task = Task.fromJSON({
        id: 'task-1',
        contextId: 'context-1',
        status: {
            state: 'TASK_STATE_COMPLETED',
            message: {
                messageId: 'message-1',
                role: 'ROLE_AGENT',
                parts: [{ text: 'done', mediaType: 'text/plain' }]
            }
        },
        artifacts: [
            {
                artifactId: 'artifact-1',
                name: 'report',
                parts: [{ url: 'https://agent.example/report.txt', filename: 'report.txt' }]
            }
        ]
    })
    const view = normalizeTaskResult('remote-1', task)
    assert.equal(view.taskId, 'task-1')
    assert.equal(view.state, 'TASK_STATE_COMPLETED')
    assert.equal(view.text, 'done')
    assert.deepEqual(view.artifacts, [
        {
            artifactId: 'artifact-1',
            name: 'report',
            url: 'https://agent.example/report.txt',
            filename: 'report.txt'
        }
    ])

    const message = Message.fromJSON({
        messageId: 'message-2',
        taskId: 'task-standalone',
        contextId: 'context-standalone',
        role: 'ROLE_AGENT',
        parts: [{ text: 'standalone', mediaType: 'text/plain' }]
    })
    const standalone = normalizeTaskResult('remote-1', message)
    assert.equal(standalone.text, 'standalone')
    assert.equal(standalone.taskId, 'task-standalone')
    assert.equal(standalone.contextId, 'context-standalone')

    const artifactOnly = Task.fromJSON({
        id: 'task-artifact',
        contextId: 'context-artifact',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [
            {
                artifactId: 'artifact-result',
                name: 'result',
                parts: [
                    { text: 'artifact answer', mediaType: 'text/plain' },
                    { data: { count: 2 }, mediaType: 'application/json' }
                ]
            }
        ]
    })
    const artifactView = normalizeTaskResult('remote-1', artifactOnly)
    assert.equal(artifactView.text, 'artifact answer')
    assert.deepEqual(artifactView.artifacts[1].data, { count: 2 })
})

test('keeps input-required A2A tasks cancellable and resumes the same task id', async () => {
    let outcome: any = { kind: 'waiting', reply: 'choose one' }
    let cancelCalls = 0
    const nexus = {
        runInSession: async () => outcome,
        cancelSessions: async () => {
            cancelCalls += 1
            return 1
        }
    }
    const executor = new NexusA2AExecutor(nexus as any)
    const first = captureBus()
    await executor.execute(requestContext('task-wait', 'context-wait'), first.bus)
    assert.equal(executor.activeCount, 1)
    assert.equal(lastState(first.events), TaskState.TASK_STATE_INPUT_REQUIRED)

    outcome = { kind: 'invalid_input', reply: 'reply with a valid choice' }
    const invalid = captureBus()
    await executor.execute(requestContext('task-wait', 'context-wait'), invalid.bus)
    assert.equal(executor.activeCount, 1)
    assert.equal(lastState(invalid.events), TaskState.TASK_STATE_INPUT_REQUIRED)

    outcome = { kind: 'completed', result: agentResult() }
    const followUp = captureBus()
    await executor.execute(requestContext('task-wait', 'context-wait'), followUp.bus)
    assert.equal(executor.activeCount, 0)
    assert.equal(lastState(followUp.events), TaskState.TASK_STATE_COMPLETED)

    outcome = { kind: 'waiting', reply: 'need input' }
    const cancellable = captureBus()
    await executor.execute(requestContext('task-cancel', 'context-cancel'), cancellable.bus)
    await executor.cancelTask('task-cancel', cancellable.bus)
    assert.equal(executor.activeCount, 0)
    assert.equal(lastState(cancellable.events), TaskState.TASK_STATE_CANCELED)
    assert.equal(cancelCalls, 1)
})

test('binds bridge managed sessions to A2A context instead of task id', async () => {
    const identities: any[] = []
    let fallbackCalls = 0
    const executor = new NexusA2AExecutor({
        runInSession: async () => {
            fallbackCalls += 1
            return { kind: 'completed', result: agentResult() }
        },
        runInContextSession: async (identity: any) => {
            identities.push(identity)
            return { kind: 'completed', result: agentResult() }
        },
        cancelSessions: async () => 0
    } as any)

    await executor.execute(
        requestContext('task-context-1', 'shared-context'),
        captureBus().bus
    )
    await executor.execute(
        requestContext('task-context-2', 'shared-context'),
        captureBus().bus
    )

    assert.equal(fallbackCalls, 0)
    assert.deepEqual(
        identities.map((identity) => identity.channelId),
        ['context:shared-context', 'context:shared-context']
    )
})

test('shuts down active A2A executions and publishes cancellation once', async () => {
    let finish: (value: any) => void = () => undefined
    const pending = new Promise<any>((resolve) => {
        finish = resolve
    })
    const nexus = {
        runInSession: async () => pending,
        cancelSessions: async () => {
            finish({ kind: 'cancelled' })
            return 1
        }
    }
    const executor = new NexusA2AExecutor(nexus as any)
    const captured = captureBus()
    const execution = executor.execute(requestContext('task-active', 'context-active'), captured.bus)
    await Promise.resolve()
    assert.equal(executor.activeCount, 1)

    await executor.shutdown()
    assert.equal(executor.activeCount, 0)
    assert.equal(lastState(captured.events), TaskState.TASK_STATE_CANCELED)
    assert.equal(
        captured.events.filter(
            (event) =>
                event.kind === 'statusUpdate' &&
                event.data.status.state === TaskState.TASK_STATE_CANCELED
        ).length,
        1
    )

    await execution
})

test('preserves active A2A tasks as input-required during bridge restart', async () => {
    let cancelCalls = 0
    const executor = new NexusA2AExecutor({
        runInSession: async (_identity: any, input: any) =>
            await new Promise<any>((resolve) => {
                input.signal?.addEventListener(
                    'abort',
                    () => resolve({ kind: 'waiting', reply: 'restart' }),
                    { once: true }
                )
            }),
        cancelSessions: async () => {
            cancelCalls += 1
            return 1
        }
    } as any)
    const captured = captureBus()
    const execution = executor.execute(
        requestContext('task-restart', 'context-restart'),
        captured.bus
    )
    await Promise.resolve()

    await executor.shutdown({ preserveForRestart: true })
    await execution
    assert.equal(cancelCalls, 0)
    assert.equal(lastState(captured.events), TaskState.TASK_STATE_INPUT_REQUIRED)
})

test('rejects A2A work above the configured concurrency limit', async () => {
    let finish: (value: any) => void = () => undefined
    const pending = new Promise<any>((resolve) => {
        finish = resolve
    })
    const executor = new NexusA2AExecutor(
        {
            runInSession: async () => pending,
            cancelSessions: async () => 0
        } as any,
        { maxConcurrentTasks: 1, maxTrackedTasks: 2 }
    )
    const first = captureBus()
    const firstRun = executor.execute(
        requestContext('task-limit-1', 'context-limit-1'),
        first.bus
    )
    await Promise.resolve()
    assert.equal(executor.runningCount, 1)

    const second = captureBus()
    await executor.execute(
        requestContext('task-limit-2', 'context-limit-2'),
        second.bus
    )
    assert.equal(lastState(second.events), TaskState.TASK_STATE_FAILED)

    finish({ kind: 'completed', result: agentResult() })
    await firstRun
    assert.equal(executor.runningCount, 0)
})

function requestContext(taskId: string, contextId: string) {
    const userMessage = Message.fromJSON({
        messageId: `${taskId}-message`,
        taskId,
        contextId,
        role: 'ROLE_USER',
        parts: [{ text: 'run task', mediaType: 'text/plain' }],
        metadata: { agent: 'pi' }
    })
    return {
        taskId,
        contextId,
        userMessage,
        request: { metadata: {} },
        context: { user: { userName: 'peer' } }
    } as any
}

function captureBus() {
    const events: any[] = []
    return {
        events,
        bus: {
            publish(event: any) {
                events.push(event)
            }
        } as any
    }
}

function lastState(events: any[]) {
    return events.filter((event) => event.kind === 'statusUpdate').at(-1)?.data.status.state
}

function agentResult() {
    return {
        agent: 'pi',
        hostId: 'host-1',
        text: 'completed',
        files: [],
        images: [],
        raw: 'completed',
        exitCode: 0,
        timedOut: false,
        command: 'pi'
    }
}
