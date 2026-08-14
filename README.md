# koishi-plugin-agent-nexus

AgentNexus 是面向 ChatLuna 的 **SSH 运维面 + 统一 Agent 委托层**。

- SSH 用于连接远端机器、探测和安装 Agent、同步 Skills、SFTP 文件管理、终端和诊断。
- A2A Provider 用于调用标准远程 A2A Agent。
- Nexus Gateway Provider 通过 HTTP/SSE 调用远端 `nexus-agentd`，再由 agentd 使用本机 ACP 连接 Coding Agent。

ChatLuna 始终只使用一个高层工具 `nexus_a2a_delegate`。每个逻辑 Agent 可以单独配置为
走 **A2A** 或 **Nexus Gateway + ACP**，调用方不需要了解底层协议。

AgentNexus 不通过 SSH 执行 Agent CLI，也不实现 A2A Server。

[更新日志](./CHANGELOG.md)

## 架构

```text
ChatLuna
   │ nexus_a2a_delegate
   ▼
AgentNexus Delegation Core
   ├─ A2A Provider ───────────────► 外部标准 A2A Agent
   │
   └─ Gateway Provider ─HTTP/SSE─► nexus-agentd
                                      │ ACP stdio
                                      ▼
                                  OpenCode / Claude Code
                                  Codex / Pi / OpenClaw

AgentNexus SSH Operations
   └─ 连接 / 安装 / 探测 / Skills / SFTP / Terminal / 诊断
```

SSH Computer、A2A Remote 和 Nexus Gateway 是三类独立配置，不建立隐式一一映射。

## 当前支持范围

SSH 探测、安装和 Skills 适配器：

- Hermes
- OpenClaw
- Claude Code
- OpenCode
- Codex
- Pi

任务执行：

- A2A：继续支持现有 Agent Card、JSON-RPC、HTTP+JSON、SSE、Task/Context 续接。
- ACP：支持 OpenCode、Claude Code、Codex、Pi 和 OpenClaw。
- Hermes：保持使用原生 A2A，不增加 ACP Driver。

ACP 默认入口分别为 `opencode acp`、`claude-agent-acp`、`codex-acp`、`pi-acp` 和
`openclaw acp`。其中 Claude Code、Codex 和 Pi 的 adapter 必须在 agentd 所在机器可执行。

## 功能

- SSH 密码或私钥认证
- SSH SHA-256 主机密钥 TOFU 或严格校验
- 已启用设备自动保持连接与断线重连
- 探测六类 Code Agent 的可执行文件
- 一键安装未检测到的 Agent
- 不执行 SSH Agent 版本检测、最新版查询或更新
- 从 Git 仓库同步 Skills，并软链接到已安装 Agent
- SFTP 文件浏览、预览、编辑、上传、下载、重命名和删除
- Koishi Console 交互终端
- A2A v1.0 Client，并兼容常见 v0.3 Agent Card 与 JSON-RPC Server
- Nexus Gateway HTTP API 与 SSE Client
- 独立 `nexus-agentd` ACP Runtime
- 每个逻辑 Agent 独立选择 A2A 或 ACP
- 稳定的 AgentNexus Job ID 与协议内部状态隔离
- 后台轮询、状态查询、补充输入、权限决策、取消和 ChatLuna wakeup

## 安装

Koishi 插件：

```bash
npm install koishi-plugin-agent-nexus
```

Linux/Unix Agent 主机：

```bash
npm install -g nexus-agentd
```

也可以在 Koishi 插件市场搜索 `agent-nexus`。

运行要求：

- Node.js 20 或更高版本
- `koishi-plugin-chatluna`
- `koishi-plugin-chatluna-storage-service`
- Console 页面需要 Koishi `console`
- 交互终端需要 Koishi `server`

## 快速开始

### 1. 配置 SSH 运维面

1. 在 Koishi 中启用 ChatLuna、ChatLuna Storage 和 AgentNexus。
2. 打开 Console 左侧的 **AgentNexus**。
3. 在 **Computer** 页添加远端 SSH 设备并连接扫描。
4. 对未安装的 Agent 点击安装；需要时在 **Skills** 页同步技能仓库。

SSH 设备只负责机器管理。后续 A2A/Gateway 配置可以指向同一台机器，也可以完全不同。

### 2A. 添加 A2A Agent

1. 在远端按对应框架说明启动 A2A Server。
2. 在 **A2A / ACP** 页添加完整 Agent Card URL 并点击发现。
3. 添加“委托 Agent”，连接方式选择 **A2A**，再选择对应 Agent Card。

未建立显式逻辑路由的旧 A2A Agent Card 仍可直接调用，兼容已有配置。

### 2B. 添加 ACP Agent

在 Linux/Unix Coding Agent 主机部署 `nexus-agentd`：

```bash
npm install -g nexus-agentd
curl -fsSL \
  https://raw.githubusercontent.com/lumia1998/koishi-plugin-agent-nexus/main/packages/nexus-agentd/nexus-agentd.example.json \
  -o nexus-agentd.json
export NEXUS_AGENTD_TOKEN='TOKEN'
nexus-agentd --config nexus-agentd.json
```

Claude Code、Codex 和 Pi 需要安装 ACP adapter：

```bash
npm install -g \
  @agentclientprotocol/claude-agent-acp \
  @agentclientprotocol/codex-acp \
  pi-acp
```

OpenCode 使用原生 `opencode acp`；OpenClaw 使用原生 `openclaw acp`，并要求 OpenClaw
Gateway 已经启动。Hermes 继续在 2A 中配置为 A2A。

示例配置：

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
      "permissionPolicy": "ask"
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

`command` 和 `args` 只能写在 agentd 本机配置中。AgentNexus/ChatLuna 的 HTTP 请求只能传：

```text
agentId
workspace
message
```

如果 Koishi 在另一台机器，把 `listen.host` 显式改成 agentd 的内网地址或 `0.0.0.0`，并同时
配置强随机 Token 和主机防火墙。默认只监听 `127.0.0.1`。

回到 Koishi：

1. 在 **A2A / ACP** 页添加 Nexus Gateway，例如 `http://10.1.2.40:8787`。
2. 填入同一个 Bearer Token 并点击发现。
3. 添加“委托 Agent”，连接方式选择 **Nexus Gateway + ACP**。
4. 选择 Gateway，填写 agentd 中对应的 `agentId` 和允许范围内的绝对 workspace。

## 每个 Agent 选择连接方式

逻辑 Agent 配置包含：

```text
id / name
provider: a2a | gateway
remoteId
agentId      # Gateway/ACP 使用
workspace    # Gateway/ACP 使用
description
skills
```

例如：

```text
Hermes News
  provider: A2A
  remote: hermes-card

OpenCode Dev
  provider: Gateway + ACP
  remote: dev-server
  agentId: opencode
  workspace: /data/repos/project

Claude Review
  provider: Gateway + ACP
  remote: dev-server
  agentId: claude
  workspace: /data/repos/project
```

ChatLuna 只需点名 `Hermes News` 或 `OpenCode Dev`。AgentNexus 根据配置选择协议，不会回退到
SSH Agent CLI。

## 两台机器示例

```text
10.1.2.30
  Koishi + ChatLuna + AgentNexus
      ├─ SSH 运维 ─────────────────────────────┐
      ├─ A2A Client ─────────► A2A Server       │
      └─ Gateway Client ─────► nexus-agentd     │
                                                   ▼
10.1.2.40
  ├─ OpenCode / Claude Code / Codex / Pi / OpenClaw
  ├─ 对应 ACP Server/Adapter
  ├─ nexus-agentd :8787
  └─ Hermes A2A Server
```

同一台远端机器可以同时提供多个不同端口的 A2A Server 和一个 Nexus Gateway；这些 Remote
都在 **A2A / ACP** 页独立添加。

## ChatLuna 工具

插件只注册：

| 工具 | 用途 |
|---|---|
| `nexus_a2a_delegate` | 通过已配置的 A2A 或 Gateway+ACP Agent 执行统一后台委托 |

工具名暂时保留 `a2a` 是为了兼容已有 ChatLuna 配置，内部已经是协议无关 Delegation Core。

支持动作：

```text
run      创建任务或续接同一远端上下文
message  回答等待输入/权限请求，或给任务补充消息
status   查询 AgentNexus Job 状态
list     列出当前 ChatLuna conversation 的 Job
agents   列出可用逻辑 Agent、协议和 Skills
stop     取消任务
```

示例：

```text
nexus_a2a_delegate action=run remote="Hermes News" prompt="查询橘鸦新闻"
nexus_a2a_delegate action=run remote="OpenCode Dev" prompt="检查当前项目测试"
nexus_a2a_delegate action=message id=<job> prompt="1"
nexus_a2a_delegate action=status id=<job>
nexus_a2a_delegate action=stop id=<job>
```

`run` 默认后台执行并立即返回稳定的 AgentNexus Job ID。A2A Task ID、A2A Context ID、Gateway
Session ID 和 ACP Session ID 只保存在 `providerState`，不会作为 ChatLuna 的主要任务 ID。

任务完成、失败、等待输入或等待权限决策时，插件会通过 ChatLuna `invoke` 唤醒原会话。
用户明确点名远端 Agent 时，ChatLuna 应把要求直接写入 `prompt`，不先自行搜索、求解或改写。

## A2A Client

AgentNexus 不注册入站 Agent Card 或任务路由。每个外部 Agent Server 使用完整 Card URL 独立
配置，例如：

```text
http://10.1.2.50:9101/.well-known/agent-card.json
http://10.1.2.50:9201/.well-known/agent-card.json
```

不同 Agent 可以使用不同主机、端口、Card 路径、Bearer Token 和首选传输方式。Token 支持
`env:VAR`；Console 返回配置时会脱敏，编辑时留空会保留原值。

现有 A2A 能力继续包括：

- Agent Card 和 Skills 发现
- 创建、续接、查询、补充输入和取消远端任务
- A2A Task ID 与 Context ID 内部维护
- JSON-RPC、HTTP+JSON 和 SSE 响应处理

## Nexus Gateway 与 agentd

Gateway API：

```text
GET  /v1/agents
POST /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
GET  /v1/sessions/:id/events
```

SSE 事件模型保留 assistant chunk、thought、plan、tool call/update、terminal、file activity、
permission/input required 和终态。当前 Delegation Manager 使用状态轮询完成 ChatLuna wakeup；
Gateway SSE Client 已支持 Event ID 重放和 `Last-Event-ID`。

agentd 的 ACP Runtime 使用 `@agentclientprotocol/sdk`，一个 Gateway Session 对应一个隔离的
ACP 子进程和 ACP Session。对同一 AgentNexus Job 或兼容的后续 Job 发送 `message/run` 时，会
续接同一 ACP Session。

当前 agentd Session 保存在内存中。agentd 重启后旧 Gateway Session 不可恢复，AgentNexus
会在后续查询中报告远端 Session 丢失；A2A Job 持久化不受此限制。

## Job 持久化与迁移

新 Job 文件：

```text
{koishi.baseDir}/data/agent-nexus/delegation-jobs.json
```

首次升级且新文件不存在时，会读取旧文件：

```text
{koishi.baseDir}/data/agent-nexus/a2a-tasks.json
```

旧任务会迁移为 schema v2 的 A2A Job，原文件保持不变。损坏的新旧任务文件会阻止
Delegation Store 初始化，避免静默生成空任务列表覆盖问题。

## Computer 与 Agent 安装

Computer 页用于管理 SSH 设备。配置保存后，插件会维持启用设备的连接，并定期尝试重连。

主机密钥默认使用首次信任并固定（TOFU）：首次成功握手保存 SHA-256 指纹，后续指纹变化
会拒绝连接。已知指纹时可改为严格校验；仅兼容旧环境时才使用不校验模式。

Agent 管理是 **install-only**：

- 未发现可执行文件：显示安装按钮。
- 已发现可执行文件：只显示路径和已安装状态。
- 不查询远端或注册表版本。
- 不提供升级、降级或重新安装操作。

## Skills

在 **Skills** 页填写 Git 仓库地址。仓库中应包含 `SKILL.md`。

仓库地址只接受 HTTPS、SSH URL 或 `git@host:path`。指定分支不存在时直接失败，不回退到
默认分支；同步不会覆盖 Agent 目录中已经存在的真实 Skill 目录。

默认中心目录：

```text
~/.agent-nexus/
  repos/
  skills/
```

## SFTP 文件与终端

**文件** 页复用 SSH 连接，支持浏览、预览、编辑、上传、下载、重命名和删除。

文件安全根目录是设备工作目录；未配置时使用远端 HOME。路径会通过 SFTP `realpath` 校验，
不能跳出根目录。上传默认上限 32 MB，预览默认读取前 1 MB。

**终端** 页提供基于现有 SSH 连接的 PTY 终端。关闭页面或终端后会清理对应通道。

## 主要配置

| 配置 | 说明 |
|---|---|
| `skillRoot` | 远端 Skills 中心目录 |
| `commandAuthority` | Console 管理 RPC 的 Koishi 权限等级 |
| `maxOutputBytes` | 单次 SSH 命令输出捕获上限 |
| `a2aMaxResponseBytes` | 单个 A2A/Gateway HTTP 或 SSE 响应读取上限 |
| `fileManagerMaxUploadBytes` | SFTP 单文件上传上限 |
| `fileManagerMaxPreviewBytes` | SFTP 文件预览读取上限 |

## 安全边界

- SSH 默认使用 TOFU 固定 SHA-256 主机密钥，也支持严格校验。
- Console RPC 不回传密码、私钥、passphrase、A2A Token 或 Gateway Token。
- A2A/Gateway Token 支持 `env:VAR`。
- agentd 默认监听 localhost，并要求 Bearer Token。
- agentd 客户端请求不能指定 command/argv。
- workspace 在启动 ACP 前执行 `realpath`，并限制在 `workspaceRoots` 内，阻止 traversal 和
  symlink escape。
- ACP 权限策略只有 `ask` 或 `deny`，默认 `ask`，不存在静默 allow-all。
- 跨公网不是第一阶段目标；LAN 部署也应使用防火墙限制来源。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
npm pack --dry-run --json --workspace nexus-agentd
```

根包和 agentd 都通过 `prepack` 自动构建。根插件发布包只包含 `CHANGELOG.md`、`lib` 和
`dist`；agentd 包只包含 `dist`、示例配置和 README。

## License

MIT
