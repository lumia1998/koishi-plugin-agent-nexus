import { readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { AgentEnableConfig, AgentKind, AgentRuntimeOptions } from '../types'

const packageManifest = require('../../package.json') as { version?: string }

export const BRIDGE_VERSION = packageManifest.version || '0.0.0'
export const BRIDGE_AGENT_KINDS: AgentKind[] = [
    'hermes',
    'openclaw',
    'claude',
    'opencode',
    'codex',
    'pi'
]

export interface BridgeConfig {
    host: string
    port: number
    publicBaseUrl?: string
    token?: string
    dataDir: string
    cwd: string
    agents: AgentEnableConfig
    runtime: AgentRuntimeOptions
    defaultTimeoutMs: number
    maxOutputBytes: number
    maxRequestBytes: number
    maxArtifactBytes: number
    maxArtifacts: number
    maxConcurrentTasks: number
    maxTrackedTasks: number
    maxStoredTasks: number
    artifactTtlMs: number
    sessionHistoryRetentionMs: number
    cardName: string
    cardDescription: string
}

export type BridgeConfigInput = Partial<
    Omit<BridgeConfig, 'agents' | 'runtime'> & {
        agents: Partial<AgentEnableConfig> | AgentKind[] | string
        runtime: Partial<AgentRuntimeOptions>
    }
>

export interface BridgeCliOptions {
    config: BridgeConfig
    help: boolean
    version: boolean
}

export async function loadBridgeCliOptions(
    argv = process.argv.slice(2),
    env: NodeJS.ProcessEnv = process.env
): Promise<BridgeCliOptions> {
    const parsed = parseArgs(argv)
    let fileConfig: BridgeConfigInput = {}
    if (parsed.configPath) {
        const raw = await readFile(expandHome(parsed.configPath), 'utf8')
        fileConfig = JSON.parse(raw) as BridgeConfigInput
    }
    return {
        config: normalizeBridgeConfig({
            ...fileConfig,
            ...environmentConfig(env),
            ...parsed.values,
            runtime: {
                ...(fileConfig.runtime || {}),
                ...(environmentConfig(env).runtime || {}),
                ...(parsed.values.runtime || {})
            }
        }),
        help: parsed.help,
        version: parsed.version
    }
}

export function normalizeBridgeConfig(input: BridgeConfigInput = {}): BridgeConfig {
    const defaultTimeoutMs = positiveInteger(input.defaultTimeoutMs, 600000)
    const agents = normalizeAgents(input.agents)
    const cwd = path.resolve(expandHome(stringValue(input.cwd) || process.cwd()))
    const dataDir = path.resolve(
        expandHome(stringValue(input.dataDir) || '~/.agent-nexus/bridge')
    )
    const maxConcurrentTasks = boundedInteger(
        input.maxConcurrentTasks,
        2,
        1,
        32
    )
    const maxTrackedTasks = Math.max(
        maxConcurrentTasks,
        boundedInteger(input.maxTrackedTasks, 64, 1, 4096)
    )
    return {
        host: stringValue(input.host) || '127.0.0.1',
        port: portNumber(input.port, 8787),
        publicBaseUrl: optionalHttpUrl(input.publicBaseUrl),
        token: stringValue(input.token),
        dataDir,
        cwd,
        agents,
        runtime: {
            openclawAgent: stringValue(input.runtime?.openclawAgent) || 'default',
            claudeSkipPermissions:
                booleanValue(input.runtime?.claudeSkipPermissions) ?? true,
            codexBypassSandbox:
                booleanValue(input.runtime?.codexBypassSandbox) ?? true,
            opencodeAuto: booleanValue(input.runtime?.opencodeAuto) ?? true,
            defaultTimeoutMs: positiveInteger(
                input.runtime?.defaultTimeoutMs,
                defaultTimeoutMs
            )
        },
        defaultTimeoutMs,
        maxOutputBytes: boundedInteger(
            input.maxOutputBytes,
            4 * 1024 * 1024,
            64 * 1024,
            64 * 1024 * 1024
        ),
        maxRequestBytes: boundedInteger(
            input.maxRequestBytes,
            2 * 1024 * 1024,
            1024,
            16 * 1024 * 1024
        ),
        maxArtifactBytes: boundedInteger(
            input.maxArtifactBytes,
            128 * 1024 * 1024,
            1024 * 1024,
            2 * 1024 * 1024 * 1024
        ),
        maxArtifacts: boundedInteger(input.maxArtifacts, 256, 1, 4096),
        maxConcurrentTasks,
        maxTrackedTasks,
        maxStoredTasks: boundedInteger(input.maxStoredTasks, 256, 1, 4096),
        artifactTtlMs: boundedInteger(
            input.artifactTtlMs,
            60 * 60 * 1000,
            60 * 1000,
            24 * 60 * 60 * 1000
        ),
        sessionHistoryRetentionMs: boundedInteger(
            input.sessionHistoryRetentionMs,
            30 * 24 * 60 * 60 * 1000,
            24 * 60 * 60 * 1000,
            365 * 24 * 60 * 60 * 1000
        ),
        cardName: stringValue(input.cardName) || 'AgentNexus Bridge',
        cardDescription:
            stringValue(input.cardDescription) ||
            'A2A bridge for local code-agent command line runtimes.'
    }
}

export function bridgeHelp() {
    return `agent-nexus-bridge [options]

Options:
  --config <file>             JSON configuration file
  --host <address>            Listen address (default: 127.0.0.1)
  --port <number>             Listen port (default: 8787)
  --public-base-url <url>     Public base URL advertised in the Agent Card
  --token <value>             Bearer token or env:VARIABLE reference
  --data-dir <path>           Session and artifact state directory
  --cwd <path>                Agent working directory and artifact root
  --agents <list>             Comma-separated agents or "all"
  --timeout-ms <number>       Default task timeout
  --max-output-bytes <number> Maximum captured stdout/stderr bytes
  --max-request-bytes <number> Maximum JSON-RPC request bytes
  --max-artifact-bytes <n>    Maximum bytes per published artifact
  --max-artifacts <number>    Maximum live artifact links
  --max-concurrent <number>   Maximum running agent tasks
  --max-tracked <number>      Maximum running or waiting tasks
  --max-stored <number>       Maximum retained A2A task records
  --artifact-ttl-ms <number>  Artifact link lifetime
  --help                      Show this help
  --version                   Show the bridge version

Environment variables use the AGENT_NEXUS_BRIDGE_ prefix, for example
AGENT_NEXUS_BRIDGE_HOST, PORT, PUBLIC_URL, TOKEN, DATA_DIR, CWD and AGENTS.`
}

function environmentConfig(env: NodeJS.ProcessEnv): BridgeConfigInput {
    const runtime: Partial<AgentRuntimeOptions> = {}
    setBoolean(runtime, 'claudeSkipPermissions', env.AGENT_NEXUS_BRIDGE_CLAUDE_SKIP_PERMISSIONS)
    setBoolean(runtime, 'codexBypassSandbox', env.AGENT_NEXUS_BRIDGE_CODEX_BYPASS_SANDBOX)
    setBoolean(runtime, 'opencodeAuto', env.AGENT_NEXUS_BRIDGE_OPENCODE_AUTO)
    if (env.AGENT_NEXUS_BRIDGE_OPENCLAW_AGENT) {
        runtime.openclawAgent = env.AGENT_NEXUS_BRIDGE_OPENCLAW_AGENT
    }
    const result: BridgeConfigInput = { runtime }
    setString(result, 'host', env.AGENT_NEXUS_BRIDGE_HOST)
    setNumber(result, 'port', env.AGENT_NEXUS_BRIDGE_PORT)
    setString(result, 'publicBaseUrl', env.AGENT_NEXUS_BRIDGE_PUBLIC_URL)
    setString(result, 'token', env.AGENT_NEXUS_BRIDGE_TOKEN)
    setString(result, 'dataDir', env.AGENT_NEXUS_BRIDGE_DATA_DIR)
    setString(result, 'cwd', env.AGENT_NEXUS_BRIDGE_CWD)
    setString(result, 'agents', env.AGENT_NEXUS_BRIDGE_AGENTS)
    setNumber(result, 'defaultTimeoutMs', env.AGENT_NEXUS_BRIDGE_TIMEOUT_MS)
    setNumber(result, 'maxOutputBytes', env.AGENT_NEXUS_BRIDGE_MAX_OUTPUT_BYTES)
    setNumber(result, 'maxRequestBytes', env.AGENT_NEXUS_BRIDGE_MAX_REQUEST_BYTES)
    setNumber(result, 'maxArtifactBytes', env.AGENT_NEXUS_BRIDGE_MAX_ARTIFACT_BYTES)
    setNumber(result, 'maxArtifacts', env.AGENT_NEXUS_BRIDGE_MAX_ARTIFACTS)
    setNumber(result, 'maxConcurrentTasks', env.AGENT_NEXUS_BRIDGE_MAX_CONCURRENT_TASKS)
    setNumber(result, 'maxTrackedTasks', env.AGENT_NEXUS_BRIDGE_MAX_TRACKED_TASKS)
    setNumber(result, 'maxStoredTasks', env.AGENT_NEXUS_BRIDGE_MAX_STORED_TASKS)
    setNumber(result, 'artifactTtlMs', env.AGENT_NEXUS_BRIDGE_ARTIFACT_TTL_MS)
    setNumber(
        result,
        'sessionHistoryRetentionMs',
        env.AGENT_NEXUS_BRIDGE_SESSION_RETENTION_MS
    )
    setString(result, 'cardName', env.AGENT_NEXUS_BRIDGE_CARD_NAME)
    setString(result, 'cardDescription', env.AGENT_NEXUS_BRIDGE_CARD_DESCRIPTION)
    return result
}

function parseArgs(argv: string[]) {
    const values: BridgeConfigInput = {}
    let configPath = ''
    let help = false
    let version = false
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--help' || argument === '-h') {
            help = true
            continue
        }
        if (argument === '--version' || argument === '-v') {
            version = true
            continue
        }
        const [flag, inline] = splitArgument(argument)
        const take = () => {
            if (inline !== undefined) return inline
            const next = argv[++index]
            if (next === undefined || next.startsWith('--')) {
                throw new Error(`${flag} requires a value`)
            }
            return next
        }
        if (flag === '--config') configPath = take()
        else if (flag === '--host') values.host = take()
        else if (flag === '--port') values.port = Number(take())
        else if (flag === '--public-base-url') values.publicBaseUrl = take()
        else if (flag === '--token') values.token = take()
        else if (flag === '--data-dir') values.dataDir = take()
        else if (flag === '--cwd') values.cwd = take()
        else if (flag === '--agents') values.agents = take()
        else if (flag === '--timeout-ms') values.defaultTimeoutMs = Number(take())
        else if (flag === '--max-output-bytes') values.maxOutputBytes = Number(take())
        else if (flag === '--max-request-bytes') values.maxRequestBytes = Number(take())
        else if (flag === '--max-artifact-bytes') values.maxArtifactBytes = Number(take())
        else if (flag === '--max-artifacts') values.maxArtifacts = Number(take())
        else if (flag === '--max-concurrent') values.maxConcurrentTasks = Number(take())
        else if (flag === '--max-tracked') values.maxTrackedTasks = Number(take())
        else if (flag === '--max-stored') values.maxStoredTasks = Number(take())
        else if (flag === '--artifact-ttl-ms') values.artifactTtlMs = Number(take())
        else throw new Error(`Unknown bridge option: ${argument}`)
    }
    return { values, configPath, help, version }
}

function normalizeAgents(value: BridgeConfigInput['agents']): AgentEnableConfig {
    if (!value) return allAgents(true)
    if (!Array.isArray(value) && typeof value === 'object') {
        const enabled = allAgents(false)
        for (const kind of BRIDGE_AGENT_KINDS) {
            enabled[kind] = booleanValue(value[kind]) ?? false
        }
        return enabled
    }
    const names = (Array.isArray(value) ? value : String(value).split(','))
        .map((item) => String(item).trim().toLowerCase())
        .filter(Boolean)
    if (names.includes('all')) return allAgents(true)
    const enabled = allAgents(false)
    for (const name of names) {
        if (!BRIDGE_AGENT_KINDS.includes(name as AgentKind)) {
            throw new Error(`Unknown bridge agent: ${name}`)
        }
        enabled[name as AgentKind] = true
    }
    return enabled
}

function allAgents(value: boolean): AgentEnableConfig {
    return {
        hermes: value,
        openclaw: value,
        claude: value,
        opencode: value,
        codex: value,
        pi: value
    }
}

function expandHome(value: string) {
    if (value === '~') return os.homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2))
    }
    return value
}

function optionalHttpUrl(value: unknown) {
    const text = stringValue(value)
    if (!text) return undefined
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Bridge publicBaseUrl must be an http(s) URL without credentials')
    }
    return url.toString().replace(/\/$/, '')
}

function positiveInteger(value: unknown, fallback: number) {
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function boundedInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number
) {
    const number = positiveInteger(value, fallback)
    return Math.min(maximum, Math.max(minimum, number))
}

function portNumber(value: unknown, fallback: number) {
    const number = positiveInteger(value, fallback)
    if (number > 65535) throw new Error('Bridge port must be between 1 and 65535')
    return number
}

function stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function booleanValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') return undefined
    if (/^(1|true|yes|on)$/i.test(value)) return true
    if (/^(0|false|no|off)$/i.test(value)) return false
    return undefined
}

function splitArgument(value: string): [string, string | undefined] {
    const index = value.indexOf('=')
    return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)]
}

function setString<T extends object, K extends keyof T>(target: T, key: K, value?: string) {
    if (value !== undefined && value !== '') target[key] = value as T[K]
}

function setNumber<T extends object, K extends keyof T>(target: T, key: K, value?: string) {
    if (value !== undefined && value !== '') target[key] = Number(value) as T[K]
}

function setBoolean<T extends object, K extends keyof T>(target: T, key: K, value?: string) {
    const parsed = booleanValue(value)
    if (parsed !== undefined) target[key] = parsed as T[K]
}
