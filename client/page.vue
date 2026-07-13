<template>
    <div class="nexus-page">
        <div class="toolbar">
            <div class="title">AgentNexus</div>
            <div class="actions">
                <el-button size="small" :loading="loading" @click="reload">刷新</el-button>
            </div>
        </div>

        <div class="tabs">
            <div
                v-for="tab in tabs"
                :key="tab"
                class="tab"
                :class="{ active: active === tab }"
                @click="active = tab"
            >
                {{ tabLabel[tab] }}
            </div>
        </div>

        <div class="content" v-loading="loading">
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
import { onMounted, ref } from 'vue'
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

onMounted(reload)
</script>

<style scoped>
.nexus-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(100%, 1440px);
    min-height: 100%;
    margin: 0 auto;
    padding: 24px clamp(24px, 4vw, 56px) 40px;
    box-sizing: border-box;
}
.toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
}
.title {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
}
.actions {
    display: flex;
    gap: 8px;
}
.tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--k-color-border, #3333);
    padding-bottom: 8px;
    overflow-x: auto;
}
.tab {
    flex: 0 0 auto;
    padding: 7px 14px;
    border-radius: 8px;
    cursor: pointer;
    opacity: 0.75;
}
.tab.active {
    background: var(--k-color-primary, #409eff22);
    opacity: 1;
    font-weight: 600;
}
.content {
    flex: 1;
    min-height: 0;
    min-width: 0;
}

@media (max-width: 720px) {
    .nexus-page {
        gap: 12px;
        padding: 16px 14px 28px;
    }

    .toolbar {
        align-items: flex-start;
        flex-direction: column;
    }

    .actions {
        width: 100%;
    }

    .actions :deep(.el-button) {
        flex: 1;
    }
}
</style>
