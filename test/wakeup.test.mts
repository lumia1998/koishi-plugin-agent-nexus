import { HumanMessage } from '@langchain/core/messages'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    notifyChatLunaDelegation,
    type DelegationJob
} from '../src/delegation/index.ts'

test('queues a wakeup while a plugin conversation is in flight', async () => {
    let invoked = false
    let queued: unknown[] | undefined
    const job = wakeupJob()

    await notifyChatLunaDelegation(
        {
            conversation: {
                async getConversation() {
                    return { chatMode: 'plugin' }
                }
            },
            conversationRuntime: {
                async appendPendingMessage(...args) {
                    queued = args
                    return true
                }
            },
            async invoke() {
                invoked = true
                return { ok: true }
            }
        },
        job
    )

    assert.equal(invoked, false)
    assert.equal(queued?.[0], job.parentConversationId)
    assert.ok(queued?.[1] instanceof HumanMessage)
    assert.equal(queued?.[2], 'plugin')
    assert.match(String((queued?.[1] as HumanMessage).content), /Automatic notice/)
})

test('calls the ChatLuna conversation service with its receiver intact', async () => {
    let invoked = false
    const conversation = {
        expected: 'conversation-1',
        async getConversation(id: string) {
            assert.equal(this, conversation)
            assert.equal(id, this.expected)
            return { chatMode: 'chat' }
        }
    }

    await notifyChatLunaDelegation(
        {
            conversation,
            async invoke() {
                invoked = true
                return { ok: true }
            }
        },
        wakeupJob()
    )

    assert.equal(invoked, true)
})

test('invokes ChatLuna when no plugin turn is active', async () => {
    let invocation: any
    const job = wakeupJob()

    await notifyChatLunaDelegation(
        {
            conversation: {
                async getConversation() {
                    return { chatMode: 'plugin' }
                }
            },
            conversationRuntime: {
                async appendPendingMessage() {
                    return false
                }
            },
            async invoke(input) {
                invocation = input
                return { ok: true }
            }
        },
        job
    )

    assert.equal(invocation.delivery, 'channel')
    assert.deepEqual(invocation.conversation, {
        type: 'existing',
        id: job.parentConversationId
    })
    assert.equal(invocation.routing.channelId, 'channel-1')
})

test('skips delivery when the original conversation no longer exists', async () => {
    let invoked = false

    await notifyChatLunaDelegation(
        {
            conversation: {
                async getConversation() {
                    return undefined
                }
            },
            async invoke() {
                invoked = true
                return { ok: true }
            }
        },
        wakeupJob()
    )

    assert.equal(invoked, false)
})

function wakeupJob(): DelegationJob {
    const now = Date.now()
    return {
        schemaVersion: 2,
        id: 'job-1',
        provider: 'gateway',
        agentId: 'hermes',
        agentName: 'Hermes',
        remoteId: 'gateway',
        remoteName: 'Gateway',
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        routing: {
            platform: 'onebot',
            selfId: 'bot-1',
            userId: 'user-1',
            channelId: 'channel-1',
            isDirect: false
        },
        state: 'completed',
        background: true,
        prompt: 'task',
        providerState: {},
        artifacts: [],
        activeRunId: 'run-1',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: now,
        expiresAt: now + 60_000
    }
}
