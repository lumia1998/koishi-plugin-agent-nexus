import { Schema } from 'koishi'
import type {
    DelegationAgentConfig,
    GatewayRemoteConfig,
    NexusConfig
} from './types'
import { PRIMARY_GATEWAY_ID } from './types'
import { validateGatewayUrl } from './gateway/client'

export const name = 'agent-nexus'

export interface ArtifactCacheConfig {
    enabled: boolean
    ttlHours: number
    maxTotalBytes: number
}

export interface Config {
    gatewayUrl: string
    gatewayKey: string
    commandAuthority: number
    maxResponseBytes: number
    artifactCache: ArtifactCacheConfig
}

export const Config: Schema<Config> = Schema.object({
    gatewayUrl: Schema.string()
        .default('http://127.0.0.1:8787')
        .description('Nexus Gateway 地址；填写 Gateway 所在机器的局域网地址'),
    gatewayKey: Schema.string()
        .role('secret')
        .default('')
        .description('在 Nexus Gateway 管理页生成的 API Key（不是控制台密码）'),
    commandAuthority: Schema.number()
        .min(1)
        .max(5)
        .default(4)
        .description('AgentNexus Console 管理操作所需权限等级'),
    maxResponseBytes: Schema.number()
        .min(1048576)
        .max(268435456)
        .default(32 * 1024 * 1024)
        .description('单个 Gateway HTTP 响应或 SSE 事件帧允许读取的最大字节数'),
    artifactCache: Schema.object({
        enabled: Schema.boolean()
            .default(true)
            .description('把产物缓存到本地磁盘，控制台直接从本地读取；关闭后每次预览都会回源 Gateway'),
        ttlHours: Schema.number()
            .min(1)
            .max(24 * 365)
            .default(72)
            .description('产物缓存保留时长（小时），按最后访问时间计算'),
        maxTotalBytes: Schema.number()
            .min(16 * 1024 * 1024)
            .max(1024 * 1024 * 1024 * 1024)
            .default(2 * 1024 * 1024 * 1024)
            .description('产物缓存目录总容量上限（字节），超出后按最久未访问淘汰')
    }).description('产物本地缓存与清理策略')
})

export function createDefaultNexusConfig(): NexusConfig {
    return { delegation: { agents: [] } }
}

/**
 * Loads the compact configuration and salvages Gateway overrides from the
 * previous A2A/multi-Gateway shape. Connection secrets remain plugin settings.
 */
export function normalizeStoredNexusConfig(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('AgentNexus config root must be an object')
    }
    const delegation = optionalRecord(value.delegation, 'delegation')
    const rawAgents = optionalArray(delegation?.agents, 'delegation.agents')
    const agents = new Map<string, DelegationAgentConfig>()
    let droppedAgents = 0
    for (const value of rawAgents) {
        const agent = sanitizeDelegationAgent(value)
        if (!agent) {
            droppedAgents += 1
            continue
        }
        agents.set(agent.agentId, agent)
    }
    const legacyKeys = [
        'a2a',
        'gateway',
        'hosts',
        'agents',
        'skills',
        'skillRoot',
        'defaultHostId'
    ]
    const removedLegacy = legacyKeys.some((key) => Object.hasOwn(value, key))
    const config: NexusConfig = {
        delegation: { agents: Array.from(agents.values()) }
    }
    const changed =
        removedLegacy ||
        !delegation ||
        delegation.agents === undefined ||
        droppedAgents > 0 ||
        rawAgents.some(
            (item) =>
                isRecord(item) &&
                ['id', 'provider', 'remoteId', 'managedHostId'].some((key) =>
                    Object.hasOwn(item, key)
                )
        )
    return { config, changed, removedLegacy, droppedAgents }
}

export function createGatewayConnection(plugin: Config): GatewayRemoteConfig {
    const key = plugin.gatewayKey.trim()
    return {
        id: PRIMARY_GATEWAY_ID,
        name: 'Nexus Gateway',
        baseUrl: validateGatewayUrl(
            plugin.gatewayUrl.trim() || 'http://127.0.0.1:8787'
        ),
        authToken: key || undefined,
        enabled: Boolean(key)
    }
}

function sanitizeDelegationAgent(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('Delegation agent must be an object')
    }
    if (value.provider !== undefined && value.provider !== 'gateway') {
        return undefined
    }
    const agentId = text(value.agentId)
    if (!agentId) return undefined
    return {
        agentId,
        name: text(value.name) || agentId,
        enabled: value.enabled !== false,
        workspace: optionalText(value.workspace),
        description: optionalText(value.description),
        skills: Array.isArray(value.skills)
            ? value.skills.map(text).filter(Boolean)
            : undefined
    } satisfies DelegationAgentConfig
}

function optionalRecord(value: unknown, name: string) {
    if (value === undefined) return undefined
    if (!isRecord(value)) throw new Error(`AgentNexus config ${name} must be an object`)
    return value
}

function optionalArray(value: unknown, name: string) {
    if (value === undefined) return [] as unknown[]
    if (!Array.isArray(value)) throw new Error(`AgentNexus config ${name} must be an array`)
    return value
}

function text(value: unknown) {
    return typeof value === 'string' ? value.trim() : ''
}

function optionalText(value: unknown) {
    return text(value) || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
