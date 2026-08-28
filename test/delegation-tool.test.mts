import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildDelegationToolNames,
    delegationToolNameForJob,
    type DelegationJob
} from '../src/delegation/index.ts'
import {
    NexusAgentDelegateTool,
    registerAgentDelegationTools
} from '../src/tools/delegate.ts'
import {
    NEXUS_FILE_PUBLISH_TOOL,
    NexusFilePublishTool,
    registerGatewayFilePublishTool
} from '../src/tools/publish.ts'
import {
    createNexusArtifactElement,
    isNexusArtifactElement
} from '../src/utils/artifact-element.ts'
import { AgentNexusService } from '../src/service.ts'

test('builds stable, Agent-facing delegation tool names', () => {
    const names = buildDelegationToolNames([
        { id: 'hermes-route', name: 'Hermes News' },
        { id: 'opencode-route', name: 'Development OpenCode', agentId: 'opencode' },
        { id: 'pi-route', name: 'Pi', agentId: 'pi' },
        { id: 'second-opencode', name: 'Other OpenCode', agentId: 'opencode' },
        { id: 'unicode-route', name: '中文 Agent' }
    ])

    assert.equal(names.get('hermes-route'), 'nexus_hermes')
    assert.equal(names.get('opencode-route'), 'nexus_opencode')
    assert.equal(names.get('pi-route'), 'nexus_pi')
    assert.equal(names.get('second-opencode'), 'nexus_opencode_2')
    assert.equal(names.get('unicode-route'), 'nexus_agent')
})

test('persists the exact Agent tool name with a delegation job', () => {
    const job = {
        toolName: 'nexus_opencode_2',
        agentId: 'route-2',
        agentName: 'Other OpenCode',
        providerAgentId: 'opencode'
    } as Pick<DelegationJob, 'toolName' | 'agentId' | 'agentName' | 'providerAgentId'>
    assert.equal(delegationToolNameForJob(job), 'nexus_opencode_2')
})

test('an Agent-specific tool fixes routing and hides the remote field', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown, context: unknown, signal: unknown) {
            invocation = { input, context, signal }
            return 'delegated'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    assert.equal((tool.schema as any).shape.remote, undefined)
    const result = await tool._call(
        { action: 'run', prompt: 'clone the project' },
        undefined,
        {
            configurable: {
                conversationId: 'conversation-1',
                userId: 'user-1',
                session: { platform: 'test', selfId: 'bot', userId: 'user-1' }
            },
            signal: new AbortController().signal
        }
    )

    assert.equal(result, 'delegated')
    assert.deepEqual(invocation.input, {
        action: 'run',
        prompt: 'clone the project',
        remote: 'hermes-route'
    })
    assert.equal((invocation.context as any).parentConversationId, 'conversation-1')
})

test('an Agent-specific tool works without conversation context', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown, context: unknown) {
            invocation = { input, context }
            return 'delegated without context'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    const result = await tool._call({ action: 'run', prompt: '原样发送' })
    assert.equal(result, 'delegated without context')
    assert.equal(invocation.context, undefined)
    assert.deepEqual(invocation.input, {
        action: 'run',
        prompt: '原样发送',
        remote: 'hermes-route'
    })
})

test('forwards current Koishi message attachments only for task turns', async () => {
    let invocation: any
    const nexus = {
        async collectInputAttachments(parentConfig: any) {
            assert.equal(parentConfig.configurable.session.elements[0].type, 'img')
            return [{
                name: '需求.png',
                mediaType: 'image/png',
                bytes: new Uint8Array([1, 2, 3])
            }]
        },
        async handleDelegate(input: unknown) {
            invocation = input
            return 'delegated'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    await tool._call(
        { action: 'run', prompt: '分析这张图片' },
        undefined,
        { configurable: { session: { elements: [{ type: 'img' }] } } }
    )
    assert.equal(invocation.attachments[0].name, '需求.png')
    assert.deepEqual([...invocation.attachments[0].bytes], [1, 2, 3])

    invocation = undefined
    await tool._call(
        { action: 'status', id: 'job-1' },
        undefined,
        { configurable: { session: { elements: [{ type: 'img' }] } } }
    )
    assert.equal(invocation.attachments, undefined)
})

test('reads ChatLuna Agent context from the nested configurable field', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown, context: unknown) {
            invocation = { input, context }
            return 'delegated'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    await tool._call(
        { action: 'run', prompt: '后台处理', background: true },
        undefined,
        {
            configurable: {
                agentContext: {
                    conversationId: 'agent-conversation',
                    userId: 'agent-user'
                },
                session: { platform: 'test', selfId: 'bot' }
            }
        }
    )
    assert.equal(
        invocation.context.parentConversationId,
        'agent-conversation'
    )
    assert.equal(invocation.context.routing.userId, 'agent-user')
})

test('registers one tool per enabled Agent and disposes stale tools on sync', () => {
    const agents = [
        {
            id: 'hermes-route',
            name: 'Hermes News',
            provider: 'gateway',
            remoteId: 'primary-gateway',
            remoteName: 'Nexus Gateway',
            agentId: 'hermes',
            protocol: 'acp',
            enabled: true,
            state: 'ready',
            skills: []
        },
        {
            id: 'opencode-route',
            name: 'OpenCode Dev',
            provider: 'gateway',
            remoteId: 'primary-gateway',
            remoteName: 'Nexus Gateway',
            agentId: 'opencode',
            workspace: '/workspace',
            enabled: true,
            state: 'ready',
            skills: []
        },
        {
            id: 'disabled-route',
            name: 'Pi',
            provider: 'gateway',
            remoteId: 'primary-gateway',
            remoteName: 'Nexus Gateway',
            agentId: 'pi',
            workspace: '/workspace',
            enabled: false,
            state: 'error',
            skills: []
        }
    ] as any[]
    const registered = new Map<string, any>()
    const platform = {
        registerTool(name: string, spec: any) {
            registered.set(name, spec)
            return () => registered.delete(name)
        },
        unregisterTool(name: string) {
            registered.delete(name)
        }
    }
    const disposers = registerAgentDelegationTools(
        platform,
        {} as any,
        agents as any
    )
    assert.deepEqual([...registered.keys()], ['nexus_hermes', 'nexus_opencode'])
    assert.doesNotMatch(registered.get('nexus_hermes').description, /A2A|ACP/)
    assert.equal(registered.has('nexus_a2a_delegate'), false)

    agents.splice(0, agents.length, agents[2])
    for (const dispose of disposers) dispose()
    assert.deepEqual([...registered.keys()], [])
})

test('file publish tool forwards exact paths and current conversation context', async () => {
    let invocation: any
    const sent: any[] = []
    const nexus = {
        async publishDelegationFiles(input: unknown, context: unknown) {
            invocation = { input, context }
            return [{
                id: 'file-1',
                name: 'result.zip',
                url: 'http://gateway.local/v1/artifacts/token/result.zip',
                size: 128,
                mediaType: 'application/zip',
                sha256: 'abc',
                expiresAt: Date.now() + 60_000
            }]
        }
    }
    const tool = new NexusFilePublishTool(nexus as any)
    const result = await tool._call(
        { id: 'job-1', paths: ['D:\\workspace\\result.zip'] },
        undefined,
        {
            configurable: {
                conversationId: 'conversation-1',
                userId: 'user-1',
                session: {
                    platform: 'test',
                    selfId: 'bot',
                    userId: 'user-1',
                    send(content: unknown) {
                        sent.push(content)
                        return Promise.resolve([])
                    }
                }
            }
        }
    )
    assert.match(result, /文件已发布/)
    assert.doesNotMatch(result, /http:\/\/gateway\.local/)
    assert.equal(sent[0].type, 'file')
    assert.equal(sent[0].attrs.src, 'http://gateway.local/v1/artifacts/token/result.zip')
    assert.equal(sent[0].attrs.filename, 'result.zip')
    assert.deepEqual(invocation.input, {
        id: 'job-1',
        paths: ['D:\\workspace\\result.zip']
    })
    assert.equal(invocation.context.parentConversationId, 'conversation-1')

    const registered = new Map<string, any>()
    const dispose = registerGatewayFilePublishTool(
        {
            registerTool(name: string, spec: any) {
                registered.set(name, spec)
                return () => registered.delete(name)
            }
        },
        nexus as any
    )
    assert.deepEqual([...registered.keys()], [NEXUS_FILE_PUBLISH_TOOL])
    assert.match(registered.get(NEXUS_FILE_PUBLISH_TOOL).description, /Base64/)
    dispose?.()
    assert.equal(registered.size, 0)
})

test('builds native Koishi elements for artifact media types and buffers', () => {
    const audio = createNexusArtifactElement({
        bytes: Buffer.from([1, 2, 3]),
        filename: 'voice.wav',
        mediaType: 'audio/wav'
    })
    assert.equal(audio.type, 'audio')
    assert.equal(audio.attrs.src, 'data:audio/wav;base64,AQID')
    assert.equal(audio.attrs.filename, 'voice.wav')
    assert.equal(isNexusArtifactElement(audio), true)

    const view = new Uint8Array([9, 1, 2, 3, 8]).subarray(1, 4)
    const viewAudio = createNexusArtifactElement({
        bytes: view,
        filename: 'view.wav',
        mediaType: 'audio/wav'
    })
    assert.equal(viewAudio.attrs.src, 'data:audio/wav;base64,AQID')

    const video = createNexusArtifactElement({
        url: 'https://gateway.example/video.mp4',
        filename: 'video.mp4',
        mediaType: 'video/mp4'
    })
    assert.equal(video.type, 'video')
    assert.equal(video.attrs.src, 'https://gateway.example/video.mp4')
    assert.equal(video.attrs.filename, 'video.mp4')
    assert.equal(isNexusArtifactElement(video), true)

    const file = createNexusArtifactElement({
        url: 'https://gateway.example/report.zip',
        filename: 'report.zip',
        mediaType: 'application/zip'
    })
    assert.equal(file.type, 'file')
    assert.equal(file.attrs.src, 'https://gateway.example/report.zip')
    assert.equal(file.attrs.filename, 'report.zip')
    assert.equal(file.attrs.mime, 'application/zip')
    assert.equal(isNexusArtifactElement(file), true)
})

test('file publish sends audio and video as native Koishi media elements', async () => {
    const sent: any[] = []
    const nexus = {
        async publishDelegationFiles() {
            return [
                {
                    id: 'audio-1',
                    name: 'song.mp3',
                    url: 'https://gateway.example/song.mp3',
                    size: 3,
                    mediaType: 'audio/mpeg',
                    sha256: 'audio',
                    expiresAt: Date.now() + 60_000
                },
                {
                    id: 'video-1',
                    name: 'clip.mp4',
                    url: 'https://gateway.example/clip.mp4',
                    size: 3,
                    mediaType: 'video/mp4',
                    sha256: 'video',
                    expiresAt: Date.now() + 60_000
                }
            ]
        }
    }
    const tool = new NexusFilePublishTool(nexus as any)
    await tool._call(
        { paths: ['song.mp3', 'clip.mp4'] },
        undefined,
        {
            configurable: {
                session: {
                    send(content: unknown) {
                        sent.push(content)
                        return Promise.resolve([])
                    }
                }
            }
        }
    )
    assert.deepEqual(
        sent.map((element) => [element.type, element.attrs.src]),
        [
            ['audio', 'https://gateway.example/song.mp3'],
            ['video', 'https://gateway.example/clip.mp4']
        ]
    )
})

test('does not re-read echoed artifacts as user attachments', async () => {
    const service = Object.create(AgentNexusService.prototype) as any
    service.ctx = { logger: { debug() {} } }
    const echoedArtifact = createNexusArtifactElement({
        url: 'https://gateway.example/song.mp3',
        filename: 'song.mp3',
        mediaType: 'audio/mpeg'
    })

    const attachments = await service.collectInputAttachments({
        configurable: {
            session: {
                elements: [
                    echoedArtifact,
                    { type: 'audio', attrs: { src: 'marshmello_alone.mp3' } }
                ]
            }
        }
    })
    assert.deepEqual(attachments, [])
})

test('pending continuation failure does not swallow the current Koishi message', async () => {
    const service = Object.create(AgentNexusService.prototype) as any
    let middleware: any
    let nextCalls = 0
    const sent: string[] = []
    service.ctx = {
        logger: { warn() {} },
        middleware(handler: any) {
            middleware = handler
            return () => undefined
        }
    }
    service.pluginConfig = { autoResumePending: true }
    service.running = true
    service.resumePendingMessage = async () => {
        throw new Error('Nexus Gateway request failed (404): Agent Nexus session not found')
    }

    service.installPendingMessageMiddleware()
    const result = await middleware(
        {
            userId: 'user',
            selfId: 'bot',
            send(content: string) {
                sent.push(content)
                return Promise.resolve([])
            }
        },
        async () => {
            nextCalls += 1
            return 'next-result'
        }
    )

    assert.equal(result, 'next-result')
    assert.equal(nextCalls, 1)
    assert.deepEqual(sent, [
        '继续 Agent 任务失败：Nexus Gateway request failed (404): Agent Nexus session not found'
    ])
})
