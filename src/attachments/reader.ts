import { lookup as dnsLookup } from 'dns/promises'
import { constants } from 'fs'
import { open, realpath, stat } from 'fs/promises'
import { request as httpRequest, type IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'
import { BlockList, isIP } from 'net'
import path from 'path'
import type { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import { brotliDecompress, gunzip, inflate } from 'zlib'
import type { InputAttachmentConfig } from '../config'

const unzipGzip = promisify(gunzip)
const unzipDeflate = promisify(inflate)
const unzipBrotli = promisify(brotliDecompress)
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const blockedIPv4 = new BlockList()
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
    ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedIPv4.addSubnet(address, prefix)
const publicIPv6 = new BlockList()
publicIPv6.addSubnet('2000::', 3, 'ipv6')
const blockedIPv6 = new BlockList()
for (const [address, prefix] of [
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
] as const) blockedIPv6.addSubnet(address, prefix, 'ipv6')

/** Policy is supplied by the administrator, never by message elements or tools. */
export class InputAttachmentReader {
    private roots: string[] = []
    private readonly configuredRoots: string[]
    private readonly privateOrigins: Set<string>

    constructor(baseDir: string, policy: Partial<InputAttachmentConfig> = {}) {
        this.configuredRoots = (policy.localRoots || []).map((root) => {
            if (!root.trim()) throw new Error('inputAttachments.localRoots 不允许空目录。')
            return path.resolve(baseDir, root.trim())
        })
        this.privateOrigins = new Set((policy.privateOrigins || []).map((origin) => {
            const url = httpUrl(origin)
            if (url.origin !== origin) {
                throw new Error('inputAttachments.privateOrigins 必须是准确的 HTTP(S) origin，不能包含路径。')
            }
            return url.origin
        }))
    }

    async init() {
        // Pin trusted canonical roots at startup; later symlink replacements cannot
        // redefine the allowlist. Only administrator-controlled directories belong here.
        this.roots = await Promise.all(this.configuredRoots.map(async (root) => {
            const canonical = await realpath(root)
            if (!(await stat(canonical)).isDirectory()) {
                throw new Error('inputAttachments.localRoots 必须指向现有目录。')
            }
            return canonical
        }))
    }

    async read(source: string, maxBytes: number): Promise<{ bytes: Uint8Array, mediaType?: string }> {
        let url: URL
        try { url = new URL(source) } catch {
            throw new Error('用户附件地址无效。')
        }
        if (url.protocol === 'file:') {
            return { bytes: await this.readLocal(url, maxBytes) }
        }
        return this.readRemote(httpUrl(source), maxBytes)
    }

    private async readLocal(url: URL, maxBytes: number) {
        if (!this.roots.length) {
            throw new Error('本地附件读取未启用；请配置 inputAttachments.localRoots 中的专用附件目录。')
        }
        if (url.hostname || url.search || url.hash) {
            throw new Error('本地附件必须是无主机名、查询参数和片段的 file URL。')
        }
        const filename = fileURLToPath(url)
        if (filename.startsWith('\\\\') || filename.startsWith('//')) {
            throw new Error('不允许读取 UNC 附件地址。')
        }
        const canonical = await realpath(filename)
        this.assertLocalPath(canonical)
        const expected = await stat(canonical)
        if (!expected.isFile()) throw new Error('本地附件必须是普通文件。')
        assertSize(expected.size, maxBytes)
        const handle = await open(canonical,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
        try {
            const opened = await handle.stat()
            this.assertLocalPath(await realpath(canonical))
            if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
                throw new Error('本地附件在读取前发生变化。')
            }
            assertSize(opened.size, maxBytes)
            return await readLimitedStream(handle.createReadStream({ autoClose: false }), maxBytes)
        } finally {
            await handle.close()
        }
    }

    private assertLocalPath(filename: string) {
        // Canonical path comparison stays case-sensitive, including on Windows.
        if (!this.roots.some((root) => filename.startsWith(
            root.endsWith(path.sep) ? root : `${root}${path.sep}`))) {
            throw new Error('本地附件不在 inputAttachments.localRoots 允许的目录内。')
        }
    }

    private async readRemote(initial: URL, maxBytes: number) {
        const signal = AbortSignal.timeout(30_000)
        let url = initial
        for (let redirects = 0; redirects <= 5; redirects += 1) {
            signal.throwIfAborted()
            const hostname = url.hostname.replace(/^\[|\]$/g, '')
            const family = isIP(hostname)
            const addresses = family
                ? [{ address: hostname, family }]
                : await resolveAddresses(hostname, signal)
            if (!addresses.length) throw new Error('用户附件域名没有可用的 IP 地址。')
            if (!this.privateOrigins.has(url.origin)) {
                for (const item of addresses) assertPublicAddress(item.address)
            }
            signal.throwIfAborted()
            const response = await new Promise<IncomingMessage>((resolve, reject) => {
                const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
                    agent: false,
                    signal,
                    headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'node' },
                    // Connect only to the checked answers, preserving Host and TLS SNI.
                    // No second DNS lookup and no pooled socket can bypass validation.
                    lookup: (_host, options, callback) => {
                        if (options.all) callback(null, addresses)
                        else callback(null, addresses[0].address, addresses[0].family)
                    }
                }, resolve)
                request.on('error', reject)
                request.on('upgrade', (_response, socket) => {
                    socket.destroy()
                    reject(new Error('用户附件不允许升级 HTTP 协议。'))
                })
                request.end()
            })
            try {
                if (redirectStatuses.has(response.statusCode || 0)) {
                    if (redirects === 5 || !response.headers.location) {
                        throw new Error('用户附件重定向次数过多或缺少目标地址。')
                    }
                    // Every redirect, including allowlisted origins, re-enters the
                    // full protocol, credentials, DNS and destination validation.
                    url = httpUrl(new URL(response.headers.location, url).href)
                    continue
                }
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    throw new Error(`无法读取用户附件（HTTP ${response.statusCode || 0}）。`)
                }
                const declared = Number(response.headers['content-length'])
                if (Number.isFinite(declared)) assertSize(declared, maxBytes)
                let bytes = await readLimitedStream(response, maxBytes)
                const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase()
                const decompress = encoding === 'gzip' ? unzipGzip
                    : encoding === 'deflate' ? unzipDeflate
                    : encoding === 'br' ? unzipBrotli : undefined
                if (decompress) bytes = await decompress(bytes, { maxOutputLength: maxBytes })
                else if (encoding !== 'identity') throw new Error('用户附件使用了不支持的 HTTP 内容编码。')
                signal.throwIfAborted()
                assertSize(bytes.length, maxBytes)
                return { bytes, mediaType: response.headers['content-type'] }
            } finally {
                response.destroy()
            }
        }
        throw new Error('用户附件重定向次数过多。')
    }
}

function httpUrl(source: string) {
    let url: URL
    try { url = new URL(source) } catch { throw new Error('用户附件 HTTP 地址无效。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error('用户附件只允许无凭据和片段的 HTTP(S) 地址。')
    }
    return url
}

function assertPublicAddress(address: string) {
    const family = isIP(address)
    const allowed = family === 4 ? !blockedIPv4.check(address)
        : family === 6 && publicIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6')
    if (!allowed) {
        throw new Error('用户附件地址指向内网或保留 IP；可信附件服务需配置 inputAttachments.privateOrigins。')
    }
}

async function resolveAddresses(hostname: string, signal: AbortSignal) {
    return new Promise<Awaited<ReturnType<typeof lookupAll>>>((resolve, reject) => {
        const abort = () => reject(new Error('用户附件 DNS 解析超时。'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else lookupAll(hostname).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}

function lookupAll(hostname: string) {
    return dnsLookup(hostname, { all: true, verbatim: true })
}

async function readLimitedStream(stream: Readable, maxBytes: number) {
    const chunks: Buffer[] = []
    let total = 0
    for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        assertSize(total, maxBytes)
        chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
}

function assertSize(size: number, maxBytes: number) {
    if (size > maxBytes) throw new Error('单个用户附件超过 16 MB。')
}
