import type { DelegationJob, RemoteAgentInfo } from './types'

export type DelegationToolAgent = Pick<
    RemoteAgentInfo,
    'id' | 'name' | 'agentId'
>

/**
 * Build the ChatLuna tool names exposed for configured logical agents.
 *
 * The provider agent id is preferred for Gateway routes so managed agents keep
 * predictable names (`nexus_opencode`, `nexus_pi`, ...). A2A routes normally
 * have no provider agent id, so their configured display name is used.
 */
export function buildDelegationToolNames(
    agents: readonly DelegationToolAgent[]
) {
    const names = new Map<string, string>()
    const used = new Set<string>()
    for (const agent of agents) {
        if (!agent.id || names.has(agent.id)) continue
        const base = `nexus_${toolNameSegment(
            agent.agentId || agent.name || agent.id
        )}`
        let name = base
        let suffix = 2
        while (used.has(name)) name = `${base}_${suffix++}`
        used.add(name)
        names.set(agent.id, name)
    }
    return names
}

export function delegationToolNameForAgent(
    agent: DelegationToolAgent,
    agents: readonly DelegationToolAgent[] = [agent]
) {
    return (
        buildDelegationToolNames(agents).get(agent.id) ||
        `nexus_${toolNameSegment(agent.agentId || agent.name || agent.id)}`
    )
}

export function delegationToolNameForJob(
    job: Pick<DelegationJob, 'toolName' | 'agentId' | 'agentName' | 'providerAgentId'>
) {
    return (
        job.toolName ||
        delegationToolNameForAgent({
            id: job.agentId,
            name: job.agentName,
            agentId: job.providerAgentId
        })
    )
}

export function toolNameSegment(value: string) {
    const normalized = value.normalize('NFKD').toLowerCase()
    // The product names are longer than the CLI shorthand users expect as tool
    // names: DeepSeek Harness is `dsh`, Grok Build is `grok`.
    if (normalized.includes('deepseek') || /\bdsh\b/.test(normalized)) return 'dsh'
    if (normalized.includes('grok')) return 'grok'
    const known = normalized.match(/(?:openclaw|opencode|hermes|claude|codex|pi)/)
    if (known) return known[0]
    const slug = normalized
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
    return slug || 'agent'
}
