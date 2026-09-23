# CC Desktop

Claude Code 的桌面工作台：项目与会话集中管理，支持 **app 内直接对话**（官方 Agent SDK）、**内嵌终端**（真 CLI 跑在 PTY 里）与系统终端三种交互方式，并内置供应商切换、token 用量统计、回收站等工具。支持 Windows 与 macOS。

> **前置要求**：本机已安装 Claude Code CLI（`claude` 在 PATH 中）并完成登录。app 内对话与内嵌终端都直接调用本机 claude，应用不内置 CLI——探测不到时对话层会直接报错，不静默回退。

## 目录结构

```
claude-fast/
├── src/                     前端源码（React + TypeScript + Vite）
│   ├── App.tsx              全局状态（项目清单 / 会话 / 对话与终端 tab / 配置落盘）
│   ├── components/          UI 组件（项目列表 / 对话视图 / 终端面板 / 各类对话框）
│   ├── lib/                 preload 桥封装（api.ts）与终端、代码高亮等前端库
│   └── config/              供应商预设常量
├── electron/                Electron 后端
│   ├── main.ts              窗口 / 托盘 / 单实例 / 关闭拦截 / IPC 注册
│   ├── preload.ts           contextBridge 白名单 API（window.claudeFast）
│   └── backend/             业务模块（配置 / 对话 / 终端 / 会话 / 供应商 / 用量统计…）
├── tools/                   开发构建脚本（dev.mjs / build-electron.mjs）
├── build/                   打包图标资源（icon.ico / icon.png / icon.icns）
├── docs/                    设计与行为规格文档
└── package.json / vite.config.ts / tsconfig.json / index.html
```

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe 与用户数据。程序本体通过**安装包**分发（Windows：`CC Desktop_<版本>_x64-setup.exe`；macOS：`CC Desktop-<版本>-arm64.dmg` / `-x64.dmg`）；用户数据（`config.json`）在数据根目录（见下文「数据根目录」）。

## 界面与功能

单行顶栏 + 左侧可收起项目栏（窄窗口自动收起）。顶栏右侧是全部功能入口（纯图标按钮：搜索 / 添加项目 / 批量添加 / 回收站 / 统计 / 设置），右端两个状态胶囊：**供应商**（当前生效的供应商，未配置显示「默认配置」）与**健康检查**（claude 可用性，有失效项目时变红并带「N 失效」角标）。左栏顶部搜索框按需展开，可按项目名 / 路径过滤。

### 项目管理

- **添加项目**：顶栏「+」输入路径（或浏览选文件夹）单个添加；「批量添加」扫描 Claude Code 项目目录（`~/.claude/projects`），反向解析 mangled 目录名为真实路径一键导入。路径已失效的项目标红、不可启动，可二次确认后清除其残留数据。
- **新建会话**：项目行「+」按钮，按设置的「默认交互方式」开**页面对话**或**内嵌终端**（两种 tab 始终共存，改设置不关已开 tab）。
- **拖拽排序**：项目行整行拖拽调序，顺序保存到 `config.json`，重启后依然有效（搜索过滤期间禁用拖拽）。
- **右键菜单**：移到最前 / 在系统终端中新建会话 / 打开所在文件夹 / 复制路径 / 从列表移除（移除的项目不会被扫描自动加回）。

### 会话管理

- 点击项目行展开其会话列表（标题 + 时间，按修改时间倒序）。标题回退链：手动重命名 > AI 生成标题 > 首条用户消息；只执行过命令、无实质对话的会话不进列表。
- **点击会话行 = 打开只读会话页**：只渲染历史内容，不启动进程、不改文件——查看不是破坏性操作。头部「刷新」旁的 **▶ 继续对话** 按钮把它切换为可发言，按「默认交互方式」分发：页面对话就地把只读页变可发言，内嵌终端则开一个 resume 的终端 tab。
- **会话内容查看**：聊天式渲染历史消息，思考过程与工具调用折叠展示（一轮工具循环合并为一行摘要）；左侧用户发言导航轨（悬停预览、点击跳转）；「变更文件」面板聚合会话中编辑过的文件；会话内全文搜索；导出 Markdown / JSONL；头部显示 token 统计。
- **重命名 / 删除 / 置顶**：右键会话行操作。重命名与官方 `/rename` 同机制（向 jsonl 追加 custom-title 行，官方 CLI 同样生效）；删除先进回收站，可恢复（回原目录，可继续 resume）或永久删除；置顶的会话聚到左栏顶部**跨项目**区域（带项目名徽标），删除后条目保留、恢复时自动复活。

### app 内对话（页面对话）

基于官方 `@anthropic-ai/claude-agent-sdk` 托管 CLI 子进程，流式渲染：

- **懒启动**：首条消息才启动进程，失败可重试；多会话 tab 并行，切换 tab 不中断后台流式。
- **权限 6 档**：每工具确认 / 自动 / 接受编辑 / 计划模式 / 完全权限（bypass）/ 不询问；初始档位跟随本机 settings，CLI 自己切的档位（如进出计划模式）实时同步到输入框旁的模式选择器。
- **三类交互卡片**：工具权限确认（允许 / 拒绝）、模型提问（选项作答）、方案审批（批准并恢复原档位 / 批准逐个确认 / 继续修改），方案预览可展开为全屏阅读模式。
- **图片**：粘贴或拖入 PNG / JPEG / GIF / WebP（单图 ≤4.5MB），支持纯图无文本发送。
- **中断与撤回**：忙碌时可中断；本轮模型还没开口时，「停止」即撤回——刚发的消息（连图片）退回输入框，改完直接重发（Esc 是主入口）。
- **AI 会话标题**：新会话首轮自动生成（与官方 TUI 同机制落盘），列表与 tab 同步显示真名字。
- **落盘互通**：与终端共用同一份 `~/.claude/projects/<项目>/<会话id>.jsonl`，app 内开的对话可直接在终端 `--resume`，反之亦然。

### 内嵌终端

真 claude CLI 跑在应用内 PTY 终端里（node-pty + xterm.js），与对话 tab 同一条 tab 栏：

- 渲染对齐系统终端观感（等宽步进字体 + WebGL 渲染），支持 256 色 / truecolor。
- **剪贴板贴图**：复制的图片文件可直接粘贴（图片路径送入 PTY，claude 识别为 `[Image #1]`）。
- **忙闲保护**：关闭 tab 前探测终端是否忙碌，正在输出时不可关（宁漏关不误杀）；关闭即杀整棵进程树。
- 新会话标题自动回填（终端标题 + 会话文件双路探测）。

### 系统终端

右键菜单「在系统终端中新建会话 / 继续对话」：Windows 新开终端窗口在项目目录运行 claude（`/k` 模式，claude 退出后窗口保留可看输出）；macOS 打开 Terminal.app。

### 供应商与其他工具

- **供应商切换**：88 个预设模板 + 自定义（JSON 文本为唯一事实来源，结构化字段双向同步），可拉取供应商模型列表，可一键导入 CC Switch 备份（.sql）；切换 = 整份写入 live `settings.json`（原子写 + `.bak` 备份，离任供应商内容自动回填清单）。切换只影响新会话。
- **Coding Plan 用量查询**：Kimi / 智谱 GLM / MiniMax / ZenMux / OpenCode Go 五家订阅用量（key 取自该供应商配置，非已知厂商自动隐藏）。
- **使用统计**：token 用量仪表盘（近 7 天 / 30 天 / 全部），按日 / 月趋势、项目排行、模型分布；数据来自本地增量扫描的用量台账，已删会话仍计入。
- **健康检查**：claude 是否在 PATH、各项目目录是否存在、Claude Code 版本 vs npm 最新版（可一键升级）、失效项目一键清理。
- **其他**：深色 / 浅色主题、关闭行为（退出 / 最小化到托盘 / 每次询问）、系统托盘、开机自启动、单实例（重复启动唤起已有窗口）。

## 数据根目录（双模式）

应用启动时自动定位数据根（存放 `config.json` 等用户数据）：

1. **便携模式**：从 exe 所在目录向上（最多 6 级）查找首个数据根标记——`config.json`（或 `.bak`）通过内容校验：为 JSON 对象，且是空对象 `{}`（显式引导便携模式）或含 ≥2 个本应用已知字段。开发目录、整体移动的文件夹、绿色版走此路径。
2. **安装模式**：找不到标记时回退 `%APPDATA%\claude-fast`（macOS 为 `~/Library/Application Support/claude-fast`），首次运行自动创建。

因此：绿色版取安装目录内容，与 `config.json` 同层放置即为便携模式；安装版装到 Program Files（只读）也能正常读写用户数据。解析结果进程内缓存，运行期间不会换根。

`config.json` 保存：项目顺序与清单（`order` / `projects` / `excluded`）、主题、关闭行为、默认交互方式（`chat` / `terminal`）、供应商清单与当前供应商、置顶会话。写入采用「临时文件 → 备份 `.bak` → 原子替换」三步保护，读取失败自动从 `.bak` 回退，任何情况下不会删除该文件。

## 开发与构建

技术栈：**Electron（Node.js 后端）+ React + TypeScript + Vite**；对话层用官方 `@anthropic-ai/claude-agent-sdk`，内嵌终端用 node-pty + xterm.js。

```bash
# 安装依赖（国内可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 加速）
npm install

# 开发模式（vite 热更新 + electron，主进程改动自动重启）
npm run dev

# 单元测试（路径解析 / 配置 / 扫描 / 根目录定位 / 会话管理 / mangle / 回收站 / 终端 PTY / 剪贴板图片 / 对话层 / 用量台账）
npm test

# 类型检查（前端 + electron 主进程）
npm run typecheck

# 生产构建（类型检查 + 前端 vite 构建 + 主进程 esbuild 编译）
npm run build

# 打包安装包（Windows：NSIS 安装包；macOS：.dmg，x64 + arm64）
npm run dist:win
npm run dist:mac
```

构建产物（Windows）：`release/CC Desktop_<版本>_x64-setup.exe`（NSIS 安装包，默认装到 `C:\Program Files\CC Desktop`，可选择安装目录、免管理员、中英双语界面）。

构建产物（macOS）：`release/CC Desktop-<版本>-arm64.dmg` / `...-x64.dmg`（安装镜像，拖入「应用程序」即可）。

### 架构要点

- **进程模型**：渲染进程无 Node 权限（`contextIsolation: true`），全部后端能力经 `contextBridge` 暴露的 `window.claudeFast` 白名单 API（`electron/preload.ts`）走 `ipcRenderer.invoke`。
- **项目清单（路径模型）**：主列表 = Claude 会话目录扫描 ∪ `config.projects` 手动清单，按路径去重；`excluded` 排除清单保证「从列表移除」的项目不被扫描自动加回。启动/续聊直接开终端运行 claude，不经过任何脚本文件。
- **系统终端启动链（Windows）**：经 `cmd /c start "Claude Code" /d "<项目>" cmd /k claude [--resume <id>]` 新开终端——Electron GUI 主进程直接 spawn cmd 时 Windows 不分配新 console，claude 拿不到 TTY 会静默退出，必须经 `start`（CREATE_NEW_CONSOLE）走系统默认终端委托。macOS 写临时 .sh 后 `open -a Terminal`。
- **对话层**：Agent SDK 运行时动态 `import()`（ESM），`pathToClaudeCodeExecutable` 指向本机 claude 可执行文件；权限确认 / 提问 / 方案审批经 `canUseTool` 通道下发。
- **配置写入**：一律读改写（`updateConfig` / `mutateConfig`）并持锁串行，落盘保留未知字段，不会从参数重建整份配置。
- **打包约束**（实测踩坑，改打包配置勿动）：node-pty 与 Agent SDK 主包必须保持 esbuild `external` + electron-builder `asarUnpack`（native 模块与 ESM 动态加载需要真实文件路径）；SDK 平台包（各含一份 237MB claude.exe）从 `build.files` 排除、不进安装包——app 内对话只认本机 claude。

## 说明

- 会话数据全部落在 Claude Code 官方目录 `~/.claude/projects/<mangled>/<会话id>.jsonl`，本应用与官方 CLI 完全互通（resume / 重命名 / 标题一致）；`CLAUDE_CONFIG_DIR` 自定义数据目录优先于默认路径。
- 窗口重新聚焦时自动刷新会话列表与置顶区（1.5s 节流）；正在阅读的会话内容不自动刷新（会话页自带刷新按钮，保持过期优于打扰阅读）。
- **跨平台**：Windows 与 macOS 行为一致（项目清单 / 会话管理 / 回收站 / 批量添加 / 对话 / 终端全部支持）。
- Electron 依赖（含二进制）通过 npm 安装；国内网络可用环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 加速首次安装。
