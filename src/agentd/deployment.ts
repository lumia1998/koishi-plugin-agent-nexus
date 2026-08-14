import { randomUUID } from 'crypto'
import path from 'path'
import type { SshSession } from '../ssh/session'
import type {
    AgentdAgentKind,
    AgentdDeploymentPhase,
    AgentdServiceMode,
    ExecResult
} from '../types'
import { quoteShell } from '../utils/shell'

export const agentdAgentKinds: readonly AgentdAgentKind[] = [
    'openclaw',
    'claude',
    'opencode',
    'codex',
    'pi'
]

const adapterPackages: Partial<Record<AgentdAgentKind, string>> = {
    claude: '@agentclientprotocol/claude-agent-acp',
    codex: '@agentclientprotocol/codex-acp',
    pi: 'pi-acp'
}

const adapterCommands: Partial<Record<AgentdAgentKind, string>> = {
    claude: 'claude-agent-acp',
    codex: 'codex-acp',
    pi: 'pi-acp'
}

const agentCommands: Record<AgentdAgentKind, string> = {
    openclaw: 'openclaw',
    claude: 'claude',
    opencode: 'opencode',
    codex: 'codex',
    pi: 'pi'
}

export interface RemoteAgentdDeploymentInput {
    port: number
    workspaceRoots: string[]
    agents: AgentdAgentKind[]
    token: string
}

export interface RemoteAgentdDeploymentResult {
    serviceMode: AgentdServiceMode
    workspaceRoots: string[]
    warning?: string
}

export type RemoteAgentdProgressReporter = (
    phase: AgentdDeploymentPhase,
    label: string,
    percent: number
) => void

type ServicePrivilege = 'system-root' | 'system-sudo' | 'user'

const fileOperationTimeoutMs = 20_000
const installTimeoutMs = 4 * 60 * 1000

export async function deployNexusAgentdRemote(
    session: SshSession,
    input: RemoteAgentdDeploymentInput,
    report: RemoteAgentdProgressReporter = () => undefined
): Promise<RemoteAgentdDeploymentResult> {
    const port = validateAgentdPort(input.port)
    const agents = normalizeAgentdAgents(input.agents)
    if (!agents.length) throw new Error('请至少选择一个已安装的 ACP Agent。')
    validateToken(input.token)

    report('checking', '检查 Linux、Node.js 和 systemd 环境', 5)
    const platform = (
        await runChecked(session, 'uname -s', '检查远端操作系统', 15_000)
    ).trim()
    if (platform !== 'Linux') {
        throw new Error(`nexus-agentd 一键部署仅支持 Linux/systemd，当前为 ${platform || 'unknown'}。`)
    }

    await runChecked(
        session,
        'command -v npm >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1',
        '检查 npm 和 systemd',
        15_000
    )
    const nodeVersion = (
        await runChecked(
            session,
            'command -v node >/dev/null 2>&1 && node -p "process.versions.node"',
            '检查 Node.js',
            15_000
        )
    ).trim()
    const nodeMajor = Number(nodeVersion.split('.')[0])
    if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
        throw new Error(`nexus-agentd 需要 Node.js 20 或更高版本，当前为 ${nodeVersion || 'unknown'}。`)
    }
    if (agents.includes('claude') && nodeMajor < 22) {
        throw new Error(
            `Claude Code ACP Adapter 需要 Node.js 22 或更高版本，当前为 ${nodeVersion}。可先取消选择 Claude Code。`
        )
    }

    report('workspace', '准备 Workspace 根目录', 15)
    const workspaceRoots = await resolveWorkspaceRoots(session, input.workspaceRoots)
    const privilege = await detectServicePrivilege(session)
    report('installing', '安装缺失的 Gateway 与 ACP Adapter', 30)
    await installAgentdPackages(session, agents, report)
    const agentdPath = (
        await runChecked(
            session,
            'command -v nexus-agentd',
            '定位 nexus-agentd',
            15_000
        )
    ).trim()
    if (!agentdPath.startsWith('/') || /[\r\n]/.test(agentdPath)) {
        throw new Error(`nexus-agentd 可执行文件路径无效：${agentdPath || 'not found'}`)
    }

    const remotePath = (
        await runChecked(session, 'printf %s "$PATH"', '读取远端 PATH', 15_000)
    ).trim()
    const home = session.environmentInfo.home
    if (!home.startsWith('/')) throw new Error(`远端 HOME 路径无效：${home || 'unknown'}`)
    assertSingleLine(home, 'remote HOME')
    const configDir = path.posix.join(home, '.config', 'agent-nexus')
    const cacheDir = path.posix.join(home, '.cache', 'agent-nexus')
    const configPath = path.posix.join(configDir, 'nexus-agentd.json')
    const environmentPath = path.posix.join(configDir, 'nexus-agentd.env')
    const launcherPath = path.posix.join(configDir, 'nexus-agentd-launcher.sh')
    const userUnitDir = path.posix.join(home, '.config', 'systemd', 'user')
    const userUnitPath = path.posix.join(userUnitDir, 'nexus-agentd.service')
    const stagedUnitPath = path.posix.join(
        cacheDir,
        `nexus-agentd-${randomUUID()}.service`
    )

    report('configuring', '写入 Gateway 配置与 systemd 服务', 65)
    await runChecked(
        session,
        `mkdir -p ${quoteShell(configDir)} ${quoteShell(cacheDir)}${privilege === 'user' ? ` ${quoteShell(userUnitDir)}` : ''}`,
        '创建 nexus-agentd 配置目录',
        15_000
    )

    const username = (
        await runChecked(session, 'id -un', '读取远端用户', 15_000)
    ).trim()
    validateSystemdUser(username)
    const unit = buildAgentdSystemdUnit({
        mode: privilege === 'user' ? 'user' : 'system',
        username,
        home,
        environmentPath,
        launcherPath
    })
    const config = buildAgentdConfig(port, workspaceRoots, agents)
    const environment = buildAgentdEnvironment(
        input.token,
        home,
        remotePath,
        session.serviceEnvironment
    )
    const launcher = buildAgentdLauncher(agentdPath, configPath)

    await writeRemoteAtomic(session, configPath, config, 0o600)
    await writeRemoteAtomic(session, environmentPath, environment, 0o600)
    await writeRemoteAtomic(session, launcherPath, launcher, 0o700)
    if (privilege === 'user') {
        await writeRemoteAtomic(session, userUnitPath, unit, 0o644)
    } else {
        await writeRemoteAtomic(session, stagedUnitPath, unit, 0o600)
    }

    try {
        report('starting', '启动 nexus-agentd systemd 服务', 82)
        await startAgentdService(session, privilege, stagedUnitPath)
        report('verifying', '检查 Gateway 健康状态', 92)
        await runChecked(
            session,
            buildHealthCheckCommand(port),
            '验证 nexus-agentd 健康状态',
            20_000
        )
    } catch (error) {
        const diagnostics = await readAgentdDiagnostics(session, privilege)
        throw appendAgentdDiagnostics(error, diagnostics)
    } finally {
        if (privilege !== 'user') {
            await withTimeout(
                session.unlink(stagedUnitPath),
                '清理临时 systemd 文件',
                fileOperationTimeoutMs
            ).catch(() => undefined)
        }
    }

    let warning: string | undefined
    if (privilege === 'user') {
        await session.exec(
            'command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true',
            { timeoutMs: 15_000 }
        )
        const linger = await session.exec(
            'command -v loginctl >/dev/null 2>&1 && loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true',
            { timeoutMs: 10_000 }
        )
        if (linger.stdout.trim() !== 'yes') {
            warning =
                '已使用用户级 systemd 启动，但该账号未启用 linger；用户会话结束后服务可能停止。建议使用 root 或免密 sudo 的 SSH 账号重新部署。'
        }
    }

    return {
        serviceMode: privilege === 'user' ? 'user' : 'system',
        workspaceRoots,
        warning
    }
}

export function validateAgentdPort(value: number) {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('nexus-agentd 端口必须是 1 到 65535 的整数。')
    }
    return port
}

export function normalizeAgentdAgents(input: AgentdAgentKind[]) {
    const allowed = new Set<AgentdAgentKind>(agentdAgentKinds)
    const result: AgentdAgentKind[] = []
    for (const value of input || []) {
        if (!allowed.has(value)) throw new Error(`不支持的 ACP Agent：${String(value)}`)
        if (!result.includes(value)) result.push(value)
    }
    return result
}

export function buildAgentdInstallCommand(agents: AgentdAgentKind[]) {
    const normalizedAgents = normalizeAgentdAgents(agents)
    const packages = [
        { command: 'nexus-agentd', packageName: 'nexus-agentd' },
        ...normalizedAgents.flatMap((kind) => {
            const packageName = adapterPackages[kind]
            const command = adapterCommands[kind]
            return packageName && command ? [{ command, packageName }] : []
        })
    ]
    return [
        'set -e',
        'command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 127; }',
        'mkdir -p "$HOME/.local"',
        'set --',
        ...packages.map(
            ({ command, packageName }) =>
                `command -v ${quoteShell(command)} >/dev/null 2>&1 || set -- "$@" ${quoteShell(packageName)}`
        ),
        '[ "$#" -eq 0 ] || npm_config_prefix="$HOME/.local" npm_config_fetch_timeout=45000 npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=1000 npm_config_fetch_retry_maxtimeout=10000 npm install -g --no-audit --no-fund --loglevel=error "$@"',
        ...packages.map(
            ({ command }) =>
                `command -v ${quoteShell(command)} >/dev/null 2>&1 || { echo ${quoteShell(`${command} was not found after installation`)} >&2; exit 1; }`
        ),
        ...normalizedAgents.map((kind) => {
            const command = agentCommands[kind]
            return `command -v ${quoteShell(command)} >/dev/null 2>&1 || { echo ${quoteShell(`${command} is required for ${kind}`)} >&2; exit 1; }`
        })
    ].join('; ')
}

export function buildNpmCacheCleanupCommand() {
    return [
        'set -e',
        'cache="$(readlink -f "$HOME/.npm/_cacache" 2>/dev/null || true)"',
        '[ -z "$cache" ] || [ "$cache" = "$HOME/.npm/_cacache" ] || { echo "refusing unexpected npm cache path: $cache" >&2; exit 1; }',
        '[ -z "$cache" ] || rm -rf -- "$cache"',
        'find "$HOME/.npm/_logs" -type f -mtime +7 -delete 2>/dev/null || true'
    ].join('\n')
}

export function buildAgentdConfig(
    port: number,
    workspaceRoots: string[],
    agents: AgentdAgentKind[]
) {
    return `${JSON.stringify(
        {
            listen: { host: '0.0.0.0', port: validateAgentdPort(port) },
            authToken: 'env:NEXUS_AGENTD_TOKEN',
            workspaceRoots,
            agents: Object.fromEntries(
                normalizeAgentdAgents(agents).map((kind) => [
                    kind,
                    { driver: kind, permissionPolicy: 'ask' }
                ])
            )
        },
        null,
        2
    )}\n`
}

export function buildAgentdEnvironment(
    token: string,
    home: string,
    remotePath: string,
    serviceEnvironment: Record<string, string> = {}
) {
    validateToken(token)
    const fixed = new Set(['NEXUS_AGENTD_TOKEN', 'HOME', 'PATH'])
    return [
        environmentLine('NEXUS_AGENTD_TOKEN', token),
        environmentLine('HOME', home),
        environmentLine('PATH', remotePath),
        ...Object.entries(serviceEnvironment)
            .filter(
                ([name, value]) =>
                    !fixed.has(name) &&
                    isAgentdServiceEnvironmentKey(name) &&
                    Boolean(value)
            )
            .map(([name, value]) => environmentLine(name, value))
    ].join('\n') + '\n'
}

export function buildAgentdLauncher(agentdPath: string, configPath: string) {
    return `#!/bin/sh\nexec ${quoteShell(agentdPath)} --config ${quoteShell(configPath)}\n`
}

export function buildAgentdSystemdUnit(input: {
    mode: AgentdServiceMode
    username: string
    home: string
    environmentPath: string
    launcherPath: string
}) {
    validateSystemdUser(input.username)
    return [
        '[Unit]',
        'Description=Nexus Agent Gateway',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        ...(input.mode === 'system' ? [`User=${input.username}`] : []),
        `WorkingDirectory=${systemdPath(input.home, 'WorkingDirectory')}`,
        `EnvironmentFile=${systemdPath(input.environmentPath, 'EnvironmentFile')}`,
        `ExecStart=${systemdPath(input.launcherPath, 'ExecStart')}`,
        'Restart=on-failure',
        'RestartSec=3',
        'TimeoutStopSec=20',
        'KillMode=mixed',
        'UMask=0077',
        '',
        '[Install]',
        `WantedBy=${input.mode === 'system' ? 'multi-user.target' : 'default.target'}`,
        ''
    ].join('\n')
}

async function resolveWorkspaceRoots(session: SshSession, values: string[]) {
    const roots = [...new Set((values || []).map((value) => value.trim()).filter(Boolean))]
    if (!roots.length) throw new Error('请至少填写一个 workspace 根目录。')
    const resolved: string[] = []
    for (const value of roots) {
        assertSingleLine(value, 'workspace root')
        const target = session.resolveRemotePath(value)
        await runChecked(
            session,
            `mkdir -p ${quoteShell(target)}`,
            `创建 workspace 根目录 ${value}`,
            15_000
        )
        const real = await withTimeout(
            session.realpath(target),
            `解析 workspace 根目录 ${value}`,
            fileOperationTimeoutMs
        )
        const stat = await withTimeout(
            session.stat(real),
            `检查 workspace 根目录 ${value}`,
            fileOperationTimeoutMs
        )
        if (!stat.isDirectory()) throw new Error(`workspace 根目录不是目录：${value}`)
        if (!resolved.includes(real)) resolved.push(real)
    }
    return resolved
}

async function installAgentdPackages(
    session: SshSession,
    agents: AgentdAgentKind[],
    report: RemoteAgentdProgressReporter
) {
    const command = buildAgentdInstallCommand(agents)
    try {
        await runChecked(
            session,
            command,
            '安装 nexus-agentd 与 ACP Adapter',
            installTimeoutMs
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/ENOSPC|no space left on device/i.test(message)) throw error
        report('installing', '磁盘空间不足，清理 npm 缓存后重试', 35)
        await runChecked(
            session,
            buildNpmCacheCleanupCommand(),
            '清理远端 npm 缓存',
            60_000
        )
        await runChecked(
            session,
            command,
            '清理缓存后安装 nexus-agentd 与 ACP Adapter',
            installTimeoutMs
        )
    }
}

async function detectServicePrivilege(session: SshSession): Promise<ServicePrivilege> {
    const output = await runChecked(
        session,
        buildServicePrivilegeCommand(),
        '检查 systemd 服务权限',
        15_000
    )
    const value = output.trim()
    if (value === 'system-root' || value === 'system-sudo' || value === 'user') {
        return value
    }
    throw new Error(`无法识别 systemd 服务模式：${value || 'unknown'}`)
}

export function buildServicePrivilegeCommand() {
    return [
        'if [ "$(id -u)" -eq 0 ]; then',
        '    printf system-root',
        'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
        '    printf system-sudo',
        'elif systemctl --user show-environment >/dev/null 2>&1; then',
        '    printf user',
        'else',
        '    echo "systemd service management requires root, passwordless sudo, or a working user systemd session" >&2',
        '    exit 1',
        'fi'
    ].join('\n')
}

async function startAgentdService(
    session: SshSession,
    privilege: ServicePrivilege,
    stagedUnitPath: string
) {
    const prefix = privilege === 'system-sudo' ? 'sudo -n ' : ''
    const command =
        privilege === 'user'
            ? [
                  'set -e',
                  'systemctl --user daemon-reload',
                  'systemctl --user enable nexus-agentd.service >/dev/null',
                  'systemctl --user restart nexus-agentd.service',
                  'systemctl --user is-active --quiet nexus-agentd.service'
              ].join('; ')
            : [
                  'set -e',
                  `${prefix}install -m 0644 ${quoteShell(stagedUnitPath)} /etc/systemd/system/nexus-agentd.service`,
                  `${prefix}systemctl daemon-reload`,
                  `${prefix}systemctl enable nexus-agentd.service >/dev/null`,
                  `${prefix}systemctl restart nexus-agentd.service`,
                  `${prefix}systemctl is-active --quiet nexus-agentd.service`
              ].join('; ')
    await runChecked(session, command, '启动 nexus-agentd systemd 服务', 60_000)
}

async function readAgentdDiagnostics(
    session: SshSession,
    privilege: ServicePrivilege
) {
    const prefix = privilege === 'system-sudo' ? 'sudo -n ' : ''
    const command =
        privilege === 'user'
            ? [
                  'set +e',
                  'SYSTEMD_COLORS=0 systemctl --user status nexus-agentd.service --no-pager --full 2>&1',
                  'SYSTEMD_COLORS=0 journalctl --user -u nexus-agentd.service -n 80 --no-pager 2>&1'
              ].join('; ')
            : [
                  'set +e',
                  `SYSTEMD_COLORS=0 ${prefix}systemctl status nexus-agentd.service --no-pager --full 2>&1`,
                  `SYSTEMD_COLORS=0 ${prefix}journalctl -u nexus-agentd.service -n 80 --no-pager 2>&1`
              ].join('; ')
    try {
        const result = await session.exec(command, { timeoutMs: 20_000 })
        return `${result.stdout}\n${result.stderr}`.trim().slice(-8000)
    } catch {
        return ''
    }
}

function appendAgentdDiagnostics(error: unknown, diagnostics: string) {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(
        diagnostics
            ? `${message}\n\n远端服务诊断：\n${diagnostics}`
            : message
    )
}

function buildHealthCheckCommand(port: number) {
    return `node -e ${quoteShell(buildHealthCheckScript(port))}`
}

export function buildHealthCheckScript(port: number) {
    const script = [
        '(async () => {',
        `const url = ${JSON.stringify(`http://127.0.0.1:${validateAgentdPort(port)}/health`)};`,
        'const deadline = Date.now() + 15000;',
        'let lastError;',
        'while (Date.now() < deadline) {',
        'try {',
        'const response = await fetch(url, { signal: AbortSignal.timeout(3000) });',
        'if (!response.ok) throw new Error(`health check returned ${response.status}`);',
        'const value = await response.json();',
        'if (!value || value.ok !== true) throw new Error("invalid health response");',
        'return;',
        '} catch (error) {',
        'lastError = error;',
        'await new Promise((resolve) => setTimeout(resolve, 500));',
        '}',
        '}',
        'throw lastError || new Error("health check timed out");',
        '})().catch((error) => { console.error(error.message || String(error)); process.exit(1); });'
    ].join('\n')
    return script
}

async function writeRemoteAtomic(
    session: SshSession,
    target: string,
    content: string,
    mode: number
) {
    const temporary = `${target}.tmp-${randomUUID()}`
    try {
        await withTimeout(
            session.writeFile(temporary, content, mode),
            `写入远端文件 ${target}`,
            fileOperationTimeoutMs
        )
        await withTimeout(
            session.replaceFile(temporary, target),
            `替换远端文件 ${target}`,
            fileOperationTimeoutMs
        )
    } catch (error) {
        await withTimeout(
            session.unlink(temporary),
            `清理远端临时文件 ${temporary}`,
            fileOperationTimeoutMs
        ).catch(() => undefined)
        throw error
    }
}

async function withTimeout<T>(task: Promise<T>, label: string, timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            task,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label}超时。`)),
                    timeoutMs
                )
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function runChecked(
    session: SshSession,
    command: string,
    label: string,
    timeoutMs: number
) {
    const result = await session.exec(command, { timeoutMs })
    assertExecResult(result, label)
    return result.stdout
}

function assertExecResult(result: ExecResult, label: string) {
    if (result.timedOut) throw new Error(`${label}超时。`)
    if (result.truncated) throw new Error(`${label}输出过长，无法确认结果。`)
    if (result.exitCode !== 0) {
        const output = (result.stderr || result.stdout).trim().slice(-3000)
        throw new Error(`${label}失败（exit ${result.exitCode}）：${output || 'unknown error'}`)
    }
}

function environmentLine(name: string, value: string) {
    assertSingleLine(value, name)
    return `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function systemdPath(value: string, label: string) {
    assertSingleLine(value, label)
    if (!value.startsWith('/') || /[\s"'\\]/.test(value)) {
        throw new Error(`${label} 不是可直接写入 systemd unit 的绝对路径：${value}`)
    }
    return value
}

function validateToken(value: string) {
    if (value.length < 32 || /[\r\n\0]/.test(value)) {
        throw new Error('nexus-agentd Token 格式无效。')
    }
}

function validateSystemdUser(value: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(value)) {
        throw new Error(`远端系统用户名称不适合写入 systemd unit：${value || 'unknown'}`)
    }
}

function isAgentdServiceEnvironmentKey(value: string) {
    return (
        [
            'SHELL',
            'LANG',
            'LANGUAGE',
            'LC_ALL',
            'XDG_CONFIG_HOME',
            'XDG_DATA_HOME',
            'XDG_CACHE_HOME'
        ].includes(value) || value.startsWith('LC_')
    )
}

function assertSingleLine(value: string, label: string) {
    if (!value || /[\r\n\0]/.test(value)) {
        throw new Error(`${label} 包含无效字符。`)
    }
}
