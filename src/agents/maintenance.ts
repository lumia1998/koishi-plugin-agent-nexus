import type { AgentKind } from '../types'
import { quoteShell } from '../utils/shell'

export interface AgentMaintenancePlan {
    action: 'install' | 'update'
    method: string
    command: string
}

const npmPackages: Partial<Record<AgentKind, string>> = {
    openclaw: 'openclaw',
    claude: '@anthropic-ai/claude-code',
    opencode: 'opencode-ai',
    codex: '@openai/codex'
}

const latestCache = new Map<
    AgentKind,
    { value?: string; error?: string; expiresAt: number }
>()

interface LatestVersionResult {
    value?: string
    error?: string
    expiresAt: number
}

export async function latestAgentVersion(
    kind: AgentKind
): Promise<LatestVersionResult> {
    const cached = latestCache.get(kind)
    if (cached && cached.expiresAt > Date.now()) return cached
    try {
        const value =
            kind === 'hermes'
                ? await fetchJsonVersion(
                      'https://pypi.org/pypi/hermes-agent/json',
                      (data) => data?.info?.version
                  )
                : await fetchJsonVersion(
                      `https://registry.npmjs.org/${encodeURIComponent(
                          npmPackages[kind]!
                      )}/latest`,
                      (data) => data?.version
                  )
        const result: LatestVersionResult = {
            value,
            expiresAt: Date.now() + 10 * 60 * 1000
        }
        latestCache.set(kind, result)
        return result
    } catch (error) {
        const result: LatestVersionResult = {
            error: error instanceof Error ? error.message : String(error),
            expiresAt: Date.now() + 60 * 1000
        }
        latestCache.set(kind, result)
        return result
    }
}

export function buildAgentMaintenancePlan(
    kind: AgentKind,
    installed: boolean,
    executablePath?: string
): AgentMaintenancePlan {
    const action = installed ? 'update' : 'install'
    if (kind === 'hermes') {
        return {
            action,
            method: 'NousResearch 官方安装器',
            command: officialInstaller(
                'https://hermes-agent.nousresearch.com/install.sh'
            )
        }
    }
    if (kind === 'claude') {
        return installed && executablePath
            ? {
                  action,
                  method: 'Claude Code 内置更新器',
                  command: `${quoteShell(executablePath)} update`
              }
            : {
                  action,
                  method: 'Anthropic 官方安装器',
                  command: officialInstaller('https://claude.ai/install.sh')
              }
    }
    if (kind === 'opencode') {
        return installed && executablePath
            ? {
                  action,
                  method: 'OpenCode 内置更新器',
                  command: `${quoteShell(executablePath)} upgrade`
              }
            : {
                  action,
                  method: 'OpenCode 官方安装器',
                  command: officialInstaller('https://opencode.ai/install')
              }
    }
    const packageName = npmPackages[kind]
    if (!packageName) throw new Error(`Unsupported agent maintenance: ${kind}`)
    return {
        action,
        method: `npm 用户级安装（${packageName}）`,
        command: [
            'set -e',
            'command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 127; }',
            'mkdir -p "$HOME/.local"',
            `npm_config_prefix="$HOME/.local" npm install -g ${quoteShell(
                `${packageName}@latest`
            )}`
        ].join('; ')
    }
}

export function normalizeAgentVersion(value?: string) {
    const match = value?.match(/(?:^|\s|v)(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?)/)
    return match?.[1]
}

export function isVersionNewer(current?: string, latest?: string) {
    const left = normalizeAgentVersion(current)
    const right = normalizeAgentVersion(latest)
    if (!left || !right) return undefined
    return compareVersions(right, left) > 0
}

function compareVersions(left: string, right: string) {
    const [leftMain, leftPre = ''] = left.split('-', 2)
    const [rightMain, rightPre = ''] = right.split('-', 2)
    const a = leftMain.split('.').map(Number)
    const b = rightMain.split('.').map(Number)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const delta = (a[index] ?? 0) - (b[index] ?? 0)
        if (delta) return delta
    }
    if (leftPre === rightPre) return 0
    if (!leftPre) return 1
    if (!rightPre) return -1
    return leftPre.localeCompare(rightPre, undefined, { numeric: true })
}

async function fetchJsonVersion(
    url: string,
    select: (data: any) => unknown
) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': 'koishi-plugin-agent-nexus' }
        })
        if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
        const value = select(await response.json())
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error('registry response has no version')
        }
        return value.trim()
    } finally {
        clearTimeout(timer)
    }
}

function officialInstaller(url: string) {
    return [
        'set -e',
        'command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 127; }',
        'tmp=$(mktemp)',
        'trap \'rm -f "$tmp"\' EXIT',
        `curl -fsSL ${quoteShell(url)} -o "$tmp"`,
        'bash "$tmp"'
    ].join('; ')
}
