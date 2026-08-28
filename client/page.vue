<template>
    <div class="nexus-page">
        <header class="hero">
            <div class="hero-copy">
                <span class="eyebrow">CHATLUNA · AGENT NEXUS</span>
                <div class="title-row">
                    <h1>Agent 中枢</h1>
                    <span class="gateway-pill" :class="status.gateway.state">
                        <i />{{ gatewayStateLabel }}
                    </span>
                </div>
                <p>
                    Nexus Gateway 负责接入 ACP 与 A2A Agent；本插件只负责把可用
                    Agent 发布为 ChatLuna 工具，并维护委派任务上下文。
                </p>
            </div>
            <el-button
                class="refresh-button"
                :loading="loading"
                @click="reload(true)"
            >
                重新检查 Gateway
            </el-button>
        </header>

        <section class="metrics" aria-label="运行概览">
            <article>
                <span>Gateway</span>
                <strong>{{ status.gateway.state === 'ready' ? '在线' : '离线' }}</strong>
                <small>{{ status.gateway.baseUrl }}</small>
            </article>
            <article>
                <span>发现 Agent</span>
                <strong>{{ status.gateway.agents.length }}</strong>
                <small>由 Gateway 统一提供</small>
            </article>
            <article>
                <span>可用 Agent</span>
                <strong>{{ readyCount }}</strong>
                <small>通过健康检查</small>
            </article>
            <article>
                <span>ChatLuna 工具</span>
                <strong>{{ toolCount }}</strong>
                <small>已自动注册</small>
            </article>
        </section>

        <section v-if="!gatewayKeyConfigured" class="setup-notice">
            <span class="notice-index">需要配置</span>
            <div>
                <strong>请在 Koishi 插件设置中填写 Gateway API Key</strong>
                <p>
                    Key 在 Nexus Gateway 的“API 密钥”页面生成；这里需要的是 API
                    Key，不是 Gateway 控制台登录密码。
                </p>
            </div>
        </section>

        <main class="control-surface" v-loading="loading">
            <div class="surface-title">
                <div>
                    <span>单一连接 · 自动发现</span>
                    <h2>Gateway Agent 清单</h2>
                </div>
                <code>URL + API KEY → AGENTS → TOOLS</code>
            </div>
            <gateway-panel
                :config="config"
                :status="status"
                :gateway-key-configured="gatewayKeyConfigured"
                @updated="applyConsoleData"
            />
        </main>

        <task-history :jobs="jobs" :loading="jobsLoading" @refresh="reloadJobs" />
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import GatewayPanel from './components/gateway-panel.vue'
import TaskHistory from './components/task-history.vue'
import type {
    NexusConfig,
    NexusConsoleData,
    NexusStatus,
    NexusTaskSummary
} from '../src/types'

const loading = ref(false)
let generation = 0
const config = ref<NexusConfig>({ delegation: { agents: [] } })
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
const jobs = ref<NexusTaskSummary[]>([])
const jobsLoading = ref(false)
let jobsTimer: ReturnType<typeof setInterval> | undefined

const readyCount = computed(
    () => status.value.gateway.agents.filter((agent) => agent.ready).length
)
const toolCount = computed(
    () =>
        status.value.delegation.agents.filter(
            (agent) => agent.enabled && agent.toolName
        ).length
)
const gatewayStateLabel = computed(() => {
    if (!gatewayKeyConfigured.value) return '等待 API Key'
    if (status.value.gateway.state === 'ready') return 'Gateway 在线'
    if (status.value.gateway.state === 'checking') return '正在检查'
    if (status.value.gateway.state === 'error') return '连接异常'
    return '尚未检查'
})

async function reload(discover = false) {
    const current = ++generation
    loading.value = true
    try {
        const [data, taskRows] = await Promise.all([
            send('agent-nexus/getConsoleData'),
            send('agent-nexus/getDelegationJobs')
        ])
        if (current !== generation) return
        applyConsoleData(data)
        jobs.value = taskRows
        if (discover) {
            status.value = await send('agent-nexus/refreshGateway')
        }
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        if (current === generation) loading.value = false
    }
}

async function reloadJobs() {
    jobsLoading.value = true
    try {
        jobs.value = await send('agent-nexus/getDelegationJobs')
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        jobsLoading.value = false
    }
}

function applyConsoleData(data: NexusConsoleData) {
    config.value = data.config
    status.value = data.status
    gatewayKeyConfigured.value = data.gatewayKeyConfigured
}

onMounted(() => {
    void reload(true)
    jobsTimer = setInterval(() => void reloadJobs(), 5_000)
})

onBeforeUnmount(() => {
    if (jobsTimer) clearInterval(jobsTimer)
})
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
    gap: 22px;
}

.hero,
.title-row,
.surface-title {
    display: flex;
    align-items: center;
}

.hero {
    position: relative;
    justify-content: space-between;
    gap: 28px;
    padding: 6px 0 24px 18px;
    border-bottom: 1px solid var(--nexus-line);
}

.hero::before {
    position: absolute;
    top: 8px;
    bottom: 26px;
    left: 0;
    width: 3px;
    background: var(--k-color-primary);
    content: '';
}

.hero-copy {
    min-width: 0;
}

.eyebrow,
.surface-title span,
.surface-title code,
.metrics span,
.notice-index {
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.eyebrow,
.surface-title span {
    color: var(--k-color-primary);
    font-size: 10px;
}

.title-row {
    gap: 14px;
    margin-top: 7px;
}

h1,
h2,
.hero p,
.setup-notice p {
    margin: 0;
}

h1 {
    color: var(--nexus-ink);
    font-family: 'Microsoft YaHei UI', 'Noto Sans SC', sans-serif;
    font-size: clamp(30px, 4vw, 48px);
    font-weight: 760;
    line-height: 1;
    letter-spacing: -0.05em;
}

.hero p {
    max-width: 760px;
    margin-top: 12px;
    color: var(--k-text-light);
    font-size: 13px;
    line-height: 1.7;
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

.metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid var(--nexus-line);
    background: var(--nexus-line);
}

.metrics article {
    display: grid;
    min-width: 0;
    padding: 16px 18px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 30%);
}

.metrics span {
    color: var(--k-text-light);
    font-size: 9px;
}

.metrics strong {
    margin-top: 9px;
    color: var(--nexus-ink);
    font-size: 27px;
    line-height: 1;
}

.metrics small {
    margin-top: 8px;
    overflow: hidden;
    color: var(--k-text-light);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.setup-notice {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 18px;
    align-items: start;
    padding: 16px 18px;
    border: 1px solid color-mix(in srgb, #d99b2b, transparent 52%);
    background: color-mix(in srgb, #d99b2b, transparent 93%);
}

.notice-index {
    color: #b7790c;
    font-size: 10px;
}

.setup-notice strong {
    color: var(--nexus-ink);
    font-size: 13px;
}

.setup-notice p {
    margin-top: 5px;
    color: var(--k-text-light);
    font-size: 12px;
    line-height: 1.6;
}

.control-surface {
    min-width: 0;
    padding: 21px;
    border: 1px solid var(--nexus-line);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 38%);
}

.surface-title {
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 22px;
}

.surface-title h2 {
    margin: 5px 0 0;
    color: var(--nexus-ink);
    font-size: 19px;
}

.surface-title code {
    color: var(--k-text-light);
    font-size: 9px;
}

@media (max-width: 900px) {
    .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 680px) {
    .nexus-page {
        padding: 17px 13px 32px calc(var(--activity-width, 0px) + 13px);
    }

    .hero,
    .surface-title {
        align-items: flex-start;
        flex-direction: column;
    }

    .refresh-button {
        width: 100%;
    }

    .setup-notice {
        grid-template-columns: 1fr;
        gap: 8px;
    }

    .control-surface {
        padding: 16px 13px;
    }
}
</style>
