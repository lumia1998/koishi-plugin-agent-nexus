import type { ChatInvocationInput } from 'koishi-plugin-chatluna'
import type { DelegationJob } from './types'

export async function notifyChatLunaDelegation(
    chatluna: { invoke(input: ChatInvocationInput): Promise<any> } | undefined,
    job: DelegationJob
) {
    if (!chatluna?.invoke) {
        throw new Error('ChatLuna invocation service is unavailable.')
    }
    const invocation: ChatInvocationInput = {
        routing: job.routing,
        message: formatDelegationWakeup(job),
        messageName: job.provider === 'a2a' ? 'a2a_task' : 'delegation_job',
        conversation: {
            type: 'existing',
            id: job.parentConversationId
        },
        delivery: 'channel',
        source: {
            kind:
                job.provider === 'a2a'
                    ? 'agent-nexus-a2a'
                    : 'agent-nexus-delegation',
            id: job.id,
            detail: {
                provider: job.provider,
                agentId: job.agentId,
                agentName: job.agentName,
                remoteId: job.remoteId,
                remoteName: job.remoteName,
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

export function formatDelegationWakeup(job: DelegationJob) {
    const details = [
        job.output?.trim(),
        job.error?.trim() ? `Error: ${job.error.trim()}` : undefined,
        ...job.artifacts.map((artifact) =>
            artifact.url
                ? `${artifact.name || artifact.filename || 'file'}: ${artifact.url}`
                : artifact.text
        )
    ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
    const interactive =
        job.state === 'input_required' || job.state === 'permission_required'
    const instruction = interactive
        ? `The remote agent is waiting for ${job.state === 'permission_required' ? 'a permission decision' : 'input'}. Use nexus_a2a_delegate action=message id=${job.id} with the user's answer.`
        : job.state === 'failed'
          ? `Report the remote agent failure to the user. Retry with nexus_a2a_delegate action=run id=${job.id} only when appropriate.`
          : `Use this remote agent result to answer the user. Continue the same context with nexus_a2a_delegate action=run id=${job.id} if needed.`
    return [
        `<delegation_job_result job_id="${escapeXml(job.id)}" agent="${escapeXml(job.agentName)}" provider="${job.provider}" state="${job.state}">`,
        escapeXml(details || '(empty result)'),
        '</delegation_job_result>',
        '',
        `Automatic notice: a background AgentNexus job started by this conversation has updated. ${instruction}`
    ].join('\n')
}

function escapeXml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}
