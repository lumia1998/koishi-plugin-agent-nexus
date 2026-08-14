import { spawn } from 'node:child_process'
import { resolveSecret } from '../config.js'
import type { AgentdDriverConfig } from '../types.js'
import type { AgentDriver } from './types.js'

const BASE_ENV_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'SHELL',
    'TMP',
    'TMPDIR',
    'TEMP',
    'LANG',
    'LC_ALL'
]

export interface StdioAcpDriverDefaults {
    name: string
    description: string
    command: string
    args: string[]
    probeArgs?: string[]
    env?: Record<string, string>
}

export function createStdioAcpDriver(
    id: string,
    config: AgentdDriverConfig,
    defaults: StdioAcpDriverDefaults
): AgentDriver {
    const command = config.command || defaults.command
    const args = config.args === undefined ? [...defaults.args] : [...config.args]
    const env = buildEnvironment(config, defaults.env)
    const name = config.name || defaults.name
    const description = config.description || defaults.description
    return {
        id,
        name,
        description,
        command,
        args,
        env,
        permissionPolicy: config.permissionPolicy || 'ask',
        permissionTimeoutMs: config.permissionTimeoutMs || 15 * 60 * 1000,
        async probe() {
            try {
                const version = await probeCommand(
                    command,
                    defaults.probeArgs || ['--version'],
                    env,
                    name
                )
                return {
                    id,
                    name,
                    description,
                    protocol: 'acp',
                    ready: true,
                    version
                }
            } catch (error) {
                return {
                    id,
                    name,
                    description,
                    protocol: 'acp',
                    ready: false,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
        },
        spawn(workspace) {
            return spawn(command, args, {
                cwd: workspace,
                env,
                stdio: ['pipe', 'pipe', 'pipe']
            })
        }
    }
}

export function buildEnvironment(
    config: AgentdDriverConfig,
    defaults: Record<string, string> = {}
) {
    const result: NodeJS.ProcessEnv = {}
    for (const key of new Set([...BASE_ENV_KEYS, ...(config.inheritEnv || [])])) {
        const value = process.env[key]
        if (value !== undefined) result[key] = value
    }
    Object.assign(result, defaults)
    for (const [key, value] of Object.entries(config.env || {})) {
        result[key] = resolveSecret(value)
    }
    return result
}

export function probeCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    label: string
) {
    return new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let output = ''
        let settled = false
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (error) reject(error)
            else resolve(output.trim().split(/\r?\n/)[0] || 'unknown')
        }
        const timer = setTimeout(() => {
            child.kill()
            finish(new Error(`${label} probe timed out`))
        }, 5000)
        child.stdout.on('data', (chunk) => {
            output = `${output}${String(chunk)}`.slice(-8192)
        })
        child.stderr.on('data', (chunk) => {
            output = `${output}${String(chunk)}`.slice(-8192)
        })
        child.once('error', (error) => finish(error))
        child.once('exit', (code, signal) => {
            if (code === 0) finish()
            else {
                finish(
                    new Error(
                        output.trim() ||
                            `${label} probe exited with ${signal || code || 'unknown'}`
                    )
                )
            }
        })
    })
}
