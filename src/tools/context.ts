import type { DelegationContext, DelegationRouting } from '../delegation'

export function delegationContextFromSession(
    session: any,
    parentConversationId: string
): DelegationContext | undefined {
    const conversationId = String(parentConversationId || '').trim()
    const userId = String(session?.userId || '').trim()
    if (!conversationId || !userId) return undefined
    return {
        parentConversationId: conversationId,
        source: 'chatluna',
        routing: routingFromSession(session)
    }
}

export function routingFromSession(
    session: any,
    userIdOverride?: string
): DelegationRouting {
    return {
        platform: String(session?.platform || 'chatluna'),
        selfId: String(session?.selfId || ''),
        userId: String(userIdOverride || session?.userId || ''),
        username: optionalString(session?.username ?? session?.author?.name),
        guildId: optionalString(session?.guildId),
        channelId: optionalString(session?.channelId),
        isDirect: Boolean(session?.isDirect ?? !session?.guildId)
    }
}

export function sameDelegationRouting(
    left: DelegationRouting,
    right: DelegationRouting
) {
    return (
        left.platform === right.platform &&
        left.selfId === right.selfId &&
        left.userId === right.userId &&
        left.guildId === right.guildId &&
        left.channelId === right.channelId &&
        left.isDirect === right.isDirect
    )
}

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

    const routing = routingFromSession(session, userId)
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
