# AgentNexus 项目计划与实现记录

> 仓库：`https://github.com/lumia1998/koishi-plugin-AgentNexus`
> 参考实现：`ChatLunaLab/chatluna` → `packages/extension-agent`（v1-dev）Computer 模块
> 日期：2026-07-13

---

## 1. 项目目标

做一个类似 ChatLuna Agent **Computer** 的后端能力，但核心不是本地/e2b 沙箱，而是：

1. **底层用 SSH** 连接远端机器（支持密码 / 密钥登录）
2. **探测远端已安装的 Code Agent**：
   - Hermes
   - OpenClaw
   - Claude Code
   - OpenCode
   - Codex
3. 在 Koishi 侧边栏 WebUI 中选择/管理这些 agent
4. **Skills 同步**：给仓库地址后自动拉取，落到 AgentNexus 中心目录，并软链接到各 code agent 的 skill 路径
5. **注册工具给 ChatLuna**：把复杂任务、爬虫 skill 等委托给远端 code agent 非交互执行
6. 解析 agent 输出中的文件/图片路径，通过 **SFTP + publish** 回传给 ChatLuna

---

## 2. 参考设计：ChatLuna Computer

已 clone 并分析：

```
chatluna/packages/extension-agent/src/computer/
```

关键启发：

| 点 | ChatLuna Computer | AgentNexus 对应 |
|---|---|---|
| Backend 抽象 | local / e2b / open-terminal | **SSH only** |
| Session 复用 | conversation/user key + idle 回收 | SSH 连接池 + idle |
| Tools | file_read/write/edit、bash、grep… | **nexus_delegate / publish / list_*** |
| 终端 | xterm + WebSocket PTY | 同样做（SSH shell） |
| Skills | materialize 到 sandbox | 中心仓 + symlink 到各 agent |
| 产物发布 | file_publish + storage | SFTP + chatluna_storage |

结论：AgentNexus **不完整复刻 computer**，定位是：

> **SSH 上的 Code Agent 网关 + Skill 分发 + 产物回传 + 终端调试**

---

## 3. 各 Code Agent 非交互 CLI（调研结果）

| Agent | 非交互命令 | 备注 |
|---|---|---|
| **Hermes** | `hermes chat -Q -q "..."` | 静默 stdout 文本 |
| **OpenClaw** | `openclaw agent --local --agent default --query "..."` | 用户确认命令 |
| **Claude Code** | `claude -p "..." --output-format json` | 可加 skip-permissions（需显式开关） |
| **OpenCode** | `opencode run --format json --auto "..."` | `--auto` 可配置 |
| **Codex** | `codex exec "..."` | 可加 bypass sandbox（需显式开关） |

统一执行原则：

```
SSH exec → 收 stdout/stderr → 解析文本/JSON → 抽文件路径 → SFTP 拉回 publish
```

为提高路径识别率，delegate 时会自动在 prompt 末尾追加：

```text
<nexus_files>
/abs/path/to/file
</nexus_files>
```

---

## 4. 总体架构

```
ChatLuna (主对话)
    │  tool call
    ▼
AgentNexus (Koishi 插件)
    ├── WebUI（侧边栏）
    │     · SSH 主机配置（密码/密钥）
    │     · 探测/勾选 code agent
    │     · Skill 仓库导入与同步状态
    │     · 交互终端（xterm）
    ├── SSH Backend
    │     · ssh2 连接池（密码 / privateKey）
    │     · exec + sftp + pty
    ├── Agent Detector / Adapters
    │     · which + --version
    │     · 拼非交互命令并解析结果
    ├── Skill Sync
    │     · git clone/pull → ~/.agent-nexus/skills/{name}
    │     · ln -s 到各 agent skills 目录
    └── Tools（注册给 ChatLuna）
          · nexus_delegate
          · nexus_publish
          · nexus_list_agents
          · nexus_list_skills
```

---

## 5. 分期计划

### P0（代码闭环已完成，待真实环境联调）

- [x] SSH 连接（密码/密钥，`env:VAR` 密钥引用）
- [x] exec / sftp / pty
- [x] 5 个 code agent adapter
- [x] `nexus_delegate` / `nexus_publish` / `nexus_list_agents` / `nexus_list_skills`
- [x] Skills：仓库同步 + 中心目录 + 软链
- [x] WebUI：Computer / Skills / 单实例终端
- [x] 默认 SSH Computer 常驻连接 + 断线自动重连
- [x] 终端 WebSocket：`/agent-nexus/terminal/{sessionId}/{terminalId}?token=...`
- [x] 基础构建：`node scripts/build.cjs` → `lib/index.js`
- [x] WebUI console client 打包：`dist/index.js` + `dist/style.css`
- [x] 配置变更后主动断开旧 SSH 会话，避免复用旧凭据/旧地址
- [x] Console 返回配置时隐藏密码、私钥和 passphrase；编辑留空时保留原凭据
- [x] delegate 使用自定义 cwd 时，publish 使用同一安全根目录解析文件
- [x] Skills 更新失败不再吞错，并记录 `lastError`
- [x] Skills 仅软链到远端已扫描安装的 agent，并可重新检查软链状态
- [x] 终端连接 token 增加 60 秒有效期、单次认领和同源检查
- [x] Windows UNC 工作区构建脚本自动寻找可用映射盘符
- [x] 后端与前端 TypeScript 检查、单元测试及完整构建通过

### P1（下一步）

- [ ] 真实 SSH 联调（Linux 远端优先）
- [ ] OpenClaw 在不同安装形态下的探测增强
- [ ] Skill 同步失败重试 / 增量更新状态展示
- [ ] auto 路由策略（按可用性与任务类型）
- [ ] 实际 Koishi + ChatLuna 开发模板安装与工具调用验证

### P2（增强）

- [ ] 多主机并行、更细会话隔离
- [ ] 后台长任务（类似 chatluna background job，挂到终端 tab）
- [ ] 统一结构化 JSON 结果 schema
- [ ] Windows 远端适配（路径/symlink/shell）
- [ ] 更严格的安全策略与审计日志

---

## 6. 当前已实现内容（代码结构）

```
koishi-plugin-AgentNexus/
├── package.json
├── README.md
├── PROJECT.md                 ← 本文件
├── tsconfig.json
├── scripts/build.cjs
├── src/
│   ├── index.ts               # 插件入口
│   ├── config.ts              # Schema / 默认配置
│   ├── types.ts               # 类型
│   ├── service.ts             # 核心服务：委托/发布/扫描/终端
│   ├── proxy.ts               # 终端 WebSocket 代理
│   ├── shims.d.ts
│   ├── ssh/
│   │   ├── session.ts         # 单连接：exec/sftp/pty
│   │   └── pool.ts            # 连接池 + idle 清理
│   ├── adapters/
│   │   ├── base.ts            # 探测/命令包装/路径解析
│   │   ├── hermes.ts
│   │   ├── openclaw.ts
│   │   ├── claude.ts
│   │   ├── opencode.ts
│   │   ├── codex.ts
│   │   └── index.ts
│   ├── skills/sync.ts         # git 同步 + symlink
│   ├── tools/
│   │   ├── base.ts
│   │   ├── delegate.ts
│   │   ├── publish.ts
│   │   ├── list_agents.ts
│   │   └── list_skills.ts
│   ├── utils/shell.ts
│   └── webui/index.ts         # console listeners
└── client/
    ├── index.ts
    ├── page.vue
    └── components/
        ├── computer-panel.vue
        ├── skills-panel.vue
        └── terminal-panel.vue
```

### 6.1 注册给 ChatLuna 的工具

| Tool | 作用 |
|---|---|
| `nexus_delegate` | 委托远端 code agent 非交互执行任务，可选自动 publish 文件 |
| `nexus_publish` | 按远端路径 SFTP 拉取并生成临时 URL |
| `nexus_list_agents` | 列出主机与已安装 agent |
| `nexus_list_skills` | 列出已同步 skills |

### 6.2 WebUI Tab

1. **Computer**：配置单一默认 SSH Computer，连接后自动扫描 Agent 状态
2. **Skills**：仓库 URL 导入、同步状态和软链状态
3. **终端**：进入页面后自动创建一个 xterm SSH 终端

### 6.3 配置落盘

```
{koishi.baseDir}/data/agent-nexus/config.json
```

配置文件仍保存实际凭据以供 SSH 使用，但 Console RPC 不会回传密码、私钥或
passphrase。编辑已有主机时凭据输入框留空会保留原凭据，需要替换时再输入新值。
生产环境推荐使用 `env:VAR`；引用不存在的环境变量会返回明确错误。

### 6.4 Skills 远端布局

```
~/.agent-nexus/
  skills/{skill-name}/
  repos/{source-id}/
```

软链目标（按 agent）：

- Hermes: `~/.hermes/skills`
- OpenClaw: `~/.openclaw/skills` 等
- Claude: `~/.claude/skills`
- OpenCode: `~/.config/opencode/skills` 等
- Codex: `~/.codex/skills` 等

---

## 7. 执行时序（委托）

```
ChatLuna 判断任务复杂 / 需要 code agent skill
  → nexus_delegate({ agent, prompt, publishFiles })
  → 选择 SSH host / session
  → resolve agent（auto 或指定）
  → adapter.buildCommand(prompt + nexus_files 约定)
  → ssh.exec(cmd, timeout)
  → adapter.parseResult
  → 可选 sftp + publish
  → 返回文本 + 文件 URL
```

---

## 8. 安全注意

1. 密钥支持 `env:VAR`，避免明文写配置
2. prompt 通过 base64 注入远端，降低 shell 注入风险
3. Claude、OpenCode、Codex 默认跳过权限确认或沙箱，只应连接受信任的隔离机器
4. 首期按 **Linux/macOS 远端** 设计
5. 日志应避免打印私钥与完整密码

---

## 9. 本地构建

```bash
npm install
npm run build   # scripts/build.cjs → lib/index.js
```

说明：

- 后端用 esbuild 打包为单文件 `lib/index.js`
- 前端 client 使用 Koishi console 构建链，完整 `npm run build` 会同时生成 `lib/` 与 `dist/`
- Windows 网络工作区应配置映射盘符；构建脚本会自动从现有盘符中寻找对应项目
- 当前本地验证命令：`npm test`、`npm run typecheck`、`tsc -p client/tsconfig.json --noEmit`、`npm run build`

---

## 10. 变更时间线（本会话）

1. 创建空仓库本地目录 `koishi-plugin-AgentNexus`
2. clone `chatluna`（v1-dev sparse：`packages/extension-agent`）并分析 computer 设计
3. 调研 hermes / openclaw / claude / opencode / codex 非交互 CLI
4. 确认 OpenClaw 命令：
   `openclaw agent --local --agent default --query "..."`
5. 确认 WebUI 对齐 computer，并加入终端
6. 落地 P0 骨架：SSH、adapters、tools、skills、service、proxy、WebUI
7. 完成本文档 `PROJECT.md`
8. 修复 WebUI 生产入口路径、UNC 构建、SSH 配置变更后的旧连接复用
9. 修复 delegate cwd 与 publish 根目录不一致问题
10. 修复 Skill 更新吞错、失败状态缺失、软链状态丢失和未安装 agent 误链接
11. 加固 Console 凭据回传与终端 token 生命周期
12. 增加凭据脱敏、凭据合并和缺失环境变量测试；当前共 11 个测试通过

---

## 11. 后续建议优先级

1. **联调一条完整链路**：SSH 测试 → 扫描 agent → `nexus_delegate` → 文件 publish
2. 按真实 agent 输出格式细化 parser，尤其是 OpenCode JSONL 和各版本 Claude/Codex 输出
3. 增加 SSH/SFTP/PTY/Skill Git 操作集成测试
4. 再做后台任务、多主机增强和按任务类型的 auto 路由

---

## 12. 一句话总结

> AgentNexus = **ChatLuna 的 SSH Code-Agent 网关**：
> 配置远端主机 → 探测/选择 agent → 同步 skills → 非交互委托执行 → SFTP 回传产物，并提供 WebUI 终端调试。
