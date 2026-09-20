# Node 分支推进到 v2.0.0 进度（对话层改用 Agent SDK）— 交接简报

> 2026-09-20 立。写完 `v2.0.0` 那一版原生方案审批之后，确认 `ExitPlanMode` 在当前 CLI 的 `--print` 模式下不下发，遂决定转向：**以 `claude-fast-electron`（Node/Electron）为主线**，功能追平 `v2.0.0`，其中对话一层改用官方 `@anthropic-ai/claude-agent-sdk` 重新实现——不再手写 CLI stream-json + control 协议。
>
> 这份文档是给**在另一个会话里干活的 agent** 的交接简报：它自包含，不需要读本次对话的上下文。

---

## 0. 先读什么（别跳过）

- 分支 `claude-fast-electron` 的 `CLAUDE.md` / `README.md` —— 该分支内的约定以此为准
- 分支 `v2.0.0` 的 `CLAUDE.md` —— **这是行为规格书**，功能与边界都写在里面，本任务以它为验收标准
- 两个分支在**同一个仓库**里，可直接 `git show v2.0.0:<path>` 对照源码，不必切分支

**分支纪律**：所有工作在 `claude-fast-electron` 上进行。**不要动 `main`**（`main` 恒等于 `v1.0.0`，ff-only 同步）、不要动 `v1.0.0`、不要动 `v2.0.0`。

## 1. 背景与目标

- `claude-fast-electron` 从 `f76a56f`（会话查看器 diff 可视化）分叉，落后 `v2.0.0` **84 个提交**。它是**启动器 / 查看器**：后端 `electron/backend/*.ts`（Node），前端 React + TS + Vite，`package.json` 是 `type: module` 但主进程经 `tools/build-electron.mjs` 打成 `dist-electron/main.cjs`，用 electron-builder 出包
- `v2.0.0` 是 Tauri 2 + Rust，含完整的 app 内 GUI 对话
- **目标**：Node 分支成为主线，功能追平 `v2.0.0`；其中「app 内对话」一层**不要移植 `src-tauri/src/chat.rs`，改用官方 `@anthropic-ai/claude-agent-sdk` 重新实现**

## 2. 必须先做的验证 spike（阻塞后续设计，别先写产品代码）

写一个一次性脚本跑通下面几条，把结论写进分支 `CLAUDE.md`，再动产品代码：

1. **SDK 能否拿到 `ExitPlanMode`？** ⚠️ 有已知反例：裸 CLI 在 `--print` 模式下工具表里**没有** `ExitPlanMode`（实测 CLI 2.1.278，`system/init` 的 `tools` 共 28 个，`AskUserQuestion` 同样缺席——交互类工具在非交互模式被整体裁掉；`--allowedTools ExitPlanMode`、`--permission-prompts host`、`--dangerously-skip-permissions`、先发 `control_request(initialize)` 都放不回来，换 `--model claude-sonnet-5` 也一样）。Tauri 侧因此把原生方案审批降级成了「兜底触发」。**SDK 是否额外传参让它可用，未验证**——这直接决定方案审批 UI 怎么做。
   本机 `%TEMP%\plan-probe\` 留了两个可复用的探针脚本（`variants.mjs` 打印各 flag 下的工具表、`init.mjs` 测 initialize 是否解锁交互工具），可先跑它们建立基线，再写 SDK 版对照。
   注意：`--input-format stream-json` 下 **init 事件要等第一条 stdin 消息才吐**，不发消息只等 init 会一直静默（别误判成卡死）。
2. **会话落盘互通**：SDK 会话是否写同一份 `~/.claude/projects/<mangled>/<sessionId>.jsonl`；`claude --resume` 能否续；`renameSession()` 追加的 `{"type":"custom-title","customTitle":...}` 是否与 `v2.0.0` 的 `rename_session` 字节一致
3. **`settingSources` 默认是 `[]`** —— 不传就**加载不到 `settings.json` 与 CLAUDE.md**。而 `v2.0.0` 的行为是刻意继承 settings 的 `permissions.defaultMode`（项目 local > 项目 > 用户级，`CLAUDE_CONFIG_DIR` 优先）。先确认要传什么，否则开箱行为就和终端不一致
4. **打包后能否工作**：asar / 原生二进制解包 / ESM

## 3. 移植清单

### 3.1 后端（Node，`electron/backend/*.ts`）

现有：`config` / `mangle` / `paths` / `platform` / `scriptnames` / `sessions` / `text` / `trash`

缺口（对照 `v2.0.0` 的 41 个命令 + 7 个 `chat_*`）：

- **配置模型**：`favorites` → `order`（项目绝对路径数组，显示顺序）；新增 `providers` / `currentProvider` / `pinnedSessions`。**`save_config` 必须改读改写**——`v2.0.0` 踩过这个坑：从参数重建整个 Config 会静默清掉新增字段。`favorites` 存量数据怎么迁移，先想清楚再动手
- **数据根判定要统一**：`v2.0.0` 已改为「exe 向上最多 6 级找 `config.json` 或 `config.json.bak` 并做**内容校验**（`{}` 空对象，或命中 ≥2 个已知字段）」；electron 分支还在用旧标记（`claude-claude-fast.bat`，注释里还提到 `scripts/`）。**不统一的话，同一个便携目录两个 app 会认到不同数据根**。注意 `v2.0.0` 那个「≥2 而非 ≥1」是必需的（`projects`/`dark`/`order` 都是通用词，向上扫会撞到别人家配置，认领后一次保存就把人家整份覆写）
- **两边共用同一个安装模式数据根**（`%APPDATA%\claude-fast`）：老用户（Tauri 版）的 `config.json` 带 `order`/`providers`/`pinnedSessions`，Node 版必须能读且**不丢字段**
- 会话域：回收站、置顶会话（`pinned_sessions`，注意 `prune_dead_pins` / `drop_pins_for_projects` 那套清理语义）、搜索 / 导出 / token 统计
- 用量台账（`stats-ledger.json`）：口径别自己发明——「同一 `message.id` 取带 `stop_reason` 的收尾行」「按本地时区归属日期」「每日会话数按最后活跃日归属」「`LEDGER_VERSION` 不一致触发全量重扫」等，逐条照 `v2.0.0` 的 CLAUDE.md
- 供应商切换（`provider.rs`，含 CC Switch SQL 导入、sanitize、回填顺序）、模型拉取（`model_fetch.rs`）、Coding Plan 用量（`usage_query.rs`，换 Node 的 fetch）、版本检查与升级（`claude_update.rs`）
- `scriptnames.ts` 已是半死代码（只有 `platform.ts` 引用它），`v2.0.0` 已彻底去脚本化 —— 顺手清干净

### 3.2 前端

差距 **31 个文件、约 +12k 行**。缺的组件：

`Icons.tsx` / `MessageParts.tsx` / `ChatView.tsx` / `ChatTabs.tsx` / `PinnedSessions.tsx` / `SessionRow.tsx` / `SessionContextMenu.tsx` / `ProviderDialog.tsx` / `PresetPicker.tsx` / `StatsDialog.tsx`

多出来的（`v2.0.0` 已删）：`SessionViewer.tsx`（已并进 `ChatView`）、`Toolbar.tsx`（功能进顶栏）

这些是纯前端，可以直接搬；**只有 `src/lib/api.ts` 那一层要重写成 IPC 契约**（对照 `electron/ipc-contract.ts` 的类型表模式）。

## 4. 对话层：用 SDK 实现，行为对齐 `v2.0.0`

**不要移植 `chat.rs`**。要复刻的是**行为**，规格见 `v2.0.0` CLAUDE.md 的「app 内直接对话」整段：

- 懒启动（首条消息才起会话）、多会话 tab 并行（每 tab 一个会话，切 tab 不中断流、后台继续流式）、图片粘贴/拖入（base64，PNG/JPEG/GIF/WebP，单图 ≤4.5MB）、支持纯图无文本发送
- 权限模式 6 档（manual / auto / acceptEdits / plan / bypassPermissions / dontAsk），初始值解析 `permissions.defaultMode`，运行中可热切（SDK：`setPermissionMode` 或 `query.setPermissionMode()`）
- 权限确认卡片 = SDK 的 `canUseTool` → 卡片允许/拒绝 → 返回 `{behavior:"allow"}` / `{behavior:"deny", message}`
- 中断 = SDK 的 `interrupt()`
- 流式渲染：文本 / 思考 / 工具调用 / 工具结果；**活动组跨消息合并**（一轮工具循环折成一行摘要「思考 · 读取 2 个文件 · 执行 1 条命令」，不是每块一行）
- 方案审批卡：取决于第 2 步 (1)。SDK 能下 `ExitPlanMode` 就走原生三选一（批准并自动接受编辑 acceptEdits / 批准逐个确认 manual / 继续修改 deny）；不能就退回 `v2.0.0` 现在的兜底触发（`turn_end && 计划模式` → 正文取本轮最后一条已完成助手文本，批准 = 切模式 + 发执行指令）
- **别把已删掉的东西搬回来**：`v2.0.0` 刚删了 `plan_structure` 侧信道与 `PlanChoices` 决策点选择器，别再引入

### SDK 已知事实与坑

> 以下部分来自二手资料（核实过程中 WebFetch 被全域拦截，未能读官方页面），**请以官方 TS reference 复核**。

- SDK 是 **CLI 的包装层**：`query()` 内部 spawn `claude` 子进程走同一套 stdio stream-json + control 协议（`initialize` / `can_use_tool` / `hook_callback` / `mcp_message` / `interrupt` / `set_permission_mode`）——**不是**直连 API。所以它不减少进程数
- 需要 **Node 18+**；**ESM-first**（`sdk.mjs`）。本分支是 `type: module` 但主进程打成 `.cjs` —— SDK 很可能要**保持 external + 运行时动态 `import()`**，别指望塞进 esbuild 的 CJS bundle
- **`pathToClaudeCodeExecutable` 建议指向用户本机那个 `claude`**：这样 app 内对话与终端跑的是同一个 CLI、同一份配置，「跟随本机 Claude Code」的性质才保住。否则 SDK 把版本钉在它自带的 CLI 上（SDK 补丁版随 CLI 版本 bump）
- **`canUseTool` 只是 "ask" 路径**：被 `acceptEdits` / `bypassPermissions` / 白名单自动批准的调用**根本不会到它**。要做「每个工具都过一遍策略」得用 `PreToolUse` hook
- 拒绝文案会作为 `tool_result` 喂回模型；`updatedInput` 可改工具输入；`{behavior:"allow"}` 不带 `updatedInput` 自 CLI 2.1.207 起合法
- 打包坑：Electron 打包后 `spawn node ENOENT`（asar / 原生二进制需解包）；可用 `spawnClaudeCodeProcess` 或 `executable` 选项绕
- 会话落盘与 `--resume` 互通；`renameSession()` 追加的 `custom-title` 行与 `v2.0.0` 的 `rename_session` 同机制
- 净新增能力（相对裸协议）：in-process MCP bridge、hook 回调、session 管理 API（fork/list/SessionStore）、typed API 面

## 5. 铁律（最容易踩的几条）

- **版本号只在用户明确要求时才改**——这次没让改就别动任何 version
- **绝不删数据根的 `config.json` / `.bak`**；保存走三步保护（写临时文件 → 旧文件备份 `.bak` → 原子替换），读取失败自动从 `.bak` 回退
- **config 读改写必须持锁**（Node 侧等价物：串行化写），且**持锁期间不得调用另一个持锁函数**（会死锁）
- 会话文件路径校验必须 **canonicalize 后**再做前缀判断（不规范化 `..` 可被穿越）
- UI：图标只用 `Icons.tsx` 的 Lucide 线性组件，**禁止 emoji / 纯字符（× ⋯ ⟳ ▾）当图标**；主按钮类名是 **`btn btn-primary`**（写 `btn primary` 会静默降级成描边）；新增按钮类**必须做墨迹居中补偿**（不对称 padding，注释写「墨迹补偿，勿改对称」）并放大目检
- `styles.css` 里 `.chat-head` 与 `.viewer-head` 是同一套改动的两份，**改一处必须同步另一处**

## 6. 分阶段建议（每阶段可独立验收）

1. **Spike + 结论**（第 2 步）—— 阻塞其余
2. 后端补齐非对话部分（配置迁移 + 数据根统一 + 回收站/置顶/统计/供应商），全部配 vitest 单测
3. 前端搬组件 + IPC 契约重写，让启动器/查看器先全功能追平
4. 对话层用 SDK 实现（最重、且依赖第 1 步结论）
5. 打包验证：electron-builder 产物里 SDK 与 `claude` 可执行文件都能跑

## 7. 交付与汇报要求

- 每阶段结束给出：改了什么 / **验证到什么程度**（跑了什么命令、点了哪条路径）/ **没验证的是什么**
- **不要用「应该能工作」搪塞**——跑不了、验不了的路径必须明确写出来
- 提交信息沿用仓库习惯：`前缀:改动点` 一行说完（中文、≤30 字），细节留 diff，确需交代原因另起正文段
- 遇到与本文档冲突的事实（尤其 SDK 行为），**以实测为准**，并把结论回写进分支 `CLAUDE.md`
