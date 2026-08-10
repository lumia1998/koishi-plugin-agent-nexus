import { access, realpath, stat } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import { getAdapter, listAdapters } from '../adapters'
import type { AgentKind, DelegateInput, PublishResult } from '../types'
import type { DelegateResult } from '../runtime/runner'
import type { BridgeConfig } from './config'
import { BRIDGE_AGENT_KINDS } from './config'
import type { BridgeArtifactRegistry } from './artifacts'

export interface LocalAgentInfo {
    kind: AgentKind
    installed: boolean
    path?: string
    version?: string
}

export class LocalAgentExecutor {
    private byKind = new Map<AgentKind, LocalAgentInfo>()

    constructor(
        private readonly config: BridgeConfig,
        detected: LocalAgentInfo[],
        private readonly artifacts?: BridgeArtifactRegistry
    ) {
        for (const item of detected) this.byKind.set(item.kind, item)
    }

    async execute(input: DelegateInput): Promise<DelegateResult> {
        const agent = this.resolveAgent(input.agent)
        const detected = this.byKind.get(agent)!
        const adapter = getAdapter(agent)
        const cwd = await this.resolveCwd(input.cwd)
        const command = adapter.buildCommand({
            prompt: input.prompt,
            cwd,
            model: input.model,
            timeoutMs: input.timeoutMs,
            openclawAgent: input.openclawAgent,
            runtime: this.config.runtime,
            sessionMode: input.sessionMode,
            providerState: input.providerState,
            executablePath: detected.path
        })
        const execution = await runLocalCommand(command, {
            cwd,
            timeoutMs:
                input.timeoutMs ||
                this.config.defaultTimeoutMs ||
                this.config.runtime.defaultTimeoutMs,
            maxOutputBytes: this.config.maxOutputBytes,
            signal: input.signal,
            env: enrichedEnvironment(Array.from(this.byKind.values()))
        })
        const parsed = adapter.parseResult(
            execution.stdout,
            execution.stderr,
            execution.exitCode,
            execution.timedOut,
            command
        )
        parsed.truncated = execution.truncated
        const published =
            input.publishFiles === false || !this.artifacts
                ? undefined
                : await this.publishFiles(parsed.files, cwd)
        return { ...parsed, hostId: 'local', published }
    }

    private resolveAgent(requested?: AgentKind | 'auto') {
        if (requested && requested !== 'auto') {
            const item = this.byKind.get(requested)
            if (!item?.installed || !this.config.agents[requested]) {
                throw new Error(`Bridge agent is not available: ${requested}`)
            }
            return requested
        }
        const available = BRIDGE_AGENT_KINDS.find(
            (kind) => this.config.agents[kind] && this.byKind.get(kind)?.installed
        )
        if (!available) throw new Error('Bridge has no enabled local agent executable')
        return available
    }

    private async resolveCwd(requested?: string) {
        const root = await realpath(this.config.cwd)
        const candidate = requested
            ? path.resolve(expandHome(requested, root))
            : root
        const resolved = await realpath(candidate)
        if (!isWithin(resolved, root)) {
            throw new Error(`Agent cwd must stay within the bridge root: ${root}`)
        }
        if (!(await stat(resolved)).isDirectory()) {
            throw new Error(`Agent cwd is not a directory: ${resolved}`)
        }
        return resolved
    }

    private async publishFiles(files: string[], cwd: string): Promise<PublishResult[]> {
        const results: PublishResult[] = []
        for (const file of files.slice(0, 20)) {
            try {
                const artifact = await this.artifacts!.register(file, cwd)
                results.push({
                    path: file,
                    name: artifact.name,
                    url: artifact.url
                })
            } catch (error) {
                results.push({
                    path: file,
                    name: path.basename(file),
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }
        return results
    }
}

export async function detectLocalAgents(config: BridgeConfig): Promise<LocalAgentInfo[]> {
    return Promise.all(
        listAdapters().map(async (adapter): Promise<LocalAgentInfo> => {
            if (!config.agents[adapter.kind]) {
                return { kind: adapter.kind, installed: false }
            }
            const executable = await findExecutable(adapter.binNames)
            if (!executable) return { kind: adapter.kind, installed: false }
            return {
                kind: adapter.kind,
                installed: true,
                path: executable,
                version: await executableVersion(executable)
            }
        })
    )
}

export interface RunLocalCommandOptions {
    cwd: string
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
    env?: NodeJS.ProcessEnv
}

export interface LocalCommandResult {
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
    truncated: boolean
}

export function runLocalCommand(
    command: string,
    options: RunLocalCommandOptions
): Promise<LocalCommandResult> {
    return new Promise((resolve) => {
        const shell =
            process.env.AGENT_NEXUS_BRIDGE_SHELL ||
            process.env.SHELL ||
            (process.platform === 'win32' ? 'bash.exe' : '/bin/sh')
        const child = spawn(shell, ['-lc', command], {
            cwd: options.cwd,
            env: options.env || process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        })
        let stdout = Buffer.alloc(0)
        let stderr = Buffer.alloc(0)
        let capturedBytes = 0
        let truncated = false
        let timedOut = false
        let aborted = false
        let settled = false
        let forceTimer: NodeJS.Timeout | undefined

        const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            const remaining = Math.max(0, options.maxOutputBytes - capturedBytes)
            if (remaining > 0) {
                const kept = buffer.subarray(0, remaining)
                if (target === 'stdout') stdout = Buffer.concat([stdout, kept])
                else stderr = Buffer.concat([stderr, kept])
                capturedBytes += kept.length
            }
            if (buffer.length > remaining) truncated = true
        }
        child.stdout.on('data', (chunk) => collect('stdout', chunk))
        child.stderr.on('data', (chunk) => collect('stderr', chunk))

        const kill = () => {
            if (!child.pid || child.exitCode !== null) return
            try {
                if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
                else child.kill('SIGTERM')
            } catch {}
            forceTimer = setTimeout(() => {
                try {
                    if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL')
                    else child.kill('SIGKILL')
                } catch {}
            }, 2000)
            forceTimer.unref()
        }
        const onAbort = () => {
            aborted = true
            kill()
        }
        if (options.signal?.aborted) onAbort()
        else options.signal?.addEventListener('abort', onAbort, { once: true })

        const timer = setTimeout(() => {
            timedOut = true
            kill()
        }, options.timeoutMs)
        timer.unref()

        const finish = (exitCode: number) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (forceTimer) clearTimeout(forceTimer)
            options.signal?.removeEventListener('abort', onAbort)
            resolve({
                exitCode: timedOut ? 124 : aborted ? 130 : exitCode,
                stdout: stdout.toString('utf8'),
                stderr: stderr.toString('utf8'),
                timedOut,
                truncated
            })
        }
        child.once('error', (error) => {
            collect('stderr', Buffer.from(error.message))
            finish(1)
        })
        child.once('close', (code) => finish(code ?? 1))
    })
}

async function findExecutable(binNames: string[]) {
    const directories = new Set(
        [
            ...(process.env.PATH || '').split(path.delimiter),
            path.join(os.homedir(), '.local', 'bin'),
            path.join(os.homedir(), '.npm-global', 'bin'),
            path.join(os.homedir(), '.cargo', 'bin'),
            path.join(os.homedir(), '.claude', 'bin'),
            path.join(os.homedir(), '.opencode', 'bin'),
            path.join(os.homedir(), '.codex', 'bin'),
            '/usr/local/bin',
            '/opt/homebrew/bin',
            '/home/linuxbrew/.linuxbrew/bin'
        ].filter(Boolean)
    )
    for (const bin of binNames) {
        if (!/^[A-Za-z0-9._+-]+$/.test(bin)) continue
        for (const directory of directories) {
            const candidate = path.join(directory, bin)
            try {
                await access(candidate, fsConstants.X_OK)
                return await realpath(candidate)
            } catch {}
        }
    }
    return undefined
}

async function executableVersion(executable: string) {
    return new Promise<string | undefined>((resolve) => {
        const child = spawn(executable, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let output = ''
        const collect = (chunk: Buffer | string) => {
            if (output.length < 4096) output += chunk.toString()
        }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        timer.unref()
        child.once('error', () => {
            clearTimeout(timer)
            resolve(undefined)
        })
        child.once('close', () => {
            clearTimeout(timer)
            resolve(output.split(/\r?\n/).map((line) => line.trim()).find(Boolean))
        })
    })
}

function enrichedEnvironment(detected: LocalAgentInfo[]) {
    const directories = detected
        .flatMap((item) => (item.path ? [path.dirname(item.path)] : []))
        .filter((item, index, array) => array.indexOf(item) === index)
    return {
        ...process.env,
        PATH: [...directories, process.env.PATH || ''].filter(Boolean).join(path.delimiter)
    }
}

function expandHome(value: string, cwd: string) {
    if (value === '~') return os.homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2))
    }
    return path.isAbsolute(value) ? value : path.resolve(cwd, value)
}

function isWithin(candidate: string, root: string) {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isAgentKind(value: string): value is AgentKind {
    return BRIDGE_AGENT_KINDS.includes(value as AgentKind)
}
