import z from './chatluna-dependencies'
import { NexusToolBase } from './base'
import { formatA2ATask } from './a2a_send'

export class NexusA2ATaskTool extends NexusToolBase {
    name = 'nexus_a2a_task'

    description = 'Get or cancel a task on a configured A2A agent.'

    schema = z.object({
        remote: z.string().describe('A2A remote name or id'),
        taskId: z.string().describe('A2A task id'),
        action: z.enum(['get', 'cancel']).default('get')
    })

    async _call(input: {
        remote: string
        taskId: string
        action: 'get' | 'cancel'
    }) {
        try {
            const remoteId = this.nexus.resolveA2ARemoteId(input.remote)
            const result =
                input.action === 'cancel'
                    ? await this.nexus.cancelA2ATask(remoteId, input.taskId)
                    : await this.nexus.getA2ATask(remoteId, input.taskId)
            return formatA2ATask(result)
        } catch (error) {
            return this.formatError(error)
        }
    }
}
