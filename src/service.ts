import { Context, h, Service } from 'koishi'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFile as readBinaryFile } from 'fs/promises'
import type {
    DelegationAgentConfig,
    GatewayRemoteConfig,
    NexusConfig,
    NexusConsoleData,
    NexusStatus,
    NexusTaskArtifact,
    NexusTaskDetail,
    NexusTaskSummary
} from './types'
import {
    createGatewayConnection,
    createDefaultNexusConfig,
    normalizeStoredNexusConfig,
    type Config
} from './config'
import { registerAgentDelegationTools } from './tools/delegate'
import { registerGatewayFilePublishTool } from './tools/publish'
import { getErrorMessage } from './utils/shell'
import { moveCorruptFileAside, writeTextFileAtomic } from './utils/atomic-file'
import { redactNexusConfig } from './utils/config'
import {
    DelegationManager,
    DelegationProviderRegistry,
    DelegationStore,
    formatDelegationUserReply,
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
import type { GatewayPublishedFile } from './gateway/types'
import {
    delegationContextFromSession,
    sameDelegationRouting
} from './tools/context'

export class AgentNexusService extends Service {
    static readonly inject = ['chatluna']

    private readonly gatewayRemote: GatewayRemoteConfig
    private readonly gatewayClient: NexusGatewayClient
    private readonly gatewayProvider: NexusGatewayProvider
    private readonly delegationStore: DelegationStore
    private readonly delegations: DelegationManager
    private readonly delegationProviders: DelegationProviderRegistry
    private toolDispose: (() => void)[] = []
    private pendingMessageDispose?: () => boolean
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
                    this.sanitizeDelegationArtifacts(artifacts, job)
            }
        )
    }

    async start() {
        await this.loadConfig()
        this.running = true
        this.syncTools()
        await this.delegations.start()
        this.installPendingMessageMiddleware()
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
        this.pendingMessageDispose?.()
        this.pendingMessageDispose = undefined
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

    private installPendingMessageMiddleware() {
        this.pendingMessageDispose?.()
        if (this.pluginConfig.autoResumePending === false) return
        this.pendingMessageDispose = this.ctx.middleware(async (session, next) => {
            if (!this.running || !session.userId || session.userId === session.selfId) {
                return next()
            }
            try {
                const handled = await this.resumePendingMessage(session)
                if (handled) return
            } catch (error) {
                this.ctx.logger.warn(
                    `[agent-nexus] pending message continuation failed: ${getErrorMessage(error)}`
                )
                await session.send(`继续 Agent 任务失败：${getErrorMessage(error)}`)
                return
            }
            return next()
        }, true)
    }

    private async resumePendingMessage(session: any) {
        const isDirect = Boolean(session.isDirect ?? !session.guildId)
        const stripped = session.stripped
        if (
            !isDirect &&
            this.pluginConfig.pendingRequireMention === true &&
            !stripped?.atSelf
        ) {
            return false
        }
        // Never consume a message addressed to another user in a group.
        if (!isDirect && stripped?.hasAt && !stripped.atSelf) return false

        const chatluna = (this.ctx as any).chatluna
        const conversationService = chatluna?.conversation
        if (typeof conversationService?.resolveConversation !== 'function') {
            return false
        }
        let resolution: any
        try {
            resolution = await conversationService.resolveConversation(session, {
                mode: 'active'
            })
        } catch {
            return false
        }
        const context = delegationContextFromSession(
            session,
            String(resolution?.conversationId || '')
        )
        if (!context) return false

        const attachments = await this.collectInputAttachments({
            configurable: { session }
        })
        const prompt = String(
            stripped?.atSelf ? stripped.content : session.content || ''
        ).trim() || (attachments.length ? '请处理我发送的附件。' : '')
        if (!prompt) return false

        const continuation = await this.delegations.continuePendingFromMessage(
            context,
            prompt,
            attachments
        )
        if (!continuation.handled) {
            if (continuation.ambiguous) {
                await session.send(
                    '当前对话有多个等待中的 Agent 任务，请 @Bot 并说明要继续哪个任务，或先结束其他任务。'
                )
                return true
            }
            return false
        }
        if (continuation.job) await this.sendDelegationReply(session, continuation.job)
        return true
    }

    private async sendDelegationReply(session: any, job: DelegationJob) {
        const text = formatDelegationUserReply(job)
        if (text) await session.send(text)
        for (const artifact of job.artifacts) {
            if (!artifact.url) continue
            await session.send(
                h.file(artifact.url, {
                    filename: artifact.filename || artifact.name || undefined,
                    mime: artifact.mediaType || undefined
                })
            )
        }
    }

    async publishDelegationFiles(
        input: { id?: string; paths: string[] },
        context?: DelegationContext
    ): Promise<GatewayPublishedFile[]> {
        const paths = Array.from(
            new Set(
                (Array.isArray(input.paths) ? input.paths : [])
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
            )
        )
        if (!paths.length) throw new Error('至少需要一个要发布的文件路径。')
        if (paths.length > 32) throw new Error('一次最多发布 32 个文件。')

        const requestedId = String(input.id || '').trim()
        let job = requestedId ? await this.delegationStore.get(requestedId) : undefined
        if (!job && !requestedId && context?.parentConversationId) {
            const candidates = (await this.delegationStore.list(
                context.parentConversationId
            )).filter(
                (candidate) =>
                    typeof candidate.providerState.gatewaySessionId === 'string' &&
                    (!candidate.routing ||
                        sameDelegationRouting(candidate.routing, context.routing))
            )
            const exact = candidates.filter(
                (candidate) => candidate.routing !== undefined
            )
            if (exact.length > 1 || (!exact.length && candidates.length > 1)) {
                throw new Error(
                    '当前路由存在多个 AgentNexus 任务，请传入明确的任务 ID。'
                )
            }
            job = (exact[0] || candidates[0])
        }
        if (!job) {
            throw new Error(
                requestedId
                    ? `未找到 AgentNexus 任务：${requestedId}`
                    : '当前对话没有可用于发布文件的 AgentNexus 任务，请传入任务 ID。'
            )
        }
        if (
            context?.parentConversationId &&
            job.parentConversationId &&
            job.parentConversationId !== context.parentConversationId
        ) {
            throw new Error(`未找到 AgentNexus 任务：${job.id}`)
        }
        if (
            context?.routing &&
            job.routing &&
            !sameDelegationRouting(job.routing, context.routing)
        ) {
            throw new Error(`未找到 AgentNexus 任务：${job.id}`)
        }
        const sessionId = String(job.providerState.gatewaySessionId || '').trim()
        if (!sessionId) throw new Error('该任务没有可用的 Nexus Gateway Session。')

        const result = await this.gatewayClient.publishFiles(
            this.gatewayRemote,
            sessionId,
            paths
        )
        const additions: DelegationArtifact[] = result.files.map((file) => ({
            artifactId: file.id,
            name: file.name,
            filename: file.name,
            url: file.url,
            mediaType: file.mediaType,
            metadata: {
                size: file.size,
                sha256: file.sha256,
                expiresAt: file.expiresAt
            }
        }))
        const knownUrls = new Set(job.artifacts.map((artifact) => artifact.url).filter(Boolean))
        job.artifacts.push(...additions.filter((artifact) => !knownUrls.has(artifact.url)))
        job.updatedAt = Date.now()
        await this.delegationStore.save(job)

        return result.files
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
            const attachment = await loadInputAttachment(source)
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
            gatewayKeyConfigured: this.gatewayRemote.enabled
        }
    }

    async getDelegationJobs(): Promise<NexusTaskSummary[]> {
        const jobs = await this.delegationStore.list()
        return jobs.map(toTaskSummary)
    }

    async getDelegationJob(id: string): Promise<NexusTaskDetail | undefined> {
        const normalizedId = String(id || '').trim()
        if (!normalizedId) return undefined
        const job = await this.delegationStore.get(normalizedId)
        return job ? toTaskDetail(job) : undefined
    }

    private async notifyDelegation(job: DelegationJob) {
        await notifyChatLunaDelegation(
            (this.ctx as any).chatluna,
            job,
            this.delegationToolName(job)
        )
    }

    private async sanitizeDelegationArtifacts(
        artifacts: DelegationArtifact[],
        _job: DelegationJob
    ) {
        return artifacts.map((artifact) =>
            artifact.bytesBase64
                ? {
                      ...artifact,
                      bytesBase64: undefined,
                      text: [
                          artifact.text,
                          '[binary artifact omitted: Nexus Gateway must publish binary artifacts as URLs]'
                      ]
                          .filter(Boolean)
                          .join('\n')
                  }
                : artifact
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
        const disposePublish = registerGatewayFilePublishTool(platform, this)
        if (disposePublish) this.toolDispose.push(disposePublish)
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

function toTaskSummary(job: DelegationJob): NexusTaskSummary {
    return {
        id: job.id,
        agentId: job.agentId,
        agentName: job.agentName,
        toolName: job.toolName,
        state: job.state,
        background: job.background,
        promptPreview: clipTaskText(job.prompt, 180) || '(无提示词)',
        outputPreview: clipTaskText(job.output, 240),
        remoteState: job.remoteState,
        artifactCount: job.artifacts.length,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        expiresAt: job.expiresAt
    }
}

function toTaskDetail(job: DelegationJob): NexusTaskDetail {
    return {
        ...toTaskSummary(job),
        prompt: job.prompt,
        output: job.output,
        error: job.error,
        pollError: job.pollError,
        pendingRequest: job.pendingRequest,
        artifacts: job.artifacts.map(toTaskArtifact)
    }
}

function toTaskArtifact(artifact: DelegationArtifact): NexusTaskArtifact {
    const metadata = artifact.metadata || {}
    return {
        artifactId: artifact.artifactId,
        name: artifact.name || artifact.filename || '未命名产物',
        filename: artifact.filename,
        url: artifact.url,
        mediaType: artifact.mediaType,
        size: typeof metadata.size === 'number' ? metadata.size : undefined,
        sha256: typeof metadata.sha256 === 'string' ? metadata.sha256 : undefined,
        expiresAt:
            typeof metadata.expiresAt === 'number'
                ? metadata.expiresAt
                : undefined,
        preview: artifactPreview(artifact)
    }
}

function artifactPreview(artifact: DelegationArtifact) {
    if (artifact.text) return clipTaskText(artifact.text, 1000)
    if (artifact.data !== undefined) {
        try {
            return clipTaskText(JSON.stringify(artifact.data), 1000)
        } catch {}
    }
    if (artifact.bytesBase64) {
        return '[二进制产物，内容未在记录中展开]'
    }
    return undefined
}

function clipTaskText(value: string | undefined, maxChars: number) {
    if (!value) return undefined
    const text = value.trim()
    if (!text) return undefined
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
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

async function loadInputAttachment(source: InputAttachmentSource): Promise<InputAttachment> {
    const parsed = parseDataUri(source.source)
    if (parsed) {
        assertInputAttachmentSize(parsed.bytes.length)
        return {
            name: source.name,
            mediaType: concreteMediaType(source.mediaType) || parsed.mediaType || 'application/octet-stream',
            bytes: parsed.bytes
        }
    }
    let bytes: Uint8Array
    if (source.source.startsWith('file://')) {
        bytes = await readBinaryFile(fileURLToPath(source.source))
    } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(source.source)) {
        const response = await fetch(source.source, {
            signal: AbortSignal.timeout(30_000)
        })
        if (!response.ok || !response.body) {
            throw new Error(`无法读取用户附件（HTTP ${response.status}）。`)
        }
        bytes = await readLimitedResponse(response, MAX_DELEGATION_INPUT_ATTACHMENT_BYTES)
        source.mediaType = concreteMediaType(source.mediaType)
            || normalizeMediaType(response.headers.get('content-type') || '')
    } else {
        throw new Error(`无法读取用户附件地址：${source.source}`)
    }
    assertInputAttachmentSize(bytes.length)
    return {
        name: source.name,
        mediaType: source.mediaType || 'application/octet-stream',
        bytes
    }
}

async function readLimitedResponse(response: Response, maxBytes: number) {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error('用户附件超过 16 MB。')
    }
    const reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) throw new Error('用户附件超过 16 MB。')
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
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
