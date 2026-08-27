# koishi-plugin-agent-nexus

AgentNexus 是 [Nexus Gateway](https://github.com/lumia1998/nexus-gateway) 的 Koishi / ChatLuna
配套插件。Gateway 统一接入 ACP 与 A2A Agent；本插件自动发现这些 Agent，并为每个可用 Agent
注册独立的 ChatLuna 工具。

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
- 转存 Gateway 返回的二进制产物为 ChatLuna 临时文件。
- 为单个 Agent 提供改名、停用、工作区、描述和技能标签覆盖。

插件不再负责：

- 直接连接 A2A Agent Card。
- 兼容 ACP Bridge 或选择 Gateway 后端。
- 管理多个 Gateway。
- 内置、安装或维护 Gateway 服务。
- SSH、远程终端、文件管理、Agent 安装和 Skills 同步。

这些能力属于独立的 Nexus Gateway 或宿主机运维层。

## 安装

要求 Node.js 20 或更高版本，并已安装 ChatLuna 与
`koishi-plugin-chatluna-storage-service`。

```bash
npm install koishi-plugin-agent-nexus
```

然后在 Koishi 插件设置中配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `gatewayUrl` | `http://127.0.0.1:8787` | Nexus Gateway 的数据面地址 |
| `gatewayKey` | 空 | Gateway“API 密钥”页面生成的 API Key |
| `commandAuthority` | `4` | Console 写操作所需权限等级 |
| `maxResponseBytes` | `33554432` | 单个 Gateway HTTP/SSE 响应读取上限 |

`gatewayKey` 是数据面 API Key，不是 Gateway 控制台登录密码。

### 图片与文件闭环

ChatLuna 需要把任务交给 `nexus_<agent>` 工具时，插件会从当前 Koishi 消息元素收集附件，并先调用
Gateway 的 Session 附件接口。Gateway 会在对应 Session 中临时保存附件：单个文件最多 16 MiB、单次
任务最多 32 MiB、最多 16 个文件。之后：

1. ACP Agent 优先收到其声明支持的图片/音频能力；不支持时由 Gateway 生成受限的临时资源链接。
2. A2A Agent 收到带文件名和媒体类型的二进制 Part。
3. Agent 返回的图片、音频、视频和文件由插件转成 ChatLuna 可发送的临时文件元素。

附件只跟随当前任务发送，不会拼接成历史对话；Session 空闲释放时 Gateway 同时清理临时附件。

## 局域网配置

如果 Gateway 在 `10.1.2.40`，Koishi 插件中应填写：

```text
gatewayUrl = http://10.1.2.40:8787
gatewayKey = <Gateway 中生成的 API Key>
```

`0.0.0.0` 只用于 Gateway 服务端监听所有网卡，不能作为客户端访问地址。局域网中的 Koishi
应使用 Gateway 机器的真实 IP 或域名。还要确认 Gateway 监听 `0.0.0.0`，并在防火墙中只放行
可信局域网来源。

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
