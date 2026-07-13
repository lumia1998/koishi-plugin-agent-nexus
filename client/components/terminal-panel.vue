<template>
    <div class="terminal-panel">
        <div class="terminal-head">
            <div>
                <div class="terminal-title">SSH Terminal</div>
                <div class="terminal-description">
                    进入此页面时自动连接默认 SSH Computer。
                </div>
            </div>
            <div class="terminal-state">
                <span class="dot" :class="{ on: connected }" />
                {{ connected ? '已连接' : opening ? '连接中' : '未连接' }}
            </div>
        </div>

        <div class="terminal-frame">
            <div ref="terminalHost" class="terminal-host" />
            <div v-if="error" class="terminal-error">
                <div>{{ error }}</div>
                <el-button size="small" @click="open">重新连接</el-button>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import 'xterm/css/xterm.css'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { send } from '@koishijs/client'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { NexusConfig, NexusStatus, TerminalInfo } from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
}>()

const terminalHost = ref<HTMLDivElement>()
const opening = ref(false)
const connected = ref(false)
const error = ref('')
let info: TerminalInfo | undefined
let term: Terminal | undefined
let fit: FitAddon | undefined
let socket: WebSocket | undefined
let observer: ResizeObserver | undefined

onMounted(open)
onBeforeUnmount(close)

async function open() {
    if (opening.value || connected.value) return
    error.value = ''
    opening.value = true
    await close()
    try {
        const hostId = props.config.defaultHostId || props.config.hosts[0]?.id
        if (!hostId) throw new Error('请先在 Computer 页面配置 SSH 连接。')
        await send('agent-nexus/saveConfig', props.config)
        info = (await send('agent-nexus/openTerminal', {
            hostId,
            cols: 120,
            rows: 30
        })) as TerminalInfo
        await nextTick()
        if (!terminalHost.value) return

        term = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            theme: { background: '#0f1115', foreground: '#d7dce2' }
        })
        fit = new FitAddon()
        term.loadAddon(fit)
        term.open(terminalHost.value)
        fit.fit()

        const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
        socket = new WebSocket(
            `${protocol}://${location.host}${info.url}?token=${encodeURIComponent(info.token)}`
        )
        socket.onopen = () => {
            connected.value = true
            socket?.send(JSON.stringify({ type: 'resize', cols: term?.cols, rows: term?.rows }))
        }
        socket.onmessage = (event) => {
            try {
                const message = JSON.parse(String(event.data))
                if (message.type === 'data') term?.write(message.data)
            } catch {
                term?.write(String(event.data))
            }
        }
        socket.onerror = () => {
            error.value = '终端 WebSocket 连接失败。'
        }
        socket.onclose = () => {
            connected.value = false
        }
        term.onData((data) => {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'input', data }))
            }
        })

        observer = new ResizeObserver(() => {
            fit?.fit()
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'resize', cols: term?.cols, rows: term?.rows }))
            }
        })
        observer.observe(terminalHost.value)
    } catch (err: any) {
        error.value = err?.message || String(err)
    } finally {
        opening.value = false
    }
}

async function close() {
    observer?.disconnect()
    observer = undefined
    socket?.close()
    socket = undefined
    term?.dispose()
    term = undefined
    fit = undefined
    connected.value = false
    if (info) {
        try {
            await send('agent-nexus/closeTerminal', info.sessionId, info.terminalId)
        } catch {}
        info = undefined
    }
    if (terminalHost.value) terminalHost.value.innerHTML = ''
}
</script>

<style scoped>
.terminal-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 560px;
}

.terminal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}

.terminal-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.terminal-description {
    margin-top: 4px;
    font-size: 13px;
    color: var(--k-text-light);
}

.terminal-state {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--k-text-light);
}

.dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #68707c;
}

.dot.on {
    background: #3ddc97;
    box-shadow: 0 0 8px #3ddc9788;
}

.terminal-frame {
    position: relative;
    flex: 1;
    min-height: 500px;
    overflow: hidden;
    border: 1px solid var(--k-color-border, #3333);
    border-radius: 12px;
    background: #0f1115;
}

.terminal-host {
    width: 100%;
    height: 100%;
    padding: 6px;
    box-sizing: border-box;
}

.terminal-error {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    color: #c7ccd4;
    background: #0f1115ee;
}

@media (max-width: 720px) {
    .terminal-panel {
        min-height: 460px;
    }

    .terminal-head {
        align-items: flex-start;
        flex-direction: column;
    }

    .terminal-frame {
        min-height: 400px;
    }
}
</style>
