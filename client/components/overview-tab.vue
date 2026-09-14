<template>
    <div class="overview">
        <section class="metrics" aria-label="运行概览">
            <article>
                <span>Gateway</span>
                <strong>{{ status.gateway.state === 'ready' ? '在线' : '离线' }}</strong>
                <small>{{ status.gateway.baseUrl }}</small>
            </article>
            <article>
                <span>发现 Agent</span>
                <strong>{{ status.gateway.agents.length }}</strong>
                <small>检查于 {{ formatClock(status.gateway.lastCheckedAt) }}</small>
            </article>
            <article>
                <span>可用 Agent</span>
                <strong>{{ readyCount }}</strong>
                <small v-if="attention.length" class="alert">
                    {{ attention.length }} 个异常
                </small>
            </article>
            <article>
                <span>ChatLuna 工具</span>
                <strong>{{ toolCount }}</strong>
                <small v-if="disabledCount" class="alert">{{ disabledCount }} 个已停用</small>
            </article>
        </section>

        <section v-if="!gatewayKeyConfigured" class="setup-notice">
            <span class="notice-index">未配置</span>
            <div>
                <strong>在 Koishi 插件设置中填写 Gateway API Key</strong>
                <p>需要的是 Gateway 的 API Key，不是 Gateway 控制台的登录密码。</p>
            </div>
        </section>

        <section v-if="status.gateway.error" class="error-banner">
            {{ status.gateway.error }}
        </section>

        <section v-if="attention.length" class="panel">
            <div class="panel-head">
                <h2>需要关注</h2>
                <button class="link" type="button" @click="emit('goto', 'agents')">
                    查看智能体
                </button>
            </div>
            <div class="rows">
                <button
                    v-for="agent in attention"
                    :key="agent.agentId"
                    class="row"
                    type="button"
                    @click="emit('goto', 'agents')"
                >
                    <span class="row-main">
                        <strong>{{ agent.name }}</strong>
                        <code>{{ agent.agentId }}</code>
                    </span>
                    <span class="row-state">
                        <i class="dot" :class="agent.state" />
                        {{ agentStateLabel(agent) }}
                    </span>
                    <span class="row-error">{{ agent.error || '尚未就绪' }}</span>
                </button>
            </div>
        </section>

        <section class="panel">
            <div class="panel-head">
                <h2>运行统计</h2>
                <span class="muted">{{ jobsLoaded ? `共 ${jobs.length} 条记录` : '读取中…' }}</span>
            </div>
            <div class="stat-grid">
                <div v-for="stat in stats" :key="stat.label" class="stat">
                    <span>{{ stat.label }}</span>
                    <strong :class="{ alert: stat.alert }">{{ stat.value }}</strong>
                </div>
            </div>
        </section>

        <section class="panel">
            <div class="panel-head">
                <h2>失败与等待处理</h2>
                <button class="link" type="button" @click="emit('goto', 'tasks')">
                    查看任务
                </button>
            </div>
            <div v-if="recent.length" class="rows">
                <button
                    v-for="job in recent"
                    :key="job.id"
                    class="row"
                    type="button"
                    @click="emit('goto', 'tasks')"
                >
                    <span class="row-main">
                        <strong>{{ job.agentName }}</strong>
                        <code>{{ shortId(job.id) }}</code>
                    </span>
                    <span class="row-state">
                        <i class="dot" :class="job.state" />
                        {{ STATE_LABEL[job.state] }}
                    </span>
                    <span class="row-error">{{ job.pendingRequest?.prompt || job.error || job.pollError || singleLine(job.prompt, 90) }}</span>
                </button>
            </div>
            <p v-else class="panel-note">
                {{ jobsLoaded ? '没有失败或等待处理的任务。' : '正在读取任务…' }}
            </p>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
    STATE_LABEL,
    agentStateLabel,
    attentionAgents,
    formatClock,
    isWaiting,
    shortId,
    singleLine
} from '../shared'
import type { NexusStatus } from '../../src/types'
import type { DelegationJobView } from '../../src/delegation/types'

const props = defineProps<{
    status: NexusStatus
    gatewayKeyConfigured: boolean
    jobs: DelegationJobView[]
    jobsLoaded: boolean
}>()

const emit = defineEmits<{
    (
        event: 'goto',
        tab: 'overview' | 'agents' | 'tasks' | 'artifacts' | 'settings'
    ): void
}>()

const attention = computed(() => attentionAgents(props.status))

const readyCount = computed(
    () => props.status.gateway.agents.filter((agent) => agent.ready).length
)

const toolCount = computed(
    () =>
        props.status.delegation.agents.filter(
            (agent) => agent.enabled && agent.toolName
        ).length
)

const disabledCount = computed(
    () => props.status.delegation.agents.filter((agent) => !agent.enabled).length
)

const stats = computed(() => {
    const count = (match: (job: DelegationJobView) => boolean) =>
        props.jobs.filter(match).length
    return [
        { label: '执行中', value: count((job) => job.state === 'running') },
        { label: '等待交互', value: count((job) => isWaiting(job.state)) },
        { label: '已完成', value: count((job) => job.state === 'completed') },
        {
            label: '失败 / 取消',
            value: count(
                (job) => job.state === 'failed' || job.state === 'canceled'
            ),
            alert: true
        },
        {
            label: '后台任务',
            value: count((job) => job.background)
        },
        {
            label: '回传重试中',
            value: count((job) => job.deliveryState === 'retrying'),
            alert: true
        }
    ]
})

const recent = computed(() =>
    props.jobs
        .filter(
            (job) =>
                isWaiting(job.state) ||
                job.state === 'failed' ||
                job.state === 'canceled'
        )
        .slice(0, 5)
)
</script>

<style scoped>
.overview {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 18px;
}

.metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid var(--nexus-line);
    background: var(--nexus-line);
}

.metrics article {
    display: grid;
    min-width: 0;
    padding: 16px 18px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 30%);
}

.metrics span {
    color: var(--k-text-light);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.metrics strong {
    margin-top: 9px;
    color: var(--nexus-ink);
    font-size: 27px;
    line-height: 1;
}

.metrics small {
    margin-top: 8px;
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.metrics small.alert {
    color: #b7790c;
}

.setup-notice {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 18px;
    align-items: start;
    padding: 16px 18px;
    border: 1px solid color-mix(in srgb, #d99b2b, transparent 52%);
    background: color-mix(in srgb, #d99b2b, transparent 93%);
}

.notice-index {
    color: #b7790c;
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
}

.setup-notice strong {
    color: var(--nexus-ink);
    font-size: 13px;
}

.setup-notice p {
    margin: 5px 0 0;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.6;
}

.error-banner {
    padding: 12px 16px;
    border: 1px solid color-mix(in srgb, #d65757, transparent 52%);
    background: color-mix(in srgb, #d65757, transparent 94%);
    color: #c84f4f;
    font-size: 12px;
    overflow-wrap: anywhere;
}

.panel {
    min-width: 0;
    border: 1px solid var(--nexus-line);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 38%);
}

.panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--nexus-line);
}

.panel-head h2 {
    margin: 0;
    color: var(--nexus-ink);
    font-size: 14px;
}

.muted {
    color: var(--k-text-light);
    font-size: 11px;
}

.link {
    border: 0;
    background: transparent;
    color: var(--k-color-primary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
}

.link:hover {
    text-decoration: underline;
}

.rows {
    display: flex;
    flex-direction: column;
}

.row {
    display: grid;
    grid-template-columns: minmax(0, 220px) 130px minmax(0, 1fr);
    gap: 16px;
    align-items: center;
    padding: 12px 18px;
    border: 0;
    border-bottom: 1px solid var(--nexus-line);
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
}

.row:last-child {
    border-bottom: 0;
}

.row:hover {
    background: color-mix(in srgb, var(--k-color-primary), transparent 95%);
}

.row-main {
    display: grid;
    min-width: 0;
    gap: 3px;
}

.row-main strong {
    color: var(--nexus-ink);
    font-size: 13px;
}

.row-main code {
    color: var(--k-text-light);
    font-size: 11px;
}

.row-state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--k-text-dark);
    font-size: 12px;
}

.dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: #8b949e;
}

.dot.ready,
.dot.completed {
    background: #1fa66b;
}

.dot.checking,
.dot.permission_required,
.dot.input_required {
    background: #d99b2b;
}

.dot.error,
.dot.failed,
.dot.canceled {
    background: #d65757;
}

.dot.running {
    background: var(--k-color-primary);
}

.row-error {
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.stat-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 1px;
    background: var(--nexus-line);
}

.stat {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 16px;
    background: var(--k-page-bg);
}

.stat span {
    color: var(--k-text-light);
    font-size: 12px;
}

.stat strong {
    color: var(--nexus-ink);
}

.stat strong.alert {
    color: #c84f4f;
}

.panel-note {
    margin: 0;
    padding: 26px 18px;
    color: var(--k-text-light);
    font-size: 12px;
    text-align: center;
}

@media (max-width: 1040px) {
    .stat-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .row {
        grid-template-columns: minmax(0, 1fr) auto;
    }

    .row-error {
        grid-column: 1 / -1;
        white-space: normal;
    }
}

@media (max-width: 900px) {
    .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 680px) {
    .setup-notice {
        grid-template-columns: 1fr;
        gap: 8px;
    }

    .stat-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .row {
        grid-template-columns: 1fr;
        gap: 6px;
    }
}
</style>
