import type { GatewayRemoteConfig } from '../types'
import { resolveSecret } from '../utils/shell'
import type {
    GatewayAgentsResponse,
    GatewayAttachmentView,
    GatewayEvent,
    GatewayPublishedFilesResponse,
    GatewaySessionView
} from './types'

const DEFAULT_TIMEOUT_MS = 30_000
export const SESSION_START_TIMEOUT_MS = 180_000

export interface GatewayClient {
    listAgents(remote: GatewayRemoteConfig): Promise<GatewayAgentsResponse>
    createSession(
        remote: GatewayRemoteConfig,
        input: { agentId: string; workspace?: string }
    ): Promise<GatewaySessionView>
    getSession(
        remote: GatewayRemoteConfig,
        sessionId: string
    ): Promise<GatewaySessionView>
    sendMessage(
        remote: GatewayRemoteConfig,
        sessionId: string,
        message: string,
        attachments?: string[]
    ): Promise<GatewaySessionView>
    uploadAttachment(
        remote: GatewayRemoteConfig,
        sessionId: string,
        input: { name: string; mediaType?: string; bytes: Uint8Array }
    ): Promise<GatewayAttachmentView>
    cancelSession(
        remote: GatewayRemoteConfig,
        sessionId: string
    ): Promise<GatewaySessionView>
    publishFiles(
        remote: GatewayRemoteConfig,
        sessionId: string,
        paths: string[]
    ): Promise<GatewayPublishedFilesResponse>
}

export class NexusGatewayClient {
    constructor(private readonly maxResponseBytes = 32 * 1024 * 1024) {}

    async listAgents(remote: GatewayRemoteConfig) {
        return this.request<GatewayAgentsResponse>(remote, '/v1/agents')
    }

    async createSession(
        remote: GatewayRemoteConfig,
        input: { agentId: string; workspace?: string }
    ) {
        return this.sessionRequest(
            remote,
            '/v1/sessions',
            {
                method: 'POST',
                body: JSON.stringify(input)
            },
            SESSION_START_TIMEOUT_MS
        )
    }

    async getSession(remote: GatewayRemoteConfig, sessionId: string) {
        return this.sessionRequest(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}`
        )
    }

    async sendMessage(
        remote: GatewayRemoteConfig,
        sessionId: string,
        message: string,
        attachments: string[] = []
    ) {
        return this.sessionRequest(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/message`,
            {
                method: 'POST',
                body: JSON.stringify({
                    message,
                    ...(attachments.length ? { attachments } : {})
                })
            }
        )
    }

    async uploadAttachment(
        remote: GatewayRemoteConfig,
        sessionId: string,
        input: { name: string; mediaType?: string; bytes: Uint8Array }
    ) {
        return this.request<GatewayAttachmentView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/attachments`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': input.mediaType || 'application/octet-stream',
                    'X-Nexus-File-Name': encodeURIComponent(input.name)
                },
                body: Buffer.from(input.bytes)
            },
            SESSION_START_TIMEOUT_MS
        )
    }

    async cancelSession(remote: GatewayRemoteConfig, sessionId: string) {
        return this.sessionRequest(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
            {
                method: 'POST',
                body: '{}'
            }
        )
    }

    async publishFiles(
        remote: GatewayRemoteConfig,
        sessionId: string,
        paths: string[]
    ) {
        const result = await this.request<GatewayPublishedFilesResponse>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/files/publish`,
            {
                method: 'POST',
                body: JSON.stringify({ paths })
            },
            SESSION_START_TIMEOUT_MS
        )
        return {
            files: (result.files || []).map((file) => ({
                ...file,
                url: absoluteGatewayUrl(remote, file.url)
            }))
        }
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
        init: RequestInit = {},
        timeoutMs = DEFAULT_TIMEOUT_MS
    ): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            return await requestGatewayJson<T>(
                remote,
                path,
                init,
                this.maxResponseBytes,
                controller.signal
            )
        } finally {
            clearTimeout(timer)
        }
    }

    private async sessionRequest(
        remote: GatewayRemoteConfig,
        path: string,
        init: RequestInit = {},
        timeoutMs = DEFAULT_TIMEOUT_MS
    ) {
        const session = await this.request<GatewaySessionView>(remote, path, init, timeoutMs)
        return {
            ...session,
            artifacts: (session.artifacts || []).map((artifact) => ({
                ...artifact,
                ...(artifact.url
                    ? { url: absoluteGatewayUrl(remote, artifact.url) }
                    : {})
            }))
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

export function gatewayUrl(remote: GatewayRemoteConfig, path: string) {
    const base = validateGatewayUrl(remote.baseUrl)
    return new URL(path.replace(/^\/+/, ''), `${base}/`).toString()
}

function absoluteGatewayUrl(remote: GatewayRemoteConfig, value: string) {
    const text = String(value || '').trim()
    if (!text) return text
    try {
        const parsed = new URL(text)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString()
        }
    } catch {}
    return gatewayUrl(remote, text)
}

export async function requestGatewayJson<T>(
    remote: GatewayRemoteConfig,
    path: string,
    init: RequestInit,
    maxResponseBytes: number,
    fallbackSignal?: AbortSignal
): Promise<T> {
    const response = await fetch(gatewayUrl(remote, path), {
        ...init,
        headers: gatewayHeaders(remote, init.headers),
        signal: init.signal || fallbackSignal
    })
    if (!response.ok) throw await gatewayHttpError(response)
    return (await readJsonLimited(response, maxResponseBytes)) as T
}

export function gatewayHeaders(remote: GatewayRemoteConfig, input?: any) {
    const headers = new Headers(input)
    headers.set('Accept', headers.get('Accept') || 'application/json')
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json')
    const token = remote.authToken?.trim() ? resolveSecret(remote.authToken) : ''
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return headers
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

export class GatewayHttpError extends Error {
    constructor(
        readonly status: number,
        readonly detail: string
    ) {
        super(
            `Nexus Gateway request failed (${status})${detail ? `: ${detail}` : ''}`
        )
        this.name = 'GatewayHttpError'
    }
}

async function gatewayHttpError(response: Response) {
    let detail = ''
    try {
        const value = (await readJsonLimited(response, 64 * 1024)) as any
        detail = String(value?.error || value?.message || value?.detail || '')
    } catch {}
    return new GatewayHttpError(response.status, detail)
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
