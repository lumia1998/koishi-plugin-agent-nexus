import type { AgentEnableConfig, SshBridgeConfig } from '../types'

export function defaultSshBridgeConfig(): SshBridgeConfig {
    return {
        enabled: false,
        bindHost: '0.0.0.0',
        port: 8787,
        publicBaseUrl: '',
        token: '',
        dataDir: '~/.agent-nexus/bridge',
        cwd: '',
        packageSpec: 'local',
        agents: defaultBridgeAgents()
    }
}

export function normalizeSshBridgeConfig(
    input?: Partial<SshBridgeConfig>
): SshBridgeConfig {
    const defaults = defaultSshBridgeConfig()
    return {
        ...defaults,
        ...(input || {}),
        enabled: input?.enabled ?? defaults.enabled,
        bindHost: input?.bindHost?.trim() || defaults.bindHost,
        port:
            Number.isSafeInteger(Number(input?.port)) &&
            Number(input?.port) > 0 &&
            Number(input?.port) <= 65535
                ? Number(input?.port)
                : defaults.port,
        publicBaseUrl: input?.publicBaseUrl?.trim() || '',
        token: input?.token?.trim() || '',
        dataDir: input?.dataDir?.trim() || defaults.dataDir,
        cwd: input?.cwd?.trim() || '',
        packageSpec: input?.packageSpec?.trim() || defaults.packageSpec,
        agents: {
            ...defaults.agents,
            ...(input?.agents || {})
        },
        remoteId: input?.remoteId?.trim() || undefined
    }
}

function defaultBridgeAgents(): AgentEnableConfig {
    return {
        hermes: true,
        openclaw: true,
        claude: true,
        opencode: true,
        codex: true,
        pi: true
    }
}
