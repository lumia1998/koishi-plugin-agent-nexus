import type {
    BridgeHostStatus,
    BridgeMaintenanceAction,
    NexusConfig,
    SshBridgeConfig,
    SshHostConfig
} from '../types'
import { quoteShell } from '../utils/shell'

export const BRIDGE_SERVICE_NAME = 'agent-nexus-bridge.service'

export interface BridgeMaintenancePlan {
    action: BridgeMaintenanceAction
    method: string
    command: string
    prepareCommand?: string
    files?: BridgeDeploymentFile[]
    localPackagePath?: string
}

export interface BridgeDeploymentFile {
    path: string
    content: string | Buffer
    mode: number
}

export function buildBridgeMaintenancePlan(
    action: BridgeMaintenanceAction,
    host: SshHostConfig,
    config: NexusConfig
): BridgeMaintenancePlan {
    if (action === 'install' || action === 'update') {
        const deployment = buildDeploymentFiles(host, config)
        return {
            action,
            method: 'npm 用户级安装 + systemd user service',
            command: deployment.command,
            prepareCommand: deployment.prepareCommand,
            files: deployment.files,
            localPackagePath: deployment.localPackagePath
        }
    }
    const verb = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart'
    return {
        action,
        method: 'systemd user service',
        command: [
            'set -e',
            requireSystemd(),
            `systemctl --user ${verb} ${quoteShell(BRIDGE_SERVICE_NAME)}`
        ].join('; ')
    }
}

export function buildBridgeStatusCommand(bridge: SshBridgeConfig) {
    const healthUrl = localHealthUrl(bridge)
    return [
        `printf '%s\\n' '__AGENT_NEXUS_SYSTEMD__'`,
        `if command -v systemctl >/dev/null 2>&1; then systemctl --user show ${quoteShell(
            BRIDGE_SERVICE_NAME
        )} --no-pager --property=LoadState,ActiveState,SubState,MainPID 2>/dev/null || true; else printf '%s\\n' 'LoadState=not-found'; fi`,
        `printf '%s\\n' '__AGENT_NEXUS_HEALTH__'`,
        `if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 ${quoteShell(
            healthUrl
        )} 2>/dev/null || true; elif command -v wget >/dev/null 2>&1; then wget -qO- --timeout=5 ${quoteShell(
            healthUrl
        )} 2>/dev/null || true; fi`
    ].join('; ')
}

export function parseBridgeStatus(
    output: string,
    host: SshHostConfig,
    stderr = ''
): BridgeHostStatus {
    const bridge = host.bridge
    const publicBaseUrl = bridgePublicBaseUrl(host)
    if (!bridge.enabled) {
        return {
            enabled: false,
            state: 'disabled',
            endpointUrl: `${publicBaseUrl}/a2a`,
            cardUrl: `${publicBaseUrl}/.well-known/agent-card.json`,
            agents: []
        }
    }
    const [systemdPart = '', healthPart = ''] = output.split(
        '__AGENT_NEXUS_HEALTH__',
        2
    )
    const properties = Object.fromEntries(
        systemdPart
            .replace('__AGENT_NEXUS_SYSTEMD__', '')
            .split(/\r?\n/)
            .flatMap((line) => {
                const index = line.indexOf('=')
                return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []
            })
    )
    let health: any
    const jsonLine = healthPart
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('{'))
    if (jsonLine) {
        try {
            health = JSON.parse(jsonLine)
        } catch {}
    }
    const loadState = properties.LoadState
    const activeState = properties.ActiveState
    const subState = properties.SubState
    const state =
        loadState === 'not-found'
            ? 'not-installed'
            : activeState === 'active' && health?.ok
              ? 'running'
              : activeState === 'activating'
                ? 'starting'
                : activeState === 'inactive' || activeState === 'deactivating'
                  ? 'stopped'
                  : activeState === 'failed' || (activeState === 'active' && !health?.ok)
                    ? 'error'
                    : 'unknown'
    const pid = Number(properties.MainPID)
    const error =
        state === 'error'
            ? activeState === 'active'
                ? 'Bridge service is active but its health endpoint is unavailable.'
                : stderr.trim() ||
                  `systemd state: ${activeState || 'unknown'}/${subState || 'unknown'}`
            : undefined
    return {
        enabled: true,
        state,
        endpointUrl: health?.endpointUrl || `${publicBaseUrl}/a2a`,
        cardUrl: `${publicBaseUrl}/.well-known/agent-card.json`,
        version: typeof health?.version === 'string' ? health.version : undefined,
        activeTasks: Number.isFinite(Number(health?.activeTasks))
            ? Number(health.activeTasks)
            : undefined,
        agents: Array.isArray(health?.agents)
            ? health.agents.filter(
                  (item: any) => item && typeof item.kind === 'string'
              )
            : [],
        pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
        lastCheckedAt: Date.now(),
        error
    }
}

export function bridgePublicBaseUrl(host: SshHostConfig) {
    const configured = host.bridge.publicBaseUrl?.trim()
    if (configured) return configured.replace(/\/$/, '')
    const hostname = host.host.includes(':') ? `[${host.host}]` : host.host
    return `http://${hostname}:${host.bridge.port}`
}

function buildDeploymentFiles(host: SshHostConfig, config: NexusConfig) {
    const bridge = host.bridge
    const remoteConfig = {
        host: bridge.bindHost,
        port: bridge.port,
        publicBaseUrl: bridgePublicBaseUrl(host),
        token: bridge.token || '',
        dataDir: bridge.dataDir,
        cwd: bridge.cwd || host.cwd || '~',
        agents: bridge.agents,
        runtime: config.runtime,
        defaultTimeoutMs: config.runtime.defaultTimeoutMs
    }
    const configPath = '~/.agent-nexus/bridge/config.json'
    const unitPath = `~/.config/systemd/user/${BRIDGE_SERVICE_NAME}`
    const localPackagePath = '~/.agent-nexus/bridge/agent-nexus-bridge.tgz'
    const installTarget =
        bridge.packageSpec === 'local'
            ? '"$HOME/.agent-nexus/bridge/agent-nexus-bridge.tgz"'
            : quoteShell(bridge.packageSpec)
    return {
        prepareCommand: [
            'set -e',
            'command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required" >&2; exit 127; }',
            'node_major=$(node -p \'Number(process.versions.node.split(".")[0])\')',
            '[ "$node_major" -ge 20 ] || { echo "Node.js 20+ is required" >&2; exit 1; }',
            'command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 127; }',
            requireSystemd(),
            'mkdir -p "$HOME/.local" "$HOME/.agent-nexus/bin" "$HOME/.agent-nexus/bridge" "$HOME/.config/systemd/user"',
            'ln -sfn "$(node -p \'process.execPath\')" "$HOME/.agent-nexus/bin/node"'
        ].join('; '),
        files: [
            {
                path: `${configPath}.tmp`,
                content: `${JSON.stringify(remoteConfig, null, 2)}\n`,
                mode: 0o600
            },
            {
                path: `${unitPath}.tmp`,
                content: systemdUnit(),
                mode: 0o644
            }
        ],
        command: [
            'set -e',
            `npm_config_prefix="$HOME/.local" npm install -g --omit=peer ${installTarget}`,
            'test -x "$HOME/.local/bin/agent-nexus-bridge"',
            'chmod 600 "$HOME/.agent-nexus/bridge/config.json.tmp"',
            'mv "$HOME/.agent-nexus/bridge/config.json.tmp" "$HOME/.agent-nexus/bridge/config.json"',
            `mv "$HOME/.config/systemd/user/${BRIDGE_SERVICE_NAME}.tmp" "$HOME/.config/systemd/user/${BRIDGE_SERVICE_NAME}"`,
            'systemctl --user daemon-reload',
            `systemctl --user enable ${quoteShell(BRIDGE_SERVICE_NAME)}`,
            `systemctl --user restart ${quoteShell(BRIDGE_SERVICE_NAME)}`,
            ...(bridge.packageSpec === 'local'
                ? ['rm -f "$HOME/.agent-nexus/bridge/agent-nexus-bridge.tgz"']
                : [])
        ].join('; '),
        localPackagePath: bridge.packageSpec === 'local' ? localPackagePath : undefined
    }
}

function systemdUnit() {
    return `[Unit]
Description=AgentNexus A2A Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=PATH=%h/.agent-nexus/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/agent-nexus-bridge --config %h/.agent-nexus/bridge/config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

function requireSystemd() {
    return 'command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 || { echo "systemd user service is unavailable; enable a user manager/linger for this SSH account" >&2; exit 1; }'
}

function localHealthUrl(bridge: SshBridgeConfig) {
    const host = ['0.0.0.0', '127.0.0.1'].includes(bridge.bindHost)
        ? '127.0.0.1'
        : ['::', '::0', '::1'].includes(bridge.bindHost)
          ? '[::1]'
          : bridge.bindHost.includes(':')
            ? `[${bridge.bindHost}]`
            : bridge.bindHost
    return `http://${host}:${bridge.port}/health`
}
