<template>
    <div class="a2a-panel">
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
                        <el-tooltip content="发送任务" placement="top">
                            <el-button
                                circle
                                size="small"
                                type="primary"
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
            :title="`A2A · ${taskRemote?.name || ''}`"
            width="min(760px, 94vw)"
            destroy-on-close
        >
            <div class="task-form">
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
import { reactive, ref } from 'vue'
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

const taskForm = reactive({
    text: '',
    taskId: '',
    contextId: '',
    returnImmediately: false
})

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
