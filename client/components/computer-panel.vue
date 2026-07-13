<template>
    <div class="computer-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">SSH Computer</div>
                <div class="panel-description">
                    连接一台远端机器，AgentNexus 会自动发现可用的 Code Agent。
                </div>
            </div>
            <el-tag size="small" effect="plain" :type="statusTagType">
                {{ statusLabel }}
            </el-tag>
        </div>

        <section class="connection-card">
            <div class="connection-grid">
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
                    <div class="field-label">密码</div>
                    <el-input
                        v-model="password"
                        type="password"
                        show-password
                        :placeholder="hasSavedHost ? '留空保持原密码' : 'SSH 密码'"
                        @keyup.enter="connect"
                    />
                </div>
            </div>

            <div class="connection-footer">
                <div class="connection-copy">
                    Code Agent 默认以非交互最高权限运行，并跳过确认与沙箱限制。
                </div>
                <el-button type="primary" :loading="connecting" @click="connect">
                    {{ connected ? '重新连接并扫描' : '连接并扫描' }}
                </el-button>
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
                            {{ agent(kind)?.installed ? '已安装' : '未发现' }}
                        </el-tag>
                    </div>
                    <div class="agent-version">{{ agent(kind)?.version || '等待扫描' }}</div>
                    <div class="agent-path">{{ agent(kind)?.path || 'PATH 中未找到可执行文件' }}</div>
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
import type { AgentKind, NexusConfig, NexusStatus } from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
    connecting: boolean
}>()

const emit = defineEmits<{
    connect: [input: { host: string; port: number; username: string; password: string }]
}>()

const kinds: AgentKind[] = ['hermes', 'openclaw', 'claude', 'opencode', 'codex']
const labels: Record<AgentKind, string> = {
    hermes: 'Hermes',
    openclaw: 'OpenClaw',
    claude: 'Claude Code',
    opencode: 'OpenCode',
    codex: 'Codex'
}
const host = ref('')
const port = ref(22)
const username = ref('root')
const password = ref('')

watch(
    () => props.config.hosts[0],
    (value) => {
        host.value = value?.host || ''
        port.value = value?.port || 22
        username.value = value?.username || 'root'
        password.value = ''
    },
    { immediate: true }
)

const hasSavedHost = computed(() => !!props.config.hosts[0])
const hostStatus = computed(() => props.status.hosts[0])
const availableCount = computed(() => kinds.filter((kind) => agent(kind)?.installed).length)
const connected = computed(() => !!hostStatus.value?.sessionCount || availableCount.value > 0)
const statusLabel = computed(() => {
    if (props.connecting) return '连接中'
    if (connected.value) return '已连接'
    if (hasSavedHost.value) return '已保存'
    return '未连接'
})
const statusTagType = computed(() => {
    if (props.connecting) return 'warning'
    if (connected.value) return 'success'
    return 'info'
})

function agent(kind: AgentKind) {
    return hostStatus.value?.agents.find((item) => item.kind === kind)
}

function connect() {
    if (!host.value.trim() || !username.value.trim()) {
        ElMessage.warning('请填写主机地址和账号')
        return
    }
    emit('connect', {
        host: host.value.trim(),
        port: port.value || 22,
        username: username.value.trim(),
        password: password.value
    })
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
.agent-path,
.section-meta {
    font-size: 13px;
    line-height: 1.55;
    color: var(--k-text-light);
}

.panel-description,
.section-description {
    margin-top: 5px;
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
    grid-template-columns: minmax(180px, 1.3fr) 120px minmax(150px, 0.8fr) minmax(200px, 1fr);
    gap: 16px;
    padding: 20px;
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

.port-field :deep(.el-input-number) {
    width: 100%;
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
.agent-path {
    overflow: hidden;
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

@media (max-width: 980px) {
    .connection-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 640px) {
    .panel-head,
    .section-head,
    .connection-footer {
        align-items: flex-start;
        flex-direction: column;
    }

    .connection-grid {
        grid-template-columns: 1fr;
    }

    .connection-footer :deep(.el-button) {
        width: 100%;
    }
}
</style>
