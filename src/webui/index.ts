import { Context } from 'koishi'
import { resolve } from 'path'
import type { AgentNexusService } from '../service'
import type { DelegationAgentConfig } from '../types'

export const name = 'agent-nexus-webui'
export const inject = ['console', 'agent_nexus']

export function apply(ctx: Context) {
    ctx.console.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist')
    })

    const nexus = () => ctx.agent_nexus as AgentNexusService
    const commandAuthority = { authority: nexus().commandAuthority }

    ctx.console.addListener('agent-nexus/getConsoleData', async () =>
        nexus().getConsoleData()
    )
    ctx.console.addListener(
        'agent-nexus/listDelegationJobs',
        async (limit?: number) => nexus().listDelegationJobs(limit),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/cancelDelegationJob',
        async (id: string) => nexus().cancelDelegationJob(id),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/clearTerminalDelegationJobs',
        async () => nexus().clearTerminalDelegationJobs(),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/refreshGateway',
        async () => nexus().refreshRemoteStatuses(),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/saveDelegationAgent',
        async (input: Partial<DelegationAgentConfig>) =>
            nexus().saveDelegationAgent(input),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/removeDelegationAgent',
        async (agentId: string) => nexus().removeDelegationAgent(agentId),
        commandAuthority
    )
}

declare module '@koishijs/plugin-console' {
    interface Events {
        'agent-nexus/getConsoleData'(): Promise<import('../types').NexusConsoleData>
        'agent-nexus/listDelegationJobs'(
            limit?: number
        ): Promise<import('../delegation/types').DelegationJobView[]>
        'agent-nexus/cancelDelegationJob'(id: string): Promise<string>
        'agent-nexus/clearTerminalDelegationJobs'(): Promise<number>
        'agent-nexus/refreshGateway'(): Promise<import('../types').NexusStatus>
        'agent-nexus/saveDelegationAgent'(
            input: Partial<import('../types').DelegationAgentConfig>
        ): Promise<{
            agentId: string
            data: import('../types').NexusConsoleData
        }>
        'agent-nexus/removeDelegationAgent'(
            agentId: string
        ): Promise<import('../types').NexusConsoleData>
    }
}
