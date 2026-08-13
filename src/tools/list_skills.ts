import z from './chatluna-dependencies'
import { NexusToolBase } from './base'

export class NexusListSkillsTool extends NexusToolBase {
    name = 'nexus_list_skills'

    description = 'List skills synced by AgentNexus on the remote host.'

    schema = z.object({
        hostId: z
            .string()
            .optional()
            .describe('SSH host id, device name, or address. Defaults to default host.'),
        refresh: z.boolean().optional()
    })

    async _call(input: { hostId?: string; refresh?: boolean }) {
        try {
            const skills = input.refresh
                ? await this.nexus.refreshSkills(input.hostId)
                : this.nexus.getSkillsForHost(input.hostId)

            if (!skills.length) return 'No skills found.'
            return skills
                .map(
                    (s) =>
                        `${s.name} @ ${s.path}` +
                        (s.linkedAgents.length
                            ? ` [linked: ${s.linkedAgents.join(',')}]`
                            : '')
                )
                .join('\n')
        } catch (err) {
            return this.formatError(err)
        }
    }
}
