# 更新日志

本文件记录 AgentNexus 面向使用者的重要变更。

## 未发布

### 改进

- AgentNexus 固定为 A2A Client，移除内置 A2A Bridge/Server、Bridge CLI、SSH 部署与维护入口。
- ChatLuna 工具收敛为 `nexus_a2a_delegate`；移除 SSH 自动委托、发布、列表及协议级 A2A 调试工具，避免模型误走 SSH 链路。
- 移除 `nexus.hermes`、`nexus.claudecode` 等 SSH 直调命令，以及其托管 Session Runtime、交互绑定、历史摘要和自动产物发布链路。
- A2A 委托移除仅供旧 Bridge 使用的 Agent 类型 hint，按远端 Agent Card/Skill 选择并直接转交用户任务。
- Code Agent 管理改为安装-only：移除版本检测、联网最新版查询和所有更新命令；已安装 Agent 只报告存在状态。

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

[0.1.32-alpha.1]: https://github.com/lumia1998/koishi-plugin-AgentNexus/compare/v0.1.32-alpha.0...v0.1.32-alpha.1
[0.1.32-alpha.2]: https://github.com/lumia1998/koishi-plugin-AgentNexus/compare/v0.1.32-alpha.1...v0.1.32-alpha.2
[0.1.32-alpha.4]: https://github.com/lumia1998/koishi-plugin-AgentNexus/compare/v0.1.32-alpha.3...v0.1.32-alpha.4
[0.1.32-alpha.5]: https://github.com/lumia1998/koishi-plugin-AgentNexus/compare/v0.1.32-alpha.4...v0.1.32-alpha.5
