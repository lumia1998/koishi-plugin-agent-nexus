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
import { mimeType } from '../src/utils/mime.ts'
import { SshSession } from '../src/ssh/session.ts'
import { terminalMessageSize } from '../src/proxy.ts'

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
