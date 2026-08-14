import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createAgentdServer } from '../src/server.js'
import type { AgentdConfig } from '../src/types.js'

test('gateway requires bearer auth and rejects client supplied command/argv', async () => {
    let createCalls = 0
    const sessions = {
        async listAgents() {
            return []
        },
        async create() {
            createCalls += 1
            return {}
        }
    } as any
    const server = createAgentdServer(config(), sessions)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
        const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/agents`)
        assert.equal(unauthorized.status, 401)

        const agents = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
            headers: { Authorization: 'Bearer test-token' }
        })
        assert.equal(agents.status, 200)

        const injection = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'opencode',
                workspace: '/tmp/project',
                command: 'sh',
                argv: ['-c', 'PAYLOAD']
            })
        })
        assert.equal(injection.status, 400)
        assert.match(await injection.text(), /Unsupported request fields/)
        assert.equal(createCalls, 0)
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

function config(): AgentdConfig {
    return {
        listen: { host: '127.0.0.1', port: 0 },
        authToken: 'test-token',
        workspaceRoots: [],
        maxRequestBytes: 1024 * 1024,
        maxEventsPerSession: 64,
        maxOutputChars: 64 * 1024,
        sessionTtlMs: 60_000,
        agents: {}
    }
}
