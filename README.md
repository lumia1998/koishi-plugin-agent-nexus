# koishi-plugin-agent-nexus

AgentNexus 是 [Nexus Gateway](https://github.com/lumia1998/nexus-gateway) 的 Koishi / ChatLuna
配套插件。Gateway 统一接入 ACP 与 A2A Agent；本插件自动发现这些 Agent，并为每个可用 Agent
注册独立的 ChatLuna 工具。

相关文档：

- [Nexus Gateway 仓库与安装部署文档](https://github.com/lumia1998/nexus-gateway)
- [Gateway 示例配置](https://github.com/lumia1998/nexus-gateway/blob/main/nexus-agentd.example.json)
- [npm 包页面](https://www.npmjs.com/package/koishi-plugin-agent-nexus)

## 功能边界

插件负责：

- 连接一个 Nexus Gateway，定时读取 `/v1/agents`。
- 按 Agent 自动注册 `nexus_<agent>` ChatLuna 工具。
- 创建、续接、查询和取消 Gateway Session。
- 默认把用户任务原样交给目标 Agent，并等待 Agent 返回结果。
- 用户当前消息中的图片、文件、音频和视频会在工具真正执行时读取并上传到 Gateway，再按 ACP/A2A
  协议传递给目标 Agent；不会把整段 ChatLuna 历史上下文作为调用前提。
- 会话上下文不是调用前提；显式使用后台模式时，如有 ChatLuna 会话上下文则在完成后唤醒原会话，
  没有上下文时可通过返回的任务 ID 查询。
- 注册 `nexus_file_publish` 工具，把 Agent 在 Session 工作区中生成的文件交给 Gateway 发布；有当前
  Koishi 会话时，插件按媒体类型发送原生元素：音频用 `h.audio`、视频用 `h.video`、图片用 `h.image`、
  其他文件用 `h.file`。模型回复中不会展示临时 URL。
- 在 Console 的“任务与调用记录”中查看委派任务状态、输入、输出、耗时和产物。
- 为单个 Agent 提供改名、停用、工作区、描述和技能标签覆盖。

插件不再负责：

- 直接连接 A2A Agent Card。
- 兼容 ACP Bridge 或选择 Gateway 后端。
- 管理多个 Gateway。
- 内置、安装或维护 Gateway 服务。
- SSH、远程终端、Agent 安装和 Skills 同步。

这些能力属于独立的 Nexus Gateway 或宿主机运维层。

## 安装

要求 Node.js 20 或更高版本，并已安装 ChatLuna。插件不依赖 ChatLuna Storage；文件发布仓库
由 Nexus Gateway 独立管理。

```bash
npm install koishi-plugin-agent-nexus@alpha
```

当前 0.2 单 Gateway 架构发布在 npm 的 alpha 标签。直接执行 npm install koishi-plugin-agent-nexus
会跟随 latest 标签；在 latest 尚未切换前，它可能安装旧的 0.1.x 架构。也可以固定到
npm install koishi-plugin-agent-nexus@0.2.0-alpha.4。

然后在 Koishi 插件设置中配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `gatewayUrl` | `http://127.0.0.1:8787` | Nexus Gateway 的数据面地址 |
| `gatewayKey` | 空 | Gateway“API 密钥”页面生成的 API Key |
| `commandAuthority` | `4` | Console 写操作所需权限等级 |
| `maxResponseBytes` | `33554432` | 单个 Gateway HTTP/SSE 响应读取上限 |
| `autoResumePending` | `true` | Agent 等待输入时，自动把原用户下一条消息继续到原任务 |
| `pendingRequireMention` | `false` | 群聊续接是否仍要求 @Bot；关闭后可直接回复“第一个/支付完成” |

`gatewayKey` 是数据面 API Key，不是 Gateway 控制台登录密码。

## 从零连接 Gateway

### 1. 先部署 Gateway

在 Gateway 所在机器上按
[Gateway 安装与部署文档](https://github.com/lumia1998/nexus-gateway#安装与部署)安装并启动：

~~~bash
git clone https://github.com/lumia1998/nexus-gateway.git
cd nexus-gateway
mkdir -p "$HOME/.config/agent-nexus" "$HOME/projects"
npm ci
npm run build
node dist/cli.js \
  --config "$HOME/.config/agent-nexus/nexus-agentd.json" \
  --host 0.0.0.0 \
  --port 8787 \
  --workspace "$HOME/projects"
~~~

首次启动后打开 http://<gateway-host>:8787/ui/，设置 Console Password，在 API Keys 页面创建
数据面 API Key，并在 Agents 页面确认目标 Agent 为 ready。Gateway 的部署、工作区 allowlist、
Artifact 仓库和 Agent CLI 准备都在 Gateway 侧完成。

如果目标版本已经发布到 npm，也可以按 Gateway README 的 npm 安装章节安装；请先确认
`npm view nexus-agentd version` 的 registry 版本与要部署的版本一致。

### 2. 安装并启用插件

在 Koishi 项目目录执行：

~~~bash
npm install koishi-plugin-agent-nexus@alpha
~~~

确保 ChatLuna 已启用；Console 页面还需要 Koishi 的 console 服务。

### 3. 填写连接配置

在 Koishi Console 的插件设置中填写：

~~~text
gatewayUrl = http://<gateway-host>:8787
gatewayKey = <Gateway API Keys 页面生成的 Key>
~~~

Gateway 和 Koishi 在同一台机器时使用 127.0.0.1；跨机器时使用 Gateway 的真实 IP 或域名，例如
http://10.1.2.40:8787。0.0.0.0 只表示服务端监听所有网卡，不能作为客户端地址。

## 图片与文件闭环

ChatLuna 需要把任务交给 `nexus_<agent>` 工具时，插件会从当前 Koishi 消息元素收集附件，并先调用
Gateway 的 Session 附件接口。Gateway 会在对应 Session 中临时保存附件：单个文件最多 16 MiB、单次
任务最多 32 MiB、最多 16 个文件。之后：

1. ACP Agent 优先收到其声明支持的图片/音频能力；不支持时由 Gateway 生成受限的临时资源链接。
2. A2A Agent 收到带文件名和媒体类型的二进制 Part。
3. Agent 返回的内联二进制产物由 Gateway 自动写入 Gateway 配置的 Artifact 发布仓库，插件只接收 URL。
4. Agent 报告了工作区文件路径时，ChatLuna 可调用 `nexus_file_publish`；Gateway 校验该路径必须
   位于对应 Session 的工作区内，再流式复制；插件按媒体类型通过 `h.audio`、`h.video`、`h.image` 或
   `h.file` 发送原生附件，不把下载 URL 放进用户回复。大文件始终走 Gateway URL，不会在插件中转成 Base64。

附件只跟随当前任务发送，不会拼接成历史对话；Session 空闲释放时 Gateway 同时清理临时附件。
发布链接使用不可猜测 token，默认 24 小时失效。工作区本身从不作为静态目录公开，因此几十 MiB
工作区文件发布使用流式复制，不经过 Base64/JSON；也不需要额外部署 FileBrowser 或 SFTP。若调用
来自没有 Koishi 会话的后台环境，插件仍会保留 Gateway 产物记录，Console 可查看附件入口。插件发出的
产物元素会带内部回流标记，后续续接不会把机器人刚发送的音频、视频或文件再次当成用户附件；平台若只
回传不可读取的裸文件名，也会被忽略而不会让续接任务失败。

后台任务完成后的唤醒逻辑参考 ChatLuna 的 `agentTaskAutoWakeup`：插件通过已有会话重新注入任务结果，
再由 ChatLuna 生成面向用户的回复；`toolCallReplyNextReply` 属于 Character 的短期触发条件，不用于定位
AgentNexus 任务。等待中的任务若续接失败，会立即结束为失败状态并放行当前消息，避免普通文本或其他 Koishi
命令被旧任务持续拦截。

## 局域网配置

如果 Gateway 在 `10.1.2.40`，Koishi 插件中应填写：

```text
gatewayUrl = http://10.1.2.40:8787
gatewayKey = <Gateway 中生成的 API Key>
```

`0.0.0.0` 只用于 Gateway 服务端监听所有网卡，不能作为客户端访问地址。局域网中的 Koishi
应使用 Gateway 机器的真实 IP 或域名。还要确认 Gateway 监听 `0.0.0.0`，并在防火墙中只放行
可信局域网来源。

## OpenCode、Claude Code 和 Hermes

插件不拼接这些 Agent 的命令，也不负责安装或登录；命令由 Gateway driver 决定：

| Agent | Gateway 默认入口 | 宿主机需要准备 |
| --- | --- | --- |
| OpenCode | opencode acp | 安装 OpenCode CLI，并在运行 Gateway 的用户环境中完成登录。 |
| Claude Code（CC） | claude-agent-acp | 安装 @agentclientprotocol/claude-agent-acp，并准备 Claude Code 登录环境。 |
| Hermes | hermes acp | 安装 Hermes CLI，并在运行 Gateway 的用户环境中完成登录。 |

如果 Agent 在 Gateway WebUI 中显示 unavailable，先在同一个系统用户下检查：

~~~bash
command -v opencode && opencode --version
command -v claude-agent-acp && claude-agent-acp --version
command -v hermes && hermes acp --check
~~~

这些命令在交互式 Shell 可用、但 systemd 中不可用时，检查 systemd unit 的 PATH、HOME、
XDG_CONFIG_HOME 和登录凭据。具体安装和高级 command、args、env 配置请以
[Gateway Agent 准备章节](https://github.com/lumia1998/nexus-gateway#opencodeclaude-code-和-hermes-的宿主机准备)为准。

## A2A Agent

A2A Agent Card 在 Nexus Gateway 的 Agent 管理页配置。配置并健康检查成功后，Gateway 会在
`/v1/agents` 中返回该 Agent，插件会像处理 ACP Agent 一样自动创建 ChatLuna 工具。Koishi
插件中不需要再次填写 Agent Card URL、Bearer Token 或传输协议。

## Agent 覆盖项

Console 的“Agent 中枢”页面默认展示 Gateway 返回的全部 Agent。无需手工创建路由；只有以下
情况才需要保存覆盖项：

- 修改 ChatLuna 工具显示名称。
- 暂停发布某个 Agent。
- 为调用覆盖默认工作区。
- 补充工具描述或技能标签。

删除覆盖项后会立即恢复 Gateway 自动配置。

## ChatLuna 调用方式

每个 Agent 都会得到独立工具，例如 `nexus_hermes`、`nexus_claude` 或 `nexus_opencode`。
`action=run` 默认以前台方式运行：插件不改写 `prompt`，并持续等待 Gateway 中的 Agent 完成、失败、
请求输入或请求授权。只有明确设置 `background=true` 时才立即返回任务 ID。`action=status`、
`action=message` 和 `action=stop` 可凭任务 ID 工作，即使当前工具调用没有 ChatLuna 会话上下文。
`nexus_file_publish` 可接受该任务 ID 和 Agent 返回的原始路径；有当前会话上下文时也可省略 ID，
自动使用当前对话最近的 Gateway 任务。成功发布后，工具会直接发送文件附件；不要把 Gateway 临时
URL复制到用户回复中。

### 多轮确认与支付

当 Gateway Session 进入 `input_required` 或 `permission_required`，插件会记录等待中的 Job，并按
原始 `platform + selfId + userId + guildId + channelId + conversationId` 严格匹配后续消息，继续发送
到同一个 Gateway Session。用户不需要再次说“调用 Hermes”：

~~~text
用户：@bot 帮我调用 Hermes 下单麦当劳套餐
Bot：请选择套餐……
用户：第一个
Bot：请选择堂食还是外带……
用户：堂食
Bot：请输入取餐时间……
用户：12点
Bot：支付链接……支付后回复“支付完成”
用户：支付完成
Bot：支付成功，订单已确认
~~~

群聊默认允许原用户直接回复；将 `pendingRequireMention` 设为 `true` 后，后续消息需要写成
`@bot 第一个`，但仍不需要重复写“调用 Hermes”。支付类 MCP 必须在收到“支付完成”后通过订单号或
支付号查询真实支付状态，并使用幂等键防止重复下单；用户文字本身不能作为支付凭证。若 Agent 只在
普通文本中说“请回复支付完成”，没有让 Gateway 进入 `input_required`，插件不会自动劫持下一条消息，
需要让 Hermes/MCP 使用 ACP elicitation 或 A2A `input_required`。

Gateway 会在每个 Agent 的首次请求前自动注入 Agent Nexus 交互规范，提醒 OpenCode、Claude Code、Hermes
等 Agent 在需要用户确认时使用协议级输入机制。若某个 Agent 需要额外业务规则，可在 Gateway 的 Agent
管理页配置 `instructions`；这不需要在每个 Koishi 对话中重复说明。

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
```

## License

[MIT](./LICENSE)
