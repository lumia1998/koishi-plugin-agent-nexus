import type {
    DelegationAgentStatus,
    GatewayProtocol,
    GatewayRemoteState,
    NexusStatus
} from '../src/types'
import type { DelegationJobView, DelegationState } from '../src/delegation/types'

export const PROTOCOL_LABEL: Record<GatewayProtocol, string> = {
    acp: 'ACP',
    a2a: 'A2A'
}

export const STATE_LABEL: Record<DelegationState, string> = {
    running: '执行中',
    input_required: '等待输入',
    permission_required: '等待授权',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消'
}

export const DELIVERY_LABEL: Record<DelegationJobView['deliveryState'], string> = {
    not_required: '无需回传',
    waiting: '待回传',
    delivered: '已回传',
    retrying: '回传重试中'
}

export function protocolLabel(protocol?: GatewayProtocol) {
    return protocol ? PROTOCOL_LABEL[protocol] : '未知'
}

export function agentStateLabel(row: DelegationAgentStatus) {
    if (!row.enabled) return '已停用'
    if (row.state === 'ready') return '可用'
    if (row.state === 'checking') return '检查中'
    if (row.state === 'error') return '异常'
    return '尚未检查'
}

export function stateType(state: DelegationState) {
    if (state === 'completed') return 'success'
    if (state === 'failed' || state === 'canceled') return 'danger'
    if (isWaiting(state)) return 'warning'
    return 'primary'
}

export function isWaiting(state: DelegationState) {
    return state === 'permission_required' || state === 'input_required'
}

export function isActive(state: DelegationState) {
    return state === 'running' || isWaiting(state)
}

export function needsAttention(agent: DelegationAgentStatus) {
    return agent.enabled && agent.state !== 'ready' && agent.state !== 'checking'
}

export function attentionAgents(status: NexusStatus) {
    return status.delegation.agents.filter(needsAttention)
}

export function activeJobCount(jobs: DelegationJobView[]) {
    return jobs.filter((job) => isActive(job.state)).length
}

export function shortId(value: string) {
    return value.length > 12 ? value.slice(0, 8) : value
}

export function formatDate(value?: number) {
    return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

export function formatClock(value?: number) {
    return value
        ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
        : '—'
}

export function elapsed(job: DelegationJobView, now = Date.now()) {
    const end = job.endedAt || now
    const seconds = Math.max(0, Math.floor((end - job.startedAt) / 1000))
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export function singleLine(value: string, limit: number, fromEnd = false) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= limit) return normalized
    return fromEnd ? `…${normalized.slice(-limit)}` : `${normalized.slice(0, limit)}…`
}

export function gatewayStateLabel(
    state: GatewayRemoteState,
    gatewayKeyConfigured: boolean
) {
    if (!gatewayKeyConfigured) return '等待 API Key'
    if (state === 'ready') return 'Gateway 在线'
    if (state === 'checking') return '正在检查'
    if (state === 'error') return '连接异常'
    return '尚未检查'
}
