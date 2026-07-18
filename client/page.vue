<template>
    <div class="nexus-page">
        <div class="hero">
            <div class="hero-copy">
                <div class="title-row">
                    <div class="title">AgentNexus</div>
                    <el-tag size="small" effect="plain" :type="overview.connected ? 'success' : 'info'">
                        {{ overview.connected ? 'SSH 就绪' : '待连接' }}
                    </el-tag>
                </div>
                <div class="subtitle">
                    SSH Code Agent 网关 · 扫描远端 Agent · SFTP 文件管理 · 终端调试
                </div>
            </div>
            <div class="actions">
                <el-button size="small" :loading="loading" @click="reload(true)">刷新并重扫</el-button>
            </div>
        </div>

            <div class="stats">
            <div class="stat-card">
                <div class="stat-label">主机</div>
                <div class="stat-value">{{ overview.hostLabel }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">已连接</div>
                <div class="stat-value">{{ overview.connectedCount }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">可用 Agent</div>
                <div class="stat-value">{{ overview.agentCount }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">SSH 连接</div>
                <div class="stat-value">{{ status.activeSessions || 0 }}</div>
            </div>
        </div>

        <div class="tabs">
            <button
                v-for="tab in tabs"
                :key="tab"
                class="tab"
                :class="{ active: active === tab }"
                type="button"
                @click="active = tab"
            >
                {{ tabLabel[tab] }}
            </button>
        </div>

        <div class="content" :class="{ terminal: active === 'terminal' }" v-loading="loading">
            <computer-panel
                v-if="active === 'computer'"
                :config="config"
                :status="status"
                :connecting="connecting"
                :maintaining="maintaining"
                @connect="connectComputer"
                @remove="removeComputer"
                @maintain="maintainAgent"
            />
            <skills-panel
                v-if="active === 'skills'"
                :config="config"
                :status="status"
                @sync="syncSkill"
                @refresh="refreshSkills"
            />
            <file-manager-panel
                v-show="active === 'files'"
                :config="config"
                :status="status"
                :visible="active === 'files'"
            />
            <sessions-panel
                v-show="active === 'sessions'"
                :visible="active === 'sessions'"
            />
            <!-- Keep terminal mounted so tabs/WebSocket survive Computer/Skills switches. -->
            <terminal-panel
                v-show="active === 'terminal'"
                :config="config"
                :status="status"
                :visible="active === 'terminal'"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import ComputerPanel from './components/computer-panel.vue'
import SkillsPanel from './components/skills-panel.vue'
import TerminalPanel from './components/terminal-panel.vue'
import FileManagerPanel from './components/file-manager-panel.vue'
import SessionsPanel from './components/sessions-panel.vue'
import type {
    AgentKind,
    AgentMaintenanceInput,
    NexusConfig,
    NexusStatus,
    SshAuth
} from '../src/types'

type ComputerConnectInput = {
    id?: string
    name: string
    host: string
    port: number
    username: string
    auth?: SshAuth
    cwd?: string
    setAsDefault?: boolean
}

const tabs = ['computer', 'skills', 'files', 'sessions', 'terminal'] as const
const tabLabel = {
    computer: 'Computer',
    skills: 'Skills',
    files: '文件',
    sessions: '会话',
    terminal: '终端'
}

const active = ref<(typeof tabs)[number]>('computer')
const loading = ref(false)
const connecting = ref(false)
const maintaining = ref<string[]>([])
let statusGeneration = 0
const config = ref<NexusConfig>({
    hosts: [],
    agents: {
        hermes: true,
        openclaw: true,
        claude: true,
        opencode: true,
        codex: true
    },
    runtime: {
        openclawAgent: 'default',
        claudeSkipPermissions: true,
        codexBypassSandbox: true,
        opencodeAuto: true,
        defaultTimeoutMs: 600000
    },
    skills: [],
    skillRoot: '~/.agent-nexus/skills'
})
const status = ref<NexusStatus>({
    enabled: false,
    hosts: [],
    skills: { total: 0, items: [] },
    activeSessions: 0
})

const overview = computed(() => {
    const hosts = status.value.hosts
    const connectedCount = hosts.filter((item) => item.state === 'connected').length
    const agentCount = hosts.reduce(
        (sum, item) => sum + item.agents.filter((agent) => agent.installed).length,
        0
    )
    const defaultHost =
        hosts.find((item) => item.id === status.value.defaultHostId) || hosts[0]
    const hostLabel = !hosts.length
        ? '未配置'
        : hosts.length === 1
          ? defaultHost?.name || defaultHost?.host || '1 台'
          : `${hosts.length} 台 · ${connectedCount} 已连接`
    return {
        connected: connectedCount > 0,
        connectedCount,
        agentCount,
        hostLabel
    }
})

async function reload(scan = false) {
    const generation = ++statusGeneration
    loading.value = true
    try {
        const data = await send('agent-nexus/getConsoleData')
        if (generation !== statusGeneration) return
        config.value = data.config
        status.value = data.status
        if (scan && data.config.hosts.some((host) => host.enabled)) {
            status.value = await send('agent-nexus/scanAgents')
        }
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    } finally {
        loading.value = false
    }
}

async function autoConnectAndScan() {
    const hostId =
        config.value.defaultHostId ||
        config.value.hosts.find((host) => host.enabled)?.id ||
        config.value.hosts[0]?.id
    if (!hostId) return

    const hostStatus = status.value.hosts.find((item) => item.id === hostId)
    const hasAgents = (hostStatus?.agents || []).some((agent) => agent.installed)
    if (hostStatus && hasAgents) return

    // Do not toggle the main connecting flag — that freezes the Computer UI.
    try {
        await Promise.race([
            (async () => {
                await send('agent-nexus/testHost', hostId)
                status.value = await send('agent-nexus/scanAgents', hostId)
            })(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('auto connect timeout')), 25000)
            )
        ])
    } catch {
        // keep silent on page-load auto connect
    } finally {
        await reloadQuiet()
    }
}

async function connectComputer(input: ComputerConnectInput, done: (hostId: string) => void) {
    connecting.value = true
    try {
        const payload: Record<string, unknown> = {
            name: input.name,
            host: input.host,
            port: input.port,
            username: input.username,
            enabled: true,
            setAsDefault: input.setAsDefault
        }
        // Only send id when editing an existing device.
        if (input.id) payload.id = input.id
        if (input.cwd !== undefined) payload.cwd = input.cwd
        if (input.auth) payload.auth = input.auth as SshAuth

        const result = await send('agent-nexus/saveHost', payload as any)
        config.value = result.data.config
        status.value = result.data.status
        done(result.hostId)
        ElMessage.success(input.id ? '设备已保存，正在连接扫描…' : '设备已添加，正在连接扫描…')

        // Background connect/scan finishes after save returns; refresh status shortly.
        window.setTimeout(() => {
            void reloadQuiet()
        }, 1500)
        window.setTimeout(() => {
            void reloadQuiet()
        }, 5000)
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    } finally {
        connecting.value = false
    }
}

async function reloadQuiet() {
    if (maintaining.value.length) return
    const generation = ++statusGeneration
    try {
        const data = await send('agent-nexus/getConsoleData')
        if (generation !== statusGeneration || maintaining.value.length) return
        config.value = data.config
        status.value = data.status
    } catch {
        // ignore background refresh errors
    }
}

async function removeComputer(hostId: string) {
    try {
        const host = config.value.hosts.find((item) => item.id === hostId)
        await ElMessageBox.confirm(
            `确定删除设备“${host?.name || hostId}”吗？`,
            '删除 SSH 设备',
            {
                confirmButtonText: '删除',
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        await send('agent-nexus/removeHost', hostId)
        await reload()
        ElMessage.success('SSH 设备已删除')
    } catch (err: any) {
        if (err === 'cancel' || err === 'close') return
        ElMessage.error(err?.message || String(err))
    }
}

async function maintainAgent(input: AgentMaintenanceInput) {
    const key = `${input.hostId}:${input.kind}`
    if (maintaining.value.includes(key)) return
    maintaining.value = [...maintaining.value, key]
    statusGeneration += 1
    const host = status.value.hosts.find((item) => item.id === input.hostId)
    const agent = host?.agents.find((item) => item.kind === input.kind)
    const action = agent?.installed ? '更新' : '安装'
    const labels: Record<AgentKind, string> = {
        hermes: 'Hermes',
        openclaw: 'OpenClaw',
        claude: 'Claude Code',
        opencode: 'OpenCode',
        codex: 'Codex'
    }
    try {
        await ElMessageBox.confirm(
            `将在设备“${host?.name || input.hostId}”上以当前 SSH 用户执行${action}。渠道：${agent?.maintenanceMethod || '官方安装渠道'}。是否继续？`,
            `${action} ${labels[input.kind]}`,
            {
                confirmButtonText: action,
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        const result = await send('agent-nexus/maintainAgent', input)
        statusGeneration += 1
        status.value = result.status
        ElMessage.success(
            `${labels[input.kind]} ${result.action === 'install' ? '安装' : '更新'}完成`
        )
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(error?.message || String(error))
    } finally {
        maintaining.value = maintaining.value.filter((item) => item !== key)
    }
}

async function syncSkill(input: {
    repoUrl: string
    name?: string
    branch?: string
    subdir?: string
    hostId?: string
}, done: () => void) {
    try {
        await send('agent-nexus/saveConfig', config.value)
        await send('agent-nexus/syncSkill', input)
        ElMessage.success('Skill 同步完成')
        await refreshSkills(input.hostId)
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    } finally {
        done()
    }
}

async function refreshSkills(hostId?: string) {
    try {
        await send('agent-nexus/saveConfig', config.value)
        const items = await send('agent-nexus/listSkills', hostId)
        status.value = {
            ...status.value,
            skills: {
                total: items.length,
                items,
                hostId: hostId || status.value.defaultHostId
            }
        }
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    }
}

onMounted(async () => {
    await reload(false)
    await autoConnectAndScan()
})
</script>

<style scoped>
.nexus-page {
    display: flex;
    flex-direction: column;
    gap: 18px;
    width: min(100%, 1440px);
    min-height: 100%;
    margin: 0 auto;
    padding: 24px clamp(20px, 4vw, 56px) 40px;
    box-sizing: border-box;
}

.hero,
.stats,
.tabs,
.title-row,
.actions {
    display: flex;
    align-items: center;
    gap: 12px;
}

.hero {
    justify-content: space-between;
}

.title-row {
    gap: 10px;
}

.title {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--k-text-dark);
}

.subtitle {
    margin-top: 6px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--k-text-light);
}

.stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
}

.stat-card {
    min-width: 0;
    padding: 14px 16px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 20%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
}

.stat-label {
    font-size: 12px;
    color: var(--k-text-light);
}

.stat-value {
    margin-top: 8px;
    overflow: hidden;
    font-size: 16px;
    font-weight: 650;
    color: var(--k-text-dark);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tabs {
    gap: 8px;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 20%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 24%);
    overflow-x: auto;
}

.tab {
    flex: 0 0 auto;
    border: 0;
    border-radius: 10px;
    padding: 9px 16px;
    background: transparent;
    color: var(--k-text-light);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    transition: 0.18s ease;
}

.tab:hover {
    color: var(--k-text-dark);
    background: color-mix(in srgb, var(--k-page-bg), transparent 20%);
}

.tab.active {
    color: var(--k-text-dark);
    background: color-mix(in srgb, var(--k-color-primary), transparent 86%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--k-color-primary), transparent 72%);
    font-weight: 650;
}

.content {
    flex: 1;
    min-height: 0;
    min-width: 0;
}

.content.terminal {
    overflow: visible;
}

@media (max-width: 900px) {
    .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 720px) {
    .nexus-page {
        gap: 14px;
        padding: 16px 14px 28px;
    }

    .hero {
        align-items: flex-start;
        flex-direction: column;
    }

    .actions,
    .tabs {
        width: 100%;
    }

    .actions :deep(.el-button) {
        width: 100%;
    }

    .stats {
        grid-template-columns: 1fr 1fr;
    }
}
</style>
