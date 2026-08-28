import type { ChatInvocationInput } from 'koishi-plugin-chatluna'
import type { DelegationArtifact, DelegationJob } from './types'
import { delegationToolNameForJob } from './tool-name'

export async function notifyChatLunaDelegation(
    chatluna: { invoke(input: ChatInvocationInput): Promise<any> } | undefined,
    job: DelegationJob,
    toolName = delegationToolNameForJob(job)
) {
    if (!chatluna?.invoke) {
        throw new Error('ChatLuna invocation service is unavailable.')
    }
    if (!job.routing || !job.parentConversationId) {
        throw new Error('This background job has no ChatLuna delivery context.')
    }
    const invocation: ChatInvocationInput = {
        routing: job.routing,
        message: wakeupMessage(job, toolName),
        messageName: 'delegation_job',
        conversation: {
            type: 'existing',
            id: job.parentConversationId
        },
        delivery: 'channel',
        source: {
            kind: 'agent-nexus-delegation',
            id: job.id,
            detail: {
                agentId: job.agentId,
                agentName: job.agentName,
                state: job.state
            }
        },
        persist: true
    }
    const result = await chatluna.invoke(invocation)
    if (!result?.ok) {
        throw new Error(
            result?.error?.message || 'ChatLuna rejected the delegation wakeup.'
        )
    }
}

function wakeupMessage(
    job: DelegationJob,
    toolName: string
): ChatInvocationInput['message'] {
    const media = job.artifacts
        .filter((artifact) => artifact.url)
        .map((artifact) => {
            const url = artifact.url!
            const mediaType = artifact.mediaType || ''
            if (mediaType.startsWith('image/')) {
                return { type: 'image_url', image_url: { url } }
            }
            if (mediaType.startsWith('audio/')) {
                return { type: 'audio_url', audio_url: { url, mimeType: mediaType } }
            }
            if (mediaType.startsWith('video/')) {
                return { type: 'video_url', video_url: { url, mimeType: mediaType } }
            }
            return { type: 'file_url', file_url: { url, mimeType: mediaType } }
        })
    if (!media.length) return formatDelegationWakeup(job, toolName)
    return [
        { type: 'text', text: formatDelegationWakeup(job, toolName) },
        ...media
    ] as ChatInvocationInput['message']
}

export function formatDelegationWakeup(
    job: DelegationJob,
    toolName = delegationToolNameForJob(job)
) {
    const output = redactArtifactUrls(job.output, job.artifacts)
    const details = [
        output?.trim(),
        job.error?.trim()
            ? `Error: ${redactArtifactUrls(job.error, job.artifacts)!.trim()}`
            : undefined,
        ...job.artifacts.map((artifact) =>
            artifact.url
                ? `${artifact.name || artifact.filename || 'file'}: [attachment published]`
                : artifactContent(artifact)
        )
    ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
    const interactive =
        job.state === 'input_required' || job.state === 'permission_required'
    const instruction = interactive
        ? `The remote agent is waiting for ${job.state === 'permission_required' ? 'a permission decision' : 'input'}. Use ${toolName} action=message id=${job.id} with the user's answer.`
        : job.state === 'failed'
          ? `Report the remote agent failure to the user. Retry with ${toolName} action=run id=${job.id} only when appropriate.`
          : `Use this remote agent result to answer the user. Continue the same context with ${toolName} action=run id=${job.id} if needed.`
    const attachmentInstruction = job.artifacts.some((artifact) => artifact.url)
        ? ' Published files are included as message attachments; do not print, quote, or expose their temporary URLs. Tell the user the file was sent and use its filename only.'
        : ''
    return [
        `<delegation_job_result job_id="${escapeXml(job.id)}" agent="${escapeXml(job.agentName)}" state="${job.state}">`,
        escapeXml(details || '(empty result)'),
        '</delegation_job_result>',
        '',
        `Automatic notice: a background AgentNexus job started by this conversation has updated. ${instruction}${attachmentInstruction}`
    ].join('\n')
}

function redactArtifactUrls(
    value: string | undefined,
    artifacts: DelegationArtifact[]
) {
    if (!value) return value
    return artifacts.reduce((result, artifact) => {
        if (!artifact.url) return result
        const label = artifact.name || artifact.filename || 'attachment'
        return result.split(artifact.url).join(`[${label} attached]`)
    }, value)
}

function artifactContent(artifact: DelegationJob['artifacts'][number]) {
    if (artifact.text) return artifact.text
    if (artifact.data !== undefined) {
        try {
            return JSON.stringify(artifact.data)
        } catch {}
    }
    if (!artifact.bytesBase64) return undefined
    const bytes = decodedBase64Size(artifact.bytesBase64)
    const details = [artifact.filename, artifact.mediaType, `${bytes} bytes`]
        .filter(Boolean)
        .join(', ')
    return `[binary artifact${details ? `: ${details}` : ''}]`
}

function decodedBase64Size(value: string) {
    const normalized = value.replace(/\s/g, '')
    if (!normalized) return 0
    const padding = normalized.endsWith('==')
        ? 2
        : normalized.endsWith('=')
          ? 1
          : 0
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function escapeXml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}
