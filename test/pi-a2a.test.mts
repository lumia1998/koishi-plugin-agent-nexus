import assert from 'node:assert/strict'
import test from 'node:test'
import { Message, Task } from '@a2a-js/sdk'
import { PiAdapter } from '../src/adapters/pi.ts'
import { listAdapters } from '../src/adapters/index.ts'
import {
    limitResponseBody,
    normalizeTaskResult,
    validateRemoteUrl
} from '../src/a2a/client.ts'

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
test('registers Pi with its supported skill directories', () => {
    const adapter = new PiAdapter()
    assert.ok(listAdapters().some((item) => item.kind === 'pi'))
    assert.deepEqual(adapter.skillDirs('/home/agent'), [
        '/home/agent/.pi/agent/skills',
        '/home/agent/.pi/skills'
    ])
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
