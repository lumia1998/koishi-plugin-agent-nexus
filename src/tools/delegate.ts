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
            `通过 AgentNexus 将任务交给 ${agentName}。prompt 必须原样传递用户要求；当前消息中的图片和文件会一并转发。默认等待 ${agentName} 回复，只有需要异步执行时才设置 background=true；返回的任务 ID 可用于 action=status、action=message 或 action=stop。`
        this.schema = z.object({
            action: z
                .enum(['run', 'status', 'message', 'stop'])
                .optional()
                .default('run')
                .describe('执行任务、继续任务、查看状态或停止任务'),
            id: z
                .string()
                .optional()
                .describe('用于查看状态、继续或停止任务的 AgentNexus 任务 ID。'),
            prompt: z
                .string()
                .optional()
                .describe('发送给该智能体的任务要求或后续消息。'),
            background: z
                .boolean()
                .optional()
                .default(false)
                .describe('立即返回并在后台继续执行，不等待智能体回复。'),
            newTask: z
                .boolean()
                .optional()
                .describe('不复用该智能体之前的远程任务上下文，创建新任务。'),
            skill: z
                .string()
                .optional()
                .describe('可选的智能体技能提示。')
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
            const collectAttachments = (this.nexus as any).collectInputAttachments
            const canCarryInput = !input.action || input.action === 'run' || input.action === 'message'
            const attachments = canCarryInput && typeof collectAttachments === 'function'
                ? await collectAttachments.call(this.nexus, parentConfig)
                : []
            return await this.nexus.handleDelegate(
                {
                    ...input,
                    remote: this.agentId,
                    ...(attachments.length ? { attachments } : {})
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
