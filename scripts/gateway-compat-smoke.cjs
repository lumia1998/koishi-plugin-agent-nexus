// Run against a built Gateway checkout without using an installed user's server/config.
// Usage: node scripts/gateway-compat-smoke.cjs [path-to-nexus-gateway]
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')

async function main() {
    const root = path.resolve(__dirname, '..')
    const gateway = path.resolve(process.argv[2] || path.join(root, '..', 'nexus-gateway'))
    const load = (name) => import(pathToFileURL(path.join(gateway, 'dist', name + '.js')).href)
    const [{ loadAgentdConfig }, { RunStore }, { WorkspacePolicy }, { SessionManager },
        { createDriverRegistry }, { createAgentdServer }, { closeServer }] = await Promise.all([
        load('config'), load('run-store'), load('workspace'), load('session'),
        load('drivers/index'), load('server'), load('index')
    ])
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugin-compat-'))
    let sessions, server, store
    try {
        const clientFile = path.join(temporary, 'client.cjs')
        await esbuild.build({ entryPoints: [path.join(root, 'src/gateway/client.ts')],
            outfile: clientFile, bundle: true, platform: 'node', format: 'cjs', target: 'node20' })
        const { NexusGatewayClient } = require(clientFile)
        const providerFile = path.join(temporary, 'provider.cjs')
        await esbuild.build({ entryPoints: [path.join(root, 'src/providers/gateway.ts')],
            outfile: providerFile, bundle: true, platform: 'node', format: 'cjs', target: 'node20' })
        const { NexusGatewayProvider } = require(providerFile)
        const configFile = path.join(temporary, 'config.json')
        await fs.writeFile(configFile, JSON.stringify({
            initialized: true, listen: { host: '127.0.0.1', port: 8787 },
            workspaceRoots: [temporary], maxEventsPerSession: 64,
            quotas: { maxSessionsPerKey: 1, maxRunningRunsPerKey: 1, maxSsePerKey: 2, maxUploadBytesPerKey: 1024 },
            apiKeys: [{ id: 'compat', name: 'Compatibility test', secret: 'compat-local-test-secret',
                enabled: true, scope: { allAgents: true, agentIds: [] }, createdAt: 1 }],
            agents: { compat: { protocol: 'acp', driver: 'stdio', command: process.execPath,
                args: [path.join(root, 'test/fixtures/gateway-acp.mjs')], probeArgs: ['--version'],
                workspace: temporary } }
        }))
        const config = await loadAgentdConfig(configFile)
        store = new RunStore(path.join(temporary, 'runs.json'))
        await store.init()
        sessions = new SessionManager(config, await WorkspacePolicy.create([temporary]), createDriverRegistry(config), store)
        server = createAgentdServer(config, sessions)
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const remote = { id: 'primary', name: 'Compatibility', enabled: true,
            baseUrl: `http://127.0.0.1:${server.address().port}`, authToken: 'compat-local-test-secret' }
        const client = new NexusGatewayClient()
        const created = await client.createSession(remote, { agentId: 'compat' })
        await assert.rejects(() => client.createSession(remote, { agentId: 'compat' }),
            (error) => error.status === 429 && error.quota === 'sessions' && error.retryAfterMs > 0)
        const started = await client.sendMessage(remote, created.id, 'compatibility test')
        let snapshot
        for (let attempts = 0; attempts < 100; attempts++) {
            snapshot = await client.getSession(remote, created.id)
            if (snapshot.state === 'completed') break
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert.equal(snapshot.state, 'completed')
        assert.equal(snapshot.completion.runId, started.runId)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
            const stream = client.events(remote, created.id, '999999999', controller.signal)
            const first = await stream.next()
            assert.equal(first.value.type, 'reset')
            await stream.return()
        } finally { clearTimeout(timeout); controller.abort() }
        const provider = new NexusGatewayProvider({ remote, client,
            getConfig: () => ({ delegation: { agents: [] } }) })
        const recoveryController = new AbortController()
        const recoveryTimeout = setTimeout(() => recoveryController.abort(), 5000)
        try {
            const recovery = provider.watch({}, { artifacts: [], providerState: {
                gatewaySessionId: created.id, gatewayRunId: started.runId,
                gatewayInstanceId: snapshot.instanceId, lastEventId: '999999999'
            } }, recoveryController.signal)
            const recovered = await recovery.next()
            assert.equal(recovered.value.state, 'completed')
            assert.equal(recovered.value.providerState.lastEventId, snapshot.lastEventId)
            await recovery.return()
        } finally { clearTimeout(recoveryTimeout); recoveryController.abort() }
        store.recordArtifacts(started.runId, [{ id: 'report', filename: 'report.txt', mediaType: 'text/plain', text: 'persisted output' }])
        await store.flush()
        // 0.4.0: mediaTypeForPath classifies media and source files instead of
        // falling back to octet-stream, which decides the chat element the
        // plugin builds for an artifact.
        for (const [name, expected] of [['shot.png', 'image/png'], ['clip.mp4', 'video/mp4'],
            ['voice.mp3', 'audio/mpeg'], ['notes.md', 'text/plain'], ['data.yaml', 'text/yaml']]) {
            const file = path.join(temporary, name)
            await fs.writeFile(file, 'x')
            const published = await client.publishArtifact(remote, created.id, file)
            const publishedArtifact = published.artifacts.find((item) => (item.filename || item.name) === name)
            assert.equal(publishedArtifact?.mediaType, expected, `${name} mediaType`)
        }
        await client.closeSession(remote, created.id)
        const artifact = await client.downloadArtifact(remote, started.runId, 'report')
        assert.equal(Buffer.from(artifact.bytes).toString(), 'persisted output')
        assert.equal(artifact.filename, 'report.txt')
        // 0.4.0: a run keeps at most 32 artifacts and trims the oldest ones.
        // Drivers report incrementally, so the newest survive and a trimmed id
        // must reach the plugin as a typed 404 it degrades on, not as a crash.
        for (let index = 0; index < 40; index++) {
            const id = `trim-${String(index).padStart(2, '0')}`
            store.recordArtifacts(started.runId, [{ id, filename: `${id}.txt`, mediaType: 'text/plain', text: `payload ${index}` }])
            await new Promise((resolve) => setTimeout(resolve, 2))
        }
        await store.flush()
        const trimmedArtifacts = store.get(started.runId).artifacts
        assert.equal(trimmedArtifacts.length, 32)
        assert.ok(trimmedArtifacts.some((item) => item.id === 'trim-39'), 'newest artifact must survive')
        assert.ok(!trimmedArtifacts.some((item) => item.id === 'trim-00'), 'oldest artifact must be trimmed')
        await assert.rejects(() => client.downloadArtifact(remote, started.runId, 'trim-00'),
            (error) => error.status === 404 && error.name === 'GatewayHttpError')
        const newest = await client.downloadArtifact(remote, started.runId, 'trim-39')
        assert.equal(Buffer.from(newest.bytes).toString(), 'payload 39')
        config.apiKeys[0].enabled = false
        await assert.rejects(() => client.listAgents(remote), (error) => error.status === 401 || error.status === 403)
        console.log('Gateway compatibility smoke passed: ACP completion, quota, SSE reset, persisted artifact, artifact trimming, mediaType mapping and revoked key.')
    } finally {
        if (server) await closeServer(server)
        if (sessions) await sessions.shutdown()
        if (store) await store.flush()
        await fs.rm(temporary, { recursive: true, force: true })
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
