# CC Desktop（claude-fast）

一键在项目目录启动 Claude Code 的桌面应用：**Tauri 2 + React + TypeScript（前端）+ Rust（后端）**，Windows + macOS 双平台，不限定工作区目录。

> **版本线**：`v2.0.0` 分支 = app 内直接对话（版本号 **2.0.0**，`package.json` / `Cargo.toml` / `tauri.conf.json` 三处一致）；`v1.0.0` 分支 = 纯查看器/启动器（版本号 1.0.0）。历史上的 PowerShell/WinForms 版与旧 v2.x/v3.x 版号均已作废，代码中不要再按旧版本号理解。另有 **Node.js（Electron）后端重构分支** `claude-fast-electron`（见下「分支结构」）。
>
> **去脚本化（重要）**：项目清单为**路径模型**——`config.json` 的 `favorites`/`projects` 存的都是**项目绝对路径**（不再是脚本名），右键菜单「在终端中启动」直接 `cmd /k cd /d "项目" && claude`，**不再生成/执行 scripts/ 启动脚本**。旧版脚本在首次启动时被自动解析迁移（`ensure_projects_migrated`，幂等）。项目列表 = Claude 会话目录扫描（unmangle 反解）∪ config.projects 手动清单。

## 分支结构（双后端）

| 分支 | 后端 | 说明 |
|---|---|---|
| `v2.0.0`（当前，版本号 2.0.0） | **Tauri 2 + Rust** | 主版本线：v1.0.0 的查看器/启动器 + app 内直接对话（chat.rs），后端在 `src-tauri/` |
| `v1.0.0` / `main` | **Tauri 2 + Rust** | 纯查看器/启动器（无 app 内对话），后端在 `src-tauri/` |
| `claude-fast-electron` | **Electron + Node.js** | Node 重构后端服务的分支（自 `f76a56f` 分叉）：**前端技术栈不变**（React + TS + Vite），后端改为 `electron/main.ts`（主进程/窗口/托盘/IPC）+ `electron/backend/*.ts`（业务模块：paths/scriptnames/config/mangle/sessions/trash/platform/text，vitest 单测）；构建走 npm（vite + esbuild + electron-builder）。细节见该分支的 CLAUDE.md / README.md |

两分支各自独立演进，**去脚本化（路径模型）与「从列表移除 → excluded 排除清单」已在两端对齐**；不要跨分支混用实现细节（IPC 通道、构建命令、配置读写互不通用），在 `claude-fast-electron` 分支工作时以其分支内 CLAUDE.md 为准。

## 核心文件

| 文件 | 作用 |
|---|---|
| `src/` | 前端：React + TypeScript + Vite。`App.tsx` 状态管理；`src/components/` UI 组件（对话框/列表/会话页 ChatView 等）；`MessageParts.tsx` 是消息渲染共享组件（活动组/工具行/diff 卡）；`src/lib/api.ts` 封装全部 Tauri invoke |
| `src-tauri/src/lib.rs` | 后端：绝大部分 commands 与单元测试在此。项目清单系：`list_projects`/`add_project`/`remove_project`/`launch_project`/`check_projects`；一次性迁移：`ensure_projects_migrated` |
| `src-tauri/src/chat.rs` | 后端：**app 内直接对话**——托管官方 claude CLI 子进程（stdio stream-json 模式）+ 消息翻译层（StreamAssembler）+ 5 个 `chat_*` 命令与翻译层单测 |
| `README.md` | 使用说明、构建方法 |

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe、scripts、config.json——这些运行时产物/用户数据都在数据根目录（见「数据根目录」）。

## 启动与项目清单（去脚本化）

- **不再生成/执行启动脚本**：右键项目「▶ 在终端中启动 Claude Code」新开终端执行 `cmd /k cd /d "项目路径" && claude`（Windows ShellExecuteW；macOS 临时 sh + Terminal.app），claude 退出后窗口保留。项目行只留 💬（app 内对话）与 ⋯（右键菜单等效），终端启动收进右键菜单。
- 项目列表 = **Claude 会话目录扫描**（`~/.claude/projects` unmangle 反解）∪ `config.projects`（手动添加的项目路径），按路径去重；收藏（favorites）存项目绝对路径。
- 「移除」= 从清单移除项目（不删磁盘文件）；「批量添加」= 把扫描到的项目加入清单。
- 旧版启动脚本（`scripts/claude-*.bat|sh`）在首次启动时被 `ensure_projects_migrated` 自动解析迁移（key → 路径），脚本文件保留在磁盘不自动删除。
- 健康检查（`check_projects`）直接检查项目路径是否存在。

## 跨平台层

- `script_ext()` 返回 bat/sh；`legacy_marker()` 兼容旧标记 `claude-claude-fast.<ext>`；`parse_cd_path` 兼容 `cd /d` 与 `cd "/path"` 两种语法。
- `launch_claude`：Windows 走 `ShellExecuteW` 开 cmd（Rust `Command` args 的引号会被 cmd 误解析，必须 ShellExecuteW）；macOS 走 `open -a Terminal`。
- `resume_session(file, project_path)`：新开终端窗口执行 `claude --resume <session-id>`。Windows 用 `build_resume_cmdline` 拼防注入命令行；macOS 写临时 .sh 到系统临时目录再 `open -a Terminal`（无需 osascript 自动化权限）。共用 `validate_resume_path`，但平台规则不同：Windows 拒绝 cmd 元字符；macOS 路径经 `sh_quote` 进 `cd "..."` 后元字符均为字面量，故仅拒控制字符 + 要求路径存在（避免误伤含 `( ) ' \` 的合法 mac 路径）。
- `open_folder`：explorer.exe / `open`；`check_claude`：`where` / `sh -c "command -v claude"`（均 3 秒超时，阻塞线程池执行不卡 UI）。

## mangle / unmangle（Claude Code 项目目录名解析）

- 正向 `mangle_project_path`：`: \ / _ .` → `-`（如 macOS `/Users/foo/bar` → `-Users-foo-bar`）。
- 反向 `unmangle_candidates` 分平台：Windows 解析 `X--...`（盘符格式），macOS 解析 `-Users-...`（根 `/`），共用 `enum_segment_paths` 枚举歧义候选（层级最多者优先）。
- Claude Code CLI 的项目目录为 `~/.claude/projects`（macOS 同 Linux）；macOS 后备 `~/Library/Application Support/Claude/projects`（**Claude Desktop** 内置 code 的会话目录，仅当 `~/.claude` 缺失且此处存在时使用）；`CLAUDE_CONFIG_DIR` 环境变量（官方自定义数据目录）优先于以上所有。`get_claude_projects_dir` / `scan_claude_projects` 按此优先级定位。

## 功能

- **收藏置顶**（`favorites`）：点星标或右键收藏，金色置顶。已收藏项可**整行拖拽排序**（顺序即 `favorites` 数组顺序，松手后复用 `save_config` 落盘；按 key 重排非索引，失效 key 原位保留；搜索过滤期间禁用拖拽；未收藏行不可拖拽）。前端用原生 HTML5 DnD——**`tauri.conf.json` 的 `dragDropEnabled: false` 是前提**（默认 true 时 Windows 上 WebView2 的 OLE 拖放处理会拦截页面内 dragover/drop，勿当冗余配置删掉）。
- **健康检查不阻塞启动**：`list_launchers` 只解析脚本内容不做目录 stat（秒返回）；前端渲染后异步调 `check_launchers` 并行检查，失效目录自动标红；「健康检查」对话框打开时现场重新检查。
- **批量添加**：扫描 Claude Code 项目目录，`unmangle_candidates` 反解出真实路径并验证存在性，失效项目（`missing`）不参与添加；已在清单中的项目标记跳过。清单存**项目绝对路径**于 `config.projects`。
- **app 内直接对话**（项目行 💬 / 点击会话行）：后端 `chat.rs` spawn 官方 `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --permission-mode <mode>`（新对话 `--session-id <uuid>`，续聊 `--resume <id>`），stdin 发消息、stdout 逐行翻译成 ChatEvent 经 Tauri `ipc::Channel` 推给前端 `ChatView` 流式渲染（文本/思考/工具调用/工具结果，渲染组件在 MessageParts 共用）。**权限模式**：输入区下拉 5 种（手动确认 manual【原 default，每工具都问】/自动 auto/接受编辑 acceptEdits/计划 plan/完全权限 bypassPermissions），与终端 Shift+Tab 交互循环对齐；`--permission-mode` 还合法取值 dontAsk（会触发确认的操作直接拒绝）但不在终端循环里（程序化用），故不进下拉、后端白名单仍放行——进程未启动时作为 spawn 初始模式，已启动经 `chat_set_permission_mode`（control 协议 `set_permission_mode`）热切换，CLI 回执失败经翻译层变 Error 事件 toast。manual 模式下权限确认走 control 协议：CLI 发 `can_use_tool` → app 内卡片允许/拒绝 → `control_response`（拒绝由 CLI 作为 tool_result 喂回模型，不中断会话）；中断 = `control_request interrupt`。懒启动：首条消息才 spawn 进程（用 CLI 默认模型，不做模型选择）。**多会话 tab 并行**：App 维护 chats 数组（后端 ChatManager 的 HashMap 本就支持多进程并存），全部 ChatView 保持挂载、非激活页 display:none——切换不关进程、后台继续流式；tab 栏（ChatTabs）显示标题 + 进行中状态点（ChatView 经 onStatusChange 上报 thinking/starting）+ × 关闭；**tab 右键菜单**：关闭其他会话（保留当前 tab，进行中 thinking/starting 的会话跳过不关）/ 关闭所有会话（两者均跳过进行中 thinking/starting 的会话；closeOtherChats/closeAllChats 批量处理器，逐个优雅关闭并刷新对应项目会话列表）；续聊同一会话不允许开两个进程（会分叉历史），只激活已有 tab；关闭 tab（卸载 ChatView → unmount 优雅关闭进程）后刷新该项目会话列表。对话记录由 CLI 落盘 `~/.claude/projects` 原生 jsonl → 自动进入会话列表、终端可 resume；退出 app 时 `RunEvent::Exit` 里 `ChatManager::stop_all` 清理全部子进程（关 stdin 优雅退出，超时强杀）。Windows 下 claude 可执行文件需 `where claude` 解析全路径并按 `.exe` > `.cmd`/`.bat` 优先级挑选（`Command::new("claude")` 不解析 .cmd，无扩展名 sh 垫片会报 os error 193），结果 OnceLock 缓存。
- **会话管理**：点击项目行展开其 Claude Code 会话列表（异步加载不阻塞 UI）；会话行显示标题 + 相对时间 + 摘要，**点击会话行 = 直接在 app 内继续对话**（ChatView，原会话查看页已并入），悬停仅 🗑 删除，**右键菜单收着：在终端中继续对话 / 重命名**（SessionContextMenu）。`list_sessions(project_path)` 用真实路径正向 mangle 定位 `<projects>/<mangled>/`，对每个 `.jsonl` 只读首尾各 64KB（`LITE_READ_BUF_SIZE`）提取元数据：标题回退链 customTitle > aiTitle > 首条用户消息；**命令消息（如 `/init`）被跳过——只执行命令、无实质对话的会话不进列表**；sidechain/纯元数据会话过滤；按 mtime 倒序。`rename_session(file, new_title)` 安全校验（限 projects 目录下 uuid.jsonl）后向 jsonl **追加** `custom-title` 行（与 Claude Code `/rename` 同机制，不覆盖原文件）。
- **回收站（删除 = 移入回收站）**：`delete_session` 先备份到数据根 `trash/sessions/<时间戳>/<项目>/` 再删除；「🗑 回收站」对话框可 `restore_session` 恢复（移回原目录，Claude Code 可继续 resume）或 `purge_session` / `purge_trash` 永久删除（行内二次确认）。
- **会话页 = 对话 + 内容查看二合一（ChatView，原 SessionViewer 已删）**：左右分栏（左 320px 项目/会话列表，右会话页）。会话页分两段渲染——**历史 jsonl 段**（`get_session_messages(file)` 读取，text/thinking/tool_use/tool_result 块，`MAX_SESSION_MESSAGES=500` 截断，过滤 sidechain/isMeta/命令消息；顶部「加载更早」向上分页）+ **实时流段**（本次 sitting 的流式消息追加其后）；「刷新」重读 jsonl 并清空实时区（jsonl 为唯一事实来源，对话进行中禁用）。原查看页功能全在：**搜索**（`search_session_messages` 防抖全文搜索、命中跨分页跳转定位并展开外层活动组）、**变更文件面板**（聚合 Edit/Write/MultiEdit，历史可定位、实时消息暂不可定位）、**导出**（Markdown/JSONL，仅已有 jsonl 的会话）、**token 统计**（头部展示 jsonl 累计 + 「本次」实时用量）。渲染为 Claude Code 终端风格：**历史与实时合成一条统一渲染流，活动组跨消息合并**——jsonl 里一轮工具循环拆成多条 assistant 消息，若按单条消息分组会出现「思考·读取→搜索→思考」碎行，故从一次文本输出到下一次文本输出之间的所有思考/工具折成同一组摘要行（「思考 · 读取 2 个文件 · 执行 1 条命令」，ActivityGroup + activitySummary），点击展开；工具行展开同时看输入 JSON 与执行结果（结果合并进工具行，仅无主结果独立成卡）；围栏代码块等宽。状态徽标仅在 启动中/思考中/已退出 时显示（未开始不显示）。新对话（无 jsonl）只有实时段，头部功能按钮隐藏。
- **会话域增强（搜索 / 统计 / 导出 / 文件导航）**：`search_session_messages(file, keyword)` 全文件全文搜索（text 块 + tool_use 输入，跳过 thinking/tool_result，大小写不敏感，上限 `MAX_SEARCH_HITS=200`），命中跳转可跨分页定位（加载含目标消息的页 + `data-msg-index` 滚动 + `data-block-idx` 展开 diff 卡）；`get_session_messages` 返回 `SessionUsageStats`（token 统计：usage 字段新旧两种格式防御式解析，meta 区展示总计/输入/输出/缓存读取）；`export_session(file, dest, format)` 导出 Markdown（`render_session_markdown`：text 原样 / thinking 引用块 / tool_use 摘要行不转储 input / tool_result 截断 200 字符）或 JSONL 原文复制；变更文件面板聚合 Edit/Write/MultiEdit 的 `file_path`（相对路径，按目录分组），点击定位到首见消息并展开对应卡片。
- **使用统计仪表盘**（工具栏「📊 统计」）：`get_usage_stats(tz_offset_minutes)` 流式扫描所有项目 jsonl 聚合 token 用量（只提取 usage/timestamp/model，不构造消息；**按 message.id 去重**——流式写入把一次响应拆成多行、每行带同一份 usage，不去重会成倍虚高；**sidechain 子代理消息也计入**；**单日按本地时区归属**——timestamp 是 UTC，直接截日期会错位一个时区；**每日会话数按「最后活跃日」归属**——跨天会话只计一次，任意日期窗口内每日累加 = 窗口内去重会话数（若按「当天活跃」逐日计入，跨天会话被重复累加，会出现「全部会话数 < 近30天会话数」的反直觉结果）；excluded 项目不计（含其台账历史）；**用量台账（数据根 `stats-ledger.json`）持久累计**——统计口径为**历史累计消耗**，会话删除（回收站/清空/Claude Code 自身清理）后其用量仍保留在统计中，台账建立之前已删除的会话无从恢复；时区变化触发现存文件全量重扫；现存文件 mtime+size 未变时跳过重扫（内存 `USAGE_CACHE` 与台账双层命中））。前端弹窗：汇总卡（会话/消息/token）+ 每日 token 柱状趋势（近 7 天/30 天/全部切换，只作用汇总与趋势；近 N 天 = **严格日历窗口**——含今天往前 N 个自然日，无用量日计 0 占位，趋势图柱距与日历时间成正比）+ 项目排行（token/会话数排序）+ 模型分布（按 token，消息级归属）。**订阅版 jsonl 无 costUSD，故不做成本统计**。
- **单实例**（`tauri-plugin-single-instance`）：重复启动不新建进程，回调里 show + unminimize + set_focus + `set_always_on_top` 开关（对抗 Windows 前台锁定，勿当冗余代码删掉）把已有窗口调到前台。
- 其他：深色主题（`dark`）、搜索过滤、右键菜单、新建/删除启动脚本、关闭行为可选（`close_action`：询问/退出/最小化到托盘）、系统托盘（显示窗口/退出）。状态存 `config.json`。

## 数据根目录（双模式）

`resolve_root_dir()` 自动区分：

1. **便携模式**：exe 所在目录向上（最多 6 级）查找含 `config.json` + `scripts/` 的目录（或旧标记 `claude-claude-fast.bat`）——开发目录、整体移动的文件夹、绿色版走此路径。
2. **安装模式**：找不到时回退 `%APPDATA%\claude-fast`（macOS `~/Library/Application Support/claude-fast`），首次运行自动创建 `scripts/`。

## 铁律

- **绝不删除数据根的 `config.json` / `.bak`**——用户收藏在这里。`save_config` 三步保护：写临时文件 → 旧文件备份为 `.bak` → 原子替换；`load_config` 读主文件失败时自动从 `.bak` 回退。
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
cd src-tauri && cargo test   # 后端单元测试（85 个：路径解析/脚本生成/配置/扫描/根目录定位/会话管理/mangle/sh_quote/对话翻译层）
npm run tauri build          # 生产构建
# macOS 通吃包（Intel + Apple Silicon）：npm run tauri build -- --target universal-apple-darwin
```

构建产物：Windows 为 NSIS 安装包（`src-tauri/target/release/bundle/nsis/CC Desktop_<版本>_x64-setup.exe`，`installMode: perMachine`、安装界面中英双语、免管理员），安装到 `%LOCALAPPDATA%\Programs\CC Desktop`；macOS 为 `bundle/macos/CC Desktop.app` 与 `bundle/dmg/*.dmg`。便携 exe 从 `src-tauri/target/release/` 复制（须与 config.json/scripts 同层）。
