<template>
    <div class="skills-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">Skills</div>
                <div class="panel-description">
                    从 Git 仓库同步 Skills 到中心目录，并分发给远端 Code Agent。
                </div>
            </div>
            <div class="panel-actions">
                <el-button @click="$emit('refresh', hostId || undefined)">刷新目录</el-button>
                <el-button type="primary" @click="showImport = true">从仓库导入</el-button>
            </div>
        </div>

        <div class="catalog-controls">
            <el-select v-model="hostId" clearable placeholder="默认主机" class="host-select">
                <el-option
                    v-for="host in config.hosts"
                    :key="host.id"
                    :label="host.name"
                    :value="host.id"
                />
            </el-select>
            <el-input
                v-model="keyword"
                clearable
                class="search-input"
                placeholder="搜索 Skill 名称、路径或已链接 Agent"
            />
        </div>

        <div v-if="filteredSkills.length" class="skill-grid">
            <section v-for="skill in filteredSkills" :key="skill.id" class="skill-card">
                <div class="skill-top">
                    <div class="skill-brand">
                        <div class="skill-icon">S</div>
                        <div class="skill-copy">
                            <div class="skill-title">{{ skill.name }}</div>
                            <div class="skill-source">{{ skill.sourceId || '远端中心目录' }}</div>
                        </div>
                    </div>
                    <el-tag
                        size="small"
                        effect="plain"
                        :type="skill.linkedAgents.length ? 'success' : 'warning'"
                    >
                        {{ skill.linkedAgents.length ? '已分发' : '未链接' }}
                    </el-tag>
                </div>

                <div class="skill-path">{{ skill.path }}</div>

                <div class="skill-footer">
                    <div class="agent-tags">
                        <el-tag
                            v-for="agent in skill.linkedAgents"
                            :key="agent"
                            size="small"
                            effect="plain"
                        >
                            {{ agent }}
                        </el-tag>
                        <span v-if="!skill.linkedAgents.length" class="muted">
                            同步或扫描 Agent 后显示软链状态
                        </span>
                    </div>
                </div>
            </section>
        </div>

        <el-empty v-else description="没有找到已同步的 Skill。" />

        <el-dialog
            v-model="showImport"
            title="从 Git 仓库导入 Skill"
            width="min(620px, calc(100vw - 24px))"
            destroy-on-close
        >
            <el-form label-width="96px">
                <el-form-item label="仓库 URL">
                    <el-input v-model="repoUrl" placeholder="https://github.com/org/repo" />
                </el-form-item>
                <el-form-item label="Skill 名称">
                    <el-input v-model="name" placeholder="可选，默认使用仓库名" />
                </el-form-item>
                <el-form-item label="分支">
                    <el-input v-model="branch" placeholder="main" />
                </el-form-item>
                <el-form-item label="子目录">
                    <el-input v-model="subdir" placeholder="可选，例如 skills/foo" />
                </el-form-item>
                <el-form-item label="目标主机">
                    <el-select v-model="hostId" clearable placeholder="默认主机">
                        <el-option
                            v-for="host in config.hosts"
                            :key="host.id"
                            :label="host.name"
                            :value="host.id"
                        />
                    </el-select>
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="showImport = false">取消</el-button>
                <el-button type="primary" :loading="syncing" @click="sync">
                    同步 Skill
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NexusConfig, NexusStatus } from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
}>()

const emit = defineEmits<{
    sync: [
        {
            repoUrl: string
            name?: string
            branch?: string
            subdir?: string
            hostId?: string
        },
        () => void
    ]
    refresh: [string?]
}>()

const repoUrl = ref('')
const name = ref('')
const branch = ref('main')
const subdir = ref('')
const hostId = ref<string>()
const keyword = ref('')
const syncing = ref(false)
const showImport = ref(false)

const filteredSkills = computed(() => {
    const text = keyword.value.trim().toLowerCase()
    if (!text) return props.status.skills.items
    return props.status.skills.items.filter((skill) =>
        [skill.name, skill.path, skill.sourceId, ...skill.linkedAgents]
            .filter(Boolean)
            .join('\n')
            .toLowerCase()
            .includes(text)
    )
})

async function sync() {
    if (!repoUrl.value.trim()) return
    syncing.value = true
    try {
        await new Promise<void>((resolve) => {
            emit(
                'sync',
                {
                    repoUrl: repoUrl.value.trim(),
                    name: name.value || undefined,
                    branch: branch.value || undefined,
                    subdir: subdir.value || undefined,
                    hostId: hostId.value
                },
                resolve
            )
        })
        showImport.value = false
        repoUrl.value = ''
        name.value = ''
        subdir.value = ''
    } finally {
        syncing.value = false
    }
}
</script>

<style scoped>
.skills-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
}

.panel-head,
.catalog-controls,
.skill-top,
.skill-brand,
.skill-footer,
.panel-actions,
.agent-tags {
    display: flex;
    align-items: center;
    gap: 10px;
}

.panel-head,
.skill-top,
.skill-footer {
    justify-content: space-between;
}

.panel-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.panel-description {
    margin-top: 5px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--k-text-light);
}

.catalog-controls {
    justify-content: flex-end;
}

.host-select {
    width: 190px;
}

.search-input {
    width: min(100%, 380px);
}

.skill-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
}

.skill-card {
    min-width: 0;
    padding: 18px;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
}

.skill-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: 10px;
    background: color-mix(in srgb, var(--k-color-primary), transparent 84%);
    color: var(--k-color-primary);
    font-size: 14px;
    font-weight: 700;
}

.skill-copy {
    min-width: 0;
}

.skill-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--k-text-dark);
}

.skill-source,
.muted {
    margin-top: 3px;
    font-size: 12px;
    color: var(--k-text-light);
}

.skill-path {
    margin: 16px 0;
    padding: 10px 12px;
    overflow: hidden;
    border-radius: 9px;
    background: color-mix(in srgb, var(--k-page-bg), #000 3%);
    color: var(--k-text-light);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-tags {
    flex-wrap: wrap;
}

@media (max-width: 900px) {
    .skill-grid {
        grid-template-columns: 1fr;
    }
}

@media (max-width: 720px) {
    .panel-head,
    .catalog-controls {
        align-items: stretch;
        flex-direction: column;
    }

    .panel-actions,
    .host-select,
    .search-input {
        width: 100%;
    }

    .panel-actions :deep(.el-button) {
        flex: 1;
    }
}
</style>
