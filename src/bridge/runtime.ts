import path from 'path'
import { FileSessionStorage } from '../sessions/file-storage'
import { SessionManager } from '../sessions/manager'
import type { SessionIdentity } from '../sessions/types'
import {
    AgentRunner,
    type SessionInvocationContext,
    type SessionRunOutcome
} from '../runtime/runner'
import type { DelegateInput } from '../types'
import { NexusA2AExecutor, type NexusA2AExecutionService } from '../a2a/executor'
import type { BridgeConfig } from './config'
import { BridgeArtifactRegistry } from './artifacts'
import { LocalAgentExecutor, detectLocalAgents } from './local-executor'

export class BridgeRuntime implements NexusA2AExecutionService {
    readonly a2aExecutor: NexusA2AExecutor
    readonly artifacts: BridgeArtifactRegistry
    readonly sessionManager: SessionManager
    readonly detectedAgents
    private readonly runner: AgentRunner

    private constructor(
        readonly config: BridgeConfig,
        storage: FileSessionStorage,
        detected: Awaited<ReturnType<typeof detectLocalAgents>>
    ) {
        this.detectedAgents = detected
        this.artifacts = new BridgeArtifactRegistry(
            config.cwd,
            config.artifactTtlMs,
            config.maxArtifactBytes,
            config.maxArtifacts
        )
        this.sessionManager = new SessionManager(storage, {
            historyRetentionMs: config.sessionHistoryRetentionMs
        })
        const local = new LocalAgentExecutor(config, detected, this.artifacts)
        this.runner = new AgentRunner(this.sessionManager, (input) => local.execute(input))
        this.a2aExecutor = new NexusA2AExecutor(this, {
            maxConcurrentTasks: config.maxConcurrentTasks,
            maxTrackedTasks: config.maxTrackedTasks
        })
    }

    static async create(config: BridgeConfig) {
        const storage = new FileSessionStorage(path.join(config.dataDir, 'sessions.json'))
        await storage.init()
        const detected = await detectLocalAgents(config)
        const runtime = new BridgeRuntime(config, storage, detected)
        await runtime.sessionManager.recoverTasks()
        return runtime
    }

    runInSession(
        identity: SessionIdentity,
        input: DelegateInput,
        context?: SessionInvocationContext
    ): Promise<SessionRunOutcome> {
        return this.runner.run(
            identity,
            { ...input, hostId: 'local', sessionMode: input.sessionMode ?? 'managed' },
            context
        )
    }

    async runInContextSession(
        identity: SessionIdentity,
        input: DelegateInput,
        context?: SessionInvocationContext
    ): Promise<SessionRunOutcome> {
        const resumed = await this.runner.resume(
            identity,
            input.prompt,
            input.signal,
            context
        )
        if (resumed.kind !== 'not_found') return resumed

        const { prompt: _prompt, signal: _signal, ...execution } = input
        await this.runner.startInteractive(
            identity,
            {
                ...execution,
                hostId: 'local',
                sessionMode: 'managed'
            },
            this.config.sessionHistoryRetentionMs
        )
        return this.runner.resume(identity, input.prompt, input.signal, context)
    }

    cancelSessions(identity: SessionIdentity) {
        return this.runner.cancel(identity)
    }

    async shutdown() {
        await this.runner.shutdown(5000, true)
        await this.a2aExecutor.shutdown({ preserveForRestart: true })
    }
}
