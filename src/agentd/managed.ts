import { randomUUID } from 'crypto'
import path from 'path'
import type {
    AgentdAgentKind,
    DelegationAgentConfig
} from '../types'

export function reconcileManagedDelegationAgents(
    current: DelegationAgentConfig[],
    input: {
        hostId: string
        hostName: string
        gatewayId: string
        agents: AgentdAgentKind[]
        workspaceRoots: string[]
        createMissing: boolean
    }
) {
    const selected = new Set(input.agents)
    const managedKinds = new Set<AgentdAgentKind>()
    const result: DelegationAgentConfig[] = []

    for (const agent of current) {
        if (agent.managedHostId !== input.hostId) {
            result.push(agent)
            continue
        }
        if (agent.provider !== 'gateway') {
            result.push({ ...agent, managedHostId: undefined })
            continue
        }
        const kind = agent.agentId as AgentdAgentKind | undefined
        if (!kind || !selected.has(kind) || managedKinds.has(kind)) continue
        managedKinds.add(kind)
        result.push({
            ...agent,
            remoteId: input.gatewayId,
            workspace: workspaceWithinRoots(agent.workspace, input.workspaceRoots)
                ? agent.workspace
                : input.workspaceRoots[0]
        })
    }

    if (!input.createMissing) return result
    for (const kind of input.agents) {
        const exists = result.some(
            (agent) =>
                agent.provider === 'gateway' &&
                agent.remoteId === input.gatewayId &&
                agent.agentId === kind
        )
        if (exists) continue
        result.push({
            id: randomUUID(),
            name: `${input.hostName} ${agentDisplayName(kind)}`,
            enabled: true,
            provider: 'gateway',
            remoteId: input.gatewayId,
            agentId: kind,
            workspace: input.workspaceRoots[0],
            description: `${agentDisplayName(kind)} on ${input.hostName}`,
            skills: [],
            managedHostId: input.hostId
        })
    }
    return result
}

function workspaceWithinRoots(workspace: string | undefined, roots: string[]) {
    if (!workspace || !path.posix.isAbsolute(workspace)) return false
    const value = path.posix.normalize(workspace)
    return roots.some((root) => {
        const normalizedRoot = path.posix.normalize(root)
        return value === normalizedRoot || value.startsWith(`${normalizedRoot}/`)
    })
}

function agentDisplayName(kind: AgentdAgentKind) {
    const labels: Record<AgentdAgentKind, string> = {
        openclaw: 'OpenClaw',
        claude: 'Claude Code',
        opencode: 'OpenCode',
        codex: 'Codex',
        pi: 'Pi'
    }
    return labels[kind]
}
