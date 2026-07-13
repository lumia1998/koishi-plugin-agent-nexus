<template>
    <div class="terminal-panel">
        <div class="terminal-frame">
            <div class="terminal-tabs">
                <div
                    v-for="item in tabs"
                    :key="item.key"
                    class="terminal-tab-shell"
                    :class="{
                        active: item.key === activeKey,
                        connecting: item.connecting
                    }"
                >
                    <button
                        type="button"
                        class="terminal-tab-trigger"
                        @click="activeKey = item.key"
                    >
                        <span class="terminal-tab-label">{{ item.title }}</span>
                        <span
                            class="terminal-tab-state"
                            :class="{ connected: item.connected }"
                        />
                    </button>
                    <button
                        type="button"
                        class="terminal-tab-close"
                        @click="closeTab(item.key)"
                    >
                        ×
                    </button>
                </div>

                <div class="terminal-tab-actions">
                    <el-select
                        v-if="hosts.length > 1"
                        v-model="createHostId"
                        class="create-host-select"
                        size="small"
                        placeholder="主机"
                    >
                        <el-option
                            v-for="host in hosts"
                            :key="host.id"
                            :label="hostOptionLabel(host)"
                            :value="host.id"
                        />
                    </el-select>
                    <button
                        v-if="tabs.length > 0"
                        type="button"
                        class="terminal-tab-clear"
                        @click="closeAllTabs"
                    >
                        关闭全部
                    </button>
                    <button
                        type="button"
                        class="terminal-tab-add"
                        :disabled="creating || !hosts.length"
                        @click="createTab()"
                    >
                        +
                    </button>
                </div>
            </div>

            <div class="terminal-workspace">
                <div v-if="!hosts.length" class="terminal-empty">
                    请先在 Computer 页面配置至少一台 SSH 主机。
                </div>
                <div v-else class="terminal-panes">
                    <div
                        v-for="item in tabs"
                        v-show="item.key === activeKey"
                        :key="`${item.key}-pane`"
                        class="terminal-pane"
                    >
                        <div
                            :ref="(el) => setHost(item.key, el)"
                            class="terminal-host"
                        />
                        <div v-if="item.error" class="terminal-error">
                            <div>{{ item.error }}</div>
                            <el-button size="small" type="primary" @click="reconnectTab(item.key)">
                                重新连接
                            </el-button>
                        </div>
                    </div>
                    <div v-if="!tabs.length" class="terminal-empty">
                        正在打开终端…
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import 'xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { NexusConfig, NexusStatus, SshHostConfig, TerminalInfo } from '../../src/types'

interface TerminalTab {
    key: string
    title: string
    hostId: string
    sessionId: string
    terminalId: string
    connecting: boolean
    connected: boolean
    error: string
}

interface TerminalRuntime {
    term: Terminal
    fit: FitAddon
    socket?: WebSocket
    observer?: ResizeObserver
}

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
}>()

const tabs = ref<TerminalTab[]>([])
const activeKey = ref('')
const creating = ref(false)
const createHostId = ref<string>()

const hostMap = new Map<string, HTMLDivElement>()
const runtimeMap = new Map<string, TerminalRuntime>()
let count = 1
let disposed = false

const hosts = computed(() => props.config.hosts.filter((host) => host.enabled !== false))

function hostOptionLabel(host: SshHostConfig) {
    const target = `${host.username}@${host.host}:${host.port || 22}`
    return host.name ? `${host.name}` : target
}

function hostTitle(host: SshHostConfig, index: number) {
    const base = host.name || `${host.host}`
    return `${base} #${index}`
}

function pickDefaultHostId() {
    if (
        props.config.defaultHostId &&
        hosts.value.some((host) => host.id === props.config.defaultHostId)
    ) {
        return props.config.defaultHostId
    }
    return hosts.value[0]?.id
}

watch(
    hosts,
    (list) => {
        if (!list.length) {
            createHostId.value = undefined
            return
        }
        if (!createHostId.value || !list.some((host) => host.id === createHostId.value)) {
            createHostId.value = pickDefaultHostId()
        }
    },
    { immediate: true }
)

watch(activeKey, async (key) => {
    if (!key) return
    await nextTick()
    fitTab(key)
    syncTabSize(key)
})

onMounted(async () => {
    disposed = false
    createHostId.value = pickDefaultHostId()
    if (createHostId.value) {
        await createTab(createHostId.value)
    }
})

onBeforeUnmount(async () => {
    disposed = true
    await closeAllTabs()
})

async function createTab(hostId?: string) {
    if (creating.value || disposed) return
    const targetHostId = hostId || createHostId.value || pickDefaultHostId()
    const host = hosts.value.find((item) => item.id === targetHostId)
    if (!host) {
        ElMessage.warning('请先配置 SSH 主机')
        return
    }

    creating.value = true
    const sameHostCount = tabs.value.filter((item) => item.hostId === host.id).length + 1
    const key = `terminal-${Date.now()}-${count++}`
    const tab: TerminalTab = {
        key,
        title: hostTitle(host, sameHostCount),
        hostId: host.id,
        sessionId: '',
        terminalId: '',
        connecting: true,
        connected: false,
        error: ''
    }
    tabs.value.push(tab)
    activeKey.value = key

    try {
        const runtime = await ensureRuntime(
            tab,
            `Connecting ${host.username}@${host.host}:${host.port || 22}...\r\n`
        )
        const info = (await send('agent-nexus/openTerminal', {
            hostId: host.id,
            cols: runtime.term.cols,
            rows: runtime.term.rows
        })) as TerminalInfo
        if (disposed) return
        tab.sessionId = info.sessionId
        tab.terminalId = info.terminalId
        await connectSocket(tab, runtime, info)
        tab.connecting = false
        tab.connected = true
        tab.error = ''
    } catch (err: any) {
        tab.connecting = false
        tab.connected = false
        tab.error = err?.message || String(err)
        runtimeMap.get(key)?.term.write(`\r\n[error] ${tab.error}\r\n`)
    } finally {
        creating.value = false
    }
}

async function reconnectTab(key: string) {
    const tab = tabs.value.find((item) => item.key === key)
    if (!tab) return
    await closeTab(key, true)
    createHostId.value = tab.hostId
    await createTab(tab.hostId)
}

async function ensureRuntime(tab: TerminalTab, initialOutput = '') {
    await nextTick()
    const host = hostMap.get(tab.key)
    if (!host) throw new Error('terminal host missing')

    const existing = runtimeMap.get(tab.key)
    if (existing) {
        existing.observer?.disconnect()
        existing.socket?.close()
        existing.term.dispose()
        runtimeMap.delete(tab.key)
        host.innerHTML = ''
    }

    const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
        scrollback: 5000,
        theme: {
            background: '#0f1115',
            foreground: '#d7dce2',
            cursor: '#8ab4ff',
            selectionBackground: '#3b82f655'
        }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    if (initialOutput) term.write(initialOutput)

    const runtime: TerminalRuntime = { term, fit }
    runtimeMap.set(tab.key, runtime)

    term.onData((data) => {
        if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return
        runtime.socket.send(JSON.stringify({ type: 'input', data }))
    })

    runtime.observer = new ResizeObserver(() => {
        fitTab(tab.key)
        syncTabSize(tab.key)
    })
    runtime.observer.observe(host)
    return runtime
}

async function connectSocket(
    tab: TerminalTab,
    runtime: TerminalRuntime,
    info: TerminalInfo
) {
    runtime.socket?.close()
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    runtime.socket = new WebSocket(
        `${protocol}://${location.host}${info.url}?token=${encodeURIComponent(info.token)}`
    )

    await new Promise<void>((resolve, reject) => {
        if (!runtime.socket) {
            reject(new Error('socket missing'))
            return
        }
        runtime.socket.onopen = () => resolve()
        runtime.socket.onerror = () => reject(new Error('终端 WebSocket 连接失败'))
    })

    runtime.socket.onmessage = (event) => {
        const text = typeof event.data === 'string' ? event.data : ''
        try {
            const data = JSON.parse(text)
            if (data.type === 'data') {
                runtime.term.write(data.data)
                return
            }
        } catch {}
        runtime.term.write(text)
    }

    runtime.socket.onclose = () => {
        tab.connected = false
        tab.connecting = false
    }

    syncTabSize(tab.key)
}

async function closeTab(key: string, remote = true) {
    const tab = tabs.value.find((item) => item.key === key)
    if (!tab) return

    if (remote && tab.sessionId && tab.terminalId) {
        try {
            await send('agent-nexus/closeTerminal', tab.sessionId, tab.terminalId)
        } catch {}
    }

    const runtime = runtimeMap.get(key)
    runtime?.observer?.disconnect()
    runtime?.socket?.close()
    runtime?.term?.dispose()
    runtimeMap.delete(key)
    hostMap.delete(key)

    const idx = tabs.value.findIndex((item) => item.key === key)
    tabs.value = tabs.value.filter((item) => item.key !== key)
    if (activeKey.value === key) {
        const next = tabs.value[idx] ?? tabs.value[idx - 1]
        activeKey.value = next?.key ?? ''
    }
}

async function closeAllTabs() {
    for (const item of [...tabs.value]) {
        await closeTab(item.key)
    }
    tabs.value = []
    activeKey.value = ''
}

function setHost(key: string, el: Element | null) {
    if (el instanceof HTMLDivElement) {
        hostMap.set(key, el)
        fitTab(key)
        syncTabSize(key)
        return
    }
    hostMap.delete(key)
}

function fitTab(key: string) {
    const runtime = runtimeMap.get(key)
    const host = hostMap.get(key)
    if (!runtime || !host || host.offsetParent == null) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 40) return
    runtime.fit.fit()
}

function syncTabSize(key: string) {
    const runtime = runtimeMap.get(key)
    const host = hostMap.get(key)
    if (!runtime || !host || host.offsetParent == null) return
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return
    runtime.socket.send(
        JSON.stringify({
            type: 'resize',
            cols: runtime.term.cols,
            rows: runtime.term.rows
        })
    )
}
</script>

<style scoped>
.terminal-panel {
    display: flex;
    flex-direction: column;
    padding: 0;
}

.terminal-frame {
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
    overflow: hidden;
}

.terminal-tabs {
    display: flex;
    align-items: flex-end;
    gap: 0;
    min-height: 48px;
    padding: 8px 12px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 8%);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
}

.terminal-tabs::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
}

.terminal-tab-shell {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 132px;
    max-width: 228px;
    height: 40px;
    margin-right: 4px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 12px 12px 0 0;
    background: transparent;
    color: var(--k-text-light);
    transition: background-color 0.16s ease;
    flex: 0 0 auto;
}

.terminal-tab-shell.active {
    margin-bottom: -1px;
    border-color: color-mix(in srgb, var(--k-color-divider), transparent 18%);
    background: #0f1115;
    color: #d7dce2;
    z-index: 3;
}

.terminal-tab-shell.connecting {
    color: var(--k-text-dark);
}

.terminal-tab-shell:not(.active):hover {
    background: color-mix(in srgb, var(--k-page-bg), transparent 36%);
    color: var(--k-text-dark);
}

.terminal-tab-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
    max-width: 100%;
    padding: 0 0 0 12px;
    height: 100%;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
}

.terminal-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
}

.terminal-tab-state {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #f0b429;
    flex: 0 0 auto;
}

.terminal-tab-state.connected {
    background: #3ddc97;
    box-shadow: 0 0 8px #3ddc9788;
}

.terminal-tab-close,
.terminal-tab-add,
.terminal-tab-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: currentColor;
    cursor: pointer;
}

.terminal-tab-close {
    width: 22px;
    height: 22px;
    margin-right: 8px;
    border-radius: 999px;
    font-size: 14px;
    line-height: 1;
}

.terminal-tab-close:hover {
    background: color-mix(in srgb, var(--k-color-divider), transparent 24%);
}

.terminal-tab-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 0 0 8px 8px;
    flex: 0 0 auto;
}

.create-host-select {
    width: 140px;
}

.terminal-tab-add {
    width: 30px;
    height: 30px;
    border-radius: 999px;
    color: var(--k-text-dark);
    font-size: 18px;
    line-height: 1;
}

.terminal-tab-clear {
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    color: var(--k-text-light);
    font-size: 12px;
}

.terminal-tab-add:hover,
.terminal-tab-clear:hover {
    background: color-mix(in srgb, var(--k-page-bg), transparent 30%);
}

.terminal-tab-add:disabled {
    opacity: 0.5;
    cursor: default;
}

.terminal-workspace {
    background: #0f1115;
}

.terminal-panes {
    min-height: 420px;
    background: #0f1115;
}

.terminal-pane {
    position: relative;
    height: 100%;
}

.terminal-host {
    height: min(56vh, 520px);
    overflow: hidden;
    padding: 12px 14px;
    box-sizing: border-box;
}

.terminal-empty,
.terminal-error {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    min-height: 420px;
    padding: 24px;
    color: #c7ccd4;
    text-align: center;
}

.terminal-error {
    position: absolute;
    inset: 0;
    background: #0f1115ee;
}

:deep(.xterm) {
    height: 100%;
}

:deep(.xterm-viewport) {
    overflow-y: auto !important;
    scrollbar-width: thin;
    scrollbar-color: rgba(148, 163, 184, 0.35) transparent;
}

:deep(.xterm-viewport::-webkit-scrollbar) {
    width: 10px;
}

:deep(.xterm-viewport::-webkit-scrollbar-track) {
    background: transparent;
}

:deep(.xterm-viewport::-webkit-scrollbar-thumb) {
    background: rgba(148, 163, 184, 0.35);
    border-radius: 10px;
    border: 2px solid transparent;
    background-clip: content-box;
}

:deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
    background: rgba(203, 213, 225, 0.55);
    background-clip: content-box;
}

@media (max-width: 768px) {
    .terminal-tabs {
        flex-wrap: wrap;
    }

    .terminal-tab-shell {
        max-width: calc(100% - 34px);
    }

    .terminal-tab-actions {
        margin-left: 0;
        width: 100%;
        justify-content: flex-end;
        flex-wrap: wrap;
    }

    .create-host-select {
        width: 100%;
    }

    .terminal-host {
        height: 420px;
        padding: 10px;
    }
}
</style>
