import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createOpenCodeDriver(
    id: string,
    config: AgentdDriverConfig
) {
    return createStdioAcpDriver(id, config, {
        name: 'OpenCode',
        description: 'OpenCode Coding Agent through its native ACP stdio server',
        command: 'opencode',
        args: ['acp']
    })
}
