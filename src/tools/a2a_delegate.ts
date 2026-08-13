import z from './chatluna-dependencies'
import type { A2ADelegateToolInput } from '../a2a/delegation-manager'
import { NexusToolBase } from './base'
import { toolA2ADelegationContext } from './context'

export class NexusA2ADelegateTool extends NexusToolBase {
    name = 'nexus_a2a_delegate'

    description = `Delegate work to a configured remote A2A agent through AgentNexus.
Use action=run for a new task; long tasks run in the background by default and their result is delivered automatically to the same ChatLuna conversation.
AgentNexus keeps A2A task/context identifiers private and automatically resumes a waiting task or the previous remote context.
Actions: run, status, list, agents, message, stop. Use message to answer an input-required task or guide a running task. Low-level A2A protocol tools are only for debugging.`

    schema = z.object({
        action: z
            .enum(['run', 'status', 'list', 'agents', 'message', 'stop'])
            .optional()
            .default('run'),
        remote: z
            .string()
            .optional()
            .describe('Configured A2A agent name or id. Optional when unambiguous.'),
        id: z
            .string()
            .optional()
            .describe('AgentNexus A2A job id for status, continuation, guidance, or stop.'),
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
            .describe('Start without reusing the current A2A task or context.'),
        skill: z
            .string()
            .optional()
            .describe('Agent Card skill id/name used to select or hint the remote agent.'),
        agent: z
            .enum(['auto', 'hermes', 'openclaw', 'claude', 'opencode', 'codex', 'pi'])
            .optional()
            .describe('AgentNexus Bridge agent hint for compatible A2A peers.')
    })

    async _call(
        input: A2ADelegateToolInput,
        _runManager?: unknown,
        parentConfig?: any
    ) {
        try {
            const context = toolA2ADelegationContext(parentConfig)
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
