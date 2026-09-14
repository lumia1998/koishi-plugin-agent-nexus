import { createReadStream } from 'fs'

/**
 * Builds a `Content-Disposition` value that is safe for arbitrary artifact
 * names: the ASCII fallback strips control characters, quotes and backslashes
 * so the header cannot be broken out of, and the UTF-8 form is percent-encoded.
 */
export function contentDisposition(name: string, inline: boolean) {
    const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Streams a cached artifact from disk. A single byte range is honoured so the
 * browser can seek in audio/video previews instead of pulling the whole file.
 */
export function sendCachedFile(koa: any, filePath: string, size: number) {
    koa.set('Accept-Ranges', 'bytes')
    const range = parseRangeHeader(String(koa.get('range') || ''), size)
    if (range === 'invalid') {
        koa.status = 416
        koa.set('Content-Range', `bytes */${size}`)
        koa.body = ''
        return
    }
    if (range) {
        koa.status = 206
        koa.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        koa.set('Content-Length', String(range.end - range.start + 1))
        koa.body = safeStream(filePath, range)
        return
    }
    koa.status = 200
    koa.set('Content-Length', String(size))
    koa.body = safeStream(filePath)
}

function safeStream(filePath: string, range?: { start: number; end: number }) {
    const stream = createReadStream(filePath, range)
    // The file can disappear between the cache lookup and the read (prune or
    // job cleanup). Swallow it so a vanished file cannot crash the process.
    stream.on('error', () => stream.destroy())
    return stream
}

/**
 * Parses a single-range `bytes=` header. Returns undefined when the client
 * asked for the whole file, `invalid` when the range cannot be satisfied.
 */
export function parseRangeHeader(
    value: string,
    size: number
): { start: number; end: number } | 'invalid' | undefined {
    const header = value.trim()
    if (!header) return undefined
    // RFC 5234 makes ABNF literals case-insensitive, so accept BYTES= too.
    const match = /^bytes=(\d*)-(\d*)$/i.exec(header)
    if (!match) return 'invalid'
    // "bytes=-" carries no bounds at all; ignore it and send the whole file.
    if (!match[1] && !match[2]) return undefined
    if (!size) return 'invalid'
    let start: number
    let end: number
    if (!match[1]) {
        const suffix = Number(match[2])
        if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
        start = Math.max(0, size - suffix)
        end = size - 1
    } else {
        start = Number(match[1])
        end = match[2] ? Number(match[2]) : size - 1
        if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
        if (end > size - 1) end = size - 1
    }
    if (start > end || start >= size) return 'invalid'
    return { start, end }
}
