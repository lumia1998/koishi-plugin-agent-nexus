import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createCodexDriver(id: string, config: AgentdDriverConfig) {
    return createStdioAcpDriver(id, config, {
        name: 'Codex',
        description: 'Codex CLI through the official Codex ACP adapter',
        command: 'codex-acp',
        args: []
    })
}
