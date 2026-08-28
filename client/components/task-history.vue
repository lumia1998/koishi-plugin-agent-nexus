<template>
    <section class="history-surface">
        <div class="history-head">
            <div>
                <span class="section-kicker">OBSERVABILITY · LOCAL STORE</span>
                <h2>任务与调用记录</h2>
                <p>这里展示本插件发起的 AgentNexus 委派任务；记录保存在 Koishi 的 agent-nexus 数据目录中。</p>
            </div>
            <div class="history-actions">
                <el-input
                    v-model="query"
                    class="query-input"
                    clearable
                    placeholder="搜索 Agent、任务 ID 或提示词"
                />
                <el-select v-model="stateFilter" class="state-select" aria-label="任务状态">
                    <el-option label="全部状态" value="all" />
                    <el-option label="运行中" value="running" />
                    <el-option label="等待输入" value="input_required" />
                    <el-option label="等待权限" value="permission_required" />
                    <el-option label="已完成" value="completed" />
                    <el-option label="失败" value="failed" />
                    <el-option label="已取消" value="canceled" />
                </el-select>
                <el-button plain :loading="loading" @click="emit('refresh')">刷新</el-button>
            </div>
        </div>

        <div class="history-meta">
            <span>共 {{ jobs.length }} 条</span>
            <span v-if="query || stateFilter !== 'all'">当前显示 {{ filteredJobs.length }} 条</span>
            <span class="meta-hint">点击记录查看完整输入、输出和产物</span>
        </div>

        <div v-if="!filteredJobs.length" class="history-empty">
            <strong>{{ jobs.length ? '没有匹配的任务' : '暂时没有任务记录' }}</strong>
            <span>{{ jobs.length ? '调整搜索条件或状态筛选。' : '当 ChatLuna 调用 Nexus Agent 后，任务会自动出现在这里。' }}</span>
        </div>

        <div v-else class="task-list">
            <article
                v-for="job in filteredJobs"
                :key="job.id"
                class="task-row"
                tabindex="0"
                @click="openDetail(job.id)"
                @keydown.enter="openDetail(job.id)"
                @keydown.space.prevent="openDetail(job.id)"
            >
                <div class="task-main">
                    <div class="task-title-line">
                        <strong>{{ job.agentName }}</strong>
                        <span class="state-badge" :class="job.state">{{ stateLabel(job.state) }}</span>
                        <span v-if="job.background" class="background-badge">后台</span>
                    </div>
                    <code>{{ job.id }}</code>
                    <p>{{ job.promptPreview }}</p>
                </div>
                <div class="task-route">
                    <span>TOOL</span>
                    <code>{{ job.toolName || 'nexus_agent' }}</code>
                    <small>{{ job.remoteState || '—' }}</small>
                </div>
                <div class="task-time">
                    <span>更新时间</span>
                    <strong>{{ formatDate(job.updatedAt) }}</strong>
                    <small>耗时 {{ duration(job) }}</small>
                </div>
                <div class="task-artifacts">
                    <span>产物</span>
                    <strong>{{ job.artifactCount ? `${job.artifactCount} 个` : '—' }}</strong>
                    <small>{{ job.outputPreview || '暂无输出摘要' }}</small>
                </div>
            </article>
        </div>
    </section>

    <el-dialog
        v-model="dialogVisible"
        title="任务详情"
        width="min(94vw, 780px)"
        destroy-on-close
    >
        <div v-if="detailLoading" class="detail-loading">正在读取任务详情…</div>
        <div v-else-if="detail" class="detail-content">
            <div class="detail-summary">
                <div>
                    <span class="section-kicker">{{ detail.agentName }}</span>
                    <h3>{{ stateLabel(detail.state) }} · {{ detail.background ? '后台任务' : '前台任务' }}</h3>
                </div>
                <code>{{ detail.id }}</code>
            </div>

            <div class="detail-facts">
                <span>工具 <strong>{{ detail.toolName || 'nexus_agent' }}</strong></span>
                <span>创建 <strong>{{ formatDate(detail.createdAt) }}</strong></span>
                <span>耗时 <strong>{{ duration(detail) }}</strong></span>
            </div>

            <div class="detail-block">
                <span class="detail-label">PROMPT</span>
                <pre>{{ detail.prompt }}</pre>
            </div>
            <div v-if="detail.output" class="detail-block">
                <span class="detail-label">OUTPUT</span>
                <pre>{{ detail.output }}</pre>
            </div>
            <div v-if="detail.error || detail.pollError" class="detail-block error-block">
                <span class="detail-label">ERROR</span>
                <pre>{{ [detail.error, detail.pollError].filter(Boolean).join('\n') }}</pre>
            </div>

            <div v-if="detail.artifacts.length" class="detail-block">
                <span class="detail-label">ARTIFACTS · {{ detail.artifacts.length }}</span>
                <div class="artifact-list">
                    <div v-for="artifact in detail.artifacts" :key="artifact.artifactId || artifact.name" class="artifact-row">
                        <div>
                            <strong>{{ artifact.name }}</strong>
                            <small>{{ artifact.mediaType || artifact.filename || '文件产物' }}</small>
                        </div>
                        <a v-if="artifact.url" :href="artifact.url" target="_blank" rel="noreferrer">打开附件</a>
                        <span v-else>{{ artifact.preview || '无预览' }}</span>
                    </div>
                </div>
            </div>
        </div>
        <el-empty v-else description="任务不存在或已被清理" />
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import type { NexusTaskDetail, NexusTaskState, NexusTaskSummary } from '../../src/types'

const props = withDefaults(
    defineProps<{
        jobs: NexusTaskSummary[]
        loading?: boolean
    }>(),
    { loading: false }
)
const emit = defineEmits<{ refresh: [] }>()

const query = ref('')
const stateFilter = ref<NexusTaskState | 'all'>('all')
const dialogVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<NexusTaskDetail>()

const filteredJobs = computed(() => {
    const normalized = query.value.trim().toLowerCase()
    return props.jobs.filter((job) => {
        if (stateFilter.value !== 'all' && job.state !== stateFilter.value) return false
        if (!normalized) return true
        return [job.id, job.agentId, job.agentName, job.toolName, job.promptPreview]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(normalized))
    })
})

async function openDetail(id: string) {
    dialogVisible.value = true
    detailLoading.value = true
    detail.value = undefined
    try {
        detail.value = await send('agent-nexus/getDelegationJob', id)
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
        dialogVisible.value = false
    } finally {
        detailLoading.value = false
    }
}

function stateLabel(state: NexusTaskState) {
    return {
        running: '运行中',
        input_required: '等待输入',
        permission_required: '等待权限',
        completed: '已完成',
        failed: '失败',
        canceled: '已取消'
    }[state]
}

function formatDate(value: number) {
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(value)
}

function duration(job: NexusTaskSummary | NexusTaskDetail) {
    const end = job.endedAt || job.updatedAt
    const seconds = Math.max(0, Math.round((end - job.startedAt) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m ${seconds % 60}s`
}
</script>

<style scoped>
.history-surface {
    min-width: 0;
    padding: 21px;
    border: 1px solid var(--nexus-line);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 38%);
}

.history-head,
.task-title-line,
.detail-summary,
.history-meta,
.history-actions,
.detail-facts,
.artifact-row {
    display: flex;
    align-items: center;
}

.history-head {
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
}

.section-kicker,
.detail-label,
.history-meta,
.task-route > span,
.task-time > span,
.task-artifacts > span {
    color: var(--k-color-primary);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.history-head h2 {
    margin: 5px 0 4px;
    color: var(--nexus-ink);
    font-size: 19px;
}

.history-head p {
    max-width: 680px;
    margin: 0;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.6;
}

.history-actions {
    flex: 0 0 auto;
    gap: 8px;
}

.query-input {
    width: 230px;
}

.state-select {
    width: 120px;
}

.history-meta {
    gap: 15px;
    padding: 10px 13px;
    border-top: 1px solid var(--nexus-line);
    border-bottom: 1px solid var(--nexus-line);
    color: var(--k-text-light);
    letter-spacing: 0.03em;
}

.meta-hint {
    margin-left: auto;
    letter-spacing: 0;
    text-transform: none;
}

.task-list {
    display: grid;
}

.task-row {
    display: grid;
    grid-template-columns: minmax(230px, 2.2fr) minmax(130px, 1fr) minmax(125px, 0.9fr) minmax(150px, 1.2fr);
    gap: 18px;
    align-items: center;
    padding: 16px 13px;
    border-bottom: 1px solid var(--nexus-line);
    cursor: pointer;
    outline: none;
    transition: background 0.16s ease, transform 0.16s ease;
}

.task-row:hover,
.task-row:focus-visible {
    background: color-mix(in srgb, var(--k-color-primary), transparent 94%);
}

.task-row:focus-visible {
    box-shadow: inset 2px 0 var(--k-color-primary);
}

.task-main,
.task-route,
.task-time,
.task-artifacts {
    min-width: 0;
}

.task-title-line {
    flex-wrap: wrap;
    gap: 7px;
}

.task-title-line strong {
    overflow: hidden;
    color: var(--nexus-ink);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.task-main code,
.task-route code,
.detail-summary code {
    display: block;
    overflow: hidden;
    margin-top: 5px;
    color: var(--k-text-light);
    font-family: 'Cascadia Mono', monospace;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.task-main p,
.task-artifacts small {
    display: -webkit-box;
    overflow: hidden;
    margin: 7px 0 0;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.5;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
}

.state-badge,
.background-badge {
    padding: 3px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--k-text-light), transparent 90%);
    color: var(--k-text-light);
    font-size: 10px;
}

.state-badge.running { color: #b7790c; background: color-mix(in srgb, #d99b2b, transparent 88%); }
.state-badge.completed { color: #16835a; background: color-mix(in srgb, #1fa66b, transparent 88%); }
.state-badge.failed { color: #c44747; background: color-mix(in srgb, #d65757, transparent 88%); }
.state-badge.input_required,
.state-badge.permission_required { color: #7663bd; background: color-mix(in srgb, #7663bd, transparent 89%); }

.task-route,
.task-time,
.task-artifacts {
    display: grid;
    gap: 5px;
}

.task-route code {
    margin: 0;
    color: var(--nexus-ink);
}

.task-route small,
.task-time small {
    color: var(--k-text-light);
    font-size: 11px;
}

.task-time strong,
.task-artifacts strong {
    color: var(--nexus-ink);
    font-size: 12px;
}

.history-empty {
    display: grid;
    min-height: 150px;
    place-content: center;
    gap: 8px;
    text-align: center;
}

.history-empty strong,
.history-empty span {
    color: var(--k-text-light);
}

.history-empty strong { color: var(--nexus-ink); }

.detail-content {
    color: var(--nexus-ink);
}

.detail-summary {
    justify-content: space-between;
    gap: 18px;
}

.detail-summary h3 {
    margin: 5px 0 0;
    font-size: 18px;
}

.detail-summary code {
    max-width: 42%;
    margin-top: 0;
}

.detail-facts {
    flex-wrap: wrap;
    gap: 8px 22px;
    margin-top: 18px;
    padding: 11px 0;
    border-top: 1px solid var(--nexus-line);
    border-bottom: 1px solid var(--nexus-line);
    color: var(--k-text-light);
    font-size: 12px;
}

.detail-facts strong { color: var(--nexus-ink); font-weight: 600; }

.detail-block {
    margin-top: 19px;
}

.detail-block pre {
    max-height: 270px;
    overflow: auto;
    margin: 8px 0 0;
    padding: 12px;
    border: 1px solid var(--nexus-line);
    background: color-mix(in srgb, var(--k-page-bg), transparent 25%);
    color: var(--nexus-ink);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 12px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
}

.error-block pre { color: #c44747; }

.artifact-list {
    display: grid;
    margin-top: 8px;
    border: 1px solid var(--nexus-line);
}

.artifact-row {
    justify-content: space-between;
    gap: 14px;
    padding: 11px 12px;
    border-bottom: 1px solid var(--nexus-line);
}

.artifact-row:last-child { border-bottom: 0; }

.artifact-row div { min-width: 0; }
.artifact-row strong,
.artifact-row small { display: block; }
.artifact-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifact-row small,
.artifact-row > span { margin-top: 4px; color: var(--k-text-light); font-size: 11px; }
.artifact-row a { flex: 0 0 auto; color: var(--k-color-primary); font-size: 12px; }
.detail-loading { padding: 42px 0; color: var(--k-text-light); text-align: center; }

@media (max-width: 940px) {
    .history-head { align-items: flex-start; flex-direction: column; }
    .history-actions { width: 100%; }
    .query-input { flex: 1; width: auto; }
}

@media (max-width: 720px) {
    .history-surface { padding: 16px 13px; }
    .history-actions { align-items: stretch; flex-wrap: wrap; }
    .query-input { flex-basis: 100%; }
    .state-select { flex: 1; width: auto; }
    .meta-hint { display: none; }
    .task-row { grid-template-columns: 1fr 1fr; gap: 13px; }
    .task-main { grid-column: 1 / -1; }
    .task-artifacts small { -webkit-line-clamp: 1; }
}
</style>
