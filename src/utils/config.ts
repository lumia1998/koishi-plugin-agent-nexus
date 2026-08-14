import type {
    A2AConfig,
    NexusConfig,
    SshAuth,
    SshHostConfig
} from '../types'
import { randomUUID } from 'crypto'

export function mergeHostSecrets(
    incoming: SshHostConfig,
    previous?: SshHostConfig
): SshHostConfig {
    if (!previous) return incoming
    let merged = incoming
    if (!incoming.auth || isEmptyAuth(incoming.auth)) {
        merged = {
            ...incoming,
            auth: previous.auth
        }
    } else if (incoming.auth.type !== previous.auth.type) {
        merged = incoming
    } else if (incoming.auth.type === 'password' && previous.auth.type === 'password') {
        merged = {
            ...incoming,
            auth: {
                type: 'password',
                password: incoming.auth.password || previous.auth.password
            }
        }
    } else if (incoming.auth.type === 'key' && previous.auth.type === 'key') {
        merged = {
            ...incoming,
            auth: {
                type: 'key',
                privateKey: incoming.auth.privateKey || previous.auth.privateKey,
                passphrase: incoming.auth.passphrase || previous.auth.passphrase
            }
        }
    }
    return merged
}

function isEmptyAuth(auth: SshAuth) {
    if (auth.type === 'password') return !auth.password
    return !auth.privateKey
}

export function redactNexusConfig(config: NexusConfig): NexusConfig {
    return {
        ...config,
        hosts: config.hosts.map((host) => ({
            ...host,
            auth:
                host.auth.type === 'password'
                    ? { type: 'password', password: '' }
                    : { type: 'key', privateKey: '' },
        })),
        a2a: redactA2AConfig(config.a2a)
    }
}

export function mergeA2ASecrets(
    incoming: A2AConfig,
    previous?: A2AConfig
): A2AConfig {
    const previousRemotes = new Map(
        (previous?.remotes || []).map((remote) => [remote.id, remote])
    )
    return {
        remotes: (incoming.remotes || []).map((remote) => {
            const old = previousRemotes.get(remote.id)
            return {
                ...remote,
                authToken: remote.authToken || old?.authToken
            }
        })
    }
}

export function redactA2AConfig(config?: A2AConfig): A2AConfig {
    const value = config || { remotes: [] }
    return {
        remotes: (value.remotes || []).map((remote) => ({
            ...remote,
            authToken: ''
        }))
    }
}

export function hostConnectionChanged(previous: SshHostConfig, next: SshHostConfig) {
    return (
        previous.host !== next.host ||
        previous.port !== next.port ||
        previous.username !== next.username ||
        previous.hostKeyPolicy !== next.hostKeyPolicy ||
        previous.hostKeyFingerprint !== next.hostKeyFingerprint ||
        previous.enabled !== next.enabled ||
        JSON.stringify(previous.auth) !== JSON.stringify(next.auth)
    )
}

export function repairHostIds(hosts: SshHostConfig[]) {
    const seen = new Set<string>()
    let changed = false
    const repaired = hosts.map((host) => {
        if (host.id && !seen.has(host.id)) {
            seen.add(host.id)
            return host
        }
        changed = true
        const id = randomUUID()
        seen.add(id)
        return { ...host, id }
    })
    return { hosts: repaired, changed }
}

export function normalizeHostName(name: string) {
    return name.trim()
}

export function assertUniqueHostName(
    hosts: SshHostConfig[],
    name: string,
    excludeId?: string
) {
    const normalized = normalizeHostName(name)
    if (!normalized) throw new Error('设备名称不能为空')
    const conflict = hosts.find(
        (host) =>
            host.id !== excludeId &&
            normalizeHostName(host.name).toLowerCase() === normalized.toLowerCase()
    )
    if (conflict) {
        throw new Error(`设备名称“${normalized}”已存在，请换一个唯一名称`)
    }
    return normalized
}

export function patchHostConfig(
    previous: SshHostConfig,
    input: Partial<SshHostConfig>
): SshHostConfig {
    const next: SshHostConfig = {
        ...previous,
        ...input,
        id: previous.id,
        auth: previous.auth
    }

    if (input.auth) {
        if (isEmptyAuth(input.auth) && input.auth.type === previous.auth.type) {
            next.auth = previous.auth
        } else if (isEmptyAuth(input.auth) && input.auth.type !== previous.auth.type) {
            // switching type with empty secret is invalid; keep previous
            next.auth = previous.auth
        } else {
            next.auth = input.auth
        }
    }

    return mergeHostSecrets(next, previous)
}

export function resolveHostReference(hosts: SshHostConfig[], reference: string) {
    const idMatch = hosts.find((host) => host.id === reference)
    if (idMatch) return idMatch

    const value = reference.trim().toLowerCase()
    const matches = hosts.filter((host) => {
        const address = host.host.toLowerCase()
        const name = host.name.toLowerCase()
        const port = host.port || 22
        const user = host.username.toLowerCase()
        return (
            name === value ||
            address === value ||
            `${address}:${port}` === value ||
            `${user}@${address}` === value ||
            `${user}@${address}:${port}` === value
        )
    })

    if (matches.length > 1) {
        throw new Error(`设备引用“${reference}”有歧义，请使用设备 ID。`)
    }
    return matches[0]
}
