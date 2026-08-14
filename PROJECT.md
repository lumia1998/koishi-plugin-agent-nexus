# AgentNexus 架构与维护边界

> 仓库：`https://github.com/lumia1998/koishi-plugin-agent-nexus`
>
> 更新：2026-08-14

## 1. 产品定位

AgentNexus 是 ChatLuna 的 SSH 运维面与协议无关 Agent 委托层：

1. 通过 SSH 管理受信任远端机器。
2. 探测并安装 Hermes、OpenClaw、Claude Code、OpenCode、Codex、Pi。
3. 从 Git 仓库同步 Skills，并软链接到已安装 Agent。
4. 提供 SFTP 文件管理和交互终端。
5. 通过 A2A Provider 调用标准远程 A2A Agent。
6. 通过 Nexus Gateway Provider 调用远端 `nexus-agentd`，由 agentd 使用本机 ACP 驱动 Coding Agent。

AgentNexus 不实现 A2A Server，也不通过 SSH 执行 Agent 任务。

## 2. 核心原则

- A2A 完整保留，不改成 ACP-only。
- SSH 只承担连接、安装、探测、Skills、SFTP、Terminal 和诊断。
- ChatLuna 第一阶段继续只注册 `nexus_a2a_delegate`。
- 每个逻辑 Agent 独立选择 A2A 或 Gateway+ACP。
- AgentNexus 持有稳定 Job ID；协议 ID 只保存在 `providerState`。
- A2A/Gateway Remote 与 SSH Computer 不隐式绑定。
- `nexus-agentd` 是独立 ESM package。
- `nexus-agentd` 面向 Linux/Unix Agent 主机，不维护 Windows command shim。
- ACP Driver 支持 OpenCode、Claude Code、Codex、Pi 和 OpenClaw；Hermes 保持原生 A2A。
- HTTP 客户端不能向 agentd 传 command/argv。
- workspace 必须经过 `realpath` allowlist 校验。
- agentd 默认 localhost、Bearer Token、权限策略默认 `ask`。

## 3. 总体架构

```text
ChatLuna
  │ nexus_a2a_delegate
  ▼
AgentNexus DelegationManager
  │
  ├─ A2ADelegationProvider
  │    └─ A2AClientService
  │         └─ Agent Card / JSON-RPC / HTTP+JSON / SSE
  │
  └─ NexusGatewayProvider
       └─ NexusGatewayClient
            └─ HTTP/SSE
                 ▼
             nexus-agentd
                 └─ AcpProcessRuntime
                      ├─ OpenCodeDriver  ─ opencode acp
                      ├─ ClaudeDriver    ─ claude-agent-acp
                      ├─ CodexDriver     ─ codex-acp
                      ├─ PiDriver        ─ pi-acp
                      └─ OpenClawDriver  ─ openclaw acp

AgentNexus SSH Operations
  ├─ connection pool / host key verification
  ├─ install-only Agent management
  ├─ Skills sync
  ├─ SFTP file manager
  └─ terminal
```

## 4. Delegation Core

运行时入口：

```text
ChatLuna Tool
    ↓
DelegationManager
    ↓
DelegationProviderRegistry
    ├─ A2ADelegationProvider
    └─ NexusGatewayProvider
```

通用动作：

```text
run
message
status
list
agents
stop
```

通用状态：

```text
running
input_required
permission_required
completed
failed
canceled
```

`DelegationJob` 使用 schema v2。稳定字段包括：

```text
id                 AgentNexus Job ID
provider           a2a | gateway
agentId            逻辑 Agent ID
remoteId           A2A Remote 或 Gateway ID
providerAgentId    Gateway 内 Agent Driver ID
providerState      协议私有状态
```

A2A `providerState`：

```text
taskId
contextId
remoteState
```

Gateway `providerState`：

```text
gatewaySessionId
acpSessionId
lastEventId
agentId
workspace
remoteState
```

新 Job 只在 provider、remote、Gateway agentId 和 workspace 兼容时复用旧 `providerState`。
已有 Job 的 provider/agent/remote 身份在续接时保持不变，防止配置切换导致协议串线。

## 5. 每 Agent 路由

`delegation.agents` 定义逻辑 Agent：

```ts
interface DelegationAgentConfig {
  id: string
  name: string
  enabled: boolean
  provider: 'a2a' | 'gateway'
  remoteId: string
  agentId?: string
  workspace?: string
  description?: string
  skills?: string[]
}
```

- A2A 路由只需要 `remoteId`。
- Gateway 路由还必须提供 `agentId` 和 `workspace`。
- 未被显式逻辑路由引用的旧 A2A Remote 继续作为隐式 Agent 暴露。
- 删除 Remote 不级联删除逻辑 Agent，后者会显示为不可用，便于修复配置。

## 6. A2A Provider

A2A Provider 包装现有 `A2AClientService`，不重写协议实现。

保留能力：

- Agent Card 与 Skills 发现
- JSON-RPC 和 HTTP+JSON
- SSE 响应
- Task ID 与 Context ID
- 后台轮询、续接、补充输入和取消
- ChatLuna conversation wakeup

旧的 A2A 专用 Manager/Store 测试继续保留为回归覆盖；生产运行时使用通用 Delegation Core。

## 7. Nexus Gateway Provider

Gateway API：

```text
GET  /v1/agents
POST /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
GET  /v1/sessions/:id/events
```

Gateway Client 支持：

- Bearer Token 与 `env:VAR`
- HTTP 响应大小限制
- SSE Event ID、`after` 和 `Last-Event-ID`
- Session 创建、查询、消息和取消

当前 Delegation Manager 使用 `GET session` 轮询完成 wakeup。SSE Client 和事件模型已经保留，
后续可在确认重连语义后替换或辅助轮询。

## 8. nexus-agentd

独立 package：

```text
packages/nexus-agentd/
```

主要模块：

```text
src/server.ts             Gateway HTTP/SSE
src/session.ts            Gateway Session 生命周期
src/acp/runtime.ts        公共 ACP Client Runtime
src/drivers/stdio.ts      共享 stdio、环境白名单和进程探测
src/drivers/*.ts          OpenCode、Claude Code、Codex、Pi、OpenClaw Driver
src/workspace.ts          realpath allowlist
src/config.ts             本地配置和 secret 解析
```

一个 Gateway Session 对应一个隔离 ACP 子进程。公共 Runtime 固定使用官方 ACP SDK，Driver
只声明可执行文件、argv、环境、探测方式和显示元数据，不复制 ACP Session 实现。

HTTP 请求只能指定：

```text
agentId
workspace
message
```

可执行文件、argv、环境变量、认证假设和权限策略只能存在于 agentd 本机配置。

## 9. 权限与输入

ACP Runtime 将权限请求和 elicitation 映射为：

```text
permission_required
input_required
```

待用户回答的问题和选项进入 Gateway Session `pendingRequest`，再由 Provider 格式化进
AgentNexus Job 输出。ChatLuna 通过同一工具的 `message` 动作提交选项 ID、名称、序号或输入。

权限策略：

- `ask`：默认，等待 ChatLuna/用户决策。
- `deny`：选择拒绝选项或取消。

不存在 silent allow-all。

## 10. 持久化与迁移

主配置：

```text
{koishi.baseDir}/data/agent-nexus/config.json
```

通用 Job：

```text
{koishi.baseDir}/data/agent-nexus/delegation-jobs.json
```

旧 A2A Job：

```text
{koishi.baseDir}/data/agent-nexus/a2a-tasks.json
```

新文件不存在时导入旧 schema v1：

- `a2aTaskId -> providerState.taskId`
- `contextId -> providerState.contextId`
- `waiting_input -> input_required`
- `provider = a2a`

旧文件不删除、不覆盖。损坏的新文件或迁移源会停止 Delegation Store 初始化，避免静默丢失。

agentd Session 当前只保存在内存；daemon 重启后不能恢复旧 ACP 进程。

## 11. 安全边界

- SSH 使用 SHA-256 TOFU 或严格主机密钥固定。
- Console RPC 不返回 SSH secret、A2A Token 或 Gateway Token。
- agentd 默认监听 `127.0.0.1`，LAN 监听必须显式配置。
- Gateway 要求 Bearer Token，支持 `env:VAR`。
- 客户端 command/argv 注入由严格请求字段白名单拒绝。
- workspace 和允许根都先 `realpath`，阻止 traversal 和 symlink escape。
- Driver 环境只继承基础白名单和本地显式 `inheritEnv`。
- 请求体、响应、事件数量和输出长度均有限制。
- ACP 权限默认询问，取消状态不能被迟到的 prompt 结果覆盖。

## 12. 核心代码

```text
src/delegation/                 协议无关 Job、Store、Manager、Provider Registry、wakeup
src/providers/a2a.ts            A2A Provider
src/providers/gateway.ts        Nexus Gateway Provider
src/gateway/                    Gateway HTTP/SSE Client
src/a2a/client.ts               现有 A2A 协议实现
src/tools/a2a_delegate.ts       唯一 ChatLuna 高层工具
src/service.ts                  服务装配、SSH 运维和 Console 数据
src/ssh/                        SSH 连接、执行、SFTP 与主机密钥
src/adapters/                   Agent 探测和 Skills 目录
src/agents/maintenance.ts       install-only 安装计划
src/webui/index.ts              Console RPC
client/components/a2a-panel.vue Agent/Remote/Gateway 配置
packages/nexus-agentd/          独立 Gateway + ACP daemon
```

## 13. 非目标

- 内置 A2A Server 或 Agent Card 入站路由
- 通过 SSH spawn ACP Agent
- SSH Agent 直调命令
- 从 ChatLuna 输入任意 shell command
- 把没有 ACP Server/Adapter 的普通 CLI stdout 当作 ACP
- 默认开放整个服务器文件系统
- 静默批准所有 ACP 权限
- 第一阶段跨公网部署

## 14. 后续优先级

1. 在真实 Koishi + ChatLuna 环境验证 Gateway 后台 wakeup 和权限交互。
2. 增加可选的 Gateway SSE 实时监听与断线重连策略。
3. 评估 agentd Session 恢复或明确的 daemon 重启恢复流程。
4. 在真实安装环境分别完成 Claude Code、Codex、Pi、OpenClaw 的协议互操作测试。
5. Hermes 继续使用原生 A2A，不为协议统一而增加多余 ACP Bridge。
6. 稳定后再评估把工具名迁移为 `nexus_delegate`。

## 15. 构建验证

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
npm pack --dry-run --json --workspace nexus-agentd
```

根插件发布包：

```text
CHANGELOG.md
lib/
dist/
```

agentd 发布包：

```text
dist/
nexus-agentd.example.json
README.md
```
