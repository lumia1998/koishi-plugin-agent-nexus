import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
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
import { sendDelegationArtifacts } from './delegation/media'
import { NexusGatewayProvider } from './providers'
import { NexusGatewayClient } from './gateway'
import { ArtifactCache, type CachedArtifact } from './artifacts/cache'
import { InputAttachmentReader } from './attachments/reader'

export class AgentNexusService extends Service {
    static readonly inject = ['chatluna', 'chatluna_storage']

    private readonly artifactTicketSecret = randomBytes(32)
    private readonly gatewayRemote: GatewayRemoteConfig
    private readonly gatewayClient: NexusGatewayClient
    private readonly gatewayProvider: NexusGatewayProvider
    private readonly delegationStore: DelegationStore
    private readonly delegations: DelegationManager
    private readonly delegationProviders: DelegationProviderRegistry
    private toolDispose: (() => void)[] = []
    private remoteRefreshTimer?: NodeJS.Timeout
    private artifactPruneTimer?: NodeJS.Timeout
    private running = false
    private nexusConfig: NexusConfig
    private readonly dataPath: string
    private readonly artifactCache: ArtifactCache
    private readonly artifactCacheRelative: string
    private readonly inputAttachmentReader: InputAttachmentReader

    constructor(
        ctx: Context,
        private readonly pluginConfig: Config
    ) {
        super(ctx, 'agent_nexus')
        this.gatewayRemote = createGatewayConnection(pluginConfig)
        this.gatewayClient = new NexusGatewayClient(pluginConfig.maxResponseBytes)
        this.dataPath = path.join(ctx.baseDir, 'data', 'agent-nexus')
        this.inputAttachmentReader = new InputAttachmentReader(ctx.baseDir, pluginConfig.inputAttachments)
        this.artifactCache = new ArtifactCache({
            root: path.join(this.dataPath, 'artifacts'),
            enabled: pluginConfig.artifactCache?.enabled !== false,
            ttlMs: Math.max(1, pluginConfig.artifactCache?.ttlHours || 72) * 3600_000,
            maxTotalBytes:
                pluginConfig.artifactCache?.maxTotalBytes || 2 * 1024 * 1024 * 1024
        })
        // Shown in the Console as a path relative to the Koishi base directory:
        // portable across Windows/Linux/container and no absolute host path.
        this.artifactCacheRelative =
            path.relative(ctx.baseDir, this.artifactCache.root).split(path.sep).join('/') ||
            'data/agent-nexus/artifacts'
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
                    this.prepareDelegationArtifacts(artifacts, job),
                notifyArtifacts: (job, artifacts) =>
                    job.routing
                        ? sendDelegationArtifacts(
                              (this.ctx as any).bots || {},
                              job.routing,
                              artifacts
                          )
                        : Promise.resolve()
            }
        )
        ctx.on('chatluna/chat-stopped', async ({ conversationId }) => {
            await this.delegations.cancelConversation(conversationId)
        })
        ctx.on(
            'chatluna/before-conversation-clear-history',
            async ({ conversation }) => {
                await this.delegations.releaseConversation(conversation.id)
            }
        )
        ctx.on(
            'chatluna/before-conversation-delete',
            async ({ conversation }) => {
                await this.delegations.releaseConversation(conversation.id)
            }
        )
    }

    async start() {
        await this.loadConfig()
        await this.inputAttachmentReader.init()
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
        await this.startArtifactCache()
    }

    async stop() {
        this.running = false
        await this.delegations.stop()
        for (const dispose of this.toolDispose) dispose()
        this.toolDispose = []
        if (this.remoteRefreshTimer) clearInterval(this.remoteRefreshTimer)
        this.remoteRefreshTimer = undefined
        if (this.artifactPruneTimer) clearInterval(this.artifactPruneTimer)
        this.artifactPruneTimer = undefined
    }

    private async startArtifactCache() {
        if (!this.artifactCache.enabled) return
        try {
            await this.artifactCache.init()
            await this.pruneArtifactCache('startup')
        } catch (error) {
            this.ctx.logger.warn(
                `[agent-nexus] artifact cache unavailable at ${this.artifactCache.root}: ${getErrorMessage(error)}`
            )
        }
        this.artifactPruneTimer = setInterval(() => {
            void this.pruneArtifactCache('scheduled')
        }, 3600_000)
        this.artifactPruneTimer.unref?.()
    }

    private async pruneArtifactCache(reason: string) {
        if (!this.artifactCache.enabled) return
        try {
            const stats = await this.artifactCache.prune()
            if (stats.removed) {
                this.ctx.logger.info(
                    `[agent-nexus] artifact cache pruned (${reason}): removed ${stats.removed} file(s), freed ${stats.freedBytes} bytes, ${stats.remainingEntries} kept (${stats.remainingBytes} bytes)`
                )
            }
        } catch (error) {
            this.ctx.logger.warn(
                `[agent-nexus] artifact cache prune failed: ${getErrorMessage(error)}`
            )
        }
    }

    /** Drops every cached artifact. Exposed for the Console maintenance action. */
    async clearArtifactCache() {
        return this.artifactCache.clear()
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

    listDelegationJobs(limit?: number) {
        return this.delegations.listJobsForConsole(limit)
    }

    async cancelDelegationJob(id: string) {
        return this.delegations.cancelJobFromConsole(id)
    }

    async clearTerminalDelegationJobs() {
        return this.delegations.clearTerminalJobs()
    }

    /**
     * Mints a short-lived ticket for one artifact. The console hands the returned
     * URL to the browser, which fetches it from this plugin instead of the
     * Gateway, so the API key never leaves the server.
     */
    async createArtifactTicket(jobId: string, artifactId: string) {
        const { artifact, gatewayRunId } =
            await this.delegations.artifactDownloadTargetForConsole(
                jobId,
                artifactId
            )
        if (!artifact.bytesBase64 && !gatewayRunId) {
            throw new Error('该产物没有可下载的内容。')
        }
        const expiresAt = Date.now() + ARTIFACT_TICKET_TTL_MS
        return {
            url: `/agent-nexus/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(artifactId)}?ticket=${this.signArtifactTicket(jobId, artifactId, expiresAt)}`,
            name: artifact.filename || artifact.name || 'artifact',
            mediaType: artifact.mediaType,
            expiresAt
        }
    }

    /**
     * Resolves one artifact for a ticket that {@link createArtifactTicket}
     * issued. The local cache is consulted first, so a repeat preview or a
     * Range request never goes back to the Gateway.
     */
    async readDelegationArtifact(
        jobId: string,
        artifactId: string,
        ticket: string
    ): Promise<DelegationArtifactContent> {
        if (!this.verifyArtifactTicket(jobId, artifactId, ticket)) {
            throw new Error('下载链接已失效，请重新发起下载。')
        }
        const cached = await this.artifactCache
            .lookup(jobId, artifactId)
            .catch(() => undefined)
        if (cached) {
            return {
                kind: 'file',
                path: cached.path,
                size: cached.size,
                name: cached.name,
                mediaType: cached.mediaType
            }
        }
        const { artifact, gatewayRunId } =
            await this.delegations.artifactDownloadTargetForConsole(
                jobId,
                artifactId
            )
        const name = artifact.filename || artifact.name || 'artifact'

        // Bytes that already ship inline with the session view.
        if (artifact.bytesBase64) {
            const bytes = new Uint8Array(
                Buffer.from(artifact.bytesBase64, 'base64')
            )
            const stored = await this.artifactCache
                .store(jobId, artifactId, bytes, {
                    name,
                    mediaType: artifact.mediaType
                })
                .catch(() => undefined)
            return stored
                ? cachedFileContent(stored)
                : { kind: 'bytes', bytes, name, mediaType: artifact.mediaType }
        }

        // Stream straight into the cache. Nothing is buffered, so the ceiling
        // here is the disk budget rather than maxResponseBytes — this is what
        // keeps artifacts larger than a single response downloadable.
        if (this.artifactCache.enabled && gatewayRunId) {
            const stream = await this.gatewayClient.streamArtifact(
                this.gatewayRemote,
                gatewayRunId,
                artifactId
            )
            const stored = await this.artifactCache.storeStream(
                jobId,
                artifactId,
                Readable.fromWeb(stream.body as never),
                {
                    name: stream.filename || name,
                    mediaType: artifact.mediaType || stream.mediaType
                },
                this.artifactCache.maxTotalBytes
            )
            void this.pruneArtifactCache('stream')
            return cachedFileContent(stored)
        }

        const download = await this.gatewayClient.downloadArtifact(
            this.gatewayRemote,
            gatewayRunId!,
            artifactId
        )
        return {
            kind: 'bytes',
            bytes: download.bytes,
            name,
            mediaType: artifact.mediaType
        }
    }

    private signArtifactTicket(jobId: string, artifactId: string, expiresAt: number) {
        const signature = createHmac('sha256', this.artifactTicketSecret)
            .update(`${jobId}\n${artifactId}\n${expiresAt}`)
            .digest('base64url')
        return `${expiresAt}.${signature}`
    }

    private verifyArtifactTicket(
        jobId: string,
        artifactId: string,
        ticket: string
    ) {
        const [expires, signature] = String(ticket || '').split('.')
        const expiresAt = Number(expires)
        if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false
        if (!signature) return false
        // Compare the whole ticket, not just the signature segment: signArtifactTicket
        // returns `${expiresAt}.${signature}`, so comparing against `signature` alone
        // never matches and every download would be rejected.
        const left = Buffer.from(String(ticket || ''))
        const right = Buffer.from(this.signArtifactTicket(jobId, artifactId, expiresAt))
        return left.length === right.length && timingSafeEqual(left, right)
    }

    async collectInputAttachments(parentConfig: any) {
        const session = parentConfig?.configurable?.session
        const elements = [
            ...(Array.isArray(session?.elements) ? session.elements : []),
            ...(Array.isArray(session?.event?.message?.elements)
                ? session.event.message.elements
                : [])
        ]
        const seen = new Set<string>()
        const sources = elements
            .map(inputElement)
            .filter((item): item is InputAttachmentSource => Boolean(item))
            .filter((item) => {
                if (seen.has(item.source)) return false
                seen.add(item.source)
                return true
            })
        if (!sources.length) return []
        const attachments: InputAttachment[] = []
        let total = 0
        for (const source of sources) {
            const attachment = await loadInputAttachment(source, this.inputAttachmentReader)
            total += attachment.bytes.length
            if (total > MAX_DELEGATION_INPUT_BYTES) {
                throw new Error('本次任务的图片/文件总大小超过 32 MB。')
            }
            attachments.push(attachment)
        }
        return attachments
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
            settings: {
                commandAuthority: this.pluginConfig.commandAuthority,
                maxResponseBytes: this.pluginConfig.maxResponseBytes,
                gatewayKeyLength: this.gatewayRemote.authToken?.length || 0,
                artifactCache: {
                    enabled: this.artifactCache.enabled,
                    directory: this.artifactCacheRelative,
                    ttlHours: Math.round(
                        (this.pluginConfig.artifactCache?.ttlHours || 72) * 10
                    ) / 10,
                    maxTotalBytes:
                        this.pluginConfig.artifactCache?.maxTotalBytes ||
                        2 * 1024 * 1024 * 1024
                }
            },
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
                // Cache under the Gateway artifact id, which is the only key
                // the Console can request later. Artifacts that lack one are
                // still delivered to ChatLuna but stay out of the cache.
                if (artifact.artifactId) {
                    await this.artifactCache
                        .store(job.id, artifact.artifactId, bytes, {
                            name: artifact.filename || artifact.name || filename,
                            mediaType: artifact.mediaType
                        })
                        .catch(() => undefined)
                }
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

/** How long a console artifact download link stays valid. */
const ARTIFACT_TICKET_TTL_MS = 5 * 60 * 1000
const MAX_DELEGATION_ARTIFACT_BYTES = 32 * 1024 * 1024
const MAX_DELEGATION_INPUT_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_DELEGATION_INPUT_BYTES = 32 * 1024 * 1024

interface InputAttachmentSource {
    source: string
    name: string
    mediaType?: string
}

interface InputAttachment {
    name: string
    mediaType?: string
    bytes: Uint8Array
}

function cachedFileContent(cached: CachedArtifact): DelegationArtifactContent {
    return {
        kind: 'file',
        path: cached.path,
        size: cached.size,
        name: cached.name,
        mediaType: cached.mediaType
    }
}

/**
 * Resolved artifact payload. `file` points at the local cache and is streamed
 * by the route; `bytes` is the in-memory fallback used when caching is off.
 */
export type DelegationArtifactContent =
    | {
          kind: 'file'
          path: string
          size: number
          name: string
          mediaType?: string
      }
    | {
          kind: 'bytes'
          bytes: Uint8Array
          name: string
          mediaType?: string
      }

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

function inputElement(value: any): InputAttachmentSource | undefined {
    if (!value || typeof value !== 'object') return undefined
    const type = String(value.type || '').toLowerCase()
    if (!['img', 'image', 'file', 'attachment', 'audio', 'video'].includes(type)) {
        return undefined
    }
    const attrs = value.attrs && typeof value.attrs === 'object' ? value.attrs : value
    const source = String(attrs.src || attrs.url || attrs.href || '').trim()
    if (!source) return undefined
    const name = safeInputFilename(
        String(attrs.filename || attrs.name || attrs.alt || '').trim()
    ) || filenameFromSource(source) || 'attachment'
    return {
        source,
        name,
        mediaType: normalizeMediaType(
            String(attrs.mediaType || attrs.mimeType || attrs.mime || '').trim()
        ) || mediaTypeFromSource(source, type)
    }
}

async function loadInputAttachment(source: InputAttachmentSource, reader: InputAttachmentReader): Promise<InputAttachment> {
    const parsed = parseDataUri(source.source)
    if (parsed) {
        assertInputAttachmentSize(parsed.bytes.length)
        return {
            name: source.name,
            mediaType: concreteMediaType(source.mediaType) || parsed.mediaType || 'application/octet-stream',
            bytes: parsed.bytes
        }
    }
    const { bytes, mediaType } = await reader.read(source.source, MAX_DELEGATION_INPUT_ATTACHMENT_BYTES)
    assertInputAttachmentSize(bytes.length)
    return {
        name: source.name,
        mediaType: concreteMediaType(source.mediaType) || normalizeMediaType(mediaType || '') || 'application/octet-stream',
        bytes
    }
}

function parseDataUri(value: string) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(value)
    if (!match) return undefined
    const mediaType = normalizeMediaType(match[1] || '')
    if (match[2]) {
        const encoded = match[3].replace(/\s/g, '')
        if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            throw new Error('用户附件的 Base64 数据无效。')
        }
        return { mediaType, bytes: Buffer.from(encoded, 'base64') }
    }
    return { mediaType, bytes: Buffer.from(decodeURIComponent(match[3]), 'utf8') }
}

function assertInputAttachmentSize(size: number) {
    if (size > MAX_DELEGATION_INPUT_ATTACHMENT_BYTES) {
        throw new Error('单个用户附件超过 16 MB。')
    }
}

function normalizeMediaType(value: string) {
    const result = value.split(';', 1)[0].trim().toLowerCase()
    return result || undefined
}

function concreteMediaType(value?: string) {
    return value && !value.includes('*') ? value : undefined
}

function mediaTypeFromSource(source: string, type: string) {
    if (type === 'img' || type === 'image') return 'image/*'
    if (type === 'audio') return 'audio/*'
    if (type === 'video') return 'video/*'
    const extension = path.extname(source.split(/[?#]/, 1)[0]).toLowerCase()
    const types: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
        '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip'
    }
    return types[extension]
}

function filenameFromSource(source: string) {
    try {
        const value = new URL(source)
        return safeInputFilename(path.basename(value.pathname))
    } catch {
        return safeInputFilename(path.basename(source.split(/[?#]/, 1)[0]))
    }
}

function safeInputFilename(value: string) {
    return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 180)
}

declare module 'koishi' {
    interface Context {
        agent_nexus: AgentNexusService
    }
}
