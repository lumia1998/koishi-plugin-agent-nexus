import path from 'path'
import { quoteShell } from './shell'

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
    if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) {
        throw new Error('Invalid skill repository URL')
    }
    return value
}

export function buildRemoteRealpathCommand(remotePath: string): string {
    return `readlink -f -- ${quoteShell(remotePath)}`
}

export function isRemotePathWithinRoot(remotePath: string, root: string): boolean {
    if (!remotePath.startsWith('/') || !root.startsWith('/')) return false
    const target = path.posix.normalize(remotePath)
    const base = path.posix.normalize(root).replace(/\/$/, '') || '/'
    return target === base || target.startsWith(`${base}/`)
}
