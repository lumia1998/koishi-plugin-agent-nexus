import z from 'zod'
import { NexusToolBase } from './base'

export class NexusPublishTool extends NexusToolBase {
    name = 'nexus_publish'

    description = `Publish remote files from the SSH host via SFTP and return temporary URLs.
Use after nexus_delegate when the agent produced images/files and publishFiles was false.`

    schema = z.object({
        paths: z.array(z.string()).min(1).describe('Remote absolute file paths'),
        hostId: z.string().optional().describe('SSH host id')
    })

    async _call(input: { paths: string[]; hostId?: string }) {
        try {
            const items = await this.nexus.publishFiles(input.paths, input.hostId)
            if (!items.length) return 'No files published.'
            return items
                .map((item) =>
                    item.url
                        ? `${item.path} → ${item.url}`
                        : `${item.path} → failed: ${item.error || 'unknown'}`
                )
                .join('\n')
        } catch (err) {
            return this.formatError(err)
        }
    }
}
