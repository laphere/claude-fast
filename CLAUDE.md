# Claude Code 快速启动器（claude-fast）

在本项目文件夹 `D:\MyWorkspaces\myProject\claude-fast` 中维护一个**一键在 `D:\MyWorkspaces` 各项目目录启动 Claude Code** 的工具集。

## 核心文件

| 文件 | 作用 |
|---|---|
| `src/` | 前端源码：React + TypeScript + Vite（`App.tsx` 状态管理，`src/lib/api.ts` 封装 Tauri invoke）|
| `src-tauri/` | 后端源码：Tauri 2 + Rust（全部 commands 在 `src/lib.rs`，含单元测试 `#[cfg(test)]`）|
| `README.md` | 使用说明、构建方法、架构要点 |

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe、scripts、config.json——这些运行时产物/用户数据都在安装版数据目录 `%APPDATA%\claude-fast`（见下）。

## 工作方式

- 每个 `claude-*.bat` 内容固定为：`cd /d "项目路径"` → 检查 `claude` 命令 → `call claude`。
- **必须写 `call claude` 而不是 `claude`**：`claude` 是 `claude.cmd` shim，批处理调用其他 .cmd 不加 `call` 时 cmd 不返回，错误处理不执行。
- 脚本约定：UTF-8 编码、CRLF 换行、`chcp 65001` 后输出中文、出错时 `pause` 保留窗口。
- GUI 功能：收藏置顶（`favorites`）、健康检查（失效目录红色标记）、批量添加（扫描 MyWorkspaces 含 CLAUDE.md/.git 的项目）、深色主题（`dark`）、搜索过滤、右键菜单、新建/删除启动脚本，状态存 `config.json`。
- 健康检查**不阻塞启动**：`list_launchers` 只解析路径不做目录 stat（秒返回）；前端渲染后异步调用 `check_launchers` 并行检查（阻塞线程池执行），结果回来自动标红失效项；「健康检查」对话框打开时现场重新检查。
- 收藏交互：点列表行左侧星标或右键菜单收藏；已收藏项目星标变金色并置顶。
- 批量添加的命名：用项目相对 `D:\MyWorkspaces` 的路径，反斜杠替换为 `-`（如 `yaotu\tdc` → `claude-yaotu-tdc.bat`）；新建/批量添加生成的 bat 一律写入数据根的 `scripts/`。
- **数据根目录定位（双模式）**：`resolve_root_dir()` 先便携模式（exe 所在目录向上查找含 `config.json` + `scripts/` 的目录，或旧标记 `claude-claude-fast.bat`），找不到则回退**安装模式** `%APPDATA%\claude-fast`（macOS 为 `~/Library/Application Support/claude-fast`），首次运行自动创建 `scripts/`。**安装版（推荐）**：装完即用，用户数据在 `%APPDATA%\claude-fast`；便携版需把 exe 与 config/scripts 同层放置。
- **config.json 收藏保护**：`save_config` 采用「写临时文件 → 备份旧文件到 `.bak` → 原子替换」三步；`load_config` 读取失败时自动从 `.bak` 回退。更新代码时**绝不删除 `config.json` / `.bak`**（用户数据在 `%APPDATA%\claude-fast`），否则用户的收藏丢失。

## 开发命令

```bash
npm install              # 前端依赖
npm run tauri dev        # 开发模式（热更新）
cd src-tauri && cargo test   # 后端单元测试（12 个用例：路径解析/bat 生成/配置/扫描/根目录定位）
npm run tauri build      # 生产构建（exe + NSIS 安装包，安装界面中英双语、可选安装目录、免管理员）
```

> 安装包（NSIS，`installMode: currentUser`）安装到 `%LOCALAPPDATA%\Programs\claude-fast`，用户数据在 `%APPDATA%\claude-fast\`（首次运行自动创建 `scripts/`）；便携模式（exe 与 config.json/scripts 同层）数据仍在 exe 目录。两者由 `resolve_root_dir()` 自动区分。

> ⚠️ **必须用 `npm run tauri build`（或 `npx tauri build`）构建，禁止直接 `cargo build --release`**：只有 tauri CLI 会自动加 `--features tauri/custom-protocol`，缺少该 feature 时产物是 dev 模式，运行时去连 `http://localhost:1420`（devUrl）导致白屏报「localhost 拒绝连接」。

## 新增项目

1. GUI 里点「新建启动脚本」输入路径（或「批量添加」扫描整个工作区），脚本自动生成到数据根（安装版为 `%APPDATA%\claude-fast\scripts`）的 `scripts/`；或
2. 复制数据根 `scripts/` 下任意 `claude-xxx.bat`，改名并修改 `cd /d` 那一行为新项目路径。

## 注意

- 各启动脚本里的目录路径是**绝对路径**（项目若移动需同步修改对应 bat）。
- `src-tauri/src/lib.rs` 里 `WORKSPACE_ROOT` 常量固定为 `D:\MyWorkspaces`（批量添加扫描范围，如需修改改这里并重新编译）。
- 前端源码为 UTF-8 无 BOM（Vite 正常处理），无需旧版 PowerShell 的 BOM 约束。
- 国内网络首次 `cargo build` 需配置 crates.io 镜像（见 README「说明」）。
- 构建产物为**安装包**（`src-tauri/target/release/bundle/nsis/claude-fast_<版本>_x64-setup.exe`）；需要便携 exe 时从 `src-tauri/target/release/` 复制（便携模式需与 config.json/scripts 同层放置）。
