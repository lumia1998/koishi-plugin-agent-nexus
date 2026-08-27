import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
    NexusGatewayClient,
    SESSION_START_TIMEOUT_MS
} from '../src/gateway/client.ts'
import { NexusGatewayProvider } from '../src/providers/gateway.ts'
import { PRIMARY_GATEWAY_ID } from '../src/types.ts'
import type { DelegationJob } from '../src/delegation/index.ts'

test('allows Gateway session startup to take up to 180 seconds', () => {
    assert.equal(SESSION_START_TIMEOUT_MS, 180_000)
})

test('authenticates inventory and the complete session lifecycle', async () => {
    const requests: Array<{ method: string; path: string; auth?: string; body: string }> = []
    const server = http.createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        requests.push({
            method: request.method || 'GET',
            path: request.url || '',
            auth: request.headers.authorization,
            body
        })
        response.setHeader('Content-Type', 'application/json')
        if (request.url === '/v1/agents') {
            response.end(
                JSON.stringify({
                    agents: [
                        {
                            id: 'hermes',
                            name: 'Hermes',
                            protocol: 'acp',
                            driver: 'hermes',
                            ready: true
                        }
                    ]
                })
            )
        } else if (request.url === '/v1/sessions') {
            response.end(JSON.stringify(session('created')))
        } else if (request.url === '/v1/sessions/session-1/message') {
            response.end(JSON.stringify(session('running')))
        } else if (request.url === '/v1/sessions/session-1/cancel') {
            response.end(JSON.stringify(session('canceled')))
        } else if (request.url === '/v1/sessions/session-1') {
            response.end(JSON.stringify(session('completed')))
        } else {
            response.statusCode = 404
            response.end(JSON.stringify({ error: 'missing' }))
        }
    })
    await listen(server)
    const remote = gatewayRemote(server)
    const client = new NexusGatewayClient()
    try {
        const agents = await client.listAgents(remote)
        assert.deepEqual(
            agents.agents.map((agent) => [agent.id, agent.protocol, agent.driver]),
            [['hermes', 'acp', 'hermes']]
        )
        const created = await client.createSession(remote, {
            agentId: 'hermes',
            workspace: '/workspace'
        })
        assert.equal((await client.sendMessage(remote, created.id, 'work')).state, 'running')
        assert.equal((await client.getSession(remote, created.id)).state, 'completed')
        assert.equal((await client.cancelSession(remote, created.id)).state, 'canceled')
        assert.ok(requests.every((request) => request.auth === 'Bearer TOKEN'))
        assert.deepEqual(JSON.parse(requests[1].body), {
            agentId: 'hermes',
            workspace: '/workspace'
        })
        assert.deepEqual(JSON.parse(requests[2].body), { message: 'work' })
    } finally {
        await close(server)
    }
})

test('uploads current-message attachments as bounded binary Session input', async () => {
    let uploaded: { contentType: string; fileName: string; body: Buffer } | undefined
    const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        if (request.url === '/v1/sessions/session-1/attachments') {
            uploaded = {
                contentType: String(request.headers['content-type'] || ''),
                fileName: String(request.headers['x-nexus-file-name'] || ''),
                body: Buffer.concat(chunks)
            }
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({
                id: 'attachment-1',
                name: '需求说明.txt',
                mediaType: 'text/plain',
                size: chunks.reduce((total, chunk) => total + chunk.length, 0)
            }))
            return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'missing' }))
    })
    await listen(server)
    const client = new NexusGatewayClient()
    try {
        const result = await client.uploadAttachment(
            gatewayRemote(server),
            'session-1',
            {
                name: '需求说明.txt',
                mediaType: 'text/plain',
                bytes: new Uint8Array([0, 255, 1, 2])
            }
        )
        assert.equal(result.id, 'attachment-1')
        assert.equal(uploaded?.contentType, 'text/plain')
        assert.equal(uploaded?.fileName, encodeURIComponent('需求说明.txt'))
        assert.deepEqual(uploaded?.body, Buffer.from([0, 255, 1, 2]))
    } finally {
        await close(server)
    }
})

test('parses replayable SSE events including artifacts', async () => {
    let requestUrl = ''
    let lastEventId = ''
    const server = http.createServer((request, response) => {
        requestUrl = request.url || ''
        lastEventId = String(request.headers['last-event-id'] || '')
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(
            'id: 11\r\ndata: {"id":"11","sessionId":"session-1","type":"artifact","timestamp":1,"data":{"name":"result.png"}}\r\n\r\n'
        )
        response.end(
            'id: 12\ndata: {"id":"12","sessionId":"session-1","type":"completed","timestamp":2}\n\n'
        )
    })
    await listen(server)
    const client = new NexusGatewayClient()
    try {
        const events = []
        for await (const event of client.events(
            gatewayRemote(server),
            'session-1',
            '10'
        )) {
            events.push(event)
        }
        assert.equal(requestUrl, '/v1/sessions/session-1/events?after=10')
        assert.equal(lastEventId, '10')
        assert.deepEqual(events.map((event) => event.type), ['artifact', 'completed'])
    } finally {
        await close(server)
    }
})

test('publishes ACP and A2A inventory as tools and applies per-Agent overrides', async () => {
    const config = {
        delegation: {
            agents: [
                {
                    agentId: 'hermes',
                    name: 'Hermes 中文助手',
                    enabled: true,
                    workspace: '/custom'
                },
                {
                    agentId: 'disabled',
                    name: '停用项',
                    enabled: false
                }
            ]
        }
    }
    const remote = fixedRemote()
    const client = {
        async listAgents() {
            return {
                agents: [
                    {
                        id: 'hermes',
                        name: 'Hermes',
                        protocol: 'acp',
                        driver: 'hermes',
                        ready: true,
                        enabled: true,
                        workspace: '/default',
                        responseMs: 18
                    },
                    {
                        id: 'research',
                        name: 'Research A2A',
                        protocol: 'a2a',
                        ready: true,
                        enabled: true
                    }
                ]
            }
        }
    } as any
    const provider = new NexusGatewayProvider({
        getConfig: () => config,
        remote,
        client
    })

    await provider.discoverRemote()
    const agents = provider.listAgents()
    assert.deepEqual(agents.map((agent) => agent.id), [
        'disabled',
        'hermes',
        'research'
    ])
    assert.equal(agents.find((agent) => agent.id === 'hermes')?.name, 'Hermes 中文助手')
    assert.equal(agents.find((agent) => agent.id === 'hermes')?.workspace, '/custom')
    assert.equal(agents.find((agent) => agent.id === 'hermes')?.protocol, 'acp')
    assert.equal(agents.find((agent) => agent.id === 'research')?.protocol, 'a2a')
    assert.equal(agents.find((agent) => agent.id === 'disabled')?.enabled, false)
})

test('maps protocol session ids, permission input, and binary artifacts', async () => {
    let uploaded: any
    let sentAttachmentIds: string[] | undefined
    const config = {
        delegation: {
            agents: [
                {
                    agentId: 'hermes',
                    name: 'Hermes',
                    enabled: true,
                    workspace: '/repos/project'
                }
            ]
        }
    }
    const client = {
        async createSession() {
            return session('created')
        },
        async uploadAttachment(_remote: unknown, _sessionId: string, input: unknown) {
            uploaded = input
            return { id: 'attachment-1', name: '需求.png', mediaType: 'image/png', size: 3 }
        },
        async sendMessage(_remote: unknown, _sessionId: string, _prompt: string, attachmentIds?: string[]) {
            sentAttachmentIds = attachmentIds
            return {
                ...session('permission_required'),
                output: '准备修改。',
                artifacts: [
                    {
                        id: 'image-1',
                        filename: 'result.png',
                        mediaType: 'image/png',
                        bytesBase64: 'aGVsbG8='
                    }
                ],
                pendingRequest: {
                    id: 'permission-1',
                    kind: 'permission',
                    prompt: '允许修改 package.json 吗？',
                    options: [{ id: 'allow', name: '允许一次' }]
                }
            }
        }
    } as any
    const provider = new NexusGatewayProvider({
        getConfig: () => config,
        remote: fixedRemote(),
        client
    })
    const result = await provider.run(provider.listAgents()[0], delegationJob(), {
        prompt: '修改项目',
        background: true,
        newTask: false,
        sameTask: false,
        attachments: [{
            name: '需求.png',
            mediaType: 'image/png',
            bytes: new Uint8Array([1, 2, 3])
        }]
    })
    assert.equal(result.state, 'permission_required')
    assert.match(result.text || '', /允许一次/)
    assert.equal(result.providerState.protocol, 'acp')
    assert.equal(result.providerState.protocolSessionId, 'acp-1')
    assert.equal(result.providerState.acpSessionId, 'acp-1')
    assert.equal(result.artifacts[0].bytesBase64, 'aGVsbG8=')
    assert.equal(uploaded.name, '需求.png')
    assert.deepEqual([...uploaded.bytes], [1, 2, 3])
    assert.deepEqual(sentAttachmentIds, ['attachment-1'])
})

test('keeps the previous inventory after a transient discovery failure', async () => {
    let fail = false
    const client = {
        async listAgents() {
            if (fail) throw new Error('temporary network failure')
            return {
                agents: [
                    {
                        id: 'hermes',
                        name: 'Hermes',
                        protocol: 'acp',
                        ready: true,
                        enabled: true
                    }
                ]
            }
        }
    } as any
    const provider = new NexusGatewayProvider({
        getConfig: () => ({ delegation: { agents: [] } }),
        remote: fixedRemote(),
        client
    })
    await provider.discoverRemote()
    fail = true
    const status = await provider.discoverRemote()
    assert.equal(status.state, 'error')
    assert.equal(status.agents.length, 1)
    assert.match(status.error || '', /temporary network failure/)
})

function fixedRemote() {
    return {
        id: PRIMARY_GATEWAY_ID,
        name: 'Nexus Gateway',
        baseUrl: 'http://127.0.0.1:8787',
        authToken: 'TOKEN',
        enabled: true
    }
}

function gatewayRemote(server: http.Server) {
    return {
        ...fixedRemote(),
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
}

function session(state: string) {
    return {
        id: 'session-1',
        protocol: 'acp',
        protocolSessionId: 'acp-1',
        acpSessionId: 'acp-1',
        agentId: 'hermes',
        workspace: '/workspace',
        state,
        artifacts: [],
        createdAt: 1,
        updatedAt: 1
    }
}

function delegationJob(): DelegationJob {
    return {
        schemaVersion: 2,
        id: 'job-1',
        provider: 'gateway',
        agentId: 'hermes',
        agentName: 'Hermes',
        remoteId: PRIMARY_GATEWAY_ID,
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
        state: 'running',
        background: true,
        prompt: 'work',
        providerState: {},
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
        startedAt: 1,
        expiresAt: Date.now() + 60_000
    }
}

function listen(server: http.Server) {
    return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function close(server: http.Server) {
    return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    )
}
