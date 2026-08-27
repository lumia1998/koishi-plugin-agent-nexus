import z from './chatluna-dependencies'
import {
    buildDelegationToolNames,
    type DelegateAction,
    type DelegateToolInput,
    type RemoteAgentInfo
} from '../delegation'
import type { AgentNexusService } from '../service'
import { NexusToolBase } from './base'
import { toolDelegationContext } from './context'

type DelegateToolParentConfig = any

export interface NexusToolPlatform {
    registerTool(name: string, tool: any): (() => void) | void
}

/**
 * ChatLuna tool bound to one configured logical Agent.
 *
 * The transport and remote id stay inside AgentNexus. The model only sees the
 * Agent-specific tool name and supplies a prompt (or a job continuation id).
 */
export class NexusAgentDelegateTool extends NexusToolBase {
    readonly name: string
    readonly description: string
    readonly schema

    constructor(
        nexus: AgentNexusService,
        private readonly agentId: string,
        agentName: string,
        name: string,
        description?: string
    ) {
        super(nexus)
        this.name = name
        this.description =
            description ||
            `Delegate a task to ${agentName} through AgentNexus. Pass the user's task unchanged in prompt. The tool waits for ${agentName}'s reply by default. Set background=true only when the task should continue asynchronously; use the returned job id with action=status, action=message, or action=stop.`
        this.schema = z.object({
            action: z
                .enum(['run', 'status', 'message', 'stop'])
                .optional()
                .default('run')
                .describe('run a task, continue it, inspect it, or stop it'),
            id: z
                .string()
                .optional()
                .describe('AgentNexus job id for status, continuation, or stop.'),
            prompt: z
                .string()
                .optional()
                .describe('Task instruction or follow-up message for this Agent.'),
            background: z
                .boolean()
                .optional()
                .default(false)
                .describe('Return immediately and continue asynchronously instead of waiting for the Agent reply.'),
            newTask: z
                .boolean()
                .optional()
                .describe('Start without reusing this Agent\'s previous remote context.'),
            skill: z
                .string()
                .optional()
                .describe('Optional configured skill hint for this Agent.')
        })
    }

    async _call(
        input: Omit<DelegateToolInput, 'remote' | 'action'> & {
            action?: DelegateAction
        },
        _runManager?: unknown,
        parentConfig?: DelegateToolParentConfig
    ) {
        try {
            const context = toolDelegationContext(parentConfig)
            return await this.nexus.handleDelegate(
                {
                    ...input,
                    remote: this.agentId
                },
                context,
                parentConfig?.signal
            )
        } catch (error) {
            return this.formatError(error)
        }
    }
}

export function registerAgentDelegationTools(
    platform: NexusToolPlatform,
    nexus: AgentNexusService,
    agents: readonly RemoteAgentInfo[]
) {
    const enabled = agents.filter((agent) => agent.enabled)
    const names = buildDelegationToolNames(enabled)
    const disposers: (() => void)[] = []
    for (const agent of enabled) {
        const name = names.get(agent.id)
        if (!name) continue
        const tool = new NexusAgentDelegateTool(
            nexus,
            agent.id,
            agent.name,
            name,
            undefined
        )
        const dispose = platform.registerTool(name, {
            description: tool.description,
            selector: () => true,
            createTool: () => tool,
            meta: {
                source: 'extension',
                group: 'agent-nexus',
                tags: ['agent-nexus', 'delegation', `agent:${agent.id}`],
                defaultAvailability: {
                    enabled: true,
                    main: true,
                    chatluna: true,
                    characterScope: 'all'
                }
            }
        })
        if (typeof dispose === 'function') disposers.push(dispose)
    }
    return disposers
}
