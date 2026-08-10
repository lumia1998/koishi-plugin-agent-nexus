import { readFile } from 'fs/promises'
import type { AgentKind, A2ATaskView } from '../types'
import {
    moveCorruptFileAside,
    writeTextFileAtomic
} from '../utils/atomic-file'

export type A2ADelegationState =
    | 'running'
    | 'waiting_input'
    | 'completed'
    | 'failed'
    | 'canceled'

export interface A2ADelegationRouting {
    platform: string
    selfId: string
    userId: string
    username?: string
    guildId?: string
    channelId?: string
    isDirect: boolean
}

export interface A2ADelegationContext {
    parentConversationId: string
    source: 'chatluna' | 'character'
    routing: A2ADelegationRouting
}

export interface A2ADelegationTask {
    schemaVersion: 1
    id: string
    remoteId: string
    remoteName: string
    parentConversationId: string
    source: 'chatluna' | 'character'
    routing: A2ADelegationRouting
    state: A2ADelegationState
    background: boolean
    prompt: string
    skill?: string
    agent?: AgentKind | 'auto'
    a2aTaskId?: string
    contextId?: string
    remoteState?: string
    output?: string
    error?: string
    pollError?: string
    artifacts: A2ATaskView['artifacts']
    activeRunId?: string
    notifiedRunId?: string
    createdAt: number
    updatedAt: number
    startedAt: number
    endedAt?: number
    expiresAt: number
}

interface A2ADelegationFile {
    schemaVersion: 1
    tasks: A2ADelegationTask[]
}

const VALID_STATES = new Set<A2ADelegationState>([
    'running',
    'waiting_input',
    'completed',
    'failed',
    'canceled'
])

export class A2ADelegationStore {
    private tasks = new Map<string, A2ADelegationTask>()
    private initialized = false
    private writeQueue = Promise.resolve()

    constructor(
        private readonly filePath: string,
        private readonly maxTasks = 256
    ) {}

    async init() {
        if (this.initialized) return
        try {
            const raw = await readFile(this.filePath, 'utf8')
            const parsed = JSON.parse(raw) as Partial<A2ADelegationFile>
            if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
                throw new Error('invalid A2A delegation task file')
            }
            for (const value of parsed.tasks) {
                const task = normalizeTask(value)
                if (!task) continue
                this.tasks.set(task.id, task)
            }
            this.prune(Date.now())
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                await moveCorruptFileAside(this.filePath)
            }
            this.tasks.clear()
        }
        this.initialized = true
        await this.persist()
    }

    async save(task: A2ADelegationTask) {
        await this.ensureInitialized()
        const copy = structuredClone(task)
        this.prune(Date.now())
        if (!this.tasks.has(copy.id) && this.tasks.size >= this.maxTasks) {
            const oldestTerminal = Array.from(this.tasks.entries()).find(
                ([, item]) => item.state !== 'running'
            )
            if (!oldestTerminal) {
                throw new Error('A2A delegation task limit reached')
            }
            this.tasks.delete(oldestTerminal[0])
        }
        this.tasks.delete(copy.id)
        this.tasks.set(copy.id, copy)
        this.prune(Date.now())
        await this.persist()
        return structuredClone(copy)
    }

    async get(id: string) {
        await this.ensureInitialized()
        const task = this.tasks.get(id)
        return task ? structuredClone(task) : undefined
    }

    async list(parentConversationId?: string) {
        await this.ensureInitialized()
        return Array.from(this.tasks.values())
            .filter(
                (task) =>
                    !parentConversationId ||
                    task.parentConversationId === parentConversationId
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .map((task) => structuredClone(task))
    }

    async flush() {
        await this.writeQueue
    }

    private async ensureInitialized() {
        if (!this.initialized) await this.init()
    }

    private prune(now: number) {
        for (const [id, task] of this.tasks) {
            if (task.state !== 'running' && task.expiresAt <= now) {
                this.tasks.delete(id)
            }
        }
        while (this.tasks.size > this.maxTasks) {
            const terminal = Array.from(this.tasks.entries()).find(
                ([, task]) => task.state !== 'running'
            )
            if (!terminal) break
            this.tasks.delete(terminal[0])
        }
    }

    private persist() {
        const write = async () => {
            const payload: A2ADelegationFile = {
                schemaVersion: 1,
                tasks: Array.from(this.tasks.values())
            }
            await writeTextFileAtomic(
                this.filePath,
                `${JSON.stringify(payload, null, 2)}\n`
            )
        }
        const next = this.writeQueue.then(write, write)
        this.writeQueue = next.catch(() => undefined)
        return next
    }
}

function normalizeTask(value: unknown): A2ADelegationTask | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }
    const task = value as Partial<A2ADelegationTask>
    if (
        task.schemaVersion !== 1 ||
        !stringValue(task.id) ||
        !stringValue(task.remoteId) ||
        !stringValue(task.remoteName) ||
        !stringValue(task.parentConversationId) ||
        !task.state ||
        !VALID_STATES.has(task.state) ||
        !task.routing ||
        typeof task.routing !== 'object'
    ) {
        return undefined
    }
    const now = Date.now()
    return {
        ...structuredClone(task as A2ADelegationTask),
        schemaVersion: 1,
        background: task.background !== false,
        prompt: stringValue(task.prompt),
        artifacts: Array.isArray(task.artifacts)
            ? structuredClone(task.artifacts)
            : [],
        createdAt: finiteNumber(task.createdAt, now),
        updatedAt: finiteNumber(task.updatedAt, now),
        startedAt: finiteNumber(task.startedAt, now),
        expiresAt: finiteNumber(task.expiresAt, now + 24 * 60 * 60 * 1000)
    }
}

function stringValue(value: unknown) {
    return typeof value === 'string' ? value : ''
}

function finiteNumber(value: unknown, fallback: number) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
}
