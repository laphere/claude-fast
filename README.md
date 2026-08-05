# Claude Code 快速启动器

在 `D:\MyWorkspaces` 的各个项目目录中一键启动 Claude Code，无需手动进目录、开 cmd、敲命令。

## 目录结构

```
D:\MyWorkspaces\myProject\claude-fast\
├── claude-fast.exe          图形界面主程序（Tauri 2 编译产物，复制自 src-tauri/target/release）
├── scripts/                 启动脚本目录（全部 claude-*.bat 统一存放于此）
│   ├── claude-<项目名>.bat  每个实际项目一个启动脚本（双击即用）
│   └── claude-claude-fast.bat  本工具自身的启动条目（重新在此文件夹打开 Claude）
├── config.json              运行时生成：收藏名单（favorites）+ 主题（dark）。严禁删除！
├── config.json.bak          config.json 的上一份备份，主文件损坏时自动回退
├── src/                     前端源码（React + TypeScript + Vite）
├── src-tauri/               Rust 后端源码（Tauri 2）
├── CLAUDE.md                项目说明（进入本文件夹时 Claude 自动加载）
└── README.md
```

## 使用

双击桌面上的「Claude 快速启动」快捷方式（或直接双击项目目录里的 `claude-fast.exe`）打开图形界面。
Tauri 应用为 GUI 程序，启动时**不会出现多余的 cmd 窗口**，关闭界面即完全退出。

- **双击项目** → 在对应目录启动 Claude Code（列表中的 `claude-fast` 即是本工具自身）
- **★ 收藏** → 把常用项目置顶。点每行左侧星标，或右键项目选「收藏 / 取消收藏」；收藏名单保存在 `config.json`，重启后依然有效
- **批量添加** → 一键扫描 `D:\MyWorkspaces` 下所有含 `CLAUDE.md` 或 `.git` 的项目目录，自动批量生成启动脚本（自动跳过已存在的）
- **健康检查** → 扫描所有启动项：失效目录在列表中用**红色**标记，点按钮可弹出详细报告（含 `claude` 命令是否可用）
- **🌙 深色 / ☀ 浅色** → 切换主题，偏好保存在 `config.json`
- **右键菜单** → 收藏 / 取消收藏、打开所在文件夹、复制路径、健康检查
- **新建启动脚本** → 输入项目路径（或点「浏览」选文件夹），自动生成启动脚本
- **刷新** → 重新扫描启动脚本

## 开发与构建

技术栈：**Tauri 2（Rust 后端）+ React + TypeScript + Vite**。

```bash
# 安装依赖
npm install

# 开发模式（热更新，需要 Rust 工具链）
npm run tauri dev

# 单元测试（Rust 后端逻辑：路径解析 / bat 生成 / 配置读写 / 目录扫描）
cd src-tauri && cargo test

# 生产构建（前端构建 + Rust release 编译 + NSIS 安装包）
npm run tauri build
```

构建产物：`src-tauri/target/release/claude-fast.exe`（便携版，复制到项目根目录即可用）
和 `src-tauri/target/release/bundle/nsis/claude-fast_<版本>_x64-setup.exe`（安装包）。

### 架构要点

- **数据目录定位**：exe 从自身所在目录向上逐级查找首个含 `config.json` + `scripts/` 子目录的目录（兼容旧的 `claude-claude-fast.bat` 标记），作为数据根目录。因此 exe 放在项目根即可直接运行，整个文件夹可移动到任意位置。
- **后端**（`src-tauri/src/lib.rs`）：扫描 `scripts/` 下的 `claude-*.bat`、解析 `cd /d "..."` 路径、健康检查、生成/删除启动脚本（新建一律写入 `scripts/`）、批量扫描工作区、启动 Claude、读写 `config.json`。
- **config.json 保护**：`save_config` 采用「写临时文件 → 备份旧文件到 `.bak` → 原子替换」三步；`load_config` 读取失败时自动从 `.bak` 回退。**绝不删除 `config.json` / `.bak`**，否则用户的收藏丢失。
- **启动脚本约定**：UTF-8 编码、CRLF 换行、`chcp 65001` 后输出中文、`call claude`（不加 `call` 时 cmd 不返回，错误处理不执行）、出错时 `pause` 保留窗口。
- **批量添加的命名**：用项目相对 `D:\MyWorkspaces` 的路径，反斜杠替换为 `-`（如 `yaotu\tdc` → `claude-yaotu-tdc.bat`）。
- **前端**（`src/`）：`App.tsx` 状态管理 + 组件化 UI（列表 / 搜索 / 收藏 / 右键菜单 / 各对话框），`src/lib/api.ts` 封装 Tauri invoke 调用。

## 添加新项目

方式一：**「批量添加」按钮** —— 自动扫描 `D:\MyWorkspaces` 下所有含 `CLAUDE.md` 或 `.git` 的项目，一键全部生成启动脚本（适合初次使用或新增了多个项目时）。

方式二：「新建」按钮，输入项目路径单个添加。

方式三：手动复制 `scripts/` 下任意 `claude-xxx.bat`，改名并修改里面的这一行：

```bat
cd /d "D:\MyWorkspaces\myProject\你的新项目"
```

## 说明

- 脚本会先 `cd` 到项目目录，再调用 `call claude` 启动。
- 项目目录不存在或 `claude` 命令未找到时，会显示错误并暂停，不会直接闪退。
- Claude Code 正常退出后窗口会自动关闭。
- 各启动脚本里的目录路径是**绝对路径**（项目若移动需同步修改对应 bat）。
- 国内网络下首次 `cargo build` 拉取依赖很慢，可在 `C:\Users\<你>\.cargo\config.toml` 配置 crates.io 镜像（本项目用的是 `https://rsproxy.cn/index/` sparse 源）。
