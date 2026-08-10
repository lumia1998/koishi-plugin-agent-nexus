import type { SessionIdentity } from '../sessions/types'
import type { A2ADelegationContext, A2ADelegationRouting } from '../a2a/delegation-store'

export function toolSessionIdentity(parentConfig: any): SessionIdentity | undefined {
    const configurable = parentConfig?.configurable
    const session = configurable?.session
    const userId = String(configurable?.userId ?? session?.userId ?? '').trim()
    if (!userId) return undefined
    return {
        userId,
        channelId: configurable?.conversationId
            ? `${String(session?.channelId ?? '')}#chatluna:${String(configurable.conversationId)}`
            : String(session?.channelId ?? ''),
        platform: String(session?.platform ?? 'chatluna'),
        selfId: String(session?.selfId ?? '')
    }
}

export function toolA2ADelegationContext(
    parentConfig: any
): A2ADelegationContext | undefined {
    const configurable = parentConfig?.configurable
    const session = configurable?.session
    const conversationId = String(
        configurable?.conversationId ??
            configurable?.agentContext?.parentConversationId ??
            ''
    ).trim()
    const userId = String(configurable?.userId ?? session?.userId ?? '').trim()
    if (!conversationId || !userId) return undefined

    const routing: A2ADelegationRouting = {
        platform: String(session?.platform ?? 'chatluna'),
        selfId: String(session?.selfId ?? ''),
        userId,
        username: optionalString(session?.username ?? session?.author?.name),
        guildId: optionalString(session?.guildId),
        channelId: optionalString(session?.channelId),
        isDirect: Boolean(session?.isDirect ?? !session?.guildId)
    }
    return {
        parentConversationId: conversationId,
        source: configurable?.source === 'character' ? 'character' : 'chatluna',
        routing
    }
}

function optionalString(value: unknown) {
    const text = String(value ?? '').trim()
    return text || undefined
}
