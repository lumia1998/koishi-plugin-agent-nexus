# 更新日志

本文件记录 AgentNexus 面向使用者的重要变更。

## [0.1.33] - 2026-08-14

### 新功能

- Computer 页新增 Linux/systemd **部署 ACP 网关**：通过 SSH install-only 安装 `nexus-agentd` 和缺失 Adapter，自动生成 Token、配置与 systemd 服务。
- 部署成功后自动注册显式绑定 SSH 设备的托管 Gateway，并可为 OpenCode、Claude Code、Codex、Pi、OpenClaw 创建逻辑委托 Agent。

### 改进

- 自动部署的 Token 只写入远端 `0600` 环境文件和 Koishi 服务端配置，不进入 SSH 命令、systemd unit 或 Console 返回值。
- 未配置 SSH 工作目录时创建并使用 `~/projects`，避免默认把整个 HOME 加入 workspace allowlist。
- A2A / ACP 页使用 Gateway discovery 结果选择 Agent ID，并为托管 Gateway 自动带出 workspace 根；托管 URL 和 Token 统一回到 Computer 页管理。
- agentd 部署不查询版本或执行更新；已存在的 daemon/Adapter 直接复用，只补装缺失组件并重新生成配置。
- 托管 Gateway 持久保存所选 Agent；重新配置时自动清理取消选择的自动路由，并修正超出新 allowlist 的 workspace。
- systemd 服务继承远端用户的 Shell、locale 和稳定 XDG 路径；启动/健康检查失败时自动附带服务状态与 journal 诊断。
- 删除 SSH 设备会将关联 Gateway 和自动路由解除托管并保留，修改 SSH 地址会同步更新托管 Gateway URL。
- 页面启动时自动发现已启用的 A2A/Gateway，顶部“刷新并重扫”同时刷新 SSH Agent 与协议远端状态。
- ACP Gateway 部署改为后台任务，Console 持续显示当前阶段、进度和耗时；失败时展示根因与远端 systemd 诊断，不再只显示长堆栈或无信息转圈。
- 缺失的 npm 包合并为一次安装；遇到 `ENOSPC` 时仅清理经过路径校验的 npm 缓存并自动重试，SFTP 写入和网络下载均有单步超时。

### 修复

- 修复 systemd 权限探测 Shell 缺少换行、unit 绝对路径被写成字面量引号、健康检查脚本缺少语句分隔以及服务启动后的端口竞态。

## [0.1.32] - 2026-08-14

### 新功能

- 新增协议无关 Delegation Core 和通用 schema v2 Job；AgentNexus Job ID 保持稳定，A2A Task/Context 与 Gateway/ACP Session ID 只保存在 `providerState`。
- 新增 Nexus Gateway Provider、HTTP/SSE Client 和独立 ESM package `nexus-agentd`，完成 `AgentNexus -> Gateway -> ACP` 链路。
- Console 的 **A2A / ACP** 页新增逻辑 Agent 与 Nexus Gateway 配置；每个 Agent 可独立选择 A2A 或 Gateway+ACP、远端、Gateway Agent ID 和 workspace。
- `nexus-agentd` 新增 Bearer Token、Agent discovery、Session/message/cancel/events API、SSE 事件重放、权限请求和 elicitation 交互。
- ACP Driver 扩展为 OpenCode、Claude Code、Codex、Pi 和 OpenClaw；Hermes 明确保留原生 A2A 路由。

### 改进

- AgentNexus 固定为 A2A Client，移除内置 A2A Bridge/Server、Bridge CLI、SSH 部署与维护入口。
- ChatLuna 工具收敛为 `nexus_a2a_delegate`；移除 SSH 自动委托、发布、列表及协议级 A2A 调试工具，避免模型误走 SSH 链路。
- 移除 `nexus.hermes`、`nexus.claudecode` 等 SSH 直调命令，以及其托管 Session Runtime、交互绑定、历史摘要和自动产物发布链路。
- A2A 委托移除仅供旧 Bridge 使用的 Agent 类型 hint，按远端 Agent Card/Skill 选择并直接转交用户任务。
- Code Agent 管理改为安装-only：移除版本检测、联网最新版查询和所有更新命令；已安装 Agent 只报告存在状态。
- 现有 A2A Client、Agent Card、Task/Context、SSE、后台轮询与 ChatLuna wakeup 由 A2A Provider 原样复用；未配置显式逻辑路由的旧 A2A Remote 继续可用。
- 根仓库改为 npm workspace，统一执行插件和 agentd 的测试、类型检查与构建；agentd 与 ACP SDK 共用 Zod 3.25，避免重复安装 Zod 4。

### 兼容与安全

- 首次升级会把 `a2a-tasks.json` 导入 `delegation-jobs.json`，原旧文件保持不变；损坏迁移源不会静默生成空 Store。
- A2A Remote、Gateway Remote 与 SSH Computer 保持独立，不根据主机或端口建立隐式绑定。
- agentd 默认只监听 localhost；客户端请求严格限制为 `agentId`、`workspace` 和消息，不能传 command/argv。
- workspace 和允许根执行 `realpath` 校验，拒绝 traversal、外部路径和符号链接逃逸。
- ACP 权限策略默认 `ask`，也可配置 `deny`，不存在静默自动批准；Gateway Token 在 Console 返回时脱敏并支持 `env:VAR`。

### 修复

- 逻辑 Agent 从 A2A 切换到 ACP 或修改 Gateway Agent/workspace 后，新 Job 不再继承不兼容的协议状态；已有 Job 继续保持创建时的 provider 身份。
- Gateway 权限和输入请求会把问题及选项带回 ChatLuna，不再只显示空的等待状态。
- 修复 agentd 取消与迟到 prompt 结果的竞态，避免 canceled Session 被覆盖为 completed；异步 prompt 启动失败也会稳定进入 failed。

## [0.1.32-alpha.5] - 2026-08-13

### 发布

- 发布当前 A2A Client、ChatLuna 委托与依赖精简实现，供 Koishi 测试环境联调。

## [0.1.32-alpha.4] - 2026-08-13

### 改进

- 将已打包进 Console `dist` 的 Element Plus、图标、Xterm 与 Koishi Client 移至开发依赖，避免市场安装重复计算整套前端构建工具链。
- LangChain Core 与 Zod 改为从强依赖的 ChatLuna 包目录加载，复用 ChatLuna 的运行时版本，不再作为 AgentNexus 的生产或 peer 依赖安装。

## [0.1.32-alpha.2] - 2026-08-11

### 修复

- 修复 Vite 6 将 Console 样式产物从 `dist/style.css` 改名为 `dist/index.css` 后，Koishi 无法加载插件 CSS，导致 WebUI 退化为原生 HTML 样式、页面贴边和表单错位的问题。

## [0.1.32-alpha.1] - 2026-08-11

### 新功能

- 新增 ChatLuna 高层工具 `nexus_a2a_delegate`，默认在后台委托 A2A Agent，并在完成、失败或等待输入时自动唤醒原 ChatLuna 会话。
- 自动维护 AgentNexus job、A2A Task、A2A Context 与 Hermes/Pi provider session 的映射。ChatLuna 日常调用不再需要手动管理协议 ID。
- Bridge 增加持久化 Task Store；重启后可继续查询已有任务，运行中任务会转为可安全续接的 `input-required` 状态。
- 支持按 Agent Card Skill 选择远端、自动刷新未知 Card、沿用当前会话最近远端，以及通过 `newTask` 显式创建新上下文。

### 改进

- A2A managed session 改为按 Context 绑定，使多个 A2A Task 可以延续同一个 Hermes/Pi 会话。
- `nexus_a2a_list`、`nexus_a2a_send`、`nexus_a2a_task` 默认作为协议调试工具关闭；WebUI 手动 Task/Context 操作也明确标记为协议调试。
- 后台任务增加运行代际保护，避免旧轮询覆盖新的续接结果；切换 Agent 时会清理不兼容的旧 Context。
- Agent 探测改进 login/interactive shell 环境识别，并优先使用已探测到的绝对可执行文件路径。
- Bridge、Session 与配置文件使用原子写入，损坏文件会保留备份，降低异常退出导致的状态丢失风险。
- 增加 Node.js 20 CI、发布包构建检查和高危依赖审计。

### 安全修复

- SSH 主机密钥支持 SHA-256 TOFU 与严格固定校验；已固定主机的指纹变化会拒绝连接。
- 加固 Skill 仓库、Git ref、远端路径、模型参数和产物路径校验，阻止参数注入、目录逃逸及覆盖真实 Skill 目录。
- 为 SSH 输出、终端消息、A2A HTTP/SSE 响应、Bridge 请求、任务并发、任务记录和产物大小增加边界限制，降低资源耗尽风险。
- 更新并固定多项传递依赖版本；当前高危和严重级别 NPM 审计结果为 0。

### 修复

- 无效的补充输入不再把等待中的 A2A Task 直接标记失败。
- Bridge 重启不再让已中断任务错误地保持运行状态。
- 修复超时后迟到的 SSH channel、SFTP 初始化竞争、stdout/stderr 配额互相挤占等资源清理问题。
- 修复 Agent 更新版本验证、终端依赖兼容和若干 A2A 结果归一化问题。

### 已知限制

- 这是 `alpha` 预发布版本；自动会话绑定与 Bridge 恢复已通过自动化测试，但仍需在真实 Koishi + ChatLuna + 远端 Bridge 环境完成端到端联调。

[0.1.33]: https://github.com/lumia1998/koishi-plugin-agent-nexus/compare/v0.1.32...v0.1.33
[0.1.32]: https://github.com/lumia1998/koishi-plugin-agent-nexus/compare/v0.1.32-alpha.5...v0.1.32
[0.1.32-alpha.1]: https://github.com/lumia1998/koishi-plugin-agent-nexus/compare/v0.1.32-alpha.0...v0.1.32-alpha.1
[0.1.32-alpha.2]: https://github.com/lumia1998/koishi-plugin-agent-nexus/compare/v0.1.32-alpha.1...v0.1.32-alpha.2
[0.1.32-alpha.4]: https://github.com/lumia1998/koishi-plugin-agent-nexus/compare/v0.1.32-alpha.3...v0.1.32-alpha.4
[0.1.32-alpha.5]: https://github.com/lumia1998/koishi-plugin-agent-nexus/compare/v0.1.32-alpha.4...v0.1.32-alpha.5
