<template>
    <section class="sessions-panel">
        <div class="panel-head">
            <div>
                <h2>会话历史</h2>
                <p>查看 Nexus 管理的任务上下文、结束原因与自动摘要。</p>
            </div>
            <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        </div>

        <div class="filters">
            <el-input
                v-model="search"
                clearable
                placeholder="搜索标题、摘要或消息"
                @keyup.enter="applyFilters"
                @clear="applyFilters"
            />
            <el-select v-model="status" clearable placeholder="全部状态" @change="applyFilters">
                <el-option label="执行中" value="running" />
                <el-option label="等待确认" value="waiting_confirm" />
                <el-option label="等待输入" value="waiting_input" />
                <el-option label="已完成" value="completed" />
                <el-option label="失败" value="failed" />
            </el-select>
            <el-select v-model="agent" clearable placeholder="全部 Agent" @change="applyFilters">
                <el-option v-for="item in agents" :key="item" :label="item" :value="item" />
            </el-select>
            <el-button type="primary" plain @click="applyFilters">查询</el-button>
        </div>

        <div v-loading="loading" class="session-list">
            <button
                v-for="item in page.items"
                :key="item.id"
                class="session-row"
                type="button"
                @click="openDetail(item.id)"
            >
                <div class="session-main">
                    <div class="title-line">
                        <strong>{{ item.title || `${item.agent} 会话` }}</strong>
                        <el-tag size="small" effect="plain" :type="statusType(item.status)">
                            {{ statusLabel(item.status) }}
                        </el-tag>
                        <el-tag
                            v-if="item.summaryStatus === 'pending'"
                            size="small"
                            effect="plain"
                            type="warning"
                        >
                            摘要中
                        </el-tag>
                    </div>
                    <p class="abstract">{{ item.abstract || '暂无摘要' }}</p>
                    <div v-if="item.topics.length" class="topics">
                        <el-tag v-for="topic in item.topics" :key="topic" size="small" effect="plain">
                            {{ topic }}
                        </el-tag>
                    </div>
                </div>
                <div class="session-meta">
                    <span>{{ item.agent }}</span>
                    <span>{{ item.messageCount }} 条消息</span>
                    <span>{{ formatDate(item.endedAt || item.updatedAt) }}</span>
                </div>
            </button>

            <div v-if="!loading && !page.items.length" class="empty">
                暂无符合条件的会话。
            </div>
        </div>

        <el-pagination
            v-if="page.total > page.limit"
            class="pagination"
            background
            layout="prev, pager, next"
            :page-size="page.limit"
            :total="page.total"
            :current-page="currentPage"
            @current-change="changePage"
        />

        <el-dialog
            v-model="detailVisible"
            width="min(920px, 92vw)"
            destroy-on-close
            :title="detail?.title || '会话详情'"
        >
            <div v-if="detail" class="detail">
                <div class="detail-meta">
                    <el-tag size="small" effect="plain" :type="statusType(detail.status)">
                        {{ statusLabel(detail.status) }}
                    </el-tag>
                    <span>{{ detail.agent }}</span>
                    <span>{{ detail.platform }} / {{ detail.channelId }}</span>
                    <span>{{ formatDate(detail.createdAt) }}</span>
                </div>
                <div class="summary-box">
                    <div class="summary-title">摘要</div>
                    <p>{{ detail.abstract || '暂无摘要' }}</p>
                    <small v-if="detail.endReason">结束原因：{{ endReasonLabel(detail.endReason) }}</small>
                </div>
                <div class="messages">
                    <article
                        v-for="(message, index) in detail.messages"
                        :key="`${message.createdAt}-${index}`"
                        class="message"
                        :class="message.role"
                    >
                        <header>
                            <strong>{{ roleLabel(message.role) }}</strong>
                            <time>{{ formatDate(message.createdAt) }}</time>
                        </header>
                        <pre>{{ message.content }}</pre>
                    </article>
                </div>
            </div>
            <template #footer>
                <el-button @click="detailVisible = false">关闭</el-button>
                <el-button
                    v-if="detail?.endedAt"
                    :loading="retrying"
                    @click="retrySummary"
                >
                    重新生成摘要
                </el-button>
                <el-button
                    v-if="detail?.endedAt"
                    type="danger"
                    :loading="deleting"
                    @click="deleteSession"
                >
                    删除会话
                </el-button>
            </template>
        </el-dialog>
    </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
    NexusSessionStatus,
    SessionEndReason,
    SessionHistoryDetail,
    SessionHistoryPage,
    SessionMessageRole
} from '../../src/sessions/types'

const props = defineProps<{ visible: boolean }>()
const agents = ['hermes', 'openclaw', 'claude', 'opencode', 'codex']
const loading = ref(false)
const deleting = ref(false)
const retrying = ref(false)
const loaded = ref(false)
const requestId = ref(0)
const search = ref('')
const status = ref<NexusSessionStatus | ''>('')
const agent = ref('')
const currentPage = ref(1)
const page = ref<SessionHistoryPage>({ items: [], total: 0, offset: 0, limit: 20 })
const detailVisible = ref(false)
const detail = ref<SessionHistoryDetail>()

watch(
    () => props.visible,
    (visible) => {
        if (visible && !loaded.value) void load()
    },
    { immediate: true }
)

async function load() {
    const id = ++requestId.value
    loading.value = true
    try {
        const result = await send('agent-nexus/listSessionHistory', {
            offset: (currentPage.value - 1) * page.value.limit,
            limit: page.value.limit,
            query: search.value.trim() || undefined,
            status: status.value || undefined,
            agent: agent.value || undefined
        })
        if (id !== requestId.value) return
        page.value = result
        loaded.value = true
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        if (id === requestId.value) loading.value = false
    }
}

function applyFilters() {
    currentPage.value = 1
    void load()
}

function changePage(value: number) {
    currentPage.value = value
    void load()
}

async function openDetail(id: string) {
    try {
        detail.value = await send('agent-nexus/getSessionHistory', id)
        detailVisible.value = true
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    }
}

async function retrySummary() {
    if (!detail.value) return
    retrying.value = true
    try {
        await send('agent-nexus/retrySessionSummary', detail.value.id)
        ElMessage.success('摘要任务已重新排队')
        detail.value = await send('agent-nexus/getSessionHistory', detail.value.id)
        await load()
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        retrying.value = false
    }
}

async function deleteSession() {
    if (!detail.value) return
    try {
        await ElMessageBox.confirm('删除后无法恢复，确定删除这段会话吗？', '删除会话', {
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            type: 'warning'
        })
        deleting.value = true
        await send('agent-nexus/deleteSessionHistory', detail.value.id)
        detailVisible.value = false
        detail.value = undefined
        ElMessage.success('会话已删除')
        await load()
        if (!page.value.items.length && currentPage.value > 1) {
            currentPage.value -= 1
            await load()
        }
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    } finally {
        deleting.value = false
    }
}

function statusLabel(value: NexusSessionStatus) {
    return {
        running: '执行中',
        waiting_confirm: '等待确认',
        waiting_input: '等待输入',
        completed: '已完成',
        failed: '失败'
    }[value]
}

function statusType(value: NexusSessionStatus) {
    if (value === 'completed') return 'success'
    if (value === 'failed') return 'danger'
    if (value === 'running') return 'primary'
    return 'warning'
}

function endReasonLabel(value: SessionEndReason) {
    return {
        completed: '正常完成',
        failed: '执行失败',
        cancelled: '用户取消',
        expired: '空闲超时',
        user_exit: '主动退出',
        replaced: '被新会话替换'
    }[value]
}

function roleLabel(value: SessionMessageRole) {
    return { system: 'System', user: '用户', assistant: 'Agent', tool: 'Tool' }[value]
}

function formatDate(value?: number) {
    if (!value) return '—'
    return new Date(value).toLocaleString()
}
</script>

<style scoped>
.sessions-panel {
    min-height: 460px;
}

.panel-head,
.filters,
.title-line,
.topics,
.detail-meta,
.message header {
    display: flex;
    align-items: center;
    gap: 10px;
}

.panel-head {
    justify-content: space-between;
    margin-bottom: 16px;
}

h2 {
    margin: 0;
    font-size: 18px;
    color: var(--k-text-dark);
}

.panel-head p {
    margin: 5px 0 0;
    font-size: 13px;
    color: var(--k-text-light);
}

.filters {
    margin-bottom: 14px;
}

.filters :deep(.el-input) {
    max-width: 420px;
}

.filters :deep(.el-select) {
    width: 150px;
}

.session-list {
    min-height: 240px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
}

.session-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    width: 100%;
    gap: 20px;
    padding: 16px 18px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 35%);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}

.session-row:last-child {
    border-bottom: 0;
}

.session-row:hover {
    background: color-mix(in srgb, var(--k-color-primary), transparent 95%);
}

.session-main,
.title-line,
.abstract {
    min-width: 0;
}

.title-line strong {
    overflow: hidden;
    color: var(--k-text-dark);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.abstract {
    display: -webkit-box;
    margin: 7px 0 0;
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 13px;
    line-height: 1.55;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
}

.topics {
    margin-top: 9px;
    flex-wrap: wrap;
}

.session-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 6px;
    color: var(--k-text-light);
    font-size: 12px;
    white-space: nowrap;
}

.empty {
    padding: 72px 20px;
    color: var(--k-text-light);
    text-align: center;
}

.pagination {
    justify-content: flex-end;
    margin-top: 16px;
}

.detail-meta {
    flex-wrap: wrap;
    margin-bottom: 14px;
    color: var(--k-text-light);
    font-size: 12px;
}

.summary-box {
    padding: 14px 16px;
    border-left: 3px solid color-mix(in srgb, var(--k-color-primary), transparent 25%);
    background: color-mix(in srgb, var(--k-color-primary), transparent 94%);
}

.summary-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--k-text-dark);
}

.summary-box p {
    margin: 7px 0;
    line-height: 1.6;
}

.summary-box small {
    color: var(--k-text-light);
}

.messages {
    display: flex;
    max-height: 56vh;
    margin-top: 18px;
    overflow-y: auto;
    flex-direction: column;
    gap: 12px;
}

.message {
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 25%);
    border-radius: 12px;
}

.message.user {
    background: color-mix(in srgb, var(--k-color-primary), transparent 95%);
}

.message header {
    justify-content: space-between;
    color: var(--k-text-light);
    font-size: 12px;
}

.message pre {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
    color: var(--k-text-dark);
    font: inherit;
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
}

@media (max-width: 720px) {
    .filters {
        align-items: stretch;
        flex-direction: column;
    }

    .filters :deep(.el-input),
    .filters :deep(.el-select) {
        width: 100%;
        max-width: none;
    }

    .session-row {
        grid-template-columns: 1fr;
    }

    .session-meta {
        align-items: flex-start;
        flex-direction: row;
        flex-wrap: wrap;
    }

    :deep(.el-dialog__footer) {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
    }

    :deep(.el-dialog__footer .el-button) {
        margin-left: 0;
    }
}
</style>
