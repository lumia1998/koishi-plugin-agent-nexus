import z from 'zod'
import type { A2ATaskView } from '../types'
import { NexusToolBase } from './base'

export class NexusA2ASendTool extends NexusToolBase {
    name = 'nexus_a2a_send'

    description =
        'Send a message to a configured A2A agent. Supports new tasks and follow-up turns using taskId/contextId.'

    schema = z.object({
        remote: z.string().describe('A2A remote name or id'),
        text: z.string().describe('Message for the remote agent'),
        taskId: z.string().optional().describe('Existing A2A task id for a follow-up'),
        contextId: z.string().optional().describe('Existing A2A context id'),
        agent: z
            .enum(['auto', 'hermes', 'openclaw', 'claude', 'opencode', 'codex', 'pi'])
            .optional()
            .describe('AgentNexus-specific target hint for compatible peers'),
        hostId: z
            .string()
            .optional()
            .describe('AgentNexus-specific SSH host hint for compatible peers'),
        returnImmediately: z
            .boolean()
            .optional()
            .describe('Return after task submission instead of waiting for completion')
    })

    async _call(input: {
        remote: string
        text: string
        taskId?: string
        contextId?: string
        agent?: string
        hostId?: string
        returnImmediately?: boolean
    }) {
        try {
            const remoteId = this.nexus.resolveA2ARemoteId(input.remote)
            const result = await this.nexus.sendA2AMessage({
                remoteId,
                text: input.text,
                taskId: input.taskId,
                contextId: input.contextId,
                returnImmediately: input.returnImmediately,
                metadata: {
                    ...(input.agent ? { agent: input.agent } : {}),
                    ...(input.hostId ? { hostId: input.hostId } : {})
                }
            })
            return formatA2ATask(result)
        } catch (error) {
            return this.formatError(error)
        }
    }
}

export function formatA2ATask(result: A2ATaskView) {
    const lines = [
        `Remote: ${result.remoteId}`,
        `State: ${result.state}`,
        ...(result.timedOut ? ['Wait: timed out; the remote task may still be running'] : []),
        ...(result.taskId ? [`Task: ${result.taskId}`] : []),
        ...(result.contextId ? [`Context: ${result.contextId}`] : [])
    ]
    if (result.text) lines.push('', result.text)
    if (result.artifacts.length) {
        lines.push('', 'Artifacts:')
        for (const artifact of result.artifacts) {
            lines.push(
                artifact.url
                    ? `- ${artifact.name || artifact.filename || 'file'}: ${artifact.url}`
                    : `- ${artifact.name || 'text'}: ${artifact.text || '(no preview)'}`
            )
        }
    }
    return lines.join('\n')
}
