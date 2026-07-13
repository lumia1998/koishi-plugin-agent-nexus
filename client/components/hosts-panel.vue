<template>
    <div class="hosts-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">SSH 执行后端</div>
                <div class="panel-description">
                    管理用于运行 Code Agent、同步 Skills 和回传产物的远端机器。
                </div>
            </div>
            <el-button type="primary" @click="addHost">添加主机</el-button>
        </div>

        <div class="summary-grid">
            <div class="summary-item">
                <div class="summary-value">{{ config.hosts.length }}</div>
                <div class="summary-label">已配置主机</div>
            </div>
            <div class="summary-item">
                <div class="summary-value">{{ enabledCount }}</div>
                <div class="summary-label">启用后端</div>
            </div>
            <div class="summary-item">
                <div class="summary-value">{{ status.activeSessions }}</div>
                <div class="summary-label">活跃连接</div>
            </div>
        </div>

        <div v-if="config.hosts.length" class="host-list">
            <section v-for="host in config.hosts" :key="host.id" class="host-card">
                <div class="host-head">
                    <div class="host-intro">
                        <div class="host-title-row">
                            <div class="host-title">{{ host.name }}</div>
                            <el-tag
                                size="small"
                                effect="plain"
                                :type="host.enabled ? 'success' : 'info'"
                            >
                                {{ host.enabled ? '已启用' : '已禁用' }}
                            </el-tag>
                            <el-tag
                                v-if="config.defaultHostId === host.id"
                                size="small"
                                effect="plain"
                            >
                                默认
                            </el-tag>
                            <el-tag size="small" effect="plain">
                                {{ hostState(host.id)?.sessionCount || 0 }} 个会话
                            </el-tag>
                        </div>
                        <div class="host-target">
                            {{ host.username }}@{{ host.host }}:{{ host.port || 22 }}
                        </div>
                        <div v-if="hostState(host.id)?.error" class="host-error">
                            {{ hostState(host.id)?.error }}
                        </div>
                    </div>

                    <div class="host-actions">
                        <el-button plain @click="$emit('test', host.id)">测试连接</el-button>
                        <el-button plain @click="$emit('scan', host.id)">扫描 Agents</el-button>
                        <el-button @click="edit(host)">编辑</el-button>
                        <el-switch
                            :model-value="host.enabled"
                            @change="(v: boolean) => patch(host.id, { enabled: v })"
                        />
                    </div>
                </div>

                <div class="host-body">
                    <div class="detail-item">
                        <div class="detail-label">认证方式</div>
                        <div class="detail-value">
                            {{ host.auth.type === 'key' ? 'SSH 私钥' : '密码' }}
                        </div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">默认 Agent</div>
                        <div class="detail-value">{{ host.defaultAgent || 'auto' }}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">工作目录</div>
                        <div class="detail-value path">{{ host.cwd || '远端 Home' }}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">闲置释放</div>
                        <div class="detail-value">
                            {{ Math.round(host.idleTimeoutMs / 60000) }} 分钟
                        </div>
                    </div>
                </div>

                <div class="host-footer">
                    <el-button text type="danger" @click="$emit('remove', host.id)">
                        删除此主机
                    </el-button>
                </div>
            </section>
        </div>

        <el-empty v-else description="还没有 SSH 主机，添加一台远端机器开始使用。" />

        <el-dialog
            v-model="visible"
            :title="draft.id ? '编辑 SSH 后端' : '添加 SSH 后端'"
            width="min(620px, calc(100vw - 24px))"
        >
            <el-form label-width="100px">
                <el-form-item label="名称">
                    <el-input v-model="draft.name" />
                </el-form-item>
                <el-form-item label="Host">
                    <el-input v-model="draft.host" />
                </el-form-item>
                <el-form-item label="Port">
                    <el-input-number v-model="draft.port" :min="1" :max="65535" />
                </el-form-item>
                <el-form-item label="用户名">
                    <el-input v-model="draft.username" />
                </el-form-item>
                <el-form-item label="认证方式">
                    <el-radio-group v-model="authType">
                        <el-radio label="password">密码</el-radio>
                        <el-radio label="key">私钥</el-radio>
                    </el-radio-group>
                </el-form-item>
                <el-form-item v-if="authType === 'password'" label="密码">
                    <el-input
                        v-model="password"
                        type="password"
                        show-password
                        :placeholder="draft.id ? '留空保持原密码，支持 env:VAR' : '支持 env:VAR'"
                    />
                </el-form-item>
                <template v-else>
                    <el-form-item label="私钥">
                        <el-input
                            v-model="privateKey"
                            type="textarea"
                            :rows="5"
                            :placeholder="draft.id ? '留空保持原私钥，或 env:SSH_KEY' : 'PEM 内容或 env:SSH_KEY'"
                        />
                    </el-form-item>
                    <el-form-item label="Passphrase">
                        <el-input
                            v-model="passphrase"
                            type="password"
                            show-password
                            :placeholder="draft.id ? '留空保持原 Passphrase' : ''"
                        />
                    </el-form-item>
                </template>
                <el-form-item label="默认 Agent">
                    <el-select v-model="draft.defaultAgent">
                        <el-option label="auto" value="auto" />
                        <el-option label="hermes" value="hermes" />
                        <el-option label="openclaw" value="openclaw" />
                        <el-option label="claude" value="claude" />
                        <el-option label="opencode" value="opencode" />
                        <el-option label="codex" value="codex" />
                    </el-select>
                </el-form-item>
                <el-form-item label="工作目录">
                    <el-input v-model="draft.cwd" placeholder="可选，如 ~/projects" />
                </el-form-item>
                <el-form-item label="设为默认">
                    <el-switch v-model="asDefault" />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="visible = false">取消</el-button>
                <el-button type="primary" @click="commit">确定</el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NexusConfig, NexusStatus, SshHostConfig } from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
}>()

const emit = defineEmits<{
    change: [NexusConfig]
    test: [string]
    scan: [string?]
    remove: [string]
}>()

const visible = ref(false)
const asDefault = ref(false)
const authType = ref<'password' | 'key'>('password')
const password = ref('')
const privateKey = ref('')
const passphrase = ref('')
const draft = ref<Partial<SshHostConfig>>({})

const enabledCount = computed(() => props.config.hosts.filter((host) => host.enabled).length)

function hostState(id: string) {
    return props.status.hosts.find((host) => host.id === id)
}

function addHost() {
    draft.value = {
        name: 'remote',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        enabled: true,
        defaultAgent: 'auto',
        idleTimeoutMs: 15 * 60 * 1000
    }
    authType.value = 'password'
    password.value = ''
    privateKey.value = ''
    passphrase.value = ''
    asDefault.value = props.config.hosts.length === 0
    visible.value = true
}

function edit(row: SshHostConfig) {
    draft.value = { ...row }
    authType.value = row.auth?.type === 'key' ? 'key' : 'password'
    password.value = ''
    privateKey.value = ''
    passphrase.value = ''
    asDefault.value = props.config.defaultHostId === row.id
    visible.value = true
}

function patch(id: string, partial: Partial<SshHostConfig>) {
    const hosts = props.config.hosts.map((h) =>
        h.id === id ? { ...h, ...partial } : h
    )
    emit('change', { ...props.config, hosts })
}

function commit() {
    const auth =
        authType.value === 'password'
            ? { type: 'password' as const, password: password.value }
            : {
                  type: 'key' as const,
                  privateKey: privateKey.value,
                  passphrase: passphrase.value || undefined
              }

    const id = draft.value.id || crypto.randomUUID()
    const host: SshHostConfig = {
        id,
        name: draft.value.name || 'remote',
        host: draft.value.host || '127.0.0.1',
        port: draft.value.port || 22,
        username: draft.value.username || 'root',
        auth,
        enabled: draft.value.enabled ?? true,
        defaultAgent: draft.value.defaultAgent || 'auto',
        cwd: draft.value.cwd,
        idleTimeoutMs: draft.value.idleTimeoutMs || 15 * 60 * 1000
    }

    const exists = props.config.hosts.some((h) => h.id === id)
    const hosts = exists
        ? props.config.hosts.map((h) => (h.id === id ? host : h))
        : [...props.config.hosts, host]

    emit('change', {
        ...props.config,
        hosts,
        defaultHostId: asDefault.value ? id : props.config.defaultHostId
    })
    visible.value = false
}
</script>

<style scoped>
.hosts-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
}
.panel-head,
.host-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
}

.panel-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.panel-description,
.host-target {
    margin-top: 5px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--k-text-light);
}

.summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
}

.summary-item {
    padding: 15px 18px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 25%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 30%);
}

.summary-value {
    font-size: 24px;
    font-weight: 650;
    color: var(--k-text-dark);
}

.summary-label,
.detail-label {
    margin-top: 3px;
    font-size: 12px;
    color: var(--k-text-light);
}

.host-list {
    display: grid;
    gap: 16px;
}

.host-card {
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
    overflow: hidden;
}

.host-head {
    padding: 18px;
}

.host-intro {
    min-width: 0;
}

.host-title-row,
.host-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.host-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.host-error {
    margin-top: 7px;
    font-size: 12px;
    color: var(--el-color-danger);
}

.host-body {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 30%);
    background: color-mix(in srgb, var(--k-color-divider), transparent 60%);
}

.detail-item {
    min-width: 0;
    padding: 14px 18px;
    background: var(--k-page-bg);
}

.detail-value {
    margin-top: 5px;
    font-size: 13px;
    color: var(--k-text-dark);
}

.detail-value.path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.host-footer {
    display: flex;
    justify-content: flex-end;
    padding: 4px 10px;
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 30%);
}

@media (max-width: 720px) {
    .panel-head,
    .host-head {
        flex-direction: column;
    }

    .panel-head :deep(.el-button),
    .host-actions {
        width: 100%;
    }

    .summary-grid {
        grid-template-columns: 1fr;
    }

    .host-body {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
</style>
