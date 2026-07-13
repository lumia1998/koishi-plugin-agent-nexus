import z from 'zod'
import { NexusToolBase } from './base'

export class NexusListSkillsTool extends NexusToolBase {
    name = 'nexus_list_skills'

    description = 'List skills synced by AgentNexus on the remote host.'

    schema = z.object({
        hostId: z.string().optional(),
        refresh: z.boolean().optional()
    })

    async _call(input: { hostId?: string; refresh?: boolean }) {
        try {
            const skills = input.refresh
                ? await this.nexus.refreshSkills(input.hostId)
                : this.nexus.getStatus().skills.items

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
