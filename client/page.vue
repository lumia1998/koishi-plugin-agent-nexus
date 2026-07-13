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
                    SSH Code Agent 网关 · 扫描远端 Agent · 同步 Skills · 终端调试
                </div>
            </div>
            <div class="actions">
                <el-button size="small" :loading="loading" @click="reload">刷新状态</el-button>
            </div>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="stat-label">主机</div>
                <div class="stat-value">{{ overview.hostLabel }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">可用 Agent</div>
                <div class="stat-value">{{ overview.agentCount }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Skills</div>
                <div class="stat-value">{{ status.skills.total || 0 }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">活跃会话</div>
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
                @connect="connectComputer"
            />
            <skills-panel
                v-else-if="active === 'skills'"
                :config="config"
                :status="status"
                @sync="syncSkill"
                @refresh="refreshSkills"
            />
            <terminal-panel
                v-else
                :config="config"
                :status="status"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import ComputerPanel from './components/computer-panel.vue'
import SkillsPanel from './components/skills-panel.vue'
import TerminalPanel from './components/terminal-panel.vue'
import type { NexusConfig, NexusStatus } from '../src/types'

const tabs = ['computer', 'skills', 'terminal'] as const
const tabLabel = {
    computer: 'Computer',
    skills: 'Skills',
    terminal: '终端'
}

const active = ref<(typeof tabs)[number]>('computer')
const loading = ref(false)
const connecting = ref(false)
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
    const host = status.value.hosts[0]
    const agents = host?.agents || []
    const agentCount = agents.filter((item) => item.installed).length
    const connected = !!host && (host.sessionCount > 0 || agentCount > 0)
    return {
        connected,
        agentCount,
        hostLabel: host ? `${host.host}` : '未配置'
    }
})

async function reload() {
    loading.value = true
    try {
        const data = await send('agent-nexus/getConsoleData')
        config.value = data.config
        status.value = data.status
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
    if (!hostId || connecting.value) return

    const hostStatus = status.value.hosts.find((item) => item.id === hostId)
    const hasAgents = (hostStatus?.agents || []).some((agent) => agent.installed)
    if (hostStatus && hostStatus.sessionCount > 0 && hasAgents) return

    connecting.value = true
    try {
        await send('agent-nexus/testHost', hostId)
        status.value = await send('agent-nexus/scanAgents', hostId)
    } catch {
        // keep silent on page-load auto connect; manual button still surfaces errors
    } finally {
        connecting.value = false
        try {
            const data = await send('agent-nexus/getConsoleData')
            config.value = data.config
            status.value = data.status
        } catch {}
    }
}

async function connectComputer(input: {
    host: string
    port: number
    username: string
    password: string
}) {
    connecting.value = true
    try {
        const current = config.value.hosts[0]
        const id = current?.id || crypto.randomUUID()
        config.value = {
            ...config.value,
            defaultHostId: id,
            hosts: [
                {
                    id,
                    name: 'SSH Computer',
                    host: input.host,
                    port: input.port,
                    username: input.username,
                    auth: { type: 'password', password: input.password },
                    enabled: true,
                    defaultAgent: 'auto',
                    cwd: current?.cwd,
                    idleTimeoutMs: current?.idleTimeoutMs || 15 * 60 * 1000
                }
            ],
            agents: {
                hermes: true,
                openclaw: true,
                claude: true,
                opencode: true,
                codex: true
            },
            runtime: {
                ...config.value.runtime,
                claudeSkipPermissions: true,
                codexBypassSandbox: true,
                opencodeAuto: true
            }
        }
        await send('agent-nexus/saveConfig', config.value)
        const result = await send('agent-nexus/testHost', id)
        status.value = await send('agent-nexus/scanAgents', id)
        ElMessage.success(result.output || '连接并扫描完成')
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    } finally {
        connecting.value = false
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
            skills: { total: items.length, items }
        }
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    }
}

onMounted(async () => {
    await reload()
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
