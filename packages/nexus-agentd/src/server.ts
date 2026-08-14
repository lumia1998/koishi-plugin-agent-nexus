import { timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AgentdConfig, AgentdEvent } from './types.js'
import { SessionManager, SessionNotFoundError } from './session.js'

export function createAgentdServer(
    config: AgentdConfig,
    sessions: SessionManager
) {
    return http.createServer((request, response) => {
        void handleRequest(config, sessions, request, response).catch((error) => {
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : undefined)
                return
            }
            const status =
                error instanceof SessionNotFoundError
                    ? 404
                    : error instanceof RequestError
                      ? error.status
                      : 500
            writeJson(response, status, {
                error: error instanceof Error ? error.message : String(error)
            })
        })
    })
}

async function handleRequest(
    config: AgentdConfig,
    sessions: SessionManager,
    request: IncomingMessage,
    response: ServerResponse
) {
    const url = new URL(request.url || '/', 'http://localhost')
    if (url.pathname === '/health' && request.method === 'GET') {
        writeJson(response, 200, { ok: true })
        return
    }
    authenticate(request, config.authToken)

    if (url.pathname === '/v1/agents' && request.method === 'GET') {
        writeJson(response, 200, { agents: await sessions.listAgents() })
        return
    }
    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['agentId', 'workspace'])
        const agentId = requiredString(body.agentId, 'agentId')
        const workspace = requiredString(body.workspace, 'workspace')
        writeJson(response, 201, await sessions.create(agentId, workspace))
        return
    }

    const match = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)(?:\/(message|cancel|events))?$/
    )
    if (!match) throw new RequestError(404, 'Route not found')
    const sessionId = decodeURIComponent(match[1])
    const action = match[2]

    if (!action && request.method === 'GET') {
        writeJson(response, 200, sessions.get(sessionId))
        return
    }
    if (action === 'message' && request.method === 'POST') {
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['message'])
        writeJson(
            response,
            202,
            await sessions.message(sessionId, requiredString(body.message, 'message'))
        )
        return
    }
    if (action === 'cancel' && request.method === 'POST') {
        if (Number(request.headers['content-length'] || 0) > 0) {
            const body = await readJsonBody(request, config.maxRequestBytes)
            assertOnlyKeys(body, [])
        }
        writeJson(response, 200, await sessions.cancel(sessionId))
        return
    }
    if (action === 'events' && request.method === 'GET') {
        streamEvents(
            request,
            response,
            sessions,
            sessionId,
            url.searchParams.get('after') ||
                stringHeader(request.headers['last-event-id'])
        )
        return
    }
    throw new RequestError(405, 'Method not allowed')
}

function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    sessions: SessionManager,
    sessionId: string,
    after?: string
) {
    sessions.get(sessionId)
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    response.flushHeaders?.()
    for (const event of sessions.eventsAfter(sessionId, after)) {
        writeEvent(response, event)
    }
    const unsubscribe = sessions.subscribe(sessionId, (event) =>
        writeEvent(response, event)
    )
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
    }
    request.once('close', close)
    response.once('close', close)
}

function writeEvent(response: ServerResponse, event: AgentdEvent) {
    if (response.destroyed || response.writableEnded) return
    response.write(`id: ${event.id}\n`)
    response.write(`event: ${event.type}\n`)
    response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function authenticate(request: IncomingMessage, expected: string) {
    const value = stringHeader(request.headers.authorization)
    if (!value.startsWith('Bearer ')) {
        throw new RequestError(401, 'Bearer token is required')
    }
    const actual = value.slice(7)
    const left = Buffer.from(actual)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw new RequestError(401, 'Invalid Bearer token')
    }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number) {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new RequestError(413, 'Request body is too large')
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) throw new RequestError(413, 'Request body is too large')
        chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {} as Record<string, unknown>
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('body must be an object')
        }
        return parsed as Record<string, unknown>
    } catch (error) {
        throw new RequestError(
            400,
            `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
    const accepted = new Set(allowed)
    const unknown = Object.keys(body).filter((key) => !accepted.has(key))
    if (unknown.length) {
        throw new RequestError(
            400,
            `Unsupported request fields: ${unknown.join(', ')}`
        )
    }
}

function requiredString(value: unknown, name: string) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new RequestError(400, `${name} is required`)
    return text
}

function stringHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] || '' : value || ''
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
    const body = `${JSON.stringify(value)}\n`
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    })
    response.end(body)
}

class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}
