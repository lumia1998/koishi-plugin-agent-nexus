<template>
    <div class="agents-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">Code Agent 运行配置</div>
                <div class="panel-description">
                    控制远端 Agent 的启用状态、权限参数和自动路由候选。
                </div>
            </div>
            <el-button plain @click="$emit('scan')">重新扫描全部主机</el-button>
        </div>

        <div class="runtime-grid">
            <div class="runtime-item wide">
                <div>
                    <div class="row-title">OpenClaw Agent</div>
                    <div class="row-description">非交互任务使用的 OpenClaw agent 名称。</div>
                </div>
                <el-input
                    class="control"
                    :model-value="config.runtime.openclawAgent"
                    @update:model-value="(v) => patchRuntime({ openclawAgent: v })"
                />
            </div>
            <div class="runtime-item">
                <div>
                    <div class="row-title">默认执行超时</div>
                    <div class="row-description">单次委托最长等待时间。</div>
                </div>
                <div class="control-line">
                    <el-input-number
                        :model-value="Math.round(config.runtime.defaultTimeoutMs / 1000)"
                        :min="10"
                        :step="10"
                        controls-position="right"
                        @update:model-value="(v) => patchRuntime({ defaultTimeoutMs: Number(v) * 1000 })"
                    />
                    <span>秒</span>
                </div>
            </div>
        </div>

        <div class="agent-list">
            <section v-for="kind in kinds" :key="kind" class="agent-card">
                <div class="agent-head">
                    <div class="agent-intro">
                        <div class="agent-title-row">
                            <div class="agent-title">{{ labels[kind] }}</div>
                            <el-tag
                                size="small"
                                effect="plain"
                                :type="config.agents[kind] ? 'success' : 'info'"
                            >
                                {{ config.agents[kind] ? '已启用' : '已禁用' }}
                            </el-tag>
                            <el-tag size="small" effect="plain">
                                {{ installedCount(kind) }}/{{ status.hosts.length }} 台主机可用
                            </el-tag>
                        </div>
                        <div class="agent-copy">{{ descriptions[kind] }}</div>
                    </div>
                    <el-button
                        :type="config.agents[kind] ? 'danger' : 'success'"
                        plain
                        @click="toggle(kind, !config.agents[kind])"
                    >
                        {{ config.agents[kind] ? '禁用' : '启用' }}
                    </el-button>
                </div>

                <div class="agent-body">
                    <div v-if="kind === 'claude'" class="option-row danger-row">
                        <div>
                            <div class="row-title">跳过权限确认</div>
                            <div class="row-description">允许 Claude Code 非交互执行高权限操作。</div>
                        </div>
                        <el-switch
                            :model-value="config.runtime.claudeSkipPermissions"
                            @change="(v: boolean) => patchRuntime({ claudeSkipPermissions: v })"
                        />
                    </div>
                    <div v-else-if="kind === 'codex'" class="option-row danger-row">
                        <div>
                            <div class="row-title">绕过 Sandbox</div>
                            <div class="row-description">允许 Codex 使用危险的 sandbox bypass 参数。</div>
                        </div>
                        <el-switch
                            :model-value="config.runtime.codexBypassSandbox"
                            @change="(v: boolean) => patchRuntime({ codexBypassSandbox: v })"
                        />
                    </div>
                    <div v-else-if="kind === 'opencode'" class="option-row">
                        <div>
                            <div class="row-title">自动批准</div>
                            <div class="row-description">执行时附加 OpenCode 的 --auto 参数。</div>
                        </div>
                        <el-switch
                            :model-value="config.runtime.opencodeAuto"
                            @change="(v: boolean) => patchRuntime({ opencodeAuto: v })"
                        />
                    </div>

                    <div class="detection-list">
                        <div v-for="row in rowsFor(kind)" :key="row.hostId" class="detection-row">
                            <div class="detection-host">{{ row.host }}</div>
                            <el-tag
                                size="small"
                                effect="plain"
                                :type="row.installed ? 'success' : 'info'"
                            >
                                {{ row.installed ? '已安装' : '未探测到' }}
                            </el-tag>
                            <div class="detection-version">{{ row.version || '-' }}</div>
                            <div class="detection-path">{{ row.path || '-' }}</div>
                        </div>
                        <div v-if="!status.hosts.length" class="empty-row">
                            添加并扫描 SSH 主机后显示探测结果。
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { AgentKind, NexusConfig, NexusStatus } from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
}>()

const emit = defineEmits<{
    change: [NexusConfig]
    scan: [string?]
}>()

const kinds: AgentKind[] = ['hermes', 'openclaw', 'claude', 'opencode', 'codex']
const labels: Record<AgentKind, string> = {
    hermes: 'Hermes',
    openclaw: 'OpenClaw',
    claude: 'Claude Code',
    opencode: 'OpenCode',
    codex: 'Codex'
}
const descriptions: Record<AgentKind, string> = {
    hermes: '通过 hermes -z 非交互执行任务，适合通用问答和工具调用。',
    openclaw: '使用远端 OpenClaw local agent 处理任务和 Skills。',
    claude: '调用 Claude Code print 模式，适合复杂代码分析与修改。',
    opencode: '调用 OpenCode run 模式，可使用远端项目上下文执行任务。',
    codex: '调用 Codex exec，适合工程实现、检查和自动化操作。'
}

function toggle(kind: AgentKind, value: boolean) {
    emit('change', {
        ...props.config,
        agents: { ...props.config.agents, [kind]: value }
    })
}

function patchRuntime(partial: Partial<NexusConfig['runtime']>) {
    emit('change', {
        ...props.config,
        runtime: { ...props.config.runtime, ...partial }
    })
}

function rowsFor(kind: AgentKind) {
    return props.status.hosts.map((host) => {
        const agent = host.agents.find((item) => item.kind === kind)
        return {
            hostId: host.id,
            host: host.name,
            installed: agent?.installed || false,
            version: agent?.version,
            path: agent?.path
        }
    })
}

function installedCount(kind: AgentKind) {
    return rowsFor(kind).filter((row) => row.installed).length
}
</script>

<style scoped>
.agents-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
}

.panel-head,
.agent-head,
.runtime-item,
.option-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
}

.panel-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.panel-description,
.row-description,
.agent-copy {
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--k-text-light);
}

.runtime-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
}

.runtime-item {
    min-width: 0;
    padding: 16px 18px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
}

.control {
    width: 220px;
}

.control-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--k-text-light);
}

.agent-list {
    display: grid;
    gap: 16px;
}

.agent-card {
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
    overflow: hidden;
}

.agent-head {
    align-items: flex-start;
    padding: 18px;
}

.agent-intro {
    min-width: 0;
}

.agent-title-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.agent-title,
.row-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.agent-title {
    font-size: 16px;
}

.agent-body {
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 28%);
}

.option-row {
    padding: 14px 18px;
    background: color-mix(in srgb, var(--k-page-bg), transparent 12%);
}

.danger-row {
    background: color-mix(in srgb, var(--el-color-danger-light-9), transparent 22%);
}

.detection-list {
    display: grid;
}

.detection-row {
    display: grid;
    grid-template-columns: minmax(120px, 0.8fr) auto minmax(120px, 0.8fr) minmax(180px, 1.4fr);
    align-items: center;
    gap: 14px;
    padding: 12px 18px;
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 45%);
    font-size: 12px;
}

.detection-host {
    font-weight: 600;
    color: var(--k-text-dark);
}

.detection-version,
.detection-path,
.empty-row {
    min-width: 0;
    overflow: hidden;
    color: var(--k-text-light);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.empty-row {
    padding: 18px;
}

@media (max-width: 840px) {
    .runtime-grid {
        grid-template-columns: 1fr;
    }

    .detection-row {
        grid-template-columns: 1fr auto;
    }

    .detection-version,
    .detection-path {
        grid-column: 1 / -1;
    }
}

@media (max-width: 720px) {
    .panel-head,
    .agent-head,
    .runtime-item,
    .option-row {
        align-items: flex-start;
        flex-direction: column;
    }

    .control,
    .control-line,
    .control-line :deep(.el-input-number) {
        width: 100%;
    }
}
</style>
