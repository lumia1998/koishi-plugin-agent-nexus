import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { NexusGatewayClient } from '../src/gateway/client.ts'
import { NexusGatewayProvider } from '../src/providers/gateway.ts'
import type { DelegationJob } from '../src/delegation/index.ts'

test('gateway client authenticates, discovers agents, and sends session messages', async () => {
    const requests: Array<{ path: string; auth?: string; body: string }> = []
    const server = http.createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        requests.push({
            path: request.url || '',
            auth: request.headers.authorization,
            body
        })
        response.setHeader('Content-Type', 'application/json')
        if (request.url === '/v1/agents') {
            response.end(JSON.stringify({
                agents: [{ id: 'opencode', name: 'OpenCode', protocol: 'acp', ready: true }]
            }))
        } else if (request.url === '/v1/sessions') {
            response.end(JSON.stringify(session('created')))
        } else if (request.url === '/v1/sessions/session-1/message') {
            response.end(JSON.stringify(session('running')))
        } else {
            response.statusCode = 404
            response.end(JSON.stringify({ error: 'missing' }))
        }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const remote = {
        id: 'gateway-1',
        name: 'gateway',
        baseUrl: `http://127.0.0.1:${port}`,
        authToken: 'TOKEN',
        enabled: true
    }
    const client = new NexusGatewayClient()
    try {
        const agents = await client.listAgents(remote)
        assert.equal(agents.agents[0].id, 'opencode')
        const created = await client.createSession(remote, {
            agentId: 'opencode',
            workspace: '/workspace'
        })
        const running = await client.sendMessage(remote, created.id, 'Do the work')
        assert.equal(running.state, 'running')
        assert.ok(requests.every((request) => request.auth === 'Bearer TOKEN'))
        assert.deepEqual(JSON.parse(requests[1].body), {
            agentId: 'opencode',
            workspace: '/workspace'
        })
        assert.deepEqual(JSON.parse(requests[2].body), { message: 'Do the work' })
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

test('gateway SSE supports replay cursors and parses streamed events', async () => {
    let requestUrl = ''
    let lastEventId = ''
    const server = http.createServer((request, response) => {
        requestUrl = request.url || ''
        lastEventId = String(request.headers['last-event-id'] || '')
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(
            'id: 11\r\nevent: assistant_chunk\r\ndata: {"id":"11","sessionId":"session-1","type":"assistant_chunk","timestamp":1,"data":{"text":"hello"}}\r\n\r\n'
        )
        response.end(
            'id: 12\nevent: completed\ndata: {"id":"12","sessionId":"session-1","type":"completed","timestamp":2}\n\n'
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const client = new NexusGatewayClient()
    try {
        const events = []
        for await (const event of client.events(
            {
                id: 'gateway-1',
                name: 'gateway',
                baseUrl: `http://127.0.0.1:${port}`,
                authToken: 'TOKEN',
                enabled: true
            },
            'session-1',
            '10'
        )) {
            events.push(event)
        }
        assert.equal(requestUrl, '/v1/sessions/session-1/events?after=10')
        assert.equal(lastEventId, '10')
        assert.deepEqual(events.map((event) => event.id), ['11', '12'])
        assert.deepEqual(events.map((event) => event.type), [
            'assistant_chunk',
            'completed'
        ])
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

test('gateway provider exposes permission requests and keeps ACP route metadata', async () => {
    const config = {
        gateway: {
            remotes: [
                {
                    id: 'gateway-1',
                    name: 'dev-server',
                    baseUrl: 'http://127.0.0.1:8787',
                    enabled: true
                }
            ]
        },
        delegation: {
            agents: [
                {
                    id: 'logical-opencode',
                    name: 'OpenCode',
                    enabled: true,
                    provider: 'gateway',
                    remoteId: 'gateway-1',
                    agentId: 'opencode',
                    workspace: '/repos/project'
                }
            ]
        }
    } as any
    const client = {
        async createSession() {
            return gatewaySession('created')
        },
        async sendMessage() {
            return {
                ...gatewaySession('permission_required'),
                output: 'Preparing edit.',
                pendingRequest: {
                    id: 'permission-1',
                    kind: 'permission',
                    prompt: 'Allow writing package.json?',
                    options: [
                        { id: 'allow', name: 'Allow once', kind: 'allow_once' },
                        { id: 'deny', name: 'Reject', kind: 'reject_once' }
                    ]
                }
            }
        }
    } as any
    const provider = new NexusGatewayProvider({ getConfig: () => config, client })
    const agent = provider.listAgents()[0]
    const result = await provider.run(agent, delegationJob(), {
        prompt: 'Edit package.json',
        background: true,
        newTask: false,
        sameTask: false
    })
    assert.equal(result.state, 'permission_required')
    assert.match(result.text || '', /Allow writing package\.json/)
    assert.match(result.text || '', /1\. Allow once \(allow\)/)
    assert.equal(result.providerState.gatewaySessionId, 'session-1')
    assert.equal(result.providerState.acpSessionId, 'acp-1')
    assert.equal(result.providerState.agentId, 'opencode')
    assert.equal(result.providerState.workspace, '/repos/project')
})

function session(state: 'created' | 'running') {
    return {
        id: 'session-1',
        acpSessionId: 'acp-1',
        agentId: 'opencode',
        workspace: '/workspace',
        state,
        artifacts: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    }
}

function gatewaySession(
    state: 'created' | 'permission_required'
) {
    return {
        id: 'session-1',
        acpSessionId: 'acp-1',
        agentId: 'opencode',
        workspace: '/repos/project',
        state,
        artifacts: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    }
}

function delegationJob(): DelegationJob {
    const now = Date.now()
    return {
        schemaVersion: 2,
        id: 'job-1',
        provider: 'gateway',
        agentId: 'logical-opencode',
        agentName: 'OpenCode',
        remoteId: 'gateway-1',
        remoteName: 'dev-server',
        providerAgentId: 'opencode',
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
        prompt: 'Edit package.json',
        providerState: {},
        artifacts: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        expiresAt: now + 60_000
    }
}
