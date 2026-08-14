import { randomBytes, randomUUID } from 'crypto'
import { Context, Service } from 'koishi'
import path from 'path'
import type {
    A2AConfig,
    A2ARemoteConfig,
    A2ARemoteStatus,
    A2ATaskView,
    AgentdAgentKind,
    AgentdDeploymentInput,
    AgentdDeploymentPhase,
    AgentdDeploymentProgress,
    AgentKind,
    AgentMaintenanceInput,
    AgentMaintenanceResult,
    DetectedAgent,
    DelegationAgentConfig,
    GatewayConfig,
    GatewayRemoteConfig,
    GatewayRemoteStatus,
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
    mergeGatewaySecrets,
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
    DelegationManager,
    DelegationProviderRegistry,
    DelegationStore,
    notifyChatLunaDelegation,
    type DelegateToolInput,
    type DelegationContext,
    type DelegationJob
} from './delegation'
import { A2ADelegationProvider, NexusGatewayProvider } from './providers'
import { NexusGatewayClient, validateGatewayUrl } from './gateway'
import { buildAgentMaintenancePlan } from './agents/maintenance'
import {
    deployNexusAgentdRemote,
    normalizeAgentdAgents,
    reconcileManagedDelegationAgents,
    validateAgentdPort
} from './agentd'

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
    private gatewayClient: NexusGatewayClient
    private gatewayProvider: NexusGatewayProvider
    private delegationStore: DelegationStore
    private delegations: DelegationManager
    private delegationProviders: DelegationProviderRegistry
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
    private agentdDeploymentProgress = new Map<string, AgentdDeploymentProgress>()

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
        this.gatewayClient = new NexusGatewayClient(
            pluginConfig.a2aMaxResponseBytes
        )
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.nexusConfig = createDefaultNexusConfig(pluginConfig)
        const a2aProvider = new A2ADelegationProvider({
            getConfig: () => this.nexusConfig,
            getStatus: () => this.getA2AStatus().remotes,
            discover: async (remoteId) => {
                await this.discoverA2ARemote(remoteId)
            },
            client: this.a2aClient
        })
        this.gatewayProvider = new NexusGatewayProvider({
            getConfig: () => this.nexusConfig,
            client: this.gatewayClient
        })
        this.delegationProviders = new DelegationProviderRegistry()
            .register(a2aProvider)
            .register(this.gatewayProvider)
        this.delegationStore = new DelegationStore(
            path.join(this.dataPath, 'delegation-jobs.json'),
            path.join(this.dataPath, 'a2a-tasks.json')
        )
        this.delegations = new DelegationManager(
            this.delegationStore,
            this.delegationProviders,
            (job) => this.notifyDelegation(job)
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
        await this.delegations.start()
        void this.ensureEnabledConnections(true)
        void this.refreshRemoteStatuses().catch((error) => {
            this.ctx.logger.warn(
                `[agent-nexus] initial remote discovery failed: ${getErrorMessage(error)}`
            )
        })
        this.reconnectTimer = setInterval(() => {
            void this.ensureEnabledConnections()
        }, 30000)
        await this.refreshConsoleData()
    }

    async stop() {
        await this.delegations.stop()
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

    getAgentdDeploymentProgress(hostId: string): AgentdDeploymentProgress | null {
        const progress = this.agentdDeploymentProgress.get(hostId)
        return progress ? { ...progress } : null
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
        input: DelegateToolInput,
        context: DelegationContext,
        signal?: AbortSignal
    ) {
        return this.delegations.handle(input, context, signal)
    }

    private async notifyDelegation(job: DelegationJob) {
        await notifyChatLunaDelegation((this.ctx as any).chatluna, job)
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

    getGatewayStatus() {
        return { remotes: this.gatewayProvider.getStatus() }
    }

    getDelegationStatus() {
        return {
            agents: this.delegationProviders.listAgents().map((agent) => ({
                id: agent.id,
                name: agent.name,
                enabled: agent.enabled,
                provider: agent.provider,
                remoteId: agent.remoteId,
                agentId: agent.agentId,
                workspace: agent.workspace,
                description: agent.description,
                skills: agent.skills.map((skill) => skill.id),
                state: agent.state,
                remoteName: agent.remoteName,
                protocolLabel:
                    agent.provider === 'a2a' ? 'A2A' : 'Nexus Gateway + ACP',
                error: agent.error
            }))
        }
    }

    async saveGatewayRemote(
        input: Partial<GatewayRemoteConfig> & { clearAuthToken?: boolean }
    ) {
        const name = String(input.name || '').trim()
        const baseUrl = String(input.baseUrl || '').trim()
        if (!name || !baseUrl) throw new Error('Gateway 名称和地址不能为空。')
        const remotes = [...this.nexusConfig.gateway.remotes]
        const id = String(input.id || '').trim() || randomUUID()
        const index = remotes.findIndex((remote) => remote.id === id)
        const previous = index >= 0 ? remotes[index] : undefined
        const next: GatewayRemoteConfig = {
            id,
            name,
            baseUrl: validateGatewayUrl(baseUrl),
            authToken: input.clearAuthToken
                ? ''
                : input.authToken?.trim() || previous?.authToken,
            enabled: input.enabled ?? previous?.enabled ?? true,
            managedHostId: previous?.managedHostId,
            managedWorkspaceRoots: previous?.managedWorkspaceRoots,
            managedServiceMode: previous?.managedServiceMode,
            managedAgents: previous?.managedAgents
        }
        if (index >= 0) remotes[index] = next
        else remotes.push(next)
        this.nexusConfig = {
            ...this.nexusConfig,
            gateway: { ...this.nexusConfig.gateway, remotes }
        }
        this.gatewayProvider.clearStatus(id)
        await this.writeConfigFile()
        return { remoteId: id, data: this.getConsoleData() }
    }

    async removeGatewayRemote(id: string) {
        this.nexusConfig = {
            ...this.nexusConfig,
            gateway: {
                ...this.nexusConfig.gateway,
                remotes: this.nexusConfig.gateway.remotes.filter(
                    (remote) => remote.id !== id
                )
            }
        }
        this.gatewayProvider.clearStatus(id)
        await this.writeConfigFile()
        return this.getConsoleData()
    }

    async discoverGatewayRemote(id: string) {
        return this.gatewayProvider.discoverRemote(id)
    }

    async refreshRemoteStatuses() {
        await Promise.allSettled([
            ...this.nexusConfig.a2a.remotes
                .filter((remote) => remote.enabled)
                .map((remote) => this.discoverA2ARemote(remote.id)),
            ...this.nexusConfig.gateway.remotes
                .filter((remote) => remote.enabled)
                .map((remote) => this.discoverGatewayRemote(remote.id))
        ])
        return this.getStatus()
    }

    async saveDelegationAgent(input: Partial<DelegationAgentConfig>) {
        const name = String(input.name || '').trim()
        const provider = input.provider
        const remoteId = String(input.remoteId || '').trim()
        if (!name || !remoteId || (provider !== 'a2a' && provider !== 'gateway')) {
            throw new Error('Agent 名称、连接方式和远端不能为空。')
        }
        if (
            provider === 'a2a' &&
            !this.nexusConfig.a2a.remotes.some((remote) => remote.id === remoteId)
        ) {
            throw new Error(`找不到 A2A 远端：${remoteId}`)
        }
        if (
            provider === 'gateway' &&
            !this.nexusConfig.gateway.remotes.some((remote) => remote.id === remoteId)
        ) {
            throw new Error(`找不到 Nexus Gateway：${remoteId}`)
        }
        const agentId = String(input.agentId || '').trim() || undefined
        const workspace = String(input.workspace || '').trim() || undefined
        if (provider === 'gateway' && (!agentId || !workspace)) {
            throw new Error('ACP Agent 必须配置 Gateway Agent ID 和 workspace。')
        }
        const agents = [...this.nexusConfig.delegation.agents]
        const id = String(input.id || '').trim() || randomUUID()
        const index = agents.findIndex((agent) => agent.id === id)
        const previous = index >= 0 ? agents[index] : undefined
        const next: DelegationAgentConfig = {
            id,
            name,
            enabled: input.enabled ?? agents[index]?.enabled ?? true,
            provider,
            remoteId,
            agentId: provider === 'gateway' ? agentId : undefined,
            workspace: provider === 'gateway' ? workspace : undefined,
            description: String(input.description || '').trim() || undefined,
            skills: Array.isArray(input.skills)
                ? input.skills.map((item) => String(item).trim()).filter(Boolean)
                : previous?.skills,
            managedHostId:
                previous?.managedHostId &&
                provider === 'gateway' &&
                remoteId === previous.remoteId &&
                agentId === previous.agentId
                    ? previous.managedHostId
                    : undefined
        }
        if (index >= 0) agents[index] = next
        else agents.push(next)
        this.nexusConfig = {
            ...this.nexusConfig,
            delegation: { ...this.nexusConfig.delegation, agents }
        }
        await this.writeConfigFile()
        return { agentId: id, data: this.getConsoleData() }
    }

    async removeDelegationAgent(id: string) {
        this.nexusConfig = {
            ...this.nexusConfig,
            delegation: {
                ...this.nexusConfig.delegation,
                agents: this.nexusConfig.delegation.agents.filter(
                    (agent) => agent.id !== id
                )
            }
        }
        await this.writeConfigFile()
        return this.getConsoleData()
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
            ),
            gateway: mergeGatewaySecrets(
                {
                    ...createDefaultNexusConfig(this.pluginConfig).gateway,
                    ...(cfg.gateway || {}),
                    remotes:
                        cfg.gateway?.remotes || this.nexusConfig.gateway.remotes
                },
                this.nexusConfig.gateway
            ),
            delegation: {
                agents:
                    cfg.delegation?.agents ||
                    this.nexusConfig.delegation.agents
            }
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
        this.gatewayProvider.clearStatus()
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
            const remotes = this.nexusConfig.gateway.remotes.map((remote) => {
                if (remote.managedHostId !== patched.id) return remote
                try {
                    const current = new URL(remote.baseUrl)
                    const gatewayPort =
                        Number(current.port) ||
                        (current.protocol === 'https:' ? 443 : 80)
                    return {
                        ...remote,
                        baseUrl: managedGatewayUrl(patched.host, gatewayPort)
                    }
                } catch {
                    return remote
                }
            })
            hostId = patched.id
            await this.saveConfig({
                ...this.nexusConfig,
                hosts,
                gateway: { ...this.nexusConfig.gateway, remotes },
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
        const remotes = this.nexusConfig.gateway.remotes.map((remote) =>
            remote.managedHostId === hostId
                ? {
                      ...remote,
                      managedHostId: undefined,
                      managedServiceMode: undefined
                  }
                : remote
        )
        const delegationAgents = this.nexusConfig.delegation.agents.map((agent) =>
            agent.managedHostId === hostId
                ? { ...agent, managedHostId: undefined }
                : agent
        )
        await this.saveConfig({
            ...this.nexusConfig,
            hosts,
            gateway: { ...this.nexusConfig.gateway, remotes },
            delegation: {
                ...this.nexusConfig.delegation,
                agents: delegationAgents
            },
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
            a2a: this.getA2AStatus(),
            gateway: this.getGatewayStatus(),
            delegation: this.getDelegationStatus()
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

    async deployAgentd(
        input: AgentdDeploymentInput
    ): Promise<AgentdDeploymentProgress> {
        this.requireHost(input.hostId)
        validateAgentdPort(input.port)
        if (!normalizeAgentdAgents(input.agents).length) {
            throw new Error('请至少选择一个已安装的 ACP Agent。')
        }
        const key = `${input.hostId}:nexus-agentd`
        if (this.maintenanceLocks.has(key)) {
            throw new Error('该设备正在部署 nexus-agentd，请稍候。')
        }
        this.maintenanceLocks.add(key)
        this.updateAgentdDeploymentProgress(
            input.hostId,
            'running',
            'checking',
            '准备部署',
            1,
            undefined,
            true
        )
        void this.performAgentdDeployment(input, key)
        return this.getAgentdDeploymentProgress(input.hostId)!
    }

    private async performAgentdDeployment(
        input: AgentdDeploymentInput,
        key: string
    ) {
        try {
            const host = this.requireHost(input.hostId)
            const port = validateAgentdPort(input.port)
            const selected = normalizeAgentdAgents(input.agents)
            if (!selected.length) throw new Error('请至少选择一个已安装的 ACP Agent。')
            if (!this.agentCache.has(host.id)) await this.scanAgents(host.id)
            const installed = new Set(
                (this.agentCache.get(host.id) || [])
                    .filter((agent) => agent.installed)
                    .map((agent) => agent.kind)
            )
            const missing = selected.filter((kind) => !installed.has(kind))
            if (missing.length) {
                throw new Error(
                    `请先安装这些 Agent：${missing.map(agentDisplayName).join('、')}`
                )
            }

            const existing = this.nexusConfig.gateway.remotes.find(
                (remote) => remote.managedHostId === host.id
            )
            const token =
                existing?.authToken && !existing.authToken.startsWith('env:')
                    ? existing.authToken
                    : randomBytes(32).toString('base64url')
            const session = await this.pool.getOrCreate(host)
            const deployment = await deployNexusAgentdRemote(
                session,
                {
                    port,
                    workspaceRoots: input.workspaceRoots,
                    agents: selected,
                    token
                },
                (phase, label, percent) =>
                    this.updateAgentdDeploymentProgress(
                        host.id,
                        'running',
                        phase,
                        label,
                        percent
                    )
            )

            this.updateAgentdDeploymentProgress(
                host.id,
                'running',
                'registering',
                '注册 Gateway 与委托 Agent',
                96
            )
            const gatewayId = existing?.id || randomUUID()
            const gateway: GatewayRemoteConfig = {
                id: gatewayId,
                name: existing?.name || `${host.name} ACP`,
                baseUrl: managedGatewayUrl(host.host, port),
                authToken: token,
                enabled: true,
                managedHostId: host.id,
                managedWorkspaceRoots: deployment.workspaceRoots,
                managedServiceMode: deployment.serviceMode,
                managedAgents: selected
            }
            const remotes = [...this.nexusConfig.gateway.remotes]
            const gatewayIndex = remotes.findIndex((remote) => remote.id === gatewayId)
            if (gatewayIndex >= 0) remotes[gatewayIndex] = gateway
            else remotes.push(gateway)

            const delegationAgents = reconcileManagedDelegationAgents(
                this.nexusConfig.delegation.agents,
                {
                    hostId: host.id,
                    hostName: host.name,
                    gatewayId,
                    agents: selected,
                    workspaceRoots: deployment.workspaceRoots,
                    createMissing: input.createDelegationAgents !== false
                }
            )

            this.nexusConfig = {
                ...this.nexusConfig,
                gateway: { ...this.nexusConfig.gateway, remotes },
                delegation: {
                    ...this.nexusConfig.delegation,
                    agents: delegationAgents
                }
            }
            this.gatewayProvider.clearStatus(gatewayId)
            await this.writeConfigFile()
            this.updateAgentdDeploymentProgress(
                host.id,
                'running',
                'discovering',
                '从 Koishi 验证 Gateway',
                98
            )
            const gatewayStatus = await this.discoverGatewayRemote(gatewayId)
            const warnings = [deployment.warning]
            if (gatewayStatus.state === 'error') {
                warnings.push(
                    `远端服务已启动，但 Koishi 无法访问 Gateway：${gatewayStatus.error || 'unknown error'}。请检查 ${gateway.baseUrl} 的路由、防火墙和监听端口。`
                )
            } else {
                const unavailable = selected.filter(
                    (kind) =>
                        !gatewayStatus.agents.some(
                            (agent) => agent.id === kind && agent.ready
                        )
                )
                if (unavailable.length) {
                    warnings.push(
                        `这些 Agent 尚未就绪：${unavailable.map(agentDisplayName).join('、')}`
                    )
                }
            }
            const warning = warnings.filter(Boolean).join('；') || undefined
            this.updateAgentdDeploymentProgress(
                host.id,
                'success',
                'complete',
                'ACP Gateway 已部署并注册',
                100,
                undefined,
                false,
                warning
            )
        } catch (error) {
            const message = getErrorMessage(error)
            this.updateAgentdDeploymentProgress(
                input.hostId,
                'error',
                'failed',
                '部署失败',
                100,
                message
            )
            this.ctx.logger.warn(
                `[agent-nexus] nexus-agentd deployment failed on ${input.hostId}: ${message}`
            )
        } finally {
            this.maintenanceLocks.delete(key)
        }
    }

    private updateAgentdDeploymentProgress(
        hostId: string,
        state: AgentdDeploymentProgress['state'],
        phase: AgentdDeploymentPhase,
        label: string,
        percent: number,
        error?: string,
        reset = false,
        warning?: string
    ) {
        const now = Date.now()
        const previous = this.agentdDeploymentProgress.get(hostId)
        this.agentdDeploymentProgress.set(hostId, {
            hostId,
            state,
            phase,
            label,
            percent: Math.max(0, Math.min(100, Math.round(percent))),
            startedAt: reset || !previous ? now : previous.startedAt,
            updatedAt: now,
            error,
            warning
        })
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
                    tags: ['agent-nexus', 'delegation', 'a2a', 'acp'],
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
            if (candidate.a2a && !Array.isArray(candidate.a2a.remotes)) {
                throw new Error('AgentNexus config a2a.remotes must be an array')
            }
            if (
                candidate.gateway !== undefined &&
                (!candidate.gateway || typeof candidate.gateway !== 'object')
            ) {
                throw new Error('AgentNexus config gateway must be an object')
            }
            if (
                candidate.gateway &&
                !Array.isArray(candidate.gateway.remotes)
            ) {
                throw new Error('AgentNexus config gateway.remotes must be an array')
            }
            if (
                candidate.delegation !== undefined &&
                (!candidate.delegation ||
                    typeof candidate.delegation !== 'object')
            ) {
                throw new Error('AgentNexus config delegation must be an object')
            }
            if (
                candidate.delegation &&
                !Array.isArray(candidate.delegation.agents)
            ) {
                throw new Error('AgentNexus config delegation.agents must be an array')
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
        const parsedGateway = (parsed.gateway || {}) as GatewayConfig &
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
            },
            gateway: {
                remotes: parsedGateway.remotes || []
            },
            delegation: {
                agents: parsed.delegation?.agents || []
            }
        }
        if (
            repaired.changed ||
            defaultHostId !== parsed.defaultHostId ||
            !parsed.a2a ||
            !parsed.gateway ||
            !parsed.delegation ||
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

function managedGatewayUrl(host: string, port: number) {
    const value = host.trim()
    if (!value || /[\s/?#@]/.test(value)) {
        throw new Error(`SSH 主机地址不能用于 Gateway URL：${host}`)
    }
    const hostname = value.startsWith('[') && value.endsWith(']')
        ? value
        : value.includes(':')
          ? `[${value}]`
          : value
    return validateGatewayUrl(`http://${hostname}:${port}`)
}

function agentDisplayName(kind: AgentdAgentKind) {
    const labels: Record<AgentdAgentKind, string> = {
        openclaw: 'OpenClaw',
        claude: 'Claude Code',
        opencode: 'OpenCode',
        codex: 'Codex',
        pi: 'Pi'
    }
    return labels[kind]
}

declare module 'koishi' {
    interface Context {
        agent_nexus: AgentNexusService
    }
}
