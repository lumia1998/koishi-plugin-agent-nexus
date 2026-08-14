import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createClaudeDriver(id: string, config: AgentdDriverConfig) {
    return createStdioAcpDriver(id, config, {
        name: 'Claude Code',
        description: 'Claude Code through the official Claude Agent ACP adapter',
        command: 'claude-agent-acp',
        args: []
    })
}
