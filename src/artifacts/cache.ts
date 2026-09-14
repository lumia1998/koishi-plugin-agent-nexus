import { createHash, randomUUID } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, readFile, readdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { Transform, type Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { renameWithRetry, writeFileAtomic } from '../utils/atomic-file'

/** Raised when a streamed artifact would exceed the cache's byte budget. */
export class ArtifactCacheTooLargeError extends Error {
    constructor(
        readonly limitBytes: number,
        readonly seenBytes: number
    ) {
        super(
            `Artifact exceeds the cache budget (${seenBytes} > ${limitBytes} bytes)`
        )
        this.name = 'ArtifactCacheTooLargeError'
    }
}

export interface ArtifactCacheOptions {
    /** Cache directory. Always derived from the Koishi base directory. */
    root: string
    enabled: boolean
    ttlMs: number
    maxTotalBytes: number
    now?: () => number
}

export interface ArtifactCacheMetadata {
    name: string
    mediaType?: string
}

export interface CachedArtifact extends ArtifactCacheMetadata {
    /** Absolute path of the cached file on this instance. */
    path: string
    size: number
}

export interface ArtifactCacheStats {
    removed: number
    freedBytes: number
    remainingBytes: number
    remainingEntries: number
}

interface CacheEntryFile extends ArtifactCacheMetadata {
    jobId: string
    artifactId: string
    size: number
    createdAt: number
    lastAccessedAt: number
}

/** Only rewrite the LRU timestamp when it is this stale, to avoid write amplification. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Stores Gateway artifacts on the local disk so the Console can serve them
 * without holding the API key in the browser and without re-fetching from the
 * Gateway on every preview.
 *
 * Every path is derived from `root` with `path.join`, and file names are a
 * digest of the job/artifact pair, so the layout is identical on Windows,
 * Linux and inside a container: no absolute paths, no separators baked in, and
 * no characters that are illegal on either platform.
 */
export class ArtifactCache {
    private readonly now: () => number

    constructor(private readonly options: ArtifactCacheOptions) {
        this.now = options.now || (() => Date.now())
    }

    get enabled() {
        return this.options.enabled
    }

    get root() {
        return this.options.root
    }

    /** Total on-disk budget, which is also the per-artifact streaming ceiling. */
    get maxTotalBytes() {
        return this.options.maxTotalBytes
    }

    async init() {
        if (!this.options.enabled) return
        await mkdir(this.options.root, { recursive: true })
    }

    /** Absolute path for one artifact. Never leaves the cache root. */
    pathFor(jobId: string, artifactId: string) {
        return path.join(this.options.root, `${digest(jobId, artifactId)}.bin`)
    }

    private metaPathFor(jobId: string, artifactId: string) {
        return path.join(this.options.root, `${digest(jobId, artifactId)}.json`)
    }

    /**
     * Returns the cached artifact and refreshes its LRU timestamp. Returns
     * undefined when the artifact was never cached or the file went missing.
     */
    async lookup(jobId: string, artifactId: string): Promise<CachedArtifact | undefined> {
        if (!this.options.enabled) return undefined
        const metaPath = this.metaPathFor(jobId, artifactId)
        const filePath = this.pathFor(jobId, artifactId)
        const entry = await readEntry(metaPath)
        if (!entry) return undefined
        const info = await stat(filePath).catch(() => undefined)
        if (!info?.isFile()) {
            await unlink(metaPath).catch(() => undefined)
            return undefined
        }
        await this.touch(metaPath, entry, info.size)
        return {
            path: filePath,
            size: info.size,
            name: entry.name,
            mediaType: entry.mediaType
        }
    }

    async store(
        jobId: string,
        artifactId: string,
        bytes: Uint8Array,
        metadata: ArtifactCacheMetadata
    ): Promise<CachedArtifact | undefined> {
        if (!this.options.enabled) return undefined
        if (bytes.length > this.options.maxTotalBytes) return undefined
        const filePath = this.pathFor(jobId, artifactId)
        const metaPath = this.metaPathFor(jobId, artifactId)
        await mkdir(this.options.root, { recursive: true })
        const timestamp = this.now()
        const previous = await readEntry(metaPath)
        const entry: CacheEntryFile = {
            jobId,
            artifactId,
            name: metadata.name,
            mediaType: metadata.mediaType,
            size: bytes.length,
            createdAt: previous?.createdAt ?? timestamp,
            lastAccessedAt: timestamp
        }
        await writeFileAtomic(filePath, bytes)
        await writeFileAtomic(metaPath, Buffer.from(JSON.stringify(entry)))
        return {
            path: filePath,
            size: bytes.length,
            name: entry.name,
            mediaType: entry.mediaType
        }
    }

    /**
     * Streams an artifact straight to the cache file instead of buffering it.
     * Memory stays flat regardless of size, so the ceiling is the disk budget
     * rather than a single in-memory response limit — this is what lets
     * artifacts larger than `maxResponseBytes` be downloaded at all.
     */
    async storeStream(
        jobId: string,
        artifactId: string,
        source: Readable,
        metadata: ArtifactCacheMetadata,
        maxBytes: number
    ): Promise<CachedArtifact> {
        const filePath = this.pathFor(jobId, artifactId)
        const metaPath = this.metaPathFor(jobId, artifactId)
        await mkdir(this.options.root, { recursive: true })
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.part`
        let size = 0
        try {
            await pipeline(
                source,
                new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        size += chunk.length
                        if (size > maxBytes) {
                            callback(
                                new ArtifactCacheTooLargeError(maxBytes, size)
                            )
                            return
                        }
                        callback(null, chunk)
                    }
                }),
                createWriteStream(tempPath)
            )
            // Only publish the file once it is complete, so a failed or
            // truncated transfer never leaves a readable half-artifact.
            await renameWithRetry(tempPath, filePath)
        } catch (error) {
            await unlink(tempPath).catch(() => undefined)
            throw error
        }
        const timestamp = this.now()
        const previous = await readEntry(metaPath)
        const entry: CacheEntryFile = {
            jobId,
            artifactId,
            name: metadata.name,
            mediaType: metadata.mediaType,
            size,
            createdAt: previous?.createdAt ?? timestamp,
            lastAccessedAt: timestamp
        }
        await writeFileAtomic(metaPath, Buffer.from(JSON.stringify(entry)))
        return {
            path: filePath,
            size,
            name: entry.name,
            mediaType: entry.mediaType
        }
    }

    /**
     * Drops expired entries, then evicts least-recently-used entries until the
     * directory fits the byte budget. Time alone is not enough: a burst of
     * large artifacts can fill the disk long before its TTL expires.
     */
    async prune(): Promise<ArtifactCacheStats> {
        const stats: ArtifactCacheStats = {
            removed: 0,
            freedBytes: 0,
            remainingBytes: 0,
            remainingEntries: 0
        }
        if (!this.options.enabled) return stats
        const names = await readdir(this.options.root).catch(() => [] as string[])
        const entries: Array<{ metaPath: string; filePath: string; entry: CacheEntryFile }> = []
        const now = this.now()

        for (const name of names) {
            const filePath = path.join(this.options.root, name)
            if (name.endsWith('.bin')) {
                const metaPath = `${filePath.slice(0, -4)}.json`
                const entry = await readEntry(metaPath)
                if (!entry) {
                    // Orphaned payload without metadata: drop it.
                    const info = await stat(filePath).catch(() => undefined)
                    if (info?.isFile()) {
                        await unlink(filePath).catch(() => undefined)
                        stats.removed += 1
                        stats.freedBytes += info.size
                    }
                } else {
                    entries.push({ metaPath, filePath, entry })
                }
            } else if (name.endsWith('.json')) {
                const info = await stat(filePath).catch(() => undefined)
                if (!info?.isFile()) continue
                const binPath = `${filePath.slice(0, -5)}.bin`
                const binInfo = await stat(binPath).catch(() => undefined)
                if (!binInfo?.isFile()) {
                    // Metadata without payload: drop it.
                    await unlink(filePath).catch(() => undefined)
                }
            } else {
                continue
            }
        }

        const kept: typeof entries = []
        for (const item of entries) {
            const info = await stat(item.filePath).catch(() => undefined)
            if (!info?.isFile()) continue
            if (now - item.entry.lastAccessedAt > this.options.ttlMs) {
                await this.remove(item.filePath, item.metaPath)
                stats.removed += 1
                stats.freedBytes += info.size
                continue
            }
            kept.push(item)
        }

        kept.sort((a, b) => a.entry.lastAccessedAt - b.entry.lastAccessedAt)
        let total = kept.reduce((sum, item) => sum + item.entry.size, 0)
        let index = 0
        while (total > this.options.maxTotalBytes && index < kept.length) {
            const item = kept[index++]
            const info = await stat(item.filePath).catch(() => undefined)
            const size = info?.size ?? item.entry.size
            await this.remove(item.filePath, item.metaPath)
            total -= size
            stats.removed += 1
            stats.freedBytes += size
        }

        stats.remainingEntries = kept.length - index
        stats.remainingBytes = Math.max(0, total)
        return stats
    }

    /** Removes every cached artifact regardless of TTL. */
    async clear() {
        if (!this.options.enabled) return 0
        const names = await readdir(this.options.root).catch(() => [] as string[])
        let removed = 0
        for (const name of names) {
            if (!name.endsWith('.bin') && !name.endsWith('.json')) continue
            await unlink(path.join(this.options.root, name)).catch(() => undefined)
            if (name.endsWith('.bin')) removed += 1
        }
        return removed
    }

    private async touch(metaPath: string, entry: CacheEntryFile, size: number) {
        const now = this.now()
        if (now - entry.lastAccessedAt < TOUCH_INTERVAL_MS) return
        const updated: CacheEntryFile = { ...entry, size, lastAccessedAt: now }
        await writeFileAtomic(metaPath, Buffer.from(JSON.stringify(updated))).catch(
            () => undefined
        )
    }

    private async remove(filePath: string, metaPath: string) {
        await unlink(filePath).catch(() => undefined)
        await unlink(metaPath).catch(() => undefined)
    }
}

/**
 * Cache keys are a digest rather than the raw identifiers: job and artifact ids
 * come from the Gateway, so they may contain path separators, `..`, reserved
 * Windows device names or characters that are simply illegal on one platform.
 */
function digest(jobId: string, artifactId: string) {
    return createHash('sha256')
        .update(`${jobId} ${artifactId}`)
        .digest('hex')
        .slice(0, 32)
}

async function readEntry(metaPath: string): Promise<CacheEntryFile | undefined> {
    const raw = await readFile(metaPath, 'utf8').catch(() => undefined)
    if (!raw) return undefined
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return undefined
        if (typeof parsed.name !== 'string') return undefined
        return {
            jobId: String(parsed.jobId || ''),
            artifactId: String(parsed.artifactId || ''),
            name: parsed.name,
            mediaType:
                typeof parsed.mediaType === 'string' ? parsed.mediaType : undefined,
            size: Number(parsed.size) || 0,
            createdAt: Number(parsed.createdAt) || 0,
            lastAccessedAt: Number(parsed.lastAccessedAt) || 0
        }
    } catch {
        return undefined
    }
}
