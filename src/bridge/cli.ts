#!/usr/bin/env node
import { bridgeHelp, BRIDGE_VERSION, loadBridgeCliOptions } from './config'
import { BridgeRuntime } from './runtime'
import { AgentNexusBridgeServer } from './server'

export async function runBridgeCli(argv = process.argv.slice(2)) {
    const options = await loadBridgeCliOptions(argv)
    if (options.help) {
        process.stdout.write(`${bridgeHelp()}\n`)
        return
    }
    if (options.version) {
        process.stdout.write(`${BRIDGE_VERSION}\n`)
        return
    }

    const runtime = await BridgeRuntime.create(options.config)
    const server = new AgentNexusBridgeServer(options.config, runtime)
    const address = await server.start()
    const available = runtime.detectedAgents
        .filter((item) => item.installed)
        .map((item) => `${item.kind}${item.version ? ` (${item.version})` : ''}`)
    process.stdout.write(
        [
            `AgentNexus Bridge ${BRIDGE_VERSION}`,
            `Listening: ${address.listen}`,
            `Agent Card: ${address.cardUrl}`,
            `A2A endpoint: ${address.endpointUrl}`,
            `Agents: ${available.join(', ') || 'none detected'}`
        ].join('\n') + '\n'
    )

    let stopping = false
    const stop = async () => {
        if (stopping) return
        stopping = true
        await server.stop()
    }
    process.once('SIGINT', () => void stop())
    process.once('SIGTERM', () => void stop())
}

if (require.main === module) {
    void runBridgeCli().catch((error) => {
        process.stderr.write(
            `agent-nexus-bridge: ${error instanceof Error ? error.message : String(error)}\n`
        )
        process.exitCode = 1
    })
}
