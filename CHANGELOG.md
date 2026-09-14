# 更新日志

本文件记录 AgentNexus 面向使用者的重要变更。

## [0.4.0] - 2026-09-14

- 控制台「Agent 中枢」重构为标签页：概览、智能体、任务、产物、设置，并新增单个 Agent 的覆盖项编辑对话框。
- 新增产物本地缓存：控制台下载与预览改由插件从本地磁盘直读，不再每次回源 Gateway。缓存目录为
  Koishi 数据目录下的 `data/agent-nexus/artifacts`，磁盘路径按运行平台推导，控制台显示为相对路径。
- 新增产物缓存清理策略（`artifactCache`）：`ttlHours` 按最后访问时间控制保留时长，`maxTotalBytes`
  控制目录总容量，超出后按最久未访问优先淘汰；启动时与每小时各清理一次，控制台设置页可查看状态并手动清空。
- 产物下载改为流式落盘：响应体不再整体读入内存，单文件上限由磁盘预算而非单响应字节数决定，因此大于
  `maxResponseBytes` 的产物也能在控制台下载与预览。响应支持 Range 请求，音视频预览可以拖动进度。
- 修复产物票据验签比较对象错误：签名返回「过期时间.签名」整串，验签却只比对签名段，长度恒不相等，
  导致所有控制台下载与预览都返回 403。现在比较整串，并保留过期校验与重放防护。
- 修复产物下载失败无限重试：此前下载超时、超过单次读取上限或 Gateway 持续 5xx 都会被当作可重试，
  每 2 秒重来一次直到 24 小时的活跃 TTL 到期，期间任务一直停在「执行中」且前台工具调用被挂住。
  现在尺寸超限与 4xx（429 除外）直接降级为仅元数据，暂时性错误最多尝试 3 次后放弃，任务随即进入终态。
- 产物尺寸在持久化 run view 中已知时先做预检，明知超限的产物不再触发任何下载。
- 产物无法获取时在控制台显示具体原因（曾经只显示「仅记录」）；控制台预览失败不再被误报为
  「该类型不支持在线预览」，而是显示真实错误。
- 修复前端类型检查：`client/shared.ts` 从 `../src` 引入类型与 `client/tsconfig.json` 的 `rootDir` 冲突，
  该检查在 CI 中失败。
- 移除测试套件与相关开发脚手架：删除 `test/`、`playwright.config.ts`、`scripts/test.cjs` 与
  `scripts/gateway-compat-smoke.cjs`，`npm test`、`npm run test:webui`、`npm run test:gateway`
  不再可用，CI 也不再运行测试，仅保留类型检查与构建。

## [0.3.3] - 2026-09-11

- 适配 Nexus Gateway 0.3 / 0.4 数据面：识别 SSE `reset` 缺口通知，保留 HTTP 状态、配额及重试等待信息；长期 SSE 按事件帧限额，不再按连接累计字节数中断。
- 增加使用原 API Key 的持久化产物下载；请求仅发往配置的 Gateway，拒绝重定向并限制下载大小。
- 任务监控在 SSE 缺口后采用快照游标恢复，允许超前游标回退并跳过重复事件；鉴权失效停止监控，限流按等待时间重试读取，不重放任务写入。
- 产物暂时下载失败时保留已接受任务并重试下载，恢复后再回传；取消后显式关闭保留的 Session，释放 Gateway 的会话额度。
- 验证 Nexus Gateway 0.4.x 兼容：Run 产物按 `maxArtifactsPerRun` 只保留最新 32 条，被清理的产物返回
  404，插件保留其元数据并继续回传其余产物，不重放原任务；产物 MIME 类型扩展后，图片、音视频与源码
  文件能正确映射为 Koishi 消息元素，不再全部落到通用文件。
- 增加 `npm run test:gateway`，用临时 Gateway 与真实测试 ACP 进程验证完成证明、配额、SSE 重置、
  持久化下载、产物清理和 Key 撤销。
- `nexus_<agent>` 工具不再强制要求 ChatLuna 会话上下文；默认原样传递用户任务并前台等待
  Agent 结果，显式 `background=true` 才切换为后台任务。
- 修复 ChatLuna Agent 模式嵌套上下文字段识别；有上下文的后台任务仍会回推，无上下文时可凭
  Job ID 查询、续接或取消。
- 同一 Job 的续接消息按顺序执行，避免并发覆盖远端 Session 状态。
- 修复插件停止时不等待已触发的唤醒与队列续接任务的问题：定时器一旦触发就脱离跟踪，`clearTimeout`
  无法取消，任务仍会在停止后写入 Job 存储。现在这些任务统一登记并在停止时排空，避免存储被拆除时
  写入失败或状态丢失。

## [0.3.2-alpha.6] - 2026-09-10

- 适配 Nexus Gateway 0.3.0：SSE 缺口快照恢复、单帧大小限制、结构化配额错误和重试等待。
- 支持通过原 API Key 下载持久化产物；暂时下载失败会重试，不重复提交原任务。
- 鉴权失效会停止任务监控；取消任务后显式关闭 Gateway Session。
- 增加真实 Gateway 兼容性冒烟测试，覆盖完成证明、429、SSE reset、持久化下载和 Key 撤销。

## [0.3.2-alpha.3] - 2026-08-31

- 修复已包含文件产物的后台回传仍将 `file_url`、图片和音视频 URL 注入 ChatLuna 模型上下文的问题。产物现在只由 Koishi 以原生附件投递，模型只接收文件说明并明确不会再为查找、下载或发布文件启动额外 Gateway 任务。

## [0.3.2-alpha.2] - 2026-08-31

- 修复后台任务在待授权/待输入后续接时被错误切换为前台任务的问题；续接现在继承原任务的后台模式并保持同一 Gateway Session。
- 修复后台任务同步完成时被提前标记为已通知的问题。
- 后台完成结果的图片、音频、视频和普通文件现在由 Koishi 以原生媒体元素主动发送，不再要求模型复述下载链接。
- 媒体发送失败时只重试未发送的产物，不重复发送完成文本；授权唤醒也会要求先询问用户，不再替用户擅自授权。

## [0.3.2-alpha.1] - 2026-08-31

- 修复主动回传调用 ChatLuna 会话服务时丢失方法接收者的问题。此前后台任务进入待授权、待输入、
  完成或失败状态后，会在查询原会话时抛错并持续重试，表现为 Gateway 一直等待而 Koishi 不主动询问。
- 新增真实依赖 `this` 的会话服务回归测试，覆盖“查询原会话 → 排入当前轮次或主动唤醒”的调用边界。

## [0.3.1] - 2026-08-30

- 恢复 Koishi Console 委派任务进程面板，每 3 秒自动刷新，并显示原始任务、实时状态、输出、
  待授权/输入、产物、主动回传与重试状态。
- 明确展示 Koishi Job ID、Gateway Run ID、Gateway Session ID 与协议 Session ID 的对应关系，
  ChatLuna 工具输出也会携带这些 ID，避免把本地 Job 误认为 Gateway 没有记录。

## [0.3.0] - 2026-08-30

- 要求 Nexus Gateway 0.2.0+ 返回与当前 Run 绑定的完成证明；缺失、过期或协议不匹配的
  `completed` 会收敛为失败。
- 完成结果必须没有待处理的授权/输入请求，并至少包含最终文本或一个 Artifact，避免远端过早结束后
  被当作成功主动回传。
- 保留 ChatLuna pending message 主动唤醒、同一 Gateway Session 续聊以及清空/删除会话时显式释放。

## [0.2.2] - 2026-08-30

- 对齐 ChatLuna 的后台唤醒流程：插件会复用在线会话；原会话处于 `plugin` 轮次时先排入
  pending message，避免主动回传与当前轮次并发导致结果丢失。
- 原始 ChatLuna 会话已经被删除时跳过无效回传，避免后台任务持续重试。

## [0.2.1] - 2026-08-29

- 发布 0.2 单 Gateway 架构：Koishi 只连接独立的 Nexus Gateway，由 Gateway 统一承载 ACP 与
  A2A Agent。
- 删除直接 A2A Client、Agent Card/协议调试、多 Gateway、ACP Bridge 回退、内置
  `nexus-agentd` workspace 及 `@a2a-js/sdk` 依赖。
- 插件设置收敛为 `gatewayUrl`、`gatewayKey`、`commandAuthority` 与 `maxResponseBytes`；API Key
  不再写入插件数据文件或 Console 响应。
- 修正 Gateway wire types：Agent 支持 `protocol: acp | a2a`、`driver`、`checkedAt`、
  `responseMs`，Session 支持 `protocolSessionId`，SSE 支持 `artifact` 事件。
- Console 重做为全中文单 Gateway 视图，只展示连接状态、Agent inventory、ChatLuna 工具和
  可选的 Agent 覆盖项。
- 保留 Gateway Session 续聊、状态查询、取消、后台唤醒和二进制产物转存。
- 旧配置仅迁移 Gateway Agent 覆盖项；直接 A2A 路由与旧 A2A Job 不再加载。

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
