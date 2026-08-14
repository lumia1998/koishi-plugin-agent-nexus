import type { Server } from 'node:http'
import { loadAgentdConfig } from './config.js'
import { createDriverRegistry } from './drivers/index.js'
import { createAgentdServer } from './server.js'
import { SessionManager } from './session.js'
import { WorkspacePolicy } from './workspace.js'

export async function startAgentd(configPath: string) {
    const config = await loadAgentdConfig(configPath)
    const workspacePolicy = await WorkspacePolicy.create(config.workspaceRoots)
    const sessions = new SessionManager(
        config,
        workspacePolicy,
        createDriverRegistry(config)
    )
    sessions.startCleanup()
    const server = createAgentdServer(config, sessions)
    await listen(server, config.listen.port, config.listen.host)
    return {
        config,
        server,
        sessions,
        async close() {
            await closeServer(server)
            await sessions.shutdown()
        }
    }
}

function listen(server: Server, port: number, host: string) {
    return new Promise<void>((resolve, reject) => {
        const error = (value: Error) => {
            server.off('listening', listening)
            reject(value)
        }
        const listening = () => {
            server.off('error', error)
            resolve()
        }
        server.once('error', error)
        server.once('listening', listening)
        server.listen(port, host)
    })
}

function closeServer(server: Server) {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeIdleConnections?.()
    })
}

export * from './config.js'
export * from './server.js'
export * from './session.js'
export * from './types.js'
export * from './workspace.js'
