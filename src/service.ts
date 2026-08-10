import { randomBytes, randomUUID } from 'crypto'
import { Context, Service } from 'koishi'
import path from 'path'
import type {
    A2AConfig,
    A2ARemoteConfig,
    A2ARemoteStatus,
    A2ATaskView,
    AgentKind,
    AgentMaintenanceInput,
    AgentMaintenanceResult,
    AgentResult,
    BridgeHostStatus,
    BridgeMaintenanceInput,
    BridgeMaintenanceResult,
    DelegateInput,
    DetectedAgent,
    HostStatus,
    NexusConfig,
    NexusConsoleData,
    NexusStatus,
    PublishResult,
    SkillInfo,
    SkillSourceConfig,
    SshHostConfig,
    TerminalInfo
} from './types'
import type {
    NexusSession,
    SessionHistoryQuery,
    SessionIdentity
} from './sessions/types'
import { createDefaultNexusConfig, createHost } from './config'
import { SshSessionPool } from './ssh/pool'
import type { SshSession, TerminalHandle } from './ssh/session'
import { getAdapter, listAdapters } from './adapters'
import {
    appendFileHint,
    enabledAgentKinds,
    listRemoteSkills,
    syncSkillSource
} from './skills/sync'
import { NexusTerminalProxy } from './proxy'
import { NexusDelegateTool } from './tools/delegate'
import { NexusPublishTool } from './tools/publish'
import { NexusListAgentsTool } from './tools/list_agents'
import { NexusListSkillsTool } from './tools/list_skills'
import { NexusA2AListTool } from './tools/a2a_list'
import { NexusA2ASendTool } from './tools/a2a_send'
import { NexusA2ATaskTool } from './tools/a2a_task'
import { getErrorMessage } from './utils/shell'
import {
    buildRemoteRealpathCommand,
    isRemotePathWithinRoot
} from './utils/security'
import {
    assertUniqueHostName,
    hostConnectionChanged,
    mergeA2ASecrets,
    mergeHostSecrets,
    normalizeHostName,
    patchHostConfig,
    redactNexusConfig,
    repairHostIds,
    resolveHostReference
} from './utils/config'
import { registerNexusCommands } from './commands'
import type { Config } from './config'
import { FileSessionStorage } from './sessions/file-storage'
import { SessionManager } from './sessions/manager'
import {
    buildSummaryPrompt,
    fallbackSummary,
    parseModelSummary
} from './sessions/summary'
import {
    AgentRunner,
    type SessionInvocationContext,
    type SessionRunOutcome
} from './runtime/runner'
import { SftpFileManager } from './files/manager'
import { A2AClientService, validateRemoteUrl } from './a2a/client'
import {
    buildAgentLatestVersionCommand,
    buildAgentMaintenancePlan,
    isVersionNewer,
    latestAgentVersion,
    parseHomebrewClaudeVersion,
    validateAgentMaintenanceVersion
} from './agents/maintenance'
import {
    bridgePublicBaseUrl,
    buildBridgeMaintenancePlan,
    buildBridgeStatusCommand,
    parseBridgeStatus
} from './bridge/maintenance'

interface ManagedTerminal {
    terminal: TerminalHandle
    token: string
    hostId: string
    persistent: boolean
    expiresAt: number
    attached: boolean
    expiryTimer?: NodeJS.Timeout
}

export class AgentNexusService extends Service {
    static readonly inject = ['chatluna', 'chatluna_storage']

    private pool: SshSessionPool
    private proxy: NexusTerminalProxy
    private a2aClient = new A2AClientService()
    private a2aRemoteStatus = new Map<string, A2ARemoteStatus>()
    private terminals = new Map<string, Map<string, ManagedTerminal>>()
    private agentCache = new Map<string, DetectedAgent[]>()
    private skillCache = new Map<string, SkillInfo[]>()
    private toolDispose: (() => void)[] = []
    private commandDispose?: () => void
    private reconnectTimer?: NodeJS.Timeout
    private sessionCleanupTimer?: NodeJS.Timeout
    private sessionStorage: FileSessionStorage
    private summaryQueue = new Set<string>()
    private summaryDrain?: Promise<void>
    private summaryStopped = true
    private reconnecting = false
    private nexusConfig: NexusConfig
    private dataPath: string
    private activeByHost = new Map<string, number>()
    private hostErrors = new Map<string, string>()
    private bridgeCache = new Map<string, BridgeHostStatus>()
    private maintenanceLocks = new Set<string>()
    readonly sessionManager: SessionManager
    private agentRunner: AgentRunner

    constructor(
        ctx: Context,
        private pluginConfig: Config
    ) {
        super(ctx, 'agent_nexus')
        this.pool = new SshSessionPool(pluginConfig.maxOutputBytes)
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.nexusConfig = createDefaultNexusConfig(pluginConfig)
        this.proxy = new NexusTerminalProxy(ctx, this)
        this.sessionStorage = new FileSessionStorage(
            path.join(this.dataPath, 'sessions.json')
        )
        this.sessionManager = new SessionManager(this.sessionStorage, {
            historyRetentionMs: pluginConfig.sessionHistoryRetentionMs,
            onArchived: (session) => this.enqueueSessionSummary(session)
        })
        this.agentRunner = new AgentRunner(this.sessionManager, (input) =>
            this.delegate(input)
        )
    }

    async start() {
        this.summaryStopped = false
        await this.loadConfig()
        await this.sessionStorage.init()
        await this.sessionManager.recoverTasks()
        for (const session of await this.sessionManager.listPendingSummaries()) {
            this.enqueueSessionSummary(session)
        }
        this.commandDispose?.()
        this.commandDispose = registerNexusCommands(
            this.ctx,
            this,
            this.pluginConfig
        )
        this.pool.startIdleCleanup((hostId) => {
            const host = this.nexusConfig.hosts.find((h) => h.id === hostId)
            return host?.idleTimeoutMs ?? 15 * 60 * 1000
        })
        this.proxy.start()
        this.syncTools()
        void this.ensureEnabledConnections(true)
        this.reconnectTimer = setInterval(() => {
            void this.ensureEnabledConnections()
        }, 30000)
        this.sessionCleanupTimer = setInterval(() => {
            void this.sessionManager.cleanupExpired().catch((err) => {
                this.ctx.logger.warn(
                    `[agent-nexus] session cleanup failed: ${getErrorMessage(err)}`
                )
            })
        }, 60000)
        await this.refreshConsoleData()
    }

    async stop() {
        this.summaryStopped = true
        await this.agentRunner.shutdown()
        this.commandDispose?.()
        this.commandDispose = undefined
        for (const d of this.toolDispose) d()
        this.toolDispose = []
        this.proxy.stop()
        if (this.reconnectTimer) clearInterval(this.reconnectTimer)
        this.reconnectTimer = undefined
        if (this.sessionCleanupTimer) clearInterval(this.sessionCleanupTimer)
        this.sessionCleanupTimer = undefined
        this.pool.stopIdleCleanup()
        await this.closeAllTerminals()
        await this.pool.clear()
        await this.summaryDrain
    }

    getConfig() {
        return redactNexusConfig(this.nexusConfig)
    }

    getA2AStatus() {
        return {
            remotes: this.nexusConfig.a2a.remotes.map(
                (remote) =>
                    this.a2aRemoteStatus.get(remote.id) || {
                        id: remote.id,
                        name: remote.name,
                        baseUrl: remote.baseUrl,
                        enabled: remote.enabled,
                        state: 'unknown' as const
                    }
            )
        }
    }

    async saveA2ARemote(
        input: Partial<A2ARemoteConfig> & {
            clearAuthToken?: boolean
            clearPreferredTransport?: boolean
        }
    ) {
        const name = String(input.name || '').trim()
        const baseUrl = String(input.baseUrl || '').trim()
        if (!name || !baseUrl) throw new Error('A2A 名称和地址不能为空。')
        const normalizedBaseUrl = validateRemoteUrl(baseUrl)
        const remotes = [...this.nexusConfig.a2a.remotes]
        const id = String(input.id || '').trim() || randomUUID()
        const index = remotes.findIndex((remote) => remote.id === id)
        const previous = index >= 0 ? remotes[index] : undefined
        const next: A2ARemoteConfig = {
            id,
            name,
            baseUrl: normalizedBaseUrl,
            cardPath: input.cardPath?.trim() || undefined,
            authToken:
                input.clearAuthToken
                    ? ''
                    : input.authToken?.trim() || previous?.authToken,
            enabled: input.enabled ?? previous?.enabled ?? true,
            preferredTransport: input.clearPreferredTransport
                ? undefined
                : input.preferredTransport ?? previous?.preferredTransport
        }
        if (index >= 0) remotes[index] = next
        else remotes.push(next)
        this.nexusConfig = {
            ...this.nexusConfig,
            a2a: { ...this.nexusConfig.a2a, remotes }
        }
        this.a2aRemoteStatus.delete(id)
        await this.writeConfigFile()
        return { remoteId: id, data: this.getConsoleData() }
    }

    async removeA2ARemote(id: string) {
        this.nexusConfig = {
            ...this.nexusConfig,
            a2a: {
                ...this.nexusConfig.a2a,
                remotes: this.nexusConfig.a2a.remotes.filter((remote) => remote.id !== id)
            }
        }
        this.a2aRemoteStatus.delete(id)
        await this.writeConfigFile()
        return this.getConsoleData()
    }

    async discoverA2ARemote(id: string) {
        const remote = this.requireA2ARemote(id)
        const checking: A2ARemoteStatus = {
            id: remote.id,
            name: remote.name,
            baseUrl: remote.baseUrl,
            enabled: remote.enabled,
            state: 'checking'
        }
        this.a2aRemoteStatus.set(id, checking)
        try {
            const card = await this.a2aClient.discover(remote)
            const status: A2ARemoteStatus = {
                ...checking,
                state: 'ready',
                card,
                lastCheckedAt: Date.now(),
                error: undefined
            }
            this.a2aRemoteStatus.set(id, status)
            return status
        } catch (error) {
            const status: A2ARemoteStatus = {
                ...checking,
                state: 'error',
                lastCheckedAt: Date.now(),
                error: getErrorMessage(error)
            }
            this.a2aRemoteStatus.set(id, status)
            return status
        }
    }

    async sendA2AMessage(input: {
        remoteId: string
        text: string
        taskId?: string
        contextId?: string
        returnImmediately?: boolean
        metadata?: Record<string, unknown>
    }): Promise<A2ATaskView> {
        const remote = this.requireA2ARemote(input.remoteId)
        if (!remote.enabled) throw new Error(`A2A 远端已禁用：${remote.name}`)
        return this.a2aClient.send(remote, input)
    }

    async getA2ATask(remoteId: string, taskId: string) {
        return this.a2aClient.getTask(this.requireA2ARemote(remoteId), taskId)
    }

    async cancelA2ATask(remoteId: string, taskId: string) {
        return this.a2aClient.cancelTask(this.requireA2ARemote(remoteId), taskId)
    }

    resolveA2ARemoteId(reference: string) {
        const value = reference.trim().toLowerCase()
        const matches = this.nexusConfig.a2a.remotes.filter(
            (remote) =>
                remote.id === reference || remote.name.trim().toLowerCase() === value
        )
        if (matches.length > 1) {
            throw new Error(`A2A 远端名称“${reference}”有歧义，请使用 ID。`)
        }
        if (!matches[0]) throw new Error(`找不到 A2A 远端：${reference}`)
        return matches[0].id
    }

    private requireA2ARemote(id: string) {
        const remote = this.nexusConfig.a2a.remotes.find((item) => item.id === id)
        if (!remote) throw new Error(`找不到 A2A 远端：${id}`)
        return remote
    }

    get commandAuthority() {
        return this.pluginConfig.commandAuthority
    }

    listSessionHistory(query: SessionHistoryQuery = {}) {
        return this.sessionManager.listHistory(query)
    }

    async getSessionHistory(id: string) {
        const session = await this.sessionManager.getHistoryDetail(id)
        if (!session) throw new Error('会话不存在或已被清理。')
        return session
    }

    async deleteSessionHistory(id: string) {
        await this.sessionManager.deleteHistory(id)
        this.summaryQueue.delete(id)
        return { success: true }
    }

    async retrySessionSummary(id: string) {
        const session = await this.sessionManager.retrySummary(id)
        if (!session) throw new Error('只有已结束的会话可以重新生成摘要。')
        this.enqueueSessionSummary(session)
        return { success: true }
    }

    runInSession(
        identity: SessionIdentity,
        input: DelegateInput,
        context?: SessionInvocationContext
    ): Promise<SessionRunOutcome> {
        return this.agentRunner.run(
            identity,
            { ...input, sessionMode: input.sessionMode ?? 'managed' },
            context
        )
    }

    resumeSession(
        identity: SessionIdentity,
        message: string,
        signal?: AbortSignal,
        context?: SessionInvocationContext
    ): Promise<SessionRunOutcome> {
        return this.agentRunner.resume(identity, message, signal, context)
    }

    cancelSessions(identity: SessionIdentity) {
        return this.agentRunner.cancel(identity)
    }

    hasWaitingSession(identity: SessionIdentity) {
        return this.agentRunner.hasWaiting(identity)
    }

    async startInteractiveSession(
        identity: SessionIdentity,
        input: Omit<DelegateInput, 'prompt' | 'signal'>
    ) {
        const host = this.resolveHost(input.hostId)
        const ssh = await this.pool.getOrCreate(host)
        const detectedAgent = await this.resolveAgent(host, ssh.sessionId, input.agent)
        const agent = detectedAgent.kind
        const session = await this.agentRunner.startInteractive(
            identity,
            {
                ...input,
                hostId: host.id,
                agent,
                publishFiles: input.publishFiles ?? true,
                sessionMode: 'managed'
            },
            this.pluginConfig.interactiveSessionTtlMs
        )
        return { session, hostId: host.id, hostName: host.name, agent }
    }

    endInteractiveSession(
        identity: SessionIdentity,
        agent?: AgentKind | 'auto',
        hostId?: string
    ) {
        return this.agentRunner.endInteractive(identity, agent, hostId)
    }

    private enqueueSessionSummary(session: NexusSession) {
        if (!session.endedAt || session.summary?.status !== 'pending') return
        this.summaryQueue.add(session.id)
        if (this.summaryStopped || this.summaryDrain) return
        this.summaryDrain = this.drainSessionSummaries().finally(() => {
            this.summaryDrain = undefined
            if (!this.summaryStopped && this.summaryQueue.size) {
                const next = this.summaryQueue.values().next().value as string
                void this.sessionManager.get(next).then((session) => {
                    if (session) this.enqueueSessionSummary(session)
                })
            }
        })
    }

    private async drainSessionSummaries() {
        while (!this.summaryStopped && this.summaryQueue.size) {
            const id = this.summaryQueue.values().next().value as string
            this.summaryQueue.delete(id)
            await this.summarizeSession(id)
        }
    }

    private async summarizeSession(id: string) {
        const session = await this.sessionManager.get(id)
        if (!session?.endedAt || session.summary?.status !== 'pending') return
        const revision = session.summary.revision ?? 0
        const fallback = fallbackSummary(session)
        const readyFallback = async (error?: unknown) => {
            await this.sessionManager.setSummary(id, {
                status: 'ready',
                revision,
                source: 'fallback',
                title: fallback.title,
                abstract: fallback.abstract,
                topics: [],
                generatedAt: Date.now(),
                ...(error ? { error: getErrorMessage(error) } : {})
            }, revision)
        }
        if (!this.pluginConfig.sessionSummaryEnabled) {
            await readyFallback()
            return
        }

        try {
            const chatluna = this.ctx.chatluna as any
            const modelName =
                this.pluginConfig.sessionSummaryModel.trim() ||
                chatluna?.currentConfig?.defaultModel
            if (!modelName) throw new Error('ChatLuna 未配置默认模型')
            const modelRef = await chatluna.createChatModel(modelName)
            const model = modelRef?.value
            if (!model) throw new Error(`无法创建 ChatLuna 模型：${modelName}`)
            const result = await model.invoke(
                buildSummaryPrompt(
                    session,
                    this.pluginConfig.sessionSummaryMaxInputChars
                ),
                {
                    temperature: 0,
                    maxTokens: 400,
                    stream: false,
                    timeout: 20000
                }
            )
            const { getMessageContent } = require(
                'koishi-plugin-chatluna/utils/string'
            ) as { getMessageContent(content: unknown): string }
            const parsed = parseModelSummary(
                getMessageContent(result.content),
                fallback
            )
            if (!parsed) throw new Error('摘要模型没有返回有效 JSON')
            await this.sessionManager.setSummary(id, {
                status: 'ready',
                revision,
                source: 'model',
                ...parsed,
                generatedAt: Date.now()
            }, revision)
        } catch (error) {
            this.ctx.logger.warn(
                `[agent-nexus] session summary failed: ${getErrorMessage(error)}`
            )
            await readyFallback(error)
        }
    }

    async saveConfig(cfg: NexusConfig) {
        const previousHosts = new Map(this.nexusConfig.hosts.map((host) => [host.id, host]))
        const hosts = (cfg.hosts || []).map((host) => {
            const previous = previousHosts.get(host.id)
            return mergeHostSecrets(
                createHost({
                    ...host,
                    bridge: host.bridge || previous?.bridge
                }),
                previous
            )
        })
        const scanHostIds = hosts
            .filter((host) => {
                if (!host.enabled) return false
                const previous = previousHosts.get(host.id)
                return !previous || hostConnectionChanged(previous, host)
            })
            .map((host) => host.id)
        const nextConfig: NexusConfig = {
            ...cfg,
            hosts,
            a2a: mergeA2ASecrets(
                {
                    ...createDefaultNexusConfig(this.pluginConfig).a2a,
                    ...(cfg.a2a || {}),
                    remotes: cfg.a2a?.remotes || this.nexusConfig.a2a.remotes
                },
                this.nexusConfig.a2a
            ),
            runtime: {
                ...cfg.runtime,
                defaultTimeoutMs:
                    cfg.runtime?.defaultTimeoutMs ??
                    this.pluginConfig.defaultTimeoutMs
            },
            skillRoot: cfg.skillRoot || this.pluginConfig.skillRoot
        }
        for (const host of hosts) {
            if (host.bridge.enabled || !host.bridge.remoteId) continue
            const remote = nextConfig.a2a.remotes.find(
                (item) => item.id === host.bridge.remoteId
            )
            if (remote) remote.enabled = false
        }
        const nextHostIds = new Set(hosts.map((host) => host.id))
        for (const previous of this.nexusConfig.hosts) {
            const next = hosts.find((host) => host.id === previous.id)
            if (!nextHostIds.has(previous.id) || (next && hostConnectionChanged(previous, next))) {
                this.closeTerminalsByHost(previous.id)
                await this.pool.destroyByHost(previous.id)
                this.agentCache.delete(previous.id)
                this.skillCache.delete(previous.id)
                this.hostErrors.delete(previous.id)
            }
            if (!next || JSON.stringify(previous.bridge) !== JSON.stringify(next.bridge)) {
                this.bridgeCache.delete(previous.id)
            }
            if (!nextHostIds.has(previous.id)) {
                this.pool.release(previous.id)
            }
        }
        for (const host of hosts) {
            if (!host.enabled) this.pool.release(host.id)
        }
        this.nexusConfig = nextConfig
        this.a2aRemoteStatus.clear()
        await this.writeConfigFile()
        this.syncTools()
        // SSH connect/scan must not block console save responses.
        void this.afterConfigSaved(scanHostIds)
        await this.refreshConsoleData()
    }

    private async afterConfigSaved(scanHostIds: string[]) {
        for (const hostId of scanHostIds) {
            try {
                await this.scanAgents(hostId)
            } catch (err) {
                this.hostErrors.set(hostId, getErrorMessage(err))
                this.ctx.logger.warn(
                    `[agent-nexus] scan after save failed (${hostId}): ${getErrorMessage(err)}`
                )
            }
        }
        await this.ensureEnabledConnections()
    }

    async saveHost(
        input: Partial<SshHostConfig> & { setAsDefault?: boolean }
    ): Promise<{ hostId: string; data: NexusConsoleData }> {
        const name = input.name !== undefined ? normalizeHostName(input.name) : undefined
        const explicitId = typeof input.id === 'string' ? input.id.trim() : ''
        let hostId = explicitId || undefined

        if (hostId) {
            const idx = this.nexusConfig.hosts.findIndex((h) => h.id === hostId)
            if (idx < 0) throw new Error(`Host not found: ${hostId}`)
            if (name !== undefined) {
                assertUniqueHostName(this.nexusConfig.hosts, name, hostId)
            }
            const { setAsDefault: _setAsDefault, id: _id, ...hostInput } = input
            const patched = patchHostConfig(this.nexusConfig.hosts[idx], {
                ...hostInput,
                ...(name !== undefined ? { name } : {})
            })
            const hosts = this.nexusConfig.hosts.map((host, index) =>
                index === idx ? patched : host
            )
            hostId = patched.id
            await this.saveConfig({
                ...this.nexusConfig,
                hosts,
                defaultHostId:
                    input.setAsDefault || !this.nexusConfig.defaultHostId
                        ? hostId
                        : this.nexusConfig.defaultHostId
            })
        } else {
            const hostName = assertUniqueHostName(
                this.nexusConfig.hosts,
                name || `SSH Computer ${this.nexusConfig.hosts.length + 1}`
            )
            const { setAsDefault: _setAsDefault, id: _id, ...hostInput } = input
            const host = createHost({
                ...hostInput,
                name: hostName
            })
            hostId = host.id
            await this.saveConfig({
                ...this.nexusConfig,
                hosts: [...this.nexusConfig.hosts, host],
                defaultHostId:
                    input.setAsDefault || !this.nexusConfig.defaultHostId
                        ? hostId
                        : this.nexusConfig.defaultHostId
            })
        }

        // Kick a focused connect/scan for this host without blocking the RPC.
        void this.scanAgents(hostId).catch((err) => {
            this.hostErrors.set(hostId!, getErrorMessage(err))
        })

        return { hostId: hostId!, data: this.getConsoleData() }
    }

    async removeHost(hostId: string) {
        this.bridgeCache.delete(hostId)
        const hosts = this.nexusConfig.hosts.filter((h) => h.id !== hostId)
        await this.saveConfig({
            ...this.nexusConfig,
            hosts,
            defaultHostId:
                this.nexusConfig.defaultHostId === hostId
                    ? hosts[0]?.id
                    : this.nexusConfig.defaultHostId
        })
    }

    getStatus(): NexusStatus {
        const hosts: HostStatus[] = this.nexusConfig.hosts.map((host) => {
            const agents = this.agentCache.get(host.id) || emptyAgents()
            const sessions = this.pool.getByHost(host.id)
            const connected = sessions.find((session) => session.isConnected())
            const connecting = sessions.some((session) => session.isConnecting())
            const error = this.hostErrors.get(host.id) || sessions.find((session) => session.lastError)?.lastError
            return {
                id: host.id,
                name: host.name,
                host: `${host.username}@${host.host}:${host.port || 22}`,
                state: !host.enabled
                    ? 'error'
                    : connected
                      ? 'connected'
                      : connecting
                        ? 'connecting'
                        : error
                          ? 'error'
                          : 'idle',
                error: host.enabled ? error : 'disabled',
                agents,
                sessionCount: this.pool.countByHost(host.id),
                lastConnectedAt: connected?.lastConnectedAt,
                environment: connected?.environmentInfo,
                bridge:
                    this.bridgeCache.get(host.id) ||
                    initialBridgeStatus(host)
            }
        })

        const defaultHostId =
            this.nexusConfig.defaultHostId || this.nexusConfig.hosts[0]?.id
        const skillHostId =
            (defaultHostId && this.skillCache.has(defaultHostId) && defaultHostId) ||
            this.skillCache.keys().next().value ||
            defaultHostId
        const skillItems = (skillHostId && this.skillCache.get(skillHostId)) || []
        return {
            enabled: this.nexusConfig.hosts.some((h) => h.enabled),
            defaultHostId,
            hosts,
            skills: {
                total: skillItems.length,
                items: skillItems,
                hostId: skillHostId
            },
            activeSessions: this.pool.list().length,
            a2a: this.getA2AStatus()
        }
    }

    getSkillsForHost(hostId?: string): SkillInfo[] {
        const host = this.resolveHost(hostId)
        return this.skillCache.get(host.id) || []
    }

    getConsoleData(): NexusConsoleData {
        return {
            config: redactNexusConfig(this.nexusConfig),
            status: this.getStatus()
        }
    }

    async refreshConsoleData() {
        try {
            // optional broadcast if console data service exists later
        } catch {}
    }

    async testHost(hostId: string) {
        const host = this.requireHost(hostId)
        const session = await this.pool.getOrCreate(host, `test:${host.id}`)
        try {
            const result = await session.exec('echo agent-nexus-ok && uname -a', {
                timeoutMs: 15000
            })
            if (result.exitCode !== 0) {
                throw new Error(result.stderr || result.stdout || 'test failed')
            }
            this.hostErrors.delete(host.id)
            return {
                ok: true,
                output: result.stdout.trim()
            }
        } catch (err) {
            this.hostErrors.set(host.id, getErrorMessage(err))
            throw err
        } finally {
            await this.pool.destroy(session.sessionId).catch(() => undefined)
        }
    }

    async scanAgents(hostId?: string): Promise<NexusStatus> {
        const hosts = hostId
            ? [this.requireHost(hostId)]
            : this.nexusConfig.hosts.filter((h) => h.enabled)
        const latestVersions = new Map(
            await Promise.all(
                listAdapters()
                    .filter((adapter) => adapter.kind !== 'claude')
                    .map(async (adapter) => [
                        adapter.kind,
                        await latestAgentVersion(adapter.kind)
                    ] as const)
            )
        )

        for (const host of hosts) {
            try {
                const session = await this.pool.getOrCreate(host)
                const detected: DetectedAgent[] = []
                for (const adapter of listAdapters()) {
                    if (!this.nexusConfig.agents[adapter.kind]) {
                        detected.push({
                            kind: adapter.kind,
                            installed: false,
                            skillDirs: adapter.skillDirs('~')
                        })
                        continue
                    }
                    try {
                        detected.push(
                            await this.withAgentMaintenanceInfo(
                                await adapter.detect(session),
                                session,
                                latestVersions.get(adapter.kind)
                            )
                        )
                    } catch (err) {
                        detected.push({
                            kind: adapter.kind,
                            installed: false,
                            skillDirs: adapter.skillDirs('~')
                        })
                        this.ctx.logger.warn(
                            `[agent-nexus] ${host.name}/${adapter.kind} detect failed: ${getErrorMessage(err)}`
                        )
                    }
                }
                this.agentCache.set(host.id, detected)
                await this.refreshBridgeStatus(host.id)
                this.hostErrors.delete(host.id)
            } catch (err) {
                this.agentCache.set(
                    host.id,
                    emptyAgents().map((a) => ({
                        ...a,
                        installed: false
                    }))
                )
                this.hostErrors.set(host.id, getErrorMessage(err))
                this.ctx.logger.warn(`[agent-nexus] ${getErrorMessage(err)}`)
            }
        }

        return this.getStatus()
    }

    async maintainAgent(
        input: AgentMaintenanceInput
    ): Promise<AgentMaintenanceResult> {
        const key = `${input.hostId}:${input.kind}`
        if (this.maintenanceLocks.has(key)) {
            throw new Error('该 Agent 正在安装或更新，请稍候。')
        }
        this.maintenanceLocks.add(key)
        try {
            const host = this.requireHost(input.hostId)
            const adapter = getAdapter(input.kind)
            const session = await this.pool.getOrCreate(host)
            const current =
                this.agentCache
                    .get(host.id)
                    ?.find((agent) => agent.kind === input.kind) ??
                (await adapter.detect(session))
            const plan = buildAgentMaintenancePlan(
                input.kind,
                current.installed,
                current.path
            )
            const result = await session.exec(plan.command, {
                timeoutMs: 10 * 60 * 1000
            })
            if (result.timedOut) {
                throw new Error(`${plan.method}执行超时。`)
            }
            if (result.truncated) {
                throw new Error(`${plan.method}输出过长，无法确认安装结果。`)
            }
            if (result.exitCode !== 0) {
                const output = (result.stderr || result.stdout).trim()
                throw new Error(
                    `${plan.method}失败（exit ${result.exitCode}）：${output.slice(-2000)}`
                )
            }
            const agent = await this.withAgentMaintenanceInfo(
                await adapter.detect(session),
                session
            )
            if (!agent.installed) {
                throw new Error('安装命令已结束，但重新扫描仍未发现可执行文件。')
            }
            const versionError = validateAgentMaintenanceVersion(
                plan.action,
                current.version,
                agent.version,
                agent.latestVersion
            )
            if (versionError) throw new Error(versionError)
            const agents = this.agentCache.get(host.id) ?? emptyAgents()
            this.agentCache.set(
                host.id,
                agents.map((item) =>
                    item.kind === input.kind ? agent : item
                )
            )
            this.hostErrors.delete(host.id)
            return {
                action: plan.action,
                method: plan.method,
                agent,
                status: this.getStatus()
            }
        } finally {
            this.maintenanceLocks.delete(key)
        }
    }

    async refreshBridgeStatus(hostId: string): Promise<BridgeHostStatus> {
        const host = this.requireHost(hostId)
        if (!host.bridge.enabled) {
            const disabled = initialBridgeStatus(host)
            this.bridgeCache.set(host.id, disabled)
            return disabled
        }
        try {
            const session = await this.pool.getOrCreate(host)
            const result = await session.exec(buildBridgeStatusCommand(host.bridge), {
                timeoutMs: 15_000
            })
            const status = parseBridgeStatus(result.stdout, host, result.stderr)
            this.bridgeCache.set(host.id, status)
            return status
        } catch (error) {
            const status: BridgeHostStatus = {
                ...initialBridgeStatus(host),
                state: 'error',
                lastCheckedAt: Date.now(),
                error: getErrorMessage(error)
            }
            this.bridgeCache.set(host.id, status)
            return status
        }
    }

    async maintainBridge(
        input: BridgeMaintenanceInput
    ): Promise<BridgeMaintenanceResult> {
        const key = `${input.hostId}:bridge`
        if (this.maintenanceLocks.has(key)) {
            throw new Error('该 Bridge 正在部署或变更状态，请稍候。')
        }
        this.maintenanceLocks.add(key)
        try {
            let host = this.requireHost(input.hostId)
            if (input.bridge) {
                host = this.persistBridgeConfig(host, input.bridge)
                await this.writeConfigFile()
            }
            if (!host.bridge.enabled && input.action !== 'stop') {
                throw new Error('请先在设备配置中启用 A2A Bridge。')
            }
            if (
                (input.action === 'install' || input.action === 'update') &&
                !host.bridge.token?.trim()
            ) {
                host = this.updateBridgeHost(host.id, {
                    token: randomBytes(32).toString('base64url')
                })
                await this.writeConfigFile()
            }
            const plan = buildBridgeMaintenancePlan(
                input.action,
                host,
                this.nexusConfig
            )
            this.bridgeCache.set(host.id, {
                ...initialBridgeStatus(host),
                state:
                    input.action === 'install' || input.action === 'update'
                        ? 'installing'
                        : input.action === 'stop'
                          ? 'stopped'
                          : 'starting'
            })
            const localPackage = plan.localPackagePath
                ? await packLocalBridgePackage()
                : undefined
            const session = await this.pool.getOrCreate(host)
            if (plan.prepareCommand) {
                const prepared = await session.exec(plan.prepareCommand, {
                    timeoutMs: 10 * 60 * 1000
                })
                this.assertBridgeMaintenanceResult(prepared, `${plan.method}准备`)
                for (const file of plan.files || []) {
                    await session.writeFile(
                        session.resolveRemotePath(file.path),
                        file.content,
                        file.mode
                    )
                }
                if (plan.localPackagePath && localPackage) {
                    await session.writeFile(
                        session.resolveRemotePath(plan.localPackagePath),
                        localPackage,
                        0o600
                    )
                }
            }
            const result = await session.exec(plan.command, {
                timeoutMs:
                    input.action === 'install' || input.action === 'update'
                        ? 10 * 60 * 1000
                        : 60_000
            })
            this.assertBridgeMaintenanceResult(result, plan.method)
            const shouldRun = input.action !== 'stop'
            const bridge = await this.waitForBridgeState(host, shouldRun)
            if (shouldRun && bridge.state !== 'running') {
                throw new Error(
                    bridge.error ||
                        `Bridge 服务未就绪，当前状态：${bridge.state}。请检查 systemd user 日志。`
                )
            }
            const remoteId = await this.syncBridgeRemote(host, shouldRun)
            if (shouldRun) await this.discoverA2ARemote(remoteId)
            return {
                action: input.action,
                method: plan.method,
                bridge,
                status: this.getStatus()
            }
        } catch (error) {
            const host = this.nexusConfig.hosts.find((item) => item.id === input.hostId)
            if (host) {
                this.bridgeCache.set(host.id, {
                    ...initialBridgeStatus(host),
                    state: 'error',
                    lastCheckedAt: Date.now(),
                    error: getErrorMessage(error)
                })
            }
            throw error
        } finally {
            this.maintenanceLocks.delete(key)
        }
    }

    private assertBridgeMaintenanceResult(
        result: {
            timedOut: boolean
            truncated?: boolean
            exitCode: number
            stdout: string
            stderr: string
        },
        method: string
    ) {
        if (result.timedOut) throw new Error(`${method}执行超时。`)
        if (result.truncated) {
            throw new Error(`${method}输出过长，无法确认执行结果。`)
        }
        if (result.exitCode !== 0) {
            const output = (result.stderr || result.stdout).trim()
            throw new Error(
                `${method}失败（exit ${result.exitCode}）：${output.slice(-3000)}`
            )
        }
    }

    private updateBridgeHost(
        hostId: string,
        patch: Partial<SshHostConfig['bridge']>
    ) {
        const index = this.nexusConfig.hosts.findIndex((host) => host.id === hostId)
        if (index < 0) throw new Error(`Host not found: ${hostId}`)
        const host = this.nexusConfig.hosts[index]
        const next = {
            ...host,
            bridge: { ...host.bridge, ...patch }
        }
        this.nexusConfig.hosts[index] = next
        return next
    }

    private persistBridgeConfig(host: SshHostConfig, bridge: SshHostConfig['bridge']) {
        const index = this.nexusConfig.hosts.findIndex((item) => item.id === host.id)
        if (index < 0) throw new Error(`Host not found: ${host.id}`)
        const next = patchHostConfig(host, { bridge })
        this.nexusConfig.hosts[index] = next
        this.bridgeCache.delete(host.id)
        return next
    }

    private async waitForBridgeState(host: SshHostConfig, running: boolean) {
        let status = await this.refreshBridgeStatus(host.id)
        for (let attempt = 0; attempt < 5; attempt += 1) {
            if (
                (running && status.state === 'running') ||
                (!running && status.state === 'stopped')
            ) {
                return status
            }
            await new Promise((resolve) => setTimeout(resolve, 1000))
            status = await this.refreshBridgeStatus(host.id)
        }
        return status
    }

    private async syncBridgeRemote(host: SshHostConfig, enabled: boolean) {
        const remoteId = host.bridge.remoteId || `bridge-${host.id}`
        if (host.bridge.remoteId !== remoteId) {
            host = this.updateBridgeHost(host.id, { remoteId })
        }
        const remotes = [...this.nexusConfig.a2a.remotes]
        const index = remotes.findIndex((remote) => remote.id === remoteId)
        const remote: A2ARemoteConfig = {
            id: remoteId,
            name: `${host.name} Bridge`,
            baseUrl: bridgePublicBaseUrl(host),
            authToken: host.bridge.token,
            enabled,
            preferredTransport: 'JSONRPC'
        }
        if (index >= 0) remotes[index] = { ...remotes[index], ...remote }
        else remotes.push(remote)
        this.nexusConfig = {
            ...this.nexusConfig,
            a2a: { ...this.nexusConfig.a2a, remotes }
        }
        this.a2aRemoteStatus.delete(remoteId)
        await this.writeConfigFile()
        return remoteId
    }

    private async withAgentMaintenanceInfo(
        agent: DetectedAgent,
        session: SshSession,
        resolvedLatest?: {
            value?: string
            error?: string
        }
    ) {
        const channelCommand = buildAgentLatestVersionCommand(
            agent.kind,
            agent.path
        )
        let latest = resolvedLatest
        if (channelCommand) {
            try {
                const result = await session.exec(channelCommand, {
                    timeoutMs: 30_000
                })
                if (result.timedOut) throw new Error('Homebrew 版本查询超时。')
                if (result.truncated) throw new Error('Homebrew 版本查询输出过长。')
                if (result.exitCode !== 0) {
                    throw new Error(
                        (result.stderr || result.stdout).trim() ||
                            `Homebrew 版本查询失败（exit ${result.exitCode}）。`
                    )
                }
                latest = {
                    value: parseHomebrewClaudeVersion(result.stdout)
                }
            } catch (error) {
                latest = { error: getErrorMessage(error) }
            }
        }
        latest ??= await latestAgentVersion(agent.kind)
        const plan = buildAgentMaintenancePlan(
            agent.kind,
            agent.installed,
            agent.path
        )
        return {
            ...agent,
            latestVersion: latest.value,
            updateAvailable: agent.installed
                ? isVersionNewer(agent.version, latest.value)
                : undefined,
            maintenanceMethod: plan.method,
            maintenanceError: latest.error
        }
    }

    async refreshSkills(hostId?: string) {
        const host = this.resolveHost(hostId)
        const session = await this.pool.getOrCreate(host)
        const items = await listRemoteSkills(
            session,
            this.nexusConfig,
            this.installedAgentKinds(host.id)
        )
        this.skillCache.set(host.id, items)
        return items
    }

    async syncSkill(source: SkillSourceConfig, hostId?: string) {
        if (!source.enabled) throw new Error(`Skill source disabled: ${source.name}`)
        const host = this.resolveHost(hostId)
        const session = await this.pool.getOrCreate(host)
        const idx = this.nexusConfig.skills.findIndex((s) => s.id === source.id)
        try {
            if (!this.agentCache.has(host.id)) await this.scanAgents(host.id)
            const agents = this.installedAgentKinds(host.id)
            const info = await syncSkillSource(session, source, this.nexusConfig, agents)
            const next = {
                ...source,
                lastSyncAt: Date.now(),
                lastError: undefined
            }
            if (idx >= 0) this.nexusConfig.skills[idx] = next
            else this.nexusConfig.skills.push(next)
            await this.writeConfigFile()

            const items = await listRemoteSkills(session, this.nexusConfig, agents)
            this.skillCache.set(host.id, items)
            return info
        } catch (err) {
            const failed = { ...source, lastError: getErrorMessage(err) }
            if (idx >= 0) this.nexusConfig.skills[idx] = failed
            else this.nexusConfig.skills.push(failed)
            await this.writeConfigFile()
            throw err
        }
    }

    async delegate(input: DelegateInput): Promise<
        AgentResult & { published?: PublishResult[]; hostId: string }
    > {
        const host = this.resolveHost(input.hostId)
        const active = this.activeByHost.get(host.id) || 0
        if (active >= this.pluginConfig.maxConcurrentPerHost) {
            throw new Error(`Host ${host.name} has reached its Agent task limit`)
        }
        this.activeByHost.set(host.id, active + 1)
        try {
            const session = await this.pool.getOrCreate(host)
            const detectedAgent = await this.resolveAgent(
                host,
                session.sessionId,
                input.agent
            )
            const adapter = getAdapter(detectedAgent.kind)
            const executionCwd = session.resolveRemotePath(
                input.cwd || host.cwd || session.cwd
            )

            const prompt = appendFileHint(input.prompt)
            const timeoutMs =
                input.timeoutMs ??
                this.nexusConfig.runtime.defaultTimeoutMs ??
                this.pluginConfig.defaultTimeoutMs

            const command = adapter.buildCommand({
                prompt,
                cwd: executionCwd,
                model: input.model,
                timeoutMs,
                openclawAgent: input.openclawAgent,
                runtime: this.nexusConfig.runtime,
                sessionMode: input.sessionMode,
                providerState: input.providerState,
                executablePath: detectedAgent.path
            })

            const exec = await session.exec(command, {
                cwd: executionCwd,
                timeoutMs,
                signal: input.signal
            })

            const result = adapter.parseResult(
                exec.stdout,
                exec.stderr,
                exec.exitCode,
                exec.timedOut,
                command
            )
            result.truncated = exec.truncated

            let published: PublishResult[] | undefined
            if (input.publishFiles && result.files.length) {
                published = await this.publishFiles(
                    result.files,
                    host.id,
                    executionCwd
                )
            }

            return { ...result, published, hostId: host.id }
        } finally {
            const remaining = (this.activeByHost.get(host.id) || 1) - 1
            if (remaining > 0) this.activeByHost.set(host.id, remaining)
            else this.activeByHost.delete(host.id)
        }
    }

    async publishFiles(
        paths: string[],
        hostId?: string,
        cwd?: string
    ): Promise<PublishResult[]> {
        const host = this.resolveHost(hostId)
        const session = await this.pool.getOrCreate(host)
        const out: PublishResult[] = []
        const publishRoot = await this.resolvePublishRoot(session, cwd || host.cwd)

        for (const remotePath of paths) {
            const name = path.posix.basename(remotePath.replaceAll('\\', '/'))
            try {
                const canonicalPath = await this.resolveRemotePath(
                    session,
                    remotePath,
                    cwd || host.cwd
                )
                if (!isRemotePathWithinRoot(canonicalPath, publishRoot)) {
                    throw new Error(`File is outside the publish root: ${publishRoot}`)
                }
                const asset = await session.openAsset(canonicalPath)
                const file = await this.ctx.chatluna_storage.createTempFileFromStream(
                    asset.stream,
                    name,
                    { size: asset.size, mimeType: asset.mimeType }
                )
                out.push({ path: remotePath, name, url: file.url })
            } catch (err) {
                out.push({
                    path: remotePath,
                    name,
                    error: getErrorMessage(err)
                })
            }
        }

        return out
    }

    async listRemoteFiles(input: { hostId?: string; path?: string } = {}) {
        const manager = await this.createFileManager(input.hostId)
        return manager.list(input.path)
    }

    async previewRemoteFile(input: { hostId?: string; path: string }) {
        const manager = await this.createFileManager(input.hostId)
        return manager.preview(input.path)
    }

    async uploadRemoteFile(input: {
        hostId?: string
        path: string
        contentBase64: string
    }) {
        const manager = await this.createFileManager(input.hostId)
        const remotePath = await manager.writeBase64(
            input.path,
            input.contentBase64
        )
        return { success: true, path: remotePath }
    }

    async saveRemoteText(input: {
        hostId?: string
        path: string
        content: string
    }) {
        const manager = await this.createFileManager(input.hostId)
        const remotePath = await manager.writeText(input.path, input.content)
        return { success: true, path: remotePath }
    }

    async createRemoteDirectory(input: {
        hostId?: string
        parent: string
        name: string
    }) {
        const manager = await this.createFileManager(input.hostId)
        const remotePath = await manager.createDirectory(input.parent, input.name)
        return { success: true, path: remotePath }
    }

    async renameRemoteFile(input: {
        hostId?: string
        path: string
        newName: string
    }) {
        const manager = await this.createFileManager(input.hostId)
        const remotePath = await manager.rename(input.path, input.newName)
        return { success: true, path: remotePath }
    }

    async deleteRemoteFile(input: { hostId?: string; path: string }) {
        const manager = await this.createFileManager(input.hostId)
        await manager.remove(input.path)
        return { success: true }
    }

    async downloadRemoteFile(input: { hostId?: string; path: string }) {
        const manager = await this.createFileManager(input.hostId)
        const opened = await manager.openDownload(input.path)
        const file = await this.ctx.chatluna_storage.createTempFileFromStream(
            opened.asset.stream,
            opened.result.name,
            {
                size: opened.asset.size,
                mimeType: opened.asset.mimeType
            }
        )
        return { ...opened.result, url: file.url }
    }

    private async createFileManager(hostId?: string) {
        const host = this.resolveHost(hostId)
        const session = await this.pool.getOrCreate(host)
        return SftpFileManager.create(session, host.id, host.cwd, {
            maxUploadBytes: this.pluginConfig.fileManagerMaxUploadBytes,
            maxPreviewBytes: this.pluginConfig.fileManagerMaxPreviewBytes
        })
    }

    private async resolvePublishRoot(session: SshSession, cwd?: string) {
        const requested = cwd || session.cwd
        const result = await session.exec('pwd -P', {
            cwd: requested,
            timeoutMs: 10000
        })
        if (result.exitCode !== 0 || !result.stdout.trim().startsWith('/')) {
            throw new Error(`Cannot resolve publish root: ${requested}`)
        }
        return result.stdout.trim().split('\n').pop() as string
    }

    private async resolveRemotePath(session: SshSession, remotePath: string, cwd?: string) {
        const result = await session.exec(buildRemoteRealpathCommand(remotePath), {
            cwd,
            timeoutMs: 10000
        })
        const canonical = result.stdout.trim().split('\n').pop() || ''
        if (result.exitCode !== 0 || !canonical.startsWith('/')) {
            throw new Error(`Cannot resolve remote file: ${remotePath}`)
        }
        return canonical
    }

    async createTerminal(
        clientId: string,
        input: { hostId?: string; cols?: number; rows?: number; cwd?: string } = {}
    ): Promise<TerminalInfo> {
        if (!this.ctx.server) throw new Error('Koishi server service is required for terminals')
        if (!this.nexusConfig.hosts.length) {
            throw new Error('还没有配置 SSH 设备，请先在 Computer 页面添加。')
        }
        const host = this.resolveHost(input.hostId)
        // Prefer the shared host connection when present; fall back to a console-scoped session.
        const session = await this.pool.getOrCreate(host)
        const terminal = await session.createTerminal({
            cols: input.cols,
            rows: input.rows,
            cwd: input.cwd || host.cwd,
            timeoutMs: 20_000
        })
        const token = randomUUID()
        const map =
            this.terminals.get(session.sessionId) ??
            new Map<string, ManagedTerminal>()
        const item: ManagedTerminal = {
            terminal,
            token,
            hostId: host.id,
            persistent: false,
            expiresAt: Date.now() + 60_000,
            attached: false
        }
        item.expiryTimer = setTimeout(() => {
            if (!item.attached) this.closeTerminal(session.sessionId, terminal.id)
        }, 60_000)
        map.set(terminal.id, item)
        this.terminals.set(session.sessionId, map)

        return {
            sessionId: session.sessionId,
            terminalId: terminal.id,
            hostId: host.id,
            url: `/agent-nexus/terminal/${session.sessionId}/${terminal.id}`,
            token
        }
    }

    getTerminal(sessionId: string, terminalId: string) {
        return this.terminals.get(sessionId)?.get(terminalId)
    }

    claimTerminal(sessionId: string, terminalId: string, token: string) {
        const item = this.getTerminal(sessionId, terminalId)
        if (!item || item.token !== token || item.attached || item.expiresAt < Date.now()) {
            return undefined
        }
        item.attached = true
        if (item.expiryTimer) clearTimeout(item.expiryTimer)
        item.expiryTimer = undefined
        return item
    }

    handleTerminalClose(sessionId: string, terminalId: string) {
        const map = this.terminals.get(sessionId)
        const item = map?.get(terminalId)
        if (!item || item.persistent) return
        if (item.expiryTimer) clearTimeout(item.expiryTimer)
        item.terminal.kill()
        map?.delete(terminalId)
        if (map && map.size < 1) this.terminals.delete(sessionId)
    }

    async closeTerminal(sessionId: string, terminalId: string) {
        const map = this.terminals.get(sessionId)
        const item = map?.get(terminalId)
        if (!item) return
        if (item.expiryTimer) clearTimeout(item.expiryTimer)
        item.terminal.kill()
        map?.delete(terminalId)
        if (map && map.size < 1) this.terminals.delete(sessionId)
    }

    private closeTerminalsByHost(hostId: string) {
        for (const [sessionId, map] of this.terminals) {
            for (const [terminalId, item] of map) {
                if (item.hostId !== hostId) continue
                if (item.expiryTimer) clearTimeout(item.expiryTimer)
                item.terminal.kill()
                map.delete(terminalId)
            }
            if (map.size < 1) this.terminals.delete(sessionId)
        }
    }

    private async closeAllTerminals() {
        for (const [sid, map] of this.terminals) {
            for (const [tid, item] of map) {
                item.terminal.kill()
                if (item.expiryTimer) clearTimeout(item.expiryTimer)
                map.delete(tid)
            }
            this.terminals.delete(sid)
        }
    }

    private syncTools() {
        for (const d of this.toolDispose) d()
        this.toolDispose = []

        const platform = (this.ctx as any).chatluna?.platform
        if (!platform?.registerTool) return

        const tools = [
            new NexusDelegateTool(this),
            new NexusPublishTool(this),
            new NexusListAgentsTool(this),
            new NexusListSkillsTool(this),
            new NexusA2AListTool(this),
            new NexusA2ASendTool(this),
            new NexusA2ATaskTool(this)
        ]

        for (const tool of tools) {
            this.toolDispose.push(
                platform.registerTool(tool.name, {
                    description: tool.description,
                    selector: () => true,
                    createTool: () => tool,
                    meta: {
                        source: 'extension',
                        group: 'agent-nexus',
                        tags: ['agent-nexus', 'ssh', 'computer'],
                        defaultAvailability: {
                            enabled: true,
                            main: true,
                            chatluna: true,
                            characterScope: 'all'
                        }
                    }
                })
            )
        }
    }

    private async resolveAgent(
        host: SshHostConfig,
        _sessionId: string,
        preferred?: AgentKind | 'auto'
    ): Promise<DetectedAgent> {
        let agents = this.agentCache.get(host.id)
        if (!agents?.length) {
            await this.scanAgents(host.id)
            agents = this.agentCache.get(host.id) || []
        }

        const installed = agents.filter(
            (a) => a.installed && this.nexusConfig.agents[a.kind]
        )
        if (!installed.length) {
            throw new Error(`No code agents installed on host ${host.name}`)
        }

        const want =
            preferred && preferred !== 'auto'
                ? preferred
                : host.defaultAgent && host.defaultAgent !== 'auto'
                  ? host.defaultAgent
                  : undefined

        if (want) {
            const hit = installed.find((a) => a.kind === want)
            if (hit) return hit
            throw new Error(`Agent ${want} is not available on host ${host.name}`)
        }

        const order: AgentKind[] = [
            'hermes',
            'openclaw',
            'claude',
            'opencode',
            'codex',
            'pi'
        ]
        for (const kind of order) {
            const hit = installed.find((a) => a.kind === kind)
            if (hit) return hit
        }
        return installed[0]
    }

    private installedAgentKinds(hostId: string): AgentKind[] {
        const enabled = new Set(enabledAgentKinds(this.nexusConfig))
        return (this.agentCache.get(hostId) || [])
            .filter((agent) => agent.installed && enabled.has(agent.kind))
            .map((agent) => agent.kind)
    }

    private async ensureEnabledConnections(scan = false) {
        if (this.reconnecting) return
        const hosts = this.nexusConfig.hosts.filter((item) => item.enabled)
        if (!hosts.length) return

        this.reconnecting = true
        try {
            for (const host of hosts) {
                this.pool.keepAlive(host.id)
                try {
                    await this.pool.getOrCreate(host)
                    if (scan || !this.agentCache.has(host.id)) {
                        await this.scanAgents(host.id)
                    }
                } catch (err) {
                    this.hostErrors.set(host.id, getErrorMessage(err))
                    this.ctx.logger.warn(
                        `[agent-nexus] SSH reconnect failed (${host.name}): ${getErrorMessage(err)}`
                    )
                }
            }
            for (const host of this.nexusConfig.hosts) {
                if (!host.enabled) this.pool.release(host.id)
            }
        } finally {
            this.reconnecting = false
        }
    }

    private resolveHost(hostId?: string): SshHostConfig {
        const reference = hostId?.trim()
        if (reference) return this.requireHost(reference)
        if (!this.nexusConfig.hosts.length) {
            throw new Error('还没有配置 SSH 设备，请先在 Computer 页面添加。')
        }
        const id =
            this.nexusConfig.defaultHostId ||
            this.nexusConfig.hosts.find((h) => h.enabled)?.id ||
            this.nexusConfig.hosts[0]?.id
        if (!id) throw new Error('还没有可用的 SSH 设备，请先在 Computer 页面添加。')
        return this.requireHost(id)
    }

    resolveHostId(reference: string) {
        return this.requireHost(reference).id
    }

    private requireHost(hostId: string) {
        const host = resolveHostReference(this.nexusConfig.hosts, hostId)
        if (!host) {
            const names = this.nexusConfig.hosts.map((item) => item.name).join('、')
            throw new Error(
                names
                    ? `找不到设备“${hostId}”。当前设备：${names}`
                    : `找不到设备“${hostId}”，请先在 Computer 页面添加。`
            )
        }
        if (!host.enabled) throw new Error(`设备已禁用：${host.name}`)
        return host
    }

    private async loadConfig() {
        const { readFile, mkdir } = await import('fs/promises')
        await mkdir(this.dataPath, { recursive: true })
        const file = path.join(this.dataPath, 'config.json')
        try {
            const raw = await readFile(file, 'utf8')
            const parsed = JSON.parse(raw) as NexusConfig
            const defaults = createDefaultNexusConfig(this.pluginConfig)
            const parsedA2A = (parsed.a2a || {}) as A2AConfig &
                Record<string, unknown>
            const legacyA2AServerConfig = [
                'enabled',
                'publicBaseUrl',
                'serverToken',
                'cardName',
                'cardDescription'
            ].some((key) => key in parsedA2A)
            const missingBridge = (parsed.hosts || []).some((host) => !host.bridge)
            const repaired = repairHostIds(
                (parsed.hosts || []).map((host) => createHost(host))
            )
            const defaultHostId = repaired.hosts.some(
                (host) => host.id === parsed.defaultHostId
            )
                ? parsed.defaultHostId
                : repaired.hosts.find((host) => host.enabled)?.id || repaired.hosts[0]?.id
            this.nexusConfig = {
                ...defaults,
                ...parsed,
                agents: {
                    ...defaults.agents,
                    ...parsed.agents
                },
                runtime: {
                    ...defaults.runtime,
                    ...parsed.runtime
                },
                a2a: {
                    remotes: parsedA2A.remotes || []
                },
                hosts: repaired.hosts,
                skills: parsed.skills || [],
                defaultHostId
            }
            if (
                repaired.changed ||
                defaultHostId !== parsed.defaultHostId ||
                !parsed.a2a ||
                legacyA2AServerConfig ||
                parsed.agents?.pi === undefined ||
                missingBridge
            ) {
                await this.writeConfigFile()
            }
        } catch {
            this.nexusConfig = createDefaultNexusConfig(this.pluginConfig)
            await this.writeConfigFile()
        }
    }

    private async writeConfigFile() {
        const { writeFile, mkdir } = await import('fs/promises')
        await mkdir(this.dataPath, { recursive: true })
        const file = path.join(this.dataPath, 'config.json')
        await writeFile(file, JSON.stringify(this.nexusConfig, null, 2), 'utf8')
    }
}

async function packLocalBridgePackage() {
    const { access, mkdtemp, readFile, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { execFile } = await import('child_process')
    const root = path.resolve(__dirname, '..')
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    if (manifest?.name !== 'koishi-plugin-agent-nexus') {
        throw new Error(`AgentNexus package root not found: ${root}`)
    }
    await access(path.join(root, 'lib', 'bridge.js')).catch(() => {
        throw new Error('本地包缺少 lib/bridge.js，请先执行 npm run build。')
    })

    const temp = await mkdtemp(path.join(tmpdir(), 'agent-nexus-bridge-pack-'))
    try {
        const args = [
            'pack',
            '--json',
            '--ignore-scripts',
            '--pack-destination',
            temp
        ]
        const npmExecPath = await resolveNpmExecPath(access)
        const command = npmExecPath ? process.execPath : 'npm'
        const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(
                command,
                commandArgs,
                {
                    cwd: root,
                    encoding: 'utf8',
                    maxBuffer: 4 * 1024 * 1024
                },
                (error, output, stderr) => {
                    if (error) {
                        reject(
                            new Error(
                                `本地 Bridge 打包失败：${String(stderr || error.message).trim()}`
                            )
                        )
                    } else {
                        resolve(output)
                    }
                }
            )
        })
        const packed = JSON.parse(stdout)
        const filename = Array.isArray(packed) ? packed[0]?.filename : undefined
        if (typeof filename !== 'string' || !filename) {
            throw new Error('npm pack 未返回 Bridge 压缩包名称。')
        }
        return await readFile(path.join(temp, filename))
    } finally {
        await rm(temp, { recursive: true, force: true })
    }
}

async function resolveNpmExecPath(
    access: (path: string) => Promise<void>
): Promise<string | undefined> {
    const configured = process.env.npm_execpath
    const candidates = [
        configured && /npm-cli\.js$/i.test(configured) ? configured : undefined,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(
            path.dirname(process.execPath),
            '..',
            'lib',
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js'
        )
    ].filter((value): value is string => Boolean(value))
    for (const candidate of candidates) {
        try {
            await access(candidate)
            return candidate
        } catch {}
    }
    if (process.platform === 'win32') {
        throw new Error('未找到 npm-cli.js，无法打包本地 Bridge。')
    }
    return undefined
}

function initialBridgeStatus(host: SshHostConfig): BridgeHostStatus {
    const publicBaseUrl = bridgePublicBaseUrl(host)
    return {
        enabled: host.bridge.enabled,
        state: host.bridge.enabled ? 'unknown' : 'disabled',
        endpointUrl: `${publicBaseUrl}/a2a`,
        cardUrl: `${publicBaseUrl}/.well-known/agent-card.json`,
        agents: []
    }
}

function emptyAgents(): DetectedAgent[] {
    return listAdapters().map((a) => ({
        kind: a.kind,
        installed: false,
        skillDirs: a.skillDirs('~')
    }))
}

declare module 'koishi' {
    interface Context {
        agent_nexus: AgentNexusService
    }
}
