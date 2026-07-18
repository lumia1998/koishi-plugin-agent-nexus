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
    commandAuthority: number
    maxConcurrentPerHost: number
    maxConcurrentPerUser: number
    interactiveSessionTtlMs: number
    sessionHistoryRetentionMs: number
    sessionSummaryEnabled: boolean
    sessionSummaryModel: string
    sessionSummaryMaxInputChars: number
    maxOutputBytes: number
    fileManagerMaxUploadBytes: number
    fileManagerMaxPreviewBytes: number
    commandUsers: string[]
    commandChannels: string[]
}

export const Config: Schema<Config> = Schema.object({
    defaultTimeoutMs: Schema.number()
        .default(600000)
        .description('委托执行默认超时（毫秒）'),
    skillRoot: Schema.string()
        .default('~/.agent-nexus/skills')
        .description('远端 skills 中心目录（相对远端 home 时用 ~）'),
    commandAuthority: Schema.number()
        .min(1)
        .max(5)
        .default(4)
        .description('直接调用 nexus.* 命令所需权限等级'),
    maxConcurrentPerHost: Schema.number()
        .min(1)
        .max(16)
        .default(2)
        .description('每台 SSH 主机允许同时执行的 Agent 任务数'),
    maxConcurrentPerUser: Schema.number()
        .min(1)
        .max(8)
        .default(1)
        .description('每个用户允许同时执行的直接命令数'),
    interactiveSessionTtlMs: Schema.number()
        .min(60000)
        .max(86400000)
        .default(15 * 60 * 1000)
        .description('交互模式空闲超时（毫秒）；超时后自动退出'),
    sessionHistoryRetentionMs: Schema.number()
        .min(24 * 60 * 60 * 1000)
        .max(365 * 24 * 60 * 60 * 1000)
        .default(30 * 24 * 60 * 60 * 1000)
        .description('历史会话保留时间（毫秒）'),
    sessionSummaryEnabled: Schema.boolean()
        .default(true)
        .description('会话结束后使用 ChatLuna 默认模型生成标题和摘要'),
    sessionSummaryModel: Schema.string()
        .default('')
        .description('摘要模型；留空使用 ChatLuna 默认模型'),
    sessionSummaryMaxInputChars: Schema.number()
        .min(1000)
        .max(100000)
        .default(12000)
        .description('单次会话摘要最多发送给模型的字符数'),
    maxOutputBytes: Schema.number()
        .min(65536)
        .max(67108864)
        .default(4194304)
        .description('单次 SSH 命令 stdout/stderr 最大捕获字节数'),
    fileManagerMaxUploadBytes: Schema.number()
        .min(1048576)
        .max(268435456)
        .default(32 * 1024 * 1024)
        .description('SFTP 文件管理单文件上传上限（字节）'),
    fileManagerMaxPreviewBytes: Schema.number()
        .min(65536)
        .max(8388608)
        .default(1024 * 1024)
        .description('SFTP 文件预览最大读取字节数'),
    commandUsers: Schema.array(String)
        .default([])
        .description('允许调用 nexus.* 的用户 ID 白名单；留空表示只检查权限等级'),
    commandChannels: Schema.array(String)
        .default([])
        .description('允许调用 nexus.* 的频道 ID 白名单；留空表示不限制频道')
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
