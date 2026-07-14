import { randomUUID } from 'crypto'
import { Context, Service } from 'koishi'
import path from 'path'
import type {
    AgentKind,
    AgentResult,
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
import { getErrorMessage } from './utils/shell'
import {
    buildRemoteRealpathCommand,
    isRemotePathWithinRoot
} from './utils/security'
import {
    assertUniqueHostName,
    hostConnectionChanged,
    mergeHostSecrets,
    normalizeHostName,
    patchHostConfig,
    redactNexusConfig,
    repairHostIds,
    resolveHostReference
} from './utils/config'
import { registerNexusCommands } from './commands'
import type { Config } from './config'

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
    private terminals = new Map<string, Map<string, ManagedTerminal>>()
    private agentCache = new Map<string, DetectedAgent[]>()
    private skillCache = new Map<string, SkillInfo[]>()
    private toolDispose: (() => void)[] = []
    private reconnectTimer?: NodeJS.Timeout
    private reconnecting = false
    private nexusConfig: NexusConfig
    private dataPath: string
    private activeByHost = new Map<string, number>()
    private hostErrors = new Map<string, string>()

    constructor(
        ctx: Context,
        private pluginConfig: Config
    ) {
        super(ctx, 'agent_nexus')
        this.pool = new SshSessionPool(pluginConfig.maxOutputBytes)
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.nexusConfig = createDefaultNexusConfig(pluginConfig)
        this.proxy = new NexusTerminalProxy(ctx, this)
    }

    async start() {
        await this.loadConfig()
        registerNexusCommands(this.ctx, this, this.pluginConfig)
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
        await this.refreshConsoleData()
    }

    async stop() {
        for (const d of this.toolDispose) d()
        this.toolDispose = []
        this.proxy.stop()
        if (this.reconnectTimer) clearInterval(this.reconnectTimer)
        this.reconnectTimer = undefined
        this.pool.stopIdleCleanup()
        await this.closeAllTerminals()
        await this.pool.clear()
    }

    getConfig() {
        return redactNexusConfig(this.nexusConfig)
    }

    async saveConfig(cfg: NexusConfig) {
        const previousHosts = new Map(this.nexusConfig.hosts.map((host) => [host.id, host]))
        const hosts = (cfg.hosts || []).map((host) =>
            mergeHostSecrets(host, previousHosts.get(host.id))
        )
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
            runtime: {
                ...cfg.runtime,
                defaultTimeoutMs:
                    cfg.runtime?.defaultTimeoutMs ??
                    this.pluginConfig.defaultTimeoutMs
            },
            skillRoot: cfg.skillRoot || this.pluginConfig.skillRoot
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
                lastConnectedAt: connected?.lastConnectedAt
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
            activeSessions: this.pool.list().length
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
                            skillDirs: adapter.skillDirs('~')
                        })
                        continue
                    }
                    detected.push(await adapter.detect(session))
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
            const agent = await this.resolveAgent(host, session.sessionId, input.agent)
            const adapter = getAdapter(agent)

            const prompt = appendFileHint(input.prompt)
            const timeoutMs =
                input.timeoutMs ??
                this.nexusConfig.runtime.defaultTimeoutMs ??
                this.pluginConfig.defaultTimeoutMs

            const command = adapter.buildCommand({
                prompt,
                cwd: input.cwd || host.cwd,
                model: input.model,
                timeoutMs,
                openclawAgent: input.openclawAgent,
                runtime: this.nexusConfig.runtime
            })

            const exec = await session.exec(command, {
                cwd: input.cwd || host.cwd,
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
                    input.cwd || host.cwd
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
            new NexusListSkillsTool(this)
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
    ): Promise<AgentKind> {
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
            if (hit) return hit.kind
            throw new Error(`Agent ${want} is not available on host ${host.name}`)
        }

        const order: AgentKind[] = [
            'hermes',
            'openclaw',
            'claude',
            'opencode',
            'codex'
        ]
        for (const kind of order) {
            if (installed.some((a) => a.kind === kind)) return kind
        }
        return installed[0].kind
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
            const repaired = repairHostIds(parsed.hosts || [])
            const defaultHostId = repaired.hosts.some(
                (host) => host.id === parsed.defaultHostId
            )
                ? parsed.defaultHostId
                : repaired.hosts.find((host) => host.enabled)?.id || repaired.hosts[0]?.id
            this.nexusConfig = {
                ...createDefaultNexusConfig(this.pluginConfig),
                ...parsed,
                agents: {
                    ...createDefaultNexusConfig().agents,
                    ...parsed.agents
                },
                runtime: {
                    ...createDefaultNexusConfig(this.pluginConfig).runtime,
                    ...parsed.runtime
                },
                hosts: repaired.hosts,
                skills: parsed.skills || [],
                defaultHostId
            }
            if (repaired.changed || defaultHostId !== parsed.defaultHostId) {
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
