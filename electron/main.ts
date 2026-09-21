// Electron 主进程：窗口 / 托盘 / 单实例 / 关闭拦截 / 全部 IPC 命令
// （对齐 v2.0.0 后端 lib.rs 的 commands 面；对话层改用官方 Agent SDK，见 backend/chat.ts）
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
} from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  dropPinsForProjects,
  mutateConfig,
  loadConfig,
  pruneDeadPins,
  updateConfig,
  type ConfigPatch,
} from "./backend/config";
import { ChatManager, defaultPermissionMode } from "./backend/chat";
import { claudeRunUpgrade, claudeUpdateStatus } from "./backend/claude-update";
import { PtyManager } from "./backend/pty";
import { clipboardImagePath } from "./backend/clipboard-image";
import { fetchModels } from "./backend/model-fetch";
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
  claudeConfigDir,
  openUrl,
  providerDeleteFrom,
  providerImportCcswitchFrom,
  providerListFrom,
  providerQueryUsageFrom,
  providerReadLiveFrom,
  providerReorderFrom,
  providerSaveFrom,
  providerSwitchFrom,
} from "./backend/provider";
import {
  claudeProjectsDir,
  resolveRootDir,
  type RootResolution,
} from "./backend/paths";
import {
  getSessionMessages,
  listSessions,
  renameSession,
  sessionFileAndTitle,
  sessionTitleFor,
  validateSessionFile,
} from "./backend/sessions";
import {
  exportSession,
  getSessionUserPrompts,
  listPinnedSessions,
  purgeClaudeProjectData,
  searchSessionMessages,
} from "./backend/session-extra";
import {
  deleteSessionFile,
  listTrashedSessionsIn,
  purgeSessionBackup,
  purgeTrashIn,
  restoreTrashedFile,
  validateTrashFile,
} from "./backend/trash";
import { getUsageStats } from "./backend/usage-stats";
import type { IpcContract } from "./ipc-contract";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true 时 close 事件不再拦截（quit_app / window_destroy / before-quit 已置位） */
let quitting = false;
/** before-quit 只拦一次：等对话子进程优雅退出后再放行真正的退出 */
let chatExitDone = false;

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

// ---------------- 对话层：ChathManager + 事件定向推送 ----------------

/** 会话 id → 渲染层 token。事件只发给发起该会话的窗口/标签（多 tab 并行的 Divergence 防线） */
const chatTokens = new Map<string, string>();

const chatManager = new ChatManager((sessionId, event) => {
  const token = chatTokens.get(sessionId);
  if (!token || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`chat:event:${token}`, event);
});

// ---------------- 内嵌终端：PtyManager + 事件定向推送 ----------------

/** 终端会话 id → 渲染层 token（与 chatTokens 同款：事件只发给发起该终端的 tab） */
const ptyManager = new PtyManager();

/** 关闭全部终端会话（app 退出路径调用；树杀契约见 backend/pty.ts） */
function shutdownPtySessions(): void {
  ptyManager.shutdownAll();
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

/**
 * 图标文件路径。nativeImage 不能从 asar 内读图——打包后图标放 extraResources
 * （resources/），开发模式直接读 build/；icon.ico 仍由 electron-builder 嵌入 exe 与安装包。
 *
 * ⚠️ 开发模式的 `128x128@2x.png` 带 `@2x` 后缀，Electron 会按「2 倍图」解读
 * （`getSize()` 返回逻辑尺寸 128×128），像素仍是 256×256，缩放按物理像素走，
 * 与打包后的 `icon128.png` 同一份内容。旧版这里在 dev 下指向不存在的
 * `icon128.png`，窗口图标其实是空的（静默退回 Electron 默认图标）。
 */
function appIcon(): { app: string; trayMaster: string } {
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "build");
  const big = path.join(base, app.isPackaged ? "icon128.png" : "128x128@2x.png");
  return { app: big, trayMaster: big };
}

/**
 * 托盘图标：交 256×256 主图，**不做缩放**，托盘位怎么缩交给系统
 * （Tauri 版交给系统的也是 .ico 的第 0 帧 = 256×256，见 tauri-codegen image.rs）。
 *
 * ⚠️ 别在这里自己 resize「凑精确尺寸」：实测（16/24/32/48/256 五种输入各挂一个托盘图标对照）
 * 本 app 的托盘观感与传入尺寸**基本无关**——因为本进程声明了 `dpiAware=true/pm`
 * （每显示器 DPI 感知），系统一律按真实托盘位（150% 缩放 → 24×24）重绘。
 *
 * ⚠️ 也别把「Rust 版托盘图标更亮更柔」当成自己的 bug 去追：那个 app 的清单里
 * **没有任何 DPI 声明**（DPI 不感知），系统会把它的图标按 16px 渲染再拉大到 24px，
 * 于是更糊更淡——同一张截图里量：本 app 实心占比 0.52-0.59 / 均亮度 146-155，
 * Rust 版 0.456 / 176（spread 更大、更淡）。真要比「谁对」，是本 app 这边更接近原生。
 */
function trayImage(): Electron.NativeImage {
  const p = appIcon().trayMaster;
  const img = nativeImage.createFromBuffer(fs.readFileSync(p));
  return img.isEmpty() ? nativeImage.createFromPath(p) : img;
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

async function quitApp(): Promise<void> {
  quitting = true;
  // 先优雅关掉对话子进程（关 stdin、最多等 3s 让 CLI 把 jsonl 收尾）再退出：
  // app.exit() 会立刻终止进程、连 before-quit 都不走，漏了这一步就会砍在半路。
  await chatManager.closeAll();
  // 终端会话走强杀（taskkill /T /F）：ConPTY 无优雅收尾协议，等树杀完再退
  shutdownPtySessions();
  app.exit(0);
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("CC Desktop");
  const menu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => showMainWindow() },
    { label: "退出程序", click: () => void quitApp() },
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
    title: "CC Desktop",
    width: 1120,
    height: 720,
    minWidth: 800,
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

  // 窗口获得焦点（替代 Tauri 的 onFocusChanged）：终端里跑完 claude 回来、
  // 托盘/单实例唤起时前端自动刷新会话列表
  mainWindow.on("focus", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("window:focused");
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

/** 把前端传来的过滤器整成 Electron 的 filters（`[{name, extensions}]`） */
function toDialogFilters(
  raw: { name: string; extensions: string[] }[] | undefined,
): { name: string; extensions: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f.name === "string" && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name, extensions: f.extensions.map(String) }));
}

function registerIpc(): void {
  // ---------- 项目清单（去脚本化） ----------
  handle("list_projects", () =>
    listProjects(projectsDir(), loadConfig(rootDir()).projects, loadConfig(rootDir()).excluded));
  handle("load_config", () => loadConfig(rootDir()));
  // 只覆盖 payload 里出现过的键，其余从磁盘读回——从参数重建会清掉未传字段
  handle("save_config", (p) => {
    const patch: ConfigPatch = {};
    if (p.order !== undefined) patch.order = (p.order ?? []).map(String);
    if (p.pinnedSessions !== undefined) patch.pinnedSessions = p.pinnedSessions;
    if (p.projects !== undefined) patch.projects = (p.projects ?? []).map(String);
    if (p.excluded !== undefined) patch.excluded = (p.excluded ?? []).map(String);
    if (p.dark !== undefined) patch.dark = p.dark === true;
    if (p.closeAction !== undefined) patch.closeAction = p.closeAction;
    if (p.defaultInteraction !== undefined) {
      patch.defaultInteraction = p.defaultInteraction === "terminal" ? "terminal" : "chat";
    }
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
  handle("claude_update_status", () => claudeUpdateStatus());
  handle("claude_run_upgrade", () => claudeRunUpgrade());
  handle("check_projects", (p) =>
    checkLaunchers(Array.isArray(p.paths) ? p.paths.map(String) : []));

  // ---------- 批量添加 ----------
  handle("scan_claude_projects", () => scanClaudeProjects(projectsDir()));
  handle("get_claude_projects_dir", () => projectsDir());
  handle("purge_claude_project_data", async (p) => {
    const paths = Array.isArray(p.paths) ? p.paths.map(String) : [];
    const removed = purgeClaudeProjectData(paths, projectsDir());
    // 项目数据没了，其置顶会话条目必须一并撤掉（否则置顶区留下孤儿条目）
    await mutateConfig(rootDir(), (cfg) => dropPinsForProjects(cfg, paths));
    return removed;
  });

  // ---------- 会话管理 ----------
  handle("list_sessions", (p) => listSessions(projectsDir(), String(p.projectPath)));
  handle("list_pinned_sessions", () =>
    listPinnedSessions(projectsDir(), loadConfig(rootDir()).pinnedSessions));
  handle("rename_session", (p) => renameSession(String(p.file), String(p.newTitle), projectsDir()));
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
  handle("purge_session", async (p) => {
    purgeSessionBackup(String(p.file), rootDir());
    // 彻底删除后清掉会话文件已不存在的置顶条目（进回收站的删除不清，等恢复）
    await mutateConfig(rootDir(), (cfg) => pruneDeadPins(cfg));
  });
  handle("purge_trash", async () => {
    const n = purgeTrashIn(trashRootDir());
    await mutateConfig(rootDir(), (cfg) => pruneDeadPins(cfg));
    return n;
  });
  handle("get_session_messages", (p) =>
    getSessionMessages(String(p.file), projectsDir(), toInt(p.offset)));
  handle("search_session_messages", (p) =>
    searchSessionMessages(String(p.file), String(p.keyword), projectsDir()));
  handle("get_session_user_prompts", (p) => getSessionUserPrompts(String(p.file), projectsDir()));
  handle("export_session", (p) =>
    exportSession(String(p.file), String(p.destPath), String(p.format), projectsDir()));
  handle("resume_session", (p) =>
    resumeSession(String(p.file), String(p.projectPath), projectsDir()));

  // ---------- app 内对话（官方 Agent SDK 托管） ----------
  handle("chat_default_permission_mode", (p) => defaultPermissionMode(String(p.projectPath)));
  handle("chat_start", (p) => {
    const sessionFile = p.sessionFile ? String(p.sessionFile) : null;
    // 续聊用 jsonl 文件名（去掉扩展名）当 CLI 会话 id；新对话自己生成一个 uuid
    const resumeId = sessionFile ? path.basename(sessionFile).replace(/\.jsonl$/i, "") : undefined;
    const sessionId = resumeId ?? crypto.randomUUID();
    chatTokens.set(sessionId, String(p.token));
    chatManager.start(sessionId, {
      projectPath: String(p.projectPath),
      resumeId,
      // null = 跟随 settings.json 的 defaultMode（不传 --permission-mode）
      initialMode: p.permissionMode ?? undefined,
    });
    return sessionId;
  });
  handle("chat_send", (p) =>
    chatManager.send(String(p.sessionId), String(p.text ?? ""), p.images ?? []));
  handle("chat_interrupt", (p) => chatManager.interrupt(String(p.sessionId)));
  handle("chat_set_permission_mode", (p) =>
    chatManager.setPermissionMode(String(p.sessionId), p.mode));
  handle("chat_permission_response", (p) =>
    chatManager.respondToPermission(
      String(p.sessionId),
      String(p.requestId),
      p.allow
        ? { kind: "allow", answers: p.answers, response: p.response }
        : { kind: "deny", message: p.denyMessage ?? "用户拒绝了该操作" },
    ));
  handle("chat_close", (p) => {
    const sid = String(p.sessionId);
    chatTokens.delete(sid);
    // 返回 promise：前端「关闭 tab」要么等它落定、要么 fire-and-forget，
    // 但主进程侧必须等子进程收尾（最多 3s）再算关完
    return chatManager.close(sid);
  });

  // ---------- 内嵌终端（node-pty，对齐 Tauri 线 pty_* 命令） ----------
  handle("pty_spawn_claude", (p) => {
    const token = String(p.token);
    const send = (channel: string, payload: unknown) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(channel, payload);
    };
    // 输出/退出经 token 定向推送：渲染层在 invoke 之前就已订阅
    // `pty:data:<token>` / `pty:exit:<token>`，早于应答的事件零丢失
    return ptyManager.spawnClaude(
      {
        cwd: String(p.cwd),
        resumeSessionId: p.resumeSessionId ?? null,
        newSessionId: p.newSessionId ?? null,
        cols: toInt(p.cols) ?? 80,
        rows: toInt(p.rows) ?? 24,
        token,
      },
      {
        onData: (chunk) => send(`pty:data:${token}`, chunk),
        // exit 只带 code：token 与这次 spawn 一一对应，渲染层不需要再对 id
        onExit: (code) => send(`pty:exit:${token}`, code),
      },
    );
  });
  handle("pty_write", (p) => ptyManager.write(toInt(p.id) ?? 0, String(p.data ?? "")));
  handle("pty_resize", (p) =>
    ptyManager.resize(toInt(p.id) ?? 0, toInt(p.cols) ?? 0, toInt(p.rows) ?? 0));
  handle("pty_kill", (p) => ptyManager.kill(toInt(p.id) ?? 0));
  handle("session_title_for", (p) =>
    sessionTitleFor(projectsDir(), String(p.projectPath), String(p.sessionId)));
  handle("chat_session_meta", (p) =>
    sessionFileAndTitle(projectsDir(), String(p.projectPath), String(p.sessionId)));
  handle("clipboard_image_path", () => clipboardImagePath());

  // ---------- 供应商切换 ----------
  handle("provider_list", () => providerListFrom(claudeConfigDir(), rootDir()));
  handle("provider_save", (p) =>
    providerSaveFrom(claudeConfigDir(), rootDir(), p.provider as never));
  handle("provider_delete", (p) => providerDeleteFrom(claudeConfigDir(), rootDir(), String(p.id)));
  handle("provider_reorder", (p) =>
    providerReorderFrom(claudeConfigDir(), rootDir(), Array.isArray(p.ids) ? p.ids.map(String) : []));
  handle("provider_switch", (p) => providerSwitchFrom(claudeConfigDir(), rootDir(), String(p.id)));
  handle("provider_import_ccswitch", (p) =>
    providerImportCcswitchFrom(rootDir(), String(p.filePath)));
  handle("provider_read_live", () => providerReadLiveFrom(claudeConfigDir()));
  handle("fetch_models_for_config", (p) => fetchModels(String(p.baseUrl), String(p.apiKey)));
  handle("provider_query_usage", (p) => providerQueryUsageFrom(rootDir(), String(p.id)));
  handle("open_url", (p) => openUrl(String(p.url)));

  // ---------- 使用统计 ----------
  handle("get_usage_stats", (p) =>
    getUsageStats({
      tzOffsetMinutes: toInt(p.tzOffsetMinutes) ?? 0,
      projectsDir: projectsDir(),
      dataRoot: rootDir(),
    }));

  // ---------- 其他 ----------
  handle("get_data_root", () => {
    const info = rootInfo();
    return { path: info.root, installMode: info.installMode };
  });
  handle("quit_app", () => quitApp());

  // ---------- 开机自启动（Windows 注册表 Run 项 / macOS 登录项，官方 API） ----------
  // v2.0.0 是 `cfg!(any(windows, macos, linux))`；本 app 只发布 win/mac，这里刻意
  // 不含 linux（Linux 上 setLoginItemSettings 的可用性依桌面环境而异，宁可不显示该项）。
  // 硬编码 `() => true` 会让「不支持」的分支永远走不到，不是同一个意思。
  handle("autostart_supported", () => process.platform === "win32" || process.platform === "darwin");
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
      title: typeof p.title === "string" && p.title !== "" ? p.title : "选择文件夹",
      properties: ["openDirectory", "dontAddToRecent"],
      buttonLabel: "选择此文件夹",
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle("pick_file", async (p) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: typeof p.title === "string" && p.title !== "" ? p.title : "选择文件",
      properties: ["openFile", "dontAddToRecent"],
      filters: toDialogFilters(p.filters),
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle("save_file", async (p) => {
    if (!mainWindow) return null;
    const r = await dialog.showSaveDialog(mainWindow, {
      title: typeof p.title === "string" && p.title !== "" ? p.title : "另存为",
      defaultPath: typeof p.defaultPath === "string" ? p.defaultPath : undefined,
      filters: toDialogFilters(p.filters),
    });
    return r.canceled || !r.filePath ? null : r.filePath;
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

// ---------------- 文字渲染 ----------------

// 关掉次像素抗锯齿（ClearType），走灰度抗锯齿。
// 依据（2026-09-22 实测）：用户认可的参考实现，其文字墨迹里带彩色描边的只有 2.8%（灰度渲染），
// 而本 app 默认是 82%（次像素）—— 中文在 150% 缩放 + 次像素下笔画带彩边，观感「发花」。
// 关掉后实测彩色描边降到 0%，代价是墨迹轻约 2.4%（灰度渲染的固有代价）。
// ⚠️ 这是观感取舍，只有人眼能定：觉得更糊就删掉这一行，别当冗余代码。
app.commandLine.appendSwitch("disable-lcd-text");

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

  app.on("before-quit", (e) => {
    quitting = true;
    // 退出前优雅关掉全部对话子进程（关 stdin，最多等 3s 让 CLI 把 jsonl 收尾）。
    // before-quit 是同步事件：先 preventDefault 挡住这次退出，关完再 app.quit()——
    // 否则 Electron 会在子进程还没收尾时就把它们带走。第二轮进来（chatExitDone）放行。
    if (chatExitDone) return;
    e.preventDefault();
    void chatManager.closeAll().finally(() => {
      // 终端会话也一并清场（树杀是异步的 taskkill；不等它落定也行——进程亡即树亡，
      // 但先发起再放行退出，给系统留出回收窗口，与 quit_app 同一条路）
      shutdownPtySessions();
      chatExitDone = true;
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    // 关闭行为由前端拦截决定，走到这里即窗口真正销毁——退出
    app.quit();
  });
}
