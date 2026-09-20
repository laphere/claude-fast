# App 内嵌终端（会话 tab 化）调研与方案

> 2026-09-19 调研。目标：点开会话即在会话显示区打开一个新 tab，tab 内是**真正的 claude CLI 终端**（不是自建聊天 UI）。本文是第三次尝试的前期调研——前两次（WinForms 嵌 conhost 窗口、v2.0.0 stream-json 自建 UI）均已放弃，原因见下。

## 一、历史复盘：前两次为什么不行

| 尝试 | 做法 | 失败原因 |
|---|---|---|
| WinForms 版 | 嵌原生控制台窗口（SetParent 一类） | DPI/焦点/resize 全是坑，macOS 无解 |
| v2.0.0「会话页二合一」 | `chat.rs` 托管 `claude --print --input-format stream-json --output-format stream-json --include-partial-messages` 子进程，StreamAssembler 翻译事件流，自建 ChatView 渲染（含权限确认/plan 选择/token 状态栏） | **本质受限**：自建 UI 永远是 CLI 交互面的影子——权限确认、plan 选择、斜杠命令补全、Shift+Tab 模式切换、vim 输入、图片粘贴、中断恢复……每个 claude 版本更新都要追赶；stream-json 协议本身不为完整交互设计 |

结论：这次换轨到**嵌真终端**（PTY + xterm.js）。PTY 里跑的就是真 TUI，交互 parity 天然 100%，claude 升级自动带来新特性，app 侧零维护交互逻辑。

## 二、方案空间

1. ~~SetParent 嵌原生控制台窗口~~ —— WinForms 老路，不可行。
2. ~~stream-json 自建 UI~~ —— = v2.0.0，明确放弃。
3. **xterm.js + 伪终端（PTY）** —— 正路，VS Code 集成终端同构。分两条实现路线：
   - **3a. Tauri + portable-pty**（v1.0.0 主线）
   - **3b. Electron + node-pty**（claude-fast-electron 分支）

## 三、3a vs 3b 对比（「换 Node 是否更好实现」）

| 维度 | 3a. Tauri + portable-pty | 3b. Electron + node-pty |
|---|---|---|
| PTY 库 | [portable-pty 0.9.0](https://github.com/wez/wezterm/tree/main/pty)：WezTerm 作者 wez 出品，WezTerm 生产自用，跨平台（Windows=ConPTY） | [node-pty 1.2.0-beta.15](https://github.com/microsoft/node-pty)：Microsoft 维护，VS Code/Hyper/Tabby 同款，2026-09 仍活跃发版 |
| Windows 机制 | ConPTY（Win10 1809+） | ConPTY（winpty 支持已移除，同样要求 1809+）——**两边的底层是同一个系统 API** |
| 前端 | xterm.js（`@xterm/xterm` + fit/webgl/search/web-links addons），WebView2 = Chromium | xterm.js 同一套，Electron = Chromium |
| 数据通道 | `ipc::Channel` 流式推送（**v2.0.0 chat.rs 已在本仓库验证此模式**）；或 [tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty)（Tnze，MIT，237 行 Rust，2026-07 更新）的「JS 循环 invoke read（返回二进制 ArrayBuffer）」方案 | ipcMain/ipcRenderer + `webContents.send`（VS Code 同款） |
| 进程树击杀 | `ChildKiller::kill` 只杀直接子进程，孙进程存活 → 需 `taskkill /T /F` / Job Object 兜底 | **完全相同的问题**——VS Code 用户长期抱怨 orphan 进程，node-pty 同样只杀直接子进程 |
| 构建链 | cargo 一条链（用户 rsproxy 镜像已配好） | node-gyp 原生模块：Python + MSVC + Windows SDK + **Spectre-mitigated 库**（README 明列要求），electron-builder + @electron/rebuild |

### 核心结论（纯技术口径：只论「嵌入终端并好用」，分支功能差不作为依据）

**两边都没有架构性优势——做到 VS Code 级嵌入终端，两条路都成立。** 真正的硬骨头全部落在两层共享组件上，与后端语言无关：

- **ConPTY（Windows 系统层）**：树击杀孤儿（两边都只杀直接子进程，VS Code 也没根治；解法同为 `taskkill /T /F` / Job Object / tree-kill）、resize 重放伪影、conhost 初始化错误路径——node-pty 与 portable-pty 调的是**同一个系统 API**，坑同源、药同方；
- **xterm.js（前端层）**：IME、键盘、渲染、跨 chunk UTF-8——WebView2 与 Electron 同为 Chromium，xterm.js 是同一份代码。

二级差异（真实存在，但不决定成败）：

| 差异点 | 优势方 | 说明 |
|---|---|---|
| 库的长尾打磨 | node-pty 略优 | 10 年边角案例（编码、flow control、错误路径）；portable-pty 有 WezTerm 一线生产背书，同为成熟件 |
| 参考实现密度 | node-pty 明显优 | VS Code / Hyper / Tabby / Electerm 整机开源可抄；Tauri 侧只有 tauri-plugin-pty + 2023 年停更的 demo |
| API 现成度 | node-pty 略优 | `onExit` 事件、encoding 选项开箱即用；portable-pty 需自己拼（约 200 行，插件已示范拼法） |
| 构建链 | **Tauri 明显优** | cargo 纯 Rust 零原生模块；node-pty 每次升 Electron ABI 都要过 node-gyp（Python+MSVC+WinSDK+Spectre） |
| WebView 版本可控性 | Electron 略优 | Chromium 随 Electron 锁版；WebView2 是 evergreen（随 Edge 自动更新），实践稳定，存在行为漂移的理论可能 |

**决定性的是风险结构，不是能力差异**：hard parts 两边共享，而 **3a→3b 的迁移成本极低**——xterm.js 前端层 100% 复用（React 壳相同），只换约 150 行 PTY 绑定与通道层。先走 Tauri 即使踩到 WebView2 无解坑，止损代价很小；反过来先走 Electron，node-gyp 构建链的摩擦从第一天就开始付且无法退回。

### 决策：spike 驱动，而非押注

在 Tauri 主线上先做两个半天级 spike（产出的前端代码在两条路线间通用）：

1. **Channel 二进制直传**：`Channel<Vec<u8>>` → `term.write(Uint8Array)` 全链路，含跨 chunk 中文；
2. **WebView2 IME**：xterm.js 中文组合输入 + 候选窗跟随光标。

- spike 全过关 → **留在 v1.0.0 主线实施**（零构建摩擦、无架构卡点，实施细节见下节）；
- IME 或渲染踩死 → **转 claude-fast-electron + node-pty**（最保守组合；xterm 层与 spike 成果全部带走，只重写绑定层）。

若不做 spike 直接选边：在意「站在 VS Code/Tabby 验证过的肩膀上、边角问题大概率有人踩过修过」→ 3b 完全成立；在意「构建与日常迭代最省事」→ 3a。本文后续章节按 3a 编写，3b 仅替换绑定层。

3a 实现方式：**不直接依赖 tauri-plugin-pty（22 星，JS 侧为 invoke 轮询且 `term_name` 未实现、kill 无树击杀），而是抄它的模式自写在 `src-tauri/src/pty.rs`**——项目风格偏好自持模块，且我们需要：① kill 后 `taskkill /T /F` 兜底；② 用 Channel 推送替代 JS 轮询；③ 复用 claude_update.rs 的 claude 定位逻辑。总量约等于该插件的核心 200 行 + 我们的定制。

## 四、落地设计（Tauri 主线）

### 后端 `src-tauri/src/pty.rs`（新增，约 300–400 行 + 单测）

- **会话表**：`PtyState { next_id, sessions: Mutex<HashMap<u32, PtySession>> }`，`PtySession` 持 `PtyPair` writer/reader、`Box<dyn Child>`、`ChildKiller`（对齐插件的数据结构，配 `tauri::State` 管理）。
- **命令**（全部走 `spawn_blocking`，不卡主线程）：
  - `pty_spawn(app, on_data: Channel, file, args, cwd, cols, rows)` → id；读线程循环 `read` 后经 Channel 推 `Vec<u8>`（二进制直传，xterm.js `term.write(Uint8Array)` 自带跨 chunk UTF-8 解码；若 Channel 二进制不顺，降级 base64 字符串或插件的 invoke 轮询——spike 项①）；
  - `pty_write(id, data)`、`pty_resize(id, cols, rows)`、`pty_list()`；
  - `pty_kill(id)`：先 `child_killer.kill()`，**Windows 上再 `taskkill /T /F /PID` 兜底杀树**（claude.cmd 是 cmd→node 链，只杀 cmd 会留 node 孤儿）；进程退出时 reader 收到 EOF → 推 `exit` 事件 → 前端标记 tab「已退出」；
  - app 退出（`RunEvent::ExitRequested`/窗口关闭确认）：遍历杀光全部会话。
- **claude 定位**：复用 `claude_update.rs` 的 `where claude` 解析（`.exe` 原生版直接 spawn；`.cmd/.bat` 走 `cmd /c claude …`，argv 由 portable-pty 正确引用，无注入面；无扩展名 sh shim 跳过——与现有择优逻辑一致）。
- **env 注入**：`TERM=xterm-256color`、`COLORTERM=truecolor`（插件的 `term_name` 是 TODO 未实现，必须自己传 env）。
- **首开尺寸**：spawn 前由前端 FitAddon 算好 cols/rows 传入，避免 80×24 起步再 resize 的闪变。
- **单测**：kill 的 taskkill 参数构造、会话表生命周期、claude 定位择优（现有 `claude_update` 测试可参照）。

### 前端（约 400–600 行）

- **`TerminalPane.tsx`**：xterm.js 封装。FitAddon（容器 resize 防抖 150ms → `pty_resize`）、WebGL addon（WebView2 支持；**仅对激活 tab 挂载**——Chromium 每页 WebGL 上下文有 ~16 个硬上限，多 tab 全挂会黑屏，非激活 tab 走 DOM 渲染器，claude TUI 的输出量 DOM 也足够流畅）、主题固定深色 Campbell 系（claude 探测 OSC 11 背景自适应明暗，必须答深色）、`term.onData → pty_write`、**粘贴整条拦下转发**：host 上捕获 keydown，Ctrl+V / Cmd+V / Shift+Insert / Alt+V 一律 preventDefault，**剪贴板里是图片文件时改为把路径当粘贴文本送进终端**（`clipboard_image_path` + `Terminal.paste()`，见下），否则向 PTY 写 `\x1bv`（Alt+V 序列，ESC 紧跟 v 无空格；**多打一个空格会变成「敲入空格+v」**）。Claude Code 的剪贴板粘贴绑定在 Alt+V，收到后自己去读系统剪贴板（图片贴成 `[Image #1]`、文本照常粘贴，图片+文本一条通道通吃，也无 WebView 剪贴板权限问题）。**不能走浏览器 paste**：xterm 的 paste 只会写文本、纯图片剪贴板一个字节都不发；**`\x16`（Ctrl+V 原始键码）在 Windows claude 2.1.278 实测无反应**（PTY 探针逐键码验证，社区「让 Ctrl+V 穿透」方案在 Windows 不成立）；macOS 按官方口径发 `\x16`。AltGr 在 Windows 上同时带 ctrlKey+altKey，Ctrl+V 分支须 `!altKey` 排除，否则会吃掉用 AltGr 打的字符。scrollback 上限 5000（多 tab 内存）、关闭时 dispose。
- **剪贴板图片路径提取（`src-tauri/src/clipboard_image.rs`）**：补齐**「复制的图片文件」在内嵌终端里贴不进去**的缺口。**cmd 里能贴**是因为 Ctrl+V 由 conhost 处理——它读到剪贴板的 CF_HDROP 文件列表后，把**文件路径当文本**塞进输入流，claude 识别出图片路径即转成 `[Image #1]`。内嵌终端走 xterm.js：浏览器 paste 对文件列表**不带任何文本**，而 claude 自己读剪贴板的两条路也都不认文件列表（①位图路 `ContainsImage()` 答 False；②路径路用纯 `powershell -NoProfile -Command Get-Clipboard`，PS 5.1 对文件列表返回空），于是报 `No image found in clipboard. Use alt+v to paste images.`。本模块补的就是 conhost 那一步：`clipboard_image_path` 只读地取出文件列表里首个图片文件的路径，前端用 `Terminal.paste()` 当**粘贴文本**送进 PTY（自动按 bracketed paste 包裹）——实测 claude 立刻转成 `[Image #1]`，**且完全不碰用户剪贴板**（早先那版改剪贴板内容的实现已废弃：多一个「剪贴板被改写」的副作用，还要自己猜还原时机）。白名单与 claude 源码正则严格一致（png/jpg/jpeg/gif/webp），bmp/tiff/heic 不送（送过去 claude 也不会转）。Win32 剪贴板直接调 `windows-sys`（已依赖），零新增 crate；macOS 无需处理（`osascript … «class furl»` 对 Finder 复制本就返回路径）。
- **`TerminalTabs.tsx`**：tab 条（标题 + 运行状态点 + 关闭 × + 「+」新开）。tab 标题：resume 场景直接用会话标题；新会话等 claude 落盘 jsonl 后由现有**聚焦自动刷新**机制补齐。tab 切换不销毁底层 PTY——多会话并行正是目标形态。有活跃进程的 tab 关闭前二次确认。
- **内容区改造**：右栏内容区加 tab 条，tab = `{kind: 'viewer' | 'terminal', …}`——点会话标题开查看 tab（现 SessionViewer 原样复用），「继续对话」开终端 tab。样式遵循项目按钮规范（inline-flex 居中 + 墨迹补偿，勿漏）。
- **入口接线**：SessionRow 右键菜单「在 App 内继续」→ `pty_spawn("cmd"/"claude.exe", ["/c","claude","--resume",<id>], cwd=项目路径)`；项目行「+」→ 同理新会话；外部终端启动入口保留为备选。
- **依赖**：`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-webgl`（可选 `@xterm/addon-search`/`addon-web-links`）；`tauri.conf.json` 的 `dragDropEnabled: false` 已就位（xterm 内文本选择/拖放的前提）。

### 风险与缓解

| 风险 | 缓解 |
|---|---|
| 关 tab 杀不净孙进程（node 孤儿吃 API） | `taskkill /T /F` 兜底；仍不放心可加 `win32job`/Job Object（KILL_ON_JOB_CLOSE） |
| ConPTY resize 重放屏幕/伪影 | resize 防抖；必要时关 tab 重开即净屏；WezTerm 式「跳过初始光标更新」可后置优化 |
| 中文 IME 组合输入 | xterm.js 支持（VS Code 同款）；WebView2=Chromium 理论可行——**spike 项②，第一天实测**；不过再启动 3b fallback |
| 键盘冲突（app 快捷键 vs 终端） | Tauri 无浏览器默认快捷键，基本干净；终端聚焦时 `attachCustomKeyEventHandler` 拦截 app 自有快捷键 |
| 吞吐 | claude TUI 输出 KB 级，Channel 推送绰绰有余；读线程可合并 <16ms 窗口的 chunk |
| 多 tab 长会话内存 | scrollback 上限 + 关 tab 即 dispose |
| 多 tab WebGL 上下文上限（~16/页，WebView2 与 Electron 同限） | 仅激活 tab 挂 WebGL addon，其余 DOM 渲染器 |
| app 退出残留终端进程 | 退出路径统一杀全部 PTY（close_action 询问弹窗可提示「N 个会话运行中」） |

### 工作量与节奏

- 后端 ~300–400 行 + 前端 ~400–600 行；参考量级：tauri-plugin-pty 全部 Rust 共 237 行、官方 example 前端 30 行起步。
- **第一天先做两个 spike**（各半天内）：① Channel 推二进制 chunk 到 `term.write(Uint8Array)` 全链路（含跨 chunk 中文 UTF-8）；② WebView2 里 xterm 中文 IME 输入。两项过关即可全速铺开，预计 1–2 天出可用首版（不含打磨）。

## 五、参考实现

- [Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty) — Tauri 2 + portable-pty + xterm.js，MIT，本方案后端的主要抄写对象（源码已通读：spawn/write/read/resize/kill/exitstatus 七命令 + BTreeMap 会话表）
- [marc2332/tauri-terminal](https://github.com/marc2332/tauri-terminal) — Tauri + xterm.js + portable-pty 的完整终端应用（130 星，2023 年后停更，仅作形态参考）
- [microsoft/node-pty](https://github.com/microsoft/node-pty) — 3b 路线的 PTY 库（Electron 分支 fallback 时用）
- [wez/wezterm 的 pty 目录](https://github.com/wez/wezterm) — portable-pty 出身处，WezTerm 生产验证
- VS Code 集成终端 — node-pty + xterm.js 的最大规模工程验证，树击杀/IME 等问题的处置先例都在它的 issue 库里

## 六、观感对齐 cmd/WT 的两处实现（2026-09-20，并排截图标定）

用户拿"系统终端里的会话"与内嵌终端并排截图，报了两件事，都已实测定位并修掉。两处的共同点：**cmd/WT 的观感不是 xterm 的默认行为，必须自己补**。

### 6.1 粗体要更亮（`src/lib/bold-bright.ts`）

- **现象**：同一行里 `**加粗**` 那段，系统终端是 #F2F2F2（= Campbell 的 brightWhite），内嵌终端与正文同为 #CCCCCC。
- **claude 实际发什么**（PTY 原始流抓取，2.1.278）：粗体是**裸 `ESC[1m`**（195 次，全部单独出现），颜色一律走真彩色 `ESC[38;2;r;g;bm`；带粗体的段分两类——`粗体+默认色` 144 段、`粗体+rgb(153,153,153)` 44 段。
  - 抓法（以后再做同类核对可复用）：临时 `cargo run --example` 用 portable-pty 起 `claude --resume <会话id>` 收字节。**必须自己应答终端查询**——DSR（`ESC[6n` 回 `ESC[1;1R`）、DA、OSC 11 背景色，否则 claude 卡在第一帧，只吐 4 字节 `ESC[6n`（实测踩过）；`--resume` 只重放磁盘上的会话，不产生 API 调用。
- **cmd/WT 为什么更亮**：conhost 的 intense 语义——粗体（+默认/索引色）渲染成 bright 色变体，WT 默认 `intenseTextStyle: all`（还加粗笔画）。**真彩色的粗体不会变亮**（RGB 没有 bright 变体）。
- **xterm 为什么没跟上**：`drawBoldTextInBrightColors` 只管「索引色 0-7 的粗体」（源码 `TextureAtlas._getForegroundColor`：`CM_P16/CM_P256` 且 `fgColor<8` 才 +8），claude 用的默认色走 `CM_DEFAULT` 直接返回 `colors.foreground`，够不着；字重那侧本 app 又已压平成 400（cmd 的粗体本就不在笔画上）。→ 粗体与正文同形同色。
- **做法**：`bold-bright.ts` 在 `term.write` 之前做**字节级**流式改写（`TerminalPane` 的 `onData` 里接一下）：`粗体 + 默认前景色 ⇒ 补 ESC[97m`，粗体结束（`22m`/`0m`）或流自己指定颜色 ⇒ 补 `ESC[39m` 还原。真彩色的粗体不动（与 WT 一致，否则 44 段灰粗体会被冲成亮白）。转义序列可能被 chunk 切开，未结束的尾部字节用 carry 留到下一批（已用 1 字节切片压测：结果与整块一次性改写逐字节相同）。
- **验证**：拿真实抓取的 60KB claude 流跑改写——输出 = 原始流 + 恰好 286 条 5 字节换色码（逐字节对齐验证），144 段「粗体+默认」变 brightWhite、44 段灰粗体保持灰、其余段全不受影响；再用 Edge 无头跑同一份 xterm + 主题渲染截图，逐像素确认粗体 = #E0E0E0、正文 = #CCCCCC、灰粗体 = #999999。
- **亮度档位**：补的是主题的 `brightWhite`（`termTheme()`，现值 #e0e0e0）。想与系统终端完全一致就把这个值改成 Campbell 原值 #f2f2f2——**只影响粗体那一路**（claude 不用索引色，brightWhite 平时没有别的入口）。

### 6.2 圈号（①②③④…）显得特别小（`styles.css` 的 TermWide/TermWide2）

- **现象**：同一行 `④回包后…`，系统终端里 ④ 与汉字同大（22×23 设备px），内嵌终端只有 14×13。
- **原因**（字体覆盖实测）：U+2460-24FF 这些"歧义宽度"码位 **Consolas 也有**，但它画得极小（canvas 实测 ④ 16.5×13.5，同字号下中易黑体 24×22.5）；而字体栈里 Consolas 排在 TermCJK 之前 → 圈号全从 Consolas 出。cmd 不这样：conhost 是按 font linking 把这类码位整段交给中文黑体的。
- **做法**：两个只圈该块的 `@font-face`（`unicode-range: U+2460-24FF`），插在 Consolas 之前——`TermWide` 用中易黑体（+106%，与 TermCJK 同档），`TermWide2` 用 Segoe UI Symbol（+125%）。分两个是因为中易黑体/雅黑/宋体实测都只覆盖 50/160（缺 U+246A 起，即 ⑪ 之后），Segoe UI Symbol 才是整块 160/160 全覆盖；不排在 Consolas 前面的话 ⑪-⑳ 仍会掉回 Consolas。
- **验证**：Edge 无头 canvas 量墨迹——①④⑩ 由 16.5×13.5 → 25.5×24（与汉字 25.5×24 同档）、⑪⑳ → 24×24；拉丁字母/方块字符（█）/制表符（─│）/箭头/`≥‥—` 全部逐值不变（`unicode-range` 保证拉丁不落到这两支）。

- **别漏了 `rescaleOverlappingGlyphs`（第二刀，2026-09-20 返工）**：换完字体 ④ 仍然不对——实测 12×24 的**细长圈**。原因是 claude 发的是 `**④ 回包后…**`（④ 后面跟一个空格），xterm 按 **1 格**算，而中易黑体给的是满宽字形（25.5 设备px vs 格子 14），于是撞上 `rescaleOverlappingGlyphs`：xterm 会把「单格、字形宽 > 1.5 格（=21px）」的字形**横向压到 cellWidth-1**。系统终端不压，直接让它溢出到后面那个空格格里（WT 实测 24×23）。
  - 修法：`rescaleOverlappingGlyphs: false`（与 cmd/WT 一致）。**这个开关对块状字符本来就不生效**——`allowRescaling` 要求字形宽 > 21 设备px，而 `█` 只有 16.5px，开/关实测块状字符列剖面都是 0 处暗缝；消缝靠的是"整数字格宽 + WebGL 渲染器"那套（见 99d924f / c649797），别把这条开关当成消缝的功臣。
  - 验证（Edge 无头 + WebGL/swiftshader，只改这一个开关）：④ 墨迹 12×24 → **23×24**，与同屏汉字 23×23 同档；`█`×20 与 `▀`×20 两行的列剖面高亮列数完全一致（280 / 590）、低谷 0 处。

### 6.3 emoji 把整张表拽歪（`@xterm/addon-unicode11`，2026-09-20）

- **现象**（用户截的 claude TUI 表格，`✅` 那种勾）：表头与上下横线对得整整齐齐，**数据行整体左移**——每行第 2 条竖线左移 1 格（14 设备px）、右边框左移 2 格（28px），行尾 `│` 与横线端点错开；同时 `✅` 与后一个字**贴在一起**（`✅本次加`、`✅（原本…`）。**不是宽度不够**，终端 127 列、表格只占 93 列。
- **定位**（对原图做像素级量）：表头行三条竖线落在 x=47/439/733/1335，与横线两端严丝合缝；数据行竖线落在 47/439/**719**/**1307**——用格宽 14 设备px 一除，正好是「第 2 条左移 1 格、右边框左移 2 格」。从表格 markdown 反推 claude 的排版权重：列宽 = 25/18/40（`轮转·跑福袋日期（任务级）`=25、`✅ 本次加 provider`=18、`✅（原本其实也是周日开头，这次一并修正）`=40，即 **claude 把 ✅ 记 2 列**，对得上 `47 + (w+3)×14` 的每一个像素），而 `·` 记 1 列。**每个数据行恰好 2 个 ✅ → 少 2 列**：第 2 条竖线只少 1 列，是因为它在第 1 个 ✅ 之前。
- **原因**：claude 的表格按**显示宽度**补空格，它和系统终端（conhost/WT 按字形给宽，emoji 走 Segoe UI Emoji 字体 = 2 格）都算 2 格；xterm 默认的 **Unicode 6.3** 宽度表（`common/input/UnicodeV6.ts`：宽表只到 CJK 各段，`0x2705` 不在其中）把 ✅ 算 **1 格** → 每行比 claude 的排版短 N 格，越往右越歪。同类码位（U+274C ❌、U+2757 ❗、U+2B50 ⭐、U+1F3xx–1FAxx 一串）全一样。
- **做法**：装官方 `@xterm/addon-unicode11`，在**任何数据写进来之前**注册并激活：
  ```ts
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  ```
  两个坑：① `loadAddon` 只是 `register`，**不设 `activeVersion` 不生效**（见该 addon README）；② xterm 6 把 `term.unicode` 划进 **proposed API**，不打开 `allowProposedApi: true` 直接抛「You must set the allowProposedApi option to true to use proposed API」——连 addon 的 `activate()` 都会一起挂掉，终端**整个空白**（实测：无头渲染里第二个面板就是空白的）。
- **为什么用官方 provider 而不是自己写表**：逐个码位对过 V6→V11 的差集，**恰好只有 emoji**（U+2705/274C/2757/2B50/26A1/26AA/2728/23F3/1F3AF/1F4xx/1F525/1F680/1F916… 1→2 列）；圈号 ①②、制表符 `─│┌┼`、方块字符 `█▀▄`、`·`、`—`、箭头 `→↑`、`✓✔✗`、`⏺⏵`、CJK 与全角标点**全部逐值不变**——6.2 那套字形对齐（TermWide/TermCJK 的 size-adjust）与「块状字符无暗缝」的调校（整数格宽 + WebGL）一点不受影响。
- **验证**（`.workbuddy/tmp/emoji-table.html` + `serve.cjs`，Edge 无头 `--force-device-scale-factor=1.5 --enable-unsafe-swiftshader`，两个面板同写**同一份 claude 排版字节**：上=默认 V6、下=Unicode11）：改前复现出用户截图的两处偏移（数据行第 2 条竖线 693→679、右边框 1295→1267），改后**每一行都回到 695/1295**，与横线端点重合；`✅` 也从"贴着后一个字"变成占满 2 格（含其后那个空格）。放大对照图 `.workbuddy/tmp/emoji_before_after.png`。
- **残留边界**：V11 表按 EastAsianWidth 给宽度，它管不到两类码位——「默认文本呈现、要加 U+FE0F 才变 emoji」的（`⚠` `▶` `✳` `✖`…）与「EAW=N 的 emoji」（⏺ U+23FA、⏱ U+23F1）。前者真的漏网了，见 6.4；后者与 claude 一致（claude 也按 1 格算），不用管。

### 6.4 变体选择符（`⚠️`）= 2 格（自注册 provider，2026-09-20）

- **现象**（用户接着截的第二张表）：4 行 `❌` 全部归位，**只剩 `⚠️` 那一行**仍比右边框短 1 格（截图 1965×561，逐行量最右亮像素：该行 1904，其余 1918，差 14 设备px = 1 格）。
- **定位**：该行单元格原文是 `⚠️ 清理逻辑**原样保留**——24 小时滚动是…`，即 `U+26A0` + `U+FE0F`(VS16) 两个码位。claude 的宽度实现（string-width 一线）把「基字 + VS16」整体记 2 格；Unicode 11 表则给 U+26A0 = 1 格、U+FE0F = 0 格并入前一格 → 整串只占 1 格。同一行里的 `——`（U+2014 破折号 ×2）**不是**元凶：若 claude 记 2，该行会短 2 格而不是 1 格（实测短 1 格），说明歧义宽度码位两边都算 1。
- **把 claude 的模型抠出来**：临时装一份 `string-width` 逐字符比对（脚本 `.workbuddy/tmp/stringwidth-check.mjs`，`string-width` 不是项目依赖，用完的副本在 `.workbuddy/tmp/sw/`），得到它的判据是 **emoji 基字 + VS16 = 2**、**裸基字仍 1**（`⚠`=1、`⚠️`=2；`☐`+VS16=1、`✻`+VS16=1、`①`+VS16=1；键帽 `#`/`*`/`0-9` + VS16 单独出现也是 1，只有再跟 U+20E3 才成 2）。判「是不是 emoji 基字」用 `\p{Emoji}` 就能对上（33 个样本里只有三个键帽基字例外，代码里把它们排掉）。
- **做法**（`src/lib/term-unicode.ts`，`TerminalPane` 里一行 `installTerminalWidthTable(term)`）：注册自己的 provider，V11 的结论原样透传，只改写 U+FE0F——前一个是 emoji 基字时返回「**宽度 2 + shouldJoin**」，xterm 的合并分支（`InputHandler.print` 里那条 "Combining character widens 1 column to 2"）会把前一格撑成 2 格并补一个零宽占位，合计正好 2 格；不是基字时保持 V11 语义（0 宽并入）。两个实现细节：① Unicode11Addon 不导出宽度表本身，用一个最小替身接出它的 provider 再裹一层（接不到就退回官方 addon，只丢这条补丁）；② VS16 要看**前一个**字符的类别，而 provider API 只传前一个的**属性值**（没有码位），于是借属性值的空闲状态位（bit3，V6/V11 恒填 0、xterm 自己也不读）把「前一个是 emoji 基字」带过去。
- **验证**（`.workbuddy/tmp/emoji-table3.html`，三个面板同写一份 claude 排版字节：A=默认 V6、B=只装 Unicode11、C=+VS16 补丁）：逐行量右边框——A 的数据行全是 1631（短 14px）、B 只剩 `⚠️` 那行 1631（其余 1645）、**C 全部 1645**；`⚠️` 也从"窄三角贴着后一个字"变成占满 2 格并留出它后面那个空格。对照图 `.workbuddy/tmp/emoji3_cmp2.png`。
- **仍存的边界**：V11 表本身只到 Unicode 11，之后新增的 emoji 与改判为宽的符号它也不知道——见 6.5，已用一张生成出来的差集表整张补掉。

### 6.5 把「V11 与 claude 的差集」整张表补掉（`WIDTH_DELTA`，2026-09-20）

- **动机**（用户问「还有可能出现漏网之鱼吗，是不是都覆盖了」）：不能靠两次故障的样本说话，得穷举。于是拿 string-width（claude 同款算法）与 V11 表**逐码位**比（0x0~0x2FFFF、裸字符与「后随 VS16」两种口径），差集 **287 个码位 / 47 段**，三类：
  - **Unicode 11 之后新增的 emoji**（🥲 U+1F972、🪄 U+1FA84、🩷 U+1FA77、🫠 U+1FAE0…）：V11 记 1、claude 记 2。这条最现实——模型随手写个新 emoji 就会错列；
  - **新版 EAW 由 N 改判为 W 的符号**：八卦 ☰-☷、六十四卦 ䷀-䷿、笔画 ⿼-⿿、ㆻ 等；
  - **反向**（claude 记 0/1、V11 记 1/2）：不可见填充符 ㅤ(U+3164) / ﾠ(U+FFA0)、软连字符、未分配码位等，十几个。
- **做法**：`term-unicode.ts` 里加 `WIDTH_DELTA`（`[起, 止, 宽度]`，二分查找），命中就按表给宽度（0 宽的当组合符并入前一格）。表是**生成**的、不是手写：`node .workbuddy/tmp/stringwidth-check.mjs --gen` 直接吐出 TS 字面量，换 claude 或 Unicode 版本重跑一遍即可更新。
- **顺带修掉一个自造的偏差**：VS16 补丁用 `\p{Emoji}` 判「emoji 基字」，会把**区域指示符**（🇦-🇿）与**键帽基字**（`#` `*` `0-9`）也算进去 → 单独的 `🇨️` / `#️` 被我们算 2 格、claude 算 1 格。两类都从判据里排掉；成对国旗（🇨🇳）不受影响——两个指示符各 1 格合计 2，与 claude 一致。
- **验证**：① 全码位扫描（裸字符 + 后随 VS16）：**除谚文字母外残差 0**；② 无头渲染三面板（表格里加了「新 emoji 行」「国旗行」）：默认表各数据行短 14px、只装 V11 时 ⚠️ 行短 1 格且新 emoji 行短 4 格（4 个 emoji × 1 格）、**本版自表格顶到底恒为 1645**（右边框与横线端点重合）。对照图 `.workbuddy/tmp/emoji3_cmp3.png`。
- **唯一已知残差：谚文字母（U+1161-11FF，160 个码位）**——xterm 刻意把它们当组合符（NFD 韩文靠这个拼字，动不得），claude 那边算 1 格。只有「分解形式（NFD）的韩文」才碰得到，而模型输出的韩文都是预组合（NFC）；实测的两次故障也都不涉及。

### 6.6 tab 名跟着会话名走：claude 的 OSC 0 终端标题（2026-09-20）

- **问题**（用户实测）：新会话在左栏已经看到会话名了，内容区 tab 还写着项目名。
- **先查「有没有现成的信号源」，不猜**：写了个一次性探针（`src-tauri/examples/pty_title_probe.rs`，验证完即删）在 ConPTY 里跑真 claude 抓原始字节。**第一次只收到 4 字节 `ESC[6n`**——claude 先问光标位置（DSR），裸 PTY 没人应答就卡死；探针补上「DSR → `ESC[1;1R`」才跑起来（xterm.js 自己会答，所以真 app 里见不到这一面）。
- **结论**：claude 启动约 600ms 就写出 `ESC ] 0 ; ✳ <会话名> BEL`（`/rename` 会重写，claude 的设置项 `terminalTitleFromRename` 默认 true），即**系统终端里 tab 名跟着会话名走的那条通道本来就通着**，我们只是没接。从 claude 二进制里抠出的拼装式：`` `${字形} ${会话名}` ``，字形在 `◐`/`◑`（干活时每 ~960ms 交替）与 `✳`（闲）之间变；会话名取 `sessionTitle ?? aiSessionTitle ?? agentTitle ?? haikuTitle ?? "Claude Code"`。
- **为什么不走「`--session-id` + 读会话文件」**：顺带验了，**会话 jsonl 在第一条消息之前不存在**（探针跑完 25s，`<mangled>/<uuid>.jsonl` 仍没有），所以那条路只能轮询等文件出现，还得自己生成 uuid 塞进 spawn 参数；OSC 是推送的、600ms 就有、`/rename` 也自动跟。
- **做法**：`TerminalPane` 里 `term.onTitleChange` → `src/lib/term-title.ts` 清洗 → 宿主 `updateTabTitle` 换 tab 标题。清洗规则：剥掉前缀字形（连它后面那个空格）、丢弃空/只剩字形、丢弃泛称 `claude` / `Claude Code`、丢弃 shell 设的 exe 路径（启动瞬间先被设成 `…\claude.exe` 再是 `claude`）——丢弃=保留 tab 原值（新会话仍是项目名）。**标题没变就不 setState**：动画帧会让同一秒内重写好几次标题，剥掉字形后内容相同，挡住这一路才不会让整条 tab 跟着转圈字形重渲染。
- **再跑一遍 app 的真实 spawn 链**（`cmd /D /S /C call claude.cmd`，而不是直接跑 exe）看包装层写什么标题，实测按序四条：`C:\Windows\system32\cmd.EXE`（cmd 设的，大小写混杂）→ `claude` → `✳ Claude Code`（本轮没发消息、会话无名，正好落在兜底值）→ 退出瞬间 `""`（清空标题）。**四条全部按设计丢弃**（分别是 exe 路径 / 泛称 / 兜底值 / 空），tab 始终保持上一个真名字，退出也不会被清成空白。
- **验证**：清洗函数对 11 个真样本逐条核对（含上面四条的原文）；`tsc` 与 `npm run build` 通过。另核对了 xterm 侧拿到的是**剥掉 `0;` 前缀后的纯标题**（`registerOscHandler(0)`→`setTitle`，同族 OSC 4/11 的 handler 都按"ident 已剥"解析，可互证）。

#### 6.6.1 补第二路：会话文件兜底（用户实测「tab 还是没同步」后加的，2026-09-20）

- **OSC 那条路不够**：claude 的标题链是 `customTitle ?? aiTitle ?? agentTitle ?? haikuTitle ?? "Claude Code"`（二进制里 `terminalTitle` 那行），**没有「首条用户消息」这一档**；而应用列表的标题链是 `customTitle > aiTitle > 首条用户消息`。所以**没生成 aiTitle 的会话，OSC 只写兜底值 "Claude Code"**，被清洗规则丢掉，tab 就一直挂着项目名。这不是小概率：全量扫 175 个会话文件，`ai-title` 记录 163 有 / **10 个没有**（多半是标题生成那一次调用失败/没赶上），而用户第一次验收撞上的正是其中一个（`public/a71ec22c`）。
- **第二路怎么定位到文件**：新会话开 tab 时**预生成会话 id**，spawn 时用 `--session-id <uuid>` 交给 claude（实测认；会话文件即 `<会话 id>.jsonl`，文件内每条记录也带该 sessionId）。这样 tab 从第一秒起就知道自己对应哪个会话文件，不必靠"最近新建的文件"猜（用户经常同时在系统终端里跑 claude，猜错会显示成别人的会话名）。前端生成用 `crypto.randomUUID()`（Tauri 的两个 origin 都是安全上下文），拿不到时退到手拼 v4 形状；后端 `session_args` 仍按 uuid 形状再校验一次（这两个值直接拼命令行，非 uuid 内容可能是任意 flag）。
- **问标题**：新命令 `session_title_for(projectPath, sessionId)` → `session_title_in`（lib.rs）：定位 `<projects>/<mangled>/<id>.jsonl`，读 head/tail 64KB 走**同一个** `session_meta_from_lite`，所以拿到的标题与列表逐字一致。文件还没出现（第一条消息之前）返回 None——这时后端只做一次 `stat`，代价可忽略。
- **轮询节奏**：新会话 tab 在"标题定稿"前每 3s 问一次；定稿（OSC 或文件任一路先到）即停，之后的变化（`/rename`、aiTitle 落地）由 OSC 那条路跟。定稿状态记在 `titledRef`（ref 给轮询同步判断、state 用于重算待办），**文件那路不得覆盖已定稿的标题**——OSC 是 claude 的实时值，文件里那条可能还是旧的首条消息。
- **验证**：`session_title_in` 两个单测（按 id 命中 / 文件未落盘返回 None / 非法 id 不进路径 / customTitle 优先）；`session_args` 两个单测（两种参数、注入面拒绝）；`cargo test` 153 项全绿；`tsc` 通过。真机观感仍待用户确认。

### 6.7 偶发「终端一片黑、零输出」：启动握手 DSR 应答被吞（2026-09-20）

- **问题**（用户实测）：内嵌终端 resume 旧会话时**偶发**卡死——一片黑，什么输出都没有，发生过好几次，且不自愈。
- **探针实测**（还原 app 的真实 spawn 链 `cmd /D /S /C call claude.cmd [--resume <id>]`，逐字节打时间戳）：

  | 实验 | 结果 |
  |---|---|
  | 见到 `ESC[6n` 就应答 | 一切正常（33KB 输出，TUI 完整起来） |
  | **永不应答** | **总共只吐 4 字节 `ESC[6n`，之后永久静默**（cmd 连标题都不设，claude 的 TUI 根本没机会起） |
  | 延迟 500ms 才应答 | **完整恢复**（33KB）——握手没有超时，**晚答无妨、丢了才致命** |

- **纠正一条既有认识**：§6.6 把首发 `ESC[6n` 记成了 claude 的查询。实测它出现在**spawn 后 21~30ms**，而 claude 的痕迹（`ESC]0;claude BEL`）在 374~381ms 才出现；用 `PROBE_RAW="/C echo hi"` 跑**不含 claude 的纯 cmd.exe**，那 4 字节照样在 22ms 出现。即：**这是 cmd.exe/conhost 启动时的 DSR（问光标位置），它卡住 => 整条链（含 claude 的启动）都不会发生**，不是 claude 自己的第一帧。
- **成因（前端一侧的窗口）**：应答由 xterm.js 生成（`deviceStatus` → `triggerDataEvent` → `term.onData`，xterm 源码里对 `CSI 6 n` 无条件回 `ESC[<行>;<列>R`），回灌 PTY 必须经过 `ptyIdRef`；而 `ptyIdRef` 要等 spawn 命令的 IPC 应答**外加一次退出监听的往返**（`ptySpawnClaude` 里 `invoke` 之后才 `await listen(...)`）才就位——落在同一量级（约 5~25ms）上。撞进这个窗口的那次应答被 `term.onData` 里的 `if (id !== null)` **静默丢掉**，于是 cmd.exe 永远等不到，终端永久全黑。谁先谁后取决于当时主线程/IPC 队列忙不忙（开 tab 那一刻正忙着 React 挂载 + WebGL 上下文 + 字体图集），所以表现为**偶发**；新会话与 resume 走同一条链，理论上都有，只是用户开 resume 更多。
- **修法**：`TerminalPane` 里加 `pendingInput` 队列 + `sendInput()`——**pty id 未就位时的输入一律排队，拿到 id 后按序补发，绝不丢弃**（粘贴路径一并改走 `sendInput`，`term.paste()` 本就经 `term.onData`）；同时 `ptySpawnClaude` 新增 `onSpawned(id)` 回调，在 `invoke` 一回来就把 id 交出去，把窗口从「两次 IPC 往返」收窄到一次。因为「晚答无妨」，排队是安全的正解。
- **验证**：`tsc --noEmit` 通过；后端 `cargo test` 149 项通过；探针三项实验如上表。**真机偶发复现待用户确认**（单实例插件占着 app id，自起 dev 实例会被顶回来）。
- **探针配方**（一次性，验证完即删，同 §6.6）：`cargo run --example` + portable-pty 起 `cmd /D /S /C call claude.cmd [--resume <id>]`，读线程逐块回传、主线程扫描 `ESC[6n` 并按 `dsr_delay_ms` 参数决定何时回 `ESC[1;1R`，逐块打「距 spawn 毫秒数」。**判断黑屏成因时先看这条**：若日志停在 4 字节 `ESC[6n`，就是握手没人应答。

### 6.8 删除会话时，它的终端 tab 一并关闭（2026-09-20）

- **问题**（用户提出）：会话正开在内嵌终端里，从列表把它删掉，那个终端怎么处理？此前**两边互不相干**——`deleteSession` 只刷列表/置顶、清右侧查看器，完全不看终端 tab。
- **为什么不能放着不管**：列表里会话没了、终端里的 claude 还在跑，用户接着在这个 tab 里对话甚至 `/rename`，内容落到一个"已被删除"的会话上；而 app 承诺的"移入回收站、可恢复"对不上账——回收站那份只是删除那一刻的快照，活进程继续写的那份去向取决于 claude 何时开/关这个文件（保持句柄则写入跟着去了回收站那份，每次重开则原路径被重新建出来、会话在列表里"自己回来"）。两种结果都不对。
- **口径**（视图一致性）：删除会话 = 把它挂着的**所有视图**收掉——右侧只读查看器（本来就会清）与内嵌终端 tab 同理。匹配靠 `TerminalTab.resumeSessionId` / `newSessionId`（两者都是交给 claude 的那个 uuid，与 `SessionInfo.sessionId` 同一套 id）。已结束的 tab 也一并收掉（文件都没了，留着是"指向不存在会话"的孤儿）；没挂 tab 的会话文案与行为完全不变。
- **顺序必须是「先结束进程、再删文件」**：反了会在两者之间漏掉 claude 最后追加的一条消息（回收站里的备份不完整），而且仍在写的 claude 会让删除静默失效（见上）。所以走**就地击杀注册表** `tabKillersRef`（`TerminalPane` 挂载时注册，与 `tabProbesRef` 同一套模式），宿主 `await` 它拿到「进程树已杀完」的时刻（`pty_kill` 返回 = 后端 `taskkill /T /F` 跑完）——**不能靠卸载路径**（`removeTabs` → `TerminalPane` cleanup）里那次 kill：那是 fire-and-forget，发起完就返回，等不到退出。杀完即把 `ptyIdRef` 置空，随后的卸载路径按判空跳过，不对同一个 pid 二次 taskkill。`status === "starting"`（pty id 还没回来）时注册表里的句柄是空操作，由卸载路径的 `onSpawned` 分支补杀——那时 claude 还没开始写这个会话文件，不需要等。
- **确认框要说清**：删除确认框按情况追加一句——只有已结束的 tab「将一并关闭」；运行中且探针判 idle「删除将一并关闭该终端」；运行中且探针判 busy/unknown「删除将一并结束它——claude 正在干活，这一轮会被中断」。忙/闲**在点删除这一刻现算**（与右键菜单同一套口径，unknown 按忙处理），不缓存快照。**不新增"某些会话删不掉"的规则**：单会话删除本来就是带 danger 确认的破坏性操作，与「关单个 tab 先确认」一致；批量关闭那种"跳过在跑的"是另一回事（一次误点会杀多个）。
- **覆盖不到**：同一会话在**系统终端**里跑着（右键"在系统终端继续对话"，或用户自己 `claude --resume`）时删除，后端无从得知，行为与上面那条风险相同。要根治只能在录音层面记下每个 live 进程持有的 session id（含外部进程），成本不成比例，暂不做。
- **验证**：`tsc --noEmit` 与 `npm run build` 通过；**真机行为待用户验收**——在终端里跑着会话，删掉它，看确认框文案、tab 是否随删除消失、进程是否被杀干净（任务管理器里无 claude/node 孤儿）。

## 七、待优化（用户已记录，后续统一做，当前先做功能）

**全 app 缺过渡动画，均为突变**，已知清单：

- 左栏收起/展开（自动/手动）瞬间跳变。实现注意：`.main-left` 是 `flex-basis 360px + display:none`，`display` 不能过渡——需改 width/max-width transition 或父级 grid-template-columns 过渡；且动画期间终端 tab 的 ResizeObserver 会连续触发 refit（已有 150ms 防抖），动画时长需与之对齐，避免中途反复 resize PTY 造成 claude TUI 抖动
- 对话框开关（Modal 系）、toast 出入、tab 条新增/关闭、置顶区条目出现/消失、右键菜单弹出，全部无动画
- 优先级建议：侧栏过渡 > 对话框/菜单 > toast > 其他；统一用一个 easing/时长体系（如 150-200ms ease-out）保持手感一致
