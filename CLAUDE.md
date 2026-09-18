# Claude助手（claude-fast）

一键在项目目录启动 Claude Code 的桌面应用：**Tauri 2 + React + TypeScript（前端）+ Rust（后端）**，Windows + macOS 双平台，不限定工作区目录。

> **版本线**：仓库已重新规划，当前全部代码为 **v1.0.0**（`package.json` / `Cargo.toml` / `tauri.conf.json` 三处版本号一致）。历史上的 PowerShell/WinForms 版与 v2.x/v3.x 旧版号均已作废，代码中不要再按旧版本号理解。另有 **Node.js（Electron）后端重构分支** `claude-fast-electron`（见下「分支结构」）。
>
> **去脚本化（重要）**：项目清单为**路径模型**——`config.json` 的 `order`/`projects` 存的都是**项目绝对路径**（不再是脚本名；`order` 是项目显示顺序，旧版 `favorites` 键经 serde alias 无缝承接为初始顺序），`+` 号启动直接 `cmd /k cd /d "项目" && claude`，**不再生成/执行 scripts/ 启动脚本**。旧版脚本在首次启动时被自动解析迁移（`ensure_projects_migrated`，幂等）。项目列表 = Claude 会话目录扫描（unmangle 反解）∪ config.projects 手动清单。

## 分支结构（双后端）

| 分支 | 后端 | 说明 |
|---|---|---|
| `v1.0.0`（当前）/ `main` | **Tauri 2 + Rust** | 本 CLAUDE.md 描述的主版本线，后端在 `src-tauri/` |
| `claude-fast-electron` | **Electron + Node.js** | Node 重构后端服务的分支（自 `f76a56f` 分叉）：**前端技术栈不变**（React + TS + Vite），后端改为 `electron/main.ts`（主进程/窗口/托盘/IPC）+ `electron/backend/*.ts`（业务模块：paths/scriptnames/config/mangle/sessions/trash/platform/text，vitest 单测）；构建走 npm（vite + esbuild + electron-builder）。细节见该分支的 CLAUDE.md / README.md |

两分支各自独立演进，**去脚本化（路径模型）与「从列表移除 → excluded 排除清单」已在两端对齐**；不要跨分支混用实现细节（IPC 通道、构建命令、配置读写互不通用），在 `claude-fast-electron` 分支工作时以其分支内 CLAUDE.md 为准。

## 核心文件

| 文件 | 作用 |
|---|---|
| `src/` | 前端：React + TypeScript + Vite。`App.tsx` 状态管理；`src/components/` UI 组件（对话框/列表/会话查看器等）；`src/lib/api.ts` 封装全部 Tauri invoke |
| `src-tauri/src/lib.rs` | 后端主文件（约 5700 行，**全部 commands 与大部分单元测试都在此**，`#[cfg(test)]`）。项目清单系：`list_projects`/`add_project`/`remove_project`/`launch_project`/`check_projects`；一次性迁移：`ensure_projects_migrated`；另有用量统计台账（`get_usage_stats`/`StatsLedger`，约 1940–2650 行区段） |
| `src-tauri/src/provider.rs` | 供应商切换（读写 `~/.claude/settings.json`：指纹守卫回填、current 重锚定、cc-switch SQL 备份导入） |
| `src-tauri/src/model_fetch.rs` | 供应商可用模型拉取（OpenAI 兼容 /v1/models，候选地址逐个探测） |
| `src-tauri/src/usage_query.rs` | Coding Plan 套餐用量查询适配器（Kimi/GLM/MiniMax/ZenMux/OpenCode 五家厂商 HTTP 接口；**不是** jsonl 用量统计——统计在 lib.rs） |
| `src-tauri/src/claude_update.rs` | Claude Code 版本探测与一键升级（semver 比较、bat errorlevel 链兜底 npm 安装） |
| `README.md` | 使用说明、构建方法 |

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe、scripts、config.json——这些运行时产物/用户数据都在数据根目录（见「数据根目录」）。

## 启动与项目清单（去脚本化）

- **不再生成/执行启动脚本**：`+` 号启动直接新开终端执行 `cmd /k cd /d "项目路径" && claude`（Windows ShellExecuteW；macOS 临时 sh + Terminal.app），claude 退出后窗口保留。
- 项目列表 = **Claude 会话目录扫描**（`~/.claude/projects` unmangle 反解）∪ `config.projects`（手动添加的项目路径），按路径去重；显示顺序存 `config.order`（项目绝对路径数组，旧 `favorites` 键经 serde alias 承接）。
- 「移除」= 从清单移除项目（不删磁盘文件）；「批量添加」= 把扫描到的项目加入清单。
- 旧版启动脚本（`scripts/claude-*.bat|sh`）在首次启动时被 `ensure_projects_migrated` 自动解析迁移（key → 路径），脚本文件保留在磁盘不自动删除。
- 健康检查（`check_projects`）直接检查项目路径是否存在。

## 跨平台层

- `script_ext()` 返回 bat/sh；`legacy_marker()` 兼容旧标记 `claude-claude-fast.<ext>`；`parse_cd_path` 兼容 `cd /d` 与 `cd "/path"` 两种语法。
- `launch_claude`：Windows 走 `ShellExecuteW` 开 cmd（Rust `Command` args 的引号会被 cmd 误解析，必须 ShellExecuteW）；macOS 走 `open -a Terminal`。
- `resume_session(file, project_path)`：新开终端窗口执行 `claude --resume <session-id>`。Windows 用 `build_resume_cmdline` 拼防注入命令行；macOS 写临时 .sh 到系统临时目录再 `open -a Terminal`（无需 osascript 自动化权限）。共用 `validate_resume_path`，但平台规则不同：Windows 路径进 `cd /d "<...>"` 双引号内，`& | < > ^ ( )` 均为字面量不构成注入，只拒引号内仍有效的 `"` `%` `!`（引号截断 / 变量展开 / 延迟展开）；macOS 路径经 `sh_quote` 进 `cd "..."` 后元字符均为字面量，故仅拒控制字符 + 要求路径存在（避免误伤含 `( ) ' \` 的合法 mac 路径）。`launch_project` 的 macOS 临时脚本同样把路径放进 `cd "<sh_quote>"` 双引号内（历史上漏过引号，含空格路径必坏、`;` 可逃逸，勿改回）。
- `open_folder`：explorer.exe / `open`；`check_claude`：`where` / `sh -c "command -v claude"`（均 3 秒超时，阻塞线程池执行不卡 UI）。

## mangle / unmangle（Claude Code 项目目录名解析）

- 正向 `mangle_project_path`：`: \ / _ .` → `-`（如 macOS `/Users/foo/bar` → `-Users-foo-bar`）。
- 反向 `unmangle_candidates` 分平台：Windows 解析 `X--...`（盘符格式），macOS 解析 `-Users-...`（根 `/`），共用 `enum_segment_paths` 枚举歧义候选（层级最多者优先）。
- Claude Code CLI 的项目目录为 `~/.claude/projects`（macOS 同 Linux）；macOS 后备 `~/Library/Application Support/Claude/projects`（**Claude Desktop** 内置 code 的会话目录，仅当 `~/.claude` 缺失且此处存在时使用）；`CLAUDE_CONFIG_DIR` 环境变量（官方自定义数据目录）优先于以上所有。`get_claude_projects_dir` / `scan_claude_projects` 按此优先级定位。

## 功能

- **全局拖拽排序**（`order`）：项目行整行可拖拽调序（顺序即 `config.order` 数组顺序，松手后复用 `save_config` 落盘；重排时以「order 收录项 + 其余按名称」拼出当前全序列，首次拖拽后全部项目都有显式顺序；搜索过滤期间禁用拖拽）。前端用原生 HTML5 DnD——**`tauri.conf.json` 的 `dragDropEnabled: false` 是前提**（默认 true 时 Windows 上 WebView2 的 OLE 拖放处理会拦截页面内 dragover/drop，勿当冗余配置删掉）。右键菜单「移到最前」是同一套全序列语义的快捷入口（项目多时不必从底部拖到顶部）。
- **置顶会话聚合区**（`pinned_sessions`）：会话行左侧图钉按钮置顶/取消置顶，置顶项聚到左栏顶部**跨项目**区域（无置顶项时整块不渲染；带项目名徽标消歧，标题重名可分辨）。条目形如 `{file, projectPath}`：`file` 是会话 jsonl **绝对路径**作稳定锚点（重命名只追加 customTitle 不改文件名、回收站恢复回原路径），`projectPath` 在置顶时刻记录（mangled 目录名反解项目路径是启发式枚举，不可反查）。`list_pinned_sessions` 按清单顺序**实时**解析元数据（不存快照），文件缺失的条目静默跳过不报错；**已置顶会话不再在项目列表中重复显示**（前端按 file 过滤）。语义要点：新置顶插最前、不支持拖拽排序；**删除会话保留条目**（恢复后自动复活），只有彻底删除才清理——`purge_session`/`purge_trash` 后 `prune_dead_pins` 清失效条目，`remove_project`/`purge_claude_project_data` 按 projectPath 撤条目（`drop_pins_for_projects`）。
- **健康检查不阻塞启动**：`list_projects` 的扫描/unmangle/`is_dir` 全在阻塞线程池（`spawn_blocking`）执行，不卡主线程；前端渲染后异步调 `check_projects` 批量回填路径存在性，失效项目自动标红；「健康检查」对话框打开时现场重新检查。
- **窗口聚焦自动刷新**：app 重新获得焦点（终端里跑完 claude 回来、托盘/单实例唤起）时自动刷新**当前展开项目的会话列表 + 置顶区元数据**——新会话/新标题回来即见。`onFocusChanged` **只订阅一次**、回调经 latest-ref（`visibleListsRef`）取最新（refreshSessions 随 items 变化，放进 deps 会反复重订阅且节流窗口被重置）；1.5s 节流防 alt-tab 抖动连刷，失败静默；与回收站 `onChanged` 共用 `refreshVisibleLists`；**查看器内容不自动重载**（正在阅读的会话被追加内容会把滚动位置拽走，保持过期优于打扰阅读，用查看器自带刷新按钮）；项目清单仍按需刷新，聚焦不触发全量 `load()`。
- **本地环境检查（健康检查弹窗内卡片，移植自 cc-switch）**：`claude_update_status` 探测本机 claude 版本（Windows `where claude` 定位后按 .exe > .cmd/.bat > 无扩展名择优——npm 全局目录的无扩展名 sh shim 排在前但不可直接 spawn；过滤 WindowsApps 商店别名；`.cmd/.bat` 经 `cmd /D /S /C call` 执行 `--version`）+ npm registry `/latest` 查最新稳定版，semver 严格比较（latest > current 才「可升级」，预发布/抢跑不误报）；`claude_run_upgrade` 隐藏窗口执行临时脚本：`claude update` 失败兜底 `npm i -g @anthropic-ai/claude-code@latest`（bat errorlevel 链透传，npm 优先取 claude 同目录兄弟文件），输出重定向临时文件、回传尾部 2000 字，前端升级后自动重查版本。
- **批量添加**：扫描 Claude Code 项目目录，`unmangle_candidates` 反解出真实路径并验证存在性，失效项目（`missing`）不参与添加；已在清单中的项目标记跳过。清单存**项目绝对路径**于 `config.projects`。
- **会话管理**：点击项目行展开其 Claude Code 会话列表（异步加载不阻塞 UI）；会话行显示标题 + 相对时间 + 摘要，行首常驻 📌 置顶图钉，悬停 tooltip 显示完整标题（**继续对话/重命名/置顶/删除收进右键菜单**，行上不再放按钮挤占标题宽度；会话行组件 `SessionRow` 由项目内列表与置顶聚合区共用，仅图钉语义与项目名徽标不同；置顶会话从项目列表滤除后若该项目已无可见会话，空态提示「会话已全部置顶」）。`list_sessions(project_path)` 用真实路径正向 mangle 定位 `<projects>/<mangled>/`，对每个 `.jsonl` 只读首尾各 64KB（`LITE_READ_BUF_SIZE`）提取元数据：标题回退链 customTitle > aiTitle > 首条用户消息；**命令消息（如 `/init`）被跳过——只执行命令、无实质对话的会话不进列表**；sidechain/纯元数据会话过滤；按 mtime 倒序。`rename_session(file, new_title)` 安全校验（限 projects 目录下 uuid.jsonl）后向 jsonl **追加** `custom-title` 行（与 Claude Code `/rename` 同机制，不覆盖原文件）。
- **回收站（删除 = 移入回收站）**：`delete_session` 先备份到数据根 `trash/sessions/<时间戳>/<项目>/` 再删除；「🗑 回收站」对话框可 `restore_session` 恢复（移回原目录，Claude Code 可继续 resume）或 `purge_session` / `purge_trash` 永久删除（行内二次确认）。
- **会话内容查看**：左右分栏（左 360px 项目/会话列表，右内容区）。`get_session_messages(file)` 全量读 jsonl 提取 user/assistant 消息（text/thinking/tool_use/tool_result 块，`MAX_SESSION_MESSAGES=500` 截断，过滤 sidechain/isMeta/命令消息），前端聊天式渲染（**思考+工具调用按 Claude Code 终端风格跨消息合并折叠**：连续的思考/工具块折为一个活动组摘要行（如「思考 · 读取 2 个文件 · 执行 1 条命令」，ActivityGroup + activitySummary），点击展开看思考/工具行；工具行展开同时看输入 JSON 与执行结果——结果合并进工具行不再单独成卡，仅无主结果保留独立结果卡；活动组嵌套折叠后搜索跳转会同时展开外层组（`closest("details.activity")`）；围栏代码块等宽）。
- **会话域增强（搜索 / 统计 / 导出 / 文件导航）**：`search_session_messages(file, keyword)` 全文件全文搜索（text 块 + tool_use 输入，跳过 thinking/tool_result，大小写不敏感，上限 `MAX_SEARCH_HITS=200`），命中跳转可跨分页定位（加载含目标消息的页 + `data-msg-index` 滚动 + `data-block-idx` 展开 diff 卡）；`get_session_messages` 返回 `SessionUsageStats`（token 统计：usage 字段新旧两种格式防御式解析，meta 区展示总计/输入/输出/缓存读取）；`export_session(file, dest, format)` 导出 Markdown（`render_session_markdown`：text 原样 / thinking 引用块 / tool_use 摘要行不转储 input / tool_result 截断 200 字符）或 JSONL 原文复制；变更文件面板聚合 Edit/Write/MultiEdit 的 `file_path`（相对路径，按目录分组），点击定位到首见消息并展开对应卡片。
- **使用统计仪表盘**（工具栏「📊 统计」）：`get_usage_stats(tz_offset_minutes)` 逐行解析所有项目 jsonl 聚合 token 用量（单文件全量读入内存后逐行遍历，只提取 usage/timestamp/model，不构造消息）。**扫描范围**（`usage_jsonl_files`，固定深度不递归）＝`<项目>/*.jsonl` 主会话 + `<项目>/<会话 uuid>/subagents/*.jsonl` 子代理 + `<项目>/<会话 uuid>/subagents/workflows/wf_*/*.jsonl` Workflow 子代理（后两层是 Claude Code 新布局：子代理 transcript 独立落盘，漏掉它们会让重子代理的模型少统计近一半）；子代理**文件归属其父会话 id**，会话数按 session_id 去重、不随子代理文件数虚增。**同一 message.id 取代表行**（`better_usage_row`）——流式写入把一次响应拆成多行快照，取**带 `stop_reason` 的收尾行**优先、同为收尾/中间行时取 token 更大者；不能取首行：部分写入次序下前几行 usage 全 0（只有 thinking/text 块），取首行会把整条消息记成 0（实测有会话只剩真实值的 1.3%），也不能逐行相加（成倍虚高）。**日期按本地时区归属**——timestamp 是 UTC，直接截日期会错位一个时区；**每日会话数按「最后活跃日」归属**——跨天会话只计一次，任意日期窗口内每日累加 = 窗口内去重会话数（若按「当天活跃」逐日计入，跨天会话被重复累加，会出现「全部会话数 < 近30天会话数」的反直觉结果）；excluded 项目不计（含其台账历史）；**用量台账（数据根 `stats-ledger.json`）持久累计**——统计口径为**历史累计消耗**，会话删除（回收站/清空/Claude Code 自身清理）后其用量仍保留在统计中，台账建立之前已删除的会话无从恢复；时区变化触发现存文件全量重扫；现存文件 mtime+size 未变时跳过重扫（内存 `USAGE_CACHE` 与台账双层命中）；`LEDGER_VERSION` 不一致（口径变更时 bump）触发一次全量重扫。已知取舍：去重/台账粒度是单文件内，`claude --resume`/compact 拷贝出的新文件（同 message.id）仍会双计。前端弹窗：汇总卡（会话/消息/token）+ token 柱状趋势（近 7 天/30 天/全部切换，**打开默认近 7 天**，只作用汇总与趋势；近 N 天 = **严格日历窗口**——含今天往前 N 个自然日，无用量日计 0 占位，每柱一天；**全部 = 按月聚合**——每柱一个自然月（YYYY-MM），首个有数据的月零填充到当前月，不截断（与汇总卡全期口径一致；月柱 tooltip 会话数用最后活跃日归属，activeSessions 逐日相加是「会话·天」会虚高），趋势图柱距均与日历时间成正比）+ 项目排行（token/会话数排序；**窗口内 0 token 0 会话的项目不显示**——近 N 天没用过的项目不占位，「全部」范围后端只为有会话记录的项目建条目天然无此问题）+ 模型分布（按 token，消息级归属；**窗口内 0 token 的模型不显示**；**`<synthetic>` 占位消息排除**——Claude Code 本地生成的打断应答/API 报错回显，usage 恒 0，扫描时跳过（不计消息数）、聚合出口再滤一次兜底老台账已存条目；每行带**与堆叠段同色的色块**（充当图例，不另设图例块）——本区只给窗口合计，逐日粒度统一由趋势图承担，同一份数据不在两处重复呈现）。**趋势图按模型堆叠**：同一根柱按当日各模型用量分段，**柱高仍是当日总量**——所以不设「总量 / 按模型」双视图（单色柱是它的严格子集：同样高度、更少信息，已删）。`column-reverse` 让用量最大的模型贴底，段内用 `flex-grow` 按 token 比例分配高度；标题行右侧以小字标注「柱高 = 当日总量，分段 = 各模型」。堆叠配色按**当前窗口**用量排名取色，色值引主题变量 `--chart-1..9` 与 `--chart-other` / `--chart-unattributed`：styles.css 的 `:root`（浅色）与 `[data-theme="dark"]`（深色）**各定义一组、序号严格一一对应**（1↔1 … 9↔9），切主题不改变哪个模型是什么颜色。**注意图表段与行内色块都是内联 style，而内联 style 完全可以用 `var()`** —— 初版误以为取不到主题变量，写死了一组「同时兼容浅底 #fff 与深底 #292724」的折中值，饱和度被压到 31%、明度 47%，在浅色主题下发暗沉（已废）。现浅色板 S45/L51、深色板 S50/L62；色相跨冷暖交错排布（陶土/青/金/紫/绿/玫/蓝/棕/松），使堆叠里相邻两段也不易撞色；最强模型恒拿 `--chart-1`（陶土，与 accent 同源）；模型数超 9 时前 9 名上色、其余并成中性色「其他」。**这两项全是前端改动**：后端 `perModel[].perDay`（`RankDayUsage`）一直带着逐日明细，此前只用来算窗口合计、没上时间轴——零后端字段、零台账版本变更、零重扫。**趋势堆叠的「未归属」段**（`UNATTRIBUTED_COLOR`）：当日总量里没有模型明细的差额，来源是历史台账条目——会话文件在 `per_day_model` 字段引入前就被删除，条目永久缺该字段（实测 53 天里 4 天、占总量 0.2%，且只可能来自 v2 之前：`scan_file_usage` 内 `per_day` 与 `per_day_model` 写在同一个 `if let Some(date)` 块里，v2 之后不可能只写其一）。不补这段的话：柱高取当日总量而堆叠段之和偏小，`flex-grow` 归一化会把各模型占比整体悄悄放大（实测单日失真 5.66%），极端情况下某天只有这类条目时整根柱没有可渲染的段、直接从图上消失。**弹窗刷新必须原地更新、不得整块塌缩**：点「刷新」只置 `refreshing`（旧数据继续渲染、面板高度不变，按钮 `disabled` 且文案转「刷新中…」），**绝不能退回首屏那种整块 loading 占位态**——占位态把内容换成一行 `.stats-empty`，而 `.overlay` 是 flex 垂直居中、`.modal` 高度由内容决定，面板会整体塌缩、刷新按钮从鼠标脚下移走，连点的第二下就落到 `.overlay` 上（其 `onMouseDown` = 关闭）把统计面板误关（实测：面板高 1025px → 230px、顶边下移 398px、第二击目标 `DIV.overlay`）。只有首屏无数据时才显示占位；刷新失败同样保留旧数据，错误就近贴在内容顶部（`.stats-error`）。**订阅版 jsonl 无 costUSD，故不做成本统计**。
- **供应商切换（移植自 cc-switch v3.20.1 最小核心）**（顶栏当前供应商 pill）：管理/一键切换 Claude Code 供应商，入口=顶栏 pill（显示当前供应商名）。数据模型 `ProviderInfo { id, name, settingsConfig, websiteUrl?, category? }`，settingsConfig = 切换时**整文件原子替换** `~/.claude/settings.json` 的内容（核心 `env.ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`；写 .tmp→旧文件 .bak→rename，切换前必有备份）。**切换顺序与上游一致**：①回填——live 整文件写回离任供应商（吸收用户在 Claude Code 里的手工修改，失败仅告警不阻塞）②记 current ③sanitize（仅删顶层 apiFormat/openrouterCompatMode 内部键）后写 live。**首启自动导入**：providers 为空且 live 存在 → 整文件收编为 `default` 供应商并置为当前。**保存当前供应商同步写 live**：`provider_save` 保存的条目若是 current，sanitize 后先原子写 live 再落清单——只改清单的话磁盘仍是旧内容，下次切换的回填（指纹一致即整文件吸收）会把旧 live 灌回清单、静默回滚刚保存的修改（模型映射反复「自己变回去」的根源）；非当前条目仅落清单不碰磁盘。后端 `provider.rs`（路径解析 CLAUDE_CONFIG_DIR 优先 > settings.json > 遗留 claude.json；`parse_ccswitch_sql` 定向解析 CC Switch「导出配置」的 SQL 备份——按列名取值不怕列序、`''` 转义、CAST blob 行跳过、仅取 app_type='claude'、is_current 采纳），命令 list/save/delete/switch/import_ccswitch/read_live。前端 ProviderDialog：卡片列表（启用/复制/编辑/删除，当前禁删；**复制**=立即克隆为「xx 副本」不开表单）+ 从 CC Switch SQL 备份导入（去重合并）。Config 新增 `providers`/`current_provider`；**save_config 改为读改写**（原先从参数重建整个 Config，会清掉新增字段——加 Config 字段必须检查此坑）。
- **供应商表单（结构化字段 + JSON 沉底，移植 cc-switch ProviderForm 布局）**：预设模板（仅新增时，PresetPicker：**按名称字母序** collation 排序 + **子序列模糊搜索**如 kfc→Kimi For Coding；`${KEY}` 模板变量实时替换）→ 名称 → API Key（password 输入 + **输入框内嵌眼睛图标**切换明文/密文（Icons.tsx 新增 EyeIcon/EyeOffIcon，Lucide 风格）；非官方预设显示「获取 API Key ↗」经 `open_url` 命令开系统浏览器，Windows 走 explorer 免 cmd 转义）→ 接入地址 → 「高级选项」折叠区 → 配置 JSON textarea（**SSOT 沉底**）。**字段同步**：结构化输入→改 JSON 对应 env 键→序列化回 jsonText（echoRef 打标）；手改 JSON→effect 回读刷新结构化字段，防回声循环。**模型映射 6 行**（默认 ANTHROPIC_MODEL/Sonnet/Opus/Fable/Haiku/子代理 CLAUDE_CODE_SUBAGENT_MODEL）：`fetch_models_for_config` 命令拉 **/v1/models 模型列表**（返回 `{id, ownedBy}`）；**ModelSelect 下拉**=输入框+箭头按钮弹出浮层（搜索框 + 按 ownedBy 分组、缺失归 Other、Other 殿后），点击整值替换（与上游 handleRoleModelChange 一致，[1M] 随之消失），datalist 在 WebView2 下拉失效故弃用；**「声明支持 1M」勾选**=模型值尾部字面 `[1M]` 后缀（has1M/strip1M/set1M 移植上游 CLAUDE_ONE_M_MARKER 语义，**Haiku 行不支持**），从下拉选择/手输的值若带 [1M] 同样成立；模型写入时同步 `_NAME` 显示名键（sonnet/opus/fable/haiku）并删除上游废弃的 `ANTHROPIC_SMALL_FAST_MODEL`。`model_fetch.rs` 候选探测移植上游：base 以版本段 `/v{N}` 结尾拼 `{base}/models`（智谱 paas/v4），命中 /anthropic、/coding 等兼容后缀再追加剥后缀的 `{root}/v1/models`；Bearer 认证；404/405 换下一候选；`{data:[{id,owned_by}]}` 按 id 排序去重。
- **Coding Plan 用量查询**（移植 cc-switch coding_plan 适配器，零配置）：`usage_query.rs` 按供应商 env 的 base_url **探测厂商**（api.kimi.com/coding→Kimi；bigmodel.cn/api.z.ai→智谱；minimaxi/minimax.io→MiniMax；zenmux→ZenMux；opencode.ai/zen/go→OpenCode Go），命中即用其 env 里的密钥查询（命令 `provider_query_usage(id)`，非已知厂商返回 supported=false 前端静默）。各厂商端点/解析逐字段照搬上游：Kimi `GET api.kimi.com/coding/v1/usages` Bearer；智谱 `GET {origin}/api/monitor/usage/quota/limit` **Authorization 无 Bearer 前缀**（unit:3=5h/unit:6=周，unit 缺失走 reset 升级兜底）；MiniMax `coding_plan/remains` 只取 model_remains.general、周桶 status=1 才展示；ZenMux `GET base_url` 本身即用量端点（percentage 0-1 ×100，带 $金额）；OpenCode Go `zen/go/v1/usage` rolling/weekly/monthly、percent=0 丢重置时间。401/403 统一报「认证失败」。HTTP 用 **ureq**（新依赖，阻塞、rustls；同步命令跑 Tauri 线程池）。前端卡片内联用量条：徽标为**中性描边底、颜色只标百分比**（粗体等宽，利用率 <70 绿/<90 橙/其余红，阈值与 Tailwind 色值对齐 cc-switch utilizationColor；名称与倒计时/金额弱化灰显——整块色底会淹没关键数字，这是用户明确要求的信息层级）；重置倒计时 + 单卡刷新按钮；**会话级缓存 stale-while-revalidate**（模块级 usageCache + 5 分钟新鲜期，对话框重开立即显示上次结果并标注后台静默刷新，骨架仅出现在「从未查过」的供应商；厂商探测前端镜像 detectUsageVendor 与 Rust detect_vendor 需同步），无后台轮询；millis→ISO8601 为纯算法实现（不引 chrono）。
- **单实例**（`tauri-plugin-single-instance`）：重复启动不新建进程，回调里 show + unminimize + set_focus + `set_always_on_top` 开关（对抗 Windows 前台锁定，勿当冗余代码删掉）把已有窗口调到前台。
- **按钮与图标体系统一**（新增按钮/图标必须遵循）：① 图标只用 `Icons.tsx` 的 Lucide 线性组件（viewBox 24、stroke=currentColor、strokeWidth=2、round cap/join），**禁止 emoji / 纯字符（× ⋯ ⟳ ▾ ✓ 等）做图标**——新增图标按现有样板写组件，path 取 Lucide 官方源（国内网络用 npmmirror 拉 `lucide-static` tarball，GitHub raw 直连不通）；② 主操作按钮（工具栏/查看器头部）一律「SVG 图标(13px) + 文字」，对话框底部按钮（取消/确定/保存）一律纯文字，行内/卡片紧凑操作用纯图标 + title，菜单项纯文字；③ 变体只有 `btn`/`btn-primary`/`btn-danger`/`btn-sm`——主按钮类名是 **`btn btn-primary`**（历史上出现过两处 `btn primary` 笔误，`.primary` 无样式定义，主按钮会静默降级成描边样式）；④ 字符换 SVG 后居中靠 flex/grid（font-size/line-height 对 svg 失效）：`.tool-icon`/`.inline-icon`（行内文本上下文，inline-flex + vertical-align:-2px）、`.modal-close`/`.search-clear`/`.usage-refresh`（flex 居中）、`.row-icon`（grid place-items 天然支持）；⑤ `FileTextIcon`/`FileDiffIcon` 的文档轮廓沿用仓库既有 `FileIcon` 轮廓（Lucide 新版换了圆角轮廓，同屏混用两代轮廓会露馅，勿单独升级）。
- 其他：深色主题（`dark`）、搜索过滤、右键菜单、全局拖拽排序、置顶会话聚合区、关闭行为可选（`close_action`：询问/退出/最小化到托盘）、系统托盘（显示窗口/退出）。状态存 `config.json`。

## 数据根目录（双模式）

`resolve_root_dir()` 自动区分：

1. **便携模式**：exe 所在目录向上（最多 6 级）查找含 `config.json` 的目录（或旧标记 `claude-claude-fast.bat`）——开发目录、整体移动的文件夹、绿色版走此路径。**去脚本化后 `config.json` 即便携标记**（旧版要求 config.json + scripts/ 双条件，会让没有 scripts/ 的新便携目录静默退到安装模式），但须过 `looks_like_our_config` **内容校验**（JSON 对象，且为空对象或含本项目任一已知字段 order/favorites/projects/excluded/dark/closeAction/providers/currentProvider/pinnedSessions——**给 Config 加字段必须同步 KNOWN_KEYS**；便携判定向上扫 6 级祖先，不校验会把其他工具的 config.json 误认成数据根、首次保存配置将其整文件覆写原件降级 .bak）；config.json + scripts/ 同在的存量目录免校验直接认定；存量 scripts/ 不删，仅供旧脚本迁移解析。
2. **安装模式**：找不到时回退 `%APPDATA%\claude-fast`（macOS `~/Library/Application Support/claude-fast`），首次运行自动创建数据根本身（**不再创建 scripts/**；旧版创建 scripts/ 的副作用——顺带建出数据根、保证首次 save_config 有目录可写——已改为显式 `create_dir_all(app)` 保留）。

## 铁律

- **绝不删除数据根的 `config.json` / `.bak`**——用户的项目清单、排序与置顶会话都在这里。`save_config` 三步保护：写临时文件 → 旧文件备份为 `.bak` → 原子替换；`load_config` 读主文件失败时自动从 `.bak` 回退。
- **config / 台账的读改写必须持锁**：`CONFIG_LOCK`（config.json）/ `LEDGER_LOCK`（stats-ledger.json）是全局 Mutex，所有「load → 改 → save」入口必须先拿锁；持锁期间**严禁调用另一个持锁函数**（std Mutex 不可重入，嵌套即死锁）——这也是 `add_project` 等命令直接调 `save_config_file` 而不走 `save_config` 的原因。
- **会话文件路径校验必须走 canonicalize**：`validate_session_file_in` / `validate_trash_file_in` 对 `path.starts_with(dir)` 前先 canonicalize 双方——`starts_with` 是逐组件词法匹配，不规范化 `..`，单独使用可被 `projects/../evil/<uuid>.jsonl` 穿越。
- ⚠️ **必须用 `npm run tauri build`（或 `npx tauri build`）构建，禁止直接 `cargo build --release`**：只有 tauri CLI 自动加 `--features tauri/custom-protocol`，缺它产物是 dev 模式，运行时连 `http://localhost:1420` 白屏。
- 国内网络首次构建需 crates.io 镜像（用户 `~/.cargo/config.toml` 已配 rsproxy.cn）。
- **新增任何按钮类必须做墨迹居中补偿，并放大目检/实测**（历史规律：每加新按钮都漏这条被用户发现）。中文字体 YaHei 的字形墨迹与行盒中心不重合，偏移方向由 line-height 决定：
  | line-height 设定 | 墨迹偏移 | 补偿（总高不变） | 已验证基准类 |
  |---|---|---|---|
  | `1`（配合 inline-flex 居中） | 偏上 ~1px | **padding-top +1 / bottom −1** | `.btn`（`10px 14px 8px`）、`.icon-btn`、`.pill` |
  | 不设（normal） | 偏下 1~2px | **padding-top −1~−2 / bottom 相应加** | `.stats-range button`（`5px 12px 7px`）、`.stat-sort button`（`1px 10px 3px`） |
  | `0`（配合 grid place-items） | 无偏移 | 无需补偿 | `.row-icon` |

  规则：① 新按钮必须 `inline-flex + align/justify-content: center` 或 `grid + place-items: center`（禁止单靠默认 inline 排版）；② 按上表加不对称 padding 并写注释「墨迹补偿，勿改对称」；③ 例外：`⚙` 齿轮等字形本身歪的另加 `transform` 微调（参考 `.icon-gear`）；④ **已补偿的类严禁改回对称 padding**；⑤ 验证方式：DPR 整数倍截图后放大看上下空隙，或 CDP `Page.captureScreenshot` + 像素扫描墨迹 bbox（上下空隙差 ≤1px 为达标）。

## 开发命令

```bash
npm install                  # 前端依赖
npm run tauri dev            # 开发模式（热更新）
cd src-tauri && cargo test   # 后端单元测试（全平台共 154 个定义，Windows 实测 148 个：路径解析/配置/扫描/根目录定位/会话管理/mangle/sh_quote/回收站/台账/供应商/模型拉取/版本升级；差额为平台条件用例）
npm run tauri build          # 生产构建
# macOS 通吃包（Intel + Apple Silicon）：npm run tauri build -- --target universal-apple-darwin
```

构建产物：Windows 为 NSIS 安装包（`src-tauri/target/release/bundle/nsis/Claude助手_<版本>_x64-setup.exe`，`installMode: perMachine`、安装界面中英双语、免管理员），安装到 `%LOCALAPPDATA%\Programs\Claude助手`；macOS 为 `bundle/macos/Claude助手.app` 与 `bundle/dmg/*.dmg`。便携 exe 从 `src-tauri/target/release/` 复制（须与 config.json 同层——放一个空对象 `{}` 或从旧数据目录拷来的 config.json 即被识别为便携模式，scripts/ 不再需要）。
