# koishi-plugin-agent-nexus

AgentNexus 是面向 ChatLuna 的 **SSH 运维面 + A2A Client**。

- SSH 用于管理远端机器、探测和安装 Agent、同步 Skills、SFTP 文件管理与终端。
- A2A 用于让 ChatLuna 发现并委托外部 Agent Server。

AgentNexus 固定作为 A2A Client，不实现、部署或维护 A2A Server，也不再提供按框架点名的
SSH 直调命令。ChatLuna 调用远端 Agent 时只走
`nexus_a2a_delegate`，不会把 SSH Agent CLI 当作模型工具。

[更新日志](./CHANGELOG.md)

## 支持的 Agent

- Hermes
- OpenClaw
- Claude Code
- OpenCode
- Codex
- Pi

这些适配器只负责通过 SSH 探测可执行文件、安装缺失的 Agent，以及提供 Skills 目录信息。
不同框架的实际任务调用由各自的 A2A Server 负责。

## 功能

- SSH 密码或私钥认证
- SSH SHA-256 主机密钥 TOFU 或严格校验
- 已启用设备自动保持连接与断线重连
- 探测六类 Code Agent 的可执行文件
- 一键安装未检测到的 Agent
- 不执行版本检测、最新版查询或 Agent 更新
- 从 Git 仓库同步 Skills，并软链接到已安装 Agent
- SFTP 文件浏览、预览、编辑、上传、下载、重命名和删除
- Koishi Console 交互终端
- A2A v1.0 Client，并兼容常见 v0.3 Agent Card 与 JSON-RPC Server
- 独立管理每个外部 Agent Card、Bearer Token、Card 路径和传输方式
- 只向 ChatLuna 注册一个高层后台委托工具

## 安装

```bash
npm install koishi-plugin-agent-nexus
```

也可以在 Koishi 插件市场搜索 `agent-nexus`。

运行要求：

- Node.js 20 或更高版本
- `koishi-plugin-chatluna`
- `koishi-plugin-chatluna-storage-service`
- Console 页面需要 Koishi `console`
- 交互终端需要 Koishi `server`

## 快速开始

1. 在 Koishi 中启用 ChatLuna、ChatLuna Storage 和 AgentNexus。
2. 打开 Console 左侧的 **AgentNexus**。
3. 在 **Computer** 页添加远端 SSH 设备并连接扫描。
4. 对未安装的 Agent 点击安装；需要时在 **Skills** 页同步技能仓库。
5. 在远端按对应框架说明启动 A2A Server。
6. 在 **A2A** 页逐个添加完整 Agent Card URL，然后点击发现。
7. ChatLuna 使用 `nexus_a2a_delegate` 把任务交给外部 Agent。

## 职责边界

### SSH 负责

- 主机连接、重连和主机密钥校验
- Agent 可执行文件存在性探测
- 安装尚未安装的 Agent
- Skills 同步与软链接
- SFTP 文件管理
- Console 交互终端

### A2A 负责

- Agent Card 和 Skills 发现
- 创建、续接、查询、补充输入和取消远端任务
- 维护 A2A Task ID 与 Context ID
- 在任务完成、失败或等待输入时唤醒原 ChatLuna 会话

SSH 与 A2A 配置相互独立。SSH 设备名称不代表 A2A Agent；每个 A2A Server 都应在
**A2A** 页以独立 Agent Card 配置加入。

## ChatLuna 工具

插件只注册：

| 工具 | 用途 |
|---|---|
| `nexus_a2a_delegate` | 后台委托外部 A2A Agent，并把结果回送到原 ChatLuna 会话 |

支持动作：

```text
run      创建或续接任务
message  给运行中或等待输入的任务补充消息
status   查询任务状态
list     列出当前 ChatLuna conversation 的任务
agents   列出已配置的 Agent Card 与 Skills
stop     取消任务
```

示例：

```text
nexus_a2a_delegate action=run remote=hermes prompt="查询橘鸦新闻"
nexus_a2a_delegate action=message id=<job> prompt="选择第二项"
nexus_a2a_delegate action=status id=<job>
nexus_a2a_delegate action=stop id=<job>
```

`run` 默认后台执行并立即返回 AgentNexus job ID。任务结束或需要补充输入时，插件会通过
ChatLuna `invoke` 回送结果。用户明确要求调用某个远端 Agent 时，ChatLuna 应把要求直接
写入 `prompt`，不先自行搜索、求解或改写。

未指定远端时：

- 当前 conversation 已绑定远端：沿用该远端。
- 只有一个启用远端：自动选择。
- 指定 `skill`：按已发现的 Agent Card Skills 选择远端。

## A2A Client

AgentNexus 不注册入站 Agent Card 或任务路由。每个外部 Agent Server 都通过完整 Card URL
单独配置，例如：

```text
http://10.1.2.50:9101/.well-known/agent-card.json
http://10.1.2.50:9201/.well-known/agent-card.json
```

不同 Agent 可以使用不同的主机、端口、Card 路径、Bearer Token 和首选传输方式。
Token 支持 `env:VAR`；Console 返回配置时会脱敏，编辑时留空会保留原值。

### 两台机器示例

```text
10.1.2.30
  Koishi + ChatLuna + AgentNexus
      ├─ SSH 运维 ───────────────┐
      └─ A2A Client ─────────────┤
                                  ▼
10.1.2.50
  ├─ Hermes A2A Server      :PORT
  ├─ OpenCode A2A Server    :PORT
  ├─ Claude Code A2A Server :PORT
  ├─ Pi A2A Server          :PORT
  └─ 其他 Agent A2A Server  :PORT
```

配置顺序：

1. 在 `10.1.2.30` 的 Computer 页添加 `10.1.2.50`，用于安装 Agent、Skills 和运维。
2. 在 `10.1.2.50` 启动各框架自己的 A2A Server。
3. 回到 A2A 页，逐个添加完整 Agent Card URL。
4. 点击发现，确认 Card、Skills 和传输方式可用。
5. 由 ChatLuna 调用 `nexus_a2a_delegate`。

常见接入项目以各框架当前文档为准：

| 框架 | 常见 A2A 接入 |
|---|---|
| Claude Code | `a2a-claude` 或其他 Claude Code A2A Server |
| OpenCode | `opencode-a2a` / `a2a-opencode` |
| Pi | `pi-a2a-communication` |
| Hermes | 官方 `platforms/a2a` 或兼容 Hermes A2A 服务 |
| OpenClaw | ACP/A2A 适配服务 |

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

同步后会按已安装 Agent 建立软链接，例如：

```text
~/.claude/skills
~/.config/opencode/skills
~/.codex/skills
~/.hermes/skills
~/.openclaw/skills
~/.pi/agent/skills
~/.pi/skills
```

## SFTP 文件与终端

**文件** 页复用 SSH 连接，支持：

- 浏览目录、大小、类型和修改时间
- 预览图片及常见文本/代码文件
- 在线编辑并保存文本
- 多文件上传和 Storage URL 下载
- 新建目录、重命名、删除文件或空目录

文件安全根目录是设备工作目录；未配置时使用远端 HOME。路径会通过 SFTP `realpath`
校验，不能跳出根目录。上传默认上限 32 MB，预览默认读取前 1 MB。

下载会流式写入 ChatLuna Storage，因此 `koishi-plugin-chatluna-storage-service` 是必需服务。

**终端** 页提供基于现有 SSH 连接的 PTY 终端。关闭页面或终端后会清理对应通道。

## 主要配置

| 配置 | 说明 |
|---|---|
| `skillRoot` | 远端 Skills 中心目录 |
| `commandAuthority` | Console 管理 RPC 的 Koishi 权限等级 |
| `maxOutputBytes` | 单次 SSH 命令输出捕获上限 |
| `a2aMaxResponseBytes` | 单个 A2A HTTP/SSE 响应读取上限 |
| `fileManagerMaxUploadBytes` | SFTP 单文件上传上限 |
| `fileManagerMaxPreviewBytes` | SFTP 文件预览读取上限 |

## 安全建议

- 只连接可信机器，并使用权限受限的专用 SSH 账号。
- 优先使用严格主机密钥校验或 TOFU 固定指纹。
- 不把文件管理根目录设置到包含无关敏感数据的位置。
- 不把 Koishi Console 暴露给不可信用户。
- 为外部 A2A Server 配置强随机 Bearer Token。
- 跨公网时使用 HTTPS 反向代理，并限制来源地址。
- 不在 Agent Card 名称、描述或 Skill 元数据中写入秘密。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
```

`npm pack` 与 `npm publish` 会通过 `prepack` 自动执行完整构建。

构建产物：

```text
lib/index.js
dist/
```

## License

MIT
