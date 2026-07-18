<template>
    <div class="computer-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">SSH Computer</div>
                <div class="panel-description">
                    管理远端机器。多台设备时，命令请写：
                    <code>nexus.hermes 设备名 任务</code>
                </div>
            </div>
            <div class="panel-actions">
                <el-tag size="small" effect="plain" :type="statusTagType">
                    {{ statusLabel }}
                </el-tag>
                <el-button size="small" @click="addComputer">添加设备</el-button>
            </div>
        </div>

        <section class="connection-card">
            <div v-if="creating" class="device-bar new-device-bar">
                <div>
                    <div class="field-label">正在添加新设备</div>
                    <div class="new-device-copy">
                        只有此模式会创建新设备。编辑已有设备请先从下拉列表选中，再点“保存当前设备并连接”。
                    </div>
                </div>
                <el-button size="small" @click="cancelAdd">取消</el-button>
            </div>
            <div v-else-if="config.hosts.length" class="device-bar">
                <div class="field-label">当前设备</div>
                <el-select v-model="selectedHostId" class="device-select">
                    <el-option
                        v-for="item in config.hosts"
                        :key="item.id"
                        :label="hostLabel(item)"
                        :value="item.id"
                    />
                </el-select>
                <el-tag v-if="isDefaultHost" size="small" effect="plain">默认</el-tag>
                <el-tag
                    v-if="hostStatus?.error"
                    size="small"
                    effect="plain"
                    type="danger"
                >
                    连接异常
                </el-tag>
            </div>

            <div class="connection-grid">
                <div class="field name-field">
                    <div class="field-label">设备名称</div>
                    <el-input
                        v-model="name"
                        placeholder="例如 build、开发机（多机命令前缀）"
                        clearable
                    />
                </div>
                <div class="field host-field">
                    <div class="field-label">主机地址</div>
                    <el-input v-model="host" placeholder="192.168.1.10" clearable />
                </div>
                <div class="field port-field">
                    <div class="field-label">端口</div>
                    <el-input-number v-model="port" :min="1" :max="65535" controls-position="right" />
                </div>
                <div class="field">
                    <div class="field-label">账号</div>
                    <el-input v-model="username" placeholder="root" clearable />
                </div>
                <div class="field">
                    <div class="field-label">认证方式</div>
                    <el-radio-group v-model="authType" class="auth-type">
                        <el-radio-button label="password">密码</el-radio-button>
                        <el-radio-button label="key">私钥</el-radio-button>
                    </el-radio-group>
                </div>
                <div v-if="authType === 'password'" class="field">
                    <div class="field-label">密码</div>
                    <el-input
                        v-model="password"
                        type="password"
                        show-password
                        :placeholder="hasSavedHost ? '留空保持原密码，支持 env:VAR' : 'SSH 密码或 env:VAR'"
                        @keyup.enter="connect"
                    />
                </div>
                <template v-else>
                    <div class="field key-field">
                        <div class="field-label">私钥</div>
                        <el-input
                            v-model="privateKey"
                            type="textarea"
                            :rows="3"
                            :placeholder="hasSavedHost ? '留空保持原私钥，或 env:SSH_KEY' : 'PEM 内容或 env:SSH_KEY'"
                        />
                    </div>
                    <div class="field">
                        <div class="field-label">Passphrase</div>
                        <el-input
                            v-model="passphrase"
                            type="password"
                            show-password
                            :placeholder="hasSavedHost ? '留空保持原 Passphrase' : '可选'"
                        />
                    </div>
                </template>
                <div class="field">
                    <div class="field-label">工作目录</div>
                    <el-input v-model="cwd" placeholder="可选，如 ~/projects" clearable />
                </div>
                <div class="field switch-field">
                    <div class="field-label">设为默认设备</div>
                    <el-switch v-model="asDefault" />
                </div>
            </div>

            <div v-if="hostStatus?.error" class="host-error-banner">
                {{ hostStatus.error }}
            </div>

            <div class="connection-footer">
                <div class="connection-copy">
                    设备名称会用于命令路由：
                    <code>nexus.hermes {{ nameHint }} 修 bug</code>
                    。Code Agent 默认非交互高权限运行。
                </div>
                <div class="connection-actions">
                    <el-button
                        v-if="!creating && selectedHostId"
                        type="danger"
                        plain
                        :disabled="connecting"
                        @click="$emit('remove', selectedHostId)"
                    >
                        删除设备
                    </el-button>
                    <el-button type="primary" :loading="connecting" @click="connect">
                        {{ creating ? '添加设备并连接' : '保存当前设备并连接' }}
                    </el-button>
                </div>
            </div>
        </section>

        <section class="agents-section">
            <div class="section-head">
                <div>
                    <div class="section-title">可用 Code Agents</div>
                    <div class="section-description">
                        连接成功后自动扫描。亮起的 Agent 会进入自动路由候选。
                    </div>
                </div>
                <div class="section-meta">{{ availableCount }}/{{ kinds.length }} 可用</div>
            </div>

            <div v-if="hostStatus?.environment" class="environment-summary">
                <span>
                    环境：{{ environmentLabel }} ·
                    {{ hostStatus.environment.shell || '默认 shell' }} ·
                    {{ hostStatus.environment.pathEntries }} 个 PATH 目录
                </span>
                <el-tag
                    size="small"
                    effect="plain"
                    :type="hostStatus.environment.source === 'interactive' ? 'success' : 'warning'"
                >
                    {{ hostStatus.environment.source === 'interactive' ? '交互环境已同步' : '环境已降级' }}
                </el-tag>
            </div>
            <div v-if="hostStatus?.environment?.warning" class="environment-warning">
                {{ hostStatus.environment.warning }}
            </div>

            <div class="agent-grid">
                <div
                    v-for="kind in kinds"
                    :key="kind"
                    class="agent-card"
                    :class="{ available: agent(kind)?.installed }"
                >
                    <div class="agent-top">
                        <span class="status-dot" />
                        <span class="agent-name">{{ labels[kind] }}</span>
                        <el-tag size="small" effect="plain" :type="agent(kind)?.installed ? 'success' : 'info'">
                            {{ !isScanned(kind) ? '等待扫描' : agent(kind)?.installed ? '已安装' : '未安装' }}
                        </el-tag>
                    </div>
                    <div class="agent-version">
                        {{ agent(kind)?.version || (isScanned(kind) ? '未安装' : '等待扫描') }}
                    </div>
                    <div class="agent-latest">
                        最新：{{ agent(kind)?.latestVersion || (agent(kind)?.maintenanceError ? '检查失败' : '等待检查') }}
                    </div>
                    <div class="agent-path">{{ agent(kind)?.path || 'PATH 中未找到可执行文件' }}</div>
                    <div class="agent-actions">
                        <span class="maintenance-method">
                            {{ agent(kind)?.maintenanceMethod || '官方安装渠道' }}
                        </span>
                        <el-button
                            size="small"
                            :type="agent(kind)?.installed && agent(kind)?.updateAvailable ? 'warning' : 'primary'"
                            :plain="agent(kind)?.installed"
                            :disabled="!connected || !isScanned(kind) || (agent(kind)?.installed && agent(kind)?.updateAvailable !== true)"
                            :loading="maintaining.includes(maintenanceKey(kind))"
                            @click="maintain(kind)"
                        >
                            {{ maintenanceLabel(kind) }}
                        </el-button>
                    </div>
                </div>
            </div>

            <div v-if="connected && !availableCount" class="scan-hint">
                SSH 已连接，但没有在远端 PATH 中发现支持的 Code Agent。
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { AgentKind, NexusConfig, NexusStatus, SshAuth, SshHostConfig } from '../../src/types'

export type ComputerConnectInput = {
    id?: string
    name: string
    host: string
    port: number
    username: string
    auth?: SshAuth
    cwd?: string
    setAsDefault?: boolean
}

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
    connecting: boolean
    maintaining: string[]
}>()

const emit = defineEmits<{
    connect: [input: ComputerConnectInput, done: (hostId: string) => void]
    remove: [hostId: string]
    maintain: [input: { hostId: string; kind: AgentKind }]
}>()

const kinds: AgentKind[] = ['hermes', 'openclaw', 'claude', 'opencode', 'codex']
const labels: Record<AgentKind, string> = {
    hermes: 'Hermes',
    openclaw: 'OpenClaw',
    claude: 'Claude Code',
    opencode: 'OpenCode',
    codex: 'Codex'
}
const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('root')
const password = ref('')
const privateKey = ref('')
const passphrase = ref('')
const cwd = ref('')
const authType = ref<'password' | 'key'>('password')
const asDefault = ref(false)
const selectedHostId = ref('')
const creating = ref(false)

watch(
    () => props.config.hosts,
    (hosts) => {
        if (creating.value) return
        if (selectedHostId.value && hosts.some((item) => item.id === selectedHostId.value)) {
            return
        }
        selectedHostId.value =
            hosts.find((item) => item.id === props.config.defaultHostId)?.id ||
            hosts[0]?.id ||
            ''
    },
    { immediate: true, deep: true }
)

watch(
    selectedHostId,
    (id) => {
        if (creating.value) return
        const value = props.config.hosts.find((item) => item.id === id)
        name.value = value?.name || ''
        host.value = value?.host || ''
        port.value = value?.port || 22
        username.value = value?.username || 'root'
        cwd.value = value?.cwd || ''
        authType.value = value?.auth?.type === 'key' ? 'key' : 'password'
        password.value = ''
        privateKey.value = ''
        passphrase.value = ''
        asDefault.value = !!id && id === props.config.defaultHostId
    },
    { immediate: true }
)

const hasSavedHost = computed(() =>
    !creating.value && props.config.hosts.some((item) => item.id === selectedHostId.value)
)
const isDefaultHost = computed(() => selectedHostId.value === props.config.defaultHostId)
const hostStatus = computed(() =>
    props.status.hosts.find((item) => item.id === selectedHostId.value)
)
const availableCount = computed(() => kinds.filter((kind) => agent(kind)?.installed).length)
const connected = computed(() => hostStatus.value?.state === 'connected')
const nameHint = computed(() => name.value.trim() || '设备名')
const statusLabel = computed(() => {
    if (props.connecting) return '连接中'
    if (hostStatus.value?.state === 'connecting') return '连接中'
    if (hostStatus.value?.state === 'connected') return '已连接'
    if (hostStatus.value?.state === 'error') return '连接失败'
    if (hasSavedHost.value) return '已保存'
    return '未连接'
})
const statusTagType = computed(() => {
    if (props.connecting || hostStatus.value?.state === 'connecting') return 'warning'
    if (hostStatus.value?.state === 'connected') return 'success'
    if (hostStatus.value?.state === 'error') return 'danger'
    return 'info'
})
const environmentLabel = computed(() => {
    if (hostStatus.value?.environment?.source === 'interactive') return 'interactive'
    if (hostStatus.value?.environment?.source === 'noninteractive') return 'non-interactive fallback'
    return 'fallback'
})

function agent(kind: AgentKind) {
    return hostStatus.value?.agents.find((item) => item.kind === kind)
}

function maintenanceKey(kind: AgentKind) {
    return `${selectedHostId.value}:${kind}`
}

function maintenanceLabel(kind: AgentKind) {
    const value = agent(kind)
    if (!value?.installed) return '一键安装'
    if (value.updateAvailable === true) return '更新'
    if (value.updateAvailable === undefined && !value.maintenanceError) {
        return '版本未知'
    }
    if (value.maintenanceError) return '无法检查更新'
    return '已是最新'
}

function isScanned(kind: AgentKind) {
    const value = agent(kind)
    return Boolean(
        value?.installed ||
            value?.latestVersion ||
            value?.maintenanceError
    )
}

function maintain(kind: AgentKind) {
    if (!selectedHostId.value) return
    emit('maintain', { hostId: selectedHostId.value, kind })
}

function hostLabel(item: SshHostConfig) {
    const suffix = item.id === props.config.defaultHostId ? ' · 默认' : ''
    return `${item.name || item.host} (${item.username}@${item.host}:${item.port || 22})${suffix}`
}

function addComputer() {
    creating.value = true
    name.value = ''
    host.value = ''
    port.value = 22
    username.value = 'root'
    password.value = ''
    privateKey.value = ''
    passphrase.value = ''
    cwd.value = ''
    authType.value = 'password'
    asDefault.value = props.config.hosts.length === 0
}

function cancelAdd() {
    creating.value = false
    selectedHostId.value =
        props.config.hosts.find((item) => item.id === props.config.defaultHostId)?.id ||
        props.config.hosts[0]?.id ||
        ''
}

function connect() {
    const deviceName = name.value.trim()
    if (!deviceName || !host.value.trim() || !username.value.trim()) {
        ElMessage.warning('请填写设备名称、主机地址和账号')
        return
    }

    // Editing requires an existing selection. New devices only via "添加设备".
    const editingId = creating.value ? '' : selectedHostId.value
    if (!creating.value && !editingId) {
        ElMessage.warning('请先选择已有设备，或点击右上角“添加设备”')
        return
    }

    const duplicate = props.config.hosts.some(
        (item) =>
            item.id !== (editingId || undefined) &&
            item.name.trim().toLowerCase() === deviceName.toLowerCase()
    )
    if (duplicate) {
        ElMessage.warning(
            creating.value
                ? `设备名称“${deviceName}”已存在。如需修改该设备，请先从列表选中它，不要用添加模式覆盖。`
                : `设备名称“${deviceName}”已存在，请换一个唯一名称`
        )
        return
    }

    if (creating.value) {
        if (authType.value === 'password' && !password.value) {
            ElMessage.warning('请填写 SSH 密码')
            return
        }
        if (authType.value === 'key' && !privateKey.value.trim()) {
            ElMessage.warning('请填写 SSH 私钥或 env:VAR')
            return
        }
    }

    let auth: SshAuth | undefined
    if (authType.value === 'password') {
        if (password.value || creating.value) {
            auth = { type: 'password', password: password.value }
        }
    } else if (privateKey.value.trim() || creating.value) {
        auth = {
            type: 'key',
            privateKey: privateKey.value,
            passphrase: passphrase.value || undefined
        }
    }

    emit(
        'connect',
        {
            // Only omit id in explicit create mode.
            ...(creating.value ? {} : { id: editingId }),
            name: deviceName,
            host: host.value.trim(),
            port: port.value || 22,
            username: username.value.trim(),
            auth,
            cwd: cwd.value.trim() || undefined,
            setAsDefault: asDefault.value
        },
        (hostId) => {
            creating.value = false
            selectedHostId.value = hostId
            password.value = ''
            privateKey.value = ''
            passphrase.value = ''
        }
    )
}
</script>

<style scoped>
.computer-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.panel-head,
.section-head,
.connection-footer,
.agent-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}

.panel-actions,
.connection-actions,
.device-bar {
    display: flex;
    align-items: center;
    gap: 10px;
}

.panel-title,
.section-title {
    font-weight: 650;
    color: var(--k-text-dark);
}

.panel-title {
    font-size: 18px;
}

.section-title {
    font-size: 15px;
}

.panel-description,
.section-description,
.connection-copy,
.scan-hint,
.agent-version,
.agent-latest,
.agent-path,
.section-meta,
.new-device-copy {
    font-size: 13px;
    line-height: 1.55;
    color: var(--k-text-light);
}

.panel-description,
.section-description {
    margin-top: 5px;
}

.panel-description code,
.connection-copy code {
    padding: 1px 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--k-page-bg), transparent 10%);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    color: var(--k-text-dark);
}

.connection-card,
.agents-section,
.agent-card {
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
}

.connection-grid {
    display: grid;
    grid-template-columns: minmax(160px, 0.9fr) minmax(180px, 1.2fr) 120px minmax(150px, 0.8fr) minmax(200px, 1fr);
    gap: 16px;
    padding: 20px;
}

.device-bar {
    padding: 14px 20px;
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 28%);
}

.device-bar .field-label {
    margin: 0;
    white-space: nowrap;
}

.new-device-bar {
    justify-content: space-between;
}

.device-select {
    width: min(100%, 480px);
}

.field {
    min-width: 0;
}

.field-label {
    margin-bottom: 7px;
    font-size: 12px;
    font-weight: 650;
    color: var(--k-text-dark);
}

.port-field :deep(.el-input-number),
.auth-type {
    width: 100%;
}

.key-field {
    grid-column: span 2;
}

.switch-field {
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.host-error-banner {
    margin: 0 20px 14px;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--el-color-danger-light-9), transparent 10%);
    color: var(--el-color-danger);
    font-size: 12px;
    line-height: 1.5;
}

.connection-footer {
    padding: 14px 20px;
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 28%);
}

.connection-copy {
    margin: 0;
}

.agents-section {
    padding: 20px;
}

.agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 12px;
    margin-top: 16px;
}

.agent-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 14px;
    opacity: 0.58;
    transition: 0.18s ease;
}

.agent-card.available {
    opacity: 1;
    border-color: color-mix(in srgb, var(--el-color-success), transparent 45%);
    background: color-mix(in srgb, var(--el-color-success-light-9), transparent 12%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--el-color-success), transparent 78%);
}

.status-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--k-text-light);
}

.available .status-dot {
    background: var(--el-color-success);
    box-shadow: 0 0 8px color-mix(in srgb, var(--el-color-success), transparent 30%);
}

.agent-top {
    justify-content: flex-start;
}

.agent-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 650;
    color: var(--k-text-dark);
}

.agent-version,
.agent-latest,
.agent-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 4px;
}

.maintenance-method {
    min-width: 0;
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-path {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
}

.scan-hint {
    margin-top: 14px;
}

.environment-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--k-page-bg), transparent 28%);
    color: var(--k-text-light);
    font-size: 12px;
}

.environment-warning {
    margin-top: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--el-color-warning-light-9), transparent 8%);
    color: var(--el-color-warning-dark-2);
    font-size: 12px;
    line-height: 1.5;
}

@media (max-width: 980px) {
    .connection-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .name-field,
    .key-field {
        grid-column: 1 / -1;
    }
}

@media (max-width: 640px) {
    .panel-head,
    .section-head,
    .connection-footer {
        align-items: flex-start;
        flex-direction: column;
    }

    .panel-actions,
    .connection-actions,
    .device-bar {
        align-items: stretch;
        flex-direction: column;
        width: 100%;
    }

    .device-select,
    .connection-actions :deep(.el-button) {
        width: 100%;
    }

    .connection-grid {
        grid-template-columns: 1fr;
    }

    .connection-footer :deep(.el-button) {
        width: 100%;
    }
}
</style>
