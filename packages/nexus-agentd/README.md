# nexus-agentd

`nexus-agentd` 运行在 Coding Agent 所在机器，通过 Bearer Token 保护的 HTTP/SSE Gateway
向 AgentNexus 暴露本机白名单 Agent。当前支持 OpenCode、Claude Code、Codex、Pi 和
OpenClaw ACP Driver；Hermes 使用其原生 A2A Server，不经过 agentd。

当前部署目标是 Linux/Unix Agent 主机。

```text
AgentNexus
    │ HTTP/SSE
    ▼
nexus-agentd
    │ ACP stdio
    ▼
OpenCode / Claude Code / Codex / Pi / OpenClaw
```

## 安装与启动

```bash
npm install -g nexus-agentd
curl -fsSL \
  https://raw.githubusercontent.com/lumia1998/koishi-plugin-agent-nexus/main/packages/nexus-agentd/nexus-agentd.example.json \
  -o nexus-agentd.json
export NEXUS_AGENTD_TOKEN='TOKEN'
nexus-agentd --config nexus-agentd.json
```

OpenCode 和 OpenClaw 自带 ACP 入口。Claude Code、Codex、Pi 需要先安装对应 adapter：

```bash
npm install -g \
  @agentclientprotocol/claude-agent-acp \
  @agentclientprotocol/codex-acp \
  pi-acp
```

还需要分别完成各 Agent 自身的登录或 API Key 配置。`claude-agent-acp` 当前要求 Node.js 22
或更高版本；其他 adapter 的版本要求以各自发布包为准。

也可以设置配置路径：

```bash
export NEXUS_AGENTD_CONFIG=/etc/agent-nexus/nexus-agentd.json
nexus-agentd
```

从仓库开发：

```bash
npm install
npm run build
node dist/cli.js --config nexus-agentd.json
```

## 配置

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "authToken": "env:NEXUS_AGENTD_TOKEN",
  "workspaceRoots": [
    "/data/repos"
  ],
  "agents": {
    "opencode": {
      "driver": "opencode",
      "command": "opencode",
      "args": ["acp"],
      "permissionPolicy": "ask",
      "inheritEnv": [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY"
      ]
    },
    "claude": {
      "driver": "claude",
      "command": "claude-agent-acp",
      "permissionPolicy": "ask"
    },
    "codex": {
      "driver": "codex",
      "command": "codex-acp",
      "permissionPolicy": "ask"
    },
    "pi": {
      "driver": "pi",
      "command": "pi-acp",
      "permissionPolicy": "ask"
    },
    "openclaw": {
      "driver": "openclaw",
      "command": "openclaw",
      "args": ["acp"],
      "permissionPolicy": "ask"
    }
  }
}
```

主要字段：

| 字段 | 说明 |
|---|---|
| `listen.host` | 默认 `127.0.0.1`；LAN 访问需显式改为内网地址或 `0.0.0.0` |
| `listen.port` | HTTP/SSE 监听端口，默认 `8787` |
| `authToken` | 必填 Bearer Token，支持 `env:VAR` |
| `workspaceRoots` | 允许启动 ACP Session 的目录根列表 |
| `agents` | daemon 本地 Agent 白名单 |
| `driver` | `opencode`、`claude`、`codex`、`pi` 或 `openclaw` |
| `permissionPolicy` | `ask` 或 `deny`，默认 `ask` |
| `permissionTimeoutMs` | 权限或输入请求等待时间 |
| `inheritEnv` | 额外允许传给 Agent 子进程的本机环境变量名 |
| `env` | 显式环境变量，值支持 `env:VAR` |

默认入口：

| Driver | 默认命令 | 说明 |
|---|---|---|
| `opencode` | `opencode acp` | OpenCode 原生 ACP Server |
| `claude` | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` |
| `codex` | `codex-acp` | `@agentclientprotocol/codex-acp`，自带兼容 Codex 依赖 |
| `pi` | `pi-acp` | adapter 再启动本机 `pi --mode rpc` |
| `openclaw` | `openclaw acp` | OpenClaw 原生 Gateway ACP Bridge |

OpenClaw Gateway 必须已运行并可被 `openclaw acp` 访问。可通过 OpenClaw 本机配置保存 Gateway
地址和凭据，也可在 `args` 中使用 `--url` 与 `--token-file`。不要把明文 Token 提交到仓库。

Pi Driver 会同时探测 `pi-acp` 和底层 `pi`。如果 Pi 可执行文件不是默认名称，通过
`env.PI_ACP_PI_COMMAND` 指定。

`command` 和 `args` 只从 agentd 本机配置读取。HTTP 客户端不能覆盖它们。

## API

```text
GET  /health
GET  /v1/agents
POST /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
GET  /v1/sessions/:id/events
```

除 `/health` 外都要求：

```http
Authorization: Bearer TOKEN
```

创建 Session 的请求只接受：

```json
{
  "agentId": "claude",
  "workspace": "/data/repos/project"
}
```

发送消息只接受：

```json
{
  "message": "检查并修复测试"
}
```

额外字段会返回 `400`，因此客户端不能传入 command、argv 或 shell payload。

## Session 与事件

一个 Gateway Session 对应一个 ACP 子进程和一个 ACP Session。Session 完成后再次发送消息，
会续接同一 ACP Session；每轮输出单独保存，不与上一轮文本拼接。

状态：

```text
created
running
input_required
permission_required
completed
failed
canceled
```

SSE 事件包括：

```text
session_state
assistant_chunk
thought_chunk
plan
tool_call
tool_update
terminal_output
file_activity
permission_required
input_required
completed
failed
canceled
```

`/events` 支持 `after` 查询参数和 `Last-Event-ID`，用于重放内存事件日志中的后续事件。

Session 当前保存在内存中。agentd 重启会终止 ACP 子进程，旧 Gateway Session 不可恢复。

## 权限与输入

`permissionPolicy=ask` 时，ACP permission request 会进入 `permission_required`，Session 响应
包含问题和选项。AgentNexus 通过 `message` 返回：

- 选项序号，例如 `1`
- option ID
- option name
- `deny`、`cancel`、`拒绝` 或 `取消`

ACP elicitation 会进入 `input_required`。简单单字段表单可直接回复文本、数字、布尔值或列表；
多字段结构化输入使用 JSON object。

`permissionPolicy=deny` 会选择协议提供的拒绝选项，或在没有拒绝选项时取消请求。

## Workspace 安全

workspace 在启动 ACP 子进程前执行：

1. `realpath(workspace)`。
2. `realpath` 每个 `workspaceRoots`。
3. 使用路径边界检查确认 workspace 位于允许根内。

这会拒绝 `../` 逃逸、允许根之外的绝对路径和 symlink/junction 逃逸。workspace 必须已经存在。

## 网络建议

- 默认保持 `127.0.0.1`。
- LAN 监听时使用强随机 Token 和主机防火墙限制 Koishi 来源 IP。
- 不要直接暴露到公网；需要跨网络时在前面部署 HTTPS/mTLS 反向代理。
- 使用权限受限的专用系统账号运行 agentd。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
```
