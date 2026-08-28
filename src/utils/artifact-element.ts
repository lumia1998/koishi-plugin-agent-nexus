import { h } from 'koishi'

/**
 * Internal marker used to keep an AgentNexus output attachment from being
 * collected again as a user input attachment when a platform echoes it back.
 */
export const NEXUS_ARTIFACT_ELEMENT_ATTR = 'data-agent-nexus-artifact'

export interface NexusArtifactElementInput {
    url?: string
    bytes?: Uint8Array | ArrayBuffer | ArrayBufferView
    name?: string
    filename?: string
    mediaType?: string
}

/**
 * Build the native Koishi element for a Gateway artifact.
 *
 * Gateway normally supplies `url` for artifacts, including large binary
 * artifacts. `bytes` is also supported for small/direct callers so audio and
 * video buffers keep their native Koishi element type instead of becoming a
 * generic file.
 */
export function createNexusArtifactElement(
    artifact: NexusArtifactElementInput
) {
    const source = normalizeBinarySource(artifact.bytes ?? artifact.url)
    if (source === undefined || source === null) return undefined

    const filename = artifact.filename || artifact.name || undefined
    const mediaType =
        normalizeMediaType(artifact.mediaType) || mediaTypeFromFilename(filename)
    const attrs = filename ? { filename } : undefined
    const binary = typeof source !== 'string'
    let element: any

    if (mediaType?.startsWith('image/')) {
        element = createAssetElement(h.image, source, mediaType, attrs, binary)
    } else if (mediaType?.startsWith('audio/')) {
        element = createAssetElement(h.audio, source, mediaType, attrs, binary)
    } else if (mediaType?.startsWith('video/')) {
        element = createAssetElement(h.video, source, mediaType, attrs, binary)
    } else if (binary) {
        element = createAssetElement(
            h.file,
            source,
            mediaType || 'application/octet-stream',
            attrs,
            true
        )
    } else {
        element = h.file(source, {
            ...(filename ? { filename } : {}),
            ...(mediaType ? { mime: mediaType } : {})
        })
    }

    element.attrs[NEXUS_ARTIFACT_ELEMENT_ATTR] = true
    return element
}

export function isNexusArtifactElement(value: any) {
    const attrs = value?.attrs
    return Boolean(
        attrs?.[NEXUS_ARTIFACT_ELEMENT_ATTR] ||
            attrs?.['dataAgentNexusArtifact'] ||
            attrs?.['agentNexusArtifact']
    )
}

function createAssetElement(
    factory: (...args: any[]) => any,
    source: NexusArtifactElementInput['bytes'] | string,
    mediaType: string,
    attrs: { filename: string } | undefined,
    binary: boolean
) {
    const args: any[] = [source]
    if (binary) args.push(mediaType)
    else if (mediaType) args.push(mediaType)
    if (attrs) args.push(attrs)
    return factory(...args)
}

function normalizeBinarySource(
    source: NexusArtifactElementInput['bytes'] | string | undefined
) {
    if (!source || typeof source === 'string' || Buffer.isBuffer(source)) {
        return source
    }
    if (ArrayBuffer.isView(source)) {
        return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
    }
    return source
}

function normalizeMediaType(value?: string) {
    const result = String(value || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase()
    return result || undefined
}

function mediaTypeFromFilename(filename?: string) {
    const extension = String(filename || '')
        .split(/[?#]/, 1)[0]
        .slice(String(filename || '').lastIndexOf('.') + 1)
        .toLowerCase()
    const types: Record<string, string> = {
        avif: 'image/avif',
        gif: 'image/gif',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        ogg: 'audio/ogg',
        png: 'image/png',
        svg: 'image/svg+xml',
        wav: 'audio/wav',
        webm: 'video/webm',
        webp: 'image/webp'
    }
    return types[extension]
}
