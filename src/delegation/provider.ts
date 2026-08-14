import type {
    DelegationProvider,
    DelegationProviderType,
    RemoteAgentInfo
} from './types'

export class DelegationProviderRegistry {
    private providers = new Map<DelegationProviderType, DelegationProvider>()

    register(provider: DelegationProvider) {
        if (this.providers.has(provider.type)) {
            throw new Error(`Delegation provider is already registered: ${provider.type}`)
        }
        this.providers.set(provider.type, provider)
        return this
    }

    get(type: DelegationProviderType) {
        const provider = this.providers.get(type)
        if (!provider) throw new Error(`Delegation provider is unavailable: ${type}`)
        return provider
    }

    listAgents() {
        return Array.from(this.providers.values()).flatMap((provider) =>
            provider.listAgents()
        )
    }

    findAgent(id: string) {
        return this.listAgents().find((agent) => agent.id === id)
    }

    resolveAgent(reference: string) {
        const direct = this.findAgent(reference)
        if (direct) return direct
        const value = reference.trim().toLowerCase()
        const matches = this.listAgents().filter((agent) =>
            [agent.name, ...(agent.aliases || [])].some(
                (item) => item.trim().toLowerCase() === value
            )
        )
        if (matches.length > 1) {
            throw new Error(
                `Agent name “${reference}” is ambiguous. Use its AgentNexus id.`
            )
        }
        if (!matches[0]) throw new Error(`Delegation agent not found: ${reference}`)
        return matches[0]
    }

    providerFor(agent: RemoteAgentInfo) {
        return this.get(agent.provider)
    }
}
