<template>
    <div class="agents">
        <section class="gateway-strip" :class="status.gateway.state">
            <div class="gateway-identity">
                <span class="state-light" />
                <div>
                    <strong>{{ status.gateway.name }}</strong>
                    <code>{{ status.gateway.baseUrl }}</code>
                </div>
            </div>
            <div class="gateway-meta">
                <span>API Key</span>
                <strong>{{ gatewayKeyConfigured ? '已配置' : '未配置' }}</strong>
            </div>
            <div class="gateway-meta">
                <span>最近检查</span>
                <strong>{{ formatDate(status.gateway.lastCheckedAt) }}</strong>
            </div>
            <div v-if="status.gateway.error" class="gateway-error">
                {{ status.gateway.error }}
            </div>
        </section>

        <div class="section-head">
            <h2>已发现的 Agent</h2>
            <div class="section-actions">
                <span class="count">{{ overriddenCount }} 个覆盖项</span>
                <el-button size="small" plain @click="openNewOverride">
                    添加覆盖项
                </el-button>
            </div>
        </div>

        <div v-if="!rows.length" class="empty-state">
            <strong>{{ emptyTitle }}</strong>
            <span>{{ emptyHint }}</span>
        </div>

        <div v-else class="agent-table">
            <div class="table-head">
                <span>Agent</span>
                <span>协议 / 驱动</span>
                <span>工作区</span>
                <span>ChatLuna 工具</span>
                <span>状态</span>
                <span>操作</span>
            </div>
            <article v-for="row in rows" :key="row.agentId" class="agent-row">
                <div class="agent-copy" data-label="Agent">
                    <strong>{{ row.name }}</strong>
                    <code>{{ row.agentId }}</code>
                    <small v-if="row.description">{{ row.description }}</small>
                </div>
                <div data-label="协议 / 驱动">
                    <span class="protocol-badge">{{ protocolLabel(row.protocol) }}</span>
                    <small>{{ row.driver || '—' }}</small>
                </div>
                <code class="workspace" data-label="工作区">
                    {{ row.workspace || 'Gateway 默认值' }}
                </code>
                <code class="tool-name" data-label="ChatLuna 工具">
                    {{ row.toolName || '未注册' }}
                </code>
                <div class="state-cell" data-label="状态">
                    <span class="state-dot" :class="row.state" />
                    <span>{{ agentStateLabel(row) }}</span>
                    <small v-if="row.responseMs !== undefined">
                        {{ row.responseMs }} ms
                    </small>
                </div>
                <div class="row-actions" data-label="操作">
                    <el-button size="small" text @click="openEdit(row)">
                        {{ row.overridden ? '编辑覆盖' : '设置覆盖' }}
                    </el-button>
                    <el-button
                        v-if="row.overridden"
                        size="small"
                        text
                        type="danger"
                        @click="removeOverride(row)"
                    >
                        恢复自动
                    </el-button>
                </div>
                <p v-if="row.error" class="row-error">{{ row.error }}</p>
            </article>
        </div>

        <agent-override-dialog
            v-model="dialogVisible"
            :agent-id="editingAgentId"
            :name="form.name"
            :enabled="form.enabled"
            :workspace="form.workspace"
            :description="form.description"
            :skills="form.skills"
            :saving="saving"
            @submit="saveOverride"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import AgentOverrideDialog from './agent-override-dialog.vue'
import { agentStateLabel, formatDate, protocolLabel } from '../shared'
import type {
    DelegationAgentConfig,
    DelegationAgentStatus,
    GatewayAgentSummary,
    NexusConfig,
    NexusConsoleData,
    NexusStatus
} from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
    gatewayKeyConfigured: boolean
}>()

const emit = defineEmits<{
    (event: 'updated', data: NexusConsoleData): void
}>()

interface AgentRow extends DelegationAgentStatus {
    overridden: boolean
    driver?: string
    responseMs?: number
}

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

const rows = computed<AgentRow[]>(() => {
    const inventory = new Map<string, GatewayAgentSummary>(
        props.status.gateway.agents.map((agent) => [agent.id, agent])
    )
    const overridden = new Set(
        props.config.delegation.agents.map((agent) => agent.agentId)
    )
    return props.status.delegation.agents.map((agent) => {
        const source = inventory.get(agent.agentId)
        return {
            ...agent,
            overridden: overridden.has(agent.agentId),
            driver: source?.driver,
            responseMs: source?.responseMs
        }
    })
})

const overriddenCount = computed(() => props.config.delegation.agents.length)

const emptyTitle = computed(() =>
    props.gatewayKeyConfigured ? 'Gateway 未返回 Agent' : '等待 Gateway API Key'
)
const emptyHint = computed(() =>
    props.gatewayKeyConfigured
        ? '在 Gateway 管理页添加并启用 Agent 后重新检查。'
        : '在 Koishi 插件设置中填写 API Key。'
)

function openNewOverride() {
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

function openEdit(row: AgentRow) {
    const override = props.config.delegation.agents.find(
        (agent) => agent.agentId === row.agentId
    )
    editingAgentId.value = row.agentId
    form.value = {
        name: override?.name || row.name,
        enabled: override?.enabled ?? row.enabled,
        workspace: override?.workspace || '',
        description: override?.description || '',
        skills: (override?.skills || []).join(', ')
    }
    dialogVisible.value = true
}

async function saveOverride(input: {
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

async function removeOverride(row: AgentRow) {
    try {
        await ElMessageBox.confirm(
            `恢复“${row.name}”的自动配置吗？`,
            '删除覆盖项',
            {
                confirmButtonText: '恢复自动',
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        const data = await send('agent-nexus/removeDelegationAgent', row.agentId)
        emit('updated', data)
        ElMessage.success('已恢复 Gateway 自动配置')
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    }
}
</script>

<style scoped>
.agents {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 20px;
}

.gateway-strip {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) auto auto;
    gap: 20px;
    align-items: center;
    padding: 15px 17px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 12%);
    background: var(--k-page-bg);
}

.gateway-strip.ready {
    border-left: 3px solid #1fa66b;
}

.gateway-strip.error {
    border-left: 3px solid #d65757;
}

.gateway-identity {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 12px;
}

.state-light,
.state-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: #8b949e;
}

.ready .state-light,
.state-dot.ready {
    background: #1fa66b;
}

.checking .state-light,
.state-dot.checking {
    background: #d99b2b;
}

.error .state-light,
.state-dot.error {
    background: #d65757;
}

.gateway-identity div,
.gateway-meta,
.agent-copy,
.state-cell {
    display: grid;
    min-width: 0;
    gap: 4px;
}

.gateway-identity strong {
    color: var(--k-text-dark);
    font-size: 14px;
}

.gateway-identity code,
.gateway-meta span,
.agent-copy code,
.workspace,
.tool-name,
.state-cell small {
    color: var(--k-text-light);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 11px;
}

.gateway-identity code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.gateway-meta span {
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.gateway-meta strong {
    color: var(--k-text-dark);
    font-size: 12px;
    font-weight: 600;
}

.gateway-error {
    grid-column: 1 / -1;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, #d65757, transparent 72%);
    color: #d65757;
    font-size: 12px;
    overflow-wrap: anywhere;
}

.section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
}

.section-head h2 {
    margin: 0;
    color: var(--k-text-dark);
    font-size: 15px;
}

.section-actions {
    display: flex;
    align-items: center;
    gap: 12px;
}

.count {
    color: var(--k-text-light);
    font-size: 12px;
}

.empty-state {
    display: grid;
    min-height: 150px;
    place-content: center;
    gap: 7px;
    border: 1px dashed color-mix(in srgb, var(--k-color-divider), transparent 8%);
    text-align: center;
}

.empty-state strong {
    color: var(--k-text-dark);
    font-size: 14px;
}

.empty-state span {
    color: var(--k-text-light);
    font-size: 12px;
}

.agent-table {
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 12%);
}

.table-head,
.agent-row {
    display: grid;
    grid-template-columns:
        minmax(170px, 1.2fr) minmax(110px, 0.65fr) minmax(150px, 1fr)
        minmax(145px, 0.85fr) minmax(100px, 0.55fr) minmax(145px, auto);
    gap: 14px;
    align-items: center;
}

.table-head {
    padding: 10px 14px;
    border-bottom: 1px solid var(--k-color-divider);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 22%);
    color: var(--k-text-light);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.agent-row {
    position: relative;
    padding: 13px 14px;
    background: var(--k-page-bg);
}

.agent-row + .agent-row {
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 20%);
}

.agent-copy strong {
    color: var(--k-text-dark);
    font-size: 13px;
}

.agent-copy small {
    color: var(--k-text-light);
    font-size: 11px;
    line-height: 1.45;
}

.protocol-badge {
    display: inline-block;
    width: fit-content;
    padding: 2px 6px;
    border: 1px solid color-mix(in srgb, var(--k-color-primary), transparent 52%);
    color: var(--k-color-primary);
    font-family: 'Cascadia Mono', monospace;
    font-size: 10px;
}

.agent-row > div:nth-child(2) {
    display: flex;
    align-items: center;
    gap: 7px;
}

.agent-row > div:nth-child(2) small {
    color: var(--k-text-light);
    font-size: 11px;
}

.workspace,
.tool-name {
    overflow-wrap: anywhere;
    white-space: normal;
}

.tool-name {
    color: var(--k-text-dark);
}

.state-cell {
    grid-template-columns: auto 1fr;
    align-items: center;
}

.state-cell span:not(.state-dot) {
    color: var(--k-text-dark);
    font-size: 12px;
}

.state-cell small {
    grid-column: 2;
}

.row-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.row-error {
    grid-column: 1 / -1;
    margin: -3px 0 0;
    padding-top: 9px;
    border-top: 1px dashed color-mix(in srgb, #d65757, transparent 68%);
    color: #d65757;
    font-size: 11px;
    overflow-wrap: anywhere;
}

@media (max-width: 1040px) {
    .table-head {
        display: none;
    }

    .agent-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px 20px;
    }

    .agent-row > *::before {
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
    .gateway-strip,
    .agent-row {
        grid-template-columns: 1fr;
    }

    .section-head {
        align-items: stretch;
        flex-direction: column;
        gap: 10px;
    }
}
</style>
