<template>
    <div class="computer-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">SSH Computer</div>
                <div class="panel-description">
                    管理远端机器，用于 Agent 安装、Skills、SFTP 和终端。
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
                        placeholder="例如 build、开发机"
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
                    <div class="field-label">SSH 主机密钥</div>
                    <el-select v-model="hostKeyPolicy">
                        <el-option label="首次信任并固定" value="accept-new" />
                        <el-option label="严格校验" value="strict" />
                        <el-option label="不校验（不推荐）" value="insecure" />
                    </el-select>
                </div>
                <div class="field key-field">
                    <div class="field-label">SHA-256 指纹</div>
                    <el-input
                        v-model="hostKeyFingerprint"
                        clearable
                        placeholder="SHA256:...；首次信任模式可留空"
                    />
                </div>
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
                    设备名称用于 Computer、Skills、文件和终端页面中的主机选择。
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
                        连接成功后自动扫描；未安装的 Agent 可在这里一键安装。
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
                        {{ isScanned(kind) ? (agent(kind)?.installed ? '已探测到可执行文件' : '未安装') : '等待扫描' }}
                    </div>
                    <div class="agent-path">{{ agent(kind)?.path || 'PATH 中未找到可执行文件' }}</div>
                    <div class="agent-actions">
                        <el-button
                            size="small"
                            type="primary"
                            :disabled="!connected || !isScanned(kind) || agent(kind)?.installed"
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

        <section class="agentd-section">
            <div class="section-head">
                <div>
                    <div class="section-title">ACP Gateway</div>
                    <div class="section-description">nexus-agentd · Linux/systemd</div>
                </div>
                <el-tag size="small" effect="plain" :type="agentdTagType">
                    {{ agentdStateLabel }}
                </el-tag>
            </div>

            <div v-if="managedGateway" class="agentd-summary">
                <div class="agentd-address">
                    <span class="field-label">Gateway</span>
                    <code>{{ managedGateway.baseUrl }}</code>
                </div>
                <div class="agentd-meta">
                    <el-tag size="small" effect="plain">
                        {{ managedGateway.managedServiceMode === 'user' ? '用户服务' : '系统服务' }}
                    </el-tag>
                    <el-tag
                        v-for="item in managedGatewayStatus?.agents || []"
                        :key="item.id"
                        size="small"
                        effect="plain"
                        :type="item.ready ? 'success' : 'danger'"
                    >
                        {{ item.name }}
                    </el-tag>
                </div>
                <div v-if="managedGatewayStatus?.error" class="agentd-error">
                    {{ managedGatewayStatus.error }}
                </div>
            </div>

            <div
                v-if="currentAgentdProgress && (isDeployingAgentd || currentAgentdProgress.state === 'error')"
                class="agentd-progress-block"
            >
                <div class="agentd-progress-head">
                    <span>{{ currentAgentdProgress.label }}</span>
                    <span>{{ agentdProgressElapsed }}</span>
                </div>
                <el-progress
                    :percentage="currentAgentdProgress.percent"
                    :status="agentdProgressStatus"
                    :stroke-width="8"
                />
                <div v-if="currentAgentdProgress.error" class="agentd-error">
                    {{ currentAgentdProgress.error }}
                </div>
            </div>

            <div class="agentd-actions">
                <el-button
                    type="primary"
                    :disabled="!connected || !availableAcpKinds.length"
                    :loading="isDeployingAgentd"
                    @click="openAgentdDialog"
                >
                    {{ managedGateway ? '重新配置' : '部署 ACP 网关' }}
                </el-button>
                <el-button v-if="managedGateway" @click="$emit('open-acp')">
                    查看委托 Agent
                </el-button>
            </div>
        </section>

        <el-dialog
            v-model="agentdDialog"
            :title="managedGateway ? '重新配置 ACP Gateway' : '部署 ACP Gateway'"
            width="min(640px, 92vw)"
            destroy-on-close
        >
            <div class="agentd-dialog-grid">
                <label class="field">
                    <span class="field-label">监听端口</span>
                    <el-input-number
                        v-model="agentdForm.port"
                        :min="1"
                        :max="65535"
                        :disabled="isDeployingAgentd"
                        controls-position="right"
                    />
                </label>
                <label class="field workspace-field">
                    <span class="field-label">Workspace 根目录</span>
                    <el-input
                        v-model="agentdForm.workspaceRoots"
                        type="textarea"
                        :rows="3"
                        :disabled="isDeployingAgentd"
                        placeholder="每行一个目录"
                    />
                </label>
                <div class="field workspace-field">
                    <span class="field-label">启用 ACP Agent</span>
                    <el-checkbox-group
                        v-model="agentdForm.agents"
                        class="agentd-agent-options"
                        :disabled="isDeployingAgentd"
                    >
                        <el-checkbox
                            v-for="kind in acpKinds"
                            :key="kind"
                            :label="kind"
                            :disabled="!agent(kind)?.installed"
                        >
                            {{ labels[kind] }}
                        </el-checkbox>
                    </el-checkbox-group>
                </div>
                <label class="field auto-route-field">
                    <span class="field-label">自动创建委托 Agent</span>
                    <el-switch
                        v-model="agentdForm.createDelegationAgents"
                        :disabled="isDeployingAgentd"
                    />
                </label>
                <div
                    v-if="currentAgentdProgress && (isDeployingAgentd || currentAgentdProgress.state === 'error')"
                    class="agentd-dialog-progress"
                >
                    <div class="agentd-progress-head">
                        <span>{{ currentAgentdProgress.label }}</span>
                        <span>{{ agentdProgressElapsed }}</span>
                    </div>
                    <el-progress
                        :percentage="currentAgentdProgress.percent"
                        :status="agentdProgressStatus"
                        :stroke-width="8"
                    />
                    <div v-if="currentAgentdProgress.error" class="agentd-error">
                        {{ currentAgentdProgress.error }}
                    </div>
                </div>
            </div>
            <template #footer>
                <el-button @click="agentdDialog = false">取消</el-button>
                <el-button
                    type="primary"
                    :loading="isDeployingAgentd"
                    @click="submitAgentdDeployment"
                >
                    部署
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type {
    AgentKind,
    AgentdAgentKind,
    AgentdDeploymentInput,
    AgentdDeploymentProgress,
    NexusConfig,
    NexusStatus,
    SshAuth,
    SshHostKeyPolicy,
    SshHostConfig
} from '../../src/types'

export type ComputerConnectInput = {
    id?: string
    name: string
    host: string
    port: number
    username: string
    auth?: SshAuth
    hostKeyPolicy: SshHostKeyPolicy
    hostKeyFingerprint?: string
    cwd?: string
    setAsDefault?: boolean
}

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
    connecting: boolean
    maintaining: string[]
    deployingAgentd: string[]
    agentdProgress: Record<string, AgentdDeploymentProgress>
}>()

const emit = defineEmits<{
    connect: [input: ComputerConnectInput, done: (hostId: string) => void]
    remove: [hostId: string]
    maintain: [input: { hostId: string; kind: AgentKind }]
    deployAgentd: [input: AgentdDeploymentInput, done: () => void]
    'open-acp': []
}>()

const kinds: AgentKind[] = [
    'hermes',
    'openclaw',
    'claude',
    'opencode',
    'codex',
    'pi'
]
const labels: Record<AgentKind, string> = {
    hermes: 'Hermes',
    openclaw: 'OpenClaw',
    claude: 'Claude Code',
    opencode: 'OpenCode',
    codex: 'Codex',
    pi: 'Pi'
}
const acpKinds: AgentdAgentKind[] = ['openclaw', 'claude', 'opencode', 'codex', 'pi']
const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('root')
const password = ref('')
const privateKey = ref('')
const passphrase = ref('')
const hostKeyPolicy = ref<SshHostKeyPolicy>('accept-new')
const hostKeyFingerprint = ref('')
const cwd = ref('')
const authType = ref<'password' | 'key'>('password')
const asDefault = ref(false)
const selectedHostId = ref('')
const creating = ref(false)
const agentdDialog = ref(false)
const agentdForm = reactive({
    port: 8787,
    workspaceRoots: '',
    agents: [] as AgentdAgentKind[],
    createDelegationAgents: true
})

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
        hostKeyPolicy.value = value?.hostKeyPolicy || 'accept-new'
        hostKeyFingerprint.value = value?.hostKeyFingerprint || ''
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
const availableAcpKinds = computed(() =>
    acpKinds.filter((kind) => agent(kind)?.installed)
)
const managedGateway = computed(() =>
    props.config.gateway.remotes.find(
        (remote) => remote.managedHostId === selectedHostId.value
    )
)
const managedGatewayStatus = computed(() =>
    props.status.gateway.remotes.find(
        (remote) => remote.id === managedGateway.value?.id
    )
)
const currentAgentdProgress = computed(
    () => props.agentdProgress[selectedHostId.value]
)
const isDeployingAgentd = computed(
    () =>
        props.deployingAgentd.includes(selectedHostId.value) ||
        currentAgentdProgress.value?.state === 'running'
)
const agentdProgressStatus = computed(() => {
    if (currentAgentdProgress.value?.state === 'error') return 'exception'
    if (currentAgentdProgress.value?.state === 'success') return 'success'
    return undefined
})
const agentdProgressElapsed = computed(() => {
    const progress = currentAgentdProgress.value
    if (!progress) return ''
    const seconds = Math.max(
        0,
        Math.round((progress.updatedAt - progress.startedAt) / 1000)
    )
    if (seconds < 60) return `${seconds} 秒`
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
})
const agentdStateLabel = computed(() => {
    if (isDeployingAgentd.value) return '部署中'
    if (currentAgentdProgress.value?.state === 'error') return '部署失败'
    if (!managedGateway.value) return '未部署'
    if (managedGatewayStatus.value?.state === 'ready') return '在线'
    if (managedGatewayStatus.value?.state === 'checking') return '检查中'
    if (managedGatewayStatus.value?.state === 'error') return '异常'
    return '已配置'
})
const agentdTagType = computed(() => {
    if (isDeployingAgentd.value || managedGatewayStatus.value?.state === 'checking') return 'warning'
    if (currentAgentdProgress.value?.state === 'error') return 'danger'
    if (managedGatewayStatus.value?.state === 'ready') return 'success'
    if (managedGatewayStatus.value?.state === 'error') return 'danger'
    return 'info'
})
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
    return '已安装'
}

function isScanned(kind: AgentKind) {
    const value = agent(kind)
    return Boolean(
        value?.scanned || value?.installed
    )
}

function maintain(kind: AgentKind) {
    if (!selectedHostId.value) return
    emit('maintain', { hostId: selectedHostId.value, kind })
}

function openAgentdDialog() {
    if (!selectedHostId.value || !connected.value) return
    const gateway = managedGateway.value
    let port = 8787
    if (gateway?.baseUrl) {
        try {
            port = Number(new URL(gateway.baseUrl).port) || 8787
        } catch {}
    }
    const host = props.config.hosts.find((item) => item.id === selectedHostId.value)
    agentdForm.port = port
    agentdForm.workspaceRoots = (
        gateway?.managedWorkspaceRoots?.length
            ? gateway.managedWorkspaceRoots
            : [host?.cwd || '~/projects']
    ).join('\n')
    agentdForm.agents = gateway?.managedAgents?.length
        ? gateway.managedAgents.filter((kind) => acpKinds.includes(kind))
        : managedGatewayStatus.value?.agents.length
        ? managedGatewayStatus.value.agents
              .map((item) => item.id)
              .filter((kind): kind is AgentdAgentKind => acpKinds.includes(kind as AgentdAgentKind))
        : [...availableAcpKinds.value]
    agentdForm.createDelegationAgents = true
    agentdDialog.value = true
}

function submitAgentdDeployment() {
    if (!selectedHostId.value) return
    const workspaceRoots = agentdForm.workspaceRoots
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    if (!workspaceRoots.length) {
        ElMessage.warning('请填写至少一个 Workspace 根目录')
        return
    }
    if (!agentdForm.agents.length) {
        ElMessage.warning('请至少选择一个已安装的 ACP Agent')
        return
    }
    emit(
        'deployAgentd',
        {
            hostId: selectedHostId.value,
            port: agentdForm.port,
            workspaceRoots,
            agents: [...agentdForm.agents],
            createDelegationAgents: agentdForm.createDelegationAgents
        },
        () => {
            agentdDialog.value = false
        }
    )
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
    hostKeyPolicy.value = 'accept-new'
    hostKeyFingerprint.value = ''
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
    if (hostKeyPolicy.value === 'strict' && !hostKeyFingerprint.value.trim()) {
        ElMessage.warning('严格校验需要填写 SSH SHA-256 主机指纹')
        return
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
            hostKeyPolicy: hostKeyPolicy.value,
            hostKeyFingerprint: hostKeyFingerprint.value.trim() || undefined,
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
.agentd-section,
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

.agentd-section {
    padding: 20px;
}

.agentd-summary {
    display: grid;
    gap: 10px;
    margin-top: 16px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 28%);
    border-radius: 8px;
}

.agentd-address,
.agentd-meta,
.agentd-actions,
.agentd-agent-options {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}

.agentd-address .field-label {
    margin: 0;
}

.agentd-address code {
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
}

.agentd-error {
    color: var(--el-color-danger);
    font-size: 12px;
    line-height: 1.5;
}

.agentd-progress-block,
.agentd-dialog-progress {
    display: grid;
    gap: 8px;
    margin-top: 16px;
}

.agentd-dialog-progress {
    grid-column: 1 / -1;
    padding-top: 4px;
}

.agentd-progress-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--k-text-dark);
    font-size: 13px;
}

.agentd-actions {
    margin-top: 16px;
}

.agentd-dialog-grid {
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    gap: 18px;
}

.workspace-field {
    grid-column: 1 / -1;
}

.auto-route-field {
    display: flex;
    flex-direction: column;
    justify-content: center;
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

    .agentd-dialog-grid {
        grid-template-columns: 1fr;
    }

    .workspace-field {
        grid-column: auto;
    }

    .connection-footer :deep(.el-button) {
        width: 100%;
    }
}
</style>
