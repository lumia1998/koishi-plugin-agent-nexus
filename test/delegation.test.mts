import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    DelegationManager,
    DelegationProviderRegistry,
    DelegationStore,
    type DelegationContext,
    type DelegationJob,
    type DelegationProvider,
    type RemoteAgentInfo
} from '../src/delegation/index.ts'

test('migrates legacy A2A tasks into schema v2 without deleting the legacy file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-migration-'))
    const legacy = path.join(directory, 'a2a-tasks.json')
    const current = path.join(directory, 'delegation-jobs.json')
    const now = Date.now()
    await writeFile(
        legacy,
        JSON.stringify({
            schemaVersion: 1,
            tasks: [
                {
                    schemaVersion: 1,
                    id: 'legacy-job',
                    remoteId: 'hermes',
                    remoteName: 'Hermes',
                    parentConversationId: 'conversation-1',
                    source: 'chatluna',
                    routing: context().routing,
                    state: 'waiting_input',
                    background: true,
                    prompt: 'test',
                    a2aTaskId: 'a2a-task',
                    contextId: 'a2a-context',
                    artifacts: [],
                    createdAt: now,
                    updatedAt: now,
                    startedAt: now,
                    expiresAt: now + 60_000
                }
            ]
        })
    )
    try {
        const store = new DelegationStore(current, legacy, 8)
        await store.init()
        const job = await store.get('legacy-job')
        assert.equal(job?.schemaVersion, 2)
        assert.equal(job?.provider, 'a2a')
        assert.equal(job?.state, 'input_required')
        assert.equal(job?.providerState.taskId, 'a2a-task')
        assert.equal(job?.providerState.contextId, 'a2a-context')
        assert.equal(JSON.parse(await readFile(legacy, 'utf8')).schemaVersion, 1)
        assert.equal(JSON.parse(await readFile(current, 'utf8')).schemaVersion, 2)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('stops initialization when the legacy task file is corrupt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-corrupt-migration-'))
    const legacy = path.join(directory, 'a2a-tasks.json')
    const current = path.join(directory, 'delegation-jobs.json')
    await writeFile(legacy, '{broken json')
    try {
        const store = new DelegationStore(current, legacy, 8)
        await assert.rejects(() => store.init(), /Invalid JSON/)
        assert.equal(await readFile(legacy, 'utf8'), '{broken json')
        await assert.rejects(() => readFile(current, 'utf8'), /ENOENT/)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('routes each configured agent through its selected A2A or ACP provider', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-provider-'))
    const calls: string[] = []
    const a2a = provider('a2a', agent('hermes', 'a2a'), calls)
    const gateway = provider('gateway', agent('opencode', 'gateway'), calls)
    const manager = new DelegationManager(
        new DelegationStore(path.join(directory, 'jobs.json'), undefined, 8),
        new DelegationProviderRegistry().register(a2a).register(gateway),
        async () => undefined,
        { pollIntervalMs: 1 }
    )
    try {
        await manager.start()
        const hermes = await manager.handle(
            { action: 'run', remote: 'hermes', prompt: 'A2A task' },
            context()
        )
        const opencode = await manager.handle(
            { action: 'run', remote: 'opencode', prompt: 'ACP task' },
            context()
        )
        assert.match(hermes, /Connection: A2A/)
        assert.match(opencode, /Connection: Nexus Gateway \+ ACP/)
        assert.deepEqual(calls, ['a2a:hermes', 'gateway:opencode'])
    } finally {
        await manager.stop()
        await rm(directory, { recursive: true, force: true })
    }
})

test('keeps old jobs on their original provider when an agent route changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-route-change-'))
    let route: 'a2a' | 'gateway' = 'a2a'
    const calls: Array<{
        provider: 'a2a' | 'gateway'
        agentId: string
        providerState: Record<string, unknown>
    }> = []
    const explicitA2A = {
        ...agent('shared-agent', 'a2a'),
        remoteId: 'a2a-remote',
        remoteName: 'A2A remote'
    }
    const implicitA2A = {
        ...explicitA2A,
        id: 'a2a-remote'
    }
    const gatewayAgent = {
        ...agent('shared-agent', 'gateway'),
        remoteId: 'gateway-remote',
        remoteName: 'Gateway remote',
        workspace: '/workspace/new'
    }
    const a2a: DelegationProvider = {
        type: 'a2a',
        listAgents: () => (route === 'a2a' ? [explicitA2A] : [implicitA2A]),
        async run(_agent, job) {
            calls.push({
                provider: 'a2a',
                agentId: job.agentId,
                providerState: structuredClone(job.providerState)
            })
            return result('a2a')
        },
        async message(_agent, job) {
            calls.push({
                provider: 'a2a',
                agentId: job.agentId,
                providerState: structuredClone(job.providerState)
            })
            return result('a2a')
        },
        async status() {
            return result('a2a')
        },
        async cancel() {
            return { ...result('a2a'), state: 'canceled' }
        }
    }
    const gateway: DelegationProvider = {
        type: 'gateway',
        listAgents: () => (route === 'gateway' ? [gatewayAgent] : []),
        async run(_agent, job) {
            calls.push({
                provider: 'gateway',
                agentId: job.agentId,
                providerState: structuredClone(job.providerState)
            })
            return {
                ...result('gateway'),
                providerState: {
                    gatewaySessionId: 'session-1',
                    acpSessionId: 'acp-1',
                    agentId: 'shared-agent',
                    workspace: '/workspace/new'
                }
            }
        },
        async message() {
            return result('gateway')
        },
        async status() {
            return result('gateway')
        },
        async cancel() {
            return { ...result('gateway'), state: 'canceled' }
        }
    }
    const manager = new DelegationManager(
        new DelegationStore(path.join(directory, 'jobs.json'), undefined, 8),
        new DelegationProviderRegistry().register(a2a).register(gateway),
        async () => undefined,
        { pollIntervalMs: 1 }
    )
    try {
        await manager.start()
        const first = await manager.handle(
            { action: 'run', remote: 'shared-agent', prompt: 'Use A2A' },
            context()
        )
        const oldJobId = jobId(first)
        route = 'gateway'
        const second = await manager.handle(
            { action: 'run', remote: 'shared-agent', prompt: 'Use ACP' },
            context()
        )
        assert.match(second, /Connection: Nexus Gateway \+ ACP/)
        assert.deepEqual(calls[1].providerState, {})

        const continued = await manager.handle(
            { action: 'run', id: oldJobId, prompt: 'Continue old A2A context' },
            context()
        )
        assert.match(continued, /Connection: A2A/)
        assert.equal(calls[2].provider, 'a2a')
        assert.equal(calls[2].agentId, 'shared-agent')
        assert.equal(calls[2].providerState.contextId, 'context-1')
    } finally {
        await manager.stop()
        await rm(directory, { recursive: true, force: true })
    }
})

test('polls background gateway jobs and wakes ChatLuna for permission input', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-gateway-wakeup-'))
    const remote = agent('opencode', 'gateway')
    let finishNotification!: (job: DelegationJob) => void
    const notification = new Promise<DelegationJob>((resolve) => {
        finishNotification = resolve
    })
    const gateway: DelegationProvider = {
        type: 'gateway',
        listAgents: () => [remote],
        async run() {
            return {
                state: 'running',
                remoteState: 'running',
                artifacts: [],
                providerState: { gatewaySessionId: 'session-1' }
            }
        },
        async message() {
            throw new Error('not used')
        },
        async status(_agent, job) {
            return {
                state: 'permission_required',
                remoteState: 'permission_required',
                text: 'Allow writing package.json?\n\nOptions:\n1. Allow once (allow)',
                artifacts: [],
                providerState: structuredClone(job.providerState)
            }
        },
        async cancel() {
            return {
                state: 'canceled',
                remoteState: 'canceled',
                artifacts: [],
                providerState: { gatewaySessionId: 'session-1' }
            }
        }
    }
    const manager = new DelegationManager(
        new DelegationStore(path.join(directory, 'jobs.json'), undefined, 8),
        new DelegationProviderRegistry().register(gateway),
        async (job) => finishNotification(structuredClone(job)),
        { pollIntervalMs: 1 }
    )
    try {
        await manager.start()
        const started = await manager.handle(
            { action: 'run', remote: 'opencode', prompt: 'Edit package.json' },
            context()
        )
        assert.match(started, /State: running/)
        const notified = await Promise.race([
            notification,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('notification timeout')), 1000)
            )
        ])
        assert.equal(notified.provider, 'gateway')
        assert.equal(notified.state, 'permission_required')
        assert.match(notified.output || '', /Allow once/)
    } finally {
        await manager.stop()
        await rm(directory, { recursive: true, force: true })
    }
})

function provider(
    type: 'a2a' | 'gateway',
    remote: RemoteAgentInfo,
    calls: string[]
): DelegationProvider {
    return {
        type,
        listAgents: () => [remote],
        async run(_agent, job) {
            calls.push(`${type}:${job.agentId}`)
            return result(type)
        },
        async message() {
            return result(type)
        },
        async status() {
            return result(type)
        },
        async cancel() {
            return {
                ...result(type),
                state: 'canceled'
            }
        }
    }
}

function result(type: 'a2a' | 'gateway') {
    return {
        state: 'completed' as const,
        remoteState: 'completed',
        text: `${type} complete`,
        artifacts: [],
        providerState:
            type === 'a2a'
                ? { taskId: 'task-1', contextId: 'context-1' }
                : { gatewaySessionId: 'session-1', acpSessionId: 'acp-1' }
    }
}

function agent(id: string, providerType: 'a2a' | 'gateway'): RemoteAgentInfo {
    return {
        id,
        name: id,
        provider: providerType,
        remoteId: `${id}-remote`,
        remoteName: `${id}-remote`,
        agentId: providerType === 'gateway' ? id : undefined,
        workspace: providerType === 'gateway' ? '/workspace' : undefined,
        enabled: true,
        state: 'ready',
        skills: []
    }
}

function context(): DelegationContext {
    return {
        parentConversationId: 'conversation-1',
        source: 'chatluna',
        routing: {
            platform: 'test',
            selfId: 'bot',
            userId: 'user',
            isDirect: true
        }
    }
}

function jobId(value: string) {
    const match = value.match(/AgentNexus job: ([^\s]+)/)
    assert.ok(match, `missing job id in output: ${value}`)
    return match[1]
}
