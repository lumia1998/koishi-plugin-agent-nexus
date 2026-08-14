import { readFile } from 'fs/promises'
import { writeTextFileAtomic } from '../utils/atomic-file'
import type {
    DelegationContext,
    DelegationJob,
    DelegationProviderType,
    DelegationRouting,
    DelegationState
} from './types'

interface DelegationFile {
    schemaVersion: 2
    jobs: DelegationJob[]
}

interface LegacyDelegationFile {
    schemaVersion: 1
    tasks: unknown[]
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
        private readonly legacyFilePath?: string,
        private readonly maxJobs = 256
    ) {}

    async init() {
        if (this.initialized) return
        const current = await readOptional(this.filePath)
        if (current !== undefined) {
            this.loadCurrent(current)
        } else if (this.legacyFilePath) {
            const legacy = await readOptional(this.legacyFilePath)
            if (legacy !== undefined) this.loadLegacy(legacy)
        }
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

    private loadCurrent(raw: string) {
        const parsed = parseJson(raw, this.filePath)
        if (isRecord(parsed) && parsed.schemaVersion === 2 && Array.isArray(parsed.jobs)) {
            for (const value of parsed.jobs) {
                const job = normalizeJob(value)
                if (job) this.jobs.set(job.id, job)
            }
            return
        }
        if (isLegacyFile(parsed)) {
            for (const value of parsed.tasks) {
                const job = migrateLegacyDelegationJob(value)
                if (job) this.jobs.set(job.id, job)
            }
            return
        }
        throw new Error(`Invalid Delegation job file: ${this.filePath}`)
    }

    private loadLegacy(raw: string) {
        const parsed = parseJson(raw, this.legacyFilePath || 'legacy task file')
        if (!isLegacyFile(parsed)) {
            throw new Error(
                `Invalid legacy A2A task file: ${this.legacyFilePath || 'unknown'}`
            )
        }
        for (const value of parsed.tasks) {
            const job = migrateLegacyDelegationJob(value)
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

export function migrateLegacyDelegationJob(value: unknown): DelegationJob | undefined {
    if (!isRecord(value)) return undefined
    const id = stringValue(value.id)
    const remoteId = stringValue(value.remoteId)
    const remoteName = stringValue(value.remoteName)
    const parentConversationId = stringValue(value.parentConversationId)
    const legacyState = stringValue(value.state)
    if (!id || !remoteId || !remoteName || !parentConversationId) return undefined
    const state = legacyStateValue(legacyState)
    if (!state || !isRecord(value.routing)) return undefined
    const now = Date.now()
    return normalizeJob({
        ...structuredClone(value),
        schemaVersion: 2,
        provider: 'a2a',
        agentId: remoteId,
        agentName: remoteName,
        remoteId,
        remoteName,
        state,
        providerState: {
            ...(stringValue(value.a2aTaskId)
                ? { taskId: stringValue(value.a2aTaskId) }
                : {}),
            ...(stringValue(value.contextId)
                ? { contextId: stringValue(value.contextId) }
                : {}),
            ...(stringValue(value.remoteState)
                ? { remoteState: stringValue(value.remoteState) }
                : {})
        },
        createdAt: finiteNumber(value.createdAt, now),
        updatedAt: finiteNumber(value.updatedAt, now),
        startedAt: finiteNumber(value.startedAt, now),
        expiresAt: finiteNumber(value.expiresAt, now + 24 * 60 * 60 * 1000)
    })
}

function normalizeJob(value: unknown): DelegationJob | undefined {
    if (!isRecord(value)) return undefined
    const provider = providerValue(value.provider)
    const state = stateValue(value.state)
    const id = stringValue(value.id)
    const remoteId = stringValue(value.remoteId)
    const remoteName = stringValue(value.remoteName)
    const agentId = stringValue(value.agentId) || remoteId
    const agentName = stringValue(value.agentName) || remoteName
    const parentConversationId = stringValue(value.parentConversationId)
    if (
        value.schemaVersion !== 2 ||
        !provider ||
        !state ||
        !id ||
        !remoteId ||
        !remoteName ||
        !agentId ||
        !agentName ||
        !parentConversationId ||
        !isRecord(value.routing)
    ) {
        return undefined
    }
    const now = Date.now()
    return {
        schemaVersion: 2,
        id,
        provider,
        agentId,
        agentName,
        remoteId,
        remoteName,
        providerAgentId: optionalString(value.providerAgentId),
        parentConversationId,
        source: value.source === 'character' ? 'character' : 'chatluna',
        routing: structuredClone(value.routing) as unknown as DelegationRouting,
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
        activeRunId: optionalString(value.activeRunId),
        notifiedRunId: optionalString(value.notifiedRunId),
        createdAt: finiteNumber(value.createdAt, now),
        updatedAt: finiteNumber(value.updatedAt, now),
        startedAt: finiteNumber(value.startedAt, now),
        endedAt: optionalFiniteNumber(value.endedAt),
        expiresAt: finiteNumber(value.expiresAt, now + 24 * 60 * 60 * 1000)
    }
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

function isLegacyFile(value: unknown): value is LegacyDelegationFile {
    return Boolean(
        isRecord(value) &&
            value.schemaVersion === 1 &&
            Array.isArray(value.tasks)
    )
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function providerValue(value: unknown): DelegationProviderType | undefined {
    return value === 'a2a' || value === 'gateway' ? value : undefined
}

function stateValue(value: unknown): DelegationState | undefined {
    return typeof value === 'string' && VALID_STATES.has(value as DelegationState)
        ? (value as DelegationState)
        : undefined
}

function legacyStateValue(value: string): DelegationState | undefined {
    if (value === 'waiting_input') return 'input_required'
    return stateValue(value)
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
    const text = stringValue(value)
    return text || undefined
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
