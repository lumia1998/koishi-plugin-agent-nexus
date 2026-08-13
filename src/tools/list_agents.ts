import z from './chatluna-dependencies'
import { NexusToolBase } from './base'

export class NexusListAgentsTool extends NexusToolBase {
    name = 'nexus_list_agents'

    description =
        'List remote SSH hosts and installed code agents (hermes/openclaw/claude/opencode/codex/pi).'

    schema = z.object({
        hostId: z
            .string()
            .optional()
            .describe('Optional host id, device name, or address to scan only one host'),
        refresh: z.boolean().optional().describe('Re-detect agents on the host')
    })

    async _call(input: { hostId?: string; refresh?: boolean }) {
        try {
            const resolvedHostId = input.hostId
                ? this.nexus.resolveHostId(input.hostId)
                : undefined
            const status = input.refresh
                ? await this.nexus.scanAgents(resolvedHostId)
                : this.nexus.getStatus()

            const hosts = status.hosts.filter((h) =>
                resolvedHostId ? h.id === resolvedHostId : true
            )
            if (!hosts.length) return 'No hosts configured.'

            return hosts
                .map((host) => {
                    const agents = host.agents
                        .filter((a) => a.installed)
                        .map((a) => `${a.kind}${a.version ? `@${a.version}` : ''}`)
                        .join(', ')
                    return [
                        `name: ${host.name}`,
                        `  id: ${host.id}`,
                        `  target: ${host.host}`,
                        `  state: ${host.state}${host.error ? ` - ${host.error}` : ''}`,
                        `  agents: ${agents || '(none detected)'}`,
                        `  use hostId: "${host.name}" or "${host.id}"`
                    ].join('\n')
                })
                .join('\n\n')
        } catch (err) {
            return this.formatError(err)
        }
    }
}
