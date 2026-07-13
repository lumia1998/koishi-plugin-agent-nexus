import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import type { ExecResult, SshHostConfig } from '../types'
import { resolveSecret } from '../utils/shell'

export interface TerminalHandle {
    id: string
    onData(cb: (data: string) => void): () => void
    sendInput(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
}

export class SshSession {
    readonly sessionId = randomUUID()
    readonly hostId: string
    private client = new Client()
    private connected = false
    private home = '~'
    private sftp?: SFTPWrapper
    private connecting?: Promise<void>
    lastActiveAt = Date.now()

    constructor(public readonly host: SshHostConfig) {
        this.hostId = host.id
    }

    get cwd() {
        return this.host.cwd || this.home
    }

    isConnected() {
        return this.connected
    }

    touch() {
        this.lastActiveAt = Date.now()
    }

    async connect(): Promise<void> {
        if (this.connected) return
        if (this.connecting) return this.connecting

        this.connecting = new Promise<void>((resolve, reject) => {
            const auth = this.host.auth
            const config: Record<string, unknown> = {
                host: this.host.host,
                port: this.host.port || 22,
                username: this.host.username,
                readyTimeout: 20000,
                keepaliveInterval: 15000
            }

            if (auth.type === 'password') {
                config.password = resolveSecret(auth.password)
            } else {
                config.privateKey = resolveSecret(auth.privateKey)
                if (auth.passphrase) {
                    config.passphrase = resolveSecret(auth.passphrase)
                }
            }

            this.client
                .on('ready', () => {
                    this.connected = true
                    this.touch()
                    this.rawExec('printf %s "$HOME"', 10000)
                        .then((result) => {
                            this.home = result.stdout.trim() || '~'
                            resolve()
                        })
                        .catch(reject)
                })
                .on('error', (err) => {
                    this.connected = false
                    reject(err)
                })
                .on('end', () => {
                    this.connected = false
                })
                .on('close', () => {
                    this.connected = false
                })
                .connect(config as any)
        }).finally(() => {
            this.connecting = undefined
        })

        return this.connecting
    }

    async disconnect(): Promise<void> {
        this.connected = false
        this.sftp = undefined
        this.client.end()
    }

    async exec(
        command: string,
        options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
    ): Promise<ExecResult> {
        await this.connect()
        this.touch()

        const cwd = options.cwd || this.cwd
        const timeoutMs = options.timeoutMs ?? 120000
        const envPrefix = options.env
            ? Object.entries(options.env)
                  .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
                  .join(' ')
            : ''
        const wrapped = `cd ${shellPath(cwd)} 2>/dev/null || cd; ${envPrefix}${command}`
        return this.rawExec(wrapped, timeoutMs)
    }

    private rawExec(command: string, timeoutMs: number): Promise<ExecResult> {
        return new Promise((resolve, reject) => {
            let stdout = ''
            let stderr = ''
            let settled = false
            let timedOut = false
            let stream: ClientChannel | undefined

            const timer = setTimeout(() => {
                timedOut = true
                try {
                    stream?.close()
                } catch {}
                finish(124, 'SIGTERM')
            }, timeoutMs)

            const finish = (code: number, signal?: string) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                this.touch()
                resolve({
                    exitCode: code ?? (timedOut ? 124 : 1),
                    stdout,
                    stderr,
                    timedOut,
                    signal
                })
            }

            this.client.exec(command, (err, ch) => {
                if (err) {
                    clearTimeout(timer)
                    reject(err)
                    return
                }
                stream = ch
                ch.on('data', (data: Buffer) => {
                    stdout += data.toString('utf8')
                })
                ch.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString('utf8')
                })
                ch.on('close', (code: number, signal: string) => {
                    finish(code ?? 0, signal)
                })
            })
        })
    }

    async getSftp(): Promise<SFTPWrapper> {
        await this.connect()
        if (this.sftp) return this.sftp
        return new Promise((resolve, reject) => {
            this.client.sftp((err, sftp) => {
                if (err) return reject(err)
                this.sftp = sftp
                resolve(sftp)
            })
        })
    }

    async readFile(remotePath: string): Promise<Buffer> {
        const sftp = await this.getSftp()
        this.touch()
        return new Promise((resolve, reject) => {
            sftp.readFile(remotePath, (err, data) => {
                if (err) reject(err)
                else resolve(data)
            })
        })
    }

    async openAsset(remotePath: string): Promise<{
        stream: Readable
        size?: number
    }> {
        const sftp = await this.getSftp()
        this.touch()
        const stat = await new Promise<{ size: number }>((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) reject(err)
                else resolve({ size: stats.size })
            })
        })
        const stream = sftp.createReadStream(remotePath)
        return { stream: stream as unknown as Readable, size: stat.size }
    }

    async writeFile(remotePath: string, content: Buffer | string): Promise<void> {
        const sftp = await this.getSftp()
        this.touch()
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
        await new Promise<void>((resolve, reject) => {
            sftp.writeFile(remotePath, buf, (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    async createTerminal(options: {
        cols?: number
        rows?: number
        cwd?: string
    } = {}): Promise<TerminalHandle> {
        await this.connect()
        this.touch()

        const cols = options.cols ?? 120
        const rows = options.rows ?? 30
        const cwd = options.cwd || this.cwd

        return new Promise((resolve, reject) => {
            this.client.shell(
                { term: 'xterm-256color', cols, rows },
                (err, stream) => {
                    if (err) return reject(err)

                    const id = randomUUID()
                    const listeners = new Set<(data: string) => void>()
                    const touch = () => this.touch()
                    let pending = ''
                    let closed = false

                    stream.write(`cd ${shellPath(cwd)} 2>/dev/null || true\n`)

                    stream.on('data', (chunk: Buffer) => {
                        this.touch()
                        const text = chunk.toString('utf8')
                        if (!listeners.size) pending += text
                        for (const cb of listeners) cb(text)
                    })

                    stream.on('close', () => {
                        closed = true
                        listeners.clear()
                    })

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
                                closed = true
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
