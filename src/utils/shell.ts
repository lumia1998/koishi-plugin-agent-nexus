export function quoteShell(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
}

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

export function truncateText(text: string, limit = 12000): string {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
}

export function expandHome(path: string, home = '~'): string {
    if (!path) return path
    if (path === '~') return home
    if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
    return path
}

export function base64Prompt(prompt: string): string {
    return Buffer.from(prompt, 'utf8').toString('base64')
}

/** Avoid shell injection by decoding base64 prompt inside the remote shell. */
export function wrapPromptCommand(
    build: (promptExpr: string) => string,
    prompt: string
): string {
    const b64 = base64Prompt(prompt)
    return `PROMPT=$(printf %s ${quoteShell(b64)} | base64 -d) && ${build('"$PROMPT"')}`
}
