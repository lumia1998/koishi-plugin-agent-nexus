import type { GatewayRemoteConfig } from '../types'
import { resolveSecret } from '../utils/shell'
import type {
    GatewayAgentsResponse,
    GatewayEvent,
    GatewaySessionView
} from './types'

const DEFAULT_TIMEOUT_MS = 30_000

export class NexusGatewayClient {
    constructor(private readonly maxResponseBytes = 32 * 1024 * 1024) {}

    async listAgents(remote: GatewayRemoteConfig) {
        return this.request<GatewayAgentsResponse>(remote, '/v1/agents')
    }

    async createSession(
        remote: GatewayRemoteConfig,
        input: { agentId: string; workspace: string }
    ) {
        return this.request<GatewaySessionView>(remote, '/v1/sessions', {
            method: 'POST',
            body: JSON.stringify(input)
        })
    }

    async getSession(remote: GatewayRemoteConfig, sessionId: string) {
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}`
        )
    }

    async sendMessage(
        remote: GatewayRemoteConfig,
        sessionId: string,
        message: string
    ) {
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/message`,
            {
                method: 'POST',
                body: JSON.stringify({ message })
            }
        )
    }

    async cancelSession(remote: GatewayRemoteConfig, sessionId: string) {
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
            {
                method: 'POST',
                body: '{}'
            }
        )
    }

    async *events(
        remote: GatewayRemoteConfig,
        sessionId: string,
        after?: string,
        signal?: AbortSignal
    ): AsyncGenerator<GatewayEvent> {
        const url = gatewayUrl(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`
        )
        const response = await fetch(url, {
            headers: this.headers(remote, {
                Accept: 'text/event-stream',
                ...(after ? { 'Last-Event-ID': after } : {})
            }),
            signal
        })
        if (!response.ok || !response.body) {
            throw await gatewayHttpError(response)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let total = 0
        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                total += value.byteLength
                if (total > this.maxResponseBytes) {
                    throw new Error('Nexus Gateway SSE response exceeded size limit')
                }
                buffer += decoder.decode(value, { stream: true })
                let split = eventBoundary(buffer)
                while (split) {
                    const block = buffer.slice(0, split.index)
                    buffer = buffer.slice(split.index + split.length)
                    const event = parseSseEvent(block)
                    if (event) yield event
                    split = eventBoundary(buffer)
                }
            }
        } finally {
            reader.releaseLock()
        }
    }

    private async request<T>(
        remote: GatewayRemoteConfig,
        path: string,
        init: RequestInit = {}
    ): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
        try {
            const response = await fetch(gatewayUrl(remote, path), {
                ...init,
                headers: this.headers(remote, init.headers),
                signal: init.signal || controller.signal
            })
            if (!response.ok) throw await gatewayHttpError(response)
            return (await readJsonLimited(response, this.maxResponseBytes)) as T
        } finally {
            clearTimeout(timer)
        }
    }

    private headers(remote: GatewayRemoteConfig, input?: any) {
        const headers = new Headers(input)
        headers.set('Accept', headers.get('Accept') || 'application/json')
        headers.set('Content-Type', headers.get('Content-Type') || 'application/json')
        const token = remote.authToken?.trim()
            ? resolveSecret(remote.authToken)
            : ''
        if (token) headers.set('Authorization', `Bearer ${token}`)
        return headers
    }
}

export function validateGatewayUrl(value: string) {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error(`Invalid Nexus Gateway URL: ${value}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Nexus Gateway URL must use http or https')
    }
    if (url.username || url.password || url.hash) {
        throw new Error('Nexus Gateway URL must not contain credentials or fragments')
    }
    return url.toString().replace(/\/+$/, '')
}

function gatewayUrl(remote: GatewayRemoteConfig, path: string) {
    const base = validateGatewayUrl(remote.baseUrl)
    return new URL(path.replace(/^\/+/, ''), `${base}/`).toString()
}

async function readJsonLimited(response: Response, maxBytes: number) {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error('Nexus Gateway response exceeded size limit')
    }
    if (!response.body) return undefined
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) {
                throw new Error('Nexus Gateway response exceeded size limit')
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(merged)
    return text ? JSON.parse(text) : undefined
}

async function gatewayHttpError(response: Response) {
    let detail = ''
    try {
        const value = (await readJsonLimited(response, 64 * 1024)) as any
        detail = String(value?.error || value?.message || '')
    } catch {}
    return new Error(
        `Nexus Gateway request failed (${response.status})${detail ? `: ${detail}` : ''}`
    )
}

function eventBoundary(buffer: string) {
    const unix = buffer.indexOf('\n\n')
    const windows = buffer.indexOf('\r\n\r\n')
    if (unix < 0 && windows < 0) return undefined
    if (windows >= 0 && (unix < 0 || windows < unix)) {
        return { index: windows, length: 4 }
    }
    return { index: unix, length: 2 }
}

function parseSseEvent(block: string): GatewayEvent | undefined {
    let id = ''
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('id:')) id = line.slice(3).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length) return undefined
    const event = JSON.parse(data.join('\n')) as GatewayEvent
    if (id && !event.id) event.id = id
    return event
}
