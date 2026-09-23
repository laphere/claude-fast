# 待办清单

> 2026-09-22 用户记录。逐条独立、可单独开工，做完一条挪到文末「已完成」（保留结论，别直接删）。
> 编号 T1、T2… 提交信息里可以直接引用。

## T1 — 尽可能用足 Agent SDK 的能力

**目标**：把 `@anthropic-ai/claude-agent-sdk` 已提供、而本项目还在手搓或压根没有的能力用起来。三类工作：

| 类 | 含义 | 例 |
|---|---|---|
| **功能增强** | 用 SDK 能力做出以前没有的功能 | 上下文占用条、模型热切、`/` 命令补全、结构化输出 |
| **缺失补齐** | 半成品补完 / 已知缺口填上 | 权限卡的「总是允许」、逐工具审计 |
| **替换手搓** | 自家实现与 SDK 同源，能换就换 | 会话元数据解析、标题生成、`sessions.ts` 的部分解析 |

**依据**：`docs/agent-sdk-capabilities.md`——§7「现状对照」有 11 项候选（按收益÷成本粗排），§9 是「采用前先跑探针」清单。

**已知的高价值项**（细节见上文档，此处只记排序意图）：

1. `getContextUsage()` → 会话页头部加「上下文占用」（纯读取，成本最低）
2. `options.title` → 省掉新会话那段「等标题落盘」的轮询（现在头部统计 / 四按钮都挂在拿到标题上）
3. `supportedCommands()` / `supportedModels()` + `setModel()` → `/` 补全 + 模型热切（`ModePicker.tsx` 已有权限档位下拉的先例）
4. `startup()` 预热 → 消掉首条消息的冷启（**要先定预热时机与 warm 池失效策略**，`WarmQuery` 只能 query 一次、`Options` 起进程时定死）
5. `agents` / `tool()` + `createSdkMcpServer()` → app 内置子代理、把会话搜索/用量查询做成工具（**要先把 `zod`、`@modelcontextprotocol/sdk` 显式加进 `dependencies`**，现在只是传递装进来的）
6. `enableFileCheckpointing` + `rewindFiles()` → 变更文件面板加「撤销本轮改动」（机制已实测 2026-09-23，`docs/agent-sdk-capabilities.md` §6.10：与 `~/.claude/file-history/` 手工恢复路**同一仓库**；只回滚文件、回滚后模型经 `edited_text_file` 附件自动纠偏；剩「跟踪范围 vs 面板聚合口径」重合度待验）
7. `USAGE_*_PREFIXES` + `rate_limit_event` → 配额类错误的差异化 UI（常量现成，直接可用）
8. `PreToolUse` hook → 逐工具审计（`canUseTool` 覆盖不到被自动批准的调用）
9. `maxTurns` / `maxBudgetUsd` → 成本护栏（设置项）

**⚠️ 两条纪律**：

- 标 `型` 的能力**未实测**，每条开工前先跑 §9 对应探针（照 `docs/agent-sdk-interactive-tools.md` 的做法：`%TEMP%\` 下独立脚本、不提交）。
- **替换手搓前先对数字**：`sessions.ts` 的「相邻同 `message.id` 合并」与「usage 取收尾行」两条口径是本项目实测出来的（不合并消息数虚高 30~80%、取首行差 75 倍），SDK 的同名函数不保证一致。**不同就各用各的，绝不混用**。

## T2 — 全面代码审查（含 macOS 兼容性）

**目标**：一次覆盖全仓的审查，重点是**双平台承诺 vs 只在 Windows 验过**这个落差。本项目一直单机（Windows）开发，`dist:mac` 从来没在真机跑过。

### 2.1 macOS：代码里已实锤的缺口

| 位置 | 现象 | 影响 |
|---|---|---|
| `electron/backend/clipboard-image.ts:46` | `if (process.platform !== "win32") return null;`（注释也写明「非 win32 恒 null」，因为解的是 Win32 `CF_HDROP` 的 `DROPFILES` 字节） | **终端里贴图在 macOS 完全不可用**，且是静默的（粘贴时什么都不发生）。macOS 的对等物是 `NSPasteboard` 的 `public.file-url`——注意 `src-tauri/src/clipboard_image.rs`（已退休那条线）的注释提过 osascript 路径本来就能读到 |
| `electron/backend/pty.ts:198` | kill 只在 `win32` 走 `taskkill /T /F`；**其余平台只有 `s.proc.kill()`，没有杀树** | 删会话 / 退出 app 时**孙进程可能存活**（MCP 守护进程那类）。Windows 侧的同类残留 `CLAUDE.md` 已记「根治要 Job Object，未做」——macOS 这边是**连树都没杀**，比 Windows 更宽 |

### 2.2 macOS：未在真机验证过的部分（不是已知 bug，是验证覆盖的空洞）

- **打包**：`dist:mac`（双架构 dmg）从未真机跑过；`CLAUDE.md` 记的真机验证只有 win-unpacked 与 NSIS。要验的是 **node-pty 的 darwin prebuilds 在 asarUnpack 后能否 spawn**（Windows 上踩出来的同类问题；SDK 的 darwin 平台包已不进安装包——2026-09-23 起整体剔除，对话层只认本机 claude）。
- **终端字体/行高**：`integralAdvanceFontSize` + `alignRowHeight` 的取值只在 **dpr 1.5（Windows）** 逐值验过。**Retina 是 dpr 2**——「步进×dpr 为整数」这条判据要重算，`CLAUDE.md` 说的「取值零重标定」**不覆盖 dpr 2**。
- **IME 锚点**：`ime-anchor.ts` 的六步探针在 Electron 全过，但「真输入法待用户实测」——实测环境是 Windows。macOS 输入法（含候选窗、组合键）是另一套。
- **终端渲染**：WebGL 渲染器 / 块字符暗缝的结论来自 Electron(Chromium 146) 与 WebView2(153)——两个都是 Windows 侧（macOS 没有 WebView2，Chromium 版本也不同）。
- **`integralAdvanceFontSize` 之外**：终端 `TERM=xterm-256color` / `COLORTERM=truecolor` 与剥 `CLAUDE_CODE_CHILD_SESSION` 等 env 的处理是平台无关的，但 **`where claude` 择优链**（`pickWindowsHit`、`.cmd/.bat` 过滤商店别名）在 mac 上恒走另一支，值得逐条看一遍。

### 2.3 macOS：全部 `win32` 分支清单（35 处，逐条判「另一支是否等价」）

审查时的入口清单（`grep -rn "win32" electron/ --include=*.ts | grep -v test`）：

- `chat.ts`：606（`USERPROFILE`/`HOME`）、634/671/639（`claude.exe` vs `claude`，**639 行只在 win32 做候选过滤**）、681/703（`shell: platform === "win32"`，对应 `.cmd/.bat` 走 `cmd /D /S /C call`）
- `claude-update.ts`：165/166（`cmd` vs `/bin/sh` + scriptPath）、389（`where` vs `command -v`）、399/440/480/567/573——已双平台化，重点看 567 行写的 `.sh` 与后续执行方式
- `paths.ts`：12（`bat`/`sh`）、105、204（`USERPROFILE`/`HOME`）
- `platform.ts`：35/48/108/187/237/300/353/389——启动/resume 链与 `path.win32`/`path.posix` 选择，**这是 mac 上最该逐行看的一块**
- `provider.ts:926`、`main.ts:536`（autostart 已含 darwin，看托盘 / 登录项语义）
- `mangle.ts:164`（已双平台，且**测试覆盖了 POSIX 侧**——`unmangleCandidatesPosix`）

> 已有测试覆盖的 darwin 面：`platform.test.ts` 5 处（`validateResumePath` / `buildLaunchScript` / `buildResumeScript`）、`mangle.test.ts` 的 POSIX 用例（文件头写「双平台用例全部覆盖」）、`pty.test.ts` 1 处。**没有单测覆盖的就是上面 2.1 那两条**（`clipboard-image` 的 mac 支、`pty.kill` 的 mac 支）。

### 2.4 非平台部分（顺带一起审）

- **主进程 / IPC**：`main.ts` 的 handler 注册、`preload.ts` 白名单、`electron-api.d.ts` 三处是否同步（新增后端能力时的铁律）
- **配置读写**：`config.ts` 的读改写 + 锁 + `unknownFields` 保留（`withConfigLock` 期间严禁嵌套取锁）
- **会话文件**：`sessions.ts` / `session-extra.ts` / `trash.ts` 的删除-备份-恢复链（「删除必先备份」「恢复时目标已存在必须拒绝」）
- **对话层**：`chat.ts` 的进程生命周期（懒启动 / `closeAll` 3s / `tabKillersRef` 跨 kind 去重）
- **前端**：`App.tsx` 的状态与落盘同步（尤其 `pinnedSessions` 的 `syncPinsFromConfig` 真源问题）
- **死代码 / 陈迹**：`scriptnames.ts` 只剩 `shQuote` 在生产路径、`styles.css` 的 `.viewer-head` 是死 CSS、`favorites` 兼容层——确认哪些还能清

### 2.5 交付形态

审查结果写进 `docs/`（新建 `code-review-2026-09.md` 之类），按 **P0 会出错 / P1 该修 / P2 可注意** 分级，每条给 `file:line` 与失败场景；**能顺手修的当场修并分开提交**，别把一次审查堆成一个巨大 commit。

## T3 — 健康检查支持一键安装 Claude Code（未安装场景）

**目标**：用户没装 Claude Code 时，健康检查弹窗现在只给一个红叉「未找到」（`HealthDialog.tsx:137` 的「claude 命令：未找到」+ `currentError`「未找到 claude 命令」），没有后续——补一颗「安装」按钮，一键 `npm i -g @anthropic-ai/claude-code@latest`，成功后重查刷新状态。已有升级（`claude-update.ts`），这是同一弹窗里对称的另一半。

**为什么改动小**：升级链已有 npm 兜底腿——`buildUpgradeBat` / `buildUpgradeSh`（`claude-update.ts:412-423`）本就是「`claude update` 失败则 `npm i -g @anthropic-ai/claude-code@latest`」。安装 = 砍掉第一腿、只跑第二腿；脚本生成、执行方式（输出重定向到文件防管道死锁、10 分钟超时、`windowsHide`）、结果展示（`upgradeTip`）全部**复用**，不另写一套。

**与升级的差异，开工要处理的**：

1. **npm 定位**：`siblingOrPathNpm`（`claude-update.ts:431`）靠 claude 所在目录找同级 npm——没装 claude 就没有锚点，得自己探测（`where npm` / `command -v npm`）。注意现有注释的警告：**GUI 启动的进程 PATH 可能不全**。npm 也没有时给明确指引（先装 Node），不是笼统报错。
2. **按钮挂载条件**：升级按钮挂 `verStatus?.updateAvailable`（`HealthDialog.tsx:197`），claude 缺失时恒不出现。安装按钮挂**确属「未安装」**——判据用 `currentError === "未找到 claude 命令"`；「装了但 `--version` 执行超时 / 解析失败」是另一类问题，照旧展示错误、不给安装按钮。
3. **成功后刷新两处**：弹窗内重查（复用升级完成后的逻辑），顶栏健康检查胶囊也从「claude 未找到」翻成可用——两处数据源都要接。
4. **Windows 铁律照搬**：npm.cmd 必须经 `cmd /D /S /C call`（与 `claude --version` / `claude update` 同款）；全新安装与升级同样给足超时（沿用 npm 全局安装 10 分钟的先例）。
5. **macOS**：`npm i -g` 要写 npm 全局目录，系统 node 可能 EACCES——失败把错误原样回显（`env-error` 块已有），不静默吞。

**不做（第一版）**：官方原生安装脚本（`claude.ai/install.ps1` / curl 那条路）。app 现在的重心全在 npm（升级、版本查都对 npm registry），原生安装落在 `~/.local/bin` 等路径、`locateClaude` 候选表也得跟着扩——留作后续；若做，`locateClaude` 的候选路径同步补。

**顺带价值**：新装 app 的用户第一次打开就能闭环「发现没装 → 弹窗里装好」，不用自己去查 npm 命令。

---

## 已完成

（空）
