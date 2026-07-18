import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
    buildRemoteRealpathCommand,
    isRemotePathWithinRoot,
    validateGitRef,
    validatePathSegment,
    validateRepoUrl,
    validateSkillSubdir
} from '../src/utils/security.ts'
import { ClaudeAdapter } from '../src/adapters/claude.ts'
import { CodexAdapter } from '../src/adapters/codex.ts'
import { HermesAdapter } from '../src/adapters/hermes.ts'
import { OpenClawAdapter } from '../src/adapters/openclaw.ts'
import { OpenCodeAdapter } from '../src/adapters/opencode.ts'
import { cleanAgentText, extractPaths, parseJsonLines } from '../src/adapters/base.ts'
import { syncSkillSource } from '../src/skills/sync.ts'
import { resolveSecret } from '../src/utils/shell.ts'
import {
    assertUniqueHostName,
    mergeHostSecrets,
    patchHostConfig,
    redactNexusConfig,
    repairHostIds,
    resolveHostReference,
    routeCommandHost
} from '../src/utils/config.ts'
import { createId } from '../client/utils/id.ts'
import { splitMessage } from '../src/utils/text.ts'
import {
    buildAgentMaintenancePlan,
    isVersionNewer,
    normalizeAgentVersion
} from '../src/agents/maintenance.ts'
import { mimeType } from '../src/utils/mime.ts'
import { SshSession } from '../src/ssh/session.ts'
import {
    enrichPath,
    filterRemoteEnvironment,
    parseEnvironmentProbe
} from '../src/ssh/session.ts'
import { terminalMessageSize } from '../src/proxy.ts'
import { NexusListAgentsTool } from '../src/tools/list_agents.ts'
import { SftpFileManager } from '../src/files/manager.ts'

test('creates UUIDs without crypto.randomUUID for LAN HTTP consoles', () => {
    const id = createId({
        getRandomValues(array) {
            array.fill(10)
            return array
        }
    })
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('splits long agent replies without dropping content', () => {
    const text = `${'a'.repeat(20)}\n${'b'.repeat(20)}`
    const chunks = splitMessage(text, 25)
    assert.deepEqual(chunks, ['a'.repeat(20), 'b'.repeat(20)])
})

test('rejects unsafe skill path segments', () => {
    assert.throws(() => validatePathSegment('../outside', 'skill name'))
    assert.throws(() => validatePathSegment('name;rm -rf', 'skill name'))
    assert.equal(validatePathSegment('my-skill.v1', 'skill name'), 'my-skill.v1')
})

test('rejects traversal in skill subdirectories', () => {
    assert.throws(() => validateSkillSubdir('../secrets'))
    assert.throws(() => validateSkillSubdir('safe/../../secrets'))
    assert.equal(validateSkillSubdir('/docs/reference/'), 'docs/reference')
})

test('rejects unsafe git refs', () => {
    assert.throws(() => validateGitRef('--upload-pack=evil'))
    assert.throws(() => validateGitRef('main; touch /tmp/pwned'))
    assert.equal(validateGitRef('feature/safe-name'), 'feature/safe-name')
})

test('rejects repository values that can become git options', () => {
    assert.throws(() => validateRepoUrl('--upload-pack=evil'))
    assert.throws(() => validateRepoUrl('https://example.com/repo.git\n--config=evil'))
    assert.equal(validateRepoUrl('git@example.com:team/repo.git'), 'git@example.com:team/repo.git')
})

test('only allows publishing files below the remote root', () => {
    assert.equal(isRemotePathWithinRoot('/home/agent/out/a.png', '/home/agent/out'), true)
    assert.equal(isRemotePathWithinRoot('/home/agent/out/../.ssh/id_rsa', '/home/agent/out'), false)
    assert.equal(isRemotePathWithinRoot('/etc/passwd', '/home/agent'), false)
    assert.equal(isRemotePathWithinRoot('/etc/passwd', '/'), true)
})

test('quotes remote paths before canonicalization', () => {
    const command = buildRemoteRealpathCommand("/tmp/a'; touch /tmp/pwned; '")
    assert.equal(command, "readlink -f -- '/tmp/a'\\''; touch /tmp/pwned; '\\'''" )
})

test('quotes model overrides in agent commands', () => {
    const model = 'model; touch /tmp/pwned'
    const runtime = {
        openclawAgent: 'default',
        claudeSkipPermissions: false,
        codexBypassSandbox: false,
        opencodeAuto: true,
        defaultTimeoutMs: 1000
    }

    for (const adapter of [new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter()]) {
        const command = adapter.buildInnerCommand('"$PROMPT"', { prompt: '', model, runtime })
        assert.match(command, /'model; touch \/tmp\/pwned'/)
    }
})

test('honors runtime safety switches in agent commands', () => {
    const runtime = {
        openclawAgent: 'default',
        claudeSkipPermissions: false,
        codexBypassSandbox: false,
        opencodeAuto: false,
        defaultTimeoutMs: 1000
    }
    assert.doesNotMatch(new ClaudeAdapter().buildInnerCommand('"$PROMPT"', { prompt: '', runtime }), /skip-permissions/)
    assert.doesNotMatch(new CodexAdapter().buildInnerCommand('"$PROMPT"', { prompt: '', runtime }), /bypass-approvals/)
    assert.doesNotMatch(new OpenCodeAdapter().buildInnerCommand('"$PROMPT"', { prompt: '', runtime }), /--auto/)

    runtime.claudeSkipPermissions = true
    runtime.codexBypassSandbox = true
    runtime.opencodeAuto = true
    assert.match(new ClaudeAdapter().buildInnerCommand('"$PROMPT"', { prompt: '', runtime }), /skip-permissions/)
    assert.match(new CodexAdapter().buildInnerCommand('"$PROMPT"', { prompt: '', runtime }), /bypass-approvals/)
    assert.match(new OpenCodeAdapter().buildInnerCommand('"$PROMPT"', { prompt: '', runtime }), /--auto/)
})

test('parses JSONL agent output into readable text', () => {
    const text = [
        JSON.stringify({ type: 'message', part: { type: 'text', text: 'first' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } })
    ].join('\n')
    assert.equal(parseJsonLines(text), 'first\nsecond')
})

test('runs Hermes one-shot queries without CLI presentation output', () => {
    const command = new HermesAdapter().buildInnerCommand('"$PROMPT"', {
        prompt: '',
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: false,
            codexBypassSandbox: false,
            opencodeAuto: true,
            defaultTimeoutMs: 1000
        }
    })
    assert.equal(command, 'hermes -z "$PROMPT"')
})

test('uses Claude Code single-result JSON without session persistence', () => {
    const adapter = new ClaudeAdapter()
    const command = adapter.buildInnerCommand('"$PROMPT"', {
        prompt: '',
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: false,
            codexBypassSandbox: false,
            opencodeAuto: true,
            defaultTimeoutMs: 1000
        }
    })
    assert.match(command, /-p "\$PROMPT" --output-format json --no-session-persistence/)
    const result = adapter.parseResult(
        JSON.stringify({ result: 'final answer', session_id: 'ignored' }),
        '',
        0,
        false,
        command
    )
    assert.equal(result.text, 'final answer')
    assert.equal(result.providerState, undefined)

    const managed = adapter.buildInnerCommand('"$PROMPT"', {
        prompt: '',
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: false,
            codexBypassSandbox: false,
            opencodeAuto: true,
            defaultTimeoutMs: 1000
        },
        sessionMode: 'managed',
        providerState: { sessionId: 'claude-session-id' }
    })
    assert.match(managed, /--resume 'claude-session-id'/)
    assert.match(managed, /--append-system-prompt/)
    assert.doesNotMatch(managed, /--no-session-persistence/)
    const resumed = adapter.parseResult(
        JSON.stringify({ result: 'continued', session_id: 'claude-session-id' }),
        '',
        0,
        false,
        managed
    )
    assert.equal(resumed.providerState?.sessionId, 'claude-session-id')
})

test('uses current OpenClaw JSON agent invocation', () => {
    const adapter = new OpenClawAdapter()
    const command = adapter.buildInnerCommand('"$PROMPT"', {
        prompt: '',
        runtime: {
            openclawAgent: 'main',
            claudeSkipPermissions: false,
            codexBypassSandbox: false,
            opencodeAuto: true,
            defaultTimeoutMs: 1000
        }
    })
    assert.equal(
        command,
        `openclaw agent --local --agent 'main' --message "$PROMPT" --json`
    )
    const result = adapter.parseResult(
        JSON.stringify({ payloads: [{ text: 'first' }, { text: 'second' }] }),
        '',
        0,
        false,
        command
    )
    assert.equal(result.text, 'first\nsecond')
})

test('keeps only OpenCode assistant text events', () => {
    const adapter = new OpenCodeAdapter()
    const stdout = [
        JSON.stringify({ type: 'step_start', part: { text: 'starting' } }),
        JSON.stringify({ type: 'tool_use', part: { text: 'tool preview' } }),
        JSON.stringify({ type: 'text', part: { text: 'final answer' } })
    ].join('\n')
    const result = adapter.parseResult(stdout, '', 0, false, 'opencode run')
    assert.equal(result.text, 'final answer')
})

test('keeps only completed Codex agent messages', () => {
    const adapter = new CodexAdapter()
    const stdout = [
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'ls' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })
    ].join('\n')
    const result = adapter.parseResult(stdout, '', 0, false, 'codex exec')
    assert.equal(result.text, 'done')
    assert.match(
        adapter.buildInnerCommand('"$PROMPT"', {
            prompt: '',
            runtime: {
                openclawAgent: 'default',
                claudeSkipPermissions: false,
                codexBypassSandbox: false,
                opencodeAuto: true,
                defaultTimeoutMs: 1000
            }
        }),
        /--json --ephemeral/
    )
})

test('removes internal file manifests from user-visible agent text', () => {
    assert.equal(
        cleanAgentText(`完成。\n\n<nexus_files>\n（无文件产生）\n</nexus_files>`),
        '完成。'
    )
    assert.equal(
        cleanAgentText(`完成。\n<nexus_files>\n/workspace/report.pdf\n</nexus_files>\n请查收。`),
        '完成。\n\n请查收。'
    )
})

test('extracts files before hiding the internal manifest from replies', () => {
    const adapter = new HermesAdapter()
    const result = adapter.parseResult(
        `报告已生成。\n<nexus_files>\n/workspace/report.pdf\n</nexus_files>`,
        '',
        0,
        false,
        'hermes -z'
    )
    assert.equal(result.text, '报告已生成。')
    assert.deepEqual(result.files, ['/workspace/report.pdf'])
})

test('only extracts explicitly declared or markdown-linked local files', () => {
    const text = `Visit https://example.com/a.png and import foo/bar.ts.
![result](./out/result.png)
<nexus_files>
/workspace/report.pdf
https://example.com/remote.zip
</nexus_files>`
    assert.deepEqual(extractPaths(text), ['/workspace/report.pdf', './out/result.png'])
})

test('uses file-specific MIME types for storage uploads', () => {
    assert.equal(mimeType('/tmp/a.png'), 'image/png')
    assert.equal(mimeType('/tmp/a.pdf'), 'application/pdf')
    assert.equal(mimeType('/tmp/a.unknown'), 'application/octet-stream')
})

test('expands the configured skill root through remote HOME', async () => {
    let command = ''
    const session = {
        async exec(value: string) {
            command = value
            return {
                exitCode: 0,
                stdout: '/home/agent/.agent-nexus/skills/demo',
                stderr: '',
                timedOut: false
            }
        }
    }
    const config = {
        skillRoot: '~/.agent-nexus/skills',
        hosts: [],
        skills: [],
        agents: { hermes: true, openclaw: true, claude: true, opencode: true, codex: true },
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: false,
            codexBypassSandbox: false,
            opencodeAuto: true,
            defaultTimeoutMs: 1000
        }
    }

    await syncSkillSource(
        session as never,
        { id: 'demo', name: 'demo', repoUrl: 'https://example.com/demo.git', enabled: true },
        config,
        []
    )

    assert.match(command, /ROOT=.*sed .*\^~/)
    assert.match(command, /REPO="\$REPOS\/demo"/)
    assert.match(command, /SKILL\.md not found/)
    assert.match(command, /STAGE=/)
    assert.match(command, /BACKUP=/)
})

test('fails clearly when a referenced secret environment variable is missing', () => {
    const key = 'AGENT_NEXUS_TEST_MISSING_SECRET'
    delete process.env[key]
    assert.throws(() => resolveSecret(`env:${key}`), /is not set/)
})

test('redacts stored host secrets before returning console data', () => {
    const config = {
        skillRoot: '~/.agent-nexus/skills',
        defaultHostId: 'password-host',
        hosts: [
            {
                id: 'password-host',
                name: 'password',
                host: '127.0.0.1',
                port: 22,
                username: 'root',
                auth: { type: 'password' as const, password: 'secret' },
                enabled: true,
                idleTimeoutMs: 1000
            },
            {
                id: 'key-host',
                name: 'key',
                host: '127.0.0.1',
                port: 22,
                username: 'root',
                auth: {
                    type: 'key' as const,
                    privateKey: 'private-key',
                    passphrase: 'passphrase'
                },
                enabled: true,
                idleTimeoutMs: 1000
            }
        ],
        skills: [],
        agents: { hermes: true, openclaw: true, claude: true, opencode: true, codex: true },
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: false,
            codexBypassSandbox: false,
            opencodeAuto: true,
            defaultTimeoutMs: 1000
        }
    }

    const redacted = redactNexusConfig(config)
    assert.equal(redacted.hosts[0].auth.type, 'password')
    assert.equal(redacted.hosts[0].auth.password, '')
    assert.equal(redacted.hosts[1].auth.type, 'key')
    assert.equal(redacted.hosts[1].auth.privateKey, '')
    assert.equal(redacted.hosts[1].auth.passphrase, undefined)
    assert.equal(config.hosts[0].auth.password, 'secret')
})

test('keeps stored secrets when an edited host submits blank credentials', () => {
    const previous = {
        id: 'host',
        name: 'old',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        auth: { type: 'key' as const, privateKey: 'private-key', passphrase: 'phrase' },
        enabled: true,
        idleTimeoutMs: 1000
    }
    const incoming = {
        ...previous,
        name: 'new',
        auth: { type: 'key' as const, privateKey: '', passphrase: undefined }
    }

    assert.deepEqual(mergeHostSecrets(incoming, previous).auth, previous.auth)
})

test('keeps previous auth when password host is edited without auth field', () => {
    const previous = {
        id: 'host',
        name: 'build',
        host: '10.1.2.10',
        port: 22,
        username: 'root',
        auth: { type: 'password' as const, password: 'secret' },
        enabled: true,
        defaultAgent: 'claude' as const,
        idleTimeoutMs: 30_000,
        cwd: '~/work'
    }
    const patched = patchHostConfig(previous, {
        name: 'build',
        host: '10.1.2.11',
        port: 22,
        username: 'root'
    })
    assert.deepEqual(patched.auth, previous.auth)
    assert.equal(patched.defaultAgent, 'claude')
    assert.equal(patched.idleTimeoutMs, 30_000)
    assert.equal(patched.cwd, '~/work')
    assert.equal(patched.host, '10.1.2.11')
})

test('does not convert key host to empty password auth', () => {
    const previous = {
        id: 'host',
        name: 'build',
        host: '10.1.2.10',
        port: 22,
        username: 'root',
        auth: { type: 'key' as const, privateKey: 'private-key' },
        enabled: true,
        idleTimeoutMs: 1000
    }
    const patched = patchHostConfig(previous, {
        auth: { type: 'password', password: '' }
    })
    assert.equal(patched.auth.type, 'key')
    assert.equal(patched.auth.type === 'key' && patched.auth.privateKey, 'private-key')
})

test('rejects duplicate device names', () => {
    const hosts = [
        {
            id: 'a',
            name: 'build',
            host: '10.1.2.1',
            port: 22,
            username: 'root',
            auth: { type: 'password' as const, password: 'x' },
            enabled: true,
            idleTimeoutMs: 1000
        }
    ]
    assert.throws(() => assertUniqueHostName(hosts, 'Build'), /已存在/)
    assert.equal(assertUniqueHostName(hosts, 'dev'), 'dev')
})

test('resolves SSH hosts by ID, address, name, and connection target', () => {
    const hosts = [
        {
            id: 'host-50',
            name: 'Build Server',
            host: '10.1.2.50',
            port: 22,
            username: 'lumia',
            auth: { type: 'password' as const, password: 'secret' },
            enabled: true,
            idleTimeoutMs: 1000
        }
    ]

    assert.equal(resolveHostReference(hosts, 'host-50')?.id, 'host-50')
    assert.equal(resolveHostReference(hosts, '10.1.2.50')?.id, 'host-50')
    assert.equal(resolveHostReference(hosts, 'Build Server')?.id, 'host-50')
    assert.equal(resolveHostReference(hosts, '10.1.2.50:22')?.id, 'host-50')
    assert.equal(resolveHostReference(hosts, 'lumia@10.1.2.50')?.id, 'host-50')
    assert.equal(resolveHostReference(hosts, 'lumia@10.1.2.50:22')?.id, 'host-50')
})

test('list agents accepts a device name instead of filtering only by host id', async () => {
    const status = {
        enabled: true,
        defaultHostId: 'host-computer',
        hosts: [
            {
                id: 'host-computer',
                name: 'computer',
                host: 'lumia@10.1.2.50:22',
                state: 'connected' as const,
                agents: [],
                sessionCount: 1
            }
        ],
        skills: { total: 0, items: [] },
        activeSessions: 0
    }
    const tool = new NexusListAgentsTool({
        resolveHostId(reference: string) {
            assert.equal(reference, 'computer')
            return 'host-computer'
        },
        getStatus() {
            return status
        }
    } as any)
    const output = await tool._call({ hostId: 'computer' })
    assert.match(output, /name: computer/)
    assert.doesNotMatch(output, /No hosts configured/)
})

test('rejects ambiguous SSH host addresses', () => {
    const hosts = ['first', 'second'].map((id) => ({
        id,
        name: id,
        host: '10.1.2.50',
        port: 22,
        username: id,
        auth: { type: 'password' as const, password: 'secret' },
        enabled: true,
        idleTimeoutMs: 1000
    }))
    assert.throws(() => resolveHostReference(hosts, '10.1.2.50'), /歧义/)
})

test('repairs missing and duplicate SSH host IDs', () => {
    const hosts = ['', '', 'same', 'same'].map((id, index) => ({
        id,
        name: `host-${index}`,
        host: `10.1.2.${30 + index}`,
        port: 22,
        username: 'root',
        auth: { type: 'password' as const, password: 'secret' },
        enabled: true,
        idleTimeoutMs: 1000
    }))
    const repaired = repairHostIds(hosts)
    assert.equal(repaired.changed, true)
    assert.equal(new Set(repaired.hosts.map((host) => host.id)).size, 4)
    assert.ok(repaired.hosts.every((host) => host.id))
})

test('routes commands directly when only one SSH host is enabled', () => {
    const hosts = [
        {
            id: 'only',
            name: 'hermes',
            host: '10.1.2.40',
            port: 22,
            username: 'lumia',
            auth: { type: 'password' as const, password: 'secret' },
            enabled: true,
            idleTimeoutMs: 1000
        }
    ]
    assert.deepEqual(routeCommandHost(hosts, '查看 Linux 版本'), {
        hostId: 'only',
        prompt: '查看 Linux 版本'
    })
})

test('routes multi-host commands by leading device name', () => {
    const hosts = ['hermes', 'claude'].map((name, index) => ({
        id: `host-${index}`,
        name,
        host: `10.1.2.${40 + index}`,
        port: 22,
        username: 'lumia',
        auth: { type: 'password' as const, password: 'secret' },
        enabled: true,
        idleTimeoutMs: 1000
    }))
    assert.deepEqual(routeCommandHost(hosts, 'hermes 查看 Linux 版本'), {
        hostId: 'host-0',
        prompt: '查看 Linux 版本'
    })
    assert.throws(() => routeCommandHost(hosts, '查看 Linux 版本'), /hermes、claude/)
})

test('routes multi-host commands by longest device name prefix', () => {
    const hosts = ['build', 'build-server'].map((name, index) => ({
        id: `host-${index}`,
        name,
        host: `10.1.2.${40 + index}`,
        port: 22,
        username: 'lumia',
        auth: { type: 'password' as const, password: 'secret' },
        enabled: true,
        idleTimeoutMs: 1000
    }))
    assert.deepEqual(routeCommandHost(hosts, 'build-server 检查版本'), {
        hostId: 'host-1',
        prompt: '检查版本'
    })
    assert.deepEqual(routeCommandHost(hosts, 'build 修 bug'), {
        hostId: 'host-0',
        prompt: '修 bug'
    })
})

function sshSession(maxOutputBytes = 1024) {
    const session = new SshSession({
        id: 'host',
        name: 'host',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        auth: { type: 'password', password: 'secret' },
        enabled: true,
        idleTimeoutMs: 1000
    }, maxOutputBytes)
    ;(session as any).connect = async () => undefined
    ;(session as any).connected = true
    return session
}

test('closes an SSH channel that arrives after the command timed out', async () => {
    const session = sshSession()
    let closed = false
    ;(session as any).client = {
        exec(_command: string, callback: (err: Error | undefined, channel: any) => void) {
            setTimeout(() => {
                const channel = new EventEmitter() as any
                channel.stderr = new EventEmitter()
                channel.signal = () => undefined
                channel.close = () => { closed = true }
                callback(undefined, channel)
            }, 20)
        }
    }
    const result = await session.exec('sleep 1', { timeoutMs: 5 })
    assert.equal(result.timedOut, true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(closed, true)
})

test('limits captured SSH output', async () => {
    const session = sshSession(5)
    ;(session as any).client = {
        exec(_command: string, callback: (err: Error | undefined, channel: any) => void) {
            const channel = new EventEmitter() as any
            channel.stderr = new EventEmitter()
            channel.signal = () => undefined
            channel.close = () => undefined
            callback(undefined, channel)
            channel.emit('data', Buffer.from('123456789'))
            channel.emit('close', 0, '')
        }
    }
    const result = await session.exec('echo test')
    assert.equal(result.stdout, '12345')
    assert.equal(result.truncated, true)
})

test('times out SSH shell creation and closes a late channel', async () => {
    const session = sshSession()
    let closed = false
    ;(session as any).client = {
        shell(_options: unknown, callback: (err: Error | undefined, channel: any) => void) {
            setTimeout(() => {
                const channel = new EventEmitter() as any
                channel.close = () => { closed = true }
                callback(undefined, channel)
            }, 20)
        }
    }
    await assert.rejects(
        session.createTerminal({ timeoutMs: 5 }),
        /channel creation timed out/
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(closed, true)
    assert.equal(session.hasActiveOperations(), false)
})

test('keeps an SSH session active until its terminal closes', async () => {
    const session = sshSession()
    const channel = new EventEmitter() as any
    channel.write = () => undefined
    channel.close = () => channel.emit('close')
    channel.setWindow = () => undefined
    ;(session as any).client = {
        shell(_options: unknown, callback: (err: Error | undefined, channel: any) => void) {
            callback(undefined, channel)
        }
    }

    const terminal = await session.createTerminal()
    assert.equal(session.hasActiveOperations(), true)
    terminal.kill()
    assert.equal(session.hasActiveOperations(), false)
})

test('measures terminal WebSocket messages before parsing', () => {
    assert.equal(terminalMessageSize(Buffer.alloc(12)), 12)
    assert.equal(terminalMessageSize([Buffer.alloc(5), Buffer.alloc(7)]), 12)
    assert.equal(terminalMessageSize('你好'), 6)
})

test('detects hermes outside bare non-interactive PATH', async () => {
    const adapter = new HermesAdapter()
    const session = {
        async exec(command: string) {
            if (command.includes('found=') || command.includes('command -v')) {
                return {
                    exitCode: 0,
                    stdout: '/home/lumia/.local/bin/hermes\n',
                    stderr: '',
                    timedOut: false
                }
            }
            if (command.includes('--version')) {
                return {
                    exitCode: 0,
                    stdout: 'hermes 0.9.0\n',
                    stderr: '',
                    timedOut: false
                }
            }
            return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        }
    }
    const result = await adapter.detect(session as any)
    assert.equal(result.installed, true)
    assert.equal(result.path, '/home/lumia/.local/bin/hermes')
    assert.equal(result.version, 'hermes 0.9.0')
})

test('reports hermes missing when no candidate path exists', async () => {
    const adapter = new HermesAdapter()
    const session = {
        async exec() {
            return { exitCode: 1, stdout: '\n', stderr: '', timedOut: false }
        }
    }
    const result = await adapter.detect(session as any)
    assert.equal(result.installed, false)
    assert.equal(result.path, undefined)
})

test('shares an in-flight SFTP initialization', async () => {
    const session = sshSession()
    const wrapper = new EventEmitter() as any
    let calls = 0
    ;(session as any).client = {
        sftp(callback: (err: Error | undefined, sftp: any) => void) {
            calls += 1
            setTimeout(() => callback(undefined, wrapper), 5)
        }
    }
    const [first, second] = await Promise.all([session.getSftp(), session.getSftp()])
    assert.equal(calls, 1)
    assert.equal(first, wrapper)
    assert.equal(second, wrapper)
})

test('detects every supported agent through the shared SSH probe', async () => {
    const adapters = [
        new HermesAdapter(),
        new OpenClawAdapter(),
        new ClaudeAdapter(),
        new OpenCodeAdapter(),
        new CodexAdapter()
    ]
    for (const adapter of adapters) {
        const bin = adapter.binNames[0]
        const executable = `/home/lumia/.${adapter.kind}/bin/${bin}`
        const session = {
            async exec(command: string) {
                if (command.includes('--version')) {
                    return {
                        exitCode: 0,
                        stdout: `${bin} smoke-version\n`,
                        stderr: '',
                        timedOut: false
                    }
                }
                return {
                    exitCode: 0,
                    stdout: `${executable}\n`,
                    stderr: '',
                    timedOut: false
                }
            }
        }
        const result = await adapter.detect(session as any)
        assert.equal(result.installed, true, adapter.kind)
        assert.equal(result.path, executable, adapter.kind)
        assert.equal(result.version, `${bin} smoke-version`, adapter.kind)
    }
})

test('builds fixed user-scope maintenance plans and compares agent versions', () => {
    assert.equal(normalizeAgentVersion('Hermes Agent v0.18.0 (2026.7.1)'), '0.18.0')
    assert.equal(normalizeAgentVersion('2.1.205 (Claude Code)'), '2.1.205')
    assert.equal(isVersionNewer('2.1.205', '2.1.214'), true)
    assert.equal(isVersionNewer('1.18.3', '1.18.3'), false)

    const codex = buildAgentMaintenancePlan('codex', false)
    assert.equal(codex.action, 'install')
    assert.match(codex.command, /npm_config_prefix="\$HOME\/\.local"/)
    assert.match(codex.command, /'@openai\/codex@latest'/)
    assert.doesNotMatch(codex.command, /sudo/)

    const claude = buildAgentMaintenancePlan(
        'claude',
        true,
        '/home/lumia/.local/bin/claude'
    )
    assert.equal(claude.action, 'update')
    assert.equal(
        claude.command,
        "'/home/lumia/.local/bin/claude' update"
    )

    const hermes = buildAgentMaintenancePlan('hermes', false)
    assert.match(
        hermes.command,
        /https:\/\/hermes-agent\.nousresearch\.com\/install\.sh/
    )
})

test('parses interactive SSH environment markers and removes volatile variables', () => {
    const begin = '__BEGIN__'
    const end = '__END__'
    const parsed = parseEnvironmentProbe(
        `banner\r\n${begin}\r\nHOME=/home/lumia\r\nPATH=/custom/bin:/usr/bin\r\nSHELL=/bin/zsh\r\nOPENAI_API_KEY=secret\r\n${end}\r\n`,
        begin,
        end
    )
    const filtered = filterRemoteEnvironment(parsed)
    assert.equal(filtered.HOME, '/home/lumia')
    assert.equal(filtered.SHELL, '/bin/zsh')
    assert.equal(filtered.OPENAI_API_KEY, undefined)
    const pathValue = enrichPath('~/.local/bin:/usr/bin', '/home/lumia')
    assert.doesNotMatch(pathValue, /~/)
    assert.equal(pathValue.split(':')[0], '/home/lumia/.local/bin')
})

test('SFTP file manager confines paths to the configured remote root', async () => {
    const directoryStats = {
        size: 0,
        mode: 0o40755,
        mtime: 1,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false
    }
    const fakeSession = {
        cwd: '/home/lumia/work',
        resolveRemotePath(value: string) {
            return value
        },
        async realpath(value: string) {
            return value.replace('/home/lumia/work/../..', '')
        },
        async stat() {
            return directoryStats
        },
        async listDirectory() {
            return []
        }
    }
    const manager = await SftpFileManager.create(
        fakeSession as any,
        'host-computer',
        '/home/lumia/work',
        { maxUploadBytes: 1024, maxPreviewBytes: 128 }
    )
    const listing = await manager.list()
    assert.equal(listing.root, '/home/lumia/work')
    await assert.rejects(
        manager.preview('/home/lumia/work/../../etc/passwd'),
        /超出文件管理根目录/
    )
    await assert.rejects(
        manager.createDirectory('/home/lumia/work', 'trailing '),
        /文件名无效/
    )
    await assert.rejects(manager.remove('/home/lumia/work'), /不能修改或删除/)
})
