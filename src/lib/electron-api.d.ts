// preload（electron/preload.ts）通过 contextBridge 暴露的 API 类型声明。
// 渲染进程经 window.claudeFast 调用后端，无任何 Node/远程能力。
import type {
  ClaudeProject,
  Config,
  ConfigPatch,
  Project,
  SessionInfo,
  SessionMessages,
  TrashedSession,
} from "../types";

export interface ClaudeFastApi {
  // ---------- 项目清单（去脚本化） ----------
  listProjects: () => Promise<Project[]>;
  loadConfig: () => Promise<Config>;
  /** 保存配置：只传要改的字段（主进程读改写，未传的键保持磁盘原值） */
  saveConfig: (patch: ConfigPatch) => Promise<void>;
  addProject: (path: string) => Promise<void>;
  removeProject: (path: string) => Promise<void>;
  launchProject: (path: string) => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  checkClaude: () => Promise<boolean>;
  checkProjects: (paths: string[]) => Promise<boolean[]>;
  // ---------- 批量添加 ----------
  scanClaudeProjects: () => Promise<ClaudeProject[]>;
  getClaudeProjectsDir: () => Promise<string>;
  // ---------- 会话管理 ----------
  listSessions: (projectPath: string) => Promise<SessionInfo[]>;
  renameSession: (file: string, newTitle: string) => Promise<void>;
  /** 删除会话 = 移入回收站，返回备份路径 */
  deleteSession: (file: string) => Promise<string>;
  listTrashedSessions: () => Promise<TrashedSession[]>;
  restoreSession: (file: string) => Promise<string>;
  purgeSession: (file: string) => Promise<void>;
  /** 清空回收站（彻底删除全部备份、释放磁盘，不可恢复），返回清空的会话数 */
  purgeTrash: () => Promise<number>;
  /** 读取会话内容（向上分页：offset 省略时返回最后 limit 条） */
  getSessionMessages: (file: string, offset?: number) => Promise<SessionMessages>;
  /** 新开终端窗口 resume 会话继续对话 */
  resumeSession: (file: string, projectPath: string) => Promise<void>;
  getDataRoot: () => Promise<{ path: string; installMode: boolean }>;
  quitApp: () => Promise<void>;
  // ---------- 开机自启动 ----------
  isAutostartSupported: () => Promise<boolean>;
  autostartEnabled: () => Promise<boolean>;
  autostartTurnOn: () => Promise<void>;
  autostartTurnOff: () => Promise<void>;
  // ---------- 窗口控制 ----------
  /** 选择项目文件夹（系统目录选择对话框），取消返回 null */
  pickFolder: (title: string) => Promise<string | null>;
  /** 隐藏窗口（最小化到托盘） */
  hideWindow: () => Promise<void>;
  /** 强制销毁窗口（close_action = quit 时绕过关闭拦截） */
  destroyWindow: () => Promise<void>;
  /** 订阅窗口关闭请求（主进程拦截 close 后转发）；返回取消订阅函数 */
  onCloseRequested: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    claudeFast: ClaudeFastApi;
  }
}

export {};
