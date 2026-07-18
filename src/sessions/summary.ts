import type { NexusSession, SessionSummary } from './types'

export function createPendingSummary(session: NexusSession): SessionSummary {
    const fallback = fallbackSummary(session)
    return {
        status: 'pending',
        revision: session.summary?.revision ?? 0,
        source: 'fallback',
        title: fallback.title,
        abstract: fallback.abstract,
        topics: []
    }
}

export function fallbackSummary(session: NexusSession) {
    const firstUser = session.messages.find(
        (message) => message.role === 'user' && cleanText(message.content)
    )
    const lastAssistant = [...session.messages]
        .reverse()
        .find(
            (message) =>
                message.role === 'assistant' && cleanText(message.content)
        )
    const first = cleanText(firstUser?.content || '')
    const last = cleanText(lastAssistant?.content || '')
    return {
        title: truncate(first || `${session.agent} 会话`, 48),
        abstract: truncate(
            [first, last && last !== first ? last : ''].filter(Boolean).join('；'),
            220
        )
    }
}

export function buildSummaryPrompt(session: NexusSession, maxChars: number) {
    const transcript = selectTranscript(session, maxChars)
    return `请总结下面这段 AgentNexus 会话。只输出一个 JSON 对象，不要使用 Markdown 代码块或解释。

格式：
{"title":"5-24字的话题标题","abstract":"40-160字的会话摘要","topics":["关键词1","关键词2"]}

要求：
- 使用会话主要语言。
- 标题只描述话题，不写“用户询问”“会话总结”。
- 摘要说明用户目标、关键选择和最终结果；不要编造。
- topics 最多 5 个短关键词。

会话：
${transcript}`
}

export function parseModelSummary(
    text: string,
    fallback: ReturnType<typeof fallbackSummary>
): Pick<SessionSummary, 'title' | 'abstract' | 'topics'> | undefined {
    const candidate = text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    try {
        const value = JSON.parse(candidate) as Record<string, unknown>
        const title = cleanText(String(value.title || ''))
        const abstract = cleanText(String(value.abstract || value.summary || ''))
        const topics = Array.isArray(value.topics)
            ? value.topics
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => truncate(cleanText(item), 24))
                  .filter(Boolean)
                  .slice(0, 5)
            : []
        if (!title && !abstract) return undefined
        return {
            title: truncate(title || fallback.title, 48),
            abstract: truncate(abstract || fallback.abstract, 260),
            topics
        }
    } catch {
        return undefined
    }
}

function selectTranscript(session: NexusSession, maxChars: number) {
    const messages = session.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${cleanText(message.content)}`)
        .filter((line) => !/[：:]$/.test(line))
    const selected: string[] = []
    let size = 0
    for (const line of messages.slice(-30).reverse()) {
        const clipped = truncate(line, 2000)
        if (selected.length && size + clipped.length > maxChars) break
        selected.unshift(clipped)
        size += clipped.length
    }
    return selected.join('\n')
}

function cleanText(value: string) {
    return value
        .replace(/<nexus_session>[\s\S]*?<\/nexus_session>/gi, '')
        .replace(/<nexus_files>[\s\S]*?<\/nexus_files>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function truncate(value: string, limit: number) {
    if (value.length <= limit) return value
    return `${value.slice(0, Math.max(1, limit - 1))}…`
}
