import { h } from 'koishi'
import type { DelegationArtifact, DelegationRouting } from './types'

export interface DelegationArtifactBot {
    createDirectChannel(userId: string): Promise<{ id: string }>
    sendMessage(channelId: string, content: any): Promise<unknown>
}

/**
 * Convert Gateway artifacts into native Koishi resource elements.
 *
 * The URL remains the resource source, but the element type is selected here
 * instead of asking the language model to repeat a download link.
 */
export function delegationArtifactElements(artifacts: DelegationArtifact[]) {
    return artifacts
        .filter((artifact): artifact is DelegationArtifact & { url: string } => Boolean(artifact.url))
        .map((artifact) => {
            const mediaType = artifactMediaType(artifact)
            const element = mediaType?.startsWith('image/')
                ? h.image(artifact.url)
                : mediaType?.startsWith('audio/')
                  ? h.audio(artifact.url)
                  : mediaType?.startsWith('video/')
                    ? h.video(artifact.url)
                    : h.file(artifact.url)
            const filename = artifact.filename || artifact.name
            if (filename) {
                element.attrs.filename = filename
                element.attrs.title = filename
            }
            if (mediaType) element.attrs.type = mediaType
            return element
        })
}

function artifactMediaType(artifact: DelegationArtifact) {
    if (artifact.mediaType) return artifact.mediaType.toLowerCase()
    const filename = artifact.filename || artifact.name || ''
    const extension = filename.split('.').pop()?.toLowerCase()
    return extension
        ? {
              png: 'image/png',
              jpg: 'image/jpeg',
              jpeg: 'image/jpeg',
              gif: 'image/gif',
              webp: 'image/webp',
              mp3: 'audio/mpeg',
              m4a: 'audio/mp4',
              wav: 'audio/wav',
              ogg: 'audio/ogg',
              mp4: 'video/mp4',
              webm: 'video/webm'
          }[extension]
        : undefined
}

export async function sendDelegationArtifacts(
    bots: Record<string, DelegationArtifactBot | undefined>,
    routing: DelegationRouting,
    artifacts: DelegationArtifact[]
) {
    const elements = delegationArtifactElements(artifacts)
    if (!elements.length) return

    const bot = bots[`${routing.platform}:${routing.selfId}`]
    if (!bot) {
        throw new Error(
            `The Koishi bot for ${routing.platform}:${routing.selfId} is unavailable.`
        )
    }

    const channelId = routing.isDirect
        ? (await bot.createDirectChannel(routing.userId)).id
        : routing.channelId || routing.guildId
    if (!channelId) {
        throw new Error('The delegation result has no Koishi channel target.')
    }
    await bot.sendMessage(channelId, elements)
}
