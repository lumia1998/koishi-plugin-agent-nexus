<template>
    <div class="a2a-panel">
        <section class="section remote-section">
            <div class="section-head">
                <div class="heading-group">
                    <div class="section-title">委托 Agent</div>
                    <span class="count">{{ config.delegation.agents.length }}</span>
                </div>
                <el-button size="small" :icon="Plus" @click="openAddAgent">
                    添加 Agent
                </el-button>
            </div>

            <el-alert
                type="info"
                :closable="false"
                show-icon
                title="每个 Agent 可单独选择 A2A 或 Nexus Gateway + ACP。未建立显式映射的 A2A Agent Card 仍可直接调用。"
            />

            <div v-if="!config.delegation.agents.length" class="empty-state compact-empty">
                <Connection class="empty-icon" />
                <span>尚未配置显式 Agent 路由；现有 A2A Cards 会保持兼容并直接可用</span>
            </div>

            <div v-else class="remote-list">
                <article
                    v-for="agent in config.delegation.agents"
                    :key="agent.id"
                    class="remote-row"
                >
                    <div class="remote-primary">
                        <span
                            class="state-dot"
                            :class="delegationState(agent).state"
                            aria-hidden="true"
                        />
                        <div class="remote-copy">
                            <div class="remote-title-row">
                                <strong>{{ agent.name }}</strong>
                                <el-tag size="small" effect="plain">
                                    {{ agent.provider === 'a2a' ? 'A2A' : 'ACP' }}
                                </el-tag>
                                <el-tag
                                    size="small"
                                    effect="plain"
                                    :type="stateTagType(delegationState(agent).state)"
                                >
                                    {{ stateLabel(delegationState(agent).state) }}
                                </el-tag>
                                <el-tag v-if="!agent.enabled" size="small" effect="plain">
                                    已禁用
                                </el-tag>
                            </div>
                            <div class="remote-url">
                                {{ delegationTarget(agent) }}
                            </div>
                            <div v-if="agent.workspace" class="card-summary">
                                <span>workspace: {{ agent.workspace }}</span>
                            </div>
                            <div v-if="delegationState(agent).error" class="remote-error">
                                {{ delegationState(agent).error }}
                            </div>
                        </div>
                    </div>
                    <div class="remote-actions">
                        <el-tooltip content="编辑 Agent" placement="top">
                            <el-button
                                circle
                                size="small"
                                :icon="Edit"
                                @click="openEditAgent(agent)"
                            />
                        </el-tooltip>
                        <el-tooltip content="删除 Agent" placement="top">
                            <el-button
                                circle
                                size="small"
                                type="danger"
                                plain
                                :icon="Delete"
                                @click="removeAgent(agent)"
                            />
                        </el-tooltip>
                    </div>
                </article>
            </div>
        </section>

        <section class="section remote-section">
            <div class="section-head">
                <div class="heading-group">
                    <div class="section-title">Nexus Gateways</div>
                    <span class="count">{{ config.gateway.remotes.length }}</span>
                </div>
                <el-button size="small" :icon="Plus" @click="openAddGateway">
                    添加 Gateway
                </el-button>
            </div>

            <div v-if="!config.gateway.remotes.length" class="empty-state compact-empty">
                <Connection class="empty-icon" />
                <span>尚未添加运行 nexus-agentd 的远端节点</span>
            </div>

            <div v-else class="remote-list">
                <article
                    v-for="gateway in config.gateway.remotes"
                    :key="gateway.id"
                    class="remote-row"
                >
                    <div class="remote-primary">
                        <span
                            class="state-dot"
                            :class="gatewayState(gateway).state"
                            aria-hidden="true"
                        />
                        <div class="remote-copy">
                            <div class="remote-title-row">
                                <strong>{{ gateway.name }}</strong>
                                <el-tag
                                    size="small"
                                    effect="plain"
                                    :type="stateTagType(gatewayState(gateway).state)"
                                >
                                    {{ stateLabel(gatewayState(gateway).state) }}
                                </el-tag>
                                <el-tag v-if="!gateway.enabled" size="small" effect="plain">
                                    已禁用
                                </el-tag>
                            </div>
                            <div class="remote-url">{{ gateway.baseUrl }}</div>
                            <div v-if="gatewayState(gateway).agents.length" class="skill-list">
                                <span
                                    v-for="agent in gatewayState(gateway).agents"
                                    :key="agent.id"
                                    class="skill-chip"
                                >
                                    {{ agent.name }} · {{ agent.ready ? 'ready' : 'error' }}
                                </span>
                            </div>
                            <div v-if="gatewayState(gateway).error" class="remote-error">
                                {{ gatewayState(gateway).error }}
                            </div>
                        </div>
                    </div>
                    <div class="remote-actions">
                        <el-tooltip content="发现 Gateway Agents" placement="top">
                            <el-button
                                circle
                                size="small"
                                :icon="Refresh"
                                :loading="isGatewayDiscovering(gateway.id)"
                                @click="discoverGateway(gateway)"
                            />
                        </el-tooltip>
                        <el-tooltip content="编辑 Gateway" placement="top">
                            <el-button
                                circle
                                size="small"
                                :icon="Edit"
                                @click="openEditGateway(gateway)"
                            />
                        </el-tooltip>
                        <el-tooltip content="删除 Gateway" placement="top">
                            <el-button
                                circle
                                size="small"
                                type="danger"
                                plain
                                :icon="Delete"
                                @click="removeGateway(gateway)"
                            />
                        </el-tooltip>
                    </div>
                </article>
            </div>
        </section>

        <section class="section remote-section">
            <div class="section-head">
                <div class="heading-group">
                    <div class="section-title">外部 Agent Cards</div>
                    <span class="count">{{ config.a2a.remotes.length }}</span>
                </div>
                <el-button size="small" :icon="Plus" @click="openAddRemote">
                    添加 Agent Card
                </el-button>
            </div>

            <div v-if="!config.a2a.remotes.length" class="empty-state">
                <Connection class="empty-icon" />
                <span>尚未添加外部 Agent Card</span>
            </div>

            <div v-else class="remote-list">
                <article
                    v-for="remote in config.a2a.remotes"
                    :key="remote.id"
                    class="remote-row"
                >
                    <div class="remote-primary">
                        <span
                            class="state-dot"
                            :class="remoteState(remote).state"
                            aria-hidden="true"
                        />
                        <div class="remote-copy">
                            <div class="remote-title-row">
                                <strong>{{ remote.name }}</strong>
                                <el-tag
                                    size="small"
                                    effect="plain"
                                    :type="stateTagType(remoteState(remote).state)"
                                >
                                    {{ stateLabel(remoteState(remote).state) }}
                                </el-tag>
                                <el-tag v-if="!remote.enabled" size="small" effect="plain">
                                    已禁用
                                </el-tag>
                            </div>
                            <div class="remote-url">{{ agentCardUrl(remote) }}</div>
                            <div v-if="remoteState(remote).card" class="card-summary">
                                <span>
                                    {{ remoteState(remote).card?.name }}
                                    · {{ remoteState(remote).card?.version }}
                                </span>
                                <span>
                                    {{ remoteState(remote).card?.protocolVersions.join(' / ') }}
                                </span>
                                <span v-if="remoteState(remote).card?.streaming">Streaming</span>
                            </div>
                            <div v-if="remoteState(remote).error" class="remote-error">
                                {{ remoteState(remote).error }}
                            </div>
                            <div
                                v-if="remoteState(remote).card?.skills.length"
                                class="skill-list"
                            >
                                <span
                                    v-for="skill in remoteState(remote).card?.skills.slice(0, 6) || []"
                                    :key="skill.id"
                                    class="skill-chip"
                                >
                                    {{ skill.name }}
                                </span>
                                <span
                                    v-if="(remoteState(remote).card?.skills.length || 0) > 6"
                                    class="skill-more"
                                >
                                    +{{ (remoteState(remote).card?.skills.length || 0) - 6 }}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div class="remote-actions">
                        <el-tooltip content="发现 Agent Card" placement="top">
                            <el-button
                                circle
                                size="small"
                                :icon="Refresh"
                                :loading="isDiscovering(remote.id)"
                                @click="discover(remote)"
                            />
                        </el-tooltip>
                        <el-tooltip content="协议调试：手动发送任务" placement="top">
                            <el-button
                                circle
                                size="small"
                                plain
                                :icon="Promotion"
                                :disabled="!remote.enabled"
                                @click="openTask(remote)"
                            />
                        </el-tooltip>
                        <el-tooltip content="编辑 Agent Card" placement="top">
                            <el-button
                                circle
                                size="small"
                                :icon="Edit"
                                @click="openEditRemote(remote)"
                            />
                        </el-tooltip>
                        <el-tooltip content="删除 Agent Card" placement="top">
                            <el-button
                                circle
                                size="small"
                                type="danger"
                                plain
                                :icon="Delete"
                                @click="removeRemote(remote)"
                            />
                        </el-tooltip>
                    </div>
                </article>
            </div>
        </section>

        <el-dialog
            v-model="agentDialog"
            :title="agentForm.id ? '编辑委托 Agent' : '添加委托 Agent'"
            width="min(640px, 92vw)"
            destroy-on-close
        >
            <div class="dialog-grid">
                <label class="setting">
                    <span class="field-label">名称</span>
                    <el-input v-model="agentForm.name" placeholder="OpenCode" />
                </label>
                <label class="setting">
                    <span class="field-label">连接方式</span>
                    <el-select v-model="agentForm.provider" class="full-width" @change="agentProviderChanged">
                        <el-option label="A2A" value="a2a" />
                        <el-option label="Nexus Gateway + ACP" value="gateway" />
                    </el-select>
                </label>
                <label class="setting wide-setting">
                    <span class="field-label">
                        {{ agentForm.provider === 'a2a' ? 'A2A Agent Card' : 'Nexus Gateway' }}
                    </span>
                    <el-select v-model="agentForm.remoteId" class="full-width">
                        <el-option
                            v-for="remote in agentRemoteOptions"
                            :key="remote.id"
                            :label="remote.name"
                            :value="remote.id"
                        />
                    </el-select>
                </label>
                <label v-if="agentForm.provider === 'gateway'" class="setting">
                    <span class="field-label">Gateway Agent ID</span>
                    <el-input v-model="agentForm.agentId" placeholder="opencode" />
                </label>
                <label v-if="agentForm.provider === 'gateway'" class="setting wide-setting">
                    <span class="field-label">Workspace</span>
                    <el-input v-model="agentForm.workspace" placeholder="/data/repos/project" />
                </label>
                <label class="setting wide-setting">
                    <span class="field-label">说明</span>
                    <el-input v-model="agentForm.description" placeholder="可选" />
                </label>
                <label class="setting wide-setting">
                    <span class="field-label">Skills</span>
                    <el-input v-model="agentForm.skills" placeholder="逗号分隔，用于 ChatLuna 自动选择" />
                </label>
                <label class="setting toggle-setting">
                    <span class="field-label">启用</span>
                    <el-switch v-model="agentForm.enabled" />
                </label>
            </div>
            <template #footer>
                <el-button @click="agentDialog = false">取消</el-button>
                <el-button type="primary" :loading="savingAgent" @click="saveAgent">
                    保存
                </el-button>
            </template>
        </el-dialog>

        <el-dialog
            v-model="gatewayDialog"
            :title="gatewayForm.id ? '编辑 Nexus Gateway' : '添加 Nexus Gateway'"
            width="min(620px, 92vw)"
            destroy-on-close
        >
            <div class="dialog-grid">
                <label class="setting">
                    <span class="field-label">名称</span>
                    <el-input v-model="gatewayForm.name" placeholder="dev-server" />
                </label>
                <label class="setting wide-setting">
                    <span class="field-label">Gateway URL</span>
                    <el-input v-model="gatewayForm.baseUrl" placeholder="http://10.1.2.50:PORT" />
                </label>
                <div class="setting wide-setting">
                    <span class="field-label">Bearer Token</span>
                    <el-input
                        v-model="gatewayForm.authToken"
                        type="password"
                        show-password
                        :disabled="gatewayForm.clearAuthToken"
                        placeholder="留空保持现有 Token，支持 env:VAR"
                    />
                    <el-checkbox v-model="gatewayForm.clearAuthToken">
                        清除已保存 Token
                    </el-checkbox>
                </div>
                <label class="setting toggle-setting">
                    <span class="field-label">启用</span>
                    <el-switch v-model="gatewayForm.enabled" />
                </label>
            </div>
            <template #footer>
                <el-button @click="gatewayDialog = false">取消</el-button>
                <el-button type="primary" :loading="savingGateway" @click="saveGateway">
                    保存
                </el-button>
            </template>
        </el-dialog>

        <el-dialog
            v-model="remoteDialog"
            :title="remoteForm.id ? '编辑 Agent Card' : '添加 Agent Card'"
            width="min(620px, 92vw)"
            destroy-on-close
        >
            <div class="dialog-grid">
                <label class="setting">
                    <span class="field-label">名称</span>
                    <el-input v-model="remoteForm.name" placeholder="Claude Code" />
                </label>
                <label class="setting wide-setting">
                    <span class="field-label">Agent Card URL</span>
                    <el-input
                        v-model="remoteForm.cardUrl"
                        placeholder="http://10.1.2.50:PORT/.well-known/agent-card.json"
                    />
                </label>
                <label class="setting">
                    <span class="field-label">首选传输</span>
                    <el-select v-model="remoteForm.preferredTransport" class="full-width">
                        <el-option label="自动" value="" />
                        <el-option label="JSON-RPC" value="JSONRPC" />
                        <el-option label="HTTP + JSON" value="HTTP+JSON" />
                    </el-select>
                </label>
                <div class="setting wide-setting">
                    <span class="field-label">Bearer Token</span>
                    <el-input
                        v-model="remoteForm.authToken"
                        type="password"
                        show-password
                        :disabled="remoteForm.clearAuthToken"
                        placeholder="留空保持现有 Token，支持 env:VAR"
                    />
                    <el-checkbox v-model="remoteForm.clearAuthToken">
                        清除已保存 Token
                    </el-checkbox>
                </div>
                <label class="setting toggle-setting">
                    <span class="field-label">启用</span>
                    <el-switch v-model="remoteForm.enabled" />
                </label>
            </div>
            <template #footer>
                <el-button @click="remoteDialog = false">取消</el-button>
                <el-button type="primary" :loading="savingRemote" @click="saveRemote">
                    保存
                </el-button>
            </template>
        </el-dialog>

        <el-dialog
            v-model="taskDialog"
            :title="`A2A 协议调试 · ${taskRemote?.name || ''}`"
            width="min(760px, 94vw)"
            destroy-on-close
        >
            <div class="task-form">
                <el-alert
                    type="info"
                    :closable="false"
                    show-icon
                    title="日常委托由 ChatLuna 调用 nexus_a2a_delegate；此处仅用于协议联调和故障排查。"
                />
                <el-input
                    v-model="taskForm.text"
                    type="textarea"
                    :rows="6"
                    placeholder="输入要委托给远端 Agent 的任务"
                />
                <div class="task-options">
                    <label class="setting">
                        <span class="field-label">Task ID</span>
                        <el-input v-model="taskForm.taskId" placeholder="续接任务时填写" />
                    </label>
                    <label class="setting">
                        <span class="field-label">Context ID</span>
                        <el-input v-model="taskForm.contextId" placeholder="续接上下文时填写" />
                    </label>
                    <label class="setting toggle-setting">
                        <span class="field-label">立即返回</span>
                        <el-switch v-model="taskForm.returnImmediately" />
                    </label>
                </div>

                <div v-if="taskResult" class="task-result">
                    <div class="result-head">
                        <el-tag size="small" effect="plain" :type="taskStateType(taskResult.state)">
                            {{ taskStateLabel(taskResult.state) }}
                        </el-tag>
                        <el-tag v-if="taskResult.timedOut" size="small" effect="plain" type="warning">
                            等待超时
                        </el-tag>
                        <code v-if="taskResult.taskId">{{ taskResult.taskId }}</code>
                        <div class="result-actions">
                            <el-tooltip content="刷新任务" placement="top">
                                <el-button
                                    circle
                                    size="small"
                                    :icon="Refresh"
                                    :loading="taskAction === 'refresh'"
                                    :disabled="!taskResult.taskId || !!taskAction || sendingTask"
                                    @click="refreshTask"
                                />
                            </el-tooltip>
                            <el-tooltip content="取消任务" placement="top">
                                <el-button
                                    circle
                                    size="small"
                                    type="danger"
                                    plain
                                    :icon="CloseBold"
                                    :loading="taskAction === 'cancel'"
                                    :disabled="!taskResult.taskId || isTaskTerminal(taskResult.state) || !!taskAction || sendingTask"
                                    @click="cancelTask"
                                />
                            </el-tooltip>
                        </div>
                    </div>
                    <pre v-if="taskResult.text" class="result-text">{{ taskResult.text }}</pre>
                    <div v-if="taskResult.artifacts.length" class="artifact-list">
                        <div
                            v-for="(artifact, index) in taskResult.artifacts"
                            :key="`${artifact.name}-${index}`"
                            class="artifact-row"
                        >
                            <span>{{ artifact.name || artifact.filename || `Artifact ${index + 1}` }}</span>
                            <a
                                v-if="artifact.url"
                                :href="artifact.url"
                                target="_blank"
                                rel="noreferrer"
                            >
                                打开
                            </a>
                            <span v-else class="artifact-text">{{ artifact.text }}</span>
                        </div>
                    </div>
                </div>
            </div>
            <template #footer>
                <el-button @click="taskDialog = false">关闭</el-button>
                <el-button
                    type="primary"
                    :loading="sendingTask"
                    :disabled="!!taskAction"
                    :icon="Promotion"
                    @click="sendTask"
                >
                    发送
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
    CloseBold,
    Connection,
    Delete,
    Edit,
    Plus,
    Promotion,
    Refresh
} from '@element-plus/icons-vue'
import type {
    A2ARemoteConfig,
    A2ARemoteState,
    A2ATaskView,
    DelegationAgentConfig,
    GatewayRemoteConfig,
    GatewayRemoteState,
    NexusConfig,
    NexusConsoleData,
    NexusStatus
} from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
}>()

const emit = defineEmits<{
    updated: [data: NexusConsoleData]
}>()

const DEFAULT_AGENT_CARD_PATH = '/.well-known/agent-card.json'

const savingRemote = ref(false)
const discovering = ref(new Set<string>())
const savingAgent = ref(false)
const agentDialog = ref(false)
const savingGateway = ref(false)
const gatewayDialog = ref(false)
const discoveringGateways = ref(new Set<string>())
const remoteDialog = ref(false)
const taskDialog = ref(false)
const sendingTask = ref(false)
const taskAction = ref<'' | 'refresh' | 'cancel'>('')
const taskRemote = ref<A2ARemoteConfig>()
const taskResult = ref<A2ATaskView>()

const remoteForm = reactive({
    id: '',
    name: '',
    cardUrl: '',
    authToken: '',
    clearAuthToken: false,
    enabled: true,
    preferredTransport: '' as '' | 'JSONRPC' | 'HTTP+JSON'
})

const agentForm = reactive({
    id: '',
    name: '',
    provider: 'a2a' as 'a2a' | 'gateway',
    remoteId: '',
    agentId: '',
    workspace: '',
    description: '',
    skills: '',
    enabled: true
})

const gatewayForm = reactive({
    id: '',
    name: '',
    baseUrl: '',
    authToken: '',
    clearAuthToken: false,
    enabled: true
})

const taskForm = reactive({
    text: '',
    taskId: '',
    contextId: '',
    returnImmediately: false
})

const agentRemoteOptions = computed(() =>
    agentForm.provider === 'a2a'
        ? props.config.a2a.remotes
        : props.config.gateway.remotes
)

function openAddAgent() {
    Object.assign(agentForm, {
        id: '',
        name: '',
        provider: 'a2a',
        remoteId: props.config.a2a.remotes[0]?.id || '',
        agentId: '',
        workspace: '',
        description: '',
        skills: '',
        enabled: true
    })
    agentDialog.value = true
}

function openEditAgent(agent: DelegationAgentConfig) {
    Object.assign(agentForm, {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        remoteId: agent.remoteId,
        agentId: agent.agentId || '',
        workspace: agent.workspace || '',
        description: agent.description || '',
        skills: (agent.skills || []).join(', '),
        enabled: agent.enabled
    })
    agentDialog.value = true
}

function agentProviderChanged() {
    const options = agentRemoteOptions.value
    if (!options.some((remote) => remote.id === agentForm.remoteId)) {
        agentForm.remoteId = options[0]?.id || ''
    }
    if (agentForm.provider === 'a2a') {
        agentForm.agentId = ''
        agentForm.workspace = ''
    } else if (!agentForm.agentId) {
        agentForm.agentId = 'opencode'
    }
}

async function saveAgent() {
    if (!agentForm.name.trim() || !agentForm.remoteId) {
        ElMessage.warning('请填写 Agent 名称并选择远端')
        return
    }
    if (
        agentForm.provider === 'gateway' &&
        (!agentForm.agentId.trim() || !agentForm.workspace.trim())
    ) {
        ElMessage.warning('ACP Agent 需要填写 Gateway Agent ID 和 Workspace')
        return
    }
    savingAgent.value = true
    try {
        const result = await send('agent-nexus/saveDelegationAgent', {
            ...(agentForm.id ? { id: agentForm.id } : {}),
            name: agentForm.name.trim(),
            provider: agentForm.provider,
            remoteId: agentForm.remoteId,
            agentId:
                agentForm.provider === 'gateway'
                    ? agentForm.agentId.trim()
                    : undefined,
            workspace:
                agentForm.provider === 'gateway'
                    ? agentForm.workspace.trim()
                    : undefined,
            description: agentForm.description.trim() || undefined,
            skills: agentForm.skills
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter(Boolean),
            enabled: agentForm.enabled
        })
        emit('updated', result.data)
        agentDialog.value = false
        ElMessage.success('委托 Agent 已保存')
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        savingAgent.value = false
    }
}

async function removeAgent(agent: DelegationAgentConfig) {
    try {
        await ElMessageBox.confirm(`确定删除 Agent“${agent.name}”吗？`, '删除 Agent', {
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            type: 'warning'
        })
        const data = await send('agent-nexus/removeDelegationAgent', agent.id)
        emit('updated', data)
        ElMessage.success('委托 Agent 已删除')
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    }
}

function openAddGateway() {
    Object.assign(gatewayForm, {
        id: '',
        name: '',
        baseUrl: '',
        authToken: '',
        clearAuthToken: false,
        enabled: true
    })
    gatewayDialog.value = true
}

function openEditGateway(gateway: GatewayRemoteConfig) {
    Object.assign(gatewayForm, {
        id: gateway.id,
        name: gateway.name,
        baseUrl: gateway.baseUrl,
        authToken: '',
        clearAuthToken: false,
        enabled: gateway.enabled
    })
    gatewayDialog.value = true
}

async function saveGateway() {
    if (!gatewayForm.name.trim() || !gatewayForm.baseUrl.trim()) {
        ElMessage.warning('请填写 Gateway 名称和 URL')
        return
    }
    savingGateway.value = true
    try {
        const result = await send('agent-nexus/saveGatewayRemote', {
            ...(gatewayForm.id ? { id: gatewayForm.id } : {}),
            name: gatewayForm.name.trim(),
            baseUrl: gatewayForm.baseUrl.trim(),
            authToken: gatewayForm.clearAuthToken
                ? undefined
                : gatewayForm.authToken || undefined,
            clearAuthToken: gatewayForm.clearAuthToken,
            enabled: gatewayForm.enabled
        })
        emit('updated', result.data)
        gatewayDialog.value = false
        ElMessage.success('Nexus Gateway 已保存')
        await discoverGatewayById(result.remoteId)
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        savingGateway.value = false
    }
}

async function removeGateway(gateway: GatewayRemoteConfig) {
    try {
        await ElMessageBox.confirm(
            `确定删除 Gateway“${gateway.name}”吗？引用它的 Agent 路由会显示为不可用。`,
            '删除 Gateway',
            {
                confirmButtonText: '删除',
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        const data = await send('agent-nexus/removeGatewayRemote', gateway.id)
        emit('updated', data)
        ElMessage.success('Nexus Gateway 已删除')
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    }
}

async function discoverGateway(gateway: GatewayRemoteConfig) {
    await discoverGatewayById(gateway.id)
}

async function discoverGatewayById(id: string) {
    discoveringGateways.value.add(id)
    try {
        const remote = await send('agent-nexus/discoverGatewayRemote', id)
        const data = await send('agent-nexus/getConsoleData')
        emit('updated', data)
        if (remote.state === 'ready') ElMessage.success('Gateway Agents 已更新')
        else ElMessage.error(remote.error || 'Gateway 发现失败')
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        discoveringGateways.value.delete(id)
    }
}

function openAddRemote() {
    Object.assign(remoteForm, {
        id: '',
        name: '',
        cardUrl: '',
        authToken: '',
        clearAuthToken: false,
        enabled: true,
        preferredTransport: ''
    })
    remoteDialog.value = true
}

function openEditRemote(remote: A2ARemoteConfig) {
    Object.assign(remoteForm, {
        id: remote.id,
        name: remote.name,
        cardUrl: agentCardUrl(remote),
        authToken: '',
        clearAuthToken: false,
        enabled: remote.enabled,
        preferredTransport: remote.preferredTransport || ''
    })
    remoteDialog.value = true
}

async function saveRemote() {
    if (!remoteForm.name.trim() || !remoteForm.cardUrl.trim()) {
        ElMessage.warning('请填写名称和 Agent Card URL')
        return
    }
    let target: { baseUrl: string; cardPath?: string }
    try {
        target = splitAgentCardUrl(remoteForm.cardUrl)
    } catch (error: any) {
        ElMessage.warning(error?.message || String(error))
        return
    }
    savingRemote.value = true
    try {
        const result = await send('agent-nexus/saveA2ARemote', {
            ...(remoteForm.id ? { id: remoteForm.id } : {}),
            name: remoteForm.name.trim(),
            baseUrl: target.baseUrl,
            cardPath: target.cardPath,
            authToken: remoteForm.clearAuthToken
                ? undefined
                : remoteForm.authToken || undefined,
            clearAuthToken: remoteForm.clearAuthToken,
            enabled: remoteForm.enabled,
            preferredTransport: remoteForm.preferredTransport || undefined,
            clearPreferredTransport: !remoteForm.preferredTransport
        })
        emit('updated', result.data)
        remoteDialog.value = false
        ElMessage.success('Agent Card 已保存')
        await discoverById(result.remoteId)
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        savingRemote.value = false
    }
}

async function removeRemote(remote: A2ARemoteConfig) {
    try {
        await ElMessageBox.confirm(`确定删除“${remote.name}”吗？`, '删除 Agent Card', {
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            type: 'warning'
        })
        const data = await send('agent-nexus/removeA2ARemote', remote.id)
        emit('updated', data)
        ElMessage.success('Agent Card 已删除')
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    }
}

async function discover(remote: A2ARemoteConfig) {
    await discoverById(remote.id)
}

async function discoverById(id: string) {
    discovering.value.add(id)
    try {
        const remote = await send('agent-nexus/discoverA2ARemote', id)
        const data = await send('agent-nexus/getConsoleData')
        emit('updated', data)
        if (remote.state === 'ready') ElMessage.success('Agent Card 已更新')
        else ElMessage.error(remote.error || 'Agent Card 发现失败')
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        discovering.value.delete(id)
    }
}

function openTask(remote: A2ARemoteConfig) {
    taskRemote.value = remote
    taskResult.value = undefined
    Object.assign(taskForm, {
        text: '',
        taskId: '',
        contextId: '',
        returnImmediately: false
    })
    taskDialog.value = true
}

async function sendTask() {
    if (!taskRemote.value || !taskForm.text.trim()) {
        ElMessage.warning('请输入任务内容')
        return
    }
    sendingTask.value = true
    try {
        taskResult.value = await send('agent-nexus/sendA2AMessage', {
            remoteId: taskRemote.value.id,
            text: taskForm.text.trim(),
            taskId: taskForm.taskId.trim() || undefined,
            contextId: taskForm.contextId.trim() || undefined,
            returnImmediately: taskForm.returnImmediately
        })
        taskForm.taskId = taskResult.value.taskId || ''
        taskForm.contextId = taskResult.value.contextId || ''
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        sendingTask.value = false
    }
}

async function refreshTask() {
    if (!taskRemote.value || !taskResult.value?.taskId || taskAction.value) return
    taskAction.value = 'refresh'
    try {
        taskResult.value = await send(
            'agent-nexus/getA2ATask',
            taskRemote.value.id,
            taskResult.value.taskId
        )
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        if (taskAction.value === 'refresh') taskAction.value = ''
    }
}

async function cancelTask() {
    if (!taskRemote.value || !taskResult.value?.taskId || taskAction.value) return
    taskAction.value = 'cancel'
    try {
        taskResult.value = await send(
            'agent-nexus/cancelA2ATask',
            taskRemote.value.id,
            taskResult.value.taskId
        )
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        if (taskAction.value === 'cancel') taskAction.value = ''
    }
}

function delegationState(agent: DelegationAgentConfig) {
    return (
        props.status.delegation.agents.find((item) => item.id === agent.id) || {
            state: 'unknown' as const,
            error: undefined
        }
    )
}

function delegationTarget(agent: DelegationAgentConfig) {
    if (agent.provider === 'a2a') {
        const remote = props.config.a2a.remotes.find(
            (item) => item.id === agent.remoteId
        )
        return remote ? `A2A · ${remote.name}` : `A2A · ${agent.remoteId}`
    }
    const remote = props.config.gateway.remotes.find(
        (item) => item.id === agent.remoteId
    )
    return `ACP · ${remote?.name || agent.remoteId} · ${agent.agentId || '未指定 Agent'}`
}

function gatewayState(gateway: GatewayRemoteConfig) {
    return (
        props.status.gateway.remotes.find((item) => item.id === gateway.id) || {
            id: gateway.id,
            name: gateway.name,
            baseUrl: gateway.baseUrl,
            enabled: gateway.enabled,
            state: 'unknown' as GatewayRemoteState,
            agents: []
        }
    )
}

function isGatewayDiscovering(id: string) {
    return discoveringGateways.value.has(id)
}

function isDiscovering(id: string) {
    return discovering.value.has(id)
}

function agentCardUrl(remote: A2ARemoteConfig) {
    try {
        return new URL(
            remote.cardPath?.trim() || DEFAULT_AGENT_CARD_PATH,
            `${remote.baseUrl.replace(/\/+$/, '')}/`
        ).toString()
    } catch {
        return `${remote.baseUrl.replace(/\/+$/, '')}${remote.cardPath || DEFAULT_AGENT_CARD_PATH}`
    }
}

function splitAgentCardUrl(value: string) {
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        throw new Error('Agent Card 地址必须是有效的 http(s) URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Agent Card 地址只支持 http 或 https')
    }
    if (url.username || url.password) {
        throw new Error('Agent Card 地址不能包含账号或密码')
    }
    url.hash = ''
    const baseOnly = (url.pathname === '/' || !url.pathname) && !url.search
    return {
        baseUrl: url.origin,
        cardPath: baseOnly ? undefined : `${url.pathname}${url.search}`
    }
}

function remoteState(remote: A2ARemoteConfig) {
    return (
        props.status.a2a.remotes.find((item) => item.id === remote.id) || {
            id: remote.id,
            name: remote.name,
            baseUrl: remote.baseUrl,
            enabled: remote.enabled,
            state: 'unknown' as const
        }
    )
}

function stateTagType(state: A2ARemoteState) {
    if (state === 'ready') return 'success'
    if (state === 'checking') return 'warning'
    if (state === 'error') return 'danger'
    return 'info'
}

function stateLabel(state: A2ARemoteState) {
    if (state === 'ready') return '可用'
    if (state === 'checking') return '发现中'
    if (state === 'error') return '异常'
    return '未发现'
}

function taskStateType(state: string) {
    if (state.endsWith('COMPLETED')) return 'success'
    if (state.endsWith('FAILED') || state.endsWith('REJECTED')) return 'danger'
    if (state.endsWith('CANCELED')) return 'info'
    return 'warning'
}

function taskStateLabel(state: string) {
    return state.replace(/^TASK_STATE_/, '').replaceAll('_', ' ')
}

function isTaskTerminal(state: string) {
    return /(COMPLETED|FAILED|CANCELED|REJECTED)$/.test(state)
}

</script>

<style scoped>
.a2a-panel {
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-width: 0;
}

.section {
    min-width: 0;
    padding: 4px 0 22px;
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
}

.section-head,
.heading-group,
.remote-title-row,
.remote-actions,
.result-head,
.result-actions {
    display: flex;
    align-items: center;
}

.section-head {
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
}

.heading-group,
.remote-title-row,
.remote-actions,
.result-actions {
    gap: 8px;
}

.section-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--k-text-dark);
}

.count {
    min-width: 24px;
    height: 24px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--k-color-primary), transparent 84%);
    color: var(--k-text-dark);
    font-size: 12px;
    line-height: 24px;
    text-align: center;
}

.dialog-grid,
.task-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 16px;
}

.setting {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
}

.field-label {
    font-size: 12px;
    font-weight: 650;
    color: var(--k-text-light);
}

.wide-setting {
    grid-column: 1 / -1;
}

.toggle-setting {
    align-items: flex-start;
    justify-content: space-between;
}

.empty-state {
    display: flex;
    min-height: 150px;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border: 1px dashed color-mix(in srgb, var(--k-color-divider), transparent 8%);
    border-radius: 6px;
    color: var(--k-text-light);
    font-size: 13px;
}

.empty-icon {
    width: 20px;
    height: 20px;
}

.remote-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.remote-row {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    padding: 14px 14px 14px 16px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 14%);
    border-radius: 6px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 28%);
}

.remote-primary {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    align-items: flex-start;
    gap: 12px;
}

.state-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    margin-top: 7px;
    border-radius: 50%;
    background: #8b949e;
}

.state-dot.ready {
    background: #25a268;
}

.state-dot.checking {
    background: #d79a2b;
}

.state-dot.error {
    background: #d65757;
}

.remote-copy {
    min-width: 0;
}

.remote-title-row strong {
    overflow-wrap: anywhere;
    color: var(--k-text-dark);
    font-size: 14px;
}

.remote-url,
.card-summary,
.remote-error {
    margin-top: 5px;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.5;
}

.remote-url,
.card-summary {
    color: var(--k-text-light);
}

.card-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 12px;
}

.remote-error {
    color: #d65757;
}

.skill-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 9px;
}

.skill-chip,
.skill-more {
    padding: 3px 7px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 12%);
    border-radius: 4px;
    color: var(--k-text-light);
    font-size: 11px;
}

.remote-actions {
    flex: 0 0 auto;
}

.full-width {
    width: 100%;
}

.task-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.task-result {
    min-width: 0;
    border-top: 1px solid var(--k-color-divider);
    padding-top: 14px;
}

.result-head {
    min-width: 0;
    justify-content: flex-start;
    gap: 10px;
}

.result-head code {
    min-width: 0;
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.result-actions {
    margin-left: auto;
}

.result-text {
    max-height: 280px;
    margin: 14px 0 0;
    overflow: auto;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 10%);
    border-radius: 6px;
    background: var(--k-page-bg);
    color: var(--k-text-dark);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.artifact-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 10px;
}

.artifact-row {
    display: grid;
    grid-template-columns: minmax(120px, 0.35fr) minmax(0, 1fr);
    gap: 12px;
    font-size: 12px;
}

.artifact-row a {
    color: var(--k-color-primary);
}

.artifact-text {
    overflow-wrap: anywhere;
    color: var(--k-text-light);
}

@media (max-width: 760px) {
    .dialog-grid,
    .task-options {
        grid-template-columns: 1fr;
    }

    .wide-setting {
        grid-column: auto;
    }

    .remote-row {
        align-items: stretch;
        flex-direction: column;
    }

    .remote-actions {
        justify-content: flex-end;
    }
}
</style>
