import z from 'zod'
import { NexusToolBase } from './base'

export class NexusListAgentsTool extends NexusToolBase {
    name = 'nexus_list_agents'

    description =
        'List remote SSH hosts and installed code agents (hermes/openclaw/claude/opencode/codex).'

    schema = z.object({
        hostId: z.string().optional().describe('Optional host id to scan only one host'),
        refresh: z.boolean().optional().describe('Re-detect agents on the host')
    })

    async _call(input: { hostId?: string; refresh?: boolean }) {
        try {
            const status = input.refresh
                ? await this.nexus.scanAgents(input.hostId)
                : this.nexus.getStatus()

            const hosts = status.hosts.filter((h) =>
                input.hostId ? h.id === input.hostId : true
            )
            if (!hosts.length) return 'No hosts configured.'

            return hosts
                .map((host) => {
                    const agents = host.agents
                        .filter((a) => a.installed)
                        .map((a) => `${a.kind}${a.version ? `@${a.version}` : ''}`)
                        .join(', ')
                    return [
                        `${host.name} (${host.id})`,
                        `  target: ${host.host}`,
                        `  state: ${host.state}${host.error ? ` - ${host.error}` : ''}`,
                        `  agents: ${agents || '(none detected)'}`
                    ].join('\n')
                })
                .join('\n\n')
        } catch (err) {
            return this.formatError(err)
        }
    }
}
