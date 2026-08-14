import { Schema } from 'koishi'
import { randomUUID } from 'crypto'
import type {
    NexusConfig,
    SshHostConfig
} from './types'
import { normalizeHostKeyPolicy } from './ssh/host-key'

export const name = 'agent-nexus'

export interface Config {
    skillRoot: string
    commandAuthority: number
    maxOutputBytes: number
    a2aMaxResponseBytes: number
    fileManagerMaxUploadBytes: number
    fileManagerMaxPreviewBytes: number
}

export const Config: Schema<Config> = Schema.object({
    skillRoot: Schema.string()
        .default('~/.agent-nexus/skills')
        .description('远端 skills 中心目录（相对远端 home 时用 ~）'),
    commandAuthority: Schema.number()
        .min(1)
        .max(5)
        .default(4)
        .description('AgentNexus Console 管理操作所需权限等级'),
    maxOutputBytes: Schema.number()
        .min(65536)
        .max(67108864)
        .default(4194304)
        .description('单次 SSH 命令 stdout/stderr 最大捕获字节数'),
    a2aMaxResponseBytes: Schema.number()
        .min(1048576)
        .max(268435456)
        .default(32 * 1024 * 1024)
        .description('单个 A2A HTTP/SSE 响应允许读取的最大字节数'),
    fileManagerMaxUploadBytes: Schema.number()
        .min(1048576)
        .max(268435456)
        .default(32 * 1024 * 1024)
        .description('SFTP 文件管理单文件上传上限（字节）'),
    fileManagerMaxPreviewBytes: Schema.number()
        .min(65536)
        .max(8388608)
        .default(1024 * 1024)
        .description('SFTP 文件预览最大读取字节数')
})

export function createDefaultNexusConfig(cfg?: Config): NexusConfig {
    return {
        hosts: [],
        agents: {
            hermes: true,
            openclaw: true,
            claude: true,
            opencode: true,
            codex: true,
            pi: true
        },
        skills: [],
        skillRoot: cfg?.skillRoot ?? '~/.agent-nexus/skills',
        defaultHostId: undefined,
        a2a: {
            remotes: []
        },
        gateway: {
            remotes: []
        },
        delegation: {
            agents: []
        }
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
        hostKeyPolicy: normalizeHostKeyPolicy(partial?.hostKeyPolicy),
        hostKeyFingerprint: partial?.hostKeyFingerprint?.trim() || undefined,
        enabled: partial?.enabled ?? true,
        cwd: partial?.cwd,
        idleTimeoutMs: partial?.idleTimeoutMs ?? 15 * 60 * 1000
    }
}
