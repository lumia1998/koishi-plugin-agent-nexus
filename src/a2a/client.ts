import { randomUUID } from 'crypto'
import {
    AgentCard,
    Message,
    Role,
    Task,
    TaskState,
    taskStateToJSON
} from '@a2a-js/sdk'
import {
    ClientFactory,
    DefaultAgentCardResolver,
    JsonRpcTransportFactory,
    RestTransportFactory
} from '@a2a-js/sdk/client'
import type {
    A2AAgentCardSummary,
    A2ACardSkillSummary,
    A2ARemoteConfig,
    A2ATaskView
} from '../types'
import { resolveSecret } from '../utils/shell'

const DEFAULT_CARD_PATH = '/.well-known/agent-card.json'
const LEGACY_CARD_PATH = '/.well-known/agent.json'

export interface A2ASendInput {
    text: string
    taskId?: string
    contextId?: string
    metadata?: Record<string, unknown>
    returnImmediately?: boolean
    waitTimeoutMs?: number
    pollIntervalMs?: number
}

export class A2AClientService {
    constructor(private readonly maxResponseBytes = 32 * 1024 * 1024) {}

    async discover(remote: A2ARemoteConfig) {
        const { card } = await this.resolve(remote)
        return cardToSummary(card)
    }

    async send(remote: A2ARemoteConfig, input: A2ASendInput): Promise<A2ATaskView> {
        const waitTimeoutMs = normalizeDuration(input.waitTimeoutMs, 10 * 60 * 1000)
        const { client } = await this.resolve(remote, waitTimeoutMs + 30_000)
        const message = Message.fromJSON({
            messageId: randomUUID(),
            contextId: input.contextId,
            taskId: input.taskId,
            role: 'ROLE_USER',
            parts: [{ text: input.text, mediaType: 'text/plain' }],
            metadata: input.metadata || {}
        })
        const result = await client.sendMessage({
            tenant: '',
            message,
            configuration: {
                acceptedOutputModes: [
                    'text/plain',
                    'application/json',
                    'application/octet-stream'
                ],
                returnImmediately: input.returnImmediately ?? false,
                taskPushNotificationConfig: undefined
            },
            metadata: input.metadata || {}
        })
        let view = normalizeTaskResult(remote.id, result)
        if (
            input.returnImmediately ||
            !view.taskId ||
            isSettledTaskState(view.state)
        ) {
            return view
        }
        const taskId = view.taskId
        const deadline = Date.now() + waitTimeoutMs
        const pollIntervalMs = normalizeDuration(input.pollIntervalMs, 1000, 250, 10_000)
        while (Date.now() < deadline) {
            await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
            const task = await client.getTask({
                tenant: '',
                id: taskId,
                historyLength: 20
            })
            view = normalizeTaskResult(remote.id, task)
            if (isSettledTaskState(view.state)) return view
        }
        return { ...view, timedOut: true }
    }

    async getTask(remote: A2ARemoteConfig, taskId: string) {
        const { client } = await this.resolve(remote)
        const result = await client.getTask({
            tenant: '',
            id: taskId,
            historyLength: 20
        })
        return normalizeTaskResult(remote.id, result)
    }

    async cancelTask(remote: A2ARemoteConfig, taskId: string) {
        const { client } = await this.resolve(remote)
        const result = await client.cancelTask({
            tenant: '',
            id: taskId,
            metadata: {}
        })
        return normalizeTaskResult(remote.id, result)
    }

    private async resolve(remote: A2ARemoteConfig, transportTimeoutMs = 30_000) {
        const baseUrl = validateRemoteUrl(remote.baseUrl)
        const resolverFetch = createRemoteFetch(
            remote.authToken,
            30_000,
            this.maxResponseBytes
        )
        const transportFetch = createRemoteFetch(
            remote.authToken,
            transportTimeoutMs,
            this.maxResponseBytes
        )
        const resolver = new DefaultAgentCardResolver({
            fetchImpl: resolverFetch,
            legacyCompat: { enabled: true }
        })
        let card: AgentCard
        try {
            card = await resolver.resolve(
                baseUrl,
                remote.cardPath?.trim() || DEFAULT_CARD_PATH
            )
        } catch (firstError) {
            if (remote.cardPath?.trim()) throw firstError
            card = await resolver.resolve(baseUrl, LEGACY_CARD_PATH)
        }
        const transports = [
            new JsonRpcTransportFactory({
                fetchImpl: transportFetch,
                legacyCompat: { enabled: true }
            }),
            new RestTransportFactory({
                fetchImpl: transportFetch,
                legacyCompat: { enabled: true }
            })
        ]
        const client = await new ClientFactory({
            transports,
            preferredTransports: remote.preferredTransport
                ? [remote.preferredTransport]
                : ['JSONRPC', 'HTTP+JSON'],
            cardResolver: resolver
        }).createFromAgentCard(card)
        return { card, client }
    }
}

export function validateRemoteUrl(value: string) {
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        throw new Error('A2A 地址必须是有效的 http(s) URL。')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('A2A 地址只支持 http 或 https。')
    }
    if (url.username || url.password) {
        throw new Error('A2A 地址不能包含内嵌账号或密码。')
    }
    return url.toString().replace(/\/$/, '')
}

export function cardToSummary(card: AgentCard): A2AAgentCardSummary {
    const interfaces = card.supportedInterfaces || []
    return {
        name: card.name,
        description: card.description,
        version: card.version,
        url: interfaces[0]?.url || '',
        protocolVersions: Array.from(
            new Set(interfaces.map((item) => item.protocolVersion).filter(Boolean))
        ),
        streaming: Boolean(card.capabilities?.streaming),
        skills: (card.skills || []).map(
            (skill): A2ACardSkillSummary => ({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                tags: skill.tags || []
            })
        )
    }
}

export function normalizeTaskResult(
    remoteId: string,
    value: unknown
): A2ATaskView {
    if (isTask(value)) {
        const task = value as Task
        const artifactViews: A2ATaskView['artifacts'] = (task.artifacts || []).flatMap((artifact) =>
            (artifact.parts || []).map((part) => partView(part, artifact))
        )
        const statusMessage = task.status?.message
        const statusText = statusMessage ? messageText(statusMessage) : ''
        const artifactText = artifactViews
            .flatMap((artifact) => (artifact.text?.trim() ? [artifact.text.trim()] : []))
            .join('\n')
        const historyText = latestAgentMessageText(task.history || [])
        return {
            remoteId,
            taskId: task.id,
            contextId: task.contextId,
            state: taskStateToJSON(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED),
            text: statusText || artifactText || historyText || undefined,
            artifacts: artifactViews,
            raw: Task.toJSON(task)
        }
    }
    if (!isMessage(value)) {
        throw new Error('A2A remote returned neither a Task nor a Message.')
    }
    const message = value as Message
    return {
        remoteId,
        taskId: stringValue(message?.taskId),
        contextId: stringValue(message?.contextId),
        state: 'TASK_STATE_COMPLETED',
        text: messageText(message),
        artifacts: [],
        raw: message && typeof message === 'object' ? Message.toJSON(message) : message
    }
}

function isMessage(value: unknown): value is Message {
    return Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as any).messageId === 'string' &&
            Array.isArray((value as any).parts) &&
            'role' in (value as any)
    )
}

function isTask(value: unknown): value is Task {
    return Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as any).id === 'string' &&
            'status' in (value as any)
    )
}

function messageText(message: any) {
    if (!message?.parts) return ''
    return message.parts
        .flatMap((part: any) =>
            part?.content?.$case === 'text' ? [part.content.value] : []
        )
        .join('\n')
        .trim()
}

function partView(
    part: any,
    artifact: any
): A2ATaskView['artifacts'][number] {
    const common = compact({
        artifactId: stringValue(artifact?.artifactId),
        name: stringValue(artifact?.name),
        description: stringValue(artifact?.description),
        filename: stringValue(part?.filename),
        mediaType: stringValue(part?.mediaType),
        metadata:
            part?.metadata && typeof part.metadata === 'object'
                ? part.metadata
                : artifact?.metadata && typeof artifact.metadata === 'object'
                  ? artifact.metadata
                  : undefined
    }) as A2ATaskView['artifacts'][number]
    if (part?.content?.$case === 'text') {
        return { ...common, text: String(part.content.value) }
    }
    if (part?.content?.$case === 'url') {
        return {
            ...common,
            url: String(part.content.value)
        }
    }
    if (part?.content?.$case === 'data') {
        return { ...common, data: part.content.value }
    }
    if (part?.content?.$case === 'raw') {
        return {
            ...common,
            bytesBase64: Buffer.from(part.content.value || []).toString('base64')
        }
    }
    return common
}

function createRemoteFetch(
    token?: string,
    timeoutMs = 30_000,
    maxResponseBytes = 32 * 1024 * 1024
) {
    const secret = token?.trim() ? resolveSecret(token) : ''
    return async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        if (!headers.has('accept')) {
            headers.set('accept', 'application/json, text/event-stream')
        }
        if (secret) headers.set('authorization', `Bearer ${secret}`)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const onAbort = () => controller.abort()
        if (init.signal?.aborted) controller.abort()
        else init.signal?.addEventListener('abort', onAbort, { once: true })
        let cleaned = false
        const cleanup = () => {
            if (cleaned) return
            cleaned = true
            clearTimeout(timer)
            init.signal?.removeEventListener('abort', onAbort)
        }
        try {
            const response = await fetch(input, {
                ...init,
                headers,
                signal: controller.signal
            })
            return limitResponseBody(response, maxResponseBytes, cleanup)
        } catch (error) {
            cleanup()
            throw error
        }
    }
}

export function limitResponseBody(
    response: Response,
    maxBytes: number,
    onDone: () => void = () => undefined
) {
    let finished = false
    const done = () => {
        if (finished) return
        finished = true
        onDone()
    }
    const limit = Math.max(1, Math.floor(maxBytes))
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) {
        void response.body?.cancel().catch(() => undefined)
        done()
        throw new Error(`A2A response exceeds ${limit} bytes`)
    }
    if (!response.body) {
        done()
        return response
    }

    const reader = response.body.getReader()
    let received = 0
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await reader.read()
                if (chunk.done) {
                    done()
                    controller.close()
                    return
                }
                received += chunk.value.byteLength
                if (received > limit) {
                    const error = new Error(`A2A response exceeds ${limit} bytes`)
                    await reader.cancel(error).catch(() => undefined)
                    done()
                    controller.error(error)
                    return
                }
                controller.enqueue(chunk.value)
            } catch (error) {
                done()
                controller.error(error)
            }
        },
        cancel(reason) {
            done()
            return reader.cancel(reason)
        }
    })
    const limited = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    })
    Object.defineProperties(limited, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type }
    })
    return limited
}

function latestAgentMessageText(history: Message[]) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index]?.role !== Role.ROLE_AGENT) continue
        const text = messageText(history[index])
        if (text) return text
    }
    return ''
}

function isSettledTaskState(state: string) {
    return new Set([
        'TASK_STATE_COMPLETED',
        'TASK_STATE_FAILED',
        'TASK_STATE_CANCELED',
        'TASK_STATE_REJECTED',
        'TASK_STATE_INPUT_REQUIRED',
        'TASK_STATE_AUTH_REQUIRED'
    ]).has(state)
}

function normalizeDuration(
    value: unknown,
    fallback: number,
    minimum = 1000,
    maximum = 60 * 60 * 1000
) {
    const number = Number(value)
    return Number.isFinite(number) && number >= minimum
        ? Math.min(maximum, Math.floor(number))
        : fallback
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function compact<T extends Record<string, unknown>>(value: T) {
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined)
    ) as Partial<T>
}
