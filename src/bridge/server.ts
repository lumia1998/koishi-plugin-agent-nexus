import { timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import os from 'os'
import path from 'path'
import {
    A2A_PROTOCOL_VERSION,
    A2A_VERSION_HEADER,
    AGENT_CARD_PATH,
    AgentCard,
    formatSSEErrorEvent,
    formatSSEEvent
} from '@a2a-js/sdk'
import {
    DefaultExecutionEventBusManager,
    DefaultRequestHandler,
    JsonRpcTransportHandler,
    UnauthenticatedUser,
    defaultServerCallContextBuilder,
    type RequestHeaders
} from '@a2a-js/sdk/server'
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server'
import {
    duplicateInterfacesForLegacy,
    isLegacyJsonRpcMethod,
    isV1JsonRpcMethod
} from '@a2a-js/sdk/compat/v0_3'
import { resolveSecret } from '../utils/shell'
import type { BridgeRuntime } from './runtime'
import { BRIDGE_VERSION, type BridgeConfig } from './config'
import { BoundedTaskStore } from './task-store'

export const BRIDGE_A2A_PATH = '/a2a'
export const BRIDGE_HEALTH_PATH = '/health'
export const BRIDGE_AGENT_CARD_PATH = `/${AGENT_CARD_PATH.replace(/^\/+/, '')}`
export const BRIDGE_LEGACY_CARD_PATH = '/.well-known/agent.json'

export class AgentNexusBridgeServer {
    private server?: Server
    private readonly taskStore: BoundedTaskStore
    private readonly eventBusManager = new DefaultExecutionEventBusManager()
    private readonly card: AgentCard
    private readonly handler: DefaultRequestHandler
    private readonly jsonRpc: JsonRpcTransportHandler
    private readonly legacyJsonRpc: LegacyJsonRpcTransportHandler

    constructor(
        private readonly config: BridgeConfig,
        private readonly runtime: BridgeRuntime
    ) {
        this.taskStore = new BoundedTaskStore(
            config.maxStoredTasks,
            path.join(config.dataDir, 'a2a-tasks.json')
        )
        this.card = buildBridgeCard(config, runtime)
        this.handler = new DefaultRequestHandler(
            this.card,
            this.taskStore,
            runtime.a2aExecutor,
            this.eventBusManager
        )
        this.jsonRpc = new JsonRpcTransportHandler(this.handler)
        this.legacyJsonRpc = new LegacyJsonRpcTransportHandler(this.handler)
    }

    async start() {
        if (this.server) return this.address()
        await this.taskStore.init()
        this.server = createServer((request, response) => {
            void this.handle(request, response).catch((error) => {
                if (response.headersSent || response.writableEnded) {
                    response.destroy(error instanceof Error ? error : undefined)
                    return
                }
                json(response, 500, {
                    error: error instanceof Error ? error.message : String(error)
                })
            })
        })
        this.server.headersTimeout = 15_000
        this.server.requestTimeout = 30_000
        this.server.keepAliveTimeout = 5_000
        this.server.maxHeadersCount = 100
        await new Promise<void>((resolve, reject) => {
            const server = this.server!
            const onError = (error: Error) => {
                server.off('listening', onListening)
                reject(error)
            }
            const onListening = () => {
                server.off('error', onError)
                resolve()
            }
            server.once('error', onError)
            server.once('listening', onListening)
            server.listen(this.config.port, this.config.host)
        }).catch((error) => {
            this.server = undefined
            throw error
        })
        this.runtime.artifacts.setPublicBaseUrl(this.publicBaseUrl())
        return this.address()
    }

    async stop() {
        const server = this.server
        this.server = undefined
        const closed = server
            ? new Promise<void>((resolve, reject) => {
                  server.close((error) => (error ? reject(error) : resolve()))
              })
            : Promise.resolve()
        await this.runtime.shutdown()
        await this.taskStore.flush()
        if (!server) return
        server.closeAllConnections?.()
        await closed
    }

    address() {
        return {
            listen: `${this.config.host}:${this.config.port}`,
            publicBaseUrl: this.publicBaseUrl(),
            cardUrl: `${this.publicBaseUrl()}${BRIDGE_AGENT_CARD_PATH}`,
            endpointUrl: `${this.publicBaseUrl()}${BRIDGE_A2A_PATH}`
        }
    }

    private publicBaseUrl() {
        return bridgePublicBaseUrl(this.config)
    }

    private async handle(request: IncomingMessage, response: ServerResponse) {
        const url = new URL(request.url || '/', 'http://bridge.local')
        if (request.method === 'GET' && url.pathname === BRIDGE_HEALTH_PATH) {
            json(response, 200, {
                ok: true,
                name: this.config.cardName,
                version: BRIDGE_VERSION,
                activeTasks: this.runtime.a2aExecutor.runningCount,
                trackedTasks: this.runtime.a2aExecutor.activeCount,
                endpointUrl: `${this.publicBaseUrl()}${BRIDGE_A2A_PATH}`,
                agents: this.runtime.detectedAgents
            })
            return
        }
        if (request.method === 'GET' && url.pathname === BRIDGE_AGENT_CARD_PATH) {
            response.setHeader(A2A_VERSION_HEADER, A2A_PROTOCOL_VERSION)
            json(response, 200, AgentCard.toJSON(this.card))
            return
        }
        if (request.method === 'GET' && url.pathname === BRIDGE_LEGACY_CARD_PATH) {
            response.setHeader(A2A_VERSION_HEADER, '0.3')
            json(response, 200, toLegacyCard(this.card))
            return
        }
        if (request.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
            const id = url.pathname.slice('/artifacts/'.length)
            if (id && (await this.runtime.artifacts.serve(id, response))) return
            if (!response.headersSent) json(response, 404, { error: 'Artifact not found' })
            return
        }
        if (request.method === 'POST' && url.pathname === BRIDGE_A2A_PATH) {
            if (!this.authorized(request)) {
                response.setHeader('WWW-Authenticate', 'Bearer')
                json(response, 401, { error: 'A2A authentication required.' })
                return
            }
            await this.handleRpc(request, response)
            return
        }
        json(response, 404, { error: 'Not found' })
    }

    private async handleRpc(request: IncomingMessage, response: ServerResponse) {
        let raw: string
        try {
            raw = await readBody(request, this.config.maxRequestBytes)
        } catch (error) {
            if (error instanceof RequestBodyTooLargeError) {
                json(response, 413, { error: error.message })
                return
            }
            throw error
        }
        let body: any = raw
        try {
            body = raw ? JSON.parse(raw) : ''
        } catch {}
        const method = body && typeof body === 'object' ? body.method : undefined
        const requestedHeader = headerValue(request, A2A_VERSION_HEADER).trim()
        const legacy =
            isLegacyJsonRpcMethod(method) ||
            (!isV1JsonRpcMethod(method) && requestedHeader === '0.3')
        const transport = legacy ? this.legacyJsonRpc : this.jsonRpc
        const requestedVersion = requestedHeader || (legacy ? '0.3' : A2A_PROTOCOL_VERSION)
        const context = defaultServerCallContextBuilder({
            extensions: undefined,
            user: this.user(request),
            headers: request.headers as RequestHeaders,
            requestedVersion
        })
        try {
            const result = await transport.handle(body || raw || '', context)
            if (isAsyncIterable(result)) {
                await this.stream(response, result, body?.id, legacy)
                return
            }
            response.setHeader(A2A_VERSION_HEADER, legacy ? '0.3' : A2A_PROTOCOL_VERSION)
            json(response, 200, result)
        } catch (error) {
            const rpcError = legacy
                ? LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError(error)
                : JsonRpcTransportHandler.mapToJSONRPCError(error)
            response.setHeader(A2A_VERSION_HEADER, legacy ? '0.3' : A2A_PROTOCOL_VERSION)
            json(response, 200, {
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: rpcError
            })
        }
    }

    private async stream(
        response: ServerResponse,
        result: AsyncGenerator<any, void, undefined>,
        requestId: string | number | null | undefined,
        legacy: boolean
    ) {
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/event-stream')
        response.setHeader('Cache-Control', 'no-cache')
        response.setHeader('Connection', 'keep-alive')
        response.setHeader('X-Accel-Buffering', 'no')
        response.setHeader(A2A_VERSION_HEADER, legacy ? '0.3' : A2A_PROTOCOL_VERSION)
        response.flushHeaders()
        let disconnected = false
        const close = () => {
            disconnected = true
        }
        response.once('close', close)
        try {
            for await (const event of result) {
                if (disconnected || response.destroyed) continue
                response.write(formatSSEEvent(event))
            }
        } catch (error) {
            if (!disconnected && !response.destroyed) {
                const rpcError = legacy
                    ? LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError(error)
                    : JsonRpcTransportHandler.mapToJSONRPCError(error)
                response.write(
                    formatSSEErrorEvent({
                        jsonrpc: '2.0',
                        id: requestId ?? null,
                        error: rpcError
                    })
                )
            }
        } finally {
            response.off('close', close)
            if (!response.destroyed && !response.writableEnded) response.end()
        }
    }

    private authorized(request: IncomingMessage) {
        const configured = this.config.token?.trim()
        if (!configured) return true
        const match = headerValue(request, 'authorization').match(/^Bearer\s+(.+)$/i)
        if (!match) return false
        try {
            const left = Buffer.from(resolveSecret(configured))
            const right = Buffer.from(match[1])
            return left.length === right.length && timingSafeEqual(left, right)
        } catch {
            return false
        }
    }

    private user(request: IncomingMessage) {
        if (!this.config.token?.trim()) return new UnauthenticatedUser()
        return {
            isAuthenticated: true,
            userName: headerValue(request, 'x-a2a-client') || 'a2a-client'
        }
    }
}

export function buildBridgeCard(config: BridgeConfig, runtime: BridgeRuntime) {
    const endpointUrl = `${bridgePublicBaseUrl(config)}${BRIDGE_A2A_PATH}`
    const interfaces = duplicateInterfacesForLegacy(
        [
            {
                url: endpointUrl,
                protocolBinding: 'JSONRPC',
                tenant: '',
                protocolVersion: A2A_PROTOCOL_VERSION
            }
        ] as any,
        ['JSONRPC']
    )
    const tokenEnabled = Boolean(config.token?.trim())
    const skills = runtime.detectedAgents
        .filter((item) => item.installed && config.agents[item.kind])
        .map((item) => ({
            id: `local-${item.kind}`,
            name: `${item.kind} local agent`,
            description: `Run coding and automation tasks with the local ${item.kind} CLI.`,
            tags: [item.kind, 'local', 'coding'],
            examples: [`Ask ${item.kind} to inspect or modify a local repository.`],
            inputModes: ['text/plain'],
            outputModes: ['text/plain', 'application/octet-stream'],
            securityRequirements: []
        }))
    return AgentCard.fromJSON({
        name: config.cardName,
        description: config.cardDescription,
        supportedInterfaces: interfaces,
        provider: {
            organization: 'AgentNexus',
            url: 'https://github.com/lumia1998/koishi-plugin-agent-nexus'
        },
        version: BRIDGE_VERSION,
        documentationUrl:
            'https://github.com/lumia1998/koishi-plugin-agent-nexus#agentnexus-bridge',
        capabilities: {
            streaming: true,
            pushNotifications: false,
            extendedAgentCard: false,
            extensions: []
        },
        securitySchemes: tokenEnabled
            ? {
                  bearer: {
                      httpAuthSecurityScheme: {
                          scheme: 'bearer',
                          bearerFormat: 'Token',
                          description: 'Bearer token configured for AgentNexus Bridge.'
                      }
                  }
              }
            : {},
        securityRequirements: tokenEnabled
            ? [{ schemes: { bearer: { list: [] } } }]
            : [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain', 'application/octet-stream'],
        skills
    })
}

function json(response: ServerResponse, status: number, body: unknown) {
    if (response.writableEnded) return
    const payload = Buffer.from(JSON.stringify(body))
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Length', String(payload.length))
    response.end(payload)
}

class RequestBodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage, limit: number) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > limit) throw new RequestBodyTooLargeError(`A2A request exceeds ${limit} bytes`)
        chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
}

function bridgePublicBaseUrl(config: Pick<BridgeConfig, 'host' | 'port' | 'publicBaseUrl'>) {
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, '')
    const host = ['0.0.0.0', '::', '::0'].includes(config.host)
        ? os.hostname()
        : config.host.includes(':')
          ? `[${config.host}]`
          : config.host
    return `http://${host}:${config.port}`
}

function headerValue(request: IncomingMessage, name: string) {
    const value = request.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] || '' : String(value || '')
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<any, void, undefined> {
    return Boolean(value && typeof (value as any)[Symbol.asyncIterator] === 'function')
}

function toLegacyCard(card: AgentCard) {
    const primary = card.supportedInterfaces[0]
    const securitySchemes = Object.fromEntries(
        Object.entries(card.securitySchemes || {}).flatMap(([name, scheme]) => {
            const value = (scheme as any)?.scheme
            if (value?.$case !== 'httpAuthSecurityScheme') return []
            return [
                [
                    name,
                    {
                        type: 'http',
                        scheme: value.value.scheme,
                        ...(value.value.bearerFormat
                            ? { bearerFormat: value.value.bearerFormat }
                            : {}),
                        ...(value.value.description
                            ? { description: value.value.description }
                            : {})
                    }
                ]
            ]
        })
    )
    return {
        name: card.name,
        description: card.description,
        url: primary?.url,
        preferredTransport: primary?.protocolBinding,
        protocolVersion: '0.3',
        version: card.version,
        capabilities: {
            streaming: Boolean(card.capabilities?.streaming),
            pushNotifications: false,
            stateTransitionHistory: true
        },
        skills: card.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            tags: skill.tags,
            examples: skill.examples
        })),
        defaultInputModes: card.defaultInputModes,
        defaultOutputModes: card.defaultOutputModes,
        ...(Object.keys(securitySchemes).length ? { securitySchemes } : {}),
        ...(card.securityRequirements?.length
            ? {
                  security: card.securityRequirements.map((item: any) =>
                      Object.fromEntries(
                          Object.entries(item.schemes || {}).map(
                              ([key, value]: [string, any]) => [key, value?.list || []]
                          )
                      )
                  )
              }
            : {}),
        provider: card.provider
    }
}
