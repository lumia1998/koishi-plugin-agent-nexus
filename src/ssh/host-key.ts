import { timingSafeEqual } from 'crypto'
import type { SshHostKeyPolicy } from '../types'

export interface HostKeyVerificationResult {
    accepted: boolean
    fingerprint?: string
    learned?: boolean
    error?: string
}

export function normalizeHostKeyPolicy(value: unknown): SshHostKeyPolicy {
    return value === 'strict' || value === 'insecure' || value === 'accept-new'
        ? value
        : 'accept-new'
}

export function normalizeHostKeyFingerprint(value?: string): string | undefined {
    const fingerprint = value?.trim()
    if (!fingerprint) return undefined

    if (/^[0-9a-f]{64}$/i.test(fingerprint)) {
        return fingerprint.toLowerCase()
    }

    const match = fingerprint.match(/^sha256:([A-Za-z0-9+/]+={0,2})$/i)
    if (!match) {
        throw new Error('SSH host key fingerprint must be SHA256:<base64> or 64 hex characters')
    }
    const encoded = match[1].replace(/=+$/, '')
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const digest = Buffer.from(padded, 'base64')
    if (
        digest.length !== 32 ||
        digest.toString('base64').replace(/=+$/, '') !== encoded
    ) {
        throw new Error('SSH host key fingerprint is not a valid SHA-256 digest')
    }
    return digest.toString('hex')
}

export function formatHostKeyFingerprint(hashedKey: string): string {
    const digest = normalizeObservedHash(hashedKey)
    return `SHA256:${Buffer.from(digest, 'hex')
        .toString('base64')
        .replace(/=+$/, '')}`
}

export function verifySshHostKey(
    hashedKey: string,
    configuredFingerprint: string | undefined,
    policy: SshHostKeyPolicy
): HostKeyVerificationResult {
    let observed: string
    try {
        observed = normalizeObservedHash(hashedKey)
    } catch (error) {
        return {
            accepted: false,
            error: error instanceof Error ? error.message : String(error)
        }
    }

    const fingerprint = formatHostKeyFingerprint(observed)
    if (policy === 'insecure') return { accepted: true, fingerprint }

    let expected: string | undefined
    try {
        expected = normalizeHostKeyFingerprint(configuredFingerprint)
    } catch (error) {
        return {
            accepted: false,
            fingerprint,
            error: error instanceof Error ? error.message : String(error)
        }
    }

    if (!expected) {
        if (policy === 'strict') {
            return {
                accepted: false,
                fingerprint,
                error: `SSH host key is not pinned. Observed ${fingerprint}`
            }
        }
        return { accepted: true, fingerprint, learned: true }
    }

    const left = Buffer.from(observed, 'hex')
    const right = Buffer.from(expected, 'hex')
    if (left.length === right.length && timingSafeEqual(left, right)) {
        return { accepted: true, fingerprint }
    }
    return {
        accepted: false,
        fingerprint,
        error: `SSH host key mismatch. Expected ${formatHostKeyFingerprint(
            expected
        )}, observed ${fingerprint}`
    }
}

function normalizeObservedHash(value: string) {
    const hash = value.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error('SSH server returned an invalid SHA-256 host key hash')
    }
    return hash
}
