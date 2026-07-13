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
import { createDefaultNexusConfig } from './config'
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
    hostConnectionChanged,
    mergeHostSecrets,
    redactNexusConfig
} from './utils/config'

interface ManagedTerminal {
    terminal: TerminalHandle
    token: string
    hostId: string
    persistent: boolean
    expiresAt: number
    attached: boolean
}

export class AgentNexusService extends Service {
    static readonly inject = ['chatluna']

    private pool = new SshSessionPool()
    private proxy: NexusTerminalProxy
    private terminals = new Map<string, Map<string, ManagedTerminal>>()
    private agentCache = new Map<string, DetectedAgent[]>()
    private skillCache: SkillInfo[] = []
    private toolDispose: (() => void)[] = []
    private reconnectTimer?: NodeJS.Timeout
    private reconnecting = false
    private nexusConfig: NexusConfig
    private dataPath: string

    constructor(
        ctx: Context,
        private pluginConfig: { defaultTimeoutMs: number; skillRoot: string }
    ) {
        super(ctx, 'agent_nexus')
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.nexusConfig = createDefaultNexusConfig(pluginConfig)
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
        void this.ensureDefaultConnection(true)
        this.reconnectTimer = setInterval(() => {
            void this.ensureDefaultConnection()
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
                await this.pool.destroyByHost(previous.id)
                this.agentCache.delete(previous.id)
            }
        }
        this.nexusConfig = nextConfig
        await this.writeConfigFile()
        this.syncTools()
        void this.ensureDefaultConnection(true)
        await this.refreshConsoleData()
    }

    getStatus(): NexusStatus {
        const hosts: HostStatus[] = this.nexusConfig.hosts.map((host) => {
            const agents = this.agentCache.get(host.id) || emptyAgents()
            return {
                id: host.id,
                name: host.name,
                host: `${host.username}@${host.host}:${host.port || 22}`,
                state: host.enabled ? 'idle' : 'error',
                error: host.enabled ? undefined : 'disabled',
                agents,
                sessionCount: this.pool.countByHost(host.id)
            }
        })

        return {
            enabled: this.nexusConfig.hosts.some((h) => h.enabled),
            defaultHostId: this.nexusConfig.defaultHostId || this.nexusConfig.hosts[0]?.id,
            hosts,
            skills: {
                total: this.skillCache.length,
                items: this.skillCache
            },
            activeSessions: this.pool.list().length
        }
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
            return {
                ok: true,
                output: result.stdout.trim()
            }
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
            } catch (err) {
                this.agentCache.set(
                    host.id,
                    emptyAgents().map((a) => ({
                        ...a,
                        installed: false
                    }))
                )
                this.ctx.logger.warn(`[agent-nexus] ${getErrorMessage(err)}`)
            }
        }

        return this.getStatus()
    }

    async refreshSkills(hostId?: string) {
        const host = this.resolveHost(hostId)
        const session = await this.pool.getOrCreate(host)
        this.skillCache = await listRemoteSkills(
            session,
            this.nexusConfig,
            this.installedAgentKinds(host.id)
        )
        return this.skillCache
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

            this.skillCache = await listRemoteSkills(session, this.nexusConfig, agents)
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
            timeoutMs
        })

        const result = adapter.parseResult(
            exec.stdout,
            exec.stderr,
            exec.exitCode,
            exec.timedOut,
            command
        )

        let published: PublishResult[] | undefined
        if (input.publishFiles && result.files.length) {
            published = await this.publishFiles(
                result.files,
                host.id,
                input.cwd || host.cwd
            )
        }

        return { ...result, published, hostId: host.id }
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
                const storage = (this.ctx as any).chatluna_storage
                if (storage?.createTempFileFromStream) {
                    const asset = await session.openAsset(canonicalPath)
                    const file = await storage.createTempFileFromStream(
                        asset.stream,
                        name,
                        { size: asset.size }
                    )
                    out.push({ path: remotePath, name, url: file.url })
                } else {
                    const buf = await session.readFile(canonicalPath)
                    // fallback: data URL for small files only
                    if (buf.length > 2 * 1024 * 1024) {
                        out.push({
                            path: remotePath,
                            name,
                            error: 'chatluna_storage unavailable and file too large'
                        })
                    } else {
                        const b64 = buf.toString('base64')
                        out.push({
                            path: remotePath,
                            name,
                            url: `data:application/octet-stream;base64,${b64}`
                        })
                    }
                }
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
        const host = this.resolveHost(input.hostId)
        const session = await this.pool.getOrCreate(
            host,
            `console:${clientId}:${host.id}`
        )
        const terminal = await session.createTerminal({
            cols: input.cols,
            rows: input.rows,
            cwd: input.cwd || host.cwd
        })
        const token = randomUUID()
        const map =
            this.terminals.get(session.sessionId) ??
            new Map<string, ManagedTerminal>()
        map.set(terminal.id, {
            terminal,
            token,
            hostId: host.id,
            persistent: false,
            expiresAt: Date.now() + 60_000,
            attached: false
        })
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
        return item
    }

    handleTerminalClose(sessionId: string, terminalId: string) {
        const map = this.terminals.get(sessionId)
        const item = map?.get(terminalId)
        if (!item || item.persistent) return
        item.terminal.kill()
        map?.delete(terminalId)
        if (map && map.size < 1) this.terminals.delete(sessionId)
    }

    async closeTerminal(sessionId: string, terminalId: string) {
        const map = this.terminals.get(sessionId)
        const item = map?.get(terminalId)
        if (!item) return
        item.terminal.kill()
        map?.delete(terminalId)
        if (map && map.size < 1) this.terminals.delete(sessionId)
    }

    private async closeAllTerminals() {
        for (const [sid, map] of this.terminals) {
            for (const [tid, item] of map) {
                item.terminal.kill()
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

    private async ensureDefaultConnection(scan = false) {
        if (this.reconnecting) return
        const host = this.nexusConfig.hosts.find(
            (item) => item.id === this.nexusConfig.defaultHostId && item.enabled
        ) ?? this.nexusConfig.hosts.find((item) => item.enabled)
        if (!host) return

        this.reconnecting = true
        this.pool.keepAlive(host.id)
        try {
            await this.pool.getOrCreate(host)
            if (scan || !this.agentCache.has(host.id)) await this.scanAgents(host.id)
        } catch (err) {
            this.ctx.logger.warn(`[agent-nexus] SSH reconnect failed: ${getErrorMessage(err)}`)
        } finally {
            this.reconnecting = false
        }
    }

    private resolveHost(hostId?: string): SshHostConfig {
        if (hostId) return this.requireHost(hostId)
        const id = this.nexusConfig.defaultHostId || this.nexusConfig.hosts.find((h) => h.enabled)?.id
        if (!id) throw new Error('No SSH host configured.')
        return this.requireHost(id)
    }

    private requireHost(hostId: string) {
        const host = this.nexusConfig.hosts.find((h) => h.id === hostId)
        if (!host) throw new Error(`Host not found: ${hostId}`)
        if (!host.enabled) throw new Error(`Host disabled: ${host.name}`)
        return host
    }

    private async loadConfig() {
        const { readFile, mkdir } = await import('fs/promises')
        await mkdir(this.dataPath, { recursive: true })
        const file = path.join(this.dataPath, 'config.json')
        try {
            const raw = await readFile(file, 'utf8')
            const parsed = JSON.parse(raw) as NexusConfig
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
                hosts: parsed.hosts || [],
                skills: parsed.skills || []
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
