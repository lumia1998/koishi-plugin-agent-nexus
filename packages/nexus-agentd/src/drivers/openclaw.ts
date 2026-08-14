import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createOpenClawDriver(id: string, config: AgentdDriverConfig) {
    return createStdioAcpDriver(id, config, {
        name: 'OpenClaw',
        description: 'OpenClaw Gateway through its native ACP stdio bridge',
        command: 'openclaw',
        args: ['acp'],
        env: {
            OPENCLAW_HIDE_BANNER: '1',
            OPENCLAW_SUPPRESS_NOTES: '1'
        }
    })
}
