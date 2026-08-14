import path from 'path'

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/
const SAFE_GIT_REF = /^(?!-)(?!.*(?:^|\/)\.\.?($|\/))[a-zA-Z0-9._/-]+$/

export function validatePathSegment(value: string, label: string): string {
    if (!value || !SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
        throw new Error(`Invalid ${label}`)
    }
    return value
}

export function validateSkillSubdir(value?: string): string {
    const normalized = value?.replace(/^\/+|\/+$/g, '') || ''
    if (!normalized) return ''
    const parts = normalized.split('/')
    if (parts.some((part) => part === '.' || part === '..' || !SAFE_SEGMENT.test(part))) {
        throw new Error('Invalid skill subdir')
    }
    return parts.join('/')
}

export function validateGitRef(value: string): string {
    if (!value || !SAFE_GIT_REF.test(value)) throw new Error('Invalid git branch')
    return value
}

export function validateRepoUrl(value: string): string {
    const candidate = value?.trim()
    if (
        !candidate ||
        candidate.startsWith('-') ||
        /[\0\r\n\s]/.test(candidate)
    ) {
        throw new Error('Invalid skill repository URL')
    }
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(candidate)) {
        return candidate
    }
    let url: URL
    try {
        url = new URL(candidate)
    } catch {
        throw new Error('Skill repository must use https://, ssh://, or git@host:path')
    }
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname) {
        throw new Error('Skill repository must use https:// or ssh://')
    }
    return candidate
}

export function isRemotePathWithinRoot(remotePath: string, root: string): boolean {
    if (!remotePath.startsWith('/') || !root.startsWith('/')) return false
    const target = path.posix.normalize(remotePath)
    const base = path.posix.normalize(root).replace(/\/$/, '') || '/'
    if (base === '/') return target.startsWith('/')
    return target === base || target.startsWith(`${base}/`)
}
