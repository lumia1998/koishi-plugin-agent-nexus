import type { AgentKind } from '../types'
import { quoteShell } from '../utils/shell'

export interface AgentMaintenancePlan {
    action: 'install'
    method: string
    command: string
}

const npmPackages: Partial<Record<AgentKind, string>> = {
    openclaw: 'openclaw',
    claude: '@anthropic-ai/claude-code',
    opencode: 'opencode-ai',
    codex: '@openai/codex',
    pi: '@mariozechner/pi-coding-agent'
}

export function buildAgentMaintenancePlan(
    kind: AgentKind,
    installed: boolean,
    _executablePath?: string
): AgentMaintenancePlan {
    if (installed) {
        throw new Error('该 Agent 已安装，AgentNexus 只提供安装，不提供更新。')
    }
    if (kind === 'hermes') {
        return {
            action: 'install',
            method: 'NousResearch 官方安装器',
            command: officialInstaller(
                'https://hermes-agent.nousresearch.com/install.sh'
            )
        }
    }
    return npmInstallPlan(kind)
}

function npmInstallPlan(kind: AgentKind): AgentMaintenancePlan {
    const packageName = npmPackages[kind]
    if (!packageName) throw new Error(`Unsupported agent maintenance: ${kind}`)
    return {
        action: 'install',
        method: `npm 用户级安装（${packageName}）`,
        command: [
            'set -e',
            'command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 127; }',
            'mkdir -p "$HOME/.local"',
            `npm_config_prefix="$HOME/.local" npm install -g ${quoteShell(packageName)}`
        ].join('; ')
    }
}

function officialInstaller(url: string) {
    return [
        'set -e',
        'command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 127; }',
        'umask 077',
        'tmp=$(mktemp)',
        'trap \'rm -f "$tmp"\' EXIT',
        `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 120 ${quoteShell(url)} -o "$tmp"`,
        '[ -s "$tmp" ] || { echo "installer download is empty" >&2; exit 1; }',
        '[ "$(wc -c < "$tmp")" -le 2097152 ] || { echo "installer download exceeds 2 MB" >&2; exit 1; }',
        'bash "$tmp"'
    ].join('; ')
}
