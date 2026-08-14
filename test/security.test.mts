import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
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
import { PiAdapter } from '../src/adapters/pi.ts'
import { linkSkillToAgents, syncSkillSource } from '../src/skills/sync.ts'
import { resolveSecret } from '../src/utils/shell.ts'
import {
    assertUniqueHostName,
    mergeA2ASecrets,
    mergeGatewaySecrets,
    mergeHostSecrets,
    patchHostConfig,
    redactA2AConfig,
    redactGatewayConfig,
    redactNexusConfig,
    repairHostIds,
    resolveHostReference
} from '../src/utils/config.ts'
import { createId } from '../client/utils/id.ts'
import {
    buildAgentMaintenancePlan,
} from '../src/agents/maintenance.ts'
import { mimeType } from '../src/utils/mime.ts'
import { SshSession } from '../src/ssh/session.ts'
import {
    formatHostKeyFingerprint,
    normalizeHostKeyFingerprint,
    verifySshHostKey
} from '../src/ssh/host-key.ts'
import {
    enrichPath,
    filterRemoteEnvironment,
    parseEnvironmentProbe
} from '../src/ssh/session.ts'
import { terminalMessageSize } from '../src/proxy.ts'
import { SftpFileManager } from '../src/files/manager.ts'

test('pins and verifies SSH SHA-256 host keys', () => {
    const hash = 'ab'.repeat(32)
    const fingerprint = formatHostKeyFingerprint(hash)
    assert.match(fingerprint, /^SHA256:/)
    assert.equal(normalizeHostKeyFingerprint(fingerprint), hash)

    assert.deepEqual(verifySshHostKey(hash, undefined, 'accept-new'), {
        accepted: true,
        fingerprint,
        learned: true
    })
    assert.equal(
        verifySshHostKey(hash, undefined, 'strict').accepted,
        false
    )
    assert.equal(
        verifySshHostKey(hash, fingerprint, 'strict').accepted,
        true
    )
    const mismatch = verifySshHostKey('cd'.repeat(32), fingerprint, 'strict')
    assert.equal(mismatch.accepted, false)
    assert.match(mismatch.error || '', /mismatch/i)
})

test('creates UUIDs without crypto.randomUUID for LAN HTTP consoles', () => {
    const id = createId({
        getRandomValues(array) {
            array.fill(10)
            return array
        }
    })
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('keeps A2A configuration client-only while preserving remote secrets', () => {
    const previous = {
        remotes: [
            {
                id: 'remote-1',
                name: 'OpenCode',
                baseUrl: 'http://10.1.2.50:9101',
                authToken: 'TOKEN',
                enabled: true
            }
        ]
    }
    const merged = mergeA2ASecrets(
        {
            remotes: [
                {
                    ...previous.remotes[0],
                    authToken: ''
                }
            ]
        },
        previous
    )

    assert.deepEqual(Object.keys(merged), ['remotes'])
    assert.equal(merged.remotes[0].authToken, 'TOKEN')
    assert.equal(redactA2AConfig(merged).remotes[0].authToken, '')
})

test('keeps Gateway tokens server-side while preserving blank edits', () => {
    const previous = {
        remotes: [
            {
                id: 'gateway-1',
                name: 'dev-server',
                baseUrl: 'http://10.1.2.40:8787',
                authToken: 'TOKEN',
                enabled: true
            }
        ]
    }
    const merged = mergeGatewaySecrets(
        {
            remotes: [
                {
                    ...previous.remotes[0],
                    authToken: ''
                }
            ]
        },
        previous
    )

    assert.equal(merged.remotes[0].authToken, 'TOKEN')
    assert.equal(redactGatewayConfig(merged).remotes[0].authToken, '')
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
    assert.throws(() => validateRepoUrl('http://example.com/repo.git'))
    assert.throws(() => validateRepoUrl('file:///srv/private/repo'))
    assert.throws(() => validateRepoUrl('/srv/private/repo'))
    assert.equal(
        validateRepoUrl('https://example.com/team/repo.git'),
        'https://example.com/team/repo.git'
    )
    assert.equal(
        validateRepoUrl('ssh://git@example.com/team/repo.git'),
        'ssh://git@example.com/team/repo.git'
    )
    assert.equal(validateRepoUrl('git@example.com:team/repo.git'), 'git@example.com:team/repo.git')
})

test('confines remote files to the configured root', () => {
    assert.equal(isRemotePathWithinRoot('/home/agent/out/a.png', '/home/agent/out'), true)
    assert.equal(isRemotePathWithinRoot('/home/agent/out/../.ssh/id_rsa', '/home/agent/out'), false)
    assert.equal(isRemotePathWithinRoot('/etc/passwd', '/home/agent'), false)
    assert.equal(isRemotePathWithinRoot('/etc/passwd', '/'), true)
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
        agents: {
            hermes: true,
            openclaw: true,
            claude: true,
            opencode: true,
            codex: true,
            pi: true
        },
        a2a: { remotes: [] }
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
    assert.doesNotMatch(command, /\|\| git clone/)
    assert.match(command, /remote get-url origin/)
})

test('refuses to replace a real agent skill directory with a symlink', async () => {
    let command = ''
    const session = {
        async exec(value: string) {
            command = value
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        }
    }
    assert.deepEqual(
        await linkSkillToAgents(
            session as never,
            '/home/agent/.agent-nexus/skills/demo',
            'demo',
            ['claude']
        ),
        ['claude']
    )
    assert.match(command, /Refusing to replace non-symlink skill/)
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
        agents: {
            hermes: true,
            openclaw: true,
            claude: true,
            opencode: true,
            codex: true,
            pi: true
        },
        a2a: { remotes: [] }
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

test('rejects oversized SSH asset reads before opening a stream', async () => {
    const session = sshSession()
    let opened = false
    ;(session as any).getSftp = async () => ({
        createReadStream() {
            opened = true
            return new EventEmitter()
        }
    })
    ;(session as any).stat = async () => ({
        size: 5,
        isFile: () => true
    })
    await assert.rejects(() => session.openAsset('/tmp/large.bin', 4), /read limit/)
    assert.equal(opened, false)
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
    const calls: string[] = []
    const session = {
        async exec(command: string) {
            calls.push(command)
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
    assert.equal(result.scanned, true)
    assert.equal(calls.some((command) => command.includes('--version')), false)
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

test('keeps stdout capacity when stderr reaches its own output limit', async () => {
    const session = sshSession(5)
    ;(session as any).client = {
        exec(_command: string, callback: (err: Error | undefined, channel: any) => void) {
            const channel = new EventEmitter() as any
            channel.stderr = new EventEmitter()
            channel.signal = () => undefined
            channel.close = () => undefined
            callback(undefined, channel)
            channel.stderr.emit('data', Buffer.from('errors'))
            channel.emit('data', Buffer.from('reply'))
            channel.emit('close', 0, '')
        }
    }
    const result = await session.exec('echo test')
    assert.equal(result.stderr, 'error')
    assert.equal(result.stdout, 'reply')
    assert.equal(result.truncated, true)
})

test('detects every supported agent through the shared SSH probe', async () => {
    const adapters = [
        new HermesAdapter(),
        new OpenClawAdapter(),
        new ClaudeAdapter(),
        new OpenCodeAdapter(),
        new CodexAdapter(),
        new PiAdapter()
    ]
    for (const adapter of adapters) {
        const bin = adapter.binNames[0]
        const executable = `/home/lumia/.${adapter.kind}/bin/${bin}`
        const calls: string[] = []
        const session = {
            async exec(command: string) {
                calls.push(command)
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
        assert.equal(result.scanned, true, adapter.kind)
        assert.equal(
            calls.some((command) => command.includes('--version')),
            false,
            adapter.kind
        )
    }
})

test('builds install-only maintenance plans without registry version checks', () => {
    const codex = buildAgentMaintenancePlan('codex', false)
    assert.equal(codex.action, 'install')
    assert.match(codex.command, /npm_config_prefix="\$HOME\/\.local"/)
    assert.match(codex.command, /'@openai\/codex'/)
    assert.doesNotMatch(codex.command, /sudo/)

    const claudeInstall = buildAgentMaintenancePlan('claude', false)
    assert.match(claudeInstall.command, /'@anthropic-ai\/claude-code'/)
    assert.doesNotMatch(claudeInstall.command, /claude\.ai\/install/)

    const opencodeInstall = buildAgentMaintenancePlan('opencode', false)
    assert.match(opencodeInstall.command, /'opencode-ai'/)
    assert.doesNotMatch(opencodeInstall.command, /opencode\.ai\/install/)

    assert.throws(
        () => buildAgentMaintenancePlan('claude', true),
        /只提供安装，不提供更新/
    )

    const hermes = buildAgentMaintenancePlan('hermes', false)
    assert.match(
        hermes.command,
        /https:\/\/hermes-agent\.nousresearch\.com\/install\.sh/
    )
    assert.match(hermes.command, /--proto '=https'/)
    assert.match(hermes.command, /installer download exceeds 2 MB/)
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
