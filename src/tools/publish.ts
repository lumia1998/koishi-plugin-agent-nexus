import { h } from 'koishi'
import z from './chatluna-dependencies'
import type { AgentNexusService } from '../service'
import { NexusToolBase } from './base'
import { toolDelegationContext } from './context'
import type { NexusToolPlatform } from './delegate'
import type { GatewayPublishedFile } from '../gateway/types'

export const NEXUS_FILE_PUBLISH_TOOL = 'nexus_file_publish'

export class NexusFilePublishTool extends NexusToolBase {
    readonly name = NEXUS_FILE_PUBLISH_TOOL
    readonly description =
        '发布 Nexus Agent 在工作区中生成的图片或文件。传入该 Agent 返回的原始文件路径；工具会让 Nexus Gateway 流式复制文件，并在有当前 Koishi 会话时通过 h.file 作为文件附件发送给用户。不要把临时 URL 写入回复、展示给用户或要求用户点击 URL；只说明文件名和发送状态。不得猜测路径，也不要读取文件转成 Base64。'
    readonly schema = z.object({
        id: z
            .string()
            .optional()
            .describe('产生这些文件的 AgentNexus 任务 ID；省略时使用当前对话最近的任务。'),
        paths: z
            .array(z.string())
            .min(1)
            .max(32)
            .describe('Agent 返回的一个或多个原始文件路径，可为会话工作区内的绝对或相对路径。')
    })

    async _call(
        input: { id?: string; paths: string[] },
        _runManager?: unknown,
        parentConfig?: any
    ) {
        try {
            const files = await this.nexus.publishDelegationFiles(
                input,
                toolDelegationContext(parentConfig)
            )
            const session = parentConfig?.configurable?.session
            const sent = await sendPublishedFiles(session, files)
            return formatPublishResult(files, sent)
        } catch (error) {
            return this.formatError(error)
        }
    }
}

async function sendPublishedFiles(
    session: { send?: (content: unknown) => Promise<unknown> } | undefined,
    files: GatewayPublishedFile[]
) {
    if (typeof session?.send !== 'function') return false
    for (const file of files) {
        const element = h.file(file.url, {
            filename: file.name,
            mime: file.mediaType || undefined
        })
        await session.send(element)
    }
    return true
}

function formatPublishResult(files: GatewayPublishedFile[], sent: boolean) {
    const names = files.map((file) => `- ${file.name}`).join('\n')
    return [
        sent
            ? '文件已发布，并已作为 Koishi 文件附件发送给用户：'
            : '文件已发布，但当前调用没有可用的 Koishi 会话来直接发送附件：',
        names,
        '请勿在回复中输出临时下载 URL；只描述文件名和处理结果。'
    ].join('\n')
}

export function registerGatewayFilePublishTool(
    platform: NexusToolPlatform,
    nexus: AgentNexusService
) {
    const tool = new NexusFilePublishTool(nexus)
    const dispose = platform.registerTool(tool.name, {
        description: tool.description,
        selector: () => true,
        createTool: () => tool,
        meta: {
            source: 'extension',
            group: 'agent-nexus',
            tags: ['agent-nexus', 'files', 'publish'],
            defaultAvailability: {
                enabled: true,
                main: true,
                chatluna: true,
                characterScope: 'all'
            }
        }
    })
    return typeof dispose === 'function' ? dispose : undefined
}
