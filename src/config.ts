import { Schema } from 'koishi'
import { randomUUID } from 'crypto'
import type {
    AgentEnableConfig,
    AgentRuntimeOptions,
    NexusConfig,
    SshHostConfig
} from './types'

export const name = 'agent-nexus'

export interface Config {
    defaultTimeoutMs: number
    skillRoot: string
}

export const Config: Schema<Config> = Schema.object({
    defaultTimeoutMs: Schema.number()
        .default(600000)
        .description('委托执行默认超时（毫秒）'),
    skillRoot: Schema.string()
        .default('~/.agent-nexus/skills')
        .description('远端 skills 中心目录（相对远端 home 时用 ~）')
})

export function createDefaultNexusConfig(cfg?: Config): NexusConfig {
    return {
        hosts: [],
        agents: {
            hermes: true,
            openclaw: true,
            claude: true,
            opencode: true,
            codex: true
        },
        runtime: {
            openclawAgent: 'default',
            claudeSkipPermissions: true,
            codexBypassSandbox: true,
            opencodeAuto: true,
            defaultTimeoutMs: cfg?.defaultTimeoutMs ?? 600000
        },
        skills: [],
        skillRoot: cfg?.skillRoot ?? '~/.agent-nexus/skills',
        defaultHostId: undefined
    }
}

export function createHost(partial?: Partial<SshHostConfig>): SshHostConfig {
    return {
        id: partial?.id ?? randomUUID(),
        name: partial?.name ?? 'default',
        host: partial?.host ?? '127.0.0.1',
        port: partial?.port ?? 22,
        username: partial?.username ?? 'root',
        auth: partial?.auth ?? { type: 'password', password: '' },
        enabled: partial?.enabled ?? true,
        defaultAgent: partial?.defaultAgent ?? 'auto',
        cwd: partial?.cwd,
        idleTimeoutMs: partial?.idleTimeoutMs ?? 15 * 60 * 1000
    }
}

export function defaultAgents(): AgentEnableConfig {
    return {
        hermes: true,
        openclaw: true,
        claude: true,
        opencode: true,
        codex: true
    }
}

export function defaultRuntime(timeout = 600000): AgentRuntimeOptions {
    return {
        openclawAgent: 'default',
        claudeSkipPermissions: true,
        codexBypassSandbox: true,
        opencodeAuto: true,
        defaultTimeoutMs: timeout
    }
}
