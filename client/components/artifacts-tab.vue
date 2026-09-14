<template>
    <div class="artifacts">
        <div class="summary">
            <article>
                <span>产物总数</span>
                <strong>{{ rows.length }}</strong>
            </article>
            <article>
                <span>可下载</span>
                <strong>{{ downloadableCount }}</strong>
            </article>
            <article>
                <span>外部链接</span>
                <strong>{{ linkedCount }}</strong>
            </article>
            <article>
                <span>涉及任务</span>
                <strong>{{ jobCount }}</strong>
            </article>
        </div>

        <div class="filters">
            <el-input
                v-model="search"
                clearable
                placeholder="搜索产物名称、Agent、任务 ID"
            />
            <el-select v-model="kindFilter" placeholder="全部类型">
                <el-option label="全部类型" value="all" />
                <el-option label="可下载" value="downloadable" />
                <el-option label="外部链接" value="linked" />
                <el-option label="仅记录" value="inert" />
            </el-select>
        </div>

        <div v-if="!jobsLoaded" class="empty">正在读取任务…</div>

        <div v-else-if="!rows.length" class="empty">
            本插件发起的任务还没有产物。
        </div>

        <div v-else class="artifact-table">
            <div class="table-head">
                <span>名称</span>
                <span>类型</span>
                <span>来源</span>
                <span>状态</span>
                <span>操作</span>
            </div>
            <article v-for="row in filtered" :key="row.key" class="artifact-row">
                <div class="artifact-copy" data-label="名称">
                    <button class="name-button" type="button" @click="openDetail(row)">
                        {{ row.name }}
                    </button>
                    <code v-if="row.filename && row.filename !== row.name">
                        {{ row.filename }}
                    </code>
                </div>
                <code class="media" data-label="类型">
                    {{ row.mediaType || '未知' }}
                </code>
                <div class="source" data-label="来源">
                    <strong>{{ row.job.agentName }}</strong>
                    <code>{{ shortId(row.job.id) }}</code>
                </div>
                <div data-label="状态">
                    <el-tag
                        v-if="row.artifactId && row.job.gatewayRunId"
                        size="small"
                        effect="plain"
                        type="success"
                    >
                        可下载
                    </el-tag>
                    <el-tag
                        v-else-if="row.url"
                        size="small"
                        effect="plain"
                        type="primary"
                    >
                        外部链接
                    </el-tag>
                    <el-tag
                        v-else
                        size="small"
                        effect="plain"
                        :type="row.downloadError ? 'warning' : 'info'"
                    >
                        {{ row.downloadError ? '下载失败' : '仅记录' }}
                    </el-tag>
                    <small v-if="row.downloadError" class="download-error">
                        {{ row.downloadError }}
                    </small>
                </div>
                <div class="row-actions" data-label="操作">
                    <el-button
                        v-if="row.artifactId && row.job.gatewayRunId"
                        size="small"
                        text
                        :loading="downloadingKey === row.key"
                        @click="download(row)"
                    >
                        下载
                    </el-button>
                    <a
                        v-if="row.url"
                        class="external"
                        :href="row.url"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        打开链接
                    </a>
                </div>
            </article>
        </div>

        <el-dialog
            v-model="detailVisible"
            width="min(900px, 94vw)"
            destroy-on-close
            :title="detail?.name || '产物详情'"
        >
            <div v-if="detail" class="detail">
                <div class="detail-grid">
                    <div>
                        <span>类型</span>
                        <code>{{ detail.mediaType || '未知' }}</code>
                    </div>
                    <div>
                        <span>来源智能体</span>
                        <code>{{ detail.job.agentName }}</code>
                    </div>
                    <div>
                        <span>任务 ID</span>
                        <code>{{ detail.job.id }}</code>
                    </div>
                    <div>
                        <span>Gateway Run ID</span>
                        <code>{{ detail.job.gatewayRunId || '尚未返回' }}</code>
                    </div>
                </div>

                <p v-if="detail.downloadError" class="detail-warning">
                    {{ detail.downloadError }}
                </p>

                <div class="preview">
                    <img
                        v-if="previewUrl && previewKind === 'image'"
                        :src="previewUrl"
                        :alt="detail.name"
                        @error="failPreview('图片预览加载失败，请下载后查看。')"
                    />
                    <video
                        v-else-if="previewUrl && previewKind === 'video'"
                        :src="previewUrl"
                        controls
                        preload="metadata"
                        @error="failPreview('视频预览加载失败，请下载后查看。')"
                    />
                    <audio
                        v-else-if="previewUrl && previewKind === 'audio'"
                        :src="previewUrl"
                        controls
                        preload="metadata"
                        @error="failPreview('音频预览加载失败，请下载后查看。')"
                    />
                    <pre v-else-if="previewKind === 'text'">{{ textPreview }}</pre>
                    <p v-else-if="previewKind === 'loading'" class="preview-note">
                        正在生成预览…
                    </p>
                    <p v-else-if="previewKind === 'error'" class="preview-note error">
                        预览加载失败：{{ previewError }}
                    </p>
                    <p v-else class="preview-note">
                        {{ detail.url
                            ? '该类型不支持在线预览，可在新窗口打开链接。'
                            : '该类型不支持在线预览，请下载后查看。' }}
                    </p>
                </div>
            </div>
            <template #footer>
                <el-button @click="detailVisible = false">关闭</el-button>
                <el-button
                    v-if="detail?.artifactId && detail.job.gatewayRunId"
                    type="primary"
                    :loading="Boolean(downloadingKey)"
                    @click="detail && download(detail)"
                >
                    下载
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import { shortId } from '../shared'
import type { DelegationJobView } from '../../src/delegation/types'

const props = defineProps<{
    jobs: DelegationJobView[]
    jobsLoaded: boolean
}>()

interface ArtifactRow {
    key: string
    name: string
    filename?: string
    mediaType?: string
    artifactId?: string
    url?: string
    downloadError?: string
    job: DelegationJobView
}

const TEXT_PREVIEW_LIMIT = 64 * 1024
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'])
const TEXT_EXTS = new Set([
    'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml',
    'xml', 'toml', 'ini', 'conf', 'env', 'sh', 'bash', 'ps1', 'js', 'mjs',
    'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h',
    'cpp', 'css', 'scss', 'html', 'htm', 'sql'
])

const search = ref('')
const kindFilter = ref('all')
const downloadingKey = ref('')
const detailVisible = ref(false)
const detail = ref<ArtifactRow>()
const previewKind = ref<
    'none' | 'loading' | 'image' | 'video' | 'audio' | 'text' | 'error'
>('none')
const previewUrl = ref('')
const previewError = ref('')
const textPreview = ref('')

const rows = computed<ArtifactRow[]>(() => {
    const list: ArtifactRow[] = []
    for (const job of props.jobs) {
        job.artifacts.forEach((artifact, index) => {
            list.push({
                key: `${job.id}:${artifact.id || index}`,
                name: artifact.name,
                filename: artifact.filename,
                mediaType: artifact.mediaType,
                artifactId: artifact.id,
                url: artifact.url,
                downloadError: artifact.downloadError,
                job
            })
        })
    }
    return list
})

const downloadableCount = computed(
    () => rows.value.filter((row) => row.artifactId && row.job.gatewayRunId).length
)

const linkedCount = computed(
    () => rows.value.filter((row) => !row.artifactId && row.url).length
)

const jobCount = computed(
    () => new Set(rows.value.map((row) => row.job.id)).size
)

const filtered = computed(() => {
    const query = search.value.trim().toLowerCase()
    return rows.value.filter((row) => {
        const downloadable = Boolean(row.artifactId && row.job.gatewayRunId)
        if (kindFilter.value === 'downloadable' && !downloadable) return false
        if (kindFilter.value === 'linked' && !(!row.artifactId && row.url)) return false
        if (kindFilter.value === 'inert' && (downloadable || row.url)) return false
        if (!query) return true
        return [
            row.name,
            row.filename,
            row.mediaType,
            row.job.agentName,
            row.job.id
        ].some((value) => value?.toLowerCase().includes(query))
    })
})

async function ticketFor(row: ArtifactRow, inline = false) {
    if (!row.artifactId) throw new Error('该产物没有可下载的内容。')
    const ticket = await send(
        'agent-nexus/createArtifactTicket',
        row.job.id,
        row.artifactId
    )
    return inline ? `${ticket.url}&inline=1` : ticket.url
}

async function download(row: ArtifactRow) {
    downloadingKey.value = row.key
    try {
        const url = await ticketFor(row)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = row.filename || row.name
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
    } catch (error: any) {
        ElMessage.error(error?.message || String(error))
    } finally {
        downloadingKey.value = ''
    }
}

async function openDetail(row: ArtifactRow) {
    detail.value = row
    detailVisible.value = true
    textPreview.value = ''
    previewUrl.value = ''
    previewError.value = ''
    const kind = previewKindFor(row)
    if (kind === 'none') {
        previewKind.value = 'none'
        return
    }
    previewKind.value = 'loading'
    try {
        const url = await ticketFor(row, true)
        if (detail.value?.key !== row.key) return
        if (kind === 'text') {
            const response = await fetch(url)
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const text = await response.text()
            textPreview.value =
                text.length > TEXT_PREVIEW_LIMIT
                    ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}\n\n…[预览已截断，请下载查看完整内容]`
                    : text
            previewKind.value = 'text'
        } else {
            previewUrl.value = url
            previewKind.value = kind
        }
    } catch (error: any) {
        if (detail.value?.key !== row.key) return
        // Surface the real reason instead of falling through to the
        // "unsupported type" note, which hides ticket/auth failures.
        previewKind.value = 'error'
        previewError.value = error?.message || String(error)
        ElMessage.error(previewError.value)
    }
}

function failPreview(reason: string) {
    previewKind.value = 'error'
    previewError.value = reason
    ElMessage.error(reason)
}

function previewKindFor(row: ArtifactRow) {
    const mediaType = (row.mediaType || '').toLowerCase()
    const extension = (row.filename || row.name).split('.').pop()?.toLowerCase() || ''
    if (mediaType.startsWith('image/') || IMAGE_EXTS.has(extension)) return 'image'
    if (mediaType.startsWith('video/') || VIDEO_EXTS.has(extension)) return 'video'
    if (mediaType.startsWith('audio/') || AUDIO_EXTS.has(extension)) return 'audio'
    if (mediaType.startsWith('text/') || TEXT_EXTS.has(extension)) return 'text'
    return 'none'
}
</script>

<style scoped>
.artifacts {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 12px;
}

.summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--nexus-line);
}

.summary article {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-right: 1px solid var(--nexus-line);
}

.summary article:last-child {
    border-right: 0;
}

.summary span {
    color: var(--k-text-light);
    font-size: 12px;
}

.summary strong {
    color: var(--nexus-ink);
}

.filters {
    display: flex;
    gap: 10px;
}

.filters :deep(.el-input) {
    max-width: 520px;
}

.filters :deep(.el-select) {
    width: 160px;
}

.empty {
    padding: 58px 20px;
    border: 1px solid var(--nexus-line);
    color: var(--k-text-light);
    text-align: center;
}

.artifact-table {
    border: 1px solid var(--nexus-line);
}

.table-head,
.artifact-row {
    display: grid;
    grid-template-columns:
        minmax(180px, 1.4fr) minmax(110px, 0.7fr) minmax(140px, 1fr)
        minmax(100px, 0.6fr) minmax(150px, auto);
    gap: 14px;
    align-items: center;
}

.table-head {
    padding: 10px 14px;
    border-bottom: 1px solid var(--nexus-line);
    color: var(--k-text-light);
    font-family: 'Cascadia Mono', 'Microsoft YaHei UI', monospace;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.artifact-row {
    padding: 13px 14px;
    background: var(--k-page-bg);
}

.artifact-row + .artifact-row {
    border-top: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 20%);
}

.artifact-copy,
.source {
    display: grid;
    min-width: 0;
    gap: 4px;
}

.artifact-copy strong,
.source strong {
    color: var(--nexus-ink);
    font-size: 13px;
    overflow-wrap: anywhere;
}

.artifact-copy code,
.source code,
.media {
    color: var(--k-text-light);
    font-size: 11px;
    overflow-wrap: anywhere;
}

.row-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.external {
    color: var(--k-color-primary);
    font-size: 12px;
    text-decoration: none;
}

.external:hover {
    text-decoration: underline;
}

.name-button {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--nexus-ink);
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    text-align: left;
    overflow-wrap: anywhere;
    cursor: pointer;
}

.name-button:hover {
    color: var(--k-color-primary);
    text-decoration: underline;
}

.detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid var(--nexus-line);
    background: var(--nexus-line);
}

.detail-grid div {
    display: grid;
    min-width: 0;
    gap: 6px;
    padding: 11px 12px;
    background: var(--k-side-bg);
}

.detail-grid span {
    color: var(--k-text-light);
    font-size: 10px;
}

.detail-grid code {
    overflow: hidden;
    color: var(--nexus-ink);
    font-size: 11px;
    overflow-wrap: anywhere;
}

.preview {
    display: grid;
    min-height: 120px;
    margin-top: 16px;
    padding: 14px;
    border: 1px solid var(--nexus-line);
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 28%);
    place-items: center;
}

.preview img,
.preview video {
    max-width: 100%;
    max-height: 46vh;
}

.preview pre {
    width: 100%;
    max-height: 46vh;
    margin: 0;
    overflow: auto;
    color: var(--nexus-ink);
    font: inherit;
    font-size: 12px;
    line-height: 1.65;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
}

.preview-note {
    margin: 0;
    color: var(--k-text-light);
    font-size: 12px;
    text-align: center;
}

.preview-note.error {
    color: var(--k-color-danger, #d03050);
}

.download-error {
    display: block;
    margin-top: 4px;
    color: var(--k-text-light);
    font-size: 11px;
    overflow-wrap: anywhere;
}

.detail-warning {
    margin: 12px 0 0;
    padding: 10px 12px;
    border: 1px solid var(--nexus-line);
    color: var(--k-color-warning, #d68f00);
    font-size: 12px;
    overflow-wrap: anywhere;
}

@media (max-width: 1040px) {
    .table-head {
        display: none;
    }

    .artifact-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px 20px;
    }

    .artifact-row > *::before {
        display: block;
        margin-bottom: 4px;
        color: var(--k-text-light);
        content: attr(data-label);
        font-size: 9px;
        letter-spacing: 0.08em;
    }

    .row-actions {
        justify-content: flex-start;
    }
}

@media (max-width: 760px) {
    .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .summary article {
        border-bottom: 1px solid var(--nexus-line);
    }

    .filters {
        flex-direction: column;
    }

    .filters :deep(.el-input),
    .filters :deep(.el-select) {
        width: 100%;
        max-width: none;
    }

    .artifact-row {
        grid-template-columns: 1fr;
    }
}
</style>
