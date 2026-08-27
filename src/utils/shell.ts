export function resolveSecret(value: string): string {
    if (!value?.startsWith('env:')) return value ?? ''
    const name = value.slice(4)
    if (!name) throw new Error('Secret environment variable name is empty')
    const secret = process.env[name]
    if (secret === undefined) throw new Error(`Environment variable ${name} is not set`)
    return secret
}

export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
