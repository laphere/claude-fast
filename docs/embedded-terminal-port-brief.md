# 把内嵌终端迁移到 Electron（Node）线 — 交接简报

> 2026-09-21 立。目标：**一个 app 两种交互模式**——内嵌终端（真 claude TUI，PTY + xterm.js）与页面内对话（已有，官方 Agent SDK）。终端那一套现在活在 Tauri 2 + Rust 的 `embedded-terminal` 分支上，要把它并进 Electron 主线，让两条线**共用同一份共享层代码**（现在共享层是 Rust/TS 各一份，任何共性改动都要写两遍——这就是本次迁移的动机）。
>
> 这份文档自包含，给**另一个会话里干活的 agent** 用，不需要读前一次对话的上下文。
>
> **2026-09-22 补记**：迁移已完成并落地（见「内嵌终端」两次提交），Tauri 线分支
> `embedded-terminal` 随之**退休删除**（本地与远端都不在了）。本文里所有
> `embedded-terminal` 的引用**一律改读本机 tag `embedded-terminal-final`**——
> 例如 `git show embedded-terminal-final:src-tauri/src/pty.rs`。分支纪律那节已失效，
> 见下。

---

## 0. 先读什么（别跳过）

- 本分支 `CLAUDE.md`：项目约定、铁律、IPC 三处同步规则、打包约束
- `docs/chat-behavior-spec.md`：**同类文档的写法范例**（逐条给证据、标明「已验证 / 未验证」）
- Tauri 线（`git show embedded-terminal-final:<path>`，**不要切分支**；该 tag 是退休后留下的本机存档）：
  - `docs/embedded-terminal-plan.md`：终端设计全程与实测踩坑（§6.x 逐条），**本次的验收基准**
  - `src/components/TerminalPane.tsx`、`src/lib/{pty,bold-bright,term-unicode,term-title,ime-anchor}.ts`
  - `src-tauri/src/pty.rs`、`src-tauri/src/clipboard_image.rs`
  - `docs/ime-anchor-probe/`：IME 锚点的回归探针（真 Chromium 里断言落点）

**分支纪律**（迁移期间有效，**已于 2026-09-22 履行完毕**）：所有工作在本分支 `claude-fast-electron` 上进行。**不要动 `main`**（与 `embedded-terminal` 同一提交，Tauri 线）、不要动 `embedded-terminal`、不要动本机 tag `v1.0.0-final` / `v2.0.0-final`。——`embedded-terminal` 现按迁移完成后的收尾惯例删除（内容在 `main` 上另有一份，本机另留 tag `embedded-terminal-final`）；`main` 与本机 tag **仍未动**。

---

## 1. 已完成的前置验证（不用重做）

2026-09-21 在**本机真机**上做过三项可行性验证，结论如下：

1. **`node-pty` 不需要编译、也不需要 `electron-rebuild`。**
   `node-pty@1.1.0` 是 **N-API + 平台预编译包**（`prebuilds/win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64`，含 `conpty.dll` / `OpenConsole.exe` / `winpty.dll`）。安装脚本 `node scripts/prebuild.js || node-gyp rebuild` 走的是预编译分支。实测**同一个二进制**在 `node 20.19.5`（ABI 115）与 **`electron 41.7.1`（ABI 145）** 下都加载成功并正常收发字节（中文完整）。
2. **`taskkill /PID <pty.pid> /T /F` 在 Electron 下能把整棵进程树收干净。**
   验证方式：PTY 里跑 `cmd.exe` → 用 `start /b` 起一条长命 node 孙进程（自己把 pid 写进临时文件）→ `taskkill /T /F` 后 `tasklist` 查，孙进程已消失。
3. **仓库当前状态**：`node-pty@1.1.0` 已用 `npm i node-pty --no-save --no-package-lock` 装进 `node_modules`（**未写进 `package.json`**）；`node_modules/@xterm/` 是个**空残留目录**，xterm 一个包都没装。

> 上面两项的探针脚本已存到 **`.workbuddy/terminal-port-spike/`**（`probe.js` 验 1、`probe-kill.js` 验 2；该目录被 `.gitignore` 忽略、不入库）。跑法：`./node_modules/.bin/electron .workbuddy/terminal-port-spike/probe.js`（`probe.js` 用绝对路径 require 仓库里的 `node-pty`）。**harness 也放这个目录**。

---

## 2. 阶段 0：判定性 spike（**先做这个，别先写产品代码**）

风险不在「搬」这个动作，而集中在三处宿主相关的行为。**先用最小 harness 把这三处验掉，过不去就不搬**（Tauri 线继续当终端版），用最小代价买确定答案。

harness 建议：一个最小 Electron app（**放在 gitignore 的工作目录里，别进源码树**），加载 `node-pty` + xterm + 四个可搬模块 + 搬过来的 `ime-anchor.ts`，用 **xterm-256color / cols·rows 由 FitAddon 量好**起一个真 `claude`。

| 要验的 | 怎么验 | 过不去怎么办 |
|---|---|---|
| **① 字体/WebGL 暗缝**（Tauri 线那套 `fontSize`/`lineHeight`/WebGL 取值是对着 **WebView2 + dpr1.5** 实拍标定的） | 与 Tauri 版**并排截图逐像素比**（同一机器、同一字体、同一 dpr）。量法见仓库里终端与 cmd 的对比手法：行高看高亮条、字面看墨迹 bbox | 按老方法重新标定（`TerminalPane.tsx` 里整套取值与 `rowHeightCache` 机制都带注释，照着重测） |
| **② IME 候选窗锚点** | 程序化部分照 `docs/ime-anchor-probe/` 的六步断言先在 Electron（Chromium）里跑通；**「候选窗贴不贴光标」必须让用户用真输入法敲**（探针验不了真输入法） | 若 Chromium 不把隐藏 textarea 的 caret 报给 OS IME，则本方案不成立 → 停止迁移，保留 Tauri 线 |
| **③ 忙闲探针阈值** | Tauri 后端是**固定 8192 字节一读一推**，`detectActivity` 判「1 秒 ≥8 个 chunk」为忙；量出 `node-pty` 的 data 事件实际切分频率与空闲基线 | 按实测重定阈值（判错的代价：`tabClosable` 误判 → 「关闭其他/所有会话」误杀正在干活的 claude，数据丢失） |

**阶段 0 的交付**：三处的实测数据 + 明确结论（可行 / 需重标定 / 不可行）。**不要跳过或口头带过**。

---

## 3. 移植清单

行数与位置为 2026-09-21 的审计结论（原 `embedded-terminal` 分支行号，逐条可核；该分支已退休，改读 tag `embedded-terminal-final`）。

### 3.1 几乎逐字可搬（≈1340 行，零改动）

| 文件 | 行数 | 备注 |
|---|---|---|
| `src/components/TerminalPane.tsx` | 615 | **无任何 Tauri 依赖**（后端调用全经 `../lib/pty`）；宿主耦合是浏览器 API 与 xterm 内部 |
| `src/lib/bold-bright.ts` | 178 | 字节级 SGR 改写（裸 `ESC[1m` + 默认前景 → 补 `ESC[97m`），零依赖 |
| `src/lib/term-unicode.ts` | 203 | V11 兜底 + `WIDTH_DELTA` 差集 + VS16 补丁，仅依赖 `@xterm/addon-unicode11` |
| `src/lib/term-title.ts` | 34 | 纯函数：OSC 0 标题 → 会话名 |
| `src/lib/ime-anchor.ts` | 251 | 代码可搬（钩 xterm 私有方法，与宿主 API 无关），**行为需按 §2 ② 重验** |
| `src/types.ts:88-111` | ~24 | `TerminalTab` / `TabActivity` |
| `styles.css` 的 `@font-face`×3 + `.terminal-pane` | ~61 | Electron 的 `styles.css` 里**一个 `@font-face` 都没有**，整块搬 |

另：tab 条样式（`.content-tabs` / `.content-tab*`）约 98 行属**半搬**——要与 Electron 现有的 `.chat-tabs` 合并，不能直接覆盖。

### 3.2 必须重写 / 新写（≈1100–1400 行）

| 项 | 原实现 | 要做的事 |
|---|---|---|
| `src/lib/pty.ts`（113 行） | Tauri `Channel<ArrayBuffer>` 二进制直传 + 全局 `pty-exit` 事件 + 后端分配 id | 改成 `ipcRenderer.invoke` + `pty:data:<token>` / `pty:exit:<token>` 定向推送（照 `electron/preload.ts` 的 `onChatEvent` 与 `main.ts` 的定向推送模式）。**对外签名与语义逐条保留**：`onSpawned` 早于 resolve、先注册退出监听再 invoke、`earlyExits` 补发、`newSessionId()` 的 uuid 形状与 fallback |
| `src-tauri/src/pty.rs`（≈425 行，不含测试） | portable-pty + ConPTY | 换成 `node-pty`，写 `electron/backend/pty.ts`。要点见 §4 |
| `src-tauri/src/clipboard_image.rs`（≈135 行） | Win32 `CF_HDROP` + `DragQueryFileW`，取**首个**扩展名命中 `png/jpg/jpeg/gif/webp` 的路径；只读不改剪贴板；macOS 恒 `None` | 换 Electron `clipboard.availableFormats()` + `readBuffer("FileNameW")`，**自己解 DROPFILES 字节**（20 字节头 + offset + UTF-16LE 路径列表）。**必须实测**：Chromium 是否列出该格式、字节布局 |
| `App.tsx` 终端段（≈430 行） | 终端 tab 生命周期、批量关闭、右键菜单、探针注册表 | 与现有 `ChatTabs` 合并成一套 tab 模型，见 §5 |
| 新增 `session_title_for` | Rust `lib.rs:1227-1250` | Electron 侧**不存在**该命令，属新增：后端 + IPC 契约 + preload 白名单三处同步（渲染层用它给新会话 tab 补标题，3s 轮询直到拿到） |
| 依赖与打包 | — | `package.json` 加 `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-webgl`、`@xterm/addon-unicode11`、`node-pty`；`build.asarUnpack` 必须加上 `node-pty`（`prebuilds/**` 的 `.node`、`conpty/OpenConsole.exe` 不能从 asar 里跑） |

---

## 4. 后端要点（照抄 Tauri 的语义，别自己发明）

- **kill 顺序**：Windows **先 `taskkill /PID <pid> /T /F`，再 `pty.kill()`**。node-pty 自己的 kill 是 `GetConsoleProcessList` + `process.kill`（Windows）与 SIGHUP（macOS），**不等价于 taskkill**；反序会把孙进程孤儿化（Tauri 线实测留下 claude.exe + MCP 孤儿持续吃 API）。**并且要保持「IPC handler 返回 = 树已杀完」的契约**——删除会话的语义依赖它（先杀进程再动会话文件）。
- **输出类型归一**：node-pty 的 `onData` 在 **Windows 给 Buffer、Unix 给 string**。主进程必须统一成 `Uint8Array` 再推给渲染层，否则 `bold-bright.ts` 的字节级扫描在 macOS 上**静默失效**（只是"粗体不变亮"，不报错）。
- **spawn 环境**：`TERM=xterm-256color`、`COLORTERM=truecolor`；**剥掉 `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDECODE`**——不剥则 app 从 claude 会话里启动时子会话 jsonl 不落盘、会话列表永远看不到它。
- **输入串行化**：同一 PTY 的写入必须保序（Tauri 用专属写线程 + FIFO 做到了；node-pty 在未 ready 前会排队，但「同一 pty 的写入顺序」仍需自己保证）。
- **resize**：node-pty **对 `cols`/`rows ≤ 0 直接抛**，未 ready 时排队；前端守卫是 `term.cols >= 2 && term.rows >= 1`，语义要对齐。初值由 FitAddon 先量好再传，避免 80×24 起步闪变。
- **退出清场**：Tauri 有 `RunEvent::Exit → shutdown_all`；Electron 侧现有 `before-quit` 只关对话子进程，**要把 PTY 也挂上**（注意 `quit_app` 走的是 `app.exit()`，不触发 before-quit，见 `main.ts` 现有处理）。
- **背压**：Tauri 读线程「发送失败也继续排水」；Electron 侧要自己做等价处理，否则 IPC 背压会拖慢子进程（大 diff / `cat` 大文件时）。

---

## 5. 前端设计约定（用户 2026-09-21 拍板的方向）

- **一个 app 两种模式**，共享层只有一份（这是本次迁移的全部意义）。
- **一套 tab 模型**：改成判别联合 `kind: "chat" | "term"`；status/activity 收到 tab 对象上（现在对话状态是旁挂 map `chatStatus`）。两套 tab 的现状差异（字段名、状态机、去重键、忙闲来源、激活态语义）见审计结论，动手前先读 `App.tsx` 与 `ChatTabs.tsx` 两侧。
- **设置里加「默认交互方式」**（新建 tab / 点会话行 / 项目行「+」用哪种），**但两种 tab 必须能共存**——改默认值不得关掉已开的 tab（否则切一下就把开着的终端/对话全没了）。
- `activeTabId === null` = 空态（Electron 线没有 SessionViewer 对应物，点会话行现在直接开对话 tab）。
- 项目行右键「在系统终端中启动/继续」**保留不动**——那是开外部终端窗口，与内嵌终端不是一回事。

---

## 6. 必须重新验证的清单（移植后逐条过，别假定成立）

1. **进程树回收**（关 tab / 删会话 / 退出 app 三条路径都要过）——见 §4。
2. **忙闲探针阈值**——见 §2 ③。
3. **Windows Buffer / macOS string 类型分叉**——见 §4；macOS 上无报错，只能靠主动看。
4. **字体度量 / WebGL 暗缝**——见 §2 ①；macOS 侧宿主从 WKWebView 换成 Chromium，属**全新未验**。
5. **IME 候选窗锚点**——见 §2 ②。失败时 `installImeCaretAnchor` 静默返回空 dispose，不报错，必须主动看。
6. **贴图（CF_HDROP）**——见 §3.2。
7. **resize 时序** + **hide 到托盘时的节流**：Electron 的 `backgroundThrottling` 默认 true，窗口隐藏时 renderer 被节流，120/450ms 的补 fit 与 150ms 防抖可能被拖后 → 「切回窗口后底部行被裁」要专门验。
8. **二进制吞吐与背压**——见 §4。
9. **dev 下 React 18 StrictMode 双起 claude**：Tauri 线用「spawn 推迟一个宏任务」压掉 setup→cleanup→setup；Electron 的 dev 入口是 `tools/dev.mjs`，要在新链上确认。
10. **`newSessionId()` 的 `crypto.randomUUID`**：生产渲染层以 `file://` 加载，需实测可用（有 fallback 兜底，风险低）。
11. **`~/.claude` 定位与 `TERM`/`COLORTERM`/三个 env 删除**逐条照搬——见 §4。

---

## 7. 铁律

- **逐字搬运，搬运期间不做"顺手改进"**：搬过来的文件保持一字不改（含注释里的实测数据）。任何行为差异都要能归因到「宿主变了」而不是「我改了」。
- **Tauri 版是 A/B 基准**：它现在是冻结可运行的，渲染类问题一律并排截图逐像素比，别凭感觉。
- **改动必须带验证**：跑不了 / 验不了的路径要明确写出来，不许用「应该能工作」搪塞。
- 渲染进程零 Node 权限：新增能力要 `main.ts` 注册 handler + `preload.ts` 白名单 + `electron-api.d.ts`/IPC 契约类型三处同步。
- 提交信息沿用仓库习惯：`前缀:改动点` 一行说完（中文 ≤30 字），细节留 diff，确需交代原因另起正文段。
- **版本号只在用户明确要求时改**。
- 遇到与本简报冲突的事实（尤其宿主行为），**以实测为准**，并把结论回写进 `CLAUDE.md` 或 `docs/`。

---

## 8. 分阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0** | 判定性 spike（§2 三处） | 三处实测数据 + 结论；不过则不搬 |
| 1 | 后端 + 打包：`electron/backend/pty.ts`、IPC 接线、依赖与 `asarUnpack` | 冒烟探针（起 claude、字节流、kill 无孤儿）+ **打包后仍能跑**（`npm run dist:win` 装机实测） |
| 2 | 前端：搬 ≈1340 行 + tab 判别联合 + 设置项 + `session_title_for` | 单测（探针阈值、title 过滤等纯逻辑）+ `npm run typecheck` + 真机点 |
| 3 | 真机重验 §6 全清单 | 用户参与：IME 真敲、暗缝截图、贴图（复制图片文件）、托盘 hide 回窗、大 diff 吞吐 |

每阶段结束给：改了什么 / **验证到什么程度**（跑了什么命令、点了哪条路径）/ **没验证的是什么**。

## 9. 用户状态（交接时）

- 用户关心的是「终端在 Tauri 线里已经修好、优化好的东西，搬过去会不会退化」——**§6 那张表就是对他的答复**，阶段 0/3 要正面回应它，别绕。
- 提交与推送节奏由用户掌握；分支重组的收尾（`v1.0.0`/`v2.0.0` 已删、只留本机 tag）刚做完，别再动分支。
