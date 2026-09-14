import type {
    DelegationAgentConfig,
    GatewayAgentSummary,
    GatewayRemoteConfig,
    GatewayRemoteStatus,
    NexusConfig
} from '../types'
import type { GatewayClient } from '../gateway/client'
import { GatewayPayloadTooLargeError } from '../gateway/client'
import type { GatewaySessionView } from '../gateway/types'
import type {
    DelegationJob,
    DelegationProvider,
    DelegationProviderResult,
    DelegationRunRequest,
    RemoteAgentInfo
} from '../delegation/types'

export interface NexusGatewayProviderOptions {
    getConfig(): NexusConfig
    remote: GatewayRemoteConfig
    client: GatewayClient
}

interface HydratedGatewaySession {
    session: GatewaySessionView
    artifactRetryAfterMs?: number
}

/**
 * Total download attempts allowed for one artifact, counting the first try.
 * Without a ceiling the job stays `running` until the 24h active TTL expires,
 * which also blocks a foreground tool call for the whole window.
 */
const MAX_ARTIFACT_DOWNLOAD_ATTEMPTS = 3

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

interface ArtifactHydrationPolicy {
    /** When false a failed download degrades the artifact instead of retrying. */
    allowRetry: boolean
    /** Response ceiling; artifacts already known to exceed it are never fetched. */
    maxBytes: number
}

function artifactDownloadAttempts(providerState: Record<string, unknown> | undefined) {
    const value = Number(providerState?.gatewayArtifactDownloadAttempts)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * A failure is worth retrying only when it can plausibly clear on its own.
 * "Too large" and other 4xx rejections describe the artifact itself, so
 * retrying them just delays the turn's terminal state.
 */
function isRetryableArtifactError(error: unknown) {
    if (error instanceof GatewayPayloadTooLargeError) return false
    const status = statusOf(error)
    if (status === undefined) return true
    if (status === 429) return true
    return status >= 500
}

function artifactFailureReason(error: unknown) {
    if (error instanceof GatewayPayloadTooLargeError) {
        // Same situation as the size pre-check: the bytes are too large to
        // ride along with the chat message, but the Console streams them
        // from the Gateway, so point the user there.
        const limit = error.limitBytes ? ` ${error.limitBytes} 字节` : ''
        return `产物超过随消息回传的上限${limit}；可在控制台产物页下载`
    }
    const status = statusOf(error)
    return status ? `Gateway 返回 ${status}` : errorMessage(error)
}

/**
 * Keeps the artifact's metadata but marks why its bytes are unavailable, so
 * the Console can explain the entry instead of showing a bare "仅记录".
 */
function degradeArtifact(
    artifact: GatewaySessionView['artifacts'][number],
    unsafeUrl: boolean,
    reason: string
) {
    return {
        ...artifact,
        ...(unsafeUrl ? { url: undefined } : {}),
        metadata: { ...artifact.metadata, downloadError: reason }
    }
}

export class NexusGatewayProvider implements DelegationProvider {
    readonly type = 'gateway' as const
    private inventoryStatus?: GatewayRemoteStatus
    private discoveryVersion = 0
    private discovery?: {
        version: number
        promise: Promise<GatewayRemoteStatus>
    }

    constructor(private readonly options: NexusGatewayProviderOptions) {}

    getStatus(): GatewayRemoteStatus {
        const remote = this.options.remote
        return (
            this.inventoryStatus || {
                id: remote.id,
                name: remote.name,
                baseUrl: remote.baseUrl,
                enabled: remote.enabled,
                state: 'unknown',
                agents: []
            }
        )
    }

    clearStatus() {
        this.discoveryVersion += 1
        this.discovery = undefined
        this.inventoryStatus = undefined
    }

    async discoverRemote() {
        const version = this.discoveryVersion
        if (this.discovery?.version === version) return this.discovery.promise
        const promise = this.performDiscovery(version)
        this.discovery = { version, promise }
        try {
            return await promise
        } finally {
            if (this.discovery?.promise === promise) this.discovery = undefined
        }
    }

    private async performDiscovery(version: number) {
        const remote = this.options.remote
        const checking: GatewayRemoteStatus = {
            id: remote.id,
            name: remote.name,
            baseUrl: remote.baseUrl,
            enabled: remote.enabled,
            state: 'checking',
            agents: this.inventoryStatus?.agents || []
        }
        this.commitStatus(version, checking)
        if (!remote.enabled) {
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'unknown',
                error: '尚未在 Koishi 插件设置中配置 Gateway API Key。'
            }
            this.commitStatus(version, status)
            return status
        }
        try {
            const result = await this.options.client.listAgents(remote)
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'ready',
                agents: (result.agents || []).map(mapGatewayAgent),
                lastCheckedAt: Date.now()
            }
            this.commitStatus(version, status)
            return status
        } catch (error) {
            const status: GatewayRemoteStatus = {
                ...checking,
                state: 'error',
                lastCheckedAt: Date.now(),
                error: errorMessage(error)
            }
            this.commitStatus(version, status)
            return status
        }
    }

    listAgents(): RemoteAgentInfo[] {
        const overrides = new Map(
            this.options
                .getConfig()
                .delegation.agents.map((agent) => [agent.agentId, agent])
        )
        const discovered = new Map(
            this.getStatus().agents.map((agent) => [agent.id, agent])
        )
        const ids = new Set([...discovered.keys(), ...overrides.keys()])
        return Array.from(ids)
            .sort((left, right) => left.localeCompare(right))
            .map((id) => this.agentInfo(id, overrides.get(id), discovered.get(id)))
    }

    async discover() {
        await this.discoverRemote()
    }

    async run(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        const remote = this.requireRemote()
        let sessionId = stateString(job, 'gatewaySessionId')
        let session: GatewaySessionView
        if (!sessionId || request.newTask) {
            if (
                sessionId &&
                request.newTask &&
                typeof this.options.client.closeSession === 'function'
            ) {
                try {
                    await this.options.client.closeSession(remote, sessionId)
                } catch (error) {
                    if (statusOf(error) !== 404) throw error
                }
                sessionId = undefined
            }
            if (!agent.agentId) {
                throw new Error(`Gateway agent id is missing for ${agent.name}`)
            }
            session = await this.options.client.createSession(remote, {
                agentId: agent.agentId,
                ...(agent.workspace ? { workspace: agent.workspace } : {})
            })
            sessionId = session.id
        }
        const attachmentIds = request.attachments?.length
            ? await Promise.all(
                  request.attachments.map(async (attachment) =>
                      (
                          await this.options.client.uploadAttachment(
                              remote,
                              sessionId!,
                              attachment
                          )
                      ).id
                  )
              )
            : []
        session = await this.options.client.sendMessage(
            remote,
            sessionId,
            request.prompt,
            attachmentIds
        )
        return this.sessionResult(remote, session, job)
    }

    async message(
        agent: RemoteAgentInfo,
        job: DelegationJob,
        request: DelegationRunRequest
    ) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (request.requestId) {
            if (!sessionId) {
                throw new Error('Nexus Gateway did not return a session id.')
            }
            const session = await this.options.client.resolvePending(
                this.requireRemote(),
                sessionId,
                request.requestId,
                {
                    ...(request.prompt ? { message: request.prompt } : {}),
                    ...(request.optionId ? { optionId: request.optionId } : {}),
                    ...(request.decision ? { action: request.decision } : {})
                }
            )
            return this.sessionResult(this.requireRemote(), session, job)
        }
        return this.run(agent, job, { ...request, sameTask: true })
    }

    async *watch(
        _agent: RemoteAgentInfo,
        job: DelegationJob,
        signal: AbortSignal
    ) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        let after = stateString(job, 'lastEventId')
        for await (const event of this.options.client.events(
            this.requireRemote(),
            sessionId,
            after,
            signal
        )) {
            // A reset event means the event ring no longer covers `after`.
            // Recover from the fixed same-origin Session route rather than
            // following the server-advertised URL (which must never carry an
            // API key into a chat platform).
            if (event.type !== 'reset' && event.id && cursorAtOrBefore(event.id, after)) {
                continue
            }
            let session: GatewaySessionView
            if (event.type === 'reset' && isGatewaySessionView(event.data)) {
                session = event.data
            } else {
                session = await this.options.client.getSession(
                    this.requireRemote(),
                    sessionId
                )
            }
            const snapshotCursor = session.lastEventId || event.id || after
            if (event.type === 'reset') {
                // A reset is authoritative even when the requested cursor was
                // ahead of the current Gateway sequence. The replacement
                // snapshot may therefore move the cursor backwards.
                after = snapshotCursor
                session = after && session.lastEventId !== after
                    ? { ...session, lastEventId: after }
                    : session
            } else {
                if (snapshotCursor && cursorAtOrBefore(snapshotCursor, after)) {
                    continue
                }
                after = maxCursor(after, snapshotCursor)
                session = after && session.lastEventId !== after
                    ? { ...session, lastEventId: after }
                    : session
            }
            const result = await this.sessionResult(
                this.requireRemote(),
                session,
                job
            )
            yield result
            if (result.state !== 'running') return
        }
    }

    async close(_agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) return
        await this.options.client.closeSession(this.requireRemote(), sessionId)
    }

    async publish(_agent: RemoteAgentInfo, job: DelegationJob, path: string) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        const session = await this.options.client.publishArtifact(
            this.requireRemote(),
            sessionId,
            path
        )
        return this.sessionResult(this.requireRemote(), session, job)
    }

    async status(_agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) throw new Error('Nexus Gateway did not return a session id.')
        const session = await this.options.client.getSession(
            this.requireRemote(),
            sessionId
        )
        return this.sessionResult(this.requireRemote(), session, job)
    }

    async cancel(_agent: RemoteAgentInfo, job: DelegationJob) {
        const sessionId = stateString(job, 'gatewaySessionId')
        if (!sessionId) {
            return {
                state: 'canceled',
                remoteState: 'canceled',
                artifacts: [],
                providerState: structuredClone(job.providerState)
            } satisfies DelegationProviderResult
        }
        const remote = this.requireRemote()
        const session = await this.options.client.cancelSession(
            remote,
            sessionId
        )
        // Gateway cancellation leaves the terminal Session retained until it
        // is explicitly closed. Release that server-side resource after the
        // cancel has been accepted. Older clients may not expose closeSession;
        // keep the cancellation path compatible with them.
        if (typeof this.options.client.closeSession === 'function') {
            await this.options.client.closeSession(remote, sessionId)
        }
        return this.sessionResult(remote, session, job)
    }

    private async sessionResult(
        remote: GatewayRemoteConfig,
        session: GatewaySessionView,
        job: DelegationJob
    ) {
        const attempts = artifactDownloadAttempts(job.providerState)
        const hydrated = await this.hydrateArtifacts(
            remote,
            session,
            job.artifacts,
            {
                // `attempts` counts completed retries, so the first try is
                // still allowed when attempts === MAX - 1.
                allowRetry: attempts + 1 < MAX_ARTIFACT_DOWNLOAD_ATTEMPTS,
                maxBytes:
                    this.options.client.maxResponseBytes ||
                    DEFAULT_MAX_RESPONSE_BYTES
            }
        )
        const previousState = structuredClone(job.providerState)
        delete previousState.gatewayArtifactDownloadPending
        delete previousState.gatewayArtifactRetryAfterMs
        delete previousState.gatewayArtifactDownloadAttempts
        const result = fromGatewaySession(hydrated.session, previousState)
        if (
            hydrated.artifactRetryAfterMs !== undefined &&
            (result.state === 'running' || result.state === 'completed')
        ) {
            // The turn has already been accepted. Keep it logically active
            // while a read-only artifact download is retried; this prevents a
            // transient storage failure from replaying the user's prompt.
            // The attempt counter bounds that window so the job cannot stay
            // running until the active TTL expires.
            result.state = 'running'
            result.remoteState = hydrated.session.state
            result.error = undefined
            result.providerState = {
                ...result.providerState,
                gatewayArtifactDownloadPending: true,
                gatewayArtifactRetryAfterMs: hydrated.artifactRetryAfterMs,
                gatewayArtifactDownloadAttempts: attempts + 1
            }
        }
        return result
    }

    private async hydrateArtifacts(
        remote: GatewayRemoteConfig,
        session: GatewaySessionView,
        previous: DelegationJob['artifacts'],
        policy: ArtifactHydrationPolicy
    ): Promise<HydratedGatewaySession> {
        const client = this.options.client as GatewayClient & {
            downloadArtifact?: GatewayClient['downloadArtifact']
        }
        const downloadArtifact = client.downloadArtifact
        if (!session.runId || typeof downloadArtifact !== 'function') {
            return { session: stripUnsafeArtifactUrls(session, remote) }
        }
        if (!session.artifacts?.length) return { session }

        let artifactRetryPending = false
        let artifactRetryAfterMs = 0
        const artifacts = await Promise.all(
            session.artifacts.map(async (artifact) => {
                const unsafeUrl = artifact.url
                    ? isUnsafeArtifactUrl(artifact.url, remote)
                    : false
                const existing = artifact.id
                    ? previous.find((item) => item.artifactId === artifact.id)
                    : undefined
                if (hasInlineArtifact(artifact)) {
                    return unsafeUrl ? { ...artifact, url: undefined } : artifact
                }
                if (existing?.bytesBase64) {
                    return {
                        ...artifact,
                        url: undefined,
                        bytesBase64: existing.bytesBase64,
                        filename: artifact.filename || existing.filename,
                        mediaType: artifact.mediaType || existing.mediaType
                    }
                }
                if (existing?.url && !isUnsafeArtifactUrl(existing.url, remote)) {
                    return { ...artifact, url: existing.url }
                }
                if (artifact.url && !unsafeUrl) return artifact
                if (!artifact.id) {
                    return unsafeUrl ? { ...artifact, url: undefined } : artifact
                }
                if (terminalArtifactStorageStatus(artifact)) {
                    return unsafeUrl ? { ...artifact, url: undefined } : artifact
                }
                // The persisted run view reports the size up front, so an
                // artifact that cannot fit the response ceiling is never
                // downloaded at all.
                if (
                    typeof artifact.size === 'number' &&
                    artifact.size > policy.maxBytes
                ) {
                    // Only the chat delivery is capped here: these bytes have
                    // to be base64'd into the job record. The Console streams
                    // from the Gateway instead, so it can still fetch this.
                    return degradeArtifact(
                        artifact,
                        unsafeUrl,
                        `产物大小 ${artifact.size} 字节，超过随消息回传的上限 ${policy.maxBytes} 字节；可在控制台产物页下载`
                    )
                }
                try {
                    const downloaded = await downloadArtifact.call(
                        client,
                        remote,
                        session.runId!,
                        artifact.id
                    )
                    const bytes = Buffer.from(downloaded.bytes)
                    if (!bytes.length) {
                        return unsafeUrl ? { ...artifact, url: undefined } : artifact
                    }
                    return {
                        ...artifact,
                        url: undefined,
                        bytesBase64: bytes.toString('base64'),
                        filename: artifact.filename || downloaded.filename,
                        mediaType: artifact.mediaType || downloaded.mediaType
                    }
                } catch (error) {
                    // Metadata-only/expired artifacts are still useful to the
                    // user as a structured result. Keep them without exposing
                    // an authenticated Gateway URL. Other old Gateway URLs
                    // remain compatible when they are not credentials.
                    if (statusOf(error) === 404) {
                        return unsafeUrl ? { ...artifact, url: undefined } : artifact
                    }
                    if (statusOf(error) === 401 || statusOf(error) === 403) {
                        throw error
                    }
                    // Permanent failures degrade immediately; transient ones
                    // may hold the turn open, but only until the attempt
                    // ceiling is reached.
                    if (!isRetryableArtifactError(error) || !policy.allowRetry) {
                        const reason = artifactFailureReason(error)
                        return degradeArtifact(
                            artifact,
                            unsafeUrl,
                            isRetryableArtifactError(error)
                                ? `${reason}（已尝试 ${MAX_ARTIFACT_DOWNLOAD_ATTEMPTS} 次后放弃）`
                                : reason
                        )
                    }
                    artifactRetryPending = true
                    artifactRetryAfterMs = Math.max(
                        artifactRetryAfterMs,
                        retryAfterMsOf(error)
                    )
                    return unsafeUrl ? { ...artifact, url: undefined } : artifact
                }
            })
        )
        return {
            session: { ...session, artifacts },
            ...(artifactRetryPending
                ? { artifactRetryAfterMs }
                : {})
        }
    }

    private agentInfo(
        id: string,
        override?: DelegationAgentConfig,
        discovered?: GatewayAgentSummary
    ): RemoteAgentInfo {
        const remote = this.options.remote
        const status = this.getStatus()
        const missing =
            status.state === 'ready' && !discovered
                ? `Gateway 没有返回 Agent：${id}`
                : undefined
        const unavailable = discovered && !discovered.ready
        const configuredSkills = (override?.skills || []).map((skill) => ({
            id: skill,
            name: skill,
            description: '',
            tags: []
        }))
        return {
            id,
            name: override?.name || discovered?.name || id,
            provider: 'gateway',
            remoteId: remote.id,
            remoteName: remote.name,
            agentId: id,
            protocol: discovered?.protocol,
            workspace: override?.workspace || discovered?.workspace,
            aliases: [id, discovered?.name || ''].filter(Boolean),
            enabled:
                remote.enabled &&
                (override?.enabled ?? true) &&
                discovered?.enabled !== false &&
                discovered?.ready !== false &&
                !missing,
            state:
                missing || unavailable
                    ? 'error'
                    : discovered
                      ? status.state
                      : status.state === 'error'
                        ? 'error'
                        : 'unknown',
            description: override?.description || discovered?.description,
            skills: configuredSkills,
            error: missing || discovered?.error || status.error
        }
    }

    private requireRemote() {
        const remote = this.options.remote
        if (!remote.enabled) {
            throw new Error('Nexus Gateway API Key 尚未配置。')
        }
        return remote
    }

    private commitStatus(version: number, status: GatewayRemoteStatus) {
        if (this.discoveryVersion === version) this.inventoryStatus = status
    }
}

function mapGatewayAgent(agent: GatewayAgentSummary): GatewayAgentSummary {
    return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        protocol: agent.protocol,
        driver: agent.driver,
        ready: agent.ready,
        enabled: agent.enabled,
        workspace: agent.workspace,
        version: agent.version,
        error: agent.error,
        checkedAt: agent.checkedAt,
        responseMs: agent.responseMs
    }
}

function hasInlineArtifact(artifact: GatewaySessionView['artifacts'][number]) {
    return (
        typeof artifact.bytesBase64 === 'string' ||
        artifact.data !== undefined ||
        typeof artifact.text === 'string'
    )
}

function isUnsafeArtifactUrl(value: string, remote: GatewayRemoteConfig) {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }
    let base: URL
    try {
        base = new URL(remote.baseUrl)
    } catch {
        return true
    }
    if (url.origin === base.origin && url.pathname.startsWith('/v1/')) {
        return true
    }
    for (const key of url.searchParams.keys()) {
        if (/^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|key|sig(?:nature)?|token)$/i.test(key)) {
            return true
        }
    }
    return false
}

function stripUnsafeArtifactUrls(
    session: GatewaySessionView,
    remote: GatewayRemoteConfig
): GatewaySessionView {
    if (!session.artifacts?.length) return session
    const artifacts = session.artifacts.map((artifact) =>
        artifact.url && isUnsafeArtifactUrl(artifact.url, remote)
            ? { ...artifact, url: undefined }
            : artifact
    )
    return { ...session, artifacts }
}

function isGatewaySessionView(value: unknown): value is GatewaySessionView {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Partial<GatewaySessionView>
    return (
        typeof item.id === 'string' &&
        typeof item.agentId === 'string' &&
        typeof item.protocol === 'string' &&
        typeof item.state === 'string' &&
        Array.isArray(item.artifacts)
    )
}

function cursorAtOrBefore(value: string | undefined, current: string | undefined) {
    if (!value || !current) return false
    if (/^\d+$/.test(value) && /^\d+$/.test(current)) {
        return BigInt(value) <= BigInt(current)
    }
    return value === current
}

function maxCursor(left: string | undefined, right: string | undefined) {
    if (!left) return right
    if (!right) return left
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        return BigInt(right) > BigInt(left) ? right : left
    }
    return right === left ? left : right
}

function statusOf(error: unknown) {
    if (!error || typeof error !== 'object') return undefined
    const value = (error as { status?: unknown }).status
    return typeof value === 'number' ? value : undefined
}

function retryAfterMsOf(error: unknown) {
    if (!error || typeof error !== 'object') return 0
    const value = (error as {
        retryAfterMs?: unknown
        retryAfter?: unknown
        metadata?: { retryAfterMs?: unknown }
    }).retryAfterMs ??
        (error as { retryAfter?: unknown }).retryAfter ??
        (error as { metadata?: { retryAfterMs?: unknown } }).metadata
            ?.retryAfterMs
    const delayMs = Number(value)
    return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0
}

function terminalArtifactStorageStatus(
    artifact: GatewaySessionView['artifacts'][number]
) {
    return (
        artifact.storageStatus === 'metadata_only' ||
        artifact.storageStatus === 'expired' ||
        artifact.storageStatus === 'evicted' ||
        artifact.metadata?.storageStatus === 'metadata_only' ||
        artifact.metadata?.storageStatus === 'expired' ||
        artifact.metadata?.storageStatus === 'evicted'
    )
}

export function fromGatewaySession(
    session: GatewaySessionView,
    previousState: Record<string, unknown>
): DelegationProviderResult {
    const completionError = validateGatewayCompletion(session)
    const providerState = {
        ...structuredClone(previousState),
        gatewaySessionId: session.id,
        ...(session.instanceId
            ? { gatewayInstanceId: session.instanceId }
            : {}),
        ...(session.runId ? { gatewayRunId: session.runId } : {}),
        protocol: session.protocol,
        ...(session.protocolSessionId
            ? { protocolSessionId: session.protocolSessionId }
            : {}),
        ...(session.acpSessionId ? { acpSessionId: session.acpSessionId } : {}),
        ...(session.lastEventId ? { lastEventId: session.lastEventId } : {}),
        agentId: session.agentId,
        ...(session.workspace ? { workspace: session.workspace } : {}),
        remoteState: completionError ? 'completed_unverified' : session.state,
        gatewayCompletion: session.completion
            ? structuredClone(session.completion)
            : undefined
    }
    return {
        state: completionError ? 'failed' : gatewayState(session.state),
        remoteState: completionError ? 'completed_unverified' : session.state,
        text: session.pendingRequest
            ? formatPendingRequest(session.pendingRequest, session.output)
            : session.output,
        error: completionError || session.error,
        artifacts: (session.artifacts || []).map((artifact) => ({
            artifactId: artifact.id,
            name: artifact.name,
            description: artifact.description,
            text: artifact.text,
            url: artifact.url,
            filename: artifact.filename,
            mediaType: artifact.mediaType,
            data: artifact.data,
            bytesBase64: artifact.bytesBase64,
            metadata: artifact.metadata
        })),
        pendingRequest: session.pendingRequest
            ? structuredClone(session.pendingRequest)
            : undefined,
        providerState
    }
}

function validateGatewayCompletion(session: GatewaySessionView) {
    if (session.state !== 'completed') return undefined
    const completion = session.completion
    if (!completion || completion.verified !== true) {
        return 'Nexus Gateway reported completed without a verifiable turn-completion proof. Upgrade the Gateway before trusting this result.'
    }
    if (completion.protocol !== session.protocol) {
        return 'Nexus Gateway completion proof does not match the Session protocol.'
    }
    if (session.runId && completion.runId !== session.runId) {
        return 'Nexus Gateway completion proof belongs to a different run.'
    }
    if (session.pendingRequest) {
        return 'Nexus Gateway reported completed while input or permission is still pending.'
    }
    if (!completion.outputPresent && completion.artifactCount < 1) {
        return 'Nexus Gateway completion proof does not contain a final response or artifact.'
    }
    if (!session.output?.trim() && (session.artifacts?.length || 0) < 1) {
        return 'Nexus Gateway completed Session does not expose a final response or artifact.'
    }
    return undefined
}

function formatPendingRequest(
    request: NonNullable<GatewaySessionView['pendingRequest']>,
    output?: string
) {
    const options = request.options?.length
        ? `\nOptions:\n${request.options
              .map(
                  (option, index) =>
                      `${index + 1}. ${option.name} (${option.id})${option.kind ? ` [${option.kind}]` : ''}`
              )
              .join('\n')}`
        : ''
    return [output?.trim(), request.prompt.trim(), options.trim()]
        .filter(Boolean)
        .join('\n\n')
}

function gatewayState(
    value: GatewaySessionView['state']
): DelegationProviderResult['state'] {
    if (value === 'input_required') return 'input_required'
    if (value === 'permission_required') return 'permission_required'
    if (value === 'completed') return 'completed'
    if (value === 'failed') return 'failed'
    if (value === 'canceled') return 'canceled'
    return 'running'
}

function stateString(job: DelegationJob, key: string) {
    const value = job.providerState[key]
    return typeof value === 'string' && value ? value : undefined
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
