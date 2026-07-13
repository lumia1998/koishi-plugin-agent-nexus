import type { NexusConfig, SshHostConfig } from '../types'

export function mergeHostSecrets(
    incoming: SshHostConfig,
    previous?: SshHostConfig
): SshHostConfig {
    if (!previous || incoming.auth.type !== previous.auth.type) return incoming

    if (incoming.auth.type === 'password' && previous.auth.type === 'password') {
        return {
            ...incoming,
            auth: {
                type: 'password',
                password: incoming.auth.password || previous.auth.password
            }
        }
    }

    if (incoming.auth.type === 'key' && previous.auth.type === 'key') {
        return {
            ...incoming,
            auth: {
                type: 'key',
                privateKey: incoming.auth.privateKey || previous.auth.privateKey,
                passphrase: incoming.auth.passphrase || previous.auth.passphrase
            }
        }
    }

    return incoming
}

export function redactNexusConfig(config: NexusConfig): NexusConfig {
    return {
        ...config,
        hosts: config.hosts.map((host) => ({
            ...host,
            auth:
                host.auth.type === 'password'
                    ? { type: 'password', password: '' }
                    : { type: 'key', privateKey: '' }
        }))
    }
}

export function hostConnectionChanged(previous: SshHostConfig, next: SshHostConfig) {
    return (
        previous.host !== next.host ||
        previous.port !== next.port ||
        previous.username !== next.username ||
        previous.enabled !== next.enabled ||
        JSON.stringify(previous.auth) !== JSON.stringify(next.auth)
    )
}
