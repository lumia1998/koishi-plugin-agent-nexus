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
                .enum(['run', 'status', 'message', 'publish', 'stop'])
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
                .describe('可选的智能体技能提示。'),
            requestId: z
                .string()
                .optional()
                .describe('回复远端输入或授权请求时使用的精确请求 ID。'),
            optionId: z
                .string()
                .optional()
                .describe('授权或枚举输入的选项 ID。'),
            decision: z
                .enum(['accept', 'decline', 'cancel'])
                .optional()
                .describe('结构化确认决定。'),
            path: z
                .string()
                .optional()
                .describe('action=publish 时，要发布的远端工作区内文件路径。')
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

export class NexusTaskTool extends NexusToolBase {
    readonly name = 'nexus_task'
    readonly description =
        'Delegate work to a configured AgentNexus agent. Tasks keep their remote session for follow-up turns. ' +
        'Use background=true for long work; results and permission requests return to the originating conversation automatically. ' +
        'Actions: run, status, list, agents, message, publish, stop.'
    readonly schema = z.object({
        action: z
            .enum(['run', 'status', 'list', 'agents', 'message', 'publish', 'stop'])
            .optional()
            .default('run'),
        agent: z
            .string()
            .optional()
            .describe('Configured Agent id or exact name. Required when routing is ambiguous.'),
        id: z.string().optional().describe('Existing AgentNexus task id.'),
        prompt: z.string().optional().describe('Task, follow-up, or input response.'),
        background: z.boolean().optional().default(false),
        newTask: z.boolean().optional(),
        skill: z.string().optional(),
        requestId: z.string().optional(),
        optionId: z.string().optional(),
        decision: z.enum(['accept', 'decline', 'cancel']).optional(),
        path: z.string().optional().describe('Workspace file path for action=publish.')
    })

    async _call(
        input: DelegateToolInput & { agent?: string },
        _runManager?: unknown,
        parentConfig?: DelegateToolParentConfig
    ) {
        try {
            const context = toolDelegationContext(parentConfig)
            const collectAttachments = (this.nexus as any).collectInputAttachments
            const canCarryInput =
                !input.action || input.action === 'run' || input.action === 'message'
            const attachments =
                canCarryInput && typeof collectAttachments === 'function'
                    ? await collectAttachments.call(this.nexus, parentConfig)
                    : []
            return await this.nexus.handleDelegate(
                {
                    ...input,
                    remote: input.agent,
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
    const task = new NexusTaskTool(nexus)
    const disposeTask = platform.registerTool(task.name, {
        description: task.description,
        selector: () => true,
        createTool: () => task,
        meta: {
            source: 'extension',
            group: 'agent-nexus',
            tags: ['agent-nexus', 'delegation', 'handoff'],
            defaultAvailability: {
                enabled: true,
                main: true,
                chatluna: true,
                characterScope: 'all'
            }
        }
    })
    if (typeof disposeTask === 'function') disposers.push(disposeTask)
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
