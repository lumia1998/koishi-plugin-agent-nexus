# AgentNexus 架构与维护边界

> 仓库：`https://github.com/lumia1998/koishi-plugin-AgentNexus`
>
> 更新：2026-08-14

## 1. 产品定位

AgentNexus 是 ChatLuna 的 SSH 运维面与 A2A Client：

1. 通过 SSH 管理受信任远端机器。
2. 探测并安装 Hermes、OpenClaw、Claude Code、OpenCode、Codex、Pi。
3. 从 Git 仓库同步 Skills，并软链接到已安装 Agent。
4. 提供 SFTP 文件管理和交互终端。
5. 通过外部 Agent Card 发现 A2A Agent，并把 ChatLuna 任务交给对应 Server。

AgentNexus 固定作为 **A2A Client**。它不实现、部署或维护 A2A Server，也不通过 SSH
直接执行 Agent 任务。

## 2. 职责边界

### SSH 负责

- 主机连接、重连与主机密钥校验
- Agent 可执行文件存在性探测
- 未安装 Agent 的安装
- Skills 同步与软链接
- SFTP 文件管理
- 交互终端

### A2A 负责

- 在 A2A 页逐个添加完整 Agent Card URL
- Agent Card 与 Skills 发现
- ChatLuna 后台委托、续接、查询、补充输入和取消
- A2A Task ID 与 Context ID 的内部维护
- 完成、失败或等待输入后唤醒原 ChatLuna conversation

### 非目标

- 内置 Agent Card、A2A 入站路由或 A2A Server
- 通过 SSH 部署或维护第三方 A2A Server
- SSH Agent 直调命令或 ChatLuna SSH Agent 工具
- 本地托管 Agent Session、交互消息绑定和会话历史摘要
- Agent CLI 输出解析与自动产物发布
- Agent 版本检测、最新版查询或更新
- 向 ChatLuna 暴露协议级 A2A Task ID 工具

## 3. 总体架构

```text
ChatLuna
  │ nexus_a2a_delegate
  ▼
AgentNexus (Koishi)
  ├─ A2A Client
  │   ├─ Agent Card discovery
  │   ├─ JSON-RPC / HTTP+JSON / SSE
  │   ├─ delegation job store
  │   └─ ChatLuna result wakeup
  ├─ SSH operations
  │   ├─ connection pool / host key verification
  │   ├─ install-only Agent management
  │   ├─ Skills sync
  │   ├─ SFTP file manager
  │   └─ terminal
  └─ Console
      ├─ Computer
      ├─ A2A
      ├─ Skills
      ├─ Files
      └─ Terminal

Remote machine
  ├─ Hermes A2A Server      :PORT
  ├─ OpenCode A2A Server    :PORT
  ├─ Claude Code A2A Server :PORT
  ├─ Pi A2A Server          :PORT
  └─ other A2A Servers      :PORT
```

每个远端 Agent 可以使用不同端口、Card 路径、Token 和传输方式，因此必须在 A2A 页分别配置。
SSH Computer 与 A2A Remote 不建立隐式一一映射。

## 4. ChatLuna 工具

只注册一个工具：

| Tool | 作用 |
|---|---|
| `nexus_a2a_delegate` | 选择远端 A2A Agent，创建或续接任务，并把结果回送到原会话 |

支持动作：

```text
run      创建或续接任务
message  补充输入或指导
status   查看任务状态
list     列出当前 conversation 的任务
agents   列出 Agent Card 与 Skills
stop     取消任务
```

用户明确要求“调用 Hermes/OpenCode 等去做某事”时，ChatLuna 应把要求直接放入 `prompt`，
不先自行搜索、求解或改写。

## 5. 两台机器示例

```text
10.1.2.30
  Koishi + ChatLuna + AgentNexus
      ├─ SSH operations ─────────┐
      └─ A2A Client ─────────────┤
                                  ▼
10.1.2.50
  ├─ Agent CLI 与 Skills
  ├─ Hermes A2A Server :PORT
  ├─ OpenCode A2A Server :PORT
  └─ Claude Code A2A Server :PORT
```

配置顺序：

1. 在 Computer 页添加 `10.1.2.50`，连接并扫描。
2. 安装缺少的 Agent，同步需要的 Skills。
3. 在远端按各框架说明启动 A2A Server。
4. 在 A2A 页逐个添加完整 Agent Card URL 并发现。
5. 由 ChatLuna 调用 `nexus_a2a_delegate`。

## 6. 核心代码

```text
src/service.ts                  核心服务、SSH 运维与工具注册
src/a2a/client.ts               Agent Card 发现与 A2A 出站协议
src/a2a/delegation-manager.ts   后台任务、续接、轮询和通知
src/a2a/delegation-store.ts     ChatLuna A2A job 持久化
src/a2a/chatluna-wakeup.ts      结果回送到原 ChatLuna conversation
src/tools/a2a_delegate.ts       唯一 ChatLuna 工具
src/ssh/                       SSH 连接、执行、SFTP 与主机密钥
src/adapters/                  Agent 可执行文件探测与 Skills 目录
src/agents/maintenance.ts       install-only 安装计划
src/skills/sync.ts              Skills Git 同步与软链接
src/files/manager.ts            SFTP 文件管理
src/webui/index.ts              Console RPC
client/components/              Computer、A2A、Skills、Files、Terminal
```

## 7. 配置与持久化

- 主配置：`{koishi.baseDir}/data/agent-nexus/config.json`
- A2A job：`{koishi.baseDir}/data/agent-nexus/a2a-tasks.json`
- 配置与任务文件使用原子写入；损坏文件会移到备份路径。
- 旧配置中的 runtime、默认 Agent 等已移除字段不会再次写回。

## 8. 安全边界

- SSH 默认使用 TOFU 固定 SHA-256 主机密钥，也支持严格校验。
- Console RPC 不回传密码、私钥、passphrase 或 A2A Token。
- 密钥与 Token 支持 `env:VAR`。
- SFTP 路径通过 `realpath` 限制在设备工作目录内。
- SSH 输出、终端消息、A2A 响应和文件操作均设置大小或时间边界。
- Agent Card 可以公开发现，但任务端点应使用强 Token，并优先通过 HTTPS 暴露。

## 9. 当前维护原则

- 保持 A2A Client 与 SSH 运维面解耦。
- 所有模型可调用的远端 Agent 能力统一进入 `nexus_a2a_delegate`。
- SSH 只做机器运维，不新增 Agent 任务执行入口。
- Agent 安装器只负责“未安装到已安装”，不承担包管理器更新策略。
- 不为单一框架增加私有任务协议；框架差异由其 A2A Server 处理。
- 只有能降低真实复杂度的功能才进入核心插件。

## 10. 后续优先级

1. 在真实 Koishi + ChatLuna 环境验证完整 A2A 委托、后台回送和等待输入链路。
2. 增加不同 Agent Card 路径、认证方式和传输方式的兼容性样本。
3. 增加 SSH/SFTP/PTY/Skills 的集成测试。
4. 根据真实使用情况继续减少无状态、重复或仅供调试的 Console RPC。
5. 只有出现跨进程部署需求时，再评估 SQLite/Redis job store。

## 11. 构建验证

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
```

构建产物仅包含：

```text
lib/index.js
dist/
```
