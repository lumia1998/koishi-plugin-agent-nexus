import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver, probeCommand } from './stdio.js'

export function createPiDriver(id: string, config: AgentdDriverConfig) {
    const driver = createStdioAcpDriver(id, config, {
        name: 'Pi',
        description: 'Pi coding agent through the pi-acp adapter',
        command: 'pi-acp',
        args: []
    })
    const probeAdapter = driver.probe.bind(driver)
    return {
        ...driver,
        async probe() {
            const adapter = await probeAdapter()
            if (!adapter.ready) return adapter
            const command = driver.env.PI_ACP_PI_COMMAND || 'pi'
            try {
                const version = await probeCommand(
                    command,
                    ['--version'],
                    driver.env,
                    'Pi runtime'
                )
                return { ...adapter, version }
            } catch (error) {
                return {
                    ...adapter,
                    ready: false,
                    version: undefined,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
        }
    }
}
