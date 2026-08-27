import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createGatewayConnection,
    normalizeStoredNexusConfig
} from '../src/config.ts'
import { PRIMARY_GATEWAY_ID } from '../src/types.ts'
import { redactNexusConfig } from '../src/utils/config.ts'
import { resolveSecret } from '../src/utils/shell.ts'

test('keeps the Gateway API Key in Koishi settings, outside persisted config', () => {
    const config = { delegation: { agents: [] } }
    const connection = createGatewayConnection({
        gatewayUrl: 'http://gateway.lan:8787/',
        gatewayKey: 'KEY',
        commandAuthority: 4,
        maxResponseBytes: 32 * 1024 * 1024
    })
    assert.equal(connection.id, PRIMARY_GATEWAY_ID)
    assert.equal(connection.baseUrl, 'http://gateway.lan:8787')
    assert.equal(connection.authToken, 'KEY')
    assert.deepEqual(redactNexusConfig(config), config)
    assert.doesNotMatch(JSON.stringify(config), /KEY/)
})

test('disables the data-plane connection until an API Key is configured', () => {
    const connection = createGatewayConnection({
        gatewayUrl: 'http://127.0.0.1:8787',
        gatewayKey: '   ',
        commandAuthority: 4,
        maxResponseBytes: 32 * 1024 * 1024
    })
    assert.equal(connection.enabled, false)
    assert.equal(connection.authToken, undefined)
})

test('migrates only Gateway Agent overrides from the old configuration', () => {
    const normalized = normalizeStoredNexusConfig({
        hosts: [{ id: 'old-host' }],
        a2a: { remotes: [{ id: 'old-a2a' }] },
        gateway: { remotes: [{ id: 'gateway-1', authToken: 'SECRET' }] },
        delegation: {
            agents: [
                {
                    id: 'old-route',
                    name: 'Hermes 中文助手',
                    enabled: true,
                    provider: 'gateway',
                    remoteId: 'gateway-1',
                    agentId: 'hermes',
                    workspace: '/workspace'
                },
                {
                    id: 'old-a2a-route',
                    name: 'Old A2A',
                    enabled: true,
                    provider: 'a2a',
                    remoteId: 'old-a2a'
                }
            ]
        }
    })
    assert.equal(normalized.changed, true)
    assert.equal(normalized.removedLegacy, true)
    assert.equal(normalized.droppedAgents, 1)
    assert.deepEqual(normalized.config, {
        delegation: {
            agents: [
                {
                    agentId: 'hermes',
                    name: 'Hermes 中文助手',
                    enabled: true,
                    workspace: '/workspace',
                    description: undefined,
                    skills: undefined
                }
            ]
        }
    })
    assert.doesNotMatch(JSON.stringify(normalized.config), /SECRET|remoteId|provider/)
})

test('rejects unsafe Gateway URLs', () => {
    assert.throws(
        () =>
            createGatewayConnection({
                gatewayUrl: 'file:///etc/passwd',
                gatewayKey: 'KEY',
                commandAuthority: 4,
                maxResponseBytes: 32 * 1024 * 1024
            }),
        /http or https/
    )
    assert.throws(
        () =>
            createGatewayConnection({
                gatewayUrl: 'http://user:pass@gateway.lan:8787',
                gatewayKey: 'KEY',
                commandAuthority: 4,
                maxResponseBytes: 32 * 1024 * 1024
            }),
        /credentials/
    )
})

test('fails clearly when a referenced secret environment variable is missing', () => {
    const name = 'AGENT_NEXUS_TEST_MISSING_SECRET'
    const previous = process.env[name]
    delete process.env[name]
    try {
        assert.throws(() => resolveSecret(`env:${name}`), /is not set/)
    } finally {
        if (previous !== undefined) process.env[name] = previous
    }
})
