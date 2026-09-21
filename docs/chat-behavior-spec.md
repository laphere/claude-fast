# app 内对话 —— 行为规格与待补齐清单

> **来源**：本文件写于 `v2.0.0`（Tauri 2 + Rust）分支**删除前**（2026-09-21）。v2.0.0 的对话层是手写 CLI stream-json + control 协议（`src-tauri/src/chat.rs`），本分支改用官方 `@anthropic-ai/claude-agent-sdk` 托管（`electron/backend/chat.ts`）——**实现路径不同，外部行为要求相同**。删 v2.0.0 时把它的规格段落抄在这里，理由：`main`/`v1.0.0` 的 CLAUDE.md 没有对话层，这段文字删了就没有第二份。
>
> **怎么读**：§1 是 v2.0.0 规格原文（逐字抄录，含 Tauri 侧实现细节——读时把 `chat.rs` 换成 `chat.ts`、把 control 协议换成 SDK 的 `canUseTool`/`setPermissionMode`/`interrupt`）；§2 是 2026-09-21 逐条对照审计出的**本分支缺口**（本分支自己的待办，与 v2 去留无关）；§3 是可直接翻成 vitest 的回归用例清单。
>
> ⚠️ 文中的 `v2.0.0:<file>:<line>` 只是历史标注，该分支已删除、事后查不到；`main:<file>` 的引用仍然有效（`main` = `v1.0.0`，含同一批 Rust 测试）。

---

## §1 v2.0.0 规格原文

### §1.1 跨平台层的路径校验口径（`validate_resume_path`）

- `resume_session(file, project_path)`：新开终端窗口执行 `claude --resume <session-id>`。Windows 用 `build_resume_cmdline` 拼防注入命令行；macOS 写临时 .sh 到系统临时目录再 `open -a Terminal`（无需 osascript 自动化权限）。共用 `validate_resume_path`，但平台规则不同：Windows 路径进 `cd /d "<...>"` 双引号内，`& | < > ^ ( )` 均为字面量不构成注入，只拒引号内仍有效的 `"` `%` `!`（引号截断 / 变量展开 / 延迟展开）；macOS 路径经 `sh_quote` 进 `cd "..."` 后元字符均为字面量，故仅拒控制字符 + 要求路径存在（避免误伤含 `( ) ' \` 的合法 mac 路径）。`launch_project` 的 macOS 临时脚本同样把路径放进 `cd "<sh_quote>"` 双引号内——漏引号时含空格路径必坏、`;` 可逃逸，勿改。

**为什么这两句要留**：它们就是 B3 / B5 的验收标准。本分支的 CLAUDE.md 把 Windows 口径记成了「拒绝 cmd 元字符」，**方向是反的**（详见 §2）。

### §1.2 app 内直接对话

- **app 内直接对话**（项目行 💬 / 点击会话行）：后端 `chat.rs` spawn 官方 `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --permission-mode <mode>`（新对话 `--session-id <uuid>`，续聊 `--resume <id>`），stdin 发消息、stdout 逐行翻译成 ChatEvent 经 Tauri `ipc::Channel` 推给前端 `ChatView` 流式渲染（文本/思考/工具调用/工具结果，渲染组件在 MessageParts 共用）。**权限模式**：spawn 一律不传 --permission-mode（跟随 settings.json 的 defaultMode，与终端默认行为一致）；下拉初始选中项 = chat_default_permission_mode 解析 permissions.defaultMode（项目 settings.local.json > 项目 settings.json > 用户级 ~/.claude/settings.json，CLAUDE_CONFIG_DIR 优先；"default" 归一显示为手动确认），session_ready 以 init 事件上报的实际 permissionMode 校正显示；用户改选立即经 chat_set_permission_mode 热切换（改选过才在 spawn 时显式传 flag）；5 种选项（手动确认 manual【原 default，每工具都问】/自动 auto/接受编辑 acceptEdits/计划 plan/完全权限 bypassPermissions）与终端 Shift+Tab 交互循环对齐，配置了下拉之外的值（如 dontAsk）以原始名动态加入下拉；`--permission-mode` 还合法取值 dontAsk（会触发确认的操作直接拒绝）但不在终端循环里（程序化用），故不进下拉、后端白名单仍放行——进程未启动时作为 spawn 初始模式，已启动经 `chat_set_permission_mode`（control 协议 `set_permission_mode`）热切换，CLI 回执失败经翻译层变 Error 事件 toast。manual 模式下权限确认走 control 协议：CLI 发 `can_use_tool` → app 内卡片允许/拒绝 → `control_response`（拒绝由 CLI 作为 tool_result 喂回模型，不中断会话）；中断 = `control_request interrupt`。**计划模式的方案审批卡**（双来源，共用同一张三按钮卡）。原生路径：模型调 `ExitPlanMode` 时 CLI 经 `can_use_tool` 下发（`input.plan` 即方案正文），翻译层按 tool_name 分流成 `PlanApproval` 事件（否则会退化成一张把 `{plan:"…"}` 原样打成 JSON 的普通工具卡）；**allow 必须先于 set_permission_mode 下发**（CLI 批准 ExitPlanMode 时会自己恢复 prePlanMode，顺序反了会被它盖掉）；原生请求阻塞在 control_request 上且**不会超时**，所以每条路径都必须给出应答——下拉切走计划模式、以及「卡在场时直接发送消息」（发送即按「继续修改」处理：先 deny 再把这条消息发出去，顺序不能反）都各补一次 deny，`control_cancel_request` 到达同步收卡。**但实测（2026-09-20，CLI 2.1.278）`--print` 模式下 CLI 的工具表里根本没有 ExitPlanMode**——`system/init` 的 `tools` 只有 28 个、交互类工具（ExitPlanMode、AskUserQuestion）在非交互模式被整体裁掉，`--allowedTools ExitPlanMode`（反而是过滤器，工具压到 24 个）/`--permission-prompts host`/`--dangerously-skip-permissions`/先发 `control_request(initialize)` 宣告宿主能力都放不回来，换官方模型 id（`--model claude-sonnet-5`）与清空嵌套会话环境变量也一样，实测中模型自己都答「这个环境里没有暴露 ExitPlanMode」。**故当前实际生效的是兜底触发**：`turn_end && mode==="plan"` 且本轮进入过思考态、无错误 → 弹卡，正文取「本轮最后一条已完成的助手文本」；这条路径下批准 = 切模式 + 发一条合成的「（已批准方案）请按上面的方案开始执行」，「继续修改」只收卡（本轮已结束，用户直接打字即可）。三按钮（批准并自动接受编辑 acceptEdits / 批准，逐个确认 manual / 继续修改）与原生分支共用；原生分支留着，等 CLI 或 SDK 侧放开即自动接管（`plan.source` 区分）。**已删除**：侧信道 `plan_structure`（把方案文本交供应商 API 整理成可点选决策点的额外 LLM 调用）与 `PlanChoices.tsx` 决策点选择器——`src-tauri/src/plan_structure.rs` 一并移除。**遗留缺口（原生路径激活前必须补）**：翻译层只在权限请求那条路上特判了 ExitPlanMode，**流式那段没管**——`--include-partial-messages` 的 tool_use 块与完整 assistant 消息里同样带着这个工具，`tool_use_start` 会照常建行，展开即 `JSON.stringify(input)` 打出整段方案 JSON，活动组摘要也会计成「ExitPlanMode × 1」。要收口得在 tool_use 渲染层按工具名折叠（并按 tool_use_id 一并吞掉它的 tool_use_complete 与 tool_result，否则会留下孤儿结果卡）。当前 print 模式拿不到这个工具，故不可达、未实现。懒启动：首条消息才 spawn 进程（用 CLI 默认模型，不做模型选择）。**图片粘贴**：composer 支持粘贴（Ctrl+V 截图/复制的图片）与拖入图片文件（PNG/JPEG/GIF/WebP，单图 ≤4.5MB，超限 toast）——onPaste 读 clipboardData 的 image item、drop 读 dataTransfer.files，FileReader 转 base64 存 pendingImages（输入区上方缩略图预览条，可 × 移除），chat_send 增 images 参数、build_user_message 在 content 数组追加 image 块（官方 stream-json 协议原生支持 base64 source）；支持纯图无文本发送；历史 jsonl 的 image 块照常解析渲染（lib.rs parse_content_blocks 的 image 分支），Markdown 导出图片记 🖼️ [图片] 占位。**对话进度条**（续聊历史会话时）：对话区左侧用户发言导航轨（自 v1.0.0 查看页移植）——每条用户发言一个小横条（后端 get_session_user_prompts 提取），悬停气泡预览内容、点击 jumpTo 定位到对应消息（跨分页自动加载对应页），滚动 rAF 节流高亮当前位置；悬停波浪动效（悬停条最长，相邻条按距离 d0/d1/d2 三档递减宽度，0.15s 过渡，划过呈小山包波浪）；新对话无 jsonl 时不显示；**多会话 tab 并行**：App 维护 chats 数组（后端 ChatManager 的 HashMap 本就支持多进程并存），全部 ChatView 保持挂载、非激活页 display:none——切换不关进程、后台继续流式；tab 栏（ChatTabs）显示标题 + 进行中状态点（ChatView 经 onStatusChange 上报 thinking/starting）+ × 关闭；**tab 右键菜单**：关闭其他会话（保留当前 tab，进行中 thinking/starting 的会话跳过不关）/ 关闭所有会话（两者均跳过进行中 thinking/starting 的会话；closeOtherChats/closeAllChats 批量处理器，逐个优雅关闭并刷新对应项目会话列表）；续聊同一会话不允许开两个进程（会分叉历史），只激活已有 tab；关闭 tab（卸载 ChatView → unmount 优雅关闭进程）后刷新该项目会话列表。对话记录由 CLI 落盘 `~/.claude/projects` 原生 jsonl → 自动进入会话列表、终端可 resume；退出 app 时 `RunEvent::Exit` 里 `ChatManager::stop_all` 清理全部子进程（关 stdin 优雅退出，超时强杀）。Windows 下 claude 可执行文件需 `where claude` 解析全路径并按 `.exe` > `.cmd`/`.bat` 优先级挑选（`Command::new("claude")` 不解析 .cmd，无扩展名 sh 垫片会报 os error 193），结果 OnceLock 缓存。

### §1.3 会话页二合一与列表里的对话入口

- **会话页 = 对话 + 内容查看二合一（ChatView，原 SessionViewer 已删）**：左右分栏（左 360px 项目/会话列表，右会话页）。会话页分两段渲染——**历史 jsonl 段**（`get_session_messages(file)` 读取，text/thinking/tool_use/tool_result 块，`MAX_SESSION_MESSAGES=500` 截断，过滤 sidechain/isMeta/命令消息；顶部「加载更早」向上分页）+ **实时流段**（本次 sitting 的流式消息追加其后）；「刷新」重读 jsonl 并清空实时区（jsonl 为唯一事实来源，对话进行中禁用）。原查看页功能全在：**搜索**（`search_session_messages` 防抖全文搜索、命中跨分页跳转定位并展开外层活动组）、**变更文件面板**（聚合 Edit/Write/MultiEdit，历史可定位、实时消息暂不可定位）、**导出**（Markdown/JSONL，仅已有 jsonl 的会话）、**token 统计**（头部展示 jsonl 累计 + 「本次」实时用量）。渲染为 Claude Code 终端风格：**历史与实时合成一条统一渲染流，活动组跨消息合并**——jsonl 里一轮工具循环拆成多条 assistant 消息，若按单条消息分组会出现「思考·读取→搜索→思考」碎行，故从一次文本输出到下一次文本输出之间的所有思考/工具折成同一组摘要行（「思考 · 读取 2 个文件 · 执行 1 条命令」，ActivityGroup + activitySummary），点击展开；工具行展开同时看输入 JSON 与执行结果（结果合并进工具行，仅无主结果独立成卡）；围栏代码块等宽。状态徽标仅在 启动中/思考中/已退出 时显示（未开始不显示）。新对话（无 jsonl）只有实时段，头部功能按钮隐藏。
- **会话管理**：点击项目行展开其 Claude Code 会话列表（异步加载不阻塞 UI）；会话行显示标题 + 相对时间 + 摘要，**点击会话行 = 直接在 app 内继续对话**（ChatView，原会话查看页已并入），行首常驻 📌 置顶图钉，悬停 tooltip 显示完整标题+摘要，**行上不放操作按钮**，右键菜单收着：在终端中继续对话 / 重命名 / 置顶（按状态切「取消置顶」）/ 删除（SessionContextMenu；会话行组件 `SessionRow` 仅置顶聚合区使用，项目内列表为内联行；置顶会话从项目列表滤除后若该项目已无可见会话，空态提示「会话已全部置顶」）。`list_sessions(project_path)` 用真实路径正向 mangle 定位 `<projects>/<mangled>/`，对每个 `.jsonl` 只读首尾各 64KB（`LITE_READ_BUF_SIZE`）提取元数据：标题回退链 customTitle > aiTitle > 首条用户消息；**命令消息（如 `/init`）被跳过——只执行命令、无实质对话的会话不进列表**；sidechain/纯元数据会话过滤；按 mtime 倒序。`rename_session(file, new_title)` 安全校验（限 projects 目录下 uuid.jsonl）后向 jsonl **追加** `custom-title` 行（与 Claude Code `/rename` 同机制，不覆盖原文件）。

---

## §2 本分支缺口（2026-09-21 对照审计）

对照方式：`v2.0.0:CLAUDE.md` 的功能条目 × 本分支实际代码。**已确认落地、不必再看的**（点名项都逐条核过）：活动组跨消息合并、图片 ≤4.5MB 与 PNG/JPEG/GIF/WebP 白名单、权限 6 档与 `manual↔default` 映射、置顶清单真源同步与 prune 语义、消息分页窗口世代号、用量台账全套口径（`LEDGER_VERSION`、收尾行、本地时区分日、最后活跃日会话数、`<synthetic>` 过滤、未归属段）、搜索/导出/变更文件面板/进度轨、供应商切换与 CC Switch SQL、Coding Plan 五家厂商、claude 版本检查升级。

复核状态：**B1 / B3 / B4 / B5 / B6 / B7 已人工复核代码确认**；B2 由审计用本机真实 jsonl 实测（未人工复核）；B8–B16 来自审计、未逐条复核。

> **修复进展（2026-09-21）**：**B1 / B2 / B3 已修**（各条末尾有「已修」说明）。⚠️ 其中 B1 顺带**订正了 v2 的口径**：v2 取「同 id 的首行」，但当代 jsonl 首行 usage 恒为 0（或只有占位），真实值在**带 `stop_reason` 的收尾行**上——本机实测某会话取首行只有 3.44M、取收尾行是 258.84M（差 75 倍）。本分支因此**复用用量台账的 `betterUsageRow`（收尾行优先，同优先级取 token 更大者）**，会话头部统计与统计仪表盘逐字节一致（8 个最大的真实会话文件实测 0.0% 偏差）。§1 抄录的 v2 原文里没有这条，别照它实现。

### B1【高】会话页头部 token 统计整块没移植（静默失效）

- 现象：「总计 N · 输入 N · 输出 N · 缓存读取 N」**永不渲染**，只剩「N 条消息」，无任何报错。
- 本分支：`src/types.ts:132` 把 `SessionUsageStats` 声明为 `SessionMessages` 的**必填**字段、`src/components/ChatView.tsx:235` + `:973` 消费它，但后端 `electron/backend/sessions.ts` 不产——全仓 `grep -rn SessionUsageStats` 只有声明与消费两处、**没有生产者**；`sliceMessages` 只回 4 个字段。
- v2 参照：`lib.rs:1880` 在**切片前**对全量消息 `aggregate_usage`（实现 `:1903-1921`），每条消息带 `usage`（`:1848-1867`），`parse_usage` 兼容新旧两种格式（`:1923-1955`）。
- 验收：`get_session_messages` 返回 `stats`；头部四数字渲染；usage 按 `message.id` 全局只计一次（见 B2）。
- **已修**：`sessions.ts` 增 `Usage` / `SessionUsageStats` / `parseUsage` / `aggregateUsage`，`sliceMessages` 切片**前**对全量聚合；代表行取舍复用台账的 `betterUsageRow`（**收尾行优先**，见本节的订正说明）。验证：会话头部与台账 8 个真实会话文件 0.0% 偏差；`parseSessionMessages` / `aggregateUsage` 单测覆盖新旧 usage 格式与"首行 0、收尾行才是真值"的形状。

### B2【中】相邻同 `message.id` 的 assistant 行未合并

- 现象：消息数虚高，连带「## 消息 N」导出小节数与 500 条分页窗口覆盖的真实轮次。审计用本机真实 jsonl 实测：

  | 会话文件 | 未合并 | 合并后 |
  |---|---|---|
  | `1842efdd-…jsonl` | 1200 | 834（+44%） |
  | `13980860-…jsonl` | 706 | 460 |
  | `05d7b451-…jsonl` | 482 | 336 |

- 本分支：`electron/backend/sessions.ts` 的解析没有 `message.id` 概念，每行各成一条。
- v2 参照：`lib.rs:1837-1845` 把相邻同 id 的行**追加进上一条**；`usage_counted_ids`（`:1846-1856`）让 usage 按 id 全局只计一次（该修复的实测背景：21.3M 被显示成 32.8M）。
- 注意：**不会错位**——搜索/进度轨/变更文件面板的 `index` 与列表同源、自洽；活动组的视觉合并另在 `ChatView.tsx:1255`，与本条无关。
- 验收：见 §3 的 `parse_session_messages_merges_same_msg_id` / `session_usage_counts_split_msg_id_once` 语义。
- **已修**：`parseSessionMessages` 按 `message.id` 合并相邻行（后行 blocks 追加进上一条）。验证：本机 6 个真实会话实测合并掉 324–899 行（「消息数」从虚高回到真实值，与台账的 messages 计数同源）。**注意**：合并会改变 `messages` 下标，搜索 / 进度轨 / 变更文件面板的 `index` 与列表同源、自洽（已在审计中确认）。

### B3【中】Windows「继续对话」过度拒字符（与 v2/main 相反）

- 现象：`C:\Program Files (x86)\...` 下的项目**「启动」能开、「继续对话」直接报「项目路径包含非法字符」**。
- 本分支：`electron/backend/platform.ts:105` 拒 `" & | < > ^ % ! ( )` **十个**；`electron/backend/platform.test.ts:44-58` 把这条反向规则**写成了断言**；本分支 CLAUDE.md 也记成「Windows 拒绝 cmd 元字符」。
- v2/main 口径：只拒引号内仍有效的 `"` `%` `!`（引号截断 / 变量展开 / 延迟展开），`& | < > ^ ( )` 在双引号内是字面量——**见 §1.1 原文**。
- 验收：含 `(x86) & test` 的合法目录**必须放行**，`%` `!` `"` 仍必拒；同步改掉 `platform.test.ts` 的反向断言与本分支 CLAUDE.md 的措辞。
- **已修**：`validateResumePath` 的 win32 名单收敛为 `" % !`，注释写明口径来源与「别改回一律拒元字符」的理由；`platform.test.ts` 的反向断言改成逐字符判定（`& | < > ^ ( )` 必须放行）+ 一条端到端用例（真实存在的 `Program Files (x86) & test` 目录原样通过）；`buildResumeCmdline` 的用例同步（`%` `!` 拦、`&` 不再拦）。**B4 仍未修**（`launchProject` 依旧零校验），修它时直接复用同一个函数即可。

### B4【中】启动路径完全不做字符校验

- 本分支：`electron/backend/platform.ts:328-336` 的 `launchProject` 只做 `statIsDirectory`，随后把 `dir` 原样拼进 `` start "Claude Code" /d "${dir}" cmd /k claude ``（`windowsVerbatimArguments: true`）→ `%`（变量展开）、`!`（延迟展开）、`"`（截断引号）全部放行。
- v2/main：`launch_project` 第一句就是 `validate_resume_path(&dir)?`——注释写明「路径与 resume 拼进同款 `cd /d "..."`，注入面一致，共用同一校验」。
- 验收：launch 与 resume 共用同一校验函数。

### B5【中】macOS「启动」临时脚本用 `JSON.stringify` 而非 `shQuote`

- 本分支：`electron/backend/platform.ts:344` 写成 `` cd ${JSON.stringify(dir)} ``，而**同一文件的 resume 版**（`:159`）用的是 `shQuote`。`JSON.stringify` 不转义 `$` 与反引号 → 目录名含 `$(...)` 或 `` ` `` 时生成的 .sh 会执行命令替换（空格没问题，引号还在，所以是半边修好）。
- v2/main：`launch_project` 的 macOS 临时脚本走 `sh_quote`——见 §1.1 原文末句。
- 验收：两处共用 `shQuote`。

### B6【中】关闭会话 / 退出 app 没有优雅退出窗口

- 本分支：`electron/backend/chat.ts:791-794` 的 `close()` 是 `queue.end()` 后**同一个 tick** 直接 `abort.abort()`，而 `abort` 又是 spawn 的 signal（`:711`）→ 立即终止子进程；`closeAll()`（`:860-863`）与 `before-quit`（`main.ts:555-559`）都走它。注释声称的「超时由 SDK 强杀」并未实现。
- v2 参照：`chat_close` 先 `drop(stdin)` 再 `wait_then_kill(child, 3s)`（`chat.rs:1152-1163`、`:912-929`），app 退出 `stop_all` 等 2 秒（`:701-724`）。
- 验收：流式进行中关 tab / 退出 app，jsonl 尾部完整。

### B7【中】「跟随本机 Claude Code」定位退化，且同步阻塞主进程

- 本分支：`electron/backend/chat.ts:533-561` 只猜 `<cwd>/node_modules` 与 `<npm root -g>` 两处，**没有 `where` / `command -v` 探测** → 官方原生安装（如 `%USERPROFILE%\.local\bin\claude.exe`）一律找不到，**静默回退 SDK 自带 CLI**（版本与配置可能与终端不同，无任何提示）；且无缓存，每次会话启动都同步 `execFileSync("npm", …, { timeout: 5000, shell })`，最坏阻塞主进程 5 秒。
- v2 参照：`where claude` / `command -v claude` 取 PATH 全路径，Windows 按 `.exe > .cmd/.bat` 择优并排除 npm 垫片（`chat.rs:854-870`），结果缓存在 `OnceLock`（`:32`、`:785-790`），找不到**明确报错**。
- 验收：找得到就用本机那份并给出提示/缓存；找不到时报错或至少显式提示，不静默换实现。

### B8–B16【低】纵深防御与边角差异

| # | 项 | 本分支 | v2 参照 |
|---|---|---|---|
| B8 | `chat_start` 会话文件校验 | `main.ts:401-404` 直接取 `path.basename(...)` 当 `--resume` 参数，不验 uuid / 不验目录归属（`validateSessionFile` 就在 `sessions.ts:246`，这条路径没用） | `chat.rs:956-960` 走 `validate_session_file` |
| B9 | 权限模式白名单 | `chat.ts:121-123` `mode as PermissionMode` 强转、`:780-783` 无校验 | `chat.rs:208-215` 六档常量 + `:951-955`、`:1124-1126` 校验 |
| B10 | 图片后端白名单 | `chat.ts:237-248` 任意 `mediaType` 原样塞入；空消息判据用 `text.length > 0`（纯空白算合法） | `chat.rs:124-130` `is_supported_image`、`:138-146` 跳过不支持/空 data、判据 `text.trim()` |
| B11 | 子进程 stderr | `chat.ts:705-716` spawn 未指定 stdio 且无人读 `:718-726` 硬编码 `stderrTail: null`（两侧前端都不渲染 → 用户可见影响为零） | `chat.rs:988-1009` 起线程 drain，尾部 4000 字符随 `exited` 下发 |
| B12 | 小护栏 | `chat.ts:805-809` 无项目目录存在性检查；同 sessionId 重复 start **静默 return**（`main.ts:405` 仍覆盖 `chatTokens`，当前 App 按 `session.file` 去重故不可达）；`:289-299` 不校验 `control_request` subtype；`:835-846` 用 `?.` 静默 no-op | `chat.rs:943-946`、`:1028-1037`、`:610`、`:1166-1187` |
| B13 | 未知 `defaultMode` | `chat.ts:133-139` 硬编码白名单，非法返回 `null` → 落到下一级候选文件，可能显示成另一个档位 | `chat.rs:728-745` 只要求非空字符串就透出（新档位也能显示） |
| B14 | ISO 时间戳解析 | `usage-stats.ts:248-261` 锚定正则 `(?:\.(\d{1,3}))?Z?$`，>3 位小数或带 `±HH:MM` 直接 `null` → 该行整块跳过（总量仍有数，`perDay` 缺）→ 破坏「任意窗口 Σ每日 = 去重会话数」不变量（本机 14 万个 timestamp 全是 `.mmmZ`，只有第三方工具写的 jsonl 触发） | `lib.rs:2366-2379` 按位置切片，三种格式都能得 epoch |
| B15 | 搜索片段半径 | `session-extra.ts:120-126` 码点 ±40 字 | `lib.rs:2025-2030` 字节 ±40（中文约 ±13 字；不影响命中/跳转） |
| B16 | 标题截断 | `electron/backend/text.ts:56` `slice(0,200)` 按 UTF-16 码元（同文件 `:50` 却正确用了 `[...s]`）→ 尾字符是 emoji 时可能切出半个代理对写进 jsonl | Rust `.chars().take(200)` |

**建议修复顺序**：B1（静默、必现）→ B3（`Program Files (x86)` 用户直接不可用）→ B2（数字虚高，影响导出与分页）→ B6 / B7（数据完整性 + 启动路径确定性与阻塞）→ B4 / B5 → B8–B16。

---

## §3 回归用例清单

### 3.1 从 `main` 抄（删 v2.0.0 不影响，仍在 `main:src-tauri/src/lib.rs`，按测试名 grep）

| 用例名 | 覆盖 |
|---|---|
| `parse_session_messages_merges_same_msg_id` | B2 相邻同 id 合并 |
| `session_usage_counts_split_msg_id_once` | B2/B1 usage 按 id 只计一次 |
| `usage_parses_old_and_new_formats` | B1 `parse_usage` 新旧格式 |
| `parse_session_messages_aggregates_usage` | B1 `stats` 聚合 |
| `parse_session_messages_truncates_at_limit` | 分页/截断语义（含 `slice_messages` 全部行为） |
| `build_resume_cmdline_allows_quoted_literals` | B3 含 `(x86) & test` 的目录必须放行 |
| `validate_resume_path_checks` | B3 引号内 `& ^ ( )` 放行、`%` `!` 必拒 |

### 3.2 只存在于 v2.0.0 的 `chat.rs` 用例（已随删除消失，按下面语义重写）

- **图片白名单**：只放行前端同款的 PNG/JPEG/GIF/WebP，其余 `mediaType` 一律跳过；`data` 为空的同样跳过（纵深防御，前端已兜一层）。
- **空消息判据**：文案空判据是 `text.trim()`，纯空白不算一条合法消息。
- **权限模式白名单**：六档常量 + `dontAsk` 放行；非法值报错，不做 `as` 强转。
- **`chat_start`**：会话文件必须过 uuid + 归属目录校验；项目目录不存在即拒；同一 sessionId 重复 start 不是静默 return。
- **control 协议**：`control_request` 的 subtype 要校验；未知会话的写操作统一报「对话已结束」。

### 3.3 本分支 `chat.test.ts` 的对应关系

审计时 v2 的 `chat.rs` 有 26 个单测（`cli_args_*` / `permission_response_*` / `translate_*` / `pick_claude_candidate_*` / `unsupported_or_empty_images_are_skipped`），本分支 `electron/backend/chat.test.ts`（14 种 `ChatEvent` 全覆盖）已覆盖大部分；**缺的正是上面 B9 / B10 / B13 那几条白名单用例**。
