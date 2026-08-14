import z from './chatluna-dependencies'
import type { DelegateToolInput } from '../delegation'
import { NexusToolBase } from './base'
import { toolDelegationContext } from './context'

export class NexusA2ADelegateTool extends NexusToolBase {
    name = 'nexus_a2a_delegate'

    description = `Delegate work to a configured remote agent through AgentNexus. Each AgentNexus agent is configured to use either A2A or Nexus Gateway + ACP; do not choose or simulate the transport yourself.
When the user asks to call a named remote agent, pass the requested task directly in prompt without researching, solving, or rewriting it first.
Use action=run for a new task; long tasks run in the background by default and their result is delivered automatically to the same ChatLuna conversation.
AgentNexus keeps protocol task/session identifiers private and automatically resumes a waiting task or the previous remote context.
Actions: run, status, list, agents, message, stop. Use message to answer an input-required task or guide a running task.`

    schema = z.object({
        action: z
            .enum(['run', 'status', 'list', 'agents', 'message', 'stop'])
            .optional()
            .default('run'),
        remote: z
            .string()
            .optional()
            .describe('Configured AgentNexus agent name or id. Its A2A/ACP connection is selected by configuration.'),
        id: z
            .string()
            .optional()
            .describe('AgentNexus job id for status, continuation, guidance, or stop.'),
        prompt: z
            .string()
            .optional()
            .describe('Task instruction or follow-up message for the remote agent.'),
        background: z
            .boolean()
            .optional()
            .default(true)
            .describe('Run in background and deliver the result automatically. Defaults to true.'),
        newTask: z
            .boolean()
            .optional()
            .describe('Start without reusing the current remote task/session context.'),
        skill: z
            .string()
            .optional()
            .describe('Agent Card skill id/name used to select or hint the remote agent.')
    })

    async _call(
        input: DelegateToolInput,
        _runManager?: unknown,
        parentConfig?: any
    ) {
        try {
            const context = toolDelegationContext(parentConfig)
            if (!context) {
                throw new Error(
                    'nexus_a2a_delegate requires a ChatLuna conversation context.'
                )
            }
            return await this.nexus.handleA2ADelegate(
                input,
                context,
                parentConfig?.signal
            )
        } catch (error) {
            return this.formatError(error)
        }
    }
}
