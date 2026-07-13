<template>
    <div class="computer-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">SSH Computer</div>
                <div class="panel-description">
                    连接一台远端机器，AgentNexus 会自动发现可用的 Code Agent。
                </div>
            </div>
            <el-tag
                size="small"
                effect="plain"
                :type="connected ? 'success' : 'info'"
            >
                {{ connected ? '已连接' : '未连接' }}
            </el-tag>
        </div>

        <section class="connection-card">
            <div class="connection-grid">
                <div class="field host-field">
                    <div class="field-label">主机地址</div>
                    <el-input v-model="host" placeholder="192.168.1.10" />
                </div>
                <div class="field port-field">
                    <div class="field-label">端口</div>
                    <el-input-number v-model="port" :min="1" :max="65535" />
                </div>
                <div class="field">
                    <div class="field-label">账号</div>
                    <el-input v-model="username" placeholder="root" />
                </div>
                <div class="field">
                    <div class="field-label">密码</div>
                    <el-input
                        v-model="password"
                        type="password"
                        show-password
                        :placeholder="hasSavedHost ? '留空保持原密码' : 'SSH 密码或 env:VAR'"
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
            </div>

            <div class="agent-tags">
                <div
                    v-for="kind in kinds"
                    :key="kind"
                    class="agent-tag"
                    :class="{ available: agent(kind)?.installed }"
                >
                    <span class="status-dot" />
                    <span class="agent-name">{{ labels[kind] }}</span>
                    <span class="agent-version">{{ agent(kind)?.version || '未发现' }}</span>
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
const connected = computed(() => !!hostStatus.value?.sessionCount || availableCount.value > 0)
const availableCount = computed(() => kinds.filter((kind) => agent(kind)?.installed).length)

function agent(kind: AgentKind) {
    return hostStatus.value?.agents.find((item) => item.kind === kind)
}

function connect() {
    if (!host.value.trim() || !username.value.trim()) return
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
    gap: 24px;
}

.panel-head,
.section-head,
.connection-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
}

.panel-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.panel-description,
.section-description,
.connection-copy,
.scan-hint {
    margin-top: 5px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--k-text-light);
}

.connection-card,
.agents-section {
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
    font-weight: 600;
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

.section-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.agent-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 18px;
}

.agent-tag {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 150px;
    padding: 11px 13px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 25%);
    border-radius: 12px;
    background: color-mix(in srgb, var(--k-page-bg), transparent 12%);
    opacity: 0.48;
    transition: 0.2s ease;
}

.agent-tag.available {
    border-color: color-mix(in srgb, var(--el-color-success), transparent 45%);
    background: color-mix(in srgb, var(--el-color-success-light-9), transparent 15%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--el-color-success), transparent 78%);
    opacity: 1;
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

.agent-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.agent-version {
    margin-left: auto;
    max-width: 110px;
    overflow: hidden;
    font-size: 11px;
    color: var(--k-text-light);
    text-overflow: ellipsis;
    white-space: nowrap;
}

@media (max-width: 980px) {
    .connection-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 640px) {
    .panel-head,
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

    .agent-tag {
        width: 100%;
    }
}
</style>
