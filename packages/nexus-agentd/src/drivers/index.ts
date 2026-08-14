import type { AgentdConfig } from '../types.js'
import { createClaudeDriver } from './claude.js'
import { createCodexDriver } from './codex.js'
import { createOpenCodeDriver } from './opencode.js'
import { createOpenClawDriver } from './openclaw.js'
import { createPiDriver } from './pi.js'
import type { AgentDriver } from './types.js'

export function createDriverRegistry(config: AgentdConfig) {
    const drivers = new Map<string, AgentDriver>()
    for (const [id, driver] of Object.entries(config.agents)) {
        if (driver.enabled === false) continue
        switch (driver.driver) {
            case 'opencode':
                drivers.set(id, createOpenCodeDriver(id, driver))
                break
            case 'claude':
                drivers.set(id, createClaudeDriver(id, driver))
                break
            case 'codex':
                drivers.set(id, createCodexDriver(id, driver))
                break
            case 'pi':
                drivers.set(id, createPiDriver(id, driver))
                break
            case 'openclaw':
                drivers.set(id, createOpenClawDriver(id, driver))
                break
        }
    }
    return drivers
}

export type { AgentDriver } from './types.js'
