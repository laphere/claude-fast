// Electron 主进程：窗口 / 托盘 / 单实例 / 关闭拦截 / 全部 IPC 命令
// （对齐原 Tauri 后端 lib.rs 的 run() + 22 个 commands）
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  dropPinsForProjects,
  mutateConfig,
  loadConfig,
  updateConfig,
  type ConfigPatch,
} from "./backend/config";
import {
  addProject,
  checkClaude,
  checkLaunchers,
  launchProject,
  legacyScriptPaths,
  listProjects,
  openFolder,
  removeProject,
  resumeSession,
  scanClaudeProjects,
  scriptsDirOf,
} from "./backend/platform";
import {
  claudeProjectsDir,
  resolveRootDir,
  type RootResolution,
} from "./backend/paths";
import {
  getSessionMessages,
  listSessions,
  renameSession,
  validateSessionFile,
} from "./backend/sessions";
import {
  deleteSessionFile,
  listTrashedSessionsIn,
  purgeSessionBackup,
  purgeTrashIn,
  restoreTrashedFile,
  validateTrashFile,
} from "./backend/trash";
import type { IpcContract } from "./ipc-contract";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true 时 close 事件不再拦截（quit_app / window_destroy / before-quit 已置位） */
let quitting = false;

// ---------------- 数据根（paths.ts 内按 exe 路径缓存；exe 位置运行期不变） ----------------

function rootInfo(): RootResolution {
  return resolveRootDir(process.execPath);
}

function rootDir(): string {
  return rootInfo().root;
}

function projectsDir(): string {
  return claudeProjectsDir();
}

function trashRootDir(): string {
  return path.join(rootDir(), "trash", "sessions");
}

// ---------------- IPC 包装：后端抛错统一转为字符串（对齐 Tauri Err(String)） ----------------

function wrap<A extends unknown[]>(fn: (...args: A) => unknown) {
  return async (...args: A): Promise<unknown> => {
    try {
      return await fn(...args);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  };
}

// 注意：ipcMain.handle 的 handler 首参是 IpcMainInvokeEvent，必须剥离后再把
// contract payload 交给业务函数（曾因把 event 当 payload 用，批量添加的
// create_launcher 收到 "[object Object]" 而全部报「路径不存在」）
function handle<K extends keyof IpcContract>(
  channel: K,
  fn: (payload: IpcContract[K]) => unknown,
): void {
  ipcMain.handle(channel, (_event, payload: IpcContract[K]) => wrap(fn)(payload));
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  return undefined;
}

// ---------------- 旧脚本清单一次性迁移（去脚本化） ----------------
// 脚本时代的 config.favorites 存的是脚本名 key；迁移时解析数据根 scripts/ 下
// 旧脚本的 cd 路径完成 key → 项目路径映射：
//   projects  = 全部脚本指向的项目路径
//   favorites = 旧收藏 key 映射后的项目路径（找不到的丢弃）
// 判定：config.json 原始内容含 "projects" 字段（或无 config 文件）即视为已迁移。
async function ensureProjectsMigrated(): Promise<void> {
  const root = rootDir();
  const cfgPath = path.join(root, "config.json");
  let raw: { projects?: unknown; favorites?: unknown } | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return; // 无 config（全新安装）或不可读——交由 loadConfig 兜底
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw.projects)) return;

  const keyToPath = legacyScriptPaths(scriptsDirOf(root));
  const legacyFavs = Array.isArray(raw.favorites) ? raw.favorites.map(String) : [];
  const migratedFavs = [
    ...new Set(legacyFavs.map((k) => keyToPath.get(k)).filter((p): p is string => !!p)),
  ];
  try {
    await mutateConfig(root, (cfg) => {
      cfg.projects = [...new Set(keyToPath.values())];
      cfg.favorites = migratedFavs;
      // 显示顺序初值：旧「收藏置顶」顺序即用户心中的优先级
      if (cfg.order.length === 0) cfg.order = [...migratedFavs];
    });
  } catch {
    // 写失败时保留内存态本次会话仍可用
  }
}

// ---------------- 窗口与托盘 ----------------

function appIcon(): { app: string; tray: string } {
  // nativeImage 不能从 asar 内读图——打包后图标放 extraResources（resources/），
  // 开发模式直接读 build/；icon.ico 仍由 electron-builder 嵌入 exe 与安装包
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "build");
  return {
    app: path.join(base, "icon128.png"),
    tray: path.join(base, "icon.png"),
  };
}

/** 把主窗口显示到最前台（托盘「显示窗口」/ 托盘左键 / 单实例回调共用）。
 *  Windows 前台锁定：先强制置顶再取消，确保窗口真正浮到最前（对齐 Rust 版）。 */
function showMainWindow(): void {
  const w = mainWindow;
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  w.setAlwaysOnTop(true);
  w.setAlwaysOnTop(false);
}

function quitApp(): void {
  quitting = true;
  app.exit(0);
}

function createTray(): void {
  const { tray: trayIconPath } = appIcon();
  const image = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(image);
  tray.setToolTip("Claude助手");
  const menu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => showMainWindow() },
    { label: "退出程序", click: () => quitApp() },
  ]);
  // 左键点击显示窗口、右键弹菜单。
  // 不用 setContextMenu：Windows 上设置了之后左键单击也会弹菜单，
  // 会顶掉「左键显示窗口」行为（对齐 Tauri 版 show_menu_on_left_click(false)）。
  tray.on("click", () => showMainWindow());
  tray.on("right-click", () => {
    tray?.popUpContextMenu(menu);
  });
}

function createWindow(): void {
  const { app: appIconPath } = appIcon();
  mainWindow = new BrowserWindow({
    title: "Claude助手",
    width: 920,
    height: 660,
    minWidth: 680,
    minHeight: 500,
    center: true,
    resizable: true,
    icon: appIconPath,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // 关闭拦截：交给前端按 close_action 决定（隐藏到托盘 / 询问 / 退出）
  mainWindow.on("close", (e) => {
    if (quitting || !mainWindow) return;
    e.preventDefault();
    mainWindow.webContents.send("window:close-requested");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 防拖拽文件/链接导致页面导航（保持 HTML5 拖拽排序可用），并禁止弹新窗口
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    void mainWindow.loadURL(DEV_SERVER_URL);
  }
}

// ---------------- IPC 注册 ----------------

function registerIpc(): void {
  // ---------- 项目清单（去脚本化） ----------
  handle("list_projects", () =>
    listProjects(projectsDir(), loadConfig(rootDir()).projects, loadConfig(rootDir()).excluded));
  handle("load_config", () => loadConfig(rootDir()));
  // 只覆盖 payload 里出现过的键，其余从磁盘读回——从参数重建会清掉未传字段
  handle("save_config", (p) => {
    const patch: ConfigPatch = {};
    if (p.favorites !== undefined) patch.favorites = (p.favorites ?? []).map(String);
    if (p.order !== undefined) patch.order = (p.order ?? []).map(String);
    if (p.projects !== undefined) patch.projects = (p.projects ?? []).map(String);
    if (p.excluded !== undefined) patch.excluded = (p.excluded ?? []).map(String);
    if (p.dark !== undefined) patch.dark = p.dark === true;
    if (p.closeAction !== undefined) patch.closeAction = p.closeAction;
    if (p.pinnedSessions !== undefined) patch.pinnedSessions = p.pinnedSessions;
    return updateConfig(rootDir(), patch);
  });
  handle("add_project", (p) =>
    mutateConfig(rootDir(), (cfg) => {
      cfg.projects = addProject(cfg.projects, String(p.path));
      // 重新加入 = 解除排除
      cfg.excluded = cfg.excluded.filter((x) => x.toLowerCase() !== String(p.path).toLowerCase());
    }));
  handle("remove_project", (p) =>
    mutateConfig(rootDir(), (cfg) => {
      const target = String(p.path);
      cfg.projects = removeProject(cfg.projects, target);
      // 显示顺序与旧收藏清单同步移除（列表键已变为项目路径）
      cfg.order = cfg.order.filter((v) => v.toLowerCase() !== target.toLowerCase());
      cfg.favorites = cfg.favorites.filter((f) => f.toLowerCase() !== target.toLowerCase());
      // 项目级的置顶会话条目一并撤掉，否则置顶区留下孤儿条目
      dropPinsForProjects(cfg, [target]);
      // 加入排除清单：会话扫描会重新发现该项目，必须过滤才能让「移除」生效
      if (!cfg.excluded.some((x) => x.toLowerCase() === target.toLowerCase())) {
        cfg.excluded.push(target);
      }
    }));
  handle("launch_project", (p) => launchProject(String(p.path)));
  handle("open_folder", (p) => openFolder(String(p.path)));
  handle("check_claude", () => checkClaude());
  handle("check_projects", (p) =>
    checkLaunchers(Array.isArray(p.paths) ? p.paths.map(String) : []));

  // ---------- 批量添加 ----------
  handle("scan_claude_projects", () => scanClaudeProjects(projectsDir()));
  handle("get_claude_projects_dir", () => projectsDir());

  // ---------- 会话管理 ----------
  handle("list_sessions", (p) => listSessions(projectsDir(), String(p.projectPath)));
  handle("rename_session", (p) =>
    renameSession(String(p.file), String(p.newTitle), projectsDir()));
  handle("delete_session", (p) => {
    // 校验（限 projects 目录下 uuid.jsonl）后移入回收站（先备份再删除）
    const { path: fp } = validateSessionFile(String(p.file), projectsDir());
    return deleteSessionFile(fp, trashRootDir());
  });
  handle("list_trashed_sessions", () => listTrashedSessionsIn(trashRootDir()));
  handle("restore_session", (p) => {
    const { path: fp } = validateTrashFile(String(p.file), rootDir());
    return restoreTrashedFile(fp, projectsDir());
  });
  handle("purge_session", (p) => purgeSessionBackup(String(p.file), rootDir()));
  handle("purge_trash", () => purgeTrashIn(trashRootDir()));
  handle("get_session_messages", (p) =>
    getSessionMessages(String(p.file), projectsDir(), toInt(p.offset)));
  handle("resume_session", (p) =>
    resumeSession(String(p.file), String(p.projectPath), projectsDir()));

  // ---------- 其他 ----------
  handle("get_data_root", () => {
    const info = rootInfo();
    return { path: info.root, installMode: info.installMode };
  });
  handle("quit_app", () => quitApp());

  // ---------- 开机自启动（Windows 注册表 Run 项 / macOS 登录项，官方 API） ----------
  handle("autostart_supported", () => true);
  handle("autostart_enabled", () => {
    try {
      return app.getLoginItemSettings().openAtLogin === true;
    } catch {
      return false;
    }
  });
  handle("autostart_turn_on", () => {
    app.setLoginItemSettings({ openAtLogin: true });
  });
  handle("autostart_turn_off", () => {
    app.setLoginItemSettings({ openAtLogin: false });
  });

  // ---------- 窗口控制（替代 @tauri-apps/api/window 与 plugin-dialog） ----------
  handle("pick_folder", async (p) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: typeof p.title === "string" && p.title !== "" ? p.title : "选择项目文件夹",
      properties: ["openDirectory", "dontAddToRecent"],
      buttonLabel: "选择此文件夹",
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle("window_hide", () => {
    mainWindow?.hide();
  });
  handle("window_destroy", () => {
    quitting = true;
    mainWindow?.destroy();
  });
}

// ---------------- userData 隔离 ----------------
// Electron 默认 userData = %APPDATA%/claude-fast，会与数据根撞目录（Chromium
// 缓存文件混进用户数据）；必须在 app ready 之前重定向到独立 userdata/ 子目录
{
  const userDataDir = path.join(app.getPath("appData"), "claude-fast", "userdata");
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    app.setPath("userData", userDataDir);
  } catch {
    // 设置失败时保持默认路径
  }
}

// ---------------- 单实例 ----------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.claudefast.launcher");
    Menu.setApplicationMenu(null);
    await ensureProjectsMigrated();
    registerIpc();
    createWindow();
    createTray();

    app.on("activate", () => {
      // macOS：dock 图标点击时显示窗口（窗口可能已隐藏到托盘）
      showMainWindow();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("window-all-closed", () => {
    // 关闭行为由前端拦截决定，走到这里即窗口真正销毁——退出
    app.quit();
  });
}
