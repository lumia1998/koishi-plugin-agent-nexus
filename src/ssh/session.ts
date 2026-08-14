import {
    Client,
    type ClientChannel,
    type ExecOptions,
    type FileEntryWithStats,
    type SFTPWrapper,
    type Stats
} from 'ssh2'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import path from 'path'
import type { ExecResult, SshHostConfig } from '../types'
import { resolveSecret } from '../utils/shell'
import { mimeType } from '../utils/mime'
import { normalizeHostKeyPolicy, verifySshHostKey } from './host-key'

export interface TerminalHandle {
    id: string
    onData(cb: (data: string) => void): () => void
    onClose(cb: () => void): () => void
    sendInput(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
}

interface EnvironmentProbe {
    env: Record<string, string>
    source: 'interactive' | 'noninteractive' | 'fallback'
    warning?: string
}

export class SshSession {
    readonly sessionId = randomUUID()
    readonly hostId: string
    private client = new Client()
    private connected = false
    private home: string
    private path = '/usr/local/bin:/usr/bin:/bin'
    private remoteEnvironment: Record<string, string> = {}
    private environmentSource: 'interactive' | 'noninteractive' | 'fallback' =
        'fallback'
    private environmentWarning?: string
    private sftp?: SFTPWrapper
    private connecting?: Promise<void>
    private cancelConnecting?: (error: Error) => void
    private sftpConnecting?: Promise<SFTPWrapper>
    private activeOperations = 0
    private connectionGeneration = 0
    lastError?: string
    lastConnectedAt?: number
    lastActiveAt = Date.now()

    constructor(
        public readonly host: SshHostConfig,
        private readonly maxOutputBytes = 4 * 1024 * 1024,
        private readonly onHostKeyLearned?: (
            hostId: string,
            fingerprint: string
        ) => void
    ) {
        this.hostId = host.id
        this.home = defaultRemoteHome(host.username)
    }

    get cwd() {
        return this.resolveRemotePath(this.host.cwd || this.home)
    }

    get environmentInfo() {
        return {
            source: this.environmentSource,
            home: this.home,
            shell: this.remoteEnvironment.SHELL,
            pathEntries: this.path.split(':').filter(Boolean).length,
            variables: Object.keys(this.remoteEnvironment).length,
            warning: this.environmentWarning
        }
    }

    get serviceEnvironment() {
        const output: Record<string, string> = {}
        for (const [key, value] of Object.entries(this.remoteEnvironment)) {
            if (SERVICE_ENV_ALLOW.has(key) || key.startsWith('LC_')) {
                output[key] = value
            }
        }
        output.HOME = this.home
        output.PATH = this.path
        return output
    }

    resolveRemotePath(value?: string) {
        const input = value?.trim() || this.home
        if (input === '~') return this.home
        if (input.startsWith('~/')) {
            return path.posix.normalize(`${this.home}/${input.slice(2)}`)
        }
        if (input.startsWith('/')) return path.posix.normalize(input)
        return path.posix.resolve(this.home, input)
    }

    isConnected() {
        return this.connected
    }

    isConnecting() {
        return !!this.connecting
    }

    hasActiveOperations() {
        return this.activeOperations > 0
    }

    touch() {
        this.lastActiveAt = Date.now()
    }

    async connect(): Promise<void> {
        if (this.connected) return
        if (this.connecting) return this.connecting

        const generation = ++this.connectionGeneration
        const client = new Client()
        this.client = client
        const isCurrent = () =>
            this.connectionGeneration === generation && this.client === client
        let task: Promise<void>
        task = new Promise<void>((resolve, reject) => {
            const cancel = (error: Error) => reject(error)
            this.cancelConnecting = cancel
            const auth = this.host.auth
            let hostVerificationError: string | undefined
            const hostKeyPolicy = normalizeHostKeyPolicy(
                this.host.hostKeyPolicy
            )
            const config: Record<string, unknown> = {
                host: this.host.host,
                port: this.host.port || 22,
                username: this.host.username,
                readyTimeout: 20000,
                keepaliveInterval: 15000,
                hostHash: 'sha256',
                hostVerifier: (hashedKey: string) => {
                    const verification = verifySshHostKey(
                        hashedKey,
                        this.host.hostKeyFingerprint,
                        hostKeyPolicy
                    )
                    hostVerificationError = verification.error
                    if (verification.learned && verification.fingerprint) {
                        this.host.hostKeyPolicy = hostKeyPolicy
                        this.host.hostKeyFingerprint = verification.fingerprint
                        try {
                            this.onHostKeyLearned?.(
                                this.host.id,
                                verification.fingerprint
                            )
                        } catch {}
                    }
                    return verification.accepted
                }
            }

            if (auth.type === 'password') {
                config.password = resolveSecret(auth.password)
            } else {
                config.privateKey = resolveSecret(auth.privateKey)
                if (auth.passphrase) {
                    config.passphrase = resolveSecret(auth.passphrase)
                }
            }

            client
                .on('ready', () => {
                    if (!isCurrent()) {
                        client.end()
                        return
                    }
                    this.connected = true
                    this.lastError = undefined
                    this.lastConnectedAt = Date.now()
                    this.touch()
                    this.probeEnvironment(client)
                        .then((probe) => {
                            if (!isCurrent()) return reject(new Error('SSH connection superseded'))
                            this.remoteEnvironment = filterRemoteEnvironment(probe.env)
                            this.environmentSource = probe.source
                            this.environmentWarning = probe.warning
                            this.home = absoluteHome(
                                this.remoteEnvironment.HOME,
                                this.host.username
                            )
                            this.path = enrichPath(
                                this.remoteEnvironment.PATH || this.path,
                                this.home
                            )
                            this.remoteEnvironment.HOME = this.home
                            this.remoteEnvironment.PATH = this.path
                            resolve()
                        })
                        .catch((err) => {
                            if (!isCurrent()) return reject(err)
                            this.connected = false
                            this.lastError = errorMessage(err)
                            client.end()
                            reject(err)
                        })
                })
                .on('error', (err) => {
                    if (!isCurrent()) return
                    this.connected = false
                    this.sftp = undefined
                    this.sftpConnecting = undefined
                    const connectionError = hostVerificationError
                        ? new Error(hostVerificationError)
                        : err
                    this.lastError = connectionError.message
                    reject(connectionError)
                })
                .on('end', () => {
                    if (!isCurrent()) return
                    this.connected = false
                    this.sftp = undefined
                    this.sftpConnecting = undefined
                })
                .on('close', () => {
                    if (!isCurrent()) return
                    this.connected = false
                    this.sftp = undefined
                    this.sftpConnecting = undefined
                })
                .connect(config as any)
        }).finally(() => {
            if (this.connecting === task) this.connecting = undefined
            this.cancelConnecting = undefined
        })

        this.connecting = task
        return task
    }

    async disconnect(): Promise<void> {
        const cancelConnecting = this.cancelConnecting
        this.connectionGeneration += 1
        const client = this.client
        this.connected = false
        this.sftp = undefined
        this.sftpConnecting = undefined
        client.end()
        cancelConnecting?.(new Error('SSH connection closed'))
    }

    async exec(
        command: string,
        options: {
            cwd?: string
            timeoutMs?: number
            env?: Record<string, string>
            signal?: AbortSignal
        } = {}
    ): Promise<ExecResult> {
        await this.connect()
        this.touch()

        const cwd = this.resolveRemotePath(options.cwd || this.cwd)
        const timeoutMs = options.timeoutMs ?? 120000
        const envPrefix = buildEnvironmentExports({
            ...this.remoteEnvironment,
            HOME: this.home,
            PATH: this.path,
            ...options.env
        })
        const wrapped = `${envPrefix}cd ${shellPath(cwd)} 2>/dev/null || cd ${shellPath(this.home)}; ${command}`
        return this.rawExec(wrapped, timeoutMs, options.signal, this.client)
    }

    private rawExec(
        command: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
        client = this.client,
        execOptions?: ExecOptions
    ): Promise<ExecResult> {
        this.activeOperations += 1
        return new Promise((resolve, reject) => {
            let stdout = ''
            let stderr = ''
            let stdoutBytes = 0
            let stderrBytes = 0
            let settled = false
            let timedOut = false
            let truncated = false
            let stream: ClientChannel | undefined

            const stop = (timeout: boolean, signal: string) => {
                timedOut = timeout
                try {
                    stream?.signal('KILL')
                    stream?.close()
                } catch {}
                finish(timeout ? 124 : 130, signal)
            }
            const timer = setTimeout(() => stop(true, 'SIGKILL'), timeoutMs)
            const abort = () => stop(false, 'SIGINT')
            abortSignal?.addEventListener('abort', abort, { once: true })

            const finish = (code: number, signal?: string) => {
                if (settled) return
                settled = true
                this.activeOperations -= 1
                clearTimeout(timer)
                abortSignal?.removeEventListener('abort', abort)
                this.touch()
                resolve({
                    exitCode: code ?? (timedOut ? 124 : 1),
                    stdout,
                    stderr,
                    timedOut,
                    signal,
                    truncated
                })
            }
            if (abortSignal?.aborted) abort()

            const append = (
                current: string,
                data: Buffer,
                streamName: 'stdout' | 'stderr'
            ) => {
                const used = streamName === 'stdout' ? stdoutBytes : stderrBytes
                const available = this.maxOutputBytes - used
                if (available <= 0) {
                    truncated = true
                    return current
                }
                const chunk = data.length > available ? data.subarray(0, available) : data
                if (streamName === 'stdout') stdoutBytes += chunk.length
                else stderrBytes += chunk.length
                if (chunk.length < data.length) truncated = true
                return current + chunk.toString('utf8')
            }

            const callback = (err: Error | undefined, ch: ClientChannel) => {
                if (settled) {
                    try {
                        ch?.signal('KILL')
                        ch?.close()
                    } catch {}
                    return
                }
                if (err) {
                    clearTimeout(timer)
                    abortSignal?.removeEventListener('abort', abort)
                    settled = true
                    this.activeOperations -= 1
                    reject(err)
                    return
                }
                stream = ch
                ch.on('data', (data: Buffer) => {
                    stdout = append(stdout, data, 'stdout')
                })
                ch.stderr.on('data', (data: Buffer) => {
                    stderr = append(stderr, data, 'stderr')
                })
                ch.on('close', (code: number, signal: string) => {
                    finish(code ?? 0, signal)
                })
            }
            if (execOptions) client.exec(command, execOptions, callback)
            else client.exec(command, callback)
        })
    }

    private async probeEnvironment(client: Client): Promise<EnvironmentProbe> {
        let baseline: Record<string, string> = {}
        let baselineError: unknown
        try {
            const result = await this.rawExec('env', 8000, undefined, client)
            baseline = parseEnvironmentBlock(result.stdout)
            if (!Object.keys(baseline).length) {
                throw new Error(result.stderr.trim() || 'environment probe returned no variables')
            }
        } catch (err) {
            baselineError = err
        }

        const token = randomUUID().replaceAll('-', '')
        const begin = `__AGENT_NEXUS_ENV_${token}_BEGIN__`
        const end = `__AGENT_NEXUS_ENV_${token}_END__`
        const script = [
            `printf '\\n${begin}\\n'`,
            `printf 'HOME=%s\\n' "$HOME"`,
            `printf 'PATH=%s\\n' "$PATH"`,
            `printf 'SHELL=%s\\n' "$SHELL"`,
            `printf 'LANG=%s\\n' "$LANG"`,
            `printf 'LC_ALL=%s\\n' "$LC_ALL"`,
            `printf 'XDG_CONFIG_HOME=%s\\n' "$XDG_CONFIG_HOME"`,
            `printf 'XDG_DATA_HOME=%s\\n' "$XDG_DATA_HOME"`,
            `printf 'XDG_CACHE_HOME=%s\\n' "$XDG_CACHE_HOME"`,
            `printf 'XDG_RUNTIME_DIR=%s\\n' "$XDG_RUNTIME_DIR"`,
            `printf '${end}\\n'`
        ].join('; ')
        const shell = baseline.SHELL?.startsWith('/') ? baseline.SHELL : '/bin/sh'
        const command = `${shellPath(shell)} -lic ${shellPath(script)}`

        try {
            const result = await this.rawExec(command, 10000, undefined, client, {
                pty: { term: 'xterm-256color', cols: 80, rows: 24 }
            })
            const env = parseEnvironmentProbe(result.stdout, begin, end)
            if (
                !result.timedOut &&
                result.exitCode === 0 &&
                env.HOME?.startsWith('/') &&
                env.PATH
            ) {
                return { env: { ...baseline, ...env }, source: 'interactive' }
            }
            throw new Error(result.stderr.trim() || 'interactive environment probe returned no variables')
        } catch (interactiveError) {
            if (Object.keys(baseline).length) {
                return {
                    env: baseline,
                    source: 'noninteractive',
                    warning: `登录环境探测失败，已回退到 SSH 基础环境：${errorMessage(interactiveError)}`
                }
            }
            return {
                env: {
                    HOME: defaultRemoteHome(this.host.username),
                    PATH: this.path,
                    SHELL: '/bin/sh'
                },
                source: 'fallback',
                warning: `远端环境探测失败：${errorMessage(baselineError || interactiveError)}`
            }
        }
    }

    async getSftp(): Promise<SFTPWrapper> {
        await this.connect()
        if (this.sftp) return this.sftp
        if (this.sftpConnecting) return this.sftpConnecting
        const client = this.client
        this.sftpConnecting = new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) return reject(err)
                if (client !== this.client || !this.connected) {
                    sftp.end()
                    return reject(new Error('SSH connection changed during SFTP initialization'))
                }
                this.sftp = sftp
                const clear = () => {
                    if (this.sftp === sftp) this.sftp = undefined
                }
                sftp.once('close', clear)
                sftp.once('end', clear)
                sftp.once('error', clear)
                resolve(sftp)
            })
        }).finally(() => {
            this.sftpConnecting = undefined
        })
        return this.sftpConnecting
    }

    async realpath(remotePath: string): Promise<string> {
        const sftp = await this.getSftp()
        return this.trackOperation(
            () =>
                new Promise((resolve, reject) => {
                    sftp.realpath(remotePath, (err, value) => {
                        if (err) reject(err)
                        else resolve(value)
                    })
                })
        )
    }

    async stat(remotePath: string, followSymlink = true): Promise<Stats> {
        const sftp = await this.getSftp()
        return this.trackOperation(
            () =>
                new Promise((resolve, reject) => {
                    const callback = (err: Error | undefined, value: Stats) => {
                        if (err) reject(err)
                        else resolve(value)
                    }
                    if (followSymlink) sftp.stat(remotePath, callback)
                    else sftp.lstat(remotePath, callback)
                })
        )
    }

    async listDirectory(remotePath: string): Promise<FileEntryWithStats[]> {
        const sftp = await this.getSftp()
        return this.trackOperation(
            () =>
                new Promise((resolve, reject) => {
                    sftp.readdir(remotePath, (err, entries) => {
                        if (err) reject(err)
                        else resolve(entries)
                    })
                })
        )
    }

    async readFile(remotePath: string, maxBytes?: number): Promise<Buffer> {
        const sftp = await this.getSftp()
        return this.trackOperation(
            () =>
                new Promise((resolve, reject) => {
                    if (!maxBytes) {
                        sftp.readFile(remotePath, (err, data) => {
                            if (err) reject(err)
                            else resolve(data)
                        })
                        return
                    }
                    const chunks: Buffer[] = []
                    const stream = sftp.createReadStream(remotePath, {
                        start: 0,
                        end: Math.max(0, maxBytes - 1)
                    })
                    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
                    stream.on('error', reject)
                    stream.on('end', () => resolve(Buffer.concat(chunks)))
                })
        )
    }

    async makeDirectory(remotePath: string): Promise<void> {
        const sftp = await this.getSftp()
        await this.trackOperation(
            () =>
                new Promise<void>((resolve, reject) => {
                    sftp.mkdir(remotePath, (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                })
        )
    }

    async rename(remotePath: string, targetPath: string): Promise<void> {
        const sftp = await this.getSftp()
        await this.trackOperation(
            () =>
                new Promise<void>((resolve, reject) => {
                    sftp.rename(remotePath, targetPath, (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                })
        )
    }

    async replaceFile(remotePath: string, targetPath: string): Promise<void> {
        const sftp = await this.getSftp()
        try {
            await this.trackOperation(
                () =>
                    new Promise<void>((resolve, reject) => {
                        sftp.ext_openssh_rename(remotePath, targetPath, (err) => {
                            if (err) reject(err)
                            else resolve()
                        })
                    })
            )
            return
        } catch (err: any) {
            if (err?.code !== 8 && !/unsupported/i.test(err?.message || '')) {
                throw err
            }
            if (await this.pathExists(targetPath)) await this.unlink(targetPath)
            await this.rename(remotePath, targetPath)
        }
    }

    async unlink(remotePath: string): Promise<void> {
        const sftp = await this.getSftp()
        await this.trackOperation(
            () =>
                new Promise<void>((resolve, reject) => {
                    sftp.unlink(remotePath, (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                })
        )
    }

    async removeDirectory(remotePath: string): Promise<void> {
        const sftp = await this.getSftp()
        await this.trackOperation(
            () =>
                new Promise<void>((resolve, reject) => {
                    sftp.rmdir(remotePath, (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                })
        )
    }

    async pathExists(remotePath: string): Promise<boolean> {
        try {
            await this.stat(remotePath, false)
            return true
        } catch (err: any) {
            if (err?.code === 2 || /no such file/i.test(err?.message || '')) return false
            throw err
        }
    }

    private async trackOperation<T>(operation: () => Promise<T>): Promise<T> {
        this.activeOperations += 1
        this.touch()
        try {
            return await operation()
        } finally {
            this.activeOperations -= 1
            this.touch()
        }
    }

    async openAsset(remotePath: string, maxBytes?: number): Promise<{
        stream: Readable
        size?: number
        mimeType?: string
    }> {
        const sftp = await this.getSftp()
        const stat = await this.stat(remotePath)
        if (!stat.isFile()) throw new Error(`Asset is not a regular file: ${remotePath}`)
        if (maxBytes && stat.size > maxBytes) {
            throw new Error(
                `Asset exceeds read limit (${stat.size} > ${maxBytes} bytes): ${remotePath}`
            )
        }
        const stream = sftp.createReadStream(remotePath)
        this.activeOperations += 1
        this.touch()
        let released = false
        const release = () => {
            if (released) return
            released = true
            this.activeOperations -= 1
            this.touch()
        }
        stream.once('end', release)
        stream.once('close', release)
        stream.once('error', release)
        return {
            stream: stream as unknown as Readable,
            size: stat.size,
            mimeType: mimeType(remotePath)
        }
    }

    async writeFile(
        remotePath: string,
        content: Buffer | string,
        mode?: number
    ): Promise<void> {
        const sftp = await this.getSftp()
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
        await this.trackOperation(
            () =>
                new Promise<void>((resolve, reject) => {
                    const callback = (err?: Error | null) => {
                        if (err) reject(err)
                        else resolve()
                    }
                    if (mode === undefined) sftp.writeFile(remotePath, buf, callback)
                    else sftp.writeFile(remotePath, buf, { mode }, callback)
                })
        )
    }

    async writeFileExclusive(
        remotePath: string,
        content: Buffer | string
    ): Promise<void> {
        const sftp = await this.getSftp()
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
        await this.trackOperation(
            () =>
                new Promise<void>((resolve, reject) => {
                    sftp.writeFile(
                        remotePath,
                        buf,
                        { flag: 'wx', mode: 0o600 },
                        (err) => {
                            if (err) reject(err)
                            else resolve()
                        }
                    )
                })
        )
    }

    async createTerminal(options: {
        cols?: number
        rows?: number
        cwd?: string
        timeoutMs?: number
    } = {}): Promise<TerminalHandle> {
        await this.connect()
        this.touch()

        const cols = options.cols ?? 120
        const rows = options.rows ?? 30
        const cwd = options.cwd || this.cwd
        const timeoutMs = options.timeoutMs ?? 20_000
        const client = this.client

        return new Promise((resolve, reject) => {
            let settled = false
            const timer = setTimeout(() => {
                settled = true
                reject(new Error('SSH shell channel creation timed out'))
            }, timeoutMs)

            client.shell(
                { term: 'xterm-256color', cols, rows },
                (err, stream) => {
                    if (settled) {
                        try {
                            stream?.close()
                        } catch {}
                        return
                    }
                    settled = true
                    clearTimeout(timer)
                    if (err) return reject(err)

                    const id = randomUUID()
                    const listeners = new Set<(data: string) => void>()
                    const closeListeners = new Set<() => void>()
                    const touch = () => this.touch()
                    let pending = ''
                    let closed = false
                    this.activeOperations += 1

                    const markClosed = () => {
                        if (closed) return
                        closed = true
                        this.activeOperations -= 1
                        listeners.clear()
                        for (const cb of closeListeners) cb()
                        closeListeners.clear()
                    }

                    stream.write(`export TERM=xterm-256color; cd ${shellPath(cwd)} 2>/dev/null || true\n`)

                    stream.on('data', (chunk: Buffer) => {
                        this.touch()
                        const text = chunk.toString('utf8')
                        if (!listeners.size) {
                            pending = (pending + text).slice(-this.maxOutputBytes)
                        }
                        for (const cb of listeners) cb(text)
                    })

                    stream.on('close', markClosed)
                    stream.on('error', markClosed)

                    resolve({
                        id,
                        onData(cb) {
                            listeners.add(cb)
                            if (pending) {
                                cb(pending)
                                pending = ''
                            }
                            return () => listeners.delete(cb)
                        },
                        onClose(cb) {
                            if (closed) {
                                queueMicrotask(cb)
                                return () => undefined
                            }
                            closeListeners.add(cb)
                            return () => closeListeners.delete(cb)
                        },
                        sendInput(data) {
                            if (!closed) {
                                touch()
                                stream.write(data)
                            }
                        },
                        resize(c, r) {
                            if (!closed) stream.setWindow(r, c, 0, 0)
                        },
                        kill() {
                            if (!closed) {
                                markClosed()
                                stream.close()
                            }
                        }
                    })
                }
            )
        })
    }
}

function shellPath(path: string) {
    return `'${path.replaceAll("'", `'\\''`)}'`
}

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err)
}

export function parseEnvironmentProbe(stdout: string, begin: string, end: string) {
    const start = stdout.indexOf(begin)
    if (start < 0) return {}
    const finish = stdout.indexOf(end, start + begin.length)
    if (finish < 0) return {}
    return parseEnvironmentBlock(
        stdout
            .slice(start + begin.length, finish)
            .replace(/^[\r\n]+|[\r\n]+$/g, '')
    )
}

export function parseEnvironmentBlock(value: string) {
    const env: Record<string, string> = {}
    for (const item of value.split(/\0|\r?\n/)) {
        const normalized = item.replace(/^[\r\n]+/, '')
        const index = normalized.indexOf('=')
        if (index < 1) continue
        const key = normalized.slice(0, index)
        if (!ENV_NAME.test(key)) continue
        env[key] = normalized.slice(index + 1)
    }
    return env
}

export function filterRemoteEnvironment(input: Record<string, string>) {
    const output: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
        if (!ENV_NAME.test(key) || !isAllowedEnvironmentKey(key)) {
            continue
        }
        if (typeof value !== 'string' || value.length > 16384) continue
        output[key] = value
    }
    return output
}

function buildEnvironmentExports(env: Record<string, string>) {
    return Object.entries(env)
        .map(([key, value]) => {
            if (!ENV_NAME.test(key)) {
                throw new Error(`Invalid environment variable name: ${key}`)
            }
            return `export ${key}=${shellPath(value)}; `
        })
        .join('')
}

function absoluteHome(value: string | undefined, username: string) {
    return value?.startsWith('/') ? path.posix.normalize(value) : defaultRemoteHome(username)
}

function defaultRemoteHome(username: string) {
    return username === 'root' ? '/root' : `/home/${username}`
}

const EXTRA_PATH_DIRS = [
    '.local/bin',
    '.hermes/bin',
    '.cargo/bin',
    '.npm-global/bin',
    'go/bin',
    '.opencode/bin',
    '.claude/bin',
    '.codex/bin',
    'bin'
]

export function enrichPath(pathValue: string, home: string) {
    const current = pathValue
        .split(':')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) =>
            item === '~'
                ? home
                : item.startsWith('~/')
                  ? `${home}/${item.slice(2)}`
                  : item
        )
    const parts: string[] = []
    const seen = new Set<string>()
    for (const rel of EXTRA_PATH_DIRS) {
        const dir = `${home.replace(/\/$/, '')}/${rel}`
        if (!seen.has(dir)) {
            parts.push(dir)
            seen.add(dir)
        }
    }
    for (const dir of current) {
        if (!seen.has(dir)) {
            parts.push(dir)
            seen.add(dir)
        }
    }
    // Keep system defaults last so user bins win.
    for (const dir of ['/usr/local/bin', '/usr/bin', '/bin']) {
        if (!seen.has(dir)) {
            parts.push(dir)
            seen.add(dir)
        }
    }
    return parts.join(':')
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_ALLOW = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR'
])

const SERVICE_ENV_ALLOW = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME'
])

function isAllowedEnvironmentKey(key: string) {
    return ENV_ALLOW.has(key) || key.startsWith('LC_')
}
