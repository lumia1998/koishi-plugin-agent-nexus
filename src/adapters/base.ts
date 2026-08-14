import type { AgentKind } from '../types'
import type { SshSession } from '../ssh/session'

export abstract class CodeAgentAdapter {
    abstract readonly kind: AgentKind
    abstract readonly binNames: string[]

    abstract skillDirs(home: string): string[]

    async detect(session: SshSession) {
        for (const bin of this.binNames) {
            if (!/^[A-Za-z0-9._+-]+$/.test(bin)) continue
            const which = await session.exec(buildDetectCommand(bin), {
                timeoutMs: 12000
            })
            const path = pickExecutablePath(which.stdout)
            if (!path) continue
            const executablePath = path.startsWith('~/')
                ? session.resolveRemotePath(path)
                : path

            return {
                kind: this.kind,
                installed: true,
                scanned: true,
                path: executablePath,
                skillDirs: this.skillDirs('~')
            }
        }

        return {
            kind: this.kind,
            installed: false,
            scanned: true,
            skillDirs: this.skillDirs('~')
        }
    }
}

/** Prefer login PATH + common user install locations for CLI tools. */
function buildDetectCommand(bin: string) {
    const q = shellQuote(bin)
    return [
        `bin=${q};`,
        `found="";`,
        `found=$(command -v "$bin" 2>/dev/null || true);`,
        `if [ -z "$found" ]; then`,
        `  found=$(bash -lc 'command -v '"$bin"' 2>/dev/null' 2>/dev/null || true);`,
        `fi;`,
        `if [ -z "$found" ]; then`,
        `  for d in`,
        `    "$HOME/.local/bin"`,
        `    "$HOME/.hermes/bin"`,
        `    "$HOME/.openclaw/bin"`,
        `    "$HOME/.cargo/bin"`,
        `    "$HOME/.npm-global/bin"`,
        `    "$HOME/go/bin"`,
        `    "$HOME/.opencode/bin"`,
        `    "$HOME/.claude/bin"`,
        `    "$HOME/.codex/bin"`,
        `    "$HOME/bin"`,
        `    /usr/local/bin`,
        `    /opt/homebrew/bin`,
        `    /home/linuxbrew/.linuxbrew/bin;`,
        `  do`,
        `    if [ -x "$d/$bin" ]; then found="$d/$bin"; break; fi;`,
        `  done;`,
        `fi;`,
        `if [ -z "$found" ]; then`,
        `  for d in "$HOME/.local/pipx/venvs"/*"/bin" "$HOME/.pyenv/shims"; do`,
        `    if [ -x "$d/$bin" ]; then found="$d/$bin"; break; fi;`,
        `  done;`,
        `fi;`,
        `printf '%s\\n' "$found"`
    ].join(' ')
}

function pickExecutablePath(stdout: string) {
    for (const line of stdout.split(/\r?\n/)) {
        const value = line.trim()
        if (!value) continue
        if (value.startsWith('/') || value.startsWith('~/')) return value
    }
    return ''
}

function shellQuote(value: string) {
    return `'${value.replaceAll("'", `'\\''`)}'`
}
