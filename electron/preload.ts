// preload：contextBridge 暴露受控 API（渲染进程无 Node 权限，全部经 IPC 白名单通道）。
// invoke 调用受 electron/ipc-contract.ts 的 payload 类型约束，防止通道/参数错位。
import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannel, IpcContract } from "./ipc-contract";

function invoke<K extends IpcChannel>(channel: K, payload: IpcContract[K]): Promise<unknown> {
  return ipcRenderer.invoke(channel, payload);
}

const api = {
  // ---------- 项目清单 ----------
  listProjects: () => invoke("list_projects", undefined),
  loadConfig: () => invoke("load_config", undefined),
  /** 保存配置：只传要改的字段（主进程读改写，未传的键保持磁盘原值） */
  saveConfig: (patch: IpcContract["save_config"]) => invoke("save_config", patch),
  addProject: (path: string) => invoke("add_project", { path }),
  removeProject: (path: string) => invoke("remove_project", { path }),
  launchProject: (path: string) => invoke("launch_project", { path }),
  openFolder: (path: string) => invoke("open_folder", { path }),
  checkClaude: () => invoke("check_claude", undefined),
  checkProjects: (paths: string[]) => invoke("check_projects", { paths }),
  // ---------- 批量添加 ----------
  scanClaudeProjects: () => invoke("scan_claude_projects", undefined),
  getClaudeProjectsDir: () => invoke("get_claude_projects_dir", undefined),
  // ---------- 会话管理 ----------
  listSessions: (projectPath: string) => invoke("list_sessions", { projectPath }),
  renameSession: (file: string, newTitle: string) =>
    invoke("rename_session", { file, newTitle }),
  /** 删除会话 = 移入回收站，返回备份路径 */
  deleteSession: (file: string) => invoke("delete_session", { file }),
  listTrashedSessions: () => invoke("list_trashed_sessions", undefined),
  restoreSession: (file: string) => invoke("restore_session", { file }),
  purgeSession: (file: string) => invoke("purge_session", { file }),
  /** 清空回收站（彻底删除全部备份、释放磁盘，不可恢复），返回清空的会话数 */
  purgeTrash: () => invoke("purge_trash", undefined),
  /** 读取会话内容（向上分页：offset 省略时返回最后 limit 条） */
  getSessionMessages: (file: string, offset?: number) =>
    invoke("get_session_messages", { file, offset }),
  /** 新开终端窗口 resume 会话继续对话 */
  resumeSession: (file: string, projectPath: string) =>
    invoke("resume_session", { file, projectPath }),
  getDataRoot: () =>
    invoke("get_data_root", undefined) as Promise<{ path: string; installMode: boolean }>,
  quitApp: () => invoke("quit_app", undefined),
  // ---------- 开机自启动 ----------
  /** 当前平台是否支持开机自启动（如不支持则设置项不显示） */
  isAutostartSupported: () => invoke("autostart_supported", undefined),
  /** 当前是否已开启开机自启动 */
  autostartEnabled: () => invoke("autostart_enabled", undefined),
  /** 开启开机自启动 */
  autostartTurnOn: () => invoke("autostart_turn_on", undefined),
  /** 关闭开机自启动 */
  autostartTurnOff: () => invoke("autostart_turn_off", undefined),
  // ---------- 窗口控制（替代 @tauri-apps/api/window） ----------
  /** 选择项目文件夹（替代 @tauri-apps/plugin-dialog 的 open），取消返回 null */
  pickFolder: (title: string) =>
    invoke("pick_folder", { title }) as Promise<string | null>,
  /** 隐藏窗口（最小化到托盘） */
  hideWindow: () => invoke("window_hide", undefined),
  /** 强制销毁窗口（close_action = quit 时绕过关闭拦截） */
  destroyWindow: () => invoke("window_destroy", undefined),
  /** 订阅窗口关闭请求（主进程拦截 close 后转发）；返回取消订阅函数 */
  onCloseRequested: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("window:close-requested", handler);
    return () => {
      ipcRenderer.removeListener("window:close-requested", handler);
    };
  },
};

export type ClaudeFastApi = typeof api;

contextBridge.exposeInMainWorld("claudeFast", api);
