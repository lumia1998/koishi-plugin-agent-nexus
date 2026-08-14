import { randomUUID } from 'crypto'
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
    DetectedAgent,
    HostStatus,
    NexusConfig,
    NexusConsoleData,
    NexusStatus,
    SkillInfo,
    SkillSourceConfig,
    SshHostConfig,
    TerminalInfo
} from './types'
import { createDefaultNexusConfig, createHost } from './config'
import { SshSessionPool } from './ssh/pool'
import type { TerminalHandle } from './ssh/session'
import { getAdapter, listAdapters } from './adapters'
import {
    enabledAgentKinds,
    listRemoteSkills,
    syncSkillSource
} from './skills/sync'
import { NexusTerminalProxy } from './proxy'
import { NexusA2ADelegateTool } from './tools/a2a_delegate'
import { getErrorMessage } from './utils/shell'
import {
    moveCorruptFileAside,
    writeTextFileAtomic
} from './utils/atomic-file'
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
import type { Config } from './config'
import { SftpFileManager } from './files/manager'
import { A2AClientService, validateRemoteUrl } from './a2a/client'
import {
    A2ADelegationManager,
    type A2ADelegateToolInput
} from './a2a/delegation-manager'
import {
    A2ADelegationStore,
    type A2ADelegationContext,
    type A2ADelegationTask
} from './a2a/delegation-store'
import { notifyChatLunaA2ADelegation } from './a2a/chatluna-wakeup'
import { buildAgentMaintenancePlan } from './agents/maintenance'

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
    private a2aClient: A2AClientService
    private a2aDelegationStore: A2ADelegationStore
    private a2aDelegations: A2ADelegationManager
    private a2aRemoteStatus = new Map<string, A2ARemoteStatus>()
    private terminals = new Map<string, Map<string, ManagedTerminal>>()
    private agentCache = new Map<string, DetectedAgent[]>()
    private skillCache = new Map<string, SkillInfo[]>()
    private toolDispose: (() => void)[] = []
    private reconnectTimer?: NodeJS.Timeout
    private hostKeyWriteQueue = Promise.resolve()
    private reconnecting = false
    private nexusConfig: NexusConfig
    private dataPath: string
    private hostErrors = new Map<string, string>()
    private maintenanceLocks = new Set<string>()

    constructor(
        ctx: Context,
        private pluginConfig: Config
    ) {
        super(ctx, 'agent_nexus')
        this.pool = new SshSessionPool(
            pluginConfig.maxOutputBytes,
            (hostId, fingerprint) => this.rememberHostKey(hostId, fingerprint)
        )
        this.a2aClient = new A2AClientService(
            pluginConfig.a2aMaxResponseBytes
        )
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.nexusConfig = createDefaultNexusConfig(pluginConfig)
        this.a2aDelegationStore = new A2ADelegationStore(
            path.join(this.dataPath, 'a2a-tasks.json')
        )
        this.a2aDelegations = new A2ADelegationManager(
            this.a2aDelegationStore,
            {
                listRemotes: () => this.getA2AStatus().remotes,
                resolveRemoteId: (reference) =>
                    this.resolveA2ARemoteId(reference),
                send: (remoteId, input) =>
                    this.sendA2AMessage({ remoteId, ...input }),
                get: (remoteId, taskId) =>
                    this.getA2ATask(remoteId, taskId),
                cancel: (remoteId, taskId) =>
                    this.cancelA2ATask(remoteId, taskId),
                discover: async (remoteId) => {
                    await this.discoverA2ARemote(remoteId)
                },
                notify: (task) => this.notifyA2ADelegation(task)
            }
        )
        this.proxy = new NexusTerminalProxy(ctx, this)
    }

    async start() {
        await this.loadConfig()
        this.pool.startIdleCleanup((hostId) => {
            const host = this.nexusConfig.hosts.find((h) => h.id === hostId)
            return host?.idleTimeoutMs ?? 15 * 60 * 1000
        })
        this.proxy.start()
        this.syncTools()
        await this.a2aDelegations.start()
        void this.ensureEnabledConnections(true)
        this.reconnectTimer = setInterval(() => {
            void this.ensureEnabledConnections()
        }, 30000)
        await this.refreshConsoleData()
    }

    async stop() {
        await this.a2aDelegations.stop()
        for (const d of this.toolDispose) d()
        this.toolDispose = []
        this.proxy.stop()
        if (this.reconnectTimer) clearInterval(this.reconnectTimer)
        this.reconnectTimer = undefined
        this.pool.stopIdleCleanup()
        await this.closeAllTerminals()
        await this.pool.clear()
        await this.hostKeyWriteQueue
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

    handleA2ADelegate(
        input: A2ADelegateToolInput,
        context: A2ADelegationContext,
        signal?: AbortSignal
    ) {
        return this.a2aDelegations.handle(input, context, signal)
    }

    private async notifyA2ADelegation(task: A2ADelegationTask) {
        await notifyChatLunaA2ADelegation((this.ctx as any).chatluna, task)
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

    async saveConfig(cfg: NexusConfig) {
        const previousHosts = new Map(this.nexusConfig.hosts.map((host) => [host.id, host]))
        const hosts = (cfg.hosts || []).map((host) => {
            const previous = previousHosts.get(host.id)
            return mergeHostSecrets(
                createHost(host),
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
            hosts,
            agents: {
                ...createDefaultNexusConfig(this.pluginConfig).agents,
                ...(cfg.agents || {})
            },
            skills: cfg.skills || [],
            skillRoot: cfg.skillRoot || this.pluginConfig.skillRoot,
            defaultHostId: cfg.defaultHostId,
            a2a: mergeA2ASecrets(
                {
                    ...createDefaultNexusConfig(this.pluginConfig).a2a,
                    ...(cfg.a2a || {}),
                    remotes: cfg.a2a?.remotes || this.nexusConfig.a2a.remotes
                },
                this.nexusConfig.a2a
            )
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
        for (const host of hosts) {
            try {
                const session = await this.pool.getOrCreate(host)
                const detected: DetectedAgent[] = []
                for (const adapter of listAdapters()) {
                    if (!this.nexusConfig.agents[adapter.kind]) {
                        detected.push({
                            kind: adapter.kind,
                            installed: false,
                            scanned: true,
                            skillDirs: adapter.skillDirs('~')
                        })
                        continue
                    }
                    try {
                        detected.push(
                            await this.withAgentMaintenanceInfo(
                                await adapter.detect(session)
                            )
                        )
                    } catch (err) {
                        detected.push({
                            kind: adapter.kind,
                            installed: false,
                            scanned: true,
                            skillDirs: adapter.skillDirs('~')
                        })
                        this.ctx.logger.warn(
                            `[agent-nexus] ${host.name}/${adapter.kind} detect failed: ${getErrorMessage(err)}`
                        )
                    }
                }
                this.agentCache.set(host.id, detected)
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
            throw new Error('该 Agent 正在安装，请稍候。')
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
            if (current.installed) {
                throw new Error('该 Agent 已安装，AgentNexus 只提供安装，不提供更新。')
            }
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
                await adapter.detect(session)
            )
            if (!agent.installed) {
                throw new Error('安装命令已结束，但重新扫描仍未发现可执行文件。')
            }
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

    private async withAgentMaintenanceInfo(
        agent: DetectedAgent
    ) {
        const plan = !agent.installed
            ? buildAgentMaintenancePlan(agent.kind, false)
            : undefined
        return {
            ...agent,
            maintenanceMethod: plan?.method
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

        const tool = new NexusA2ADelegateTool(this)
        this.toolDispose.push(
            platform.registerTool(tool.name, {
                description: tool.description,
                selector: () => true,
                createTool: () => tool,
                meta: {
                    source: 'extension',
                    group: 'agent-nexus',
                    tags: ['agent-nexus', 'a2a'],
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
        let raw: string
        try {
            raw = await readFile(file, 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            this.nexusConfig = createDefaultNexusConfig(this.pluginConfig)
            await this.writeConfigFile()
            return
        }

        let parsed: NexusConfig
        try {
            const value = JSON.parse(raw) as unknown
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('AgentNexus config root must be an object')
            }
            const candidate = value as Partial<NexusConfig>
            if (candidate.hosts !== undefined && !Array.isArray(candidate.hosts)) {
                throw new Error('AgentNexus config hosts must be an array')
            }
            if (candidate.skills !== undefined && !Array.isArray(candidate.skills)) {
                throw new Error('AgentNexus config skills must be an array')
            }
            if (
                candidate.a2a !== undefined &&
                (!candidate.a2a || typeof candidate.a2a !== 'object')
            ) {
                throw new Error('AgentNexus config a2a must be an object')
            }
            if (
                candidate.agents !== undefined &&
                (!candidate.agents ||
                    typeof candidate.agents !== 'object' ||
                    Array.isArray(candidate.agents))
            ) {
                throw new Error('AgentNexus config agents must be an object')
            }
            parsed = candidate as NexusConfig
        } catch (error) {
            const backupPath = await moveCorruptFileAside(file)
            this.ctx.logger.error(
                `[agent-nexus] invalid config moved to ${backupPath}: ${getErrorMessage(error)}`
            )
            this.nexusConfig = createDefaultNexusConfig(this.pluginConfig)
            await this.writeConfigFile()
            return
        }

        const defaults = createDefaultNexusConfig(this.pluginConfig)
        const parsedA2A = (parsed.a2a || {}) as A2AConfig &
            Record<string, unknown>
        const missingHostKeyPolicy = (parsed.hosts || []).some(
            (host) => !host.hostKeyPolicy
        )
        const repaired = repairHostIds(
            (parsed.hosts || []).map((host) => createHost(host))
        )
        const defaultHostId = repaired.hosts.some(
            (host) => host.id === parsed.defaultHostId
        )
            ? parsed.defaultHostId
            : repaired.hosts.find((host) => host.enabled)?.id || repaired.hosts[0]?.id
        this.nexusConfig = {
            hosts: repaired.hosts,
            agents: {
                ...defaults.agents,
                ...parsed.agents
            },
            skills: parsed.skills || [],
            skillRoot: parsed.skillRoot || defaults.skillRoot,
            defaultHostId,
            a2a: {
                remotes: parsedA2A.remotes || []
            }
        }
        if (
            repaired.changed ||
            defaultHostId !== parsed.defaultHostId ||
            !parsed.a2a ||
            parsed.agents?.pi === undefined ||
            missingHostKeyPolicy
        ) {
            await this.writeConfigFile()
        }
    }

    private async writeConfigFile() {
        const file = path.join(this.dataPath, 'config.json')
        await writeTextFileAtomic(
            file,
            `${JSON.stringify(this.nexusConfig, null, 2)}\n`
        )
    }

    private rememberHostKey(hostId: string, fingerprint: string) {
        const host = this.nexusConfig.hosts.find((item) => item.id === hostId)
        if (!host) return
        host.hostKeyFingerprint = fingerprint
        const write = () => this.writeConfigFile()
        this.hostKeyWriteQueue = this.hostKeyWriteQueue
            .then(write, write)
            .catch((error) => {
                this.ctx.logger.warn(
                    `[agent-nexus] failed to persist SSH host key: ${getErrorMessage(error)}`
                )
            })
    }
}

function emptyAgents(): DetectedAgent[] {
    return listAdapters().map((a) => ({
        kind: a.kind,
        installed: false,
        scanned: false,
        skillDirs: a.skillDirs('~')
    }))
}

declare module 'koishi' {
    interface Context {
        agent_nexus: AgentNexusService
    }
}
