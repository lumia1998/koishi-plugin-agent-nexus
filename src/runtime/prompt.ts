import type { NexusSession } from '../sessions/types'

const MAX_MESSAGES = 30
const MAX_CONTEXT_CHARS = 24000

export function buildSessionPrompt(session: NexusSession) {
    const state = {
        sessionId: session.id,
        taskId: session.taskId,
        agent: session.agent,
        status: session.status,
        pendingAction: compactValue(session.pendingAction, 4000),
        resumeAction: compactValue(session.data?.resumeAction, 4000),
        skillState: compactValue(session.data?.skillState, 6000),
        execution: compactValue(session.data?.execution, 2000)
    }
    const messages = selectMessages(session, state)
    const context = JSON.stringify({ state, messages }, null, 2)

    return `你是 AgentNexus 调用的无状态推理引擎。Hermes/Claude/Codex 等 CLI 不保存会话；下面的 Nexus Session 是本次任务的唯一上下文来源。

请基于完整会话状态继续当前任务，不要把用户的短回复当成一个全新的任务。如果状态包含 pendingAction/resumeAction，先消费该输入，再继续原 Skill 或任务。

当任务需要用户输入、确认或选择时，不要假装任务已经完成。请在最终输出中返回以下控制协议之一（可以放在 <nexus_session> 标签中）：
{"protocol":"nexus-session/v1","status":"waiting_input","prompt":"需要用户提供的内容","data":{}}
{"protocol":"nexus-session/v1","status":"waiting_confirm","prompt":"请选择","options":[{"id":1,"label":"选项A","value":{}}],"data":{}}

任务完成时正常输出结果；也可以返回：
{"status":"completed","output":"最终结果"}
失败时可以返回：
{"status":"failed","error":"失败原因"}

Nexus Session:
${context}`
}

export function buildSessionContinuationPrompt(session: NexusSession) {
    const latest = [...session.messages]
        .reverse()
        .find((message) => message.role === 'user')
    const payload = {
        sessionId: session.id,
        taskId: session.taskId,
        userMessage: latest?.content ?? '',
        resumeAction: compactValue(session.data?.resumeAction, 4000),
        skillState: compactValue(session.data?.skillState, 4000)
    }
    return `继续当前 Hermes 会话中的原任务。以下是 Nexus 路由到本轮的用户输入和结构化恢复状态；不要把它当成新任务。

如果仍需要用户输入，请继续使用 nexus-session/v1 waiting_input 或 waiting_confirm 控制协议。

${JSON.stringify(payload, null, 2)}`
}

function selectMessages(session: NexusSession, state: unknown) {
    const selected: Array<{ role: string; content: string; data?: unknown }> = []
    const messages = session.messages.slice(-MAX_MESSAGES).reverse()
    for (const message of messages) {
        const item = {
            role: message.role,
            content: truncateString(message.content, 4000),
            data: compactValue(message.data, 2000)
        }
        const candidate = [item, ...selected]
        const size = JSON.stringify({ state, messages: candidate }).length
        if (size <= MAX_CONTEXT_CHARS || selected.length === 0) {
            selected.unshift(item)
        }
    }
    return selected
}

function compactValue(value: unknown, limit: number): unknown {
    if (value === undefined) return undefined
    let text: string
    try {
        const serialized = JSON.stringify(value)
        if (serialized === undefined) return String(value)
        text = serialized
    } catch {
        return truncateString(String(value), limit)
    }
    if (text.length <= limit) return JSON.parse(text)
    return {
        truncated: true,
        preview: truncateString(text, limit)
    }
}

function truncateString(value: string, limit: number) {
    if (value.length <= limit) return value
    return `${value.slice(0, Math.max(0, limit - 24))}\n... (truncated)`
}
