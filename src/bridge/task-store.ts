import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { Task, TaskState } from '@a2a-js/sdk'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import {
    moveCorruptFileAside,
    writeTextFileAtomic
} from '../utils/atomic-file'

type ListParams = Parameters<TaskStore['list']>[0]
type ListResult = Awaited<ReturnType<TaskStore['list']>>

interface StoredTask {
    scope: string
    task: Task
}

interface StoredTaskFile {
    schemaVersion: 1
    items: Array<{
        scope: string
        task: unknown
    }>
}

export class BoundedTaskStore implements TaskStore {
    private items = new Map<string, StoredTask>()
    private initialized = false
    private writeQueue = Promise.resolve()

    constructor(
        private readonly maxTasks = 256,
        private readonly filePath?: string
    ) {}

    async init() {
        if (this.initialized) return
        if (this.filePath) {
            try {
                const raw = await readFile(this.filePath, 'utf8')
                const parsed = JSON.parse(raw) as Partial<StoredTaskFile>
                if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) {
                    throw new Error('invalid bridge A2A task store')
                }
                for (const item of parsed.items) {
                    if (!item || typeof item.scope !== 'string') continue
                    const task = Task.fromJSON(item.task as any)
                    if (!task.id) continue
                    const scope = item.scope
                    this.items.set(taskKey(scope, task.id), { scope, task })
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    await moveCorruptFileAside(this.filePath)
                }
                this.items.clear()
            }
        }
        this.trim()
        this.markInterruptedTasks()
        this.initialized = true
        await this.persist()
    }

    async save(task: Task, context: ServerCallContext) {
        await this.ensureInitialized()
        const scope = contextScope(context)
        const key = taskKey(scope, task.id)
        this.items.delete(key)
        this.items.set(key, { scope, task: cloneTask(task) })
        this.trim()
        await this.persist()
    }

    async load(taskId: string, context: ServerCallContext) {
        await this.ensureInitialized()
        const item = this.items.get(taskKey(contextScope(context), taskId))
        return item ? cloneTask(item.task) : undefined
    }

    async list(params: ListParams, context: ServerCallContext): Promise<ListResult> {
        await this.ensureInitialized()
        const scope = contextScope(context)
        let tasks = Array.from(this.items.values())
            .filter((item) => item.scope === scope)
            .map((item) => item.task)
        if (params.contextId) {
            tasks = tasks.filter((task) => task.contextId === params.contextId)
        }
        if (params.status !== undefined) {
            tasks = tasks.filter((task) => task.status?.state === params.status)
        }
        if (params.statusTimestampAfter) {
            const threshold = new Date(params.statusTimestampAfter).getTime()
            tasks = tasks.filter((task) => {
                const timestamp = task.status?.timestamp
                return timestamp && new Date(timestamp).getTime() > threshold
            })
        }
        tasks.sort((left, right) => {
            const a = left.status?.timestamp || ''
            const b = right.status?.timestamp || ''
            return b.localeCompare(a) || right.id.localeCompare(left.id)
        })
        const totalSize = tasks.length
        if (params.pageToken) {
            const [timestamp, ...idParts] = Buffer.from(
                params.pageToken,
                'base64'
            )
                .toString('utf8')
                .split('|')
            const id = idParts.join('|')
            if (!id) throw new Error('Invalid A2A task page token')
            const index = tasks.findIndex(
                (task) =>
                    (task.status?.timestamp || '') === timestamp &&
                    task.id === id
            )
            tasks = index >= 0 ? tasks.slice(index + 1) : []
        }
        const pageSize = Math.min(100, Math.max(1, params.pageSize || 50))
        const page = tasks.slice(0, pageSize).map((task) => {
            const copy = cloneTask(task)
            if (!params.includeArtifacts) copy.artifacts = []
            return copy
        })
        const last = page.at(-1)
        const nextPageToken =
            last && tasks.length > page.length
                ? Buffer.from(
                      `${last.status?.timestamp || ''}|${last.id}`,
                      'utf8'
                  ).toString('base64')
                : ''
        return {
            tasks: page,
            nextPageToken,
            pageSize,
            totalSize
        }
    }

    async flush() {
        await this.writeQueue
    }

    private async ensureInitialized() {
        if (!this.initialized) await this.init()
    }

    private trim() {
        while (this.items.size > this.maxTasks) {
            const oldest = this.items.keys().next().value as string | undefined
            if (!oldest) break
            this.items.delete(oldest)
        }
    }

    private markInterruptedTasks() {
        const now = new Date().toISOString()
        for (const [key, item] of this.items) {
            const state = item.task.status?.state
            if (
                state !== TaskState.TASK_STATE_SUBMITTED &&
                state !== TaskState.TASK_STATE_WORKING
            ) {
                continue
            }
            const raw = Task.toJSON(item.task) as any
            raw.status = {
                state: 'TASK_STATE_INPUT_REQUIRED',
                timestamp: now,
                message: {
                    messageId: randomUUID(),
                    taskId: item.task.id,
                    contextId: item.task.contextId,
                    role: 'ROLE_AGENT',
                    parts: [
                        {
                            text: 'AgentNexus Bridge restarted while this task was running. Send a follow-up message to retry/resume it, or cancel the task.',
                            mediaType: 'text/plain'
                        }
                    ]
                }
            }
            this.items.set(key, {
                scope: item.scope,
                task: Task.fromJSON(raw)
            })
        }
    }

    private persist() {
        if (!this.filePath) return Promise.resolve()
        const write = async () => {
            const payload: StoredTaskFile = {
                schemaVersion: 1,
                items: Array.from(this.items.values()).map((item) => ({
                    scope: item.scope,
                    task: Task.toJSON(item.task)
                }))
            }
            await writeTextFileAtomic(
                this.filePath!,
                `${JSON.stringify(payload, null, 2)}\n`
            )
        }
        const next = this.writeQueue.then(write, write)
        this.writeQueue = next.catch(() => undefined)
        return next
    }
}

function cloneTask(task: Task) {
    return Task.fromJSON(Task.toJSON(task))
}

function contextScope(context: ServerCallContext) {
    const user = context.user as
        | { isAuthenticated?: boolean; userName?: string }
        | undefined
    const owner = user?.isAuthenticated
        ? `user:${user.userName || 'authenticated'}`
        : 'anonymous'
    return JSON.stringify([String(context.tenant || ''), owner])
}

function taskKey(scope: string, taskId: string) {
    return `${scope}\0${taskId}`
}
