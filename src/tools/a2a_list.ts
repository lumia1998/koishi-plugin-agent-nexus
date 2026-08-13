import z from './chatluna-dependencies'
import { NexusToolBase } from './base'

export class NexusA2AListTool extends NexusToolBase {
    name = 'nexus_a2a_list'

    description =
        'List configured A2A agents and their discovered Agent Card capabilities. Set refresh to discover the selected peer again.'

    schema = z.object({
        remote: z.string().optional().describe('A2A remote name or id'),
        refresh: z.boolean().optional().describe('Refresh the remote Agent Card')
    })

    async _call(input: { remote?: string; refresh?: boolean }) {
        try {
            const remoteId = input.remote
                ? this.nexus.resolveA2ARemoteId(input.remote)
                : undefined
            if (remoteId && input.refresh) {
                await this.nexus.discoverA2ARemote(remoteId)
            }
            const remotes = this.nexus
                .getA2AStatus()
                .remotes.filter((remote) => !remoteId || remote.id === remoteId)
            if (!remotes.length) return 'No A2A remotes configured.'
            return remotes
                .map((remote) => {
                    const card = remote.card
                    return [
                        `${remote.name} (${remote.id})`,
                        `  url: ${remote.baseUrl}`,
                        `  state: ${remote.state}${remote.error ? ` - ${remote.error}` : ''}`,
                        `  card: ${card ? `${card.name}@${card.version}` : '(not discovered)'}`,
                        `  protocols: ${card?.protocolVersions.join(', ') || '(unknown)'}`,
                        `  skills: ${card?.skills.map((skill) => skill.id).join(', ') || '(unknown)'}`
                    ].join('\n')
                })
                .join('\n\n')
        } catch (error) {
            return this.formatError(error)
        }
    }
}
