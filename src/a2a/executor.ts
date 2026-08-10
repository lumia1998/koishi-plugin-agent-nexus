import { randomUUID } from 'crypto'
import {
    AgentEvent,
    type AgentExecutor,
    type ExecutionEventBus,
    type RequestContext
} from '@a2a-js/sdk/server'
import {
    AgentCard,
    Artifact,
    Message,
    Role,
    Task,
    TaskState,
    type TaskArtifactUpdateEvent,
    type TaskStatusUpdateEvent
} from '@a2a-js/sdk'
import type { AgentKind, AgentResult, DelegateInput } from '../types'
import type { SessionIdentity } from '../sessions/types'
import type {
    SessionInvocationContext,
    SessionRunOutcome
} from '../runtime/runner'

const AGENT_KINDS: AgentKind[] = [
    'hermes',
    'openclaw',
    'claude',
    'opencode',
    'codex',
    'pi'
]

interface TaskContext {
    identity: SessionIdentity
    controller: AbortController
    contextId: string
    eventBus: ExecutionEventBus
    waiting: boolean
    cancellationPublished: boolean
}

export interface NexusA2AExecutionService {
    runInSession(
        identity: SessionIdentity,
        input: DelegateInput,
        context?: SessionInvocationContext
    ): Promise<SessionRunOutcome>
    cancelSessions(identity: SessionIdentity): Promise<number>
}

export class NexusA2AExecutor implements AgentExecutor {
    private taskContexts = new Map<string, TaskContext>()
    private cancelled = new Set<string>()
    private executions = new Set<Promise<void>>()
    private shuttingDown = false

    constructor(private readonly nexus: NexusA2AExecutionService) {}

    get activeCount() {
        return this.taskContexts.size
    }

    async cancelTask(taskId: string, eventBus: ExecutionEventBus) {
        const context = this.taskContexts.get(taskId)
        if (!context) return
        this.cancelled.add(taskId)
        context.controller.abort()
        this.publishCancelled(eventBus || context.eventBus, taskId, context.contextId, context)
        await this.nexus.cancelSessions(context.identity).catch(() => 0)
        if (context.waiting) {
            this.taskContexts.delete(taskId)
            this.cancelled.delete(taskId)
        }
    }

    async shutdown() {
        this.shuttingDown = true
        const entries = Array.from(this.taskContexts.entries())
        try {
            await Promise.all(
                entries.map(async ([taskId, context]) => {
                    this.cancelled.add(taskId)
                    context.controller.abort()
                    this.publishCancelled(
                        context.eventBus,
                        taskId,
                        context.contextId,
                        context
                    )
                    await this.nexus.cancelSessions(context.identity).catch(() => 0)
                    if (context.waiting) this.cancelled.delete(taskId)
                })
            )
            await Promise.allSettled(Array.from(this.executions))
        } finally {
            this.taskContexts.clear()
            this.cancelled.clear()
            this.shuttingDown = false
        }
    }

    async execute(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
    ): Promise<void> {
        const execution = this.executeInternal(requestContext, eventBus)
        this.executions.add(execution)
        void execution.then(
            () => this.executions.delete(execution),
            () => this.executions.delete(execution)
        )
        return execution
    }

    private async executeInternal(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
    ): Promise<void> {
        const taskId = requestContext.taskId
        const contextId = requestContext.contextId
        const userMessage = requestContext.userMessage
        const existingTask = requestContext.task
        const task =
            existingTask ||
            Task.fromJSON({
                id: taskId,
                contextId,
                status: {
                    state: 'TASK_STATE_SUBMITTED',
                    timestamp: new Date().toISOString()
                },
                artifacts: [],
                history: [Message.toJSON(userMessage)],
                metadata: userMessage.metadata || {}
            })

        if (this.shuttingDown) {
            eventBus.publish(AgentEvent.task(task))
            this.publishStatus(
                eventBus,
                taskId,
                contextId,
                TaskState.TASK_STATE_CANCELED,
                'AgentNexus is shutting down.'
            )
            return
        }

        const previous = this.taskContexts.get(taskId)
        eventBus.publish(AgentEvent.task(task))
        if (previous && !previous.waiting) {
            this.publishStatus(
                eventBus,
                taskId,
                contextId,
                TaskState.TASK_STATE_FAILED,
                'A2A task is already running.'
            )
            return
        }
        this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_WORKING)

        const metadata = {
            ...((requestContext.request.metadata || {}) as Record<string, unknown>),
            ...((userMessage.metadata || {}) as Record<string, unknown>)
        }
        const identity = this.identityFor(requestContext)
        const controller = new AbortController()
        const taskContext: TaskContext = {
            identity,
            controller,
            contextId,
            eventBus,
            waiting: false,
            cancellationPublished: false
        }
        this.taskContexts.set(taskId, taskContext)

        try {
            if (this.cancelled.has(taskId)) {
                this.publishCancelled(eventBus, taskId, contextId, taskContext)
                return
            }

            const input: DelegateInput = {
                prompt: messageText(userMessage),
                agent: normalizeAgent(metadata.agent ?? metadata.agentKind),
                hostId: stringValue(metadata.hostId),
                cwd: stringValue(metadata.cwd),
                model: stringValue(metadata.model),
                timeoutMs: numberValue(metadata.timeoutMs),
                publishFiles: metadata.publishFiles !== false,
                sessionMode: 'managed',
                signal: controller.signal
            }
            if (!input.prompt.trim()) throw new Error('A2A 消息中没有文本内容。')

            const outcome = await this.nexus.runInSession(
                identity,
                input,
                { requestId: userMessage.messageId }
            )
            if (this.cancelled.has(taskId) || outcome.kind === 'cancelled') {
                this.publishCancelled(eventBus, taskId, contextId, taskContext)
                return
            }

            if (outcome.result) this.publishResult(eventBus, taskId, contextId, outcome.result)

            if (outcome.kind === 'waiting') {
                taskContext.waiting = true
                this.publishStatus(
                    eventBus,
                    taskId,
                    contextId,
                    TaskState.TASK_STATE_INPUT_REQUIRED,
                    outcome.reply || outcome.result?.text
                )
                return
            }
            if (outcome.kind !== 'completed') {
                this.publishStatus(
                    eventBus,
                    taskId,
                    contextId,
                    TaskState.TASK_STATE_FAILED,
                    outcome.reply || `Agent task ${outcome.kind}.`
                )
                return
            }
            this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_COMPLETED)
        } catch (error) {
            if (this.cancelled.has(taskId) || controller.signal.aborted) {
                this.publishCancelled(eventBus, taskId, contextId, taskContext)
            } else {
                this.publishStatus(
                    eventBus,
                    taskId,
                    contextId,
                    TaskState.TASK_STATE_FAILED,
                    error instanceof Error ? error.message : String(error)
                )
            }
        } finally {
            if (this.taskContexts.get(taskId) === taskContext && !taskContext.waiting) {
                this.taskContexts.delete(taskId)
            }
            if (!taskContext.waiting) this.cancelled.delete(taskId)
        }
    }

    private publishCancelled(
        eventBus: ExecutionEventBus,
        taskId: string,
        contextId: string,
        context?: TaskContext
    ) {
        if (context?.cancellationPublished) return
        if (context) context.cancellationPublished = true
        this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_CANCELED)
    }

    private identityFor(requestContext: RequestContext): SessionIdentity {
        const username = requestContext.context.user?.userName || 'anonymous'
        return {
            userId: `a2a:${username}`,
            channelId: `task:${requestContext.taskId}`,
            platform: 'a2a',
            selfId: 'agent-nexus'
        }
    }

    private publishStatus(
        eventBus: ExecutionEventBus,
        taskId: string,
        contextId: string,
        state: TaskState,
        text?: string
    ) {
        const event: TaskStatusUpdateEvent = {
            taskId,
            contextId,
            status: {
                state,
                timestamp: new Date().toISOString(),
                message: text ? statusMessage(taskId, contextId, text) : undefined
            },
            metadata: {}
        }
        eventBus.publish(AgentEvent.statusUpdate(event))
    }

    private publishResult(
        eventBus: ExecutionEventBus,
        taskId: string,
        contextId: string,
        result: AgentResult & {
            hostId: string
            published?: Array<{ path: string; url?: string; name: string; error?: string }>
        }
    ) {
        const parts: any[] = []
        if (result.text?.trim()) {
            parts.push({
                content: { $case: 'text', value: result.text.trim() },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain'
            })
        }
        for (const file of result.published || []) {
            if (!file.url) continue
            parts.push({
                content: { $case: 'url', value: file.url },
                metadata: { path: file.path },
                filename: file.name,
                mediaType: mimeFor(file.name)
            })
        }
        if (!parts.length) return
        const artifact: Artifact = {
            artifactId: randomUUID(),
            name: `${result.agent} result`,
            description: 'Result returned by the SSH-backed Code Agent.',
            parts,
            metadata: { agent: result.agent, hostId: result.hostId },
            extensions: []
        }
        const event: TaskArtifactUpdateEvent = {
            taskId,
            contextId,
            artifact,
            append: false,
            lastChunk: true,
            metadata: undefined
        }
        eventBus.publish(AgentEvent.artifactUpdate(event))
    }
}

function statusMessage(taskId: string, contextId: string, text: string) {
    return Message.fromJSON({
        messageId: randomUUID(),
        taskId,
        contextId,
        role: 'ROLE_AGENT',
        parts: [{ text, mediaType: 'text/plain' }]
    })
}

function messageText(message: Message) {
    return message.parts
        .flatMap((part) =>
            part.content?.$case === 'text' ? [part.content.value] : []
        )
        .join('\n')
        .trim()
}

function normalizeAgent(value: unknown): AgentKind | 'auto' {
    const candidate = String(value || 'auto').toLowerCase() as AgentKind | 'auto'
    return candidate === 'auto' || AGENT_KINDS.includes(candidate as AgentKind)
        ? candidate
        : 'auto'
}

function stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : undefined
}

function mimeFor(name: string) {
    if (/\.png$/i.test(name)) return 'image/png'
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
    if (/\.gif$/i.test(name)) return 'image/gif'
    if (/\.svg$/i.test(name)) return 'image/svg+xml'
    if (/\.pdf$/i.test(name)) return 'application/pdf'
    return 'application/octet-stream'
}
