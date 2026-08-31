import assert from 'node:assert/strict'
import test from 'node:test'
import {
    formatDelegationWakeup,
    notifyChatLunaDelegation,
    type DelegationJob
} from '../src/delegation/index.ts'
import {
    delegationArtifactElements,
    sendDelegationArtifacts
} from '../src/delegation/media.ts'

test('invokes a terminal wakeup instead of using the lossy plugin queue', async () => {
    let invoked = false
    let queued = false
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
                    queued = true
                    return true
                }
            },
            async invoke() {
                invoked = true
                return { ok: true }
            }
        } as any,
        job
    )

    assert.equal(invoked, true)
    assert.equal(queued, false)
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

test('invokes ChatLuna even when a plugin turn is active', async () => {
    let invocation: any
    const job = wakeupJob()

    await notifyChatLunaDelegation(
        {
            conversation: {
                async getConversation() {
                    return { chatMode: 'plugin' }
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

test('keeps artifact URLs out of the model wakeup text', () => {
    const job = wakeupJob()
    job.artifacts = [
        {
            artifactId: 'pptx-1',
            filename: '上海堡垒.pptx',
            mediaType:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'http://10.1.2.30:5140/temp/result.pptx'
        }
    ]
    const message = formatDelegationWakeup(job)
    assert.match(message, /上海堡垒\.pptx/)
    assert.doesNotMatch(message, /10\.1\.2\.30:5140/)
})

test('does not expose artifact URLs as structured model input', async () => {
    const job = wakeupJob()
    job.artifacts = [
        {
            artifactId: 'pptx-1',
            filename: '王俊凯生平介绍.pptx',
            mediaType:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'file:///C:/agent-skills/ppt-master/王俊凯生平介绍.pptx'
        }
    ]
    let message: unknown

    await notifyChatLunaDelegation(
        {
            async invoke(input) {
                message = input.message
                return { ok: true }
            }
        },
        job
    )

    assert.equal(typeof message, 'string')
    assert.match(String(message), /王俊凯生平介绍\.pptx/)
    assert.match(String(message), /native attachments/)
    assert.match(String(message), /do not start another remote task/)
    assert.doesNotMatch(String(message), /file:\/\/\/C:/)
    assert.doesNotMatch(JSON.stringify(message), /file_url/)
})

test('sends artifacts as native Koishi resource elements', async () => {
    const artifacts = [
        {
            artifactId: 'image-1',
            filename: 'preview.png',
            mediaType: 'image/png',
            url: 'https://files/preview.png'
        },
        {
            artifactId: 'audio-1',
            filename: 'notice.mp3',
            mediaType: 'audio/mpeg',
            url: 'https://files/notice.mp3'
        },
        {
            artifactId: 'file-1',
            filename: 'report.pptx',
            mediaType:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files/report.pptx'
        }
    ]
    const elements = delegationArtifactElements(artifacts)
    assert.deepEqual(elements.map((element) => element.type), [
        'img',
        'audio',
        'file'
    ])
    assert.equal(elements[2].attrs.filename, 'report.pptx')

    let sent: { channelId: string; content: any } | undefined
    await sendDelegationArtifacts(
        {
            'onebot:bot-1': {
                async createDirectChannel() {
                    return { id: 'direct-channel-1' }
                },
                async sendMessage(channelId, content) {
                    sent = { channelId, content }
                }
            }
        },
        {
            platform: 'onebot',
            selfId: 'bot-1',
            userId: 'user-1',
            isDirect: true
        },
        artifacts
    )
    assert.equal(sent?.channelId, 'direct-channel-1')
    assert.deepEqual(sent?.content.map((element: any) => element.type), [
        'img',
        'audio',
        'file'
    ])
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
