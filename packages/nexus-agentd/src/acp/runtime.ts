import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentDriver } from '../drivers/index.js'
import type { AcpSessionSink } from '../session-contract.js'
import type { AgentdPendingRequest } from '../types.js'

interface PendingPermission {
    request: AgentdPendingRequest
    resolve: (response: acp.RequestPermissionResponse) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

interface PendingInput {
    request: AgentdPendingRequest
    params: acp.CreateElicitationRequest
    resolve: (response: acp.CreateElicitationResponse) => void
    timer: NodeJS.Timeout
}

type FormElicitation = acp.CreateElicitationRequest & {
    mode: 'form'
    requestedSchema: acp.ElicitationSchema
}

export class AcpProcessRuntime {
    private process?: ChildProcessWithoutNullStreams
    private connection?: acp.ClientConnection
    private pending?: PendingPermission
    private pendingInput?: PendingInput
    private disposed = false
    private prompting = false

    constructor(
        private readonly driver: AgentDriver,
        private readonly sink: AcpSessionSink
    ) {}

    async start(workspace: string) {
        if (this.process) throw new Error('ACP runtime is already started')
        const child = this.driver.spawn(workspace)
        this.process = child
        this.captureStderr(child)
        child.once('error', (error) => this.onProcessFailure(error))
        child.once('exit', (code, signal) => {
            if (this.disposed) return
            if (this.sink.state === 'canceled' || this.sink.state === 'completed') return
            this.onProcessFailure(
                new Error(
                    `ACP agent exited unexpectedly (${signal || code || 'unknown'})`
                )
            )
        })

        const app = acp
            .client({ name: 'nexus-agentd' })
            .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
                this.requestPermission(params)
            )
            .onRequest(acp.methods.client.elicitation.create, ({ params }) =>
                this.requestInput(params)
            )
            .onNotification(acp.methods.client.session.update, ({ params }) => {
                this.sessionUpdate(params)
            })
        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        )
        this.connection = app.connect(stream)
        const initialize = await this.connection.agent.request(
            acp.methods.agent.initialize,
            {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {
                    elicitation: {
                        form: {},
                        url: {}
                    }
                },
                clientInfo: {
                    name: 'nexus-agentd',
                    version: '0.1.0'
                }
            }
        )
        if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
            this.sink.emit('terminal_output', {
                stream: 'system',
                text: `ACP negotiated protocol ${initialize.protocolVersion}`
            })
        }
        const session = await this.connection.agent.request(
            acp.methods.agent.session.new,
            {
                cwd: workspace,
                mcpServers: []
            }
        )
        this.sink.setAcpSessionId(String(session.sessionId))
        this.sink.setState('created')
    }

    async prompt(message: string) {
        if (!this.connection) throw new Error('ACP runtime is not connected')
        if (this.prompting) throw new Error('ACP session is already processing a prompt')
        const sessionId = this.requireSessionId()
        this.prompting = true
        this.sink.clearPending()
        this.sink.setState('running')
        try {
            const response = await this.connection.agent.request(
                acp.methods.agent.session.prompt,
                {
                    sessionId,
                    prompt: [{ type: 'text', text: message }]
                }
            )
            if (this.sink.state === 'canceled') return
            if (response.stopReason === 'cancelled') {
                this.sink.setState('canceled')
            } else if (response.stopReason === 'refusal') {
                this.sink.setState('failed', 'ACP agent refused the prompt')
            } else {
                this.sink.setState('completed')
            }
        } catch (error) {
            if (this.sink.state !== 'canceled') {
                this.sink.setState(
                    'failed',
                    error instanceof Error ? error.message : String(error)
                )
            }
        } finally {
            this.prompting = false
        }
    }

    async respondPending(message: string) {
        if (this.pendingInput) {
            this.finishInput(message)
            return
        }
        const pending = this.pending
        if (!pending) throw new Error('ACP session is not waiting for input')
        const normalized = message.trim().toLowerCase()
        const options = pending.request.options || []
        if (
            ['cancel', 'deny', 'reject', '拒绝', '取消', '不同意'].includes(
                normalized
            )
        ) {
            this.finishPermission({ outcome: { outcome: 'cancelled' } })
            return
        }
        const numeric = Number(normalized)
        const option = Number.isInteger(numeric) && numeric >= 1
            ? options[numeric - 1]
            : options.find(
                  (item) =>
                      item.id.toLowerCase() === normalized ||
                      item.name.toLowerCase() === normalized
              )
        if (!option) {
            throw new Error(
                `Permission answer must be an option id/name or index: ${options
                    .map((item, index) => `${index + 1}. ${item.name} (${item.id})`)
                    .join('; ')}`
            )
        }
        this.finishPermission({
            outcome: {
                outcome: 'selected',
                optionId: option.id
            }
        })
    }

    async cancel() {
        if (this.pending) {
            this.finishPermission({ outcome: { outcome: 'cancelled' } })
        }
        if (this.pendingInput) {
            this.finishInput('cancel')
        }
        if (this.connection && this.sink.state !== 'canceled') {
            try {
                await this.connection.agent.notify(acp.methods.agent.session.cancel, {
                    sessionId: this.requireSessionId()
                })
            } catch (error) {
                this.sink.emit('terminal_output', {
                    stream: 'system',
                    text: `ACP cancellation notification failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                })
            }
        }
        this.sink.setState('canceled')
        await this.dispose()
    }

    async dispose() {
        if (this.disposed) return
        this.disposed = true
        if (this.pending) {
            clearTimeout(this.pending.timer)
            this.pending.reject(new Error('ACP runtime disposed'))
            this.pending = undefined
        }
        if (this.pendingInput) {
            clearTimeout(this.pendingInput.timer)
            this.pendingInput.resolve({ action: 'cancel' })
            this.pendingInput = undefined
        }
        this.connection?.close()
        this.connection = undefined
        const child = this.process
        this.process = undefined
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill()
        }
    }

    private requestPermission(
        params: acp.RequestPermissionRequest
    ): Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse {
        if (this.driver.permissionPolicy === 'deny') {
            const reject = params.options.find((option) =>
                option.kind.startsWith('reject')
            )
            return reject
                ? {
                      outcome: {
                          outcome: 'selected',
                          optionId: reject.optionId
                      }
                  }
                : { outcome: { outcome: 'cancelled' } }
        }
        if (this.pending) {
            return { outcome: { outcome: 'cancelled' } }
        }
        const request: AgentdPendingRequest = {
            id: randomUUID(),
            kind: 'permission',
            prompt:
                params.toolCall.title ||
                `Permission requested for tool ${params.toolCall.toolCallId}`,
            options: params.options.map((option) => ({
                id: option.optionId,
                name: option.name,
                kind: option.kind
            }))
        }
        this.sink.setPending(request)
        return new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending?.request.id !== request.id) return
                this.pending = undefined
                this.sink.clearPending()
                this.sink.setState('failed', 'ACP permission request timed out')
                resolve({ outcome: { outcome: 'cancelled' } })
            }, this.driver.permissionTimeoutMs)
            this.pending = { request, resolve, reject, timer }
        })
    }

    private finishPermission(response: acp.RequestPermissionResponse) {
        const pending = this.pending
        if (!pending) return
        this.pending = undefined
        clearTimeout(pending.timer)
        this.sink.clearPending()
        this.sink.setState('running')
        pending.resolve(response)
    }

    private requestInput(
        params: acp.CreateElicitationRequest
    ): Promise<acp.CreateElicitationResponse> {
        if (this.pending || this.pendingInput) {
            return Promise.resolve({ action: 'cancel' })
        }
        const request: AgentdPendingRequest = {
            id: randomUUID(),
            kind: 'input',
            prompt:
                params.mode === 'url'
                    ? `${params.message}\n${params.url}`
                    : params.message,
            options: elicitationOptions(params)
        }
        this.sink.setPending(request)
        return new Promise<acp.CreateElicitationResponse>((resolve) => {
            const timer = setTimeout(() => {
                if (this.pendingInput?.request.id !== request.id) return
                this.pendingInput = undefined
                this.sink.clearPending()
                this.sink.setState('failed', 'ACP input request timed out')
                resolve({ action: 'cancel' })
            }, this.driver.permissionTimeoutMs)
            this.pendingInput = { request, params, resolve, timer }
        })
    }

    private finishInput(message: string) {
        const pending = this.pendingInput
        if (!pending) return
        const normalized = message.trim().toLowerCase()
        let response: acp.CreateElicitationResponse
        if (['cancel', '取消'].includes(normalized)) {
            response = { action: 'cancel' }
        } else if (['decline', '拒绝', '不同意'].includes(normalized)) {
            response = { action: 'decline' }
        } else if (!isFormElicitation(pending.params)) {
            response = { action: 'accept' }
        } else {
            response = {
                action: 'accept',
                content: elicitationContent(pending.params, message)
            }
        }
        this.pendingInput = undefined
        clearTimeout(pending.timer)
        this.sink.clearPending()
        this.sink.setState('running')
        pending.resolve(response)
    }

    private sessionUpdate(params: acp.SessionNotification) {
        const update = params.update
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') {
                    this.sink.appendOutput(update.content.text)
                    this.sink.emit('assistant_chunk', {
                        messageId: update.messageId,
                        content: update.content
                    })
                }
                break
            case 'agent_thought_chunk':
                this.sink.emit('thought_chunk', update)
                break
            case 'tool_call':
                this.sink.emit('tool_call', update)
                if (update.locations?.length) {
                    this.sink.emit('file_activity', {
                        toolCallId: update.toolCallId,
                        locations: update.locations
                    })
                }
                break
            case 'tool_call_update':
                this.sink.emit('tool_update', update)
                if (update.locations?.length) {
                    this.sink.emit('file_activity', {
                        toolCallId: update.toolCallId,
                        locations: update.locations
                    })
                }
                break
            case 'plan':
            case 'plan_update':
            case 'plan_removed':
                this.sink.emit('plan', update)
                break
            default:
                break
        }
    }

    private captureStderr(child: ChildProcessWithoutNullStreams) {
        let buffer = ''
        child.stderr.on('data', (chunk) => {
            buffer += String(chunk)
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''
            for (const line of lines) {
                if (line) {
                    this.sink.emit('terminal_output', {
                        stream: 'stderr',
                        text: line
                    })
                }
            }
        })
    }

    private onProcessFailure(error: unknown) {
        if (this.disposed) return
        this.sink.setState(
            'failed',
            error instanceof Error ? error.message : String(error)
        )
    }

    private requireSessionId() {
        const value = this.sink.acpSessionId
        if (typeof value !== 'string' || !value) {
            throw new Error('ACP session has not been initialized')
        }
        return value
    }
}

function elicitationOptions(params: acp.CreateElicitationRequest) {
    if (!isFormElicitation(params)) return undefined
    const properties = params.requestedSchema.properties || {}
    if (Object.keys(properties).length !== 1) return undefined
    const schema = Object.values(properties)[0]
    if (schema.type !== 'string') return undefined
    const oneOf = Array.isArray((schema as any).oneOf)
        ? ((schema as any).oneOf as Array<{ const: string; title: string }>)
        : []
    if (oneOf.length) {
        return oneOf.map((option) => ({
            id: String(option.const),
            name: String(option.title),
            kind: 'input'
        }))
    }
    const values = Array.isArray((schema as any).enum)
        ? ((schema as any).enum as unknown[])
        : []
    return values.map((value) => ({
        id: String(value),
        name: String(value),
        kind: 'input'
    }))
}

function elicitationContent(
    params: FormElicitation,
    message: string
) {
    try {
        const parsed = JSON.parse(message) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, acp.ElicitationContentValue>
        }
    } catch {}
    const properties = params.requestedSchema.properties || {}
    const entries = Object.entries(properties)
    if (entries.length !== 1) {
        throw new Error('Structured ACP input requires a JSON object')
    }
    const [key, schema] = entries[0]
    if (schema.type === 'boolean') {
        const value = message.trim().toLowerCase()
        if (['true', 'yes', '1', '是'].includes(value)) return { [key]: true }
        if (['false', 'no', '0', '否'].includes(value)) return { [key]: false }
        throw new Error('Boolean ACP input must be true/false or yes/no')
    }
    if (schema.type === 'number' || schema.type === 'integer') {
        const value = Number(message)
        if (!Number.isFinite(value)) throw new Error('ACP input must be a number')
        return { [key]: schema.type === 'integer' ? Math.trunc(value) : value }
    }
    if (schema.type === 'array') {
        return {
            [key]: message
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter(Boolean)
        }
    }
    return { [key]: message }
}

function isFormElicitation(
    params: acp.CreateElicitationRequest
): params is FormElicitation {
    return (
        params.mode === 'form' &&
        Boolean(
            (params as Record<string, unknown>).requestedSchema &&
                typeof (params as Record<string, unknown>).requestedSchema ===
                    'object'
        )
    )
}
