# koishi-plugin-agent-nexus

AgentNexus 是面向 ChatLuna 的 SSH Code Agent 网关。插件连接一台远端机器，
自动探测已安装的 Code Agent，并将复杂任务委托给远端 Agent 非交互执行。

支持：

- Hermes
- OpenClaw
- Claude Code
- OpenCode
- Codex

## 功能

- SSH 密码登录，配置后自动保持连接并在断线后重连
- 自动扫描远端可用的 Code Agent
- 对比官方最新版本，并在 Computer 页面一键安装或更新 Code Agent
- 注册四个工具给 ChatLuna
- 提供命令直接调用各 Code Agent，无需经过 ChatLuna 工具选择
- 从 Git 仓库同步 Skills，并软链接到各 Agent 的 Skills 目录
- 通过 SFTP 回传远端生成的文件和图片
- Koishi Console SFTP 文件管理：浏览、预览、编辑、上传下载、目录和重命名删除
- Koishi Console 单实例交互终端
- 支持远端工作目录和 Agent 自动路由

## 安装

在 Koishi 项目目录执行：

```bash
npm install koishi-plugin-agent-nexus
```

也可以通过 Koishi 插件市场搜索 `agent-nexus` 安装。

AgentNexus 需要 ChatLuna 和 `koishi-plugin-chatluna-storage-service`。
Console 页面和交互终端还需要 Koishi 的 `console` 与 `server` 服务。

## 快速开始

1. 在 Koishi 配置中启用 `agent-nexus`。
2. 打开 Koishi Console 左侧的 **AgentNexus** 页面。
3. 在 **Computer** 页面填写远端 SSH 地址、端口、账号和密码。
4. 点击 **连接并扫描**。
5. 等待 Hermes、OpenClaw、Claude Code、OpenCode、Codex 状态标签亮起。
6. ChatLuna 随后可以调用 AgentNexus 工具委托远端 Agent 执行任务。

如果 SSH 已连接但 Agent 显示 `0/5`，点击页面右上角的 **刷新并重扫**。扫描会读取
远端 login + interactive shell 的 `HOME`、`PATH` 和 `SHELL`，并让实际执行使用扫描
得到的绝对可执行文件路径；Computer 页面也会显示当前环境探测是否发生降级。

也可以直接发送 Koishi 命令调用指定 Agent：

```text
nexus.hermes <任务>
nexus.openclaw <任务>
nexus.claudecode <任务>
nexus.opencode <任务>
nexus.codex <任务>
nexus.cancel
```

也可以进入指定设备和 Agent 的交互模式。点号与空格写法都支持：

```text
nexus hermes 开发机
# 等价于 nexus.hermes 开发机

搜索漫画
2
下载到当前目录

nexus hermes 开发机 -q
```

进入后，该用户在当前 Bot、平台和频道中的普通消息都会交给绑定的 Agent，
不再需要重复输入命令与设备名。`-q` 主动退出；默认空闲 15 分钟自动退出，
可通过插件配置 `interactiveSessionTtlMs` 调整。

## Session Runtime

AgentNexus 会在自身维护任务会话，不依赖 Hermes、Claude Code、Codex 等 CLI
保存上下文。每次远端调用仍是新的非交互进程，但 Nexus 会把消息历史、任务状态、
Skill 状态和待处理动作重新编译进下一次 prompt。

对于 Hermes，Session Runtime 会使用 `hermes chat --quiet --yolo -q` 创建原生
Hermes session，并保存 stderr 中的 `session_id`；后续调用通过 `--resume` 继续
Hermes 的 Tool/Skill transcript。Nexus 仍负责用户路由、TTL、并发、确认和取消，
Hermes session 只作为 provider checkpoint。普通 `delegate()` one-shot 调用仍使用
`hermes -z`。

Hermes chat 会继承远端设备的 `~/.hermes/config.yaml`。如果回复中反复出现
`Warning: Unknown toolsets: messaging`，说明 Hermes 升级后仍保留了已经移除的旧
`messaging` toolset；请在远端运行 `hermes tools` 重新保存工具配置，或从
`platform_toolsets.cli` 中删除 `messaging`。AgentNexus 会过滤这条启动警告，避免
它污染聊天回复，但清理远端配置才能恢复正确的 Hermes 工具集。

当 Agent 或 Skill 需要用户输入时，可以返回结构化控制结果：

```json
{
  "status": "waiting_confirm",
  "prompt": "请选择漫画",
  "options": [
    { "id": 1, "label": "漫画A", "value": { "comicId": "a" } },
    { "id": 2, "label": "漫画B", "value": { "comicId": "b" } }
  ],
  "data": { "skill": "search_comic" }
}
```

直接命令产生唯一待处理会话时，用户下一条普通消息（例如 `2`）会恢复该任务；
也可以再次使用对应的 `nexus.*` 命令。ChatLuna 工具会按 conversation 隔离会话，
下一轮应再次调用 `nexus_delegate` 并把用户答案作为 `prompt`。

会话默认持久化到 `{koishi.baseDir}/data/agent-nexus/sessions.json`，插件重启后会
恢复未结束的等待任务；已结束会话会在 WebUI 的“会话”页按标题、摘要、Agent 和
状态查询，支持查看消息、删除历史和重新生成摘要。摘要默认调用 ChatLuna 默认模型，
也可通过 `sessionSummaryModel` 指定模型；模型不可用时会保留本地 fallback 摘要。
历史默认保留 30 天，可通过 `sessionHistoryRetentionMs` 调整。

源码仓库可以复用实际 Nexus SSH 配置执行五 Agent 冒烟测试。测试不会主动读取或
修改远端文件，会验证安装探测、one-shot 调用和两轮 managed Session 记忆：

```bash
npm run test:agents -- --config /path/to/data/agent-nexus/config.json
```

未安装的 Agent 会明确标记为 `installed: false`，不会被误报为已验证。

只配置一台设备时，直接写任务即可。配置多台设备时，在任务前加上 **Computer
页面里的设备名称**：

```text
nexus.hermes build 修登录页 bug
nexus.hermes 开发机 检查版本
nexus.claudecode build-server 跑测试
```

`nexus.claude` 是 `nexus.claudecode` 的别名。命令会直接回复 Agent 的文本输出，
并自动通过 SFTP 发布和发送 Agent 声明的图片或其他文件。

命令默认需要 Koishi 权限等级 4，可通过插件配置中的 `commandAuthority` 调整。
每个用户和每台 SSH 主机都有并发限制，长任务可使用 `nexus.cancel` 中止。
命令支持以下选项：

```text
-H <host>       设备名称、地址或 ID（可选；多机时更推荐写「名称 任务」）
-C <cwd>        远端工作目录
-m <model>      模型名称
-t <seconds>    超时时间（秒）
-a <name>       OpenClaw Agent 名称
-q              退出当前 Agent 交互会话（也支持放在设备名之后）
```

SSH 配置保存后，插件会维持所有已启用设备的连接，并每 30 秒检查断线状态。
进入 **终端** 页面时会自动创建一个 SSH 终端。
Console 不会回传已保存的密码或私钥；编辑已有连接时对应字段留空会继续使用原凭据。
设备名称必须唯一，因为它会用于多机命令路由。

## SFTP 文件管理

Console 的 **文件** 页面复用已建立的 SSH 连接，支持：

- 浏览目录并查看大小、类型和修改时间
- 预览图片及常见文本/代码文件
- 在线修改并保存文本文件
- 多文件上传和 Storage URL 下载
- 新建目录、重命名、删除文件或空目录

文件管理的安全根目录是设备的 **工作目录**；未配置工作目录时使用远端 HOME。
所有路径都会通过 SFTP `realpath` 验证，不能跳出该根目录。为避免危险的跨目录递归
删除，目录必须为空才能删除。文件上传默认单文件上限 32 MB，预览默认读取前 1 MB，
可通过 `fileManagerMaxUploadBytes` 和 `fileManagerMaxPreviewBytes` 调整。文件 RPC 使用
`commandAuthority` 作为 Console 权限门槛。

## ChatLuna 工具

插件会注册以下工具：

| 工具 | 用途 |
|---|---|
| `nexus_delegate` | 将复杂任务委托给远端 Code Agent |
| `nexus_publish` | 通过 SFTP 拉取并发布远端文件 |
| `nexus_list_agents` | 查看已探测到的 Code Agent |
| `nexus_list_skills` | 查看远端已同步的 Skills |

`nexus_delegate` 支持指定 Agent、远端工作目录、模型、超时和是否自动发布产物。
不指定 Agent 时会从当前可用 Agent 中自动选择；不指定 `publishFiles` 时默认发布产物并返回 Storage URL。

## Skills

在 **Skills** 页面填写 Git 仓库地址即可同步。仓库中应包含 `SKILL.md`。

远端默认目录：

```text
~/.agent-nexus/
  repos/                 # Git 仓库缓存
  skills/                # AgentNexus Skills 中心目录
```

同步完成后，AgentNexus 会将 Skill 软链接到已安装 Agent 的目录，例如：

```text
~/.claude/skills
~/.config/opencode/skills
~/.codex/skills
~/.hermes/skills
~/.openclaw/skills
```

## 文件回传与 Storage

`koishi-plugin-chatluna-storage-service` 是必需依赖。请安装并在 AgentNexus 之前启用：

```bash
npm install koishi-plugin-chatluna-storage-service
```

Agent 产物回传和文件管理下载会通过 SFTP 流式同步到 ChatLuna Storage，不受文件管理
上传上限影响。
直接命令调用会使用 Storage URL 发送 `h.image` 或 `h.file`；ChatLuna 工具调用则在工具结果中返回 URL。
没有产生文件时不会上传或发送文件，也不会显示内部的 `<nexus_files>` 标记。

## 非交互命令

AgentNexus 当前使用以下 CLI 方式：

```bash
hermes -z "..."                                      # 普通 one-shot delegate
hermes chat --quiet --yolo -q "..."                  # Nexus managed session 首轮
hermes chat --quiet --yolo --resume <id> -q "..."    # 后续恢复
openclaw agent --local --agent default --message "..." --json
claude -p "..." --output-format json --dangerously-skip-permissions
opencode run --format json --auto "..."
codex exec --json --ephemeral --dangerously-bypass-approvals-and-sandbox "..."
```

## 安全警告

AgentNexus 的定位是受信任远端机器上的自动化 Code Agent 网关。

Claude Code、OpenCode 和 Codex 默认使用跳过确认或沙箱限制的参数。远端 Agent
可能读取、修改和删除工作目录中的文件，也可能执行系统命令。请遵守以下原则：

- 只连接你信任的机器
- 使用权限受限的专用系统账号
- 不要将工作目录设置到包含敏感数据的位置
- 优先使用隔离虚拟机或容器
- 不要将 Koishi Console 暴露给不可信用户

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
```

构建产物：

```text
lib/     # Koishi 后端
dist/    # Koishi Console 前端
```

## License

MIT
