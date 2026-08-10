import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NexusA2AExecutor } from '../src/a2a/executor.ts'
import { BridgeArtifactRegistry } from '../src/bridge/artifacts.ts'
import { normalizeBridgeConfig } from '../src/bridge/config.ts'
import {
    buildBridgeMaintenancePlan,
    buildBridgeStatusCommand,
    parseBridgeStatus
} from '../src/bridge/maintenance.ts'
import { defaultSshBridgeConfig } from '../src/utils/bridge-config.ts'
import {
    AgentNexusBridgeServer,
    BRIDGE_A2A_PATH,
    BRIDGE_AGENT_CARD_PATH,
    BRIDGE_HEALTH_PATH,
    BRIDGE_LEGACY_CARD_PATH,
    buildBridgeCard
} from '../src/bridge/server.ts'

test('normalizes standalone bridge configuration and enabled agents', () => {
    const config = normalizeBridgeConfig({
        host: '0.0.0.0',
        port: 9191,
        publicBaseUrl: 'http://10.1.2.50:9191/',
        agents: 'claude,opencode,pi',
        cwd: '.',
        runtime: { claudeSkipPermissions: false }
    })
    assert.equal(config.publicBaseUrl, 'http://10.1.2.50:9191')
    assert.equal(config.agents.claude, true)
    assert.equal(config.agents.opencode, true)
    assert.equal(config.agents.pi, true)
    assert.equal(config.agents.hermes, false)
    assert.equal(config.runtime.claudeSkipPermissions, false)
    assert.throws(() => normalizeBridgeConfig({ agents: 'claude,missing' }))
    assert.throws(() => normalizeBridgeConfig({ port: 70000 }))
})

test('publishes only files inside the configured bridge root', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'nexus-bridge-artifact-'))
    const root = path.join(temp, 'workspace')
    const outside = path.join(temp, 'outside.txt')
    await mkdir(root)
    await writeFile(path.join(root, 'result.txt'), 'bridge artifact')
    await writeFile(outside, 'secret')
    try {
        const registry = new BridgeArtifactRegistry(root, 60000)
        registry.setPublicBaseUrl('http://127.0.0.1:8787')
        const artifact = await registry.register('./result.txt', root)
        assert.equal(artifact.name, 'result.txt')
        assert.match(artifact.url, /^http:\/\/127\.0\.0\.1:8787\/artifacts\//)
        assert.equal(artifact.path, await realpath(path.join(root, 'result.txt')))
        await assert.rejects(() => registry.register(outside, root), /outside the bridge root/)
    } finally {
        await rm(temp, { recursive: true, force: true })
    }
})

test('serves bridge health/cards and protects JSON-RPC with bearer auth', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'nexus-bridge-http-'))
    const port = await freePort()
    const config = normalizeBridgeConfig({
        host: '127.0.0.1',
        port,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        token: 'BRIDGE_TOKEN',
        dataDir: temp,
        cwd: temp,
        agents: ['claude', 'pi'],
        maxRequestBytes: 1024
    })
    const a2aExecutor = new NexusA2AExecutor({
        async runInSession() {
            return {
                kind: 'completed',
                result: {
                    agent: 'pi',
                    hostId: 'local',
                    text: 'bridge complete',
                    files: [],
                    images: [],
                    raw: 'bridge complete',
                    exitCode: 0,
                    timedOut: false,
                    command: 'pi'
                }
            }
        },
        async cancelSessions() {
            return 0
        }
    })
    const artifacts = new BridgeArtifactRegistry(temp, 60000)
    const runtime = {
        a2aExecutor,
        artifacts,
        detectedAgents: [
            { kind: 'claude', installed: true, path: '/usr/bin/claude' },
            { kind: 'pi', installed: false }
        ],
        async shutdown() {
            await a2aExecutor.shutdown()
        }
    } as any
    const server = new AgentNexusBridgeServer(config, runtime)
    await server.start()
    try {
        const health = await fetchJson(`http://127.0.0.1:${port}${BRIDGE_HEALTH_PATH}`)
        assert.equal(health.status, 200)
        assert.equal(health.body.ok, true)

        const card = await fetchJson(
            `http://127.0.0.1:${port}${BRIDGE_AGENT_CARD_PATH}`
        )
        assert.equal(card.status, 200)
        assert.deepEqual(card.body.skills.map((skill: any) => skill.id), ['local-claude'])
        assert.equal(card.body.supportedInterfaces[0].url, `http://127.0.0.1:${port}/a2a`)

        const legacy = await fetchJson(
            `http://127.0.0.1:${port}${BRIDGE_LEGACY_CARD_PATH}`
        )
        assert.equal(legacy.body.protocolVersion, '0.3')
        assert.equal(legacy.body.securitySchemes.bearer.type, 'http')

        const oversized = await fetchJson(
            `http://127.0.0.1:${port}${BRIDGE_A2A_PATH}`,
            {
                method: 'POST',
                headers: { authorization: 'Bearer BRIDGE_TOKEN' },
                body: 'x'.repeat(1025)
            }
        )
        assert.equal(oversized.status, 413)

        const rpc = {
            jsonrpc: '2.0',
            id: 10,
            method: 'SendMessage',
            params: {
                message: {
                    messageId: 'bridge-message',
                    role: 'ROLE_USER',
                    parts: [{ text: 'hello', mediaType: 'text/plain' }]
                },
                configuration: { acceptedOutputModes: ['text/plain'] }
            }
        }
        const unauthorized = await fetchJson(
            `http://127.0.0.1:${port}${BRIDGE_A2A_PATH}`,
            { method: 'POST', body: JSON.stringify(rpc) }
        )
        assert.equal(unauthorized.status, 401)

        const authorized = await fetchJson(
            `http://127.0.0.1:${port}${BRIDGE_A2A_PATH}`,
            {
                method: 'POST',
                headers: {
                    authorization: 'Bearer BRIDGE_TOKEN',
                    'content-type': 'application/json'
                },
                body: JSON.stringify(rpc)
            }
        )
        assert.equal(authorized.status, 200)
        assert.equal(authorized.body.result.task.status.state, 'TASK_STATE_COMPLETED')
        assert.equal(
            authorized.body.result.task.artifacts[0].parts[0].text,
            'bridge complete'
        )

        const streamResponse = await fetch(
            `http://127.0.0.1:${port}${BRIDGE_A2A_PATH}`,
            {
                method: 'POST',
                headers: {
                    authorization: 'Bearer BRIDGE_TOKEN',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    ...rpc,
                    id: 11,
                    method: 'SendStreamingMessage',
                    params: {
                        ...rpc.params,
                        message: {
                            ...rpc.params.message,
                            messageId: 'bridge-stream-message'
                        }
                    }
                })
            }
        )
        assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/)
        const streamBody = await streamResponse.text()
        assert.match(streamBody, /TASK_STATE_WORKING/)
        assert.match(streamBody, /TASK_STATE_COMPLETED/)
    } finally {
        await server.stop()
        await rm(temp, { recursive: true, force: true })
    }
})

test('builds a card with only enabled and detected local agents', () => {
    const config = normalizeBridgeConfig({
        publicBaseUrl: 'http://10.1.2.50:8787',
        agents: ['hermes', 'opencode']
    })
    const card = buildBridgeCard(config, {
        detectedAgents: [
            { kind: 'hermes', installed: true },
            { kind: 'opencode', installed: false },
            { kind: 'claude', installed: true }
        ]
    } as any)
    assert.deepEqual(card.skills.map((skill) => skill.id), ['local-hermes'])
    assert.deepEqual(card.defaultInputModes, ['text/plain'])

    const ipv6Card = buildBridgeCard(
        normalizeBridgeConfig({ host: '::1', port: 8787, agents: [] }),
        { detectedAgents: [] } as any
    )
    assert.equal(ipv6Card.supportedInterfaces[0].url, 'http://[::1]:8787/a2a')
})

test('builds a user-scoped systemd deployment with SFTP config files', () => {
    const config = {
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: true,
            codexBypassSandbox: true,
            opencodeAuto: true,
            defaultTimeoutMs: 600000
        },
        a2a: { remotes: [] }
    } as any
    const host = {
        id: 'remote-1',
        name: 'Remote Agent',
        host: '10.1.2.50',
        cwd: '~/workspace',
        idleTimeoutMs: 900000,
        bridge: {
            ...defaultSshBridgeConfig(),
            enabled: true,
            port: 8787,
            token: 'secret-token',
            agents: {
                hermes: true,
                openclaw: true,
                claude: true,
                opencode: true,
                codex: true,
                pi: true
            }
        }
    } as any
    const plan = buildBridgeMaintenancePlan('install', host, config)
    assert.equal(plan.localPackagePath, '~/.agent-nexus/bridge/agent-nexus-bridge.tgz')
    assert.match(plan.command, /npm install -g --omit=peer/)
    assert.match(plan.command, /agent-nexus-bridge\.tgz/)
    assert.match(plan.prepareCommand!, /agent-nexus\/bin\/node/)
    assert.match(plan.command, /systemctl --user enable/)
    assert.match(plan.command, /systemctl --user restart/)
    assert.match(plan.command, /agent-nexus-bridge\.service/)
    assert.doesNotMatch(plan.command, /secret-token/)
    assert.doesNotMatch(plan.prepareCommand!, /secret-token/)
    const configFile = plan.files?.find((file) => file.path.endsWith('/config.json.tmp'))
    const unitFile = plan.files?.find((file) => file.path.endsWith('.service.tmp'))
    assert.ok(configFile)
    assert.match(unitFile!.content, /PATH=%h\/\.agent-nexus\/bin:/)
    assert.equal(configFile!.mode, 0o600)
    const remoteConfig = JSON.parse(configFile!.content)
    assert.equal(remoteConfig.publicBaseUrl, 'http://10.1.2.50:8787')
    assert.equal(remoteConfig.cwd, '~/workspace')
    assert.equal(remoteConfig.token, 'secret-token')

    const registryPlan = buildBridgeMaintenancePlan(
        'update',
        {
            ...host,
            bridge: { ...host.bridge, packageSpec: 'koishi-plugin-agent-nexus@next' }
        },
        config
    )
    assert.equal(registryPlan.localPackagePath, undefined)
    assert.match(registryPlan.command, /koishi-plugin-agent-nexus@next/)
})

test('parses remote bridge systemd and health states', () => {
    const host = {
        host: '10.1.2.50',
        bridge: {
            ...defaultSshBridgeConfig(),
            enabled: true,
            port: 9123
        }
    } as any
    assert.match(buildBridgeStatusCommand(host.bridge), /127\.0\.0\.1:9123\/health/)
    const running = parseBridgeStatus(
        `__AGENT_NEXUS_SYSTEMD__
LoadState=loaded
ActiveState=active
SubState=running
MainPID=1234
__AGENT_NEXUS_HEALTH__
{"ok":true,"version":"0.1.31","activeTasks":2,"agents":[{"kind":"pi","installed":true}]}`,
        host
    )
    assert.equal(running.state, 'running')
    assert.equal(running.pid, 1234)
    assert.equal(running.activeTasks, 2)
    assert.equal(running.agents[0].kind, 'pi')

    const missing = parseBridgeStatus(
        `__AGENT_NEXUS_SYSTEMD__
LoadState=not-found
ActiveState=inactive
__AGENT_NEXUS_HEALTH__`,
        host
    )
    assert.equal(missing.state, 'not-installed')
})

async function freePort() {
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    )
    return port
}

async function fetchJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init)
    return {
        status: response.status,
        body: await response.json()
    }
}
