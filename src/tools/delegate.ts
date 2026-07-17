import z from 'zod'
import { NexusToolBase } from './base'
import { truncateText } from '../utils/shell'
import type { DelegateInput } from '../types'
import type { SessionIdentity } from '../sessions/types'

export class NexusDelegateTool extends NexusToolBase {
    name = 'nexus_delegate'

    description = `Delegate a complex task to a remote code agent over SSH.
Supported agents: hermes, openclaw, claude, opencode, codex.
Use this for multi-step coding, crawling skills, repo operations, and long agent workflows.
The remote agent runs non-interactively, while AgentNexus preserves task state and pending user actions.
When a previous call asks for a choice, confirmation, or input, call this tool again with the user's answer.
Produced files can be auto-published.`

    schema = z.object({
        prompt: z.string().describe('Task instruction for the code agent'),
        agent: z
            .enum(['auto', 'hermes', 'openclaw', 'claude', 'opencode', 'codex'])
            .optional()
            .describe('Target code agent. Defaults to host/auto selection.'),
        hostId: z
            .string()
            .optional()
            .describe(
                'SSH host id, device name, or address (user@host). Defaults to configured default host.'
            ),
        cwd: z.string().optional().describe('Remote working directory'),
        model: z.string().optional().describe('Optional model override'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
        openclawAgent: z
            .string()
            .optional()
            .describe('OpenClaw agent name, default "default"'),
        publishFiles: z
            .boolean()
            .optional()
            .describe('If true, publish detected output files via SFTP')
    })

    async _call(input: {
        prompt: string
        agent?: 'auto' | 'hermes' | 'openclaw' | 'claude' | 'opencode' | 'codex'
        hostId?: string
        cwd?: string
        model?: string
        timeoutMs?: number
        openclawAgent?: string
        publishFiles?: boolean
    }, _runManager?: unknown, parentConfig?: any) {
        try {
            const delegateInput: DelegateInput = {
                prompt: input.prompt,
                agent: input.agent,
                hostId: input.hostId,
                cwd: input.cwd,
                model: input.model,
                timeoutMs: input.timeoutMs,
                openclawAgent: input.openclawAgent,
                publishFiles: input.publishFiles ?? true,
                signal: parentConfig?.signal
            }
            const identity = toolSessionIdentity(parentConfig)
            const outcome = identity
                ? await this.nexus.runInSession(identity, delegateInput, {
                      requestId: parentConfig?.configurable?.session?.messageId
                  })
                : undefined
            if (outcome?.kind === 'cancelled') {
                return outcome.reply || 'Agent task cancelled.'
            }
            if (outcome && !outcome.result) {
                return outcome.reply || 'Agent session is not ready.'
            }
            const result =
                outcome?.result ?? (await this.nexus.delegate(delegateInput))

            const lines = [
                `Agent: ${result.agent}`,
                `Exit: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
                `Command: ${result.command}`,
                '',
                truncateText(result.text || '(no output)')
            ]

            if (result.files.length) {
                lines.push('', 'Files:')
                for (const file of result.files) {
                    const pub = result.published?.find((p) => p.path === file)
                    lines.push(
                        pub?.url
                            ? `- ${file} → ${pub.url}`
                            : `- ${file}${pub?.error ? ` (${pub.error})` : ''}`
                    )
                }
            }

            return lines.join('\n')
        } catch (err) {
            return this.formatError(err)
        }
    }
}

function toolSessionIdentity(parentConfig: any): SessionIdentity | undefined {
    const configurable = parentConfig?.configurable
    const session = configurable?.session
    const userId = String(configurable?.userId ?? session?.userId ?? '').trim()
    if (!userId) return undefined
    return {
        userId,
        channelId: configurable?.conversationId
            ? `${String(session?.channelId ?? '')}#chatluna:${String(configurable.conversationId)}`
            : String(session?.channelId ?? ''),
        platform: String(session?.platform ?? 'chatluna'),
        selfId: String(session?.selfId ?? '')
    }
}
