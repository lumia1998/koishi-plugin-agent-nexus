<template>
    <el-dialog
        :model-value="modelValue"
        title="Agent 工具覆盖"
        width="min(92vw, 560px)"
        destroy-on-close
        @update:model-value="emit('update:modelValue', $event)"
    >
        <div class="form-grid">
            <label class="setting wide">
                <span>Gateway Agent ID</span>
                <el-input
                    v-model="form.agentId"
                    :disabled="Boolean(agentId)"
                    placeholder="例如 hermes"
                />
            </label>
            <label class="setting">
                <span>工具显示名称</span>
                <el-input v-model="form.name" placeholder="留空则使用 Agent 名称" />
            </label>
            <label class="setting toggle">
                <span>发布为 ChatLuna 工具</span>
                <el-switch v-model="form.enabled" />
            </label>
            <label class="setting wide">
                <span>工作区覆盖</span>
                <el-input
                    v-model="form.workspace"
                    placeholder="留空使用 Gateway 中的默认工作区"
                />
            </label>
            <label class="setting wide">
                <span>工具描述覆盖</span>
                <el-input
                    v-model="form.description"
                    type="textarea"
                    :rows="3"
                    placeholder="留空使用 Gateway 返回的描述"
                />
            </label>
            <label class="setting wide">
                <span>技能标签</span>
                <el-input
                    v-model="form.skills"
                    placeholder="用逗号分隔，例如 coding, research"
                />
            </label>
        </div>
        <template #footer>
            <el-button @click="emit('update:modelValue', false)">取消</el-button>
            <el-button type="primary" :loading="saving" @click="submit">
                保存覆盖
            </el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'

const props = defineProps<{
    modelValue: boolean
    agentId: string
    name: string
    enabled: boolean
    workspace: string
    description: string
    skills: string
    saving?: boolean
}>()

const emit = defineEmits<{
    (event: 'update:modelValue', value: boolean): void
    (
        event: 'submit',
        value: {
            agentId: string
            name: string
            enabled: boolean
            workspace: string
            description: string
            skills: string
        }
    ): void
}>()

const form = reactive({
    agentId: '',
    name: '',
    enabled: true,
    workspace: '',
    description: '',
    skills: ''
})

watch(
    () => props.modelValue,
    (open) => {
        if (!open) return
        form.agentId = props.agentId
        form.name = props.name
        form.enabled = props.enabled
        form.workspace = props.workspace
        form.description = props.description
        form.skills = props.skills
    },
    { immediate: true }
)

function submit() {
    emit('submit', { ...form })
}
</script>

<style scoped>
.form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}

.setting {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
}

.setting > span {
    color: var(--k-text-light);
    font-size: 12px;
    font-weight: 600;
}

.setting.wide {
    grid-column: 1 / -1;
}

.setting.toggle {
    justify-content: space-between;
}

@media (max-width: 680px) {
    .form-grid {
        grid-template-columns: 1fr;
    }

    .setting.wide {
        grid-column: auto;
    }
}
</style>
