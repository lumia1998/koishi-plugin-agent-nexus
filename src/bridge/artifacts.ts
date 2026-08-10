import { createReadStream } from 'fs'
import { realpath, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import type { ServerResponse } from 'http'
import { mimeType } from '../utils/mime'

export interface BridgeArtifact {
    id: string
    path: string
    name: string
    mediaType: string
    size: number
    url: string
    expiresAt: number
}

export class BridgeArtifactRegistry {
    private items = new Map<string, BridgeArtifact>()
    private publicBaseUrl = ''

    constructor(
        private readonly root: string,
        private readonly ttlMs: number
    ) {}

    setPublicBaseUrl(value: string) {
        this.publicBaseUrl = value.replace(/\/$/, '')
    }

    async register(value: string, cwd: string): Promise<BridgeArtifact> {
        const root = await realpath(this.root)
        const requested = resolvePath(value, cwd)
        const resolved = await realpath(requested)
        if (!isWithin(resolved, root)) {
            throw new Error(`Artifact is outside the bridge root: ${value}`)
        }
        const info = await stat(resolved)
        if (!info.isFile()) throw new Error(`Artifact is not a file: ${value}`)
        const id = randomUUID()
        const item: BridgeArtifact = {
            id,
            path: resolved,
            name: path.basename(resolved),
            mediaType: mimeType(resolved),
            size: info.size,
            url: `${this.publicBaseUrl}/artifacts/${id}`,
            expiresAt: Date.now() + this.ttlMs
        }
        this.items.set(id, item)
        this.cleanup()
        return { ...item }
    }

    get(id: string) {
        this.cleanup()
        const item = this.items.get(id)
        return item ? { ...item } : undefined
    }

    async serve(id: string, response: ServerResponse) {
        const item = this.get(id)
        if (!item) return false
        try {
            const info = await stat(item.path)
            if (!info.isFile()) return false
            response.statusCode = 200
            response.setHeader('Content-Type', item.mediaType)
            response.setHeader('Content-Length', String(info.size))
            response.setHeader('Content-Disposition', contentDisposition(item.name))
            response.setHeader('Cache-Control', 'private, max-age=60')
            await new Promise<void>((resolve, reject) => {
                const stream = createReadStream(item.path)
                stream.once('error', reject)
                response.once('close', resolve)
                response.once('finish', resolve)
                stream.pipe(response)
            })
            return true
        } catch (error) {
            if (response.headersSent && !response.writableEnded) {
                response.destroy(error instanceof Error ? error : undefined)
            }
            return false
        }
    }

    cleanup(now = Date.now()) {
        for (const [id, item] of this.items) {
            if (item.expiresAt <= now) this.items.delete(id)
        }
    }
}

function resolvePath(value: string, cwd: string) {
    if (value === '~') return os.homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2))
    }
    return path.isAbsolute(value) ? value : path.resolve(cwd, value)
}

function isWithin(candidate: string, root: string) {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function contentDisposition(name: string) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
