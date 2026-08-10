import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Task, TaskState } from '@a2a-js/sdk'
import {
    A2ADelegationManager,
    type A2ADelegationBackend
} from '../src/a2a/delegation-manager.ts'
import {
    A2ADelegationStore,
    type A2ADelegationContext,
    type A2ADelegationTask
} from '../src/a2a/delegation-store.ts'
import { BoundedTaskStore } from '../src/bridge/task-store.ts'
import { notifyChatLunaA2ADelegation } from '../src/a2a/chatluna-wakeup.ts'

test('persists ChatLuna A2A job bindings', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-a2a-jobs-'))
    const file = path.join(directory, 'a2a-tasks.json')
    try {
        const first = new A2ADelegationStore(file, 8)
        await first.init()
        await first.save(delegationTask())
        await first.flush()

        const restored = new A2ADelegationStore(file, 8)
        await restored.init()
        const task = await restored.get('job-1')
        assert.equal(task?.parentConversationId, 'conversation-1')
        assert.equal(task?.contextId, 'context-1')
        assert.equal(task?.state, 'completed')
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('wakes the original ChatLuna conversation with an A2A result', async () => {
    let invocation: any
    const task = delegationTask()
    task.output = 'Finished <safely>'
    await notifyChatLunaA2ADelegation(
        {
            async invoke(input) {
                invocation = input
                return { ok: true, requestId: 'request-1' }
            }
        },
        task
    )
    assert.deepEqual(invocation.conversation, {
        type: 'existing',
        id: 'conversation-1'
    })
    assert.equal(invocation.delivery, 'channel')
    assert.equal(invocation.source.kind, 'agent-nexus-a2a')
    assert.match(String(invocation.message), /Finished &lt;safely&gt;/)
    assert.match(String(invocation.message), /nexus_a2a_delegate/)
})

test('runs A2A in background, wakes ChatLuna, and reuses bound context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-a2a-runtime-'))
    const file = path.join(directory, 'a2a-tasks.json')
    const sent: any[] = []
    const notified: A2ADelegationTask[] = []
    let sendCount = 0
    let finishNotification!: () => void
    const notification = new Promise<void>((resolve) => {
        finishNotification = resolve
    })
    const backend: A2ADelegationBackend = {
        listRemotes: () => [
            {
                id: 'remote-1',
                name: 'hermes',
                baseUrl: 'https://agent.example/a2a',
                enabled: true,
                state: 'ready'
            }
        ],
        resolveRemoteId: () => 'remote-1',
        async send(_remoteId, input) {
            sent.push(structuredClone(input))
            sendCount += 1
            if (sendCount === 1) {
                return taskView(
                    'TASK_STATE_WORKING',
                    'remote-task-1',
                    'context-1'
                )
            }
            if (sendCount === 2) {
                return taskView(
                    'TASK_STATE_INPUT_REQUIRED',
                    'remote-task-2',
                    'context-1',
                    'Which repository?'
                )
            }
            return taskView(
                'TASK_STATE_COMPLETED',
                'remote-task-2',
                'context-1',
                'Finished repository review.'
            )
        },
        async get() {
            return taskView(
                'TASK_STATE_COMPLETED',
                'remote-task-1',
                'context-1',
                'Background research complete.'
            )
        },
        async cancel() {
            return taskView(
                'TASK_STATE_CANCELED',
                'remote-task-1',
                'context-1'
            )
        },
        async notify(task) {
            notified.push(structuredClone(task))
            finishNotification()
        }
    }
    const manager = new A2ADelegationManager(
        new A2ADelegationStore(file, 8),
        backend,
        { pollIntervalMs: 1 }
    )
    try {
        await manager.start()
        const started = await manager.handle(
            { action: 'run', prompt: 'Research the repository' },
            delegationContext()
        )
        assert.match(started, /running \(background\)/)
        await Promise.race([
            notification,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('notification timeout')), 1000)
            )
        ])
        assert.equal(notified[0]?.state, 'completed')
        assert.equal(notified[0]?.output, 'Background research complete.')

        const waiting = await manager.handle(
            { action: 'run', prompt: 'Inspect another part' },
            delegationContext()
        )
        assert.match(waiting, /waiting_input/)
        assert.equal(sent[1].taskId, undefined)
        assert.equal(sent[1].contextId, 'context-1')

        const completed = await manager.handle(
            { action: 'run', prompt: 'Use repository AgentNexus' },
            delegationContext()
        )
        assert.match(completed, /Finished repository review/)
        assert.equal(sent[2].taskId, 'remote-task-2')
        assert.equal(sent[2].contextId, 'context-1')
    } finally {
        await manager.stop()
        await rm(directory, { recursive: true, force: true })
    }
})

test('restores bridge A2A tasks and marks interrupted work resumable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-a2a-store-'))
    const file = path.join(directory, 'tasks.json')
    const context = {
        tenant: '',
        user: { isAuthenticated: true, userName: 'client-1' }
    } as any
    try {
        const first = new BoundedTaskStore(8, file)
        await first.init()
        await first.save(
            Task.fromJSON({
                id: 'task-running',
                contextId: 'context-1',
                status: {
                    state: 'TASK_STATE_WORKING',
                    timestamp: new Date().toISOString()
                },
                artifacts: [],
                history: []
            }),
            context
        )
        await first.flush()

        const restored = new BoundedTaskStore(8, file)
        await restored.init()
        const task = await restored.load('task-running', context)
        assert.equal(task?.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
        assert.match(
            String((task?.status?.message as any)?.parts?.[0]?.content?.value || ''),
            /restarted/i
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

function delegationContext(): A2ADelegationContext {
    return {
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        routing: {
            platform: 'test',
            selfId: 'bot-1',
            userId: 'user-1',
            channelId: 'channel-1',
            isDirect: false
        }
    }
}

function delegationTask(): A2ADelegationTask {
    const now = Date.now()
    return {
        schemaVersion: 1,
        id: 'job-1',
        remoteId: 'remote-1',
        remoteName: 'hermes',
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        routing: delegationContext().routing,
        state: 'completed',
        background: true,
        prompt: 'test',
        a2aTaskId: 'remote-task-1',
        contextId: 'context-1',
        artifacts: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: now,
        expiresAt: now + 60_000
    }
}

function taskView(
    state: string,
    taskId: string,
    contextId: string,
    text?: string
) {
    return {
        remoteId: 'remote-1',
        taskId,
        contextId,
        state,
        text,
        artifacts: []
    }
}
