<template>
    <div class="nexus-page">
        <header class="hero">
            <div class="hero-copy">
                <span class="eyebrow">CHATLUNA · AGENT NEXUS</span>
                <div class="title-row">
                    <h1>Agent 中枢</h1>
                    <span class="gateway-pill" :class="status.gateway.state">
                        <i />{{ gatewayStateLabel(status.gateway.state, gatewayKeyConfigured) }}
                    </span>
                </div>
            </div>
            <el-button
                class="refresh-button"
                :loading="loading"
                @click="reload(true)"
            >
                重新检查 Gateway
            </el-button>
        </header>

        <nav class="tabs" role="tablist">
            <button
                v-for="item in tabs"
                :key="item.name"
                class="tab"
                :class="{ active: activeTab === item.name }"
                type="button"
                role="tab"
                :aria-selected="activeTab === item.name"
                @click="selectTab(item.name)"
            >
                {{ item.label }}
                <span v-if="item.badge" class="tab-badge" :class="item.tone">
                    {{ item.badge }}
                </span>
            </button>
        </nav>

        <main v-loading="loading" class="tab-surface">
            <overview-tab
                v-if="activeTab === 'overview'"
                :status="status"
                :gateway-key-configured="gatewayKeyConfigured"
                :jobs="jobs"
                :jobs-loaded="jobsLoaded"
                @goto="selectTab"
            />
            <agents-tab
                v-else-if="activeTab === 'agents'"
                :config="config"
                :status="status"
                :gateway-key-configured="gatewayKeyConfigured"
                @updated="applyConsoleData"
            />
            <tasks-tab
                v-else-if="activeTab === 'tasks'"
                :jobs="jobs"
                :loading="jobsLoading"
                :loaded="jobsLoaded"
                :error="jobsError"
                @refresh="reloadJobs(false)"
                @cleared="reloadJobs(false)"
            />
            <artifacts-tab
                v-else-if="activeTab === 'artifacts'"
                :jobs="jobs"
                :jobs-loaded="jobsLoaded"
            />
            <settings-tab
                v-else
                :config="config"
                :status="status"
                :settings="settings"
                @updated="applyConsoleData"
                @goto="selectTab"
            />
        </main>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import OverviewTab from './components/overview-tab.vue'
import AgentsTab from './components/agents-tab.vue'
import TasksTab from './components/tasks-tab.vue'
import ArtifactsTab from './components/artifacts-tab.vue'
import SettingsTab from './components/settings-tab.vue'
import { activeJobCount, attentionAgents, gatewayStateLabel } from './shared'
import type {
    NexusConfig,
    NexusConsoleData,
    NexusPluginSettings,
    NexusStatus
} from '../src/types'
import type { DelegationJobView } from '../src/delegation/types'

type TabName = 'overview' | 'agents' | 'tasks' | 'artifacts' | 'settings'

const TAB_STORAGE_KEY = 'agent-nexus-tab'
const JOBS_POLL_MS = 5000

const activeTab = ref<TabName>(readStoredTab())
const loading = ref(false)
const jobsLoading = ref(false)
const jobsLoaded = ref(false)
const jobsError = ref('')
const jobs = ref<DelegationJobView[]>([])
const now = ref(Date.now())
let generation = 0
let jobsGeneration = 0
let pollTimer: ReturnType<typeof setInterval> | undefined

const config = ref<NexusConfig>({ delegation: { agents: [] } })
const settings = ref<NexusPluginSettings>({
    commandAuthority: 0,
    maxResponseBytes: 0,
    gatewayKeyLength: 0
})
const status = ref<NexusStatus>({
    gateway: {
        id: 'primary-gateway',
        name: 'Nexus Gateway',
        baseUrl: '',
        enabled: false,
        state: 'unknown',
        agents: []
    },
    delegation: { agents: [] }
})
const gatewayKeyConfigured = ref(false)

const tabJobs = computed(
    () =>
        activeTab.value === 'overview' ||
        activeTab.value === 'tasks' ||
        activeTab.value === 'artifacts'
)

const artifactCount = computed(() =>
    jobs.value.reduce((total, job) => total + job.artifacts.length, 0)
)

const tabs = computed(() => [
    { name: 'overview' as const, label: '概览' },
    { name: 'agents' as const, label: '智能体' },
    {
        name: 'tasks' as const,
        label: '任务',
        badge: activeJobCount(jobs.value) || undefined,
        tone: 'active'
    },
    {
        name: 'artifacts' as const,
        label: '产物',
        badge: artifactCount.value || undefined,
        tone: 'plain'
    },
    {
        name: 'settings' as const,
        label: '设置',
        badge: attentionAgents(status.value).length || undefined,
        tone: 'warn'
    }
])

async function reload(discover = false) {
    const current = ++generation
    loading.value = true
    try {
        const data = await send('agent-nexus/getConsoleData')
        if (current !== generation) return
        applyConsoleData(data)
        if (discover) {
            status.value = await send('agent-nexus/refreshGateway')
        }
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        if (current === generation) loading.value = false
    }
}

function applyConsoleData(data: NexusConsoleData) {
    config.value = data.config
    status.value = data.status
    settings.value = data.settings
    gatewayKeyConfigured.value = data.gatewayKeyConfigured
}

async function reloadJobs(silent = true) {
    const current = ++jobsGeneration
    if (!silent) jobsLoading.value = true
    try {
        const result = await send('agent-nexus/listDelegationJobs', 100)
        if (current !== jobsGeneration) return
        jobs.value = result
        jobsLoaded.value = true
        jobsError.value = ''
    } catch (error: any) {
        if (current !== jobsGeneration) return
        jobsError.value = error?.message || String(error)
        if (!silent || !jobsLoaded.value) {
            ElMessage.error(jobsError.value)
        }
    } finally {
        if (current === jobsGeneration) jobsLoading.value = false
    }
}

function selectTab(name: TabName) {
    activeTab.value = name
    try {
        localStorage.setItem(TAB_STORAGE_KEY, name)
    } catch {
        /* storage may be unavailable in private modes */
    }
    if (tabJobs.value) void reloadJobs(true)
}

function tick() {
    now.value = Date.now()
    if (!tabJobs.value || document.visibilityState !== 'visible') return
    void reloadJobs(true)
}

function restartPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(tick, JOBS_POLL_MS)
}

watch(tabJobs, (wanted) => {
    if (wanted && !jobsLoaded.value) void reloadJobs(false)
})

onMounted(() => {
    void reload(true)
    void reloadJobs(false)
    restartPolling()
})

onBeforeUnmount(() => {
    if (pollTimer) clearInterval(pollTimer)
})

function readStoredTab(): TabName {
    try {
        const value = localStorage.getItem(TAB_STORAGE_KEY)
        if (
            value === 'overview' ||
            value === 'agents' ||
            value === 'tasks' ||
            value === 'artifacts' ||
            value === 'settings'
        ) {
            return value
        }
    } catch {
        /* ignore */
    }
    return 'overview'
}
</script>

<style scoped>
.nexus-page {
    --nexus-line: color-mix(in srgb, var(--k-color-divider), transparent 8%);
    --nexus-ink: var(--k-text-dark);
    display: flex;
    width: min(100%, 1420px);
    min-height: 100%;
    margin: 0 auto;
    padding: 30px clamp(18px, 4vw, 58px) 52px
        calc(var(--activity-width, 0px) + clamp(18px, 4vw, 58px));
    box-sizing: border-box;
    flex-direction: column;
    gap: 20px;
}

.hero,
.title-row {
    display: flex;
    align-items: center;
}

.hero {
    position: relative;
    justify-content: space-between;
    gap: 28px;
    padding: 6px 0 20px 18px;
    border-bottom: 1px solid var(--nexus-line);
}

.hero::before {
    position: absolute;
    top: 8px;
    bottom: 22px;
    left: 0;
    width: 3px;
    background: var(--k-color-primary);
    content: '';
}

.hero-copy {
    min-width: 0;
}

.eyebrow {
    color: var(--k-color-primary);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.title-row {
    gap: 14px;
    margin-top: 7px;
}

h1 {
    margin: 0;
    color: var(--nexus-ink);
    font-family: 'Microsoft YaHei UI', 'Noto Sans SC', sans-serif;
    font-size: clamp(30px, 4vw, 48px);
    font-weight: 760;
    line-height: 1;
    letter-spacing: -0.05em;
}

.gateway-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--k-text-light);
    font-size: 12px;
}

.gateway-pill i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #8b949e;
}

.gateway-pill.ready i {
    background: #1fa66b;
    box-shadow: 0 0 0 4px color-mix(in srgb, #1fa66b, transparent 82%);
}

.gateway-pill.checking i {
    background: #d99b2b;
}

.gateway-pill.error i {
    background: #d65757;
}

.tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--nexus-line);
}

.tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 16px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--k-text-light);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
}

.tab:hover {
    color: var(--nexus-ink);
}

.tab.active {
    border-bottom-color: var(--k-color-primary);
    color: var(--nexus-ink);
    font-weight: 600;
}

.tab-badge {
    min-width: 18px;
    padding: 1px 5px;
    background: var(--k-color-primary);
    color: #fff;
    font-family: 'Cascadia Mono', monospace;
    font-size: 10px;
    line-height: 16px;
    text-align: center;
}

.tab-badge.warn {
    background: #d99b2b;
}

.tab-badge.plain {
    background: color-mix(in srgb, var(--k-color-divider), transparent 20%);
    color: var(--k-text-light);
}

.tab-surface {
    min-width: 0;
    min-height: 320px;
}

@media (max-width: 680px) {
    .nexus-page {
        padding: 17px 13px 32px calc(var(--activity-width, 0px) + 13px);
    }

    .hero {
        align-items: flex-start;
        flex-direction: column;
        gap: 14px;
    }

    .refresh-button {
        width: 100%;
    }

    .tabs {
        overflow-x: auto;
    }

    .tab {
        padding: 10px 12px;
        white-space: nowrap;
    }
}
</style>
