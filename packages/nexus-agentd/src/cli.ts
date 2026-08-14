#!/usr/bin/env node
import path from 'node:path'
import { startAgentd } from './index.js'

const configPath = resolveConfigPath(process.argv.slice(2))
const runtime = await startAgentd(configPath)
const address = runtime.server.address()
const label =
    typeof address === 'object' && address
        ? `${address.address}:${address.port}`
        : String(address)
console.log(`nexus-agentd listening on ${label}`)

let closing = false
const close = async () => {
    if (closing) return
    closing = true
    await runtime.close()
}
process.once('SIGINT', () => void close().finally(() => process.exit(0)))
process.once('SIGTERM', () => void close().finally(() => process.exit(0)))

function resolveConfigPath(args: string[]) {
    const index = args.indexOf('--config')
    const value = index >= 0 ? args[index + 1] : process.env.NEXUS_AGENTD_CONFIG
    return path.resolve(value || 'nexus-agentd.json')
}
