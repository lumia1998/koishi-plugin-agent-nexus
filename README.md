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
- 注册四个工具给 ChatLuna
- 从 Git 仓库同步 Skills，并软链接到各 Agent 的 Skills 目录
- 通过 SFTP 回传远端生成的文件和图片
- Koishi Console 单实例交互终端
- 支持远端工作目录和 Agent 自动路由

## 安装

在 Koishi 项目目录执行：

```bash
npm install koishi-plugin-agent-nexus
```

也可以通过 Koishi 插件市场搜索 `agent-nexus` 安装。

AgentNexus 需要 ChatLuna。Console 页面和交互终端还需要 Koishi 的
`console` 与 `server` 服务。

## 快速开始

1. 在 Koishi 配置中启用 `agent-nexus`。
2. 打开 Koishi Console 左侧的 **AgentNexus** 页面。
3. 在 **Computer** 页面填写远端 SSH 地址、端口、账号和密码。
4. 点击 **连接并扫描**。
5. 等待 Hermes、OpenClaw、Claude Code、OpenCode、Codex 状态标签亮起。
6. ChatLuna 随后可以调用 AgentNexus 工具委托远端 Agent 执行任务。

SSH 配置保存后，插件会自动维持默认连接，并每 30 秒检查一次断线状态。
进入 **终端** 页面时会自动创建一个 SSH 终端。

## SSH 凭据

密码支持直接填写，也支持环境变量引用：

```text
env:AGENT_NEXUS_SSH_PASSWORD
```

使用环境变量时，在 Koishi 进程环境中设置对应值：

```bash
AGENT_NEXUS_SSH_PASSWORD=your-password
```

Console 不会回传已保存的密码。编辑已有连接时密码留空，会继续使用原密码。

## ChatLuna 工具

插件会注册以下工具：

| 工具 | 用途 |
|---|---|
| `nexus_delegate` | 将复杂任务委托给远端 Code Agent |
| `nexus_publish` | 通过 SFTP 拉取并发布远端文件 |
| `nexus_list_agents` | 查看已探测到的 Code Agent |
| `nexus_list_skills` | 查看远端已同步的 Skills |

`nexus_delegate` 支持指定 Agent、远端工作目录、模型、超时和是否自动发布产物。
不指定 Agent 时会从当前可用 Agent 中自动选择。

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

`koishi-plugin-chatluna-storage-service` **不是必需依赖**。

未安装 Storage 时：

- SSH、Agent 扫描、Skills、委托执行和终端均可正常使用
- 小于 2 MiB 的文件会返回 `data:` URL
- 大于 2 MiB 的文件无法生成临时访问地址

如果需要稳定回传图片、文档、压缩包或大文件，建议安装：

```bash
npm install koishi-plugin-chatluna-storage-service
```

## 非交互命令

AgentNexus 当前使用以下 CLI 方式：

```bash
hermes chat -q "..."
openclaw agent --local --agent default --query "..."
claude -p "..." --output-format json --dangerously-skip-permissions
opencode run --format json --auto "..."
codex exec --dangerously-bypass-approvals-and-sandbox "..."
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
- 生产环境建议通过 `env:VAR` 保存 SSH 密码

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
