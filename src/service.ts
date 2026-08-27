import { createHash } from 'crypto'
import { Context, Service } from 'koishi'
import path from 'path'
import { Readable } from 'stream'
import type {
    DelegationAgentConfig,
    GatewayRemoteConfig,
    NexusConfig,
    NexusConsoleData,
    NexusStatus
} from './types'
import {
    createGatewayConnection,
    createDefaultNexusConfig,
    normalizeStoredNexusConfig,
    type Config
} from './config'
import { registerAgentDelegationTools } from './tools/delegate'
import { getErrorMessage } from './utils/shell'
import { moveCorruptFileAside, writeTextFileAtomic } from './utils/atomic-file'
import { redactNexusConfig } from './utils/config'
import {
    DelegationManager,
    DelegationProviderRegistry,
    DelegationStore,
    notifyChatLunaDelegation,
    type DelegateToolInput,
    type DelegationArtifact,
    type DelegationContext,
    type DelegationJob,
    buildDelegationToolNames,
    delegationToolNameForJob
} from './delegation'
import { NexusGatewayProvider } from './providers'
import { NexusGatewayClient } from './gateway'

export class AgentNexusService extends Service {
    static readonly inject = ['chatluna', 'chatluna_storage']

    private readonly gatewayRemote: GatewayRemoteConfig
    private readonly gatewayClient: NexusGatewayClient
    private readonly gatewayProvider: NexusGatewayProvider
    private readonly delegationStore: DelegationStore
    private readonly delegations: DelegationManager
    private readonly delegationProviders: DelegationProviderRegistry
    private toolDispose: (() => void)[] = []
    private remoteRefreshTimer?: NodeJS.Timeout
    private running = false
    private nexusConfig: NexusConfig
    private readonly dataPath: string

    constructor(
        ctx: Context,
        private readonly pluginConfig: Config
    ) {
        super(ctx, 'agent_nexus')
        this.gatewayRemote = createGatewayConnection(pluginConfig)
        this.gatewayClient = new NexusGatewayClient(pluginConfig.maxResponseBytes)
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.nexusConfig = createDefaultNexusConfig()

        this.gatewayProvider = new NexusGatewayProvider({
            getConfig: () => this.nexusConfig,
            remote: this.gatewayRemote,
            client: this.gatewayClient
        })
        this.delegationProviders = new DelegationProviderRegistry().register(
            this.gatewayProvider
        )
        this.delegationStore = new DelegationStore(
            path.join(this.dataPath, 'delegation-jobs.json')
        )
        this.delegations = new DelegationManager(
            this.delegationStore,
            this.delegationProviders,
            (job) => this.notifyDelegation(job),
            {
                prepareArtifacts: (artifacts, job) =>
                    this.prepareDelegationArtifacts(artifacts, job)
            }
        )
    }

    async start() {
        await this.loadConfig()
        this.running = true
        this.syncTools()
        await this.delegations.start()
        void this.refreshRemoteStatuses().catch((error) => {
            this.ctx.logger.warn(
                `[agent-nexus] initial remote discovery failed: ${getErrorMessage(error)}`
            )
        })
        this.remoteRefreshTimer = setInterval(() => {
            void this.refreshRemoteStatuses().catch((error) => {
                this.ctx.logger.warn(
                    `[agent-nexus] periodic Gateway discovery failed: ${getErrorMessage(error)}`
                )
            })
        }, 60_000)
        this.remoteRefreshTimer.unref?.()
    }

    async stop() {
        this.running = false
        await this.delegations.stop()
        for (const dispose of this.toolDispose) dispose()
        this.toolDispose = []
        if (this.remoteRefreshTimer) clearInterval(this.remoteRefreshTimer)
        this.remoteRefreshTimer = undefined
    }

    get commandAuthority() {
        return this.pluginConfig.commandAuthority
    }

    getConfig() {
        return redactNexusConfig(this.nexusConfig)
    }

    handleDelegate(
        input: DelegateToolInput,
        context?: DelegationContext,
        signal?: AbortSignal
    ) {
        return this.delegations.handle(input, context, signal)
    }

    getGatewayStatus() {
        return this.gatewayProvider.getStatus()
    }

    getDelegationStatus() {
        const agents = this.delegationProviders.listAgents()
        const toolNames = buildDelegationToolNames(
            agents.filter((agent) => agent.enabled)
        )
        return {
            agents: agents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                toolName: agent.enabled
                    ? toolNames.get(agent.id) ||
                      delegationToolNameForJob({
                          toolName: undefined,
                          agentId: agent.id,
                          agentName: agent.name,
                          providerAgentId: agent.agentId
                      })
                    : undefined,
                enabled: agent.enabled,
                agentId: agent.agentId || agent.id,
                protocol: agent.protocol,
                workspace: agent.workspace,
                description: agent.description,
                skills: agent.skills.map((skill) => skill.id),
                state: agent.state,
                error: agent.error
            }))
        }
    }

    async discoverGateway() {
        try {
            return await this.gatewayProvider.discoverRemote()
        } finally {
            this.syncTools()
        }
    }

    async refreshRemoteStatuses() {
        await this.discoverGateway()
        return this.getStatus()
    }

    async saveDelegationAgent(input: Partial<DelegationAgentConfig>) {
        const agentId = String(input.agentId || '').trim()
        const name = String(input.name || '').trim() || agentId
        if (!agentId) throw new Error('Gateway Agent ID 不能为空。')
        const workspace = String(input.workspace || '').trim() || undefined
        const agents = [...this.nexusConfig.delegation.agents]
        const index = agents.findIndex((agent) => agent.agentId === agentId)
        const previous = index >= 0 ? agents[index] : undefined
        const next: DelegationAgentConfig = {
            agentId,
            name,
            enabled: input.enabled ?? previous?.enabled ?? true,
            workspace,
            description: String(input.description || '').trim() || undefined,
            skills: Array.isArray(input.skills)
                ? input.skills.map((item) => String(item).trim()).filter(Boolean)
                : previous?.skills
        }
        if (index >= 0) agents[index] = next
        else agents.push(next)
        this.nexusConfig = {
            ...this.nexusConfig,
            delegation: { ...this.nexusConfig.delegation, agents }
        }
        await this.writeConfigFile()
        this.syncTools()
        return { agentId, data: this.getConsoleData() }
    }

    async removeDelegationAgent(id: string) {
        this.nexusConfig = {
            ...this.nexusConfig,
            delegation: {
                ...this.nexusConfig.delegation,
                agents: this.nexusConfig.delegation.agents.filter(
                    (agent) => agent.agentId !== id
                )
            }
        }
        await this.writeConfigFile()
        this.syncTools()
        return this.getConsoleData()
    }

    getStatus(): NexusStatus {
        return {
            gateway: this.getGatewayStatus(),
            delegation: this.getDelegationStatus()
        }
    }

    getConsoleData(): NexusConsoleData {
        return {
            config: redactNexusConfig(this.nexusConfig),
            status: this.getStatus(),
            gatewayKeyConfigured: this.gatewayRemote.enabled
        }
    }

    private async notifyDelegation(job: DelegationJob) {
        await notifyChatLunaDelegation(
            (this.ctx as any).chatluna,
            job,
            this.delegationToolName(job)
        )
    }

    private async prepareDelegationArtifacts(
        artifacts: DelegationArtifact[],
        job: DelegationJob
    ) {
        const existingById = new Map(
            job.artifacts
                .filter((artifact) => artifact.artifactId && artifact.url)
                .map((artifact) => [artifact.artifactId!, artifact])
        )
        return Promise.all(
            artifacts.map(async (artifact) => {
                if (!artifact.bytesBase64) return artifact
                const existing = artifact.artifactId
                    ? existingById.get(artifact.artifactId)
                    : undefined
                if (existing?.url) {
                    return {
                        ...artifact,
                        name: artifact.name || existing.name,
                        filename: artifact.filename || existing.filename,
                        url: existing.url,
                        bytesBase64: undefined,
                        metadata: { ...existing.metadata, ...artifact.metadata }
                    }
                }

                const bytes = decodeArtifactBase64(artifact.bytesBase64)
                if (bytes.length > MAX_DELEGATION_ARTIFACT_BYTES) {
                    return {
                        ...artifact,
                        bytesBase64: undefined,
                        text: [
                            artifact.text,
                            `[binary artifact omitted: ${bytes.length} bytes exceed the temporary-file limit]`
                        ]
                            .filter(Boolean)
                            .join('\n')
                    }
                }
                const sha256 = createHash('sha256').update(bytes).digest('hex')
                const artifactId = artifact.artifactId || `sha256:${sha256}`
                const hashedExisting = existingById.get(artifactId)
                if (hashedExisting?.url) {
                    return {
                        ...artifact,
                        artifactId,
                        name: artifact.name || hashedExisting.name,
                        filename: artifact.filename || hashedExisting.filename,
                        url: hashedExisting.url,
                        bytesBase64: undefined,
                        metadata: {
                            ...hashedExisting.metadata,
                            ...artifact.metadata,
                            size: bytes.length,
                            sha256
                        }
                    }
                }
                const filename = delegationArtifactFilename(artifact, sha256)
                const file =
                    await this.ctx.chatluna_storage.createTempFileFromStream(
                        Readable.from([bytes]),
                        filename,
                        {
                            size: bytes.length,
                            mimeType: artifact.mediaType
                        }
                    )
                return {
                    ...artifact,
                    artifactId,
                    name: artifact.name || file.name || filename,
                    filename: artifact.filename || file.name || filename,
                    url: file.url,
                    bytesBase64: undefined,
                    metadata: {
                        ...artifact.metadata,
                        size: bytes.length,
                        sha256
                    }
                }
            })
        )
    }

    private syncTools() {
        for (const dispose of this.toolDispose) dispose()
        this.toolDispose = []
        if (!this.running) return

        const platform = (this.ctx as any).chatluna?.platform
        if (!platform?.registerTool) return
        // Remove names registered by pre-Gateway releases before publishing the
        // current per-Agent tools.
        platform.unregisterTool?.('nexus_a2a_delegate')
        this.toolDispose = registerAgentDelegationTools(
            platform,
            this,
            this.delegationProviders.listAgents()
        )
    }

    private delegationToolName(job: DelegationJob) {
        if (job.toolName) return job.toolName
        const agents = this.delegationProviders
            .listAgents()
            .filter((agent) => agent.enabled)
        const names = buildDelegationToolNames(agents)
        return names.get(job.agentId) || delegationToolNameForJob(job)
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
            this.nexusConfig = createDefaultNexusConfig()
            await this.writeConfigFile()
            return
        }

        let normalized: ReturnType<typeof normalizeStoredNexusConfig>
        try {
            normalized = normalizeStoredNexusConfig(JSON.parse(raw) as unknown)
        } catch (error) {
            const backupPath = await moveCorruptFileAside(file)
            this.ctx.logger.error(
                `[agent-nexus] invalid config moved to ${backupPath}: ${getErrorMessage(error)}`
            )
            this.nexusConfig = createDefaultNexusConfig()
            await this.writeConfigFile()
            return
        }

        this.nexusConfig = normalized.config
        if (normalized.removedLegacy) {
            this.ctx.logger.warn(
                `[agent-nexus] migrated configuration to single-Gateway mode; direct A2A, multi-Gateway and legacy host settings were removed${normalized.droppedAgents ? ` (${normalized.droppedAgents} incompatible Agent route(s) dropped)` : ''}.`
            )
        }
        if (normalized.changed) await this.writeConfigFile()
    }

    private async writeConfigFile() {
        const file = path.join(this.dataPath, 'config.json')
        await writeTextFileAtomic(
            file,
            `${JSON.stringify(this.nexusConfig, null, 2)}\n`
        )
    }
}

const MAX_DELEGATION_ARTIFACT_BYTES = 32 * 1024 * 1024

function decodeArtifactBase64(value: string) {
    const normalized = value.replace(/\s/g, '')
    if (
        !normalized ||
        normalized.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
        throw new Error('Gateway returned invalid base64 artifact data.')
    }
    const bytes = Buffer.from(normalized, 'base64')
    if (
        bytes.toString('base64').replace(/=+$/, '') !==
        normalized.replace(/=+$/, '')
    ) {
        throw new Error('Gateway returned invalid base64 artifact data.')
    }
    return bytes
}

function delegationArtifactFilename(
    artifact: DelegationArtifact,
    sha256: string
) {
    const preferred = artifact.filename || artifact.name
    const basename = preferred ? path.basename(preferred.replace(/\\/g, '/')) : ''
    const safe = basename
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .slice(0, 180)
    return (
        safe ||
        `agent-nexus-${sha256.slice(0, 12)}${extensionForMediaType(artifact.mediaType)}`
    )
}

function extensionForMediaType(mediaType?: string) {
    const extensions: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'audio/mpeg': '.mp3',
        'audio/wav': '.wav',
        'audio/ogg': '.ogg',
        'application/pdf': '.pdf',
        'application/zip': '.zip'
    }
    return mediaType ? extensions[mediaType.toLowerCase()] || '' : ''
}

declare module 'koishi' {
    interface Context {
        agent_nexus: AgentNexusService
    }
}
