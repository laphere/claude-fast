# CC Desktop（claude-fast）

一键在项目目录启动 Claude Code 的桌面应用：**Electron（Node.js 后端）+ React + TypeScript（前端）+ Vite**，Windows + macOS 双平台，不限定工作区目录。

> **版本线**：仓库已重新规划，当前全部代码为 **v1.0.0**（`package.json` 版本号）。历史上的 PowerShell/WinForms 版、Tauri/Rust 版与 v2.x/v3.x 旧版号均已作废，代码中不要再按旧版本号理解。

## 核心文件

| 文件 | 作用 |
|---|---|
| `src/` | 前端：React + TypeScript + Vite。`App.tsx` 状态管理；`src/components/` 15 个 UI 组件（对话框/列表/会话查看器等）；`src/lib/api.ts` 封装全部 preload 桥调用（`window.claudeFast`） |
| `electron/main.ts` | Electron 主进程：窗口 / 托盘 / 单实例 / 关闭拦截 / 全部 IPC 命令注册 |
| `electron/preload.ts` | `contextBridge` 白名单 API（渲染进程无 Node 权限，全部经 `ipcRenderer.invoke`） |
| `electron/backend/` | 后端业务模块：`paths.ts`（数据根定位/内容校验/进程内缓存 + 项目目录）、`config.ts`（配置模型 + 三步保护 + 读改写 + 写串行化）、`chat.ts`（**app 内对话层**：官方 Agent SDK 托管 + 流式事件翻译 + 多会话/权限/方案/提问/图片）、`provider.ts`（供应商切换，含 CC Switch SQL 导入）、`model-fetch.ts`（供应商模型列表拉取）、`usage-query.ts`（Coding Plan 用量）、`claude-update.ts`（本机 claude 版本检查与升级）、`usage-stats.ts`（全局用量台账）、`session-extra.ts`（会话搜索/进度轨/导出/失效项目数据清除/置顶清单）、`mangle.ts`（目录名正反解析）、`sessions.ts`（会话列表/元数据/内容解析/重命名）、`trash.ts`（回收站）、`platform.ts`（启动/健康检查/resume/批量扫描/旧脚本迁移）、`scriptnames.ts`（脚本时代遗留，仅 `platform.ts` 引用它）、`text.ts`（标题清洗） |
| `electron/backend/chat.ts` | **对话层不用移植 `v2.0.0` 的 `chat.rs`**，改用官方 `@anthropic-ai/claude-agent-sdk`（0.3.278，与 CLI 2.1.278 同版）。运行时**动态 `import()`**（ESM-first，见下方「打包」），`import type` 拿类型（编译期擦除）。要点：懒启动、多会话并行、6 档权限（`manual`→CLI 的 `default`）、`canUseTool` 权限/方案/提问、`interrupt()` 中断、图片 base64（≤4.5MB）、`pathToClaudeCodeExecutable` 跟随本机 `bin\claude.exe` |
| `tools/` | 构建脚本：`dev.mjs`（并行 vite + electron）、`build-electron.mjs`（esbuild 编译主进程） |
| `build/` | 打包图标（icon.ico / icon.png / icon.icns） |
| `README.md` | 使用说明、构建方法 |

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe、scripts、config.json——这些运行时产物/用户数据都在数据根目录（见「数据根目录」）。

## 启动脚本约定

- 每个 `claude-*.bat`（Windows）/ `claude-*.sh`（macOS）内容固定：`cd` 到项目路径 → 检查 `claude` 命令 → 启动 `claude`，统一生成到数据根 `scripts/`。
- Windows **必须写 `call claude` 而不是 `claude`**：`claude` 是 `claude.cmd` shim，批处理调用其他 .cmd 不加 `call` 时 cmd 不返回，错误处理不执行。bat 约定：UTF-8 编码、CRLF 换行、`chcp 65001` 后输出中文、出错 `pause` 保留窗口。
- macOS `.sh` 模板（`genSh`）：`#!/bin/bash` + `fail()` 函数（提示+等回车）+ `cd "/路径" || fail` + `command -v claude` 检查 `|| fail` + `exec claude`；路径经 `shQuote` 转义（`\` `"` `$` 反引号）防注入；写脚本后自动 `chmod +x`。
- 脚本里的目录路径是**绝对路径**（项目移动后需同步修改脚本）。

## 跨平台层

- `scriptExt()` 返回 bat/sh；`legacyMarker()` 兼容旧标记 `claude-claude-fast.<ext>`；`parseCdPath` 兼容 `cd /d` 与 `cd "/path"` 两种语法（现供旧脚本迁移解析用）。
- **启动/resume 必须经 `cmd /c start` 链**（`spawnStartChain`）：`start "Claude Code" /d "<项目>" cmd /k claude [--resume <id>]`。⚠️ Electron GUI 主进程（无控制台）+ `stdio:"ignore"` 直接 spawn cmd 时，Windows **不分配新 console**（windowsHide/detached 均救不了；`detached` 反而触发 claude 2.x bash 探测弹多窗）——claude 拿不到 TTY 静默退出、无任何窗口（2026-09 实测根因）。`start` 用 CREATE_NEW_CONSOLE 新开终端、走系统默认终端委托；外层 cmd `/c` 无窗口立即退出。verbatim 传参仍必须（cmd 不认 MSVC 转义的 `\"`）。
- `resumeSession(file, projectPath, projectsDir)`：新开终端窗口执行 `claude --resume <session-id>`。Windows 走 `buildResumeCmdline` 的 start 链；macOS 写临时 .sh 到系统临时目录再 `open -a Terminal`（无需 osascript 自动化权限）。共用 `validateResumePath`，平台规则不同：Windows 拒绝 cmd 元字符；macOS 路径经 `shQuote` 进 `cd "..."` 后元字符均为字面量，故仅拒控制字符 + 要求路径存在（避免误伤含 `( ) ' \` 的合法 mac 路径）。
- `openFolder`：explorer.exe / `open`；`checkClaude`：`where` / `sh -c "command -v claude"`（均 3 秒超时，Promise 不阻塞渲染）。
- `checkClaude`/`checkLaunchers` 等 spawn 系函数 Windows 一律 `windowsHide: true`，防止后台命令闪黑窗（注意：这只影响探测类调用，启动终端必须走上面的 start 链）。

## mangle / unmangle（Claude Code 项目目录名解析）

- 正向 `mangleProjectPath`：`: \ / _ .` → `-`（如 macOS `/Users/foo/bar` → `-Users-foo-bar`）。
- 反向 `unmangleCandidates` 分平台：Windows 解析 `X--...`（盘符格式），macOS 解析 `-Users-...`（根 `/`），共用 `enumSegmentPaths` 枚举歧义候选（层级最多者优先；段过多 >5 降级防组合爆炸）。
- Claude Code CLI 的项目目录为 `~/.claude/projects`（macOS 同 Linux）；macOS 后备 `~/Library/Application Support/Claude/projects`（**Claude Desktop** 内置 code 的会话目录，仅当 `~/.claude` 缺失且此处存在时使用）；`CLAUDE_CONFIG_DIR` 环境变量（官方自定义数据目录）优先于以上所有。`getClaudeProjectsDir` / `scanClaudeProjects` 按此优先级定位。

## 功能

- **配置模型（`config.json`）**：`order`（项目显示顺序，项目绝对路径数组；未收录项按名称追加在后）、`projects`（手动添加的项目路径，与会话扫描结果取并集）、`excluded`（从列表移除的项目路径，扫描会重新发现它们，必须靠它排除）、`dark`、`closeAction`、`providers` / `currentProvider`（供应商切换）、`pinnedSessions`（置顶会话，条目 `{file, projectPath}`：`file` 是会话 jsonl 绝对路径作稳定锚点，`projectPath` 在置顶时刻记录）。
  - **兼容层 `favorites`**：本分支历史上的「收藏置顶」（顺序即显示顺序）。保留读写是为了不给当前 UI 造成回归，读取时在 `order` **键缺失**的情况下用它当 `order` 初值（显式写出的空 `order` 不会被覆盖回来）。前端切到 `order` 后删除该字段。
  - `providers` / `pinnedSessions` 目前只有**数据模型与清理助手**（`dropPinsForProjects` / `pruneDeadPins`），对应的命令与 UI 待实现。
- **收藏置顶**（`favorites`）：点星标或右键收藏，金色置顶。已收藏项可**整行拖拽排序**（顺序即 `favorites` 数组顺序，松手后复用 `saveConfig` 落盘；按 key 重排非索引，失效 key 原位保留；搜索过滤期间禁用拖拽；未收藏行不可拖拽）。前端用原生 HTML5 DnD——主进程的 **`will-navigate` 拦截是前提**（Electron 渲染层默认拖文件/链接会导航离开页面，`main.ts` 里 `webContents.on("will-navigate", e => e.preventDefault())` 与 `setWindowOpenHandler` deny 保证页面内 dragover/drop 可用，勿当冗余代码删掉）。
- **健康检查不阻塞启动**：`listLaunchers` 只解析脚本内容不做目录 stat（秒返回）；前端渲染后异步调 `checkLaunchers` 并行检查，失效目录自动标红；「健康检查」对话框打开时现场重新检查。
- **批量添加**：扫描 Claude Code 项目目录，`unmangleCandidates` 反解出真实路径并验证存在性，失效项目（`missing`）不参与生成。命名**无工作区概念**：任何路径统一用叶子目录名（如 `myapp` → `claude-myapp.bat`）；同名自动加序号（`claude-myapp-2.bat`，`pickUniqueScriptPath`），**绝不覆盖**其他项目的脚本。
- **会话管理**：点击项目行展开其 Claude Code 会话列表（异步加载不阻塞 UI）；会话行显示标题 + 相对时间 + 摘要，悬停出现 ✎ 重命名、🗑 删除。`listSessions(projectPath)` 用真实路径正向 mangle 定位 `<projects>/<mangled>/`，对每个 `.jsonl` 只读首尾各 64KB（`LITE_READ_BUF_SIZE`）提取元数据：标题回退链 customTitle > aiTitle > 首条用户消息；**命令消息（如 `/init`）被跳过——只执行命令、无实质对话的会话不进列表**；sidechain/纯元数据会话过滤；按 mtime 倒序。`renameSession(file, newTitle)` 安全校验（限 projects 目录下 uuid.jsonl）后向 jsonl **追加** `custom-title` 行（与 Claude Code `/rename` 同机制，不覆盖原文件）。
- **回收站（删除 = 移入回收站）**：`deleteSession` 先备份到数据根 `trash/sessions/<时间戳>/<项目>/` 再删除；「🗑 回收站」对话框可 `restoreSession` 恢复（移回原目录，Claude Code 可继续 resume）或 `purgeSession` / `purgeTrash` 永久删除（行内二次确认）。
- **会话内容查看**：左右分栏（左 320px 项目/会话列表，右内容区）。`getSessionMessages(file)` 全量读 jsonl 提取 user/assistant 消息（text/thinking/tool_use/tool_result 块，`MAX_SESSION_MESSAGES=500` 截断，过滤 sidechain/isMeta/命令消息），前端聊天式渲染（思考/工具调用/工具结果 `<details>` 折叠、围栏代码块等宽）。
- **单实例**（`app.requestSingleInstanceLock()`）：重复启动不新建进程，`second-instance` 回调里 show + restore + focus + `setAlwaysOnTop` 开关（对抗 Windows 前台锁定，勿当冗余代码删掉）把已有窗口调到前台。
- **关闭行为**：主进程拦截窗口 `close`（`e.preventDefault()` + 向渲染层发 `window:close-requested`），前端按 `closeAction` 分发：`quit` → `destroyWindow`（绕过拦截）、`minimize` → `hideWindow`（托盘）、未设置 → 弹窗询问。托盘菜单「退出程序」与 `quitApp` IPC 走 `quitting` 标志绕过拦截直接退出。
- 其他：深色主题（`dark`）、搜索过滤、右键菜单、新建/删除启动脚本、开机自启动（`app.setLoginItemSettings`：Windows 注册表 Run 项 / macOS 登录项）、系统托盘（左键显示窗口/右键菜单：显示窗口+退出；**不能用 `setContextMenu`**——Windows 上设置后左键单击也会弹菜单，会顶掉「左键显示窗口」）。状态存 `config.json`。

## 数据根目录（双模式）

`resolveRootDir(exePath)` 自动区分，**判定语义与 `v2.0.0` 的 `resolve_root_dir` 逐条对齐**（同一便携目录必须被两个 app 认成同一个根）：

1. **便携模式**：exe 所在目录向上（最多 6 级）查找首个数据根标记——开发目录、整体移动的文件夹、绿色版走此路径。
   唯一标记 `isRootDir(dir)` = `config.json` 或 `config.json.bak` 过 `looksLikeOurConfig` **内容校验**：须为 JSON 对象，且**空对象**（`{}` 是用户显式引导便携模式的正规姿势）**或命中 ≥2 个**已知字段。
   - 已知字段表 `KNOWN_CONFIG_KEYS` 必须与 `v2.0.0` 的 `KNOWN_KEYS` **逐字同表**（`order`/`projects`/`excluded`/`dark`/`closeAction`/`providers`/`currentProvider`/`pinnedSessions`）——给 Config 加字段两端同步加，否则同一个目录会被判成不同结果。
   - **为什么是「≥2」而不是「≥1」**：`projects`/`dark`/`order`/`excluded` 都是通用词，只撞 1 个键就会把别的工具的 config.json 认成数据根，认领后任意一次保存都会把它整份覆写（原件只降级成 `.bak`）。≥2 不误杀自家配置：序列化器不跳过空字段，落盘永远写全 8 个键。
   - **`.bak` 支是必需的**：主文件损坏/被删正是 .bak 存在的意义，根判定若先一步放弃该目录，会静默换根——用户看到空清单，数据其实都在原地。
2. **安装模式**：找不到便携标记时回退 `%APPDATA%\claude-fast`（macOS `~/Library/Application Support/claude-fast`），并现场创建**数据根本身**（保证首次保存有目录可写）。`installMode` 只表示「没找到便携标记」——便携根通常是 exe 的祖先目录，拿 `root !== exeDir` 判模式必然误判。

**解析结果进程内缓存**（`paths.ts` 的 `ROOT_CACHE`，按 exe 路径分键）：根在进程生命周期内不变，缓存消掉两个隐患——① 判定是 read+parse 级，单次瞬态读失败（杀软保存后独占扫描/云盘占位未水合/网络盘瞬断）会让同一会话内不同命令落到**不同的根**（load 读到空清单、save 写进另一个目录，表现为「清单自己清空又自己回来」）；② 每条命令都重扫祖先目录。单测用 `resetRootCache()` 清缓存，`resolveRootFrom(startDir)` 是不带缓存的纯查找（供单测直接打深度与「首个命中即返回」语义）。

## Agent SDK 验证结论（2026-09-20 实测）

app 内对话层改用官方 `@anthropic-ai/claude-agent-sdk` 前必须先确认的四条，已全部实测。环境：CLI `2.1.278`（`E:\DevTool\node18-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`）、SDK `0.3.278`（`claudeCodeVersion` 也标 2.1.278）。探针脚本在系统临时目录 `%TEMP%\plan-probe\`（基线）与 `%TEMP%\sdk-probe\`（SDK 对照），**不属源码库、不随分支提交**。

### 1. `ExitPlanMode` / `AskUserQuestion` 能经 `canUseTool` 下发 —— 开关是 `--permission-prompt-tool stdio`

- 裸 CLI `--print` 下工具表缺 **4 个交互工具**：`ExitPlanMode`、`AskUserQuestion`、`EnterPlanMode`、`DesignSync`。`--allowedTools ExitPlanMode`、`--allowedTools ExitPlanMode,AskUserQuestion`、`--permission-prompts host`、`--dangerously-skip-permissions`、先发 `control_request(initialize)` **都放不回来**；`initialize` 只让工具总数在 24/27/28 之间抖动（MCP 与插件工具加载数量波动所致，与交互工具无关，**别拿工具总数当判据**）。
- **加 `--permission-prompt-tool stdio` 立即恢复**：同一组参数下 28（无）→ 27（有），`ExitPlanMode` / `AskUserQuestion` / `EnterPlanMode` 三个齐回工具表。
- **SDK 只要传了 `canUseTool` 就自动补这个 flag**（`sdk.mjs` 的 transport `initialize()`：`if(canUseTool) q.push("--permission-prompt-tool","stdio")`）。实测 SDK 真实 spawn 参数：`--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --permission-mode plan --include-partial-messages`。
- 端到端确认：plan 模式下模型调 `ExitPlanMode`，`canUseTool("ExitPlanMode", { plan: "<markdown 方案正文>" })` 确实到达宿主机；`AskUserQuestion` 同样经 `canUseTool` 下发（input 为问题列表）。
- **交互工具的完整契约（通道 / payload / 回传格式 / bypass 档行为）见 `docs/agent-sdk-interactive-tools.md`（2026-09-21 实测，权威）**，实现对话层前必读。其中两条改口径的要点：① 工具总数实测在 **24–31** 之间抖动，只能按**具体工具名**判；② **`bypassPermissions` 不会吞掉提问类工具**——`can_use_tool:AskUserQuestion` 照常到达宿主，所以「默认 bypass、有分歧仍要问用户」这条路是通的。
- ⚠️ **`AskUserQuestion` 的应答必须带 `updatedInput.answers`**（`{behavior:"allow", updatedInput:{...原input, answers:{"<question 完整文本>":"<选项文字>"}}}`，key 用 `question` 而非 `header`，多选逗号分隔）：只回 `{behavior:"allow"}` **不报错但等于「用户没选」——静默失效，没有任何错误码**，是本层最容易踩的坑，必须有单测覆盖。
- **结论：方案审批做原生三选一，不再需要 Tauri 那套兜底触发。** 三档均已验证可实现：
  - 「批准并自动接受编辑」= 在 `canUseTool` 里 `await q.setPermissionMode("acceptEdits")` 再返回 `{behavior:"allow"}`——实测热切成功、同一轮继续执行（19 轮），之后的 `Edit`/`Write` 不再进 `canUseTool`（已被 acceptEdits 自动批准）。⚠️ `PowerShell` 仍会进 `canUseTool`（acceptEdits 只自动批准文件编辑），UI 别承诺「批准后不再打扰」。
  - 「批准逐个确认」= 直接 `{behavior:"allow"}`，模式不动。
  - 「继续修改」= `{behavior:"deny", message: "<反馈>"}`。
- ⚠️ 不过 `canUseTool` 的调用（acceptEdits / 白名单命中等）根本不会到宿主机；要逐工具过策略得用 `PreToolUse` hook。

### 2. 会话落盘、`--resume`、`renameSession` 三者与终端互通

- SDK 会话写**同一份** `~/.claude/projects/<mangled>/<sessionId>.jsonl`：实测 `cwd=C:\Users\laphe\AppData\Local\Temp\sdksess-XXXX` → `~/.claude/projects/C--Users-laphe-AppData-Local-Temp-sdksess-XXXX/<uuid>.jsonl`，与 `mangleProjectPath`（`:` `\` `/` `_` `.` → `-`）一致。
- `claude --resume <sessionId> -p "…"` 能续 SDK 建的会话：实测上一轮让模型记住暗号 `ORANGE-7788`，resume 后原样答出，`session_id` 不变。
- `renameSession()` 追加的行与 v2.0.0 的 `rename_session` **键值一致、键序不同、非字节一致**：
  - SDK/CLI 写的：`{"type":"custom-title","customTitle":"探针标题·中文","sessionId":"afc29ea3-…"}`
  - v2.0.0（Rust `serde_json::json!`，Cargo.toml 未开 `preserve_order`，键按字母序）：`{"customTitle":"探针标题·中文","sessionId":"afc29ea3-…","type":"custom-title"}`
  - 两侧读取端都是 JSON 解析（顺序无关），**实际互通**；`electron/backend/sessions.ts` 的 `appendCustomTitle` 与 SDK 输出逐字节相同，可继续沿用。

### 3. `settingSources` 默认值 —— **不传**才对得上终端

- **不传**：SDK 不加 `--setting-sources`，CLI 用自身默认（user + project + local）——实测加载到用户的 `settings.json`（`ANTHROPIC_MODEL` 生效，模型就是终端那个）与项目 `CLAUDE.md`，能正常认证。
- **传 `['user','project','local']`**：等于不传，只是显式加了 `--setting-sources=user,project,local`。
- **传 `[]`（SDK isolation mode）**：SDK 加 `--setting-sources=`，**连认证一起丢**——实测报 `Not logged in · Please run /login`，模型回退成 `claude-opus-5[1m]`。**不要传 `[]`**。
- ⚠️ **但「不传 settingSources」还不够**：SDK 默认会把 `--permission-mode default` 显式传给 CLI，**CLI 的 flag 压过 settings 的 `permissions.defaultMode`**。实测项目 `.claude/settings.json` 写 `permissions.defaultMode: "plan"`，SDK 默认起会话仍是 `default`。要复刻 v2.0.0「继承 settings 的 defaultMode」必须传**未出现在 `sdk.d.ts` 里的内部选项** `resolvePermissionModeInCli: true`（此时 SDK 不传该 flag，实测 `init.permissionMode` 变成 `plan`，`ExitPlanMode` 也随之进入工具表）；或自己用 SDK 导出的 `resolveSettings()` + `filterEscalatingDefaultMode()` 算好初始档位再显式传入。

### 4. 打包：ESM 与 asar 两处必须处理，**真机打包未验**

已验证的机制（本机 Node 22.22.2 + 项目 `tools/build-electron.mjs` 的 esbuild 配置）：

- **不能把 SDK 打进主进程 bundle**。实测 `bundle:true / format:cjs / target:node20` 编译 1.6MB 产物「构建成功」但**载入即抛 `ERR_INVALID_ARG_VALUE`**——esbuild 把 `import.meta.url` 降级成占位对象，SDK 靠它定位平台原生二进制。→ esbuild 必须 `external: ["electron", "@anthropic-ai/claude-agent-sdk"]`。
- **动态 `import()` 是稳妥写法**：external 后静态 import 会被编译成 `require("@anthropic-ai/claude-agent-sdk")`，在 Node 22 上靠 `require(esm)` 侥幸跑通（实测真实 query 成功、工具数 27），但这取决于运行时 Node 版本；动态 import 产物保留真 `import(...)`，实测同样跑通。
- SDK 自带 CLI：`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`（237MB，与全局那份同版本）。`pathToClaudeCodeExecutable` 的指向实测：
  - npm shim `E:\DevTool\node18-global\claude`（无扩展名 bash 脚本）→ 失败（`exists but failed to launch`）
  - `…\claude.cmd` → 失败（`spawn EINVAL`，SDK 不启 shell）
  - **`…\node_modules\@anthropic-ai\claude-code\bin\claude.exe` → 成功**，且模型/配置与终端一致（`model = deepseek-v4.1-flash[1m]`，即用户 settings 里的值）。→ 「跟随本机 Claude Code」要指到 `bin\claude.exe`，并保留「找不到就回退 SDK 自带」的分支。
- asar：现有 electron-builder 配置（`files: ["dist/**","dist-electron/**"]`）会把生产依赖的 `node_modules` **打进** `app.asar`（实测解析 `release/win-unpacked/resources/app.asar` 头部，含 `node_modules/`），且未配 `asarUnpack`，`resources/` 下没有 `app.asar.unpacked`。SDK 的平台包（含 237MB `claude.exe`）必须 `asarUnpack`，或用上面的 `pathToClaudeCodeExecutable` 指到 app 包外。
- **未验**：本机 `node_modules` 未装 `electron`（只有 61 个顶层包），所以「electron-builder 产物里真跑通 SDK」这条本轮**验不了**，留到打包阶段；同理「asar 内 spawn 必然失败」是 Electron 已知限制，本轮未在真实 Electron 运行时复现。

## 铁律

- **绝不删除数据根的 `config.json` / `.bak`**——用户的清单/排序/置顶都在这里。`saveConfig` 三步保护：写临时文件 → 旧文件备份为 `.bak` → 原子替换；`loadConfig` 读主文件失败时自动从 `.bak` 回退。
- **配置一律经 `updateConfig` / `mutateConfig` 写（读改写），不许从参数重建**：重建会静默清掉调用方没传的字段——`save_config` 的 payload 只覆盖**出现过**的键（缺省=不动），项目增删走 `mutateConfig`。落盘保留 `unknownFields`（磁盘上本进程不认识的顶层键原样写回），键顺序固定 `order/projects/excluded/dark/closeAction/providers/currentProvider/pinnedSessions`（外加兼容层 `favorites`），与 `v2.0.0` 的 Config 声明顺序一致。
- **读改写必须持锁**（`withConfigLock` 的串行链，Node 侧等价于 Rust 的 `CONFIG_LOCK`）；**持锁期间严禁调用另一个取锁函数**（`mutateConfig` / `updateConfig`）——链式锁不可重入，嵌套即自锁。
- **会话删除必先备份**：删除会话 = `deleteSessionFile` 先 rename/copy 到 `trash/sessions/<UTC时间戳>/<mangled项目>/` 再删原文件；恢复时目标已存在必须拒绝（防覆盖）。
- **渲染进程零 Node 权限**：新增后端能力时，在 `electron/main.ts` 注册 IPC handler + `electron/preload.ts` 白名单 API + `src/lib/electron-api.d.ts` 类型声明三处同步；不得在渲染层开 `nodeIntegration` 或放宽 contextIsolation。
- ⚠️ **生产渲染层以 file:// 加载**：`vite.config.ts` 的 `base: './'` 是前提（默认 `/` 时资源 404 白屏），勿删。
- ⚠️ **打包必须走 `npm run dist:*`**（= `npm run build` + electron-builder）：主进程由 esbuild 编译为 `dist-electron/*.cjs`，未构建直接 `electron .` 会找不到模块。
- ⚠️ **Agent SDK 的两条打包约束**（都是实测踩出来的，改打包配置时别看漏）：
  1. **`tools/build-electron.mjs` 必须把 `@anthropic-ai/claude-agent-sdk` 放在 `external`**：SDK 是 ESM-first，打进 CJS bundle 会让 esbuild 把 `import.meta.url` 降级成占位对象，而 SDK 靠它定位平台原生二进制——产物一载入就抛 `ERR_INVALID_ARG_VALUE`。对话层因此用运行时动态 `await import()`。
  2. **`package.json` 的 `build.asarUnpack` 必须解包 SDK 的平台包**（`**/node_modules/@anthropic-ai/claude-agent-sdk*/**`）：它带着 237MB 的 `claude.exe`，而 asar 内的可执行文件**没法 spawn**（Electron 的 fs 能读 asar，`child_process` 要真实路径）。安装包因此会比以前大约 250MB。

## 开发命令

```bash
npm install                  # 依赖（国内可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 加速）
npm run dev                  # 开发模式（vite 热更新 + electron，主进程改动自动重启）
npm test                     # 后端单元测试（107 个：路径解析/脚本生成/配置/扫描/根目录定位/会话管理/mangle/回收站）
npm run typecheck            # 类型检查（前端 tsc + electron tsc）
npm run build                # 生产构建（typecheck + vite build + esbuild 编译主进程）
npm run dist:win             # Windows NSIS 安装包（别名：npm run electron:build）
npm run dist:mac             # macOS dmg（x64 + arm64）
```

构建产物：Windows 为 NSIS 安装包（`release/CC Desktop_<版本>_x64-setup.exe`，`perMachine`、默认装到 `C:\Program Files\CC Desktop`、安装界面中英双语、免管理员、可换安装目录）；macOS 为 `release/CC Desktop-<版本>-<arch>.dmg`（x64 + arm64 双架构）。绿色版取安装目录内容（asar 包内含 dist 与 dist-electron），与 config.json/scripts 同层放置即为便携模式。

> **app 名 vs 数据根**：应用显示名（`build.productName`、托盘、窗口标题）为 **CC Desktop**；`%APPDATA%\claude-fast` 这个**数据根目录名刻意保持 `claude-fast` 不变**（`paths.ts` 的 `appDataRoot` 与 `main.ts` 的 userData 隔离均硬编码）——改名会让老用户的数据根凭空换目录、清单看起来全丢。安装目录叶子名由 productName 决定（`productName` 全是 ASCII 时才用它，否则 electron-builder 回退到包名 `claude-fast`，这正是改名前 `C:\Program Files` 下是 `claude-fast` 的原因）。
