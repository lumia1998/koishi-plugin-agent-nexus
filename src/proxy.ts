import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'
import type { Context } from 'koishi'
import type { AgentNexusService } from './service'

export class NexusTerminalProxy {
    private layer?: { close(): void }

    constructor(
        private ctx: Context,
        private service: AgentNexusService
    ) {}

    start() {
        if (!this.ctx.server) return

        this.layer = this.ctx.server.ws(
            /^\/agent-nexus\/terminal\/([^/?]+)\/([^/?]+)(?:\?.*)?$/,
            (socket, request) => {
                this.accept(socket, request).catch(() => {
                    try {
                        socket.close()
                    } catch {}
                })
            }
        )
    }

    stop() {
        this.layer?.close()
        this.layer = undefined
    }

    private async accept(socket: WebSocket, request: IncomingMessage) {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const parts = url.pathname.split('/')
        const sessionId = parts[3]
        const terminalId = parts[4]
        const token = url.searchParams.get('token') || ''

        const origin = request.headers.origin
        const host = request.headers.host
        if (origin && host && new URL(origin).host !== host) {
            socket.close()
            return
        }

        const item = this.service.claimTerminal(sessionId, terminalId, token)
        if (!item) {
            socket.close()
            return
        }

        const off = item.terminal.onData((data) => {
            if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: 'data', data }))
            }
        })

        socket.on('message', (chunk) => {
            const text = Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : String(chunk)
            try {
                const msg = JSON.parse(text)
                if (msg.type === 'input') {
                    item.terminal.sendInput(String(msg.data ?? ''))
                    return
                }
                if (msg.type === 'resize') {
                    item.terminal.resize(Number(msg.cols) || 80, Number(msg.rows) || 24)
                    return
                }
                if (msg.type === 'kill') {
                    item.terminal.kill()
                }
            } catch {
                item.terminal.sendInput(text)
            }
        })

        socket.on('close', () => {
            off()
            this.service.handleTerminalClose(sessionId, terminalId)
        })
    }
}
