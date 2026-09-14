<template>
    <div class="settings">
        <section class="panel">
            <div class="panel-head">
                <h2>连接</h2>
                <span class="muted">Koishi 插件设置项，此处只读</span>
            </div>
            <div class="info-grid">
                <div>
                    <span>Gateway 地址</span>
                    <code>{{ status.gateway.baseUrl || '未设置' }}</code>
                </div>
                <div>
                    <span>API Key</span>
                    <code>{{ apiKeyLabel }}</code>
                </div>
                <div>
                    <span>连接状态</span>
                    <code>{{ status.gateway.state === 'ready' ? '正常' : '异常' }}</code>
                </div>
                <div>
                    <span>最近检查</span>
                    <code>{{ formatDate(status.gateway.lastCheckedAt) }}</code>
                </div>
                <div>
                    <span>管理操作权限等级</span>
                    <code>{{ settings.commandAuthority || '—' }}</code>
                </div>
                <div>
                    <span>单响应上限</span>
                    <code>{{ formatBytes(settings.maxResponseBytes) }}</code>
                </div>
            </div>
            <p v-if="status.gateway.error" class="panel-error">
                {{ status.gateway.error }}
            </p>
        </section>

        <section class="panel">
            <div class="panel-head">
                <h2>产物缓存</h2>
                <span class="muted">Koishi 插件设置项，此处只读</span>
            </div>
            <div class="info-grid">
                <div>
                    <span>缓存状态</span>
                    <code>{{ cache?.enabled ? '已启用' : '已停用' }}</code>
                </div>
                <div>
                    <span>存放位置</span>
                    <code>{{ cache?.directory || '—' }}</code>
                </div>
                <div>
                    <span>保留时长</span>
                    <code>{{ ttlLabel }}</code>
                </div>
                <div>
                    <span>容量上限</span>
                    <code>{{ formatBytes(cache?.maxTotalBytes || 0) }}</code>
                </div>
                <div>
                    <span>预览读取方式</span>
                    <code>{{ cache?.enabled ? '本地磁盘直读' : '每次回源 Gateway' }}</code>
                </div>
                <div>
                    <span>清理时机</span>
                    <code>启动时 + 每小时</code>
                </div>
            </div>
            <div class="cache-actions">
                <el-button
                    size="small"
                    plain
                    :disabled="!cache?.enabled"
                    :loading="clearingCache"
                    @click="clearCache"
                >
                    清空产物缓存
                </el-button>
                <span class="muted">
                    保留时长按最后访问时间计算；超出容量上限时优先淘汰最久未访问的产物。
                </span>
            </div>
        </section>

        <section class="panel">
            <div class="panel-head">
                <h2>Agent 覆盖项</h2>
                <div class="head-actions">
                    <span class="muted">{{ overrides.length }} 项</span>
                    <el-button size="small" plain @click="openNew">添加覆盖项</el-button>
                </div>
            </div>

            <p v-if="!overrides.length" class="panel-note">没有覆盖项。</p>

            <div v-else class="override-table">
                <div class="table-head">
                    <span>Agent ID</span>
                    <span>名称</span>
                    <span>工作区</span>
                    <span>状态</span>
                    <span>操作</span>
                </div>
                <article
                    v-for="item in overrides"
                    :key="item.override.agentId"
                    class="override-row"
                >
                    <code data-label="Agent ID">{{ item.override.agentId }}</code>
                    <div data-label="名称">
                        <strong>{{ item.override.name }}</strong>
                        <small v-if="item.override.description">
                            {{ item.override.description }}
                        </small>
                    </div>
                    <code class="workspace" data-label="工作区">
                        {{ item.override.workspace || 'Gateway 默认值' }}
                    </code>
                    <div data-label="状态">
                        <el-tag
                            v-if="!item.known"
                            size="small"
                            effect="plain"
                            type="danger"
                        >
                            Gateway 中不存在
                        </el-tag>
                        <el-tag
                            v-else-if="!item.override.enabled"
                            size="small"
                            effect="plain"
                            type="info"
                        >
                            已停用
                        </el-tag>
                        <el-tag v-else size="small" effect="plain" type="success">
                            生效中
                        </el-tag>
                        <small v-if="item.override.skills?.length">
                            {{ item.override.skills.join(' · ') }}
                        </small>
                    </div>
                    <div class="row-actions" data-label="操作">
                        <el-button size="small" text @click="openEdit(item.override)">
                            编辑
                        </el-button>
                        <el-button
                            size="small"
                            text
                            type="danger"
                            @click="remove(item.override)"
                        >
                            删除
                        </el-button>
                    </div>
                </article>
            </div>
        </section>

        <agent-override-dialog
            v-model="dialogVisible"
            :agent-id="editingAgentId"
            :name="form.name"
            :enabled="form.enabled"
            :workspace="form.workspace"
            :description="form.description"
            :skills="form.skills"
            :saving="saving"
            @submit="save"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import AgentOverrideDialog from './agent-override-dialog.vue'
import { formatDate } from '../shared'
import type {
    DelegationAgentConfig,
    NexusConfig,
    NexusConsoleData,
    NexusPluginSettings,
    NexusStatus
} from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
    settings: NexusPluginSettings
}>()

const emit = defineEmits<{
    (event: 'updated', data: NexusConsoleData): void
    (
        event: 'goto',
        tab: 'overview' | 'agents' | 'tasks' | 'artifacts' | 'settings'
    ): void
}>()

const dialogVisible = ref(false)
const saving = ref(false)
const editingAgentId = ref('')
const form = ref({
    name: '',
    enabled: true,
    workspace: '',
    description: '',
    skills: ''
})

const overrides = computed(() => {
    const live = new Set(props.status.delegation.agents.map((agent) => agent.agentId))
    return props.config.delegation.agents.map((override) => ({
        override,
        known: live.has(override.agentId)
    }))
})

function formatBytes(value: number) {
    if (!value) return '—'
    return `${Math.round(value / 1024 / 1024)} MiB`
}

const apiKeyLabel = computed(() => {
    const length = props.settings.gatewayKeyLength
    return length ? `已配置 · ${length} 字符` : '未配置'
})

const cache = computed(() => props.settings.artifactCache)
const clearingCache = ref(false)

const ttlLabel = computed(() => {
    const hours = cache.value?.ttlHours
    if (!hours) return '—'
    if (hours < 24) return `${hours} 小时`
    const days = hours / 24
    return Number.isInteger(days) ? `${days} 天` : `${days.toFixed(1)} 天`
})

async function clearCache() {
    try {
        await ElMessageBox.confirm(
            '将删除所有已缓存到本地的产物，之后预览会重新从 Gateway 下载。',
            '清空产物缓存',
            { type: 'warning' }
        )
    } catch {
        return
    }
    clearingCache.value = true
    try {
        const removed = await send('agent-nexus/clearArtifactCache')
        ElMessage.success(`已清理 ${removed} 个缓存产物。`)
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        clearingCache.value = false
    }
}

function openNew() {
    editingAgentId.value = ''
    form.value = {
        name: '',
        enabled: true,
        workspace: '',
        description: '',
        skills: ''
    }
    dialogVisible.value = true
}

function openEdit(override: DelegationAgentConfig) {
    editingAgentId.value = override.agentId
    form.value = {
        name: override.name,
        enabled: override.enabled,
        workspace: override.workspace || '',
        description: override.description || '',
        skills: (override.skills || []).join(', ')
    }
    dialogVisible.value = true
}

async function save(input: {
    agentId: string
    name: string
    enabled: boolean
    workspace: string
    description: string
    skills: string
}) {
    const agentId = input.agentId.trim()
    if (!agentId) {
        ElMessage.warning('请填写 Gateway Agent ID')
        return
    }
    const payload: DelegationAgentConfig = {
        agentId,
        name: input.name.trim() || agentId,
        enabled: input.enabled,
        workspace: input.workspace.trim() || undefined,
        description: input.description.trim() || undefined,
        skills: input.skills
            .split(/[,，]/)
            .map((value) => value.trim())
            .filter(Boolean)
    }
    saving.value = true
    try {
        const result = await send('agent-nexus/saveDelegationAgent', payload)
        emit('updated', result.data)
        dialogVisible.value = false
        ElMessage.success('覆盖项已保存')
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        saving.value = false
    }
}

async function remove(override: DelegationAgentConfig) {
    try {
        await ElMessageBox.confirm(
            `删除“${override.name}”的覆盖项吗？该 Agent 将回到 Gateway 自动配置。`,
            '删除覆盖项',
            {
                confirmButtonText: '删除',
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        const data = await send('agent-nexus/removeDelegationAgent', override.agentId)
        emit('updated', data)
        ElMessage.success('覆盖项已删除')
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    }
}
</script>

<style scoped>
.settings {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 18px;
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

.head-actions {
    display: flex;
    align-items: center;
    gap: 12px;
}

.muted {
    color: var(--k-text-light);
    font-size: 11px;
}

.info-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--nexus-line);
}

.cache-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 12px;
}

.info-grid div {
    display: grid;
    min-width: 0;
    gap: 6px;
    padding: 12px 16px;
    background: var(--k-page-bg);
}

.info-grid span {
    color: var(--k-text-light);
    font-size: 10px;
    letter-spacing: 0.06em;
}

.info-grid code {
    overflow: hidden;
    color: var(--nexus-ink);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.panel-error {
    margin: 0;
    padding: 12px 18px;
    border-top: 1px solid color-mix(in srgb, #d65757, transparent 70%);
    color: #c84f4f;
    font-size: 12px;
    overflow-wrap: anywhere;
}

.panel-note {
    margin: 0;
    padding: 26px 18px;
    color: var(--k-text-light);
    font-size: 12px;
    text-align: center;
}

.table-head,
.override-row {
    display: grid;
    grid-template-columns:
        minmax(120px, 0.8fr) minmax(160px, 1.2fr) minmax(140px, 1fr)
        minmax(150px, 1fr) minmax(120px, auto);
    gap: 14px;
    align-items: center;
}

.table-head {
    padding: 10px 16px;
    border-bottom: 1px solid var(--nexus-line);
    color: var(--k-text-light);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.override-row {
    padding: 13px 16px;
    background: var(--k-page-bg);
}

.override-row + .override-row {
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 20%);
}

.override-row > code {
    color: var(--k-text-light);
    font-size: 11px;
    overflow-wrap: anywhere;
}

.override-row > div {
    display: grid;
    min-width: 0;
    gap: 4px;
    justify-items: start;
}

.override-row strong {
    color: var(--nexus-ink);
    font-size: 13px;
}

.override-row small {
    color: var(--k-text-light);
    font-size: 11px;
    line-height: 1.45;
}

.workspace {
    white-space: normal;
}

.row-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
}

@media (max-width: 1040px) {
    .info-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .table-head {
        display: none;
    }

    .override-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px 20px;
    }

    .override-row > *::before {
        display: block;
        margin-bottom: 4px;
        color: var(--k-text-light);
        content: attr(data-label);
        font-size: 9px;
        letter-spacing: 0.08em;
    }

    .row-actions {
        justify-content: flex-start;
    }
}

@media (max-width: 680px) {
    .info-grid,
    .override-row {
        grid-template-columns: 1fr;
    }

    .panel-head {
        align-items: stretch;
        flex-direction: column;
        gap: 10px;
    }
}
</style>
