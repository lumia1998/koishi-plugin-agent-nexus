<template>
    <section class="tasks">
        <div class="panel-head">
            <div class="task-metrics">
                <article>
                    <span>当前运行</span>
                    <strong>{{ counts.active }}</strong>
                </article>
                <article>
                    <span>等待交互</span>
                    <strong>{{ counts.waiting }}</strong>
                </article>
                <article>
                    <span>已完成</span>
                    <strong>{{ counts.completed }}</strong>
                </article>
                <article>
                    <span>失败 / 取消</span>
                    <strong>{{ counts.failed }}</strong>
                </article>
            </div>
            <div class="panel-actions">
                <el-button
                    size="small"
                    type="danger"
                    plain
                    :disabled="!clearableCount"
                    :loading="clearing"
                    @click="clearFinishedJobs"
                >
                    清空已结束记录
                </el-button>
                <el-button size="small" :loading="loading" @click="emit('refresh')">
                    刷新任务
                </el-button>
            </div>
        </div>

        <div class="filters">
            <el-input
                v-model="search"
                clearable
                placeholder="搜索任务、Agent、Job / Run / Session ID"
            />
            <el-select v-model="stateFilter" placeholder="全部状态">
                <el-option label="全部状态" value="all" />
                <el-option label="执行中" value="running" />
                <el-option label="等待交互" value="waiting" />
                <el-option label="已完成" value="completed" />
                <el-option label="失败 / 取消" value="failed" />
            </el-select>
        </div>

        <div v-if="error && !loaded" class="load-error">
            <strong>任务列表读取失败</strong>
            <span>{{ error }}</span>
            <el-button size="small" @click="emit('refresh')">重试</el-button>
        </div>

        <div v-else v-loading="loading && !loaded" class="task-list">
            <button
                v-for="job in filteredJobs"
                :key="job.id"
                class="task-row"
                type="button"
                @click="openDetail(job)"
            >
                <span class="task-main">
                    <span class="title-line">
                        <strong>{{ job.agentName }}</strong>
                        <el-tag size="small" effect="plain" :type="stateType(job.state)">
                            {{ STATE_LABEL[job.state] }}
                        </el-tag>
                        <el-tag size="small" effect="plain">
                            {{ job.background ? '后台' : '前台' }}
                        </el-tag>
                        <el-tag
                            v-if="job.deliveryState === 'retrying'"
                            size="small"
                            effect="plain"
                            type="danger"
                        >
                            回传重试中
                        </el-tag>
                    </span>
                    <span class="prompt">{{ job.prompt || '（无任务内容）' }}</span>
                    <span v-if="job.pendingRequest" class="pending">
                        {{ job.pendingRequest.kind === 'permission' ? '等待授权：' : '等待输入：' }}
                        {{ job.pendingRequest.prompt }}
                    </span>
                    <span v-else-if="job.pollError" class="error-line">{{ job.pollError }}</span>
                    <span v-else-if="job.output" class="progress">
                        {{ singleLine(job.output, 180, true) }}
                    </span>
                    <span class="id-line">
                        <code>JOB {{ shortId(job.id) }}</code>
                        <code v-if="job.gatewayRunId">RUN {{ shortId(job.gatewayRunId) }}</code>
                        <code v-if="job.gatewaySessionId">
                            SESSION {{ shortId(job.gatewaySessionId) }}
                        </code>
                    </span>
                </span>
                <span class="task-meta">
                    <span>{{ elapsed(job, now) }}</span>
                    <span>{{ formatDate(job.updatedAt) }}</span>
                    <span>{{ DELIVERY_LABEL[job.deliveryState] }}</span>
                </span>
            </button>

            <div v-if="loaded && !filteredJobs.length" class="empty">
                {{ jobs.length ? '没有符合条件的任务。' : '暂无委派任务记录。' }}
            </div>
        </div>

        <el-dialog
            v-model="detailVisible"
            width="min(900px, 94vw)"
            destroy-on-close
            :title="detail ? `${detail.agentName} · 任务详情` : '任务详情'"
        >
            <div v-if="detail" class="detail">
                <div class="detail-head">
                    <el-tag size="small" effect="plain" :type="stateType(detail.state)">
                        {{ STATE_LABEL[detail.state] }}
                    </el-tag>
                    <span>{{ detail.background ? '后台任务' : '前台任务' }}</span>
                    <span>{{ detail.protocol?.toUpperCase() || 'Gateway' }}</span>
                    <span>{{ elapsed(detail, now) }}</span>
                </div>

                <div class="id-grid">
                    <div>
                        <span>Koishi Job ID</span>
                        <code>{{ detail.id }}</code>
                    </div>
                    <div>
                        <span>Gateway Run ID</span>
                        <code>{{ detail.gatewayRunId || '尚未返回' }}</code>
                    </div>
                    <div>
                        <span>Gateway Session ID</span>
                        <code>{{ detail.gatewaySessionId || '尚未返回' }}</code>
                    </div>
                    <div>
                        <span>协议 Session ID</span>
                        <code>{{ detail.protocolSessionId || '尚未返回' }}</code>
                    </div>
                </div>

                <section class="detail-section">
                    <h3>原始任务</h3>
                    <pre>{{ detail.prompt }}</pre>
                </section>

                <section v-if="detail.pendingRequest" class="detail-section pending-box">
                    <h3>
                        {{ detail.pendingRequest.kind === 'permission' ? '等待授权' : '等待输入' }}
                    </h3>
                    <pre>{{ detail.pendingRequest.prompt }}</pre>
                    <ol v-if="detail.pendingRequest.options?.length">
                        <li v-for="option in detail.pendingRequest.options" :key="option.id">
                            {{ option.name }} <code>{{ option.id }}</code>
                        </li>
                    </ol>
                </section>

                <section v-if="detail.output" class="detail-section">
                    <h3>当前输出 / 最终结果</h3>
                    <pre>{{ detail.output }}</pre>
                </section>

                <section v-if="detail.error || detail.pollError" class="detail-section error-box">
                    <h3>错误与监控状态</h3>
                    <pre>{{ [detail.error, detail.pollError].filter(Boolean).join('\n\n') }}</pre>
                </section>

                <section v-if="detail.artifacts.length" class="detail-section">
                    <h3>产物</h3>
                    <ul class="artifacts">
                        <li v-for="artifact in detail.artifacts" :key="artifact.id || artifact.name">
                            <a
                                v-if="artifact.url"
                                :href="artifact.url"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {{ artifact.name }}
                            </a>
                            <span v-else>{{ artifact.name }}</span>
                            <small>{{ artifact.mediaType || '' }}</small>
                        </li>
                    </ul>
                </section>

                <div class="delivery-box">
                    <strong>主动回传：{{ DELIVERY_LABEL[detail.deliveryState] }}</strong>
                    <span v-if="detail.notificationAttempts">
                        已重试 {{ detail.notificationAttempts }} 次
                    </span>
                    <span v-if="detail.notificationNextAt">
                        下次尝试 {{ formatDate(detail.notificationNextAt) }}
                    </span>
                    <span v-if="detail.queuedMessageCount">
                        排队中的续接消息 {{ detail.queuedMessageCount }} 条
                    </span>
                </div>

                <div v-if="isActive(detail.state)" class="detail-actions">
                    <el-button
                        size="small"
                        type="danger"
                        :loading="stoppingJobId === detail.id"
                        @click="cancelJob(detail)"
                    >
                        中断任务
                    </el-button>
                </div>
            </div>
        </el-dialog>
    </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
    DELIVERY_LABEL,
    STATE_LABEL,
    elapsed,
    formatDate,
    isActive,
    isWaiting,
    shortId,
    singleLine,
    stateType
} from '../shared'
import type { DelegationJobView, DelegationState } from '../../src/delegation/types'

const props = defineProps<{
    jobs: DelegationJobView[]
    loading: boolean
    loaded: boolean
    error?: string
}>()

const emit = defineEmits<{
    (event: 'refresh'): void
    (event: 'cleared'): void
}>()

const search = ref('')
const stateFilter = ref('all')
const detailVisible = ref(false)
const detailId = ref<string>()
const clearing = ref(false)
const stoppingJobId = ref<string>()
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | undefined

const detail = computed(() =>
    props.jobs.find((job) => job.id === detailId.value)
)

const counts = computed(() => ({
    active: props.jobs.filter((job) => job.state === 'running').length,
    waiting: props.jobs.filter((job) => isWaiting(job.state)).length,
    completed: props.jobs.filter((job) => job.state === 'completed').length,
    failed: props.jobs.filter(
        (job) => job.state === 'failed' || job.state === 'canceled'
    ).length
}))

const clearableCount = computed(
    () =>
        props.jobs.filter((job) => !isActive(job.state) && !job.queuedMessageCount)
            .length
)

const filteredJobs = computed(() => {
    const query = search.value.trim().toLowerCase()
    return props.jobs.filter((job) => {
        if (!matchesState(job.state, stateFilter.value)) return false
        if (!query) return true
        return [
            job.id,
            job.agentId,
            job.agentName,
            job.prompt,
            job.output,
            job.gatewayRunId,
            job.gatewaySessionId,
            job.protocolSessionId
        ].some((value) => value?.toLowerCase().includes(query))
    })
})

function openDetail(job: DelegationJobView) {
    detailId.value = job.id
    detailVisible.value = true
}

async function clearFinishedJobs() {
    if (!clearableCount.value) return
    try {
        await ElMessageBox.confirm(
            '将清除所有已结束的任务记录，运行中和等待授权的任务不受影响。',
            '清空已结束记录',
            {
                type: 'warning',
                confirmButtonText: '清空记录',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }
    clearing.value = true
    try {
        const removed = await send('agent-nexus/clearTerminalDelegationJobs')
        detailVisible.value = false
        detailId.value = undefined
        emit('cleared')
        ElMessage.success(`已清除 ${removed} 条任务记录。`)
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        clearing.value = false
    }
}

async function cancelJob(job: DelegationJobView) {
    try {
        await ElMessageBox.confirm(
            `确定要中断 ${job.agentName} 的这个任务吗？`,
            '中断任务',
            {
                type: 'warning',
                confirmButtonText: '中断任务',
                cancelButtonText: '保留任务'
            }
        )
    } catch {
        return
    }
    stoppingJobId.value = job.id
    try {
        await send('agent-nexus/cancelDelegationJob', job.id)
        emit('refresh')
        ElMessage.success('已向 Gateway 发送中断请求。')
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        stoppingJobId.value = undefined
    }
}

function matchesState(state: DelegationState, filter: string) {
    if (filter === 'all') return true
    if (filter === 'waiting') return isWaiting(state)
    if (filter === 'failed') return state === 'failed' || state === 'canceled'
    return state === filter
}

watch(
    () => props.jobs,
    (jobs) => {
        if (detailId.value && !jobs.some((job) => job.id === detailId.value)) {
            detailVisible.value = false
            detailId.value = undefined
        }
    }
)

onMounted(() => {
    clockTimer = setInterval(() => {
        now.value = Date.now()
    }, 1000)
})

onBeforeUnmount(() => {
    if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
.tasks {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 12px;
}

.panel-head,
.panel-actions,
.title-line,
.filters,
.detail-head,
.delivery-box,
.detail-actions {
    display: flex;
    align-items: center;
}

.panel-head {
    justify-content: space-between;
    gap: 20px;
}

.panel-actions {
    gap: 8px;
}

.task-metrics {
    display: grid;
    flex: 1;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--nexus-line);
}

.task-metrics article {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-right: 1px solid var(--nexus-line);
}

.task-metrics article:last-child {
    border-right: 0;
}

.task-metrics span {
    color: var(--k-text-light);
    font-size: 12px;
}

.task-metrics strong {
    color: var(--nexus-ink);
}

.filters {
    gap: 10px;
}

.filters :deep(.el-input) {
    max-width: 520px;
}

.filters :deep(.el-select) {
    width: 160px;
}

.load-error {
    display: flex;
    min-height: 180px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 10px;
    border: 1px solid color-mix(in srgb, #d65757, transparent 60%);
    color: var(--k-text-light);
    font-size: 12px;
    text-align: center;
    padding: 20px;
}

.load-error strong {
    color: #c84f4f;
    font-size: 13px;
}

.load-error span {
    max-width: 640px;
    overflow-wrap: anywhere;
}

.task-list {
    min-height: 180px;
    overflow: hidden;
    border: 1px solid var(--nexus-line);
}

.task-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    width: 100%;
    gap: 20px;
    padding: 15px 16px;
    border: 0;
    border-bottom: 1px solid var(--nexus-line);
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
}

.task-row:last-child {
    border-bottom: 0;
}

.task-row:hover {
    background: color-mix(in srgb, var(--k-color-primary), transparent 95%);
}

.task-main {
    display: block;
    min-width: 0;
}

.title-line {
    flex-wrap: wrap;
    gap: 8px;
}

.title-line strong {
    color: var(--nexus-ink);
}

.prompt,
.progress,
.pending,
.error-line {
    display: -webkit-box;
    margin: 7px 0 0;
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.55;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
}

.progress {
    color: color-mix(in srgb, var(--nexus-ink), transparent 22%);
}

.pending {
    color: #b7790c;
}

.error-line {
    color: #c84f4f;
}

.id-line {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
}

.id-line code {
    padding: 2px 5px;
    background: color-mix(in srgb, var(--k-color-divider), transparent 58%);
    color: var(--k-text-light);
    font-size: 9px;
}

.task-meta {
    display: flex;
    min-width: 136px;
    justify-content: center;
    align-items: flex-end;
    flex-direction: column;
    gap: 5px;
    color: var(--k-text-light);
    font-size: 11px;
    white-space: nowrap;
}

.empty {
    padding: 58px 20px;
    color: var(--k-text-light);
    text-align: center;
}

.detail-head {
    gap: 10px;
    margin-bottom: 14px;
    color: var(--k-text-light);
    font-size: 12px;
    flex-wrap: wrap;
}

.id-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid var(--nexus-line);
    background: var(--nexus-line);
}

.id-grid div {
    display: grid;
    gap: 6px;
    min-width: 0;
    padding: 11px 12px;
    background: var(--k-side-bg);
}

.id-grid span {
    color: var(--k-text-light);
    font-size: 10px;
}

.id-grid code {
    overflow: hidden;
    color: var(--nexus-ink);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.detail-section {
    margin-top: 16px;
}

.detail-section h3 {
    margin: 0 0 7px;
    color: var(--nexus-ink);
    font-size: 12px;
}

.detail-section pre {
    max-height: 34vh;
    margin: 0;
    padding: 12px 13px;
    overflow: auto;
    border: 1px solid var(--nexus-line);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 28%);
    color: var(--nexus-ink);
    font: inherit;
    font-size: 12px;
    line-height: 1.65;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
}

.pending-box pre {
    border-color: color-mix(in srgb, #d99b2b, transparent 48%);
    background: color-mix(in srgb, #d99b2b, transparent 94%);
}

.error-box pre {
    border-color: color-mix(in srgb, #d65757, transparent 55%);
}

.pending-box ol,
.artifacts {
    margin: 9px 0 0;
    padding-left: 22px;
    color: var(--k-text-light);
    font-size: 12px;
}

.artifacts li {
    margin: 5px 0;
}

.artifacts small {
    margin-left: 8px;
    color: var(--k-text-light);
}

.delivery-box {
    gap: 10px 16px;
    margin-top: 17px;
    padding: 11px 12px;
    border-left: 3px solid var(--k-color-primary);
    background: color-mix(in srgb, var(--k-color-primary), transparent 95%);
    color: var(--k-text-light);
    font-size: 11px;
    flex-wrap: wrap;
}

.delivery-box strong {
    color: var(--nexus-ink);
}

.detail-actions {
    justify-content: space-between;
    gap: 12px;
    margin-top: 17px;
    padding-top: 14px;
    border-top: 1px solid var(--nexus-line);
    color: var(--k-text-light);
    font-size: 11px;
}

@media (max-width: 760px) {
    .panel-head,
    .panel-actions,
    .filters {
        align-items: stretch;
        flex-direction: column;
    }

    .task-metrics,
    .id-grid {
        grid-template-columns: 1fr;
    }

    .task-metrics article {
        border-right: 0;
        border-bottom: 1px solid var(--nexus-line);
    }

    .task-metrics article:last-child {
        border-bottom: 0;
    }

    .filters :deep(.el-input),
    .filters :deep(.el-select) {
        width: 100%;
        max-width: none;
    }

    .task-row {
        grid-template-columns: 1fr;
    }

    .task-meta {
        align-items: flex-start;
        flex-direction: row;
        flex-wrap: wrap;
    }
}
</style>
