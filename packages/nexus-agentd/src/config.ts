import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
    agentdDriverKinds,
    type AgentdConfig,
    type AgentdDriverConfig,
    type AgentdDriverKind
} from './types.js'

export async function loadAgentdConfig(filePath: string): Promise<AgentdConfig> {
    const absolute = path.resolve(filePath)
    const raw = await readFile(absolute, 'utf8')
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch (error) {
        throw new Error(
            `Invalid nexus-agentd config JSON: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    if (!isRecord(value)) throw new Error('nexus-agentd config root must be an object')
    const listen = isRecord(value.listen) ? value.listen : {}
    const host = stringValue(listen.host) || '127.0.0.1'
    const port = numberValue(listen.port, 8787, 1, 65535)
    const authToken = resolveSecret(stringValue(value.authToken))
    if (!authToken) throw new Error('nexus-agentd authToken is required')
    const workspaceRoots = arrayOfStrings(value.workspaceRoots)
    if (!workspaceRoots.length) {
        throw new Error('nexus-agentd workspaceRoots must contain at least one path')
    }
    if (!isRecord(value.agents)) {
        throw new Error('nexus-agentd agents must be an object')
    }
    const agents: Record<string, AgentdDriverConfig> = {}
    for (const [id, input] of Object.entries(value.agents)) {
        if (!isRecord(input)) throw new Error(`Agent config must be an object: ${id}`)
        const driver = stringValue(input.driver) || inferDriver(id)
        if (!isAgentdDriverKind(driver)) {
            throw new Error(`Unsupported nexus-agentd driver: ${driver || id}`)
        }
        const permissionPolicy = stringValue(input.permissionPolicy) || 'ask'
        if (permissionPolicy !== 'ask' && permissionPolicy !== 'deny') {
            throw new Error(`Invalid permissionPolicy for ${id}`)
        }
        agents[id] = {
            driver,
            name: optionalString(input.name),
            description: optionalString(input.description),
            enabled: input.enabled !== false,
            command: optionalString(input.command),
            args: input.args === undefined ? undefined : arrayOfStrings(input.args),
            inheritEnv:
                input.inheritEnv === undefined
                    ? undefined
                    : arrayOfStrings(input.inheritEnv),
            env: recordOfStrings(input.env),
            permissionPolicy,
            permissionTimeoutMs: numberValue(
                input.permissionTimeoutMs,
                15 * 60 * 1000,
                1000,
                24 * 60 * 60 * 1000
            )
        }
    }
    return {
        listen: { host, port },
        authToken,
        workspaceRoots,
        maxRequestBytes: numberValue(
            value.maxRequestBytes,
            1024 * 1024,
            1024,
            16 * 1024 * 1024
        ),
        maxEventsPerSession: numberValue(
            value.maxEventsPerSession,
            2048,
            64,
            100_000
        ),
        maxOutputChars: numberValue(
            value.maxOutputChars,
            512 * 1024,
            16 * 1024,
            16 * 1024 * 1024
        ),
        sessionTtlMs: numberValue(
            value.sessionTtlMs,
            24 * 60 * 60 * 1000,
            60_000,
            30 * 24 * 60 * 60 * 1000
        ),
        agents
    }
}

export function resolveSecret(value: string) {
    if (!value.startsWith('env:')) return value
    const name = value.slice(4).trim()
    if (!name) throw new Error('Secret environment variable name is empty')
    const secret = process.env[name]
    if (!secret) throw new Error(`Secret environment variable is missing: ${name}`)
    return secret
}

function inferDriver(id: string) {
    const value = id.trim().toLowerCase()
    return isAgentdDriverKind(value) ? value : ''
}

function isAgentdDriverKind(value: string): value is AgentdDriverKind {
    return (agentdDriverKinds as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringValue(value: unknown) {
    return typeof value === 'string' ? value.trim() : ''
}

function optionalString(value: unknown) {
    return stringValue(value) || undefined
}

function arrayOfStrings(value: unknown) {
    if (!Array.isArray(value)) return []
    return value.map(stringValue).filter(Boolean)
}

function recordOfStrings(value: unknown) {
    if (!isRecord(value)) return undefined
    const result: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') continue
        result[key] = item
    }
    return result
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
}
