# AgentNexus 项目说明

## 定位

本仓库只实现 Koishi / ChatLuna 适配层。独立的
[Nexus Gateway](https://github.com/lumia1998/nexus-gateway) 是唯一 Agent 数据面，负责 ACP、A2A、
Agent Card、驱动、认证、Session 与 SSE。

```text
ChatLuna
   │ 每 Agent 独立工具
   ▼
koishi-plugin-agent-nexus
   │ Bearer API Key / HTTP + SSE
   ▼
Nexus Gateway
   ├─ ACP Agent
   └─ A2A Agent Card
```

插件不会旁路 Gateway 直接调用任何 Agent，也不承载 Gateway 管理控制面。

## 运行时模块

```text
src/config.ts                 Koishi 连接设置与旧配置迁移
src/gateway/client.ts         Gateway JSON/SSE 客户端
src/gateway/types.ts          Gateway 数据面 wire types
src/providers/gateway.ts      Inventory → ChatLuna Agent、Session 映射
src/delegation/manager.ts     任务生命周期、续聊、轮询与取消
src/delegation/store.ts       Gateway 任务持久化
src/delegation/wakeup.ts      后台任务完成后唤醒 ChatLuna
src/tools/delegate.ts         每 Agent 独立 ChatLuna Tool
src/service.ts                Koishi Service、工具同步与产物转存
src/webui/index.ts            最小 Console RPC
client/components/gateway-panel.vue  单 Gateway 中文控制台
```

## 配置模型

连接信息只存在于 Koishi 插件设置：

```ts
interface Config {
    gatewayUrl: string
    gatewayKey: string
    commandAuthority: number
    maxResponseBytes: number
}
```

`data/agent-nexus/config.json` 只保存 Agent 覆盖项，不保存 Gateway URL、API Key、后端类型或远端
列表：

```ts
interface NexusConfig {
    delegation: {
        agents: Array<{
            agentId: string
            name: string
            enabled: boolean
            workspace?: string
            description?: string
            skills?: string[]
        }>
    }
}
```

升级时会保留旧配置中的 Gateway Agent 覆盖项，移除直接 A2A 路由、多 Gateway、ACP Bridge、SSH
和托管字段。旧 A2A 任务不会进入新的单 Gateway 任务存储。

## Gateway 契约

插件只依赖 Bearer API Key 数据面：

```text
GET  /v1/agents
POST /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
GET  /v1/sessions/:id/events
```

Agent inventory 必须保留 `protocol: "acp" | "a2a"`；Session 必须保留 `protocol`、
`protocolSessionId`、`artifacts` 与 pending request。插件不对 404/405 做旧后端回退。

## Agent 与工具映射

- Gateway inventory 是 Agent 的事实来源。
- `enabled !== false && ready === true` 的 Agent 默认发布工具。
- 覆盖项按 `agentId` 合并，不创建第二条路由。
- 工具名称由 `buildDelegationToolNames()` 稳定生成并解决重名。
- Job 保存 Gateway Session ID，从而支持续聊、状态查询、取消和后台通知。
- 前台调用不依赖 ChatLuna 会话上下文，默认等待 Agent 返回；用户任务在校验非空后保持原文传输。
- 后台通知只在存在可用的 ChatLuna 会话与路由信息时启用；无上下文后台任务通过不透明 Job ID 查询。

## 安全边界

- `gatewayKey` 使用 Koishi secret 字段，不写入 `data/agent-nexus/config.json` 或 Console 响应。
- Gateway URL 仅允许 HTTP/HTTPS，拒绝 URL 凭据与 fragment。
- Gateway 负责 API Key scope 与 Session 所有权校验。
- 二进制产物有 32 MiB 转存上限，并校验 base64 后写入 ChatLuna 临时文件。
- 局域网部署时，`0.0.0.0` 只作为 Gateway 监听地址；插件连接真实 IP/域名。

## 发布门槛

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
```

当前包不含 workspace，也不打包或发布 Gateway。
