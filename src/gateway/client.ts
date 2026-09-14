import type { GatewayRemoteConfig } from '../types'
import { resolveSecret } from '../utils/shell'
import type {
    GatewayAgentsResponse,
    GatewayAttachmentView,
    GatewayArtifactDownload,
    GatewayEvent,
    GatewayPendingResponse,
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
    resolvePending(
        remote: GatewayRemoteConfig,
        sessionId: string,
        requestId: string,
        response: GatewayPendingResponse
    ): Promise<GatewaySessionView>
    closeSession(
        remote: GatewayRemoteConfig,
        sessionId: string
    ): Promise<GatewaySessionView>
    publishArtifact(
        remote: GatewayRemoteConfig,
        sessionId: string,
        path: string
    ): Promise<GatewaySessionView>
    /** Optional for legacy injected clients; NexusGatewayClient always provides it. */
    downloadArtifact?(
        remote: GatewayRemoteConfig,
        runId: string,
        artifactId: string
    ): Promise<GatewayArtifactDownload>
    /** Optional for legacy injected clients; streams without buffering the body. */
    streamArtifact?(
        remote: GatewayRemoteConfig,
        runId: string,
        artifactId: string
    ): Promise<GatewayArtifactStream>
    events(
        remote: GatewayRemoteConfig,
        sessionId: string,
        after?: string,
        signal?: AbortSignal
    ): AsyncGenerator<GatewayEvent>
    /** Optional for legacy injected clients; NexusGatewayClient always provides it. */
    readonly maxResponseBytes?: number
}

/** An opened artifact download whose body has not been read yet. */
export interface GatewayArtifactStream {
    body: ReadableStream<Uint8Array>
    filename?: string
    mediaType?: string
}

export class NexusGatewayClient {
    constructor(readonly maxResponseBytes = 32 * 1024 * 1024) {}

    /**
     * Opens an artifact download without buffering the response body. Callers
     * can pipe it straight to disk, which is how artifacts larger than
     * `maxResponseBytes` stay downloadable: the in-memory ceiling applies to
     * `downloadArtifact`, not to the size of the file itself.
     *
     * The connect timeout is cleared once headers arrive, so a slow but
     * progressing transfer is not cut off; the consumer enforces its own
     * byte ceiling while streaming.
     */
    async streamArtifact(
        remote: GatewayRemoteConfig,
        runId: string,
        artifactId: string
    ): Promise<GatewayArtifactStream> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
        try {
            const response = await fetch(
                gatewayUrl(
                    remote,
                    `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`
                ),
                {
                    headers: gatewayHeaders(remote),
                    redirect: 'error',
                    signal: controller.signal
                }
            )
            if (!response.ok) throw await gatewayHttpError(response)
            if (!response.body) {
                throw new Error('Nexus Gateway returned an empty artifact body.')
            }
            return {
                body: response.body,
                filename: parseContentDispositionFilename(
                    response.headers.get('content-disposition')
                ),
                mediaType: responseMediaType(response.headers.get('content-type'))
            }
        } finally {
            clearTimeout(timer)
        }
    }

    async listAgents(remote: GatewayRemoteConfig) {
        return this.request<GatewayAgentsResponse>(remote, '/v1/agents')
    }

    async createSession(
        remote: GatewayRemoteConfig,
        input: { agentId: string; workspace?: string }
    ) {
        return this.request<GatewaySessionView>(
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
        return this.request<GatewaySessionView>(
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
        return this.request<GatewaySessionView>(
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
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
            {
                method: 'POST',
                body: '{}'
            }
        )
    }

    async resolvePending(
        remote: GatewayRemoteConfig,
        sessionId: string,
        requestId: string,
        response: GatewayPendingResponse
    ) {
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/resolve`,
            {
                method: 'POST',
                body: JSON.stringify(response)
            }
        )
    }

    async closeSession(remote: GatewayRemoteConfig, sessionId: string) {
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}`,
            { method: 'DELETE' }
        )
    }

    async publishArtifact(
        remote: GatewayRemoteConfig,
        sessionId: string,
        path: string
    ) {
        return this.request<GatewaySessionView>(
            remote,
            `/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/publish`,
            {
                method: 'POST',
                body: JSON.stringify({ path })
            },
            SESSION_START_TIMEOUT_MS
        )
    }

    async downloadArtifact(
        remote: GatewayRemoteConfig,
        runId: string,
        artifactId: string
    ): Promise<GatewayArtifactDownload> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
        try {
            return await requestGatewayBytes(
                remote,
                `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
                {},
                this.maxResponseBytes,
                controller.signal
            )
        } finally {
            clearTimeout(timer)
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
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
        const merged = mergeAbortSignals(signal, controller.signal)
        let response: Response | undefined
        try {
            response = await fetch(url, {
                headers: this.headers(remote, {
                    Accept: 'text/event-stream',
                    ...(after ? { 'Last-Event-ID': after } : {})
                }),
                redirect: 'error',
                signal: merged.signal
            })
            if (!response.ok || !response.body) {
                throw await gatewayHttpError(response, merged.signal)
            }
            clearTimeout(timer)
        } catch (error) {
            clearTimeout(timer)
            merged.dispose()
            if (error) throw error
            throw new Error('Nexus Gateway did not return a response')
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
            while (true) {
                // Keep a long-lived stream alive while the Gateway sends its
                // heartbeat frames, but abort a half-open connection that
                // stops delivering bytes altogether.
                const readTimer = setTimeout(
                    () => controller.abort(),
                    DEFAULT_TIMEOUT_MS
                )
                let readResult: Awaited<ReturnType<typeof reader.read>>
                try {
                    readResult = await reader.read()
                } finally {
                    clearTimeout(readTimer)
                }
                const { value, done } = readResult
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let split = eventBoundary(buffer)
                while (split) {
                    const block = buffer.slice(0, split.index)
                    buffer = buffer.slice(split.index + split.length)
                    assertSseFrameSize(block, this.maxResponseBytes)
                    const event = parseSseEvent(block, sessionId)
                    if (event) yield event
                    split = eventBoundary(buffer)
                }
                assertSseFrameSize(buffer, this.maxResponseBytes)
            }
            buffer += decoder.decode()
            let split = eventBoundary(buffer)
            while (split) {
                const block = buffer.slice(0, split.index)
                buffer = buffer.slice(split.index + split.length)
                assertSseFrameSize(block, this.maxResponseBytes)
                const event = parseSseEvent(block, sessionId)
                if (event) yield event
                split = eventBoundary(buffer)
            }
            assertSseFrameSize(buffer, this.maxResponseBytes)
        } finally {
            void reader.cancel().catch(() => undefined)
            reader.releaseLock()
            merged.dispose()
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

    private headers(remote: GatewayRemoteConfig, input?: any) {
        return gatewayHeaders(remote, input)
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
    if (url.username || url.password || url.hash || url.search) {
        throw new Error(
            'Nexus Gateway URL must not contain credentials, queries, or fragments'
        )
    }
    return url.toString().replace(/\/+$/, '')
}

export function gatewayUrl(remote: GatewayRemoteConfig, path: string) {
    if (
        /^[a-z][a-z\d+.-]*:/i.test(path) ||
        path.startsWith('//') ||
        /[\\\u0000-\u001f\u007f]/.test(path)
    ) {
        throw new Error('Nexus Gateway request path must be relative')
    }
    const base = validateGatewayUrl(remote.baseUrl)
    return new URL(path.replace(/^\/+/, ''), `${base}/`).toString()
}

export async function requestGatewayJson<T>(
    remote: GatewayRemoteConfig,
    path: string,
    init: RequestInit,
    maxResponseBytes: number,
    fallbackSignal?: AbortSignal
): Promise<T> {
    const merged = mergeAbortSignals(init.signal, fallbackSignal)
    try {
        const response = await fetch(gatewayUrl(remote, path), {
            ...init,
            headers: gatewayHeaders(remote, init.headers),
            redirect: 'error',
            signal: merged.signal
        })
        if (!response.ok) throw await gatewayHttpError(response, merged.signal)
        return (await readJsonLimited(response, maxResponseBytes)) as T
    } finally {
        merged.dispose()
    }
}

export function gatewayHeaders(remote: GatewayRemoteConfig, input?: any) {
    const headers = new Headers(input)
    headers.set('Accept', headers.get('Accept') || 'application/json')
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json')
    const token = remote.authToken?.trim() ? resolveSecret(remote.authToken).trim() : ''
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return headers
}

export async function requestGatewayBytes(
    remote: GatewayRemoteConfig,
    path: string,
    init: RequestInit,
    maxResponseBytes: number,
    fallbackSignal?: AbortSignal
): Promise<GatewayArtifactDownload> {
    const merged = mergeAbortSignals(init.signal, fallbackSignal)
    try {
        const response = await fetch(gatewayUrl(remote, path), {
            ...init,
            headers: gatewayHeaders(remote, init.headers),
            redirect: 'error',
            signal: merged.signal
        })
        if (!response.ok) throw await gatewayHttpError(response, merged.signal)
        const bytes = await readBytesLimited(response, maxResponseBytes)
        return {
            bytes,
            filename: parseContentDispositionFilename(
                response.headers.get('content-disposition')
            ),
            mediaType: responseMediaType(response.headers.get('content-type'))
        }
    } finally {
        merged.dispose()
    }
}

async function readJsonLimited(response: Response, maxBytes: number) {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined)
        throw new GatewayPayloadTooLargeError(maxBytes)
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
                throw new GatewayPayloadTooLargeError(maxBytes)
            }
            chunks.push(value)
        }
    } finally {
        void reader.cancel().catch(() => undefined)
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

async function readBytesLimited(response: Response, maxBytes: number) {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined)
        throw new GatewayPayloadTooLargeError(maxBytes)
    }
    if (!response.body) return new Uint8Array()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) {
                throw new GatewayPayloadTooLargeError(maxBytes)
            }
            chunks.push(value)
        }
    } finally {
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return merged
}

/**
 * Raised when a response body exceeds `maxResponseBytes`. Retrying cannot help:
 * the artifact is simply larger than the configured ceiling, so callers should
 * degrade it to a metadata-only entry instead of polling forever.
 */
export class GatewayPayloadTooLargeError extends Error {
    constructor(readonly limitBytes?: number) {
        super('Nexus Gateway response exceeded size limit')
        this.name = 'GatewayPayloadTooLargeError'
    }
}

export class GatewayHttpError extends Error {
    constructor(
        readonly status: number,
        readonly detail: string,
        readonly metadata: GatewayHttpErrorMetadata = {}
    ) {
        super(
            `Nexus Gateway request failed (${status})${detail ? `: ${detail}` : ''}`
        )
        this.name = 'GatewayHttpError'
    }

    get quota() {
        return this.metadata.quota
    }

    get limit() {
        return this.metadata.limit
    }

    get current() {
        return this.metadata.current
    }

    get retryAfterMs() {
        return this.metadata.retryAfterMs
    }

    /** Header-compatible alias retained for callers that use Retry-After terminology. */
    get retryAfter() {
        return this.metadata.retryAfterMs
    }

    get requestId() {
        return this.metadata.requestId
    }
}

export interface GatewayHttpErrorMetadata {
    quota?: string
    limit?: number
    current?: number
    retryAfterMs?: number
    requestId?: string
}

async function gatewayHttpError(response: Response, signal?: AbortSignal) {
    let detail = ''
    let metadata: GatewayHttpErrorMetadata = {}
    try {
        const value = (await readJsonLimited(response, 64 * 1024)) as any
        detail = String(value?.error || value?.message || value?.detail || '')
        metadata = {
            quota: typeof value?.quota === 'string' ? value.quota : undefined,
            limit: finiteNumber(value?.limit),
            current: finiteNumber(value?.current),
            retryAfterMs: nonNegativeNumber(value?.retryAfterMs),
            requestId:
                typeof value?.requestId === 'string' ? value.requestId : undefined
        }
    } catch (error) {
        if (signal?.aborted) throw error
    }
    const headerRetryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    if (metadata.retryAfterMs === undefined) {
        metadata.retryAfterMs = headerRetryAfterMs
    }
    if (!metadata.quota) {
        const quota = response.headers.get('x-quota-type')?.trim()
        if (quota) metadata.quota = quota
    }
    return new GatewayHttpError(response.status, detail, metadata)
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

function parseSseEvent(block: string, sessionId: string): GatewayEvent | undefined {
    let id = ''
    let type = ''
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('id:')) id = line.slice(3).trim()
        else if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length) return undefined
    const parsed = JSON.parse(data.join('\n')) as Record<string, unknown>
    const eventType =
        typeof parsed.type === 'string' && parsed.type
            ? parsed.type
            : type || undefined
    const event = {
        id: typeof parsed.id === 'string' && parsed.id ? parsed.id : id,
        sessionId:
            typeof parsed.sessionId === 'string' && parsed.sessionId
                ? parsed.sessionId
                : sessionId,
        type: eventType,
        timestamp:
            typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp)
                ? parsed.timestamp
                : Date.now(),
        ...(eventType === 'reset' && parsed.data === undefined
            ? { data: parsed }
            : parsed.data === undefined
              ? {}
              : { data: parsed.data })
    } as GatewayEvent
    if (id && !event.id) event.id = id
    return event
}

function assertSseFrameSize(frame: string, maxBytes: number) {
    if (Buffer.byteLength(frame, 'utf8') > maxBytes) {
        throw new Error('Nexus Gateway SSE frame exceeded size limit')
    }
}

function responseMediaType(value: string | null) {
    const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
    return mediaType || undefined
}

export function parseContentDispositionFilename(value: string | null) {
    if (!value) return undefined
    const encoded = value.match(/(?:^|;)\s*filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i)?.[1]
    const fallback = value.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/i)
    let filename = encoded || fallback?.[1] || fallback?.[2]
    if (!filename) return undefined
    filename = filename.trim()
    if (filename.startsWith('"') && filename.endsWith('"')) {
        filename = filename.slice(1, -1)
    }
    if (encoded) {
        try {
            filename = decodeURIComponent(filename)
        } catch {}
    }
    filename = filename
        .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
        .trim()
    return filename || undefined
}

function finiteNumber(value: unknown) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined
    }
    if (typeof value === 'string' && value.trim()) {
        const number = Number(value)
        return Number.isFinite(number) ? number : undefined
    }
    return undefined
}

function nonNegativeNumber(value: unknown) {
    const number = finiteNumber(value)
    return number !== undefined && number >= 0 ? number : undefined
}

function parseRetryAfter(value: string | null) {
    if (!value) return undefined
    const seconds = Number(value.trim())
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return undefined
    return Math.max(0, date - Date.now())
}

function mergeAbortSignals(...signals: Array<AbortSignal | null | undefined>) {
    const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
    if (active.length < 2) return { signal: active[0], dispose: () => {} }
    const controller = new AbortController()
    const abort = (event: Event) => {
        const source = event.target as AbortSignal
        controller.abort(source.reason)
    }
    for (const signal of active) {
        if (signal.aborted) {
            controller.abort(signal.reason)
            break
        }
        signal.addEventListener('abort', abort, { once: true })
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const signal of active) signal.removeEventListener('abort', abort)
        }
    }
}
