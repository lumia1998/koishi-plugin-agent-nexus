import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildAgentdConfig,
    buildHealthCheckScript,
    buildAgentdInstallCommand,
    buildNpmCacheCleanupCommand,
    buildServicePrivilegeCommand,
    buildAgentdSystemdUnit,
    deployNexusAgentdRemote,
    normalizeAgentdAgents,
    validateAgentdPort
} from '../src/agentd/deployment.ts'

test('builds an install-only agentd plan from fixed package names', () => {
    const command = buildAgentdInstallCommand(['opencode', 'claude', 'codex', 'pi'])
    assert.match(command, /command -v 'nexus-agentd'/)
    assert.match(command, /'nexus-agentd'/)
    assert.match(command, /'@agentclientprotocol\/claude-agent-acp'/)
    assert.match(command, /'@agentclientprotocol\/codex-acp'/)
    assert.match(command, /'pi-acp'/)
    assert.equal(command.match(/npm install/g)?.length, 1)
    assert.match(command, /npm_config_fetch_timeout=45000/)
    assert.doesNotMatch(command, /npm view|outdated|update|upgrade/)
    assert.doesNotMatch(command, /opencode-ai|@openai\/codex|@anthropic-ai\/claude-code/)
})

test('builds a syntactically separated systemd privilege probe', () => {
    const command = buildServicePrivilegeCommand()
    assert.match(command, /then\n\s+printf system-root/)
    assert.match(command, /system-sudo\nelif/)
    assert.doesNotMatch(command, /then printf/)
})

test('builds a syntactically valid agentd health check script', () => {
    const script = buildHealthCheckScript(8787)
    assert.doesNotThrow(() => new Function(script))
    assert.match(script, /http:\/\/127\.0\.0\.1:8787\/health/)
    assert.match(script, /Date\.now\(\) \+ 15000/)
    assert.match(script, /setTimeout\(resolve, 500\)/)
})

test('only removes the validated npm cache when recovering from ENOSPC', () => {
    const command = buildNpmCacheCleanupCommand()
    assert.match(command, /readlink -f "\$HOME\/\.npm\/_cacache"/)
    assert.match(command, /"\$cache" = "\$HOME\/\.npm\/_cacache"/)
    assert.match(command, /rm -rf -- "\$cache"/)
    assert.doesNotMatch(command, /\.npm\/_npx|\.cache\/Homebrew/)
})

test('generates an env-token config and hardened systemd unit', () => {
    const config = JSON.parse(
        buildAgentdConfig(8787, ['/data/repos'], ['opencode', 'pi'])
    )
    assert.equal(config.listen.host, '0.0.0.0')
    assert.equal(config.authToken, 'env:NEXUS_AGENTD_TOKEN')
    assert.deepEqual(Object.keys(config.agents), ['opencode', 'pi'])
    assert.equal(config.agents.opencode.permissionPolicy, 'ask')

    const unit = buildAgentdSystemdUnit({
        mode: 'system',
        username: 'agent',
        home: '/home/agent',
        environmentPath: '/home/agent/.config/agent-nexus/nexus-agentd.env',
        launcherPath: '/home/agent/.config/agent-nexus/nexus-agentd-launcher.sh'
    })
    assert.match(unit, /^User=agent$/m)
    assert.match(unit, /^WorkingDirectory=\/home\/agent$/m)
    assert.match(
        unit,
        /^EnvironmentFile=\/home\/agent\/\.config\/agent-nexus\/nexus-agentd\.env$/m
    )
    assert.match(
        unit,
        /^ExecStart=\/home\/agent\/\.config\/agent-nexus\/nexus-agentd-launcher\.sh$/m
    )
    assert.match(unit, /^UMask=0077$/m)
    assert.doesNotMatch(unit, /TOKEN|Bearer/)
})

test('validates agentd deployment choices before building shell commands', () => {
    assert.equal(validateAgentdPort(8787), 8787)
    assert.throws(() => validateAgentdPort(0), /1 到 65535/)
    assert.deepEqual(normalizeAgentdAgents(['pi', 'pi', 'opencode']), [
        'pi',
        'opencode'
    ])
    assert.throws(
        () => normalizeAgentdAgents(['hermes' as never]),
        /不支持的 ACP Agent/
    )
})

test('deploys agentd without placing its token in SSH commands', async () => {
    const commands: string[] = []
    const writes: Array<{ path: string; content: string; mode?: number }> = []
    const phases: string[] = []
    const token = 't'.repeat(43)
    const session = {
        environmentInfo: {
            home: '/home/agent',
            source: 'interactive',
            pathEntries: 3,
            variables: 3
        },
        serviceEnvironment: {
            HOME: '/home/agent',
            PATH: '/home/agent/.local/bin:/usr/bin:/bin',
            SHELL: '/bin/bash',
            XDG_CONFIG_HOME: '/home/agent/.config',
            OPENAI_API_KEY: 'must-not-be-copied'
        },
        resolveRemotePath(value?: string) {
            if (!value || value === '~') return '/home/agent'
            if (value.startsWith('~/')) return `/home/agent/${value.slice(2)}`
            return value
        },
        async realpath(value: string) {
            return value
        },
        async stat() {
            return { isDirectory: () => true }
        },
        async exec(command: string) {
            commands.push(command)
            let stdout = ''
            if (command === 'uname -s') stdout = 'Linux\n'
            else if (command.includes('node -p')) stdout = '22.4.0\n'
            else if (command.includes('printf system-root')) stdout = 'system-root'
            else if (command === 'command -v nexus-agentd') {
                stdout = '/home/agent/.local/bin/nexus-agentd\n'
            } else if (command === 'printf %s "$PATH"') {
                stdout = '/home/agent/.local/bin:/usr/bin:/bin'
            } else if (command === 'id -un') stdout = 'agent\n'
            return {
                exitCode: 0,
                stdout,
                stderr: '',
                timedOut: false,
                truncated: false
            }
        },
        async writeFile(path: string, content: string, mode?: number) {
            writes.push({ path, content, mode })
        },
        async replaceFile() {},
        async unlink() {}
    }

    const result = await deployNexusAgentdRemote(
        session as never,
        {
            port: 8787,
            workspaceRoots: ['/home/agent/projects'],
            agents: ['opencode', 'claude'],
            token
        },
        (phase) => phases.push(phase)
    )

    assert.equal(result.serviceMode, 'system')
    assert.deepEqual(result.workspaceRoots, ['/home/agent/projects'])
    assert.deepEqual(phases, [
        'checking',
        'workspace',
        'installing',
        'configuring',
        'starting',
        'verifying'
    ])
    assert.equal(commands.some((command) => command.includes(token)), false)

    const environment = writes.find((file) =>
        file.path.includes('nexus-agentd.env.tmp-')
    )
    const config = writes.find((file) =>
        file.path.includes('nexus-agentd.json.tmp-')
    )
    const unit = writes.find((file) => file.path.includes('.service.tmp-'))
        || writes.find((file) => file.path.includes('nexus-agentd-'))
    assert.equal(environment?.mode, 0o600)
    assert.match(environment?.content || '', new RegExp(token))
    assert.match(environment?.content || '', /^SHELL="\/bin\/bash"$/m)
    assert.match(
        environment?.content || '',
        /^XDG_CONFIG_HOME="\/home\/agent\/\.config"$/m
    )
    assert.doesNotMatch(environment?.content || '', /OPENAI_API_KEY|must-not-be-copied/)
    assert.equal(config?.mode, 0o600)
    assert.match(config?.content || '', /env:NEXUS_AGENTD_TOKEN/)
    assert.doesNotMatch(config?.content || '', new RegExp(token))
    assert.doesNotMatch(unit?.content || '', new RegExp(token))
})

test('includes systemd diagnostics when agentd startup fails', async () => {
    const session = {
        environmentInfo: {
            home: '/home/agent',
            source: 'interactive',
            pathEntries: 3,
            variables: 3
        },
        serviceEnvironment: {
            HOME: '/home/agent',
            PATH: '/home/agent/.local/bin:/usr/bin:/bin',
            SHELL: '/bin/bash'
        },
        resolveRemotePath(value?: string) {
            if (!value || value === '~') return '/home/agent'
            if (value.startsWith('~/')) return `/home/agent/${value.slice(2)}`
            return value
        },
        async realpath(value: string) {
            return value
        },
        async stat() {
            return { isDirectory: () => true }
        },
        async exec(command: string) {
            let stdout = ''
            let stderr = ''
            let exitCode = 0
            if (command === 'uname -s') stdout = 'Linux\n'
            else if (command.includes('node -p')) stdout = '22.4.0\n'
            else if (command.includes('printf system-root')) stdout = 'system-root'
            else if (command === 'command -v nexus-agentd') {
                stdout = '/home/agent/.local/bin/nexus-agentd\n'
            } else if (command === 'printf %s "$PATH"') {
                stdout = '/home/agent/.local/bin:/usr/bin:/bin'
            } else if (command === 'id -un') stdout = 'agent\n'
            else if (command.includes('systemctl restart nexus-agentd.service')) {
                exitCode = 1
                stderr = 'Job for nexus-agentd.service failed'
            } else if (command.includes('systemctl status nexus-agentd.service')) {
                stdout = 'Error: listen EADDRINUSE 0.0.0.0:8787\n'
            }
            return {
                exitCode,
                stdout,
                stderr,
                timedOut: false,
                truncated: false
            }
        },
        async writeFile() {},
        async replaceFile() {},
        async unlink() {}
    }

    await assert.rejects(
        () =>
            deployNexusAgentdRemote(session as never, {
                port: 8787,
                workspaceRoots: ['/home/agent/projects'],
                agents: ['opencode'],
                token: 't'.repeat(43)
            }),
        /EADDRINUSE/
    )
})
