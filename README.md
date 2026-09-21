# CC Desktop

在任意项目目录中一键启动 Claude Code，无需手动进目录、开终端、敲命令。支持 Windows 与 macOS。

## 目录结构

```
claude-fast/
├── src/                     前端源码（React + TypeScript + Vite）
├── electron/                Electron 后端（Node.js 主进程 + preload）
│   ├── main.ts              窗口 / 托盘 / 单实例 / 关闭拦截 / IPC 注册
│   ├── preload.ts           contextBridge 白名单 API（window.claudeFast）
│   └── backend/             后端业务模块（项目清单 / 会话 / 回收站 / 路径解析）
├── tools/                   开发构建脚本（dev.mjs / build-electron.mjs）
├── build/                   打包图标资源（icon.ico / icon.png / icon.icns）
├── app-icon.png             图标源文件
├── package.json / vite.config.ts / tsconfig.json / index.html
├── CLAUDE.md                项目说明（进入本文件夹时 Claude 自动加载）
└── README.md
```

> 本目录为**纯源码库**（与 GitHub 仓库一致）。程序本体通过**安装包**分发（Windows：`CC Desktop_<版本>_x64-setup.exe`；macOS：`CC Desktop-<版本>-arm64.dmg` / `-x64.dmg`）；用户数据（项目清单与收藏 `config.json`）在安装版数据目录 `%APPDATA%\claude-fast`（macOS 为 `~/Library/Application Support/claude-fast`）。

## 使用

双击桌面上的「CC Desktop」快捷方式（或开始菜单的 `CC Desktop`）打开图形界面。
Electron 应用为 GUI 程序，启动时**不会出现多余的 cmd 窗口**，关闭界面按设置退出或最小化到托盘。

- **启动 Claude Code** → 点击项目行内的「**+**」按钮，新开终端窗口进入该项目目录并运行 claude（`/k` 模式，claude 退出后窗口保留可看输出）
- **展开会话列表** → 点击项目行展开/收起其 Claude Code 会话列表（标题 + 时间 + 摘要），✎ 可重命名会话（写入 jsonl 的 custom-title，Claude Code 官方 /rename 同机制，改名后官方 CLI 同样生效）；🗑 删除会话（二次确认，删除后移入回收站）
- **🗑 回收站** → 顶部工具栏按钮；删除的会话在这里，可一键恢复（回到原项目，Claude Code 可继续 resume）或永久删除（需再次确认）
- **📖 会话内容查看** → 点击会话行，右侧区域以聊天形式显示会话内容（用户/助手消息、思考过程折叠、工具调用与结果折叠、代码块等宽渲染；超过 500 条只显示最近部分；代码变更以 Claude Code 风格 diff 呈现——带行号的增删行高亮）；点会话内容区的「刷新」按钮可重新加载该会话的最新内容
- **▶ 继续对话** → 点击会话行 ▶ 按钮（或右侧「继续对话」按钮），新开终端窗口在项目目录执行 `claude --resume <会话id>` 继续对话（窗口保持不关）
- **★ 收藏** → 把常用项目置顶。点每行左侧星标，或右键项目选「收藏 / 取消收藏」；**已收藏项可整行拖拽排序**（搜索过滤期间禁用拖拽），顺序保存在 `config.json`，重启后依然有效
- **批量添加** → 一键扫描 Claude Code 项目目录（Windows `%USERPROFILE%\.claude\projects`；macOS `~/.claude/projects`——Claude Code CLI 的规范路径），自动反向解析真实路径，勾选后一键**加入项目列表**（路径已失效的项目标红跳过，已在列表中的自动跳过）
- **健康检查** → 列表渲染后自动后台检查各项目路径；失效目录用**红色**标记且不可启动，点「健康检查」按钮可弹出详细报告（含 `claude` 命令是否可用）
- **🌙 深色 / ☀ 浅色** → 切换主题，偏好保存在 `config.json`
- **右键菜单** → 收藏 / 取消收藏、打开所在文件夹、复制路径、从列表移除（从列表移除的项目不会再被会话扫描自动加回）
- **新 建** → 输入项目路径（或点「浏览…」选文件夹），单个加入项目列表
- **开机自启动** → 设置里一键开关（Windows 写注册表 Run 项 / macOS 登录项）

## 开发与构建

技术栈：**Electron（Node.js 后端）+ React + TypeScript + Vite**。

```bash
# 安装依赖
npm install

# 开发模式（vite 热更新 + electron，主进程改动自动重启）
npm run dev

# 单元测试（Node 后端逻辑：路径解析 / 项目清单 / 配置读写 / 会话解析 / 回收站 / mangle）
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
绿色版解包安装目录中的 exe，与 config.json/scripts 同层放置即为便携模式。

构建产物（macOS）：`release/CC Desktop-<版本>-arm64.dmg` / `...-x64.dmg`（安装镜像，拖入「应用程序」即可）。

### 架构要点

- **数据目录定位（双模式）**：应用从自身所在目录向上逐级查找首个含 `config.json` + `scripts/` 子目录的目录（兼容旧的 `claude-claude-fast.bat` 标记）——**便携模式**（开发目录/绿色版/整个文件夹移动）。找不到标记时回退到 **安装模式**：`%APPDATA%\claude-fast`（macOS 为 `~/Library/Application Support/claude-fast`），首次运行自动创建 `scripts/` 目录。因此：绿色版把 exe 放项目根即可用；安装版装到 Program Files（只读）也能正常读写用户数据。
- **项目清单（去脚本化模型）**：主列表 = Claude 会话目录扫描（`unmangleCandidates` 反向解析 mangled 目录名并验证存在性，Windows 盘符格式与 macOS `/` 格式各有实现）∪ `config.projects` 手动清单，按路径去重；`excluded` 排除清单保证「从列表移除」的项目不被扫描自动加回；路径不存在的项目标红失效、不可启动。启动**不经过任何脚本文件**（`scripts/` 仅作数据根标记与旧版迁移来源保留）。
- **启动方式（Windows）**：经 `cmd /c start "Claude Code" /d "<项目>" cmd /k claude [--resume <id>]` 新开终端——⚠️ Electron GUI 主进程（无控制台）+ `stdio:"ignore"` 直接 spawn cmd 时 Windows **不分配新 console**，claude 拿不到 TTY 会静默退出且无窗口，必须经 `start`（CREATE_NEW_CONSOLE）走系统默认终端委托；不可用 `detached`（会触发 claude 2.x bash 探测弹多窗）。macOS 写临时 .sh 后 `open -a Terminal`。
- **进程模型**：渲染进程无 Node 权限（`contextIsolation: true`），全部后端能力经 `contextBridge` 暴露的 `window.claudeFast` 白名单 API（`electron/preload.ts`）走 `ipcRenderer.invoke`；`src/lib/api.ts` 保持与 Tauri 版相同的函数签名，UI 组件不感知后端实现。
- **config.json 保护**：`saveConfig` 采用「写临时文件 → 备份旧文件到 `.bak` → 原子替换」三步；`loadConfig` 读取失败时自动从 `.bak` 回退。**绝不删除 `config.json` / `.bak`**，否则用户的收藏丢失。
- **旧启动脚本迁移（一次性）**：首次启动检测到旧版 `config.json`（无 `projects` 字段）时，解析数据根 `scripts/` 下旧脚本的 `cd` 路径（兼容 bat 的 `cd /d "..."` 与 sh 的 `cd "/path"`），自动迁移为项目清单与收藏映射；脚本文件保留在磁盘不删，可自行清理。
- **打包**：electron-builder（配置在 `package.json` 的 `build` 字段）——Windows 打 NSIS（`perMachine`、可换安装目录、`zh_CN`/`en_US` 双语选择器），macOS 打 dmg（x64 + arm64）；`files` 只含 `dist/`（renderer）、`dist-electron/`（主进程）与托盘图标。
- **前端**（`src/`）：`App.tsx` 状态管理 + 组件化 UI（列表 / 搜索 / 收藏 / 右键菜单 / 各对话框），`src/lib/api.ts` 封装 preload 桥调用。

## 添加新项目

方式一：**「批量添加」按钮** —— 自动扫描 Claude Code 项目目录 `~/.claude/projects`（Claude Code 管理过的所有项目），目录名反向解析出真实路径；已被删除的项目标红失效、不参与勾选；已在列表中的自动跳过；勾选后一键加入项目列表（适合初次使用或新增了多个项目时）。

方式二：「新 建」按钮，输入项目路径（或点「浏览…」选择文件夹）单个添加。

## 说明

- 启动/继续对话均为**新开终端窗口**在项目目录运行 claude；Windows 用 `cmd /c start` 链走系统默认终端委托，macOS 用 Terminal.app。
- Windows 采用 `/k` 模式：claude 退出后终端窗口保留，便于查看输出。
- 项目清单、收藏、主题、自启动等全部保存在 `config.json`；从列表移除的项目会记入排除清单，不会被会话扫描自动加回。
- **跨平台**：Windows 与 macOS 行为一致（项目清单/会话管理/回收站/批量添加全部支持）；Claude Code CLI 的会话目录为 `~/.claude/projects`（规范路径），批量添加来源即此。
- Electron 依赖（含二进制）通过 npm 安装；国内网络可在环境变量中设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 加速首次安装。
