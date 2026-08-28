import { Schema } from 'koishi'
import type {
    DelegationAgentConfig,
    GatewayRemoteConfig,
    NexusConfig
} from './types'
import { PRIMARY_GATEWAY_ID } from './types'
import { validateGatewayUrl } from './gateway/client'

export const name = 'agent-nexus'

export interface Config {
    gatewayUrl: string
    gatewayKey: string
    commandAuthority: number
    maxResponseBytes: number
    /** Automatically route the original user's next message to a pending job. */
    autoResumePending?: boolean
    /** Keep @bot required for pending replies in group chats. */
    pendingRequireMention?: boolean
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
        .description('单个 Gateway HTTP 或 SSE 响应允许读取的最大字节数'),
    autoResumePending: Schema.boolean()
        .default(true)
        .description('任务等待用户输入时，自动把原用户下一条消息继续发送给同一 Agent'),
    pendingRequireMention: Schema.boolean()
        .default(false)
        .description('群聊中继续等待任务是否仍要求 @Bot；关闭后原用户可直接回复“第一个/支付完成”')
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
