import type { ChatInvocationInput } from 'koishi-plugin-chatluna'
import type { A2ADelegationTask } from './delegation-store'

export async function notifyChatLunaA2ADelegation(
    chatluna: { invoke(input: ChatInvocationInput): Promise<any> } | undefined,
    task: A2ADelegationTask
) {
    if (!chatluna?.invoke) {
        throw new Error('ChatLuna invocation service is unavailable.')
    }
    const invocation: ChatInvocationInput = {
        routing: task.routing,
        message: formatA2ADelegationWakeup(task),
        messageName: 'a2a_task',
        conversation: {
            type: 'existing',
            id: task.parentConversationId
        },
        delivery: 'channel',
        source: {
            kind: 'agent-nexus-a2a',
            id: task.id,
            detail: {
                remoteId: task.remoteId,
                remoteName: task.remoteName,
                state: task.state
            }
        },
        persist: true
    }
    const result = await chatluna.invoke(invocation)
    if (!result?.ok) {
        throw new Error(
            result?.error?.message || 'ChatLuna rejected the A2A task wakeup.'
        )
    }
}

export function formatA2ADelegationWakeup(task: A2ADelegationTask) {
    const details = [
        task.output?.trim(),
        task.error?.trim() ? `Error: ${task.error.trim()}` : undefined,
        ...task.artifacts.map((artifact) =>
            artifact.url
                ? `${artifact.name || artifact.filename || 'file'}: ${artifact.url}`
                : artifact.text
        )
    ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
    const instruction =
        task.state === 'waiting_input'
            ? `The remote A2A agent is waiting for input. Use nexus_a2a_delegate action=message id=${task.id} with the user's answer.`
            : task.state === 'failed'
              ? `Report the A2A failure to the user. Retry with nexus_a2a_delegate action=run id=${task.id} only when appropriate.`
              : `Use this A2A result to answer the user. Continue the same remote context with nexus_a2a_delegate action=run id=${task.id} if needed.`
    return [
        `<a2a_task_result job_id="${escapeXml(task.id)}" agent="${escapeXml(task.remoteName)}" state="${task.state}">`,
        escapeXml(details || '(empty result)'),
        '</a2a_task_result>',
        '',
        `Automatic notice: a background A2A task started by this conversation has updated. ${instruction}`
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
