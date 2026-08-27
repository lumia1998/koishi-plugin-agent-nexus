import type { DelegationContext, DelegationRouting } from '../delegation'

export function toolDelegationContext(
    parentConfig: any
): DelegationContext | undefined {
    const configurable = parentConfig?.configurable
    const session = configurable?.session
    const conversationId = String(
        configurable?.conversationId ??
            configurable?.agentContext?.conversationId ??
            configurable?.agentContext?.parentConversationId ??
            ''
    ).trim()
    const userId = String(
        configurable?.userId ??
            configurable?.agentContext?.userId ??
            session?.userId ??
            ''
    ).trim()
    if (!conversationId || !userId) return undefined

    const routing: DelegationRouting = {
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
