import assert from 'node:assert/strict'
import test from 'node:test'
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
import { OpenCodeAdapter } from '../src/adapters/opencode.ts'
import { syncSkillSource } from '../src/skills/sync.ts'
import { resolveSecret } from '../src/utils/shell.ts'
import { mergeHostSecrets, redactNexusConfig } from '../src/utils/config.ts'

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
