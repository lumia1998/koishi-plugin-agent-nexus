<template>
    <div class="gateway-panel">
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
                <strong>{{ checkedAtLabel }}</strong>
            </div>
            <div v-if="status.gateway.error" class="gateway-error">
                {{ status.gateway.error }}
            </div>
        </section>

        <section class="agent-section">
            <div class="section-head">
                <div>
                    <h3>已发现的 Agent</h3>
                    <p>默认自动生成工具；只有需要改名、停用或覆盖工作区时才保存覆盖项。</p>
                </div>
                <el-button size="small" plain @click="openNewOverride">
                    添加覆盖项
                </el-button>
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
        </section>

        <el-dialog
            v-model="dialogVisible"
            title="Agent 工具覆盖"
            width="min(92vw, 560px)"
            destroy-on-close
        >
            <div class="form-grid">
                <label class="setting wide">
                    <span>Gateway Agent ID</span>
                    <el-input
                        v-model="form.agentId"
                        :disabled="Boolean(editingAgentId)"
                        placeholder="例如 hermes"
                    />
                </label>
                <label class="setting">
                    <span>工具显示名称</span>
                    <el-input v-model="form.name" placeholder="留空则使用 Agent 名称" />
                </label>
                <label class="setting toggle">
                    <span>发布为 ChatLuna 工具</span>
                    <el-switch v-model="form.enabled" />
                </label>
                <label class="setting wide">
                    <span>工作区覆盖</span>
                    <el-input
                        v-model="form.workspace"
                        placeholder="留空使用 Gateway 中的默认工作区"
                    />
                </label>
                <label class="setting wide">
                    <span>工具描述覆盖</span>
                    <el-input
                        v-model="form.description"
                        type="textarea"
                        :rows="3"
                        placeholder="留空使用 Gateway 返回的描述"
                    />
                </label>
                <label class="setting wide">
                    <span>技能标签</span>
                    <el-input
                        v-model="form.skills"
                        placeholder="用逗号分隔，例如 coding, research"
                    />
                </label>
            </div>
            <template #footer>
                <el-button @click="dialogVisible = false">取消</el-button>
                <el-button type="primary" :loading="saving" @click="saveOverride">
                    保存覆盖
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
    DelegationAgentConfig,
    DelegationAgentStatus,
    GatewayAgentSummary,
    GatewayProtocol,
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
const form = reactive({
    agentId: '',
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

const checkedAtLabel = computed(() => {
    const value = props.status.gateway.lastCheckedAt
    return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查'
})
const emptyTitle = computed(() =>
    props.gatewayKeyConfigured ? 'Gateway 暂未返回 Agent' : '等待 Gateway API Key'
)
const emptyHint = computed(() =>
    props.gatewayKeyConfigured
        ? '请先在 Gateway 管理页添加并启用 Agent，然后重新检查。'
        : '在 Koishi 插件设置中填写 API Key 后会自动发现 Agent。'
)

function openNewOverride() {
    editingAgentId.value = ''
    Object.assign(form, {
        agentId: '',
        name: '',
        enabled: true,
        workspace: '',
        description: '',
        skills: ''
    })
    dialogVisible.value = true
}

function openEdit(row: AgentRow) {
    const override = props.config.delegation.agents.find(
        (agent) => agent.agentId === row.agentId
    )
    editingAgentId.value = row.agentId
    Object.assign(form, {
        agentId: row.agentId,
        name: override?.name || row.name,
        enabled: override?.enabled ?? row.enabled,
        workspace: override?.workspace || '',
        description: override?.description || '',
        skills: (override?.skills || []).join(', ')
    })
    dialogVisible.value = true
}

async function saveOverride() {
    const agentId = form.agentId.trim()
    if (!agentId) {
        ElMessage.warning('请填写 Gateway Agent ID')
        return
    }
    const input: DelegationAgentConfig = {
        agentId,
        name: form.name.trim() || agentId,
        enabled: form.enabled,
        workspace: form.workspace.trim() || undefined,
        description: form.description.trim() || undefined,
        skills: form.skills
            .split(/[,，]/)
            .map((value) => value.trim())
            .filter(Boolean)
    }
    saving.value = true
    try {
        const result = await send('agent-nexus/saveDelegationAgent', input)
        emit('updated', result.data)
        dialogVisible.value = false
        ElMessage.success('Agent 覆盖项已保存')
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

function protocolLabel(protocol?: GatewayProtocol) {
    if (protocol === 'a2a') return 'A2A'
    if (protocol === 'acp') return 'ACP'
    return '未知'
}

function agentStateLabel(row: AgentRow) {
    if (!row.enabled) return '已停用'
    if (row.state === 'ready') return '可用'
    if (row.state === 'checking') return '检查中'
    if (row.state === 'error') return '异常'
    return '尚未检查'
}
</script>

<style scoped>
.gateway-panel {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 24px;
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
}

.section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 15px;
}

.section-head h3,
.section-head p {
    margin: 0;
}

.section-head h3 {
    color: var(--k-text-dark);
    font-size: 15px;
}

.section-head p {
    margin-top: 5px;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.5;
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
}

.form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}

.setting {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
}

.setting > span {
    color: var(--k-text-light);
    font-size: 12px;
    font-weight: 600;
}

.setting.wide {
    grid-column: 1 / -1;
}

.setting.toggle {
    justify-content: space-between;
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
    .agent-row,
    .form-grid {
        grid-template-columns: 1fr;
    }

    .section-head {
        align-items: stretch;
        flex-direction: column;
    }

    .setting.wide {
        grid-column: auto;
    }
}
</style>
