import { readFile } from 'fs/promises'
import { writeTextFileAtomic } from '../utils/atomic-file'
import type {
    DelegationContext,
    DelegationJob,
    DelegationRouting,
    DelegationState
} from './types'

interface DelegationFile {
    schemaVersion: 2
    jobs: DelegationJob[]
}

const VALID_STATES = new Set<DelegationState>([
    'running',
    'input_required',
    'permission_required',
    'completed',
    'failed',
    'canceled'
])

export class DelegationStore {
    private jobs = new Map<string, DelegationJob>()
    private initialized = false
    private writeQueue = Promise.resolve()

    constructor(
        private readonly filePath: string,
        private readonly maxJobs = 256
    ) {}

    async init() {
        if (this.initialized) return
        const current = await readOptional(this.filePath)
        if (current !== undefined) this.load(current)
        this.prune(Date.now())
        this.initialized = true
        await this.persist()
    }

    async save(job: DelegationJob) {
        await this.ensureInitialized()
        const copy = structuredClone(job)
        this.prune(Date.now())
        if (!this.jobs.has(copy.id) && this.jobs.size >= this.maxJobs) {
            const oldestTerminal = Array.from(this.jobs.entries()).find(
                ([, item]) => !isActive(item.state)
            )
            if (!oldestTerminal) throw new Error('Delegation job limit reached')
            this.jobs.delete(oldestTerminal[0])
        }
        this.jobs.delete(copy.id)
        this.jobs.set(copy.id, copy)
        this.prune(Date.now())
        await this.persist()
        return structuredClone(copy)
    }

    async get(id: string) {
        await this.ensureInitialized()
        const job = this.jobs.get(id)
        return job ? structuredClone(job) : undefined
    }

    async list(parentConversationId?: string) {
        await this.ensureInitialized()
        return Array.from(this.jobs.values())
            .filter(
                (job) =>
                    !parentConversationId ||
                    job.parentConversationId === parentConversationId
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .map((job) => structuredClone(job))
    }

    async flush() {
        await this.writeQueue
    }

    private load(raw: string) {
        const parsed = parseJson(raw, this.filePath)
        if (
            !isRecord(parsed) ||
            parsed.schemaVersion !== 2 ||
            !Array.isArray(parsed.jobs)
        ) {
            throw new Error(`Invalid Delegation job file: ${this.filePath}`)
        }
        for (const value of parsed.jobs) {
            const job = normalizeJob(value)
            if (job) this.jobs.set(job.id, job)
        }
    }

    private async ensureInitialized() {
        if (!this.initialized) await this.init()
    }

    private prune(now: number) {
        for (const [id, job] of this.jobs) {
            if (!isActive(job.state) && job.expiresAt <= now) this.jobs.delete(id)
        }
        while (this.jobs.size > this.maxJobs) {
            const terminal = Array.from(this.jobs.entries()).find(
                ([, job]) => !isActive(job.state)
            )
            if (!terminal) break
            this.jobs.delete(terminal[0])
        }
    }

    private persist() {
        const write = async () => {
            const payload: DelegationFile = {
                schemaVersion: 2,
                jobs: Array.from(this.jobs.values())
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

function normalizeJob(value: unknown): DelegationJob | undefined {
    if (!isRecord(value)) return undefined
    const state = stateValue(value.state)
    const id = stringValue(value.id)
    const remoteId = stringValue(value.remoteId)
    const remoteName = stringValue(value.remoteName)
    const agentId = stringValue(value.agentId) || remoteId
    const agentName = stringValue(value.agentName) || remoteName
    const parentConversationId = optionalString(value.parentConversationId)
    if (
        value.schemaVersion !== 2 ||
        value.provider !== 'gateway' ||
        !state ||
        !id ||
        !remoteId ||
        !remoteName ||
        !agentId ||
        !agentName ||
        (value.routing !== undefined && !isRecord(value.routing))
    ) {
        return undefined
    }
    const now = Date.now()
    return {
        schemaVersion: 2,
        id,
        provider: 'gateway',
        agentId,
        agentName,
        toolName: optionalString(value.toolName),
        remoteId,
        remoteName,
        providerAgentId: optionalString(value.providerAgentId),
        parentConversationId,
        source: value.source === 'character' ? 'character' : 'chatluna',
        routing: isRecord(value.routing)
            ? (structuredClone(value.routing) as unknown as DelegationRouting)
            : undefined,
        state,
        background: value.background !== false,
        prompt: stringValue(value.prompt),
        skill: optionalString(value.skill),
        providerState: isRecord(value.providerState)
            ? structuredClone(value.providerState)
            : {},
        remoteState: optionalString(value.remoteState),
        output: optionalString(value.output),
        error: optionalString(value.error),
        pollError: optionalString(value.pollError),
        artifacts: Array.isArray(value.artifacts)
            ? structuredClone(value.artifacts)
            : [],
        pendingRequest: normalizePendingRequest(value.pendingRequest),
        queuedMessages: normalizeQueuedMessages(value.queuedMessages),
        activeRunId: optionalString(value.activeRunId),
        notifiedRunId: optionalString(value.notifiedRunId),
        notificationAttempts: optionalFiniteNumber(value.notificationAttempts),
        notificationNextAt: optionalFiniteNumber(value.notificationNextAt),
        createdAt: finiteNumber(value.createdAt, now),
        updatedAt: finiteNumber(value.updatedAt, now),
        startedAt: finiteNumber(value.startedAt, now),
        endedAt: optionalFiniteNumber(value.endedAt),
        expiresAt: finiteNumber(value.expiresAt, now + 24 * 60 * 60 * 1000)
    }
}

function normalizePendingRequest(value: unknown) {
    if (!isRecord(value)) return undefined
    const id = stringValue(value.id)
    const prompt = stringValue(value.prompt)
    const kind = value.kind
    if (!id || !prompt || (kind !== 'permission' && kind !== 'input')) {
        return undefined
    }
    const options = Array.isArray(value.options)
        ? value.options
              .filter(isRecord)
              .map((item) => ({
                  id: stringValue(item.id),
                  name: stringValue(item.name),
                  kind: optionalString(item.kind)
              }))
              .filter((item) => item.id && item.name)
        : undefined
    return {
        id,
        kind,
        prompt,
        ...(options?.length ? { options } : {})
    }
}

function normalizeQueuedMessages(value: unknown) {
    if (!Array.isArray(value)) return undefined
    const messages = value.map(stringValue).filter(Boolean).slice(0, 16)
    return messages.length ? messages : undefined
}

function parseJson(raw: string, filePath: string) {
    try {
        return JSON.parse(raw) as unknown
    } catch (error) {
        throw new Error(
            `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

async function readOptional(filePath: string) {
    try {
        return await readFile(filePath, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stateValue(value: unknown): DelegationState | undefined {
    return typeof value === 'string' && VALID_STATES.has(value as DelegationState)
        ? (value as DelegationState)
        : undefined
}

function isActive(state: DelegationState) {
    return (
        state === 'running' ||
        state === 'input_required' ||
        state === 'permission_required'
    )
}

function stringValue(value: unknown) {
    return typeof value === 'string' ? value : ''
}

function optionalString(value: unknown) {
    return stringValue(value) || undefined
}

function finiteNumber(value: unknown, fallback: number) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
}

function optionalFiniteNumber(value: unknown) {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
}

export type {
    DelegationContext,
    DelegationJob,
    DelegationRouting,
    DelegationState
} from './types'
