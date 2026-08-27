import type { NexusConfig } from '../types'

export function redactNexusConfig(config: NexusConfig): NexusConfig {
    return structuredClone(config)
}
