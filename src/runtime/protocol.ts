import type { AgentResult } from '../types'
import type {
    NexusSessionStatus,
    PendingAction,
    PendingActionOption
} from '../sessions/types'

export interface AgentControl {
    status: NexusSessionStatus
    prompt?: string
    pendingAction?: PendingAction
    data?: unknown
    taskId?: string
    output?: string
    error?: string
}

export interface PendingActionResolution {
    matched: boolean
    value?: unknown
    label?: string
    error?: string
}

export function parseAgentControl(result: Pick<AgentResult, 'raw' | 'text'>) {
    const candidates = controlCandidates(result.raw, result.text)
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate)
            const control = normalizeControl(value)
            if (control) return control
        } catch {}
    }
    return undefined
}

export function resolvePendingAction(
    action: PendingAction,
    message: string
): PendingActionResolution {
    const input = message.trim()
    if (!input) {
        return { matched: false, error: '请输入有效内容。' }
    }

    if (action.type === 'input') {
        return { matched: true, value: input, label: input }
    }

    if (action.type === 'select') {
        const options = action.options ?? []
        const numeric = Number(input)
        const option = options.find(
            (item) =>
                (Number.isInteger(numeric) && item.id === numeric) ||
                item.label.trim().toLowerCase() === input.toLowerCase()
        )
        if (!option) {
            return {
                matched: false,
                error: formatSelectionError(action)
            }
        }
        return {
            matched: true,
            value: option.value,
            label: `${option.id}. ${option.label}`
        }
    }

    const normalized = input.toLowerCase()
    const yes = new Set([
        'y',
        'yes',
        'confirm',
        'continue',
        '是',
        '确认',
        '继续'
    ])
    const no = new Set([
        'n',
        'no',
        'cancel',
        'stop',
        '否',
        '不',
        '取消',
        '停止',
        '拒绝'
    ])
    if (yes.has(normalized)) {
        return { matched: true, value: true, label: input }
    }
    if (no.has(normalized)) {
        return { matched: true, value: false, label: input }
    }
    return {
        matched: false,
        error: `${action.prompt}\n请回复“确认/继续”或“取消”。`
    }
}

export function formatPendingAction(action: PendingAction) {
    if (action.type !== 'select' || !action.options?.length) {
        return action.prompt
    }
    return [
        action.prompt,
        ...action.options.map((item) => `${item.id}. ${item.label}`)
    ].join('\n')
}

function controlCandidates(raw: string, text: string) {
    const values = new Set<string>()
    for (const source of [raw, text]) {
        const trimmed = source?.trim()
        if (!trimmed) continue

        for (const match of trimmed.matchAll(
            /<nexus_session>\s*([\s\S]*?)\s*<\/nexus_session>/gi
        )) {
            values.add(match[1].trim())
        }
        for (const match of trimmed.matchAll(
            /```(?:json)?\s*([\s\S]*?)\s*```/gi
        )) {
            values.add(match[1].trim())
        }
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            values.add(trimmed)
        }
    }
    return Array.from(values)
}

function normalizeControl(value: any): AgentControl | undefined {
    if (!value || typeof value !== 'object') return undefined
    const rawStatus = String(value.status ?? '').toLowerCase()
    const status = normalizeStatus(rawStatus)
    if (!status) return undefined

    const pending = value.pendingAction ?? value.pending_action
    const options = normalizeOptions(
        pending?.options ?? value.options ?? value.choices ?? value.results
    )
    const prompt = firstString(
        pending?.prompt,
        value.prompt,
        value.question,
        value.message
    )

    let pendingAction: PendingAction | undefined
    if (status === 'waiting_confirm' || status === 'waiting_input') {
        const explicitType = String(pending?.type ?? value.actionType ?? '')
        const type =
            explicitType === 'select' || options.length
                ? 'select'
                : explicitType === 'confirm' || status === 'waiting_confirm'
                  ? 'confirm'
                  : 'input'
        pendingAction = {
            type,
            prompt: prompt || defaultPrompt(type),
            options: options.length ? options : undefined,
            data:
                pending?.data ??
                value.data ??
                value.state ??
                value.skillState ??
                value.skill_state
        }
    }

    return {
        status,
        prompt,
        pendingAction,
        data:
            value.data ??
            value.state ??
            value.skillState ??
            value.skill_state ??
            pending?.data,
        taskId: firstString(value.taskId, value.task_id, value.runId, value.run_id),
        output: firstString(value.output, value.result, value.content),
        error: firstString(value.error, value.reason)
    }
}

function normalizeStatus(value: string): NexusSessionStatus | undefined {
    if (value === 'waiting_selection' || value === 'waiting_select') {
        return 'waiting_confirm'
    }
    if (
        value === 'running' ||
        value === 'waiting_input' ||
        value === 'waiting_confirm' ||
        value === 'completed' ||
        value === 'failed'
    ) {
        return value
    }
    return undefined
}

function normalizeOptions(value: unknown): PendingActionOption[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((item, index) => {
        if (typeof item === 'string') {
            return [{ id: index + 1, label: item, value: item }]
        }
        if (!item || typeof item !== 'object') return []
        const option = item as Record<string, unknown>
        const rawId = Number(option.id ?? index + 1)
        const id = Number.isInteger(rawId) ? rawId : index + 1
        const label = firstString(
            option.label,
            option.title,
            option.name,
            option.text
        )
        if (!label) return []
        return [
            {
                id,
                label,
                value: option.value ?? structuredClone(option)
            }
        ]
    })
}

function firstString(...values: unknown[]) {
    return values.find(
        (value): value is string =>
            typeof value === 'string' && value.trim().length > 0
    )
}

function defaultPrompt(type: PendingAction['type']) {
    if (type === 'select') return '请选择一个选项：'
    if (type === 'confirm') return '请确认是否继续。'
    return '请提供继续任务所需的信息。'
}

function formatSelectionError(action: PendingAction) {
    const options = action.options ?? []
    if (!options.length) return action.prompt
    return [
        '无法识别你的选择，请回复选项编号或完整名称。',
        ...options.map((item) => `${item.id}. ${item.label}`)
    ].join('\n')
}
