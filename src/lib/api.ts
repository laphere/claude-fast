import { invoke } from "@tauri-apps/api/core";
import {
  isEnabled as autostartIsEnabled,
  enable as autostartEnable,
  disable as autostartDisable,
} from "@tauri-apps/plugin-autostart";
import type {
  ClaudeProject,
  Config,
  Project,
  SessionInfo,
  SessionMessages,
  SessionSearchHit,
  SessionUserPrompt,
  TrashedSession,
  UsageStats,
} from "../types";

/** Tauri 后端命令封装（去脚本化：项目清单为路径模型） */
export const api = {
  // ---------- 项目清单 ----------
  listProjects: () => invoke<Project[]>("list_projects"),
  loadConfig: () => invoke<Config>("load_config"),
  saveConfig: (
    favorites: string[],
    projects: string[],
    excluded: string[],
    dark: boolean,
    closeAction?: string | null,
  ) =>
    invoke("save_config", {
      favorites,
      projects,
      excluded,
      dark,
      closeAction,
    }),
  addProject: (path: string) => invoke("add_project", { path }),
  removeProject: (path: string) => invoke("remove_project", { path }),
  launchProject: (path: string) => invoke("launch_project", { path }),
  openFolder: (path: string) => invoke("open_folder", { path }),
  checkClaude: () => invoke<boolean>("check_claude"),
  checkProjects: (paths: string[]) => invoke<boolean[]>("check_projects", { paths }),
  // ---------- 批量添加 ----------
  scanClaudeProjects: () => invoke<ClaudeProject[]>("scan_claude_projects"),
  getClaudeProjectsDir: () => invoke<string>("get_claude_projects_dir"),
  // ---------- 会话管理 ----------
  listSessions: (projectPath: string) =>
    invoke<SessionInfo[]>("list_sessions", { projectPath }),
  renameSession: (file: string, newTitle: string) =>
    invoke("rename_session", { file, newTitle }),
  /** 删除会话 = 移入回收站，返回备份路径 */
  deleteSession: (file: string) => invoke<string>("delete_session", { file }),
  listTrashedSessions: () => invoke<TrashedSession[]>("list_trashed_sessions"),
  restoreSession: (file: string) => invoke<string>("restore_session", { file }),
  purgeSession: (file: string) => invoke("purge_session", { file }),
  /** 清空回收站（彻底删除全部备份、释放磁盘，不可恢复），返回清空的会话数 */
  purgeTrash: () => invoke<number>("purge_trash"),
  /** 读取会话内容（向上分页：offset 省略时返回最后 limit 条） */
  getSessionMessages: (file: string, offset?: number) =>
    invoke<SessionMessages>("get_session_messages", { file, offset }),
  /** 会话内全文搜索（返回命中消息序号与上下文片段） */
  searchSessionMessages: (file: string, keyword: string) =>
    invoke<SessionSearchHit[]>("search_session_messages", { file, keyword }),
  /** 会话全量用户发言（对话进度条导航轨） */
  getSessionUserPrompts: (file: string) =>
    invoke<SessionUserPrompt[]>("get_session_user_prompts", { file }),
  /** 导出会话到指定路径（markdown / jsonl），返回写入的字节数 */
  exportSession: (file: string, destPath: string, format: "markdown" | "jsonl") =>
    invoke<number>("export_session", { file, destPath, format }),
  /** 全局使用统计（仪表盘；后端按用量台账持久累计，已删除会话的历史用量仍计入；
   *  现存文件仅 mtime+size 变更时重扫）。单日统计按本地时区归属：
   *  getTimezoneOffset 返回 UTC-本地（东八区为 -480），取负得东偏分钟数 */
  getUsageStats: () =>
    invoke<UsageStats>("get_usage_stats", {
      tzOffsetMinutes: -new Date().getTimezoneOffset(),
    }),
  /** 新开终端窗口 resume 会话继续对话 */
  resumeSession: (file: string, projectPath: string) =>
    invoke("resume_session", { file, projectPath }),
  getDataRoot: () =>
    invoke<{ path: string; installMode: boolean }>("get_data_root"),
  quitApp: () => invoke("quit_app"),
  // ---------- 开机自启动 ----------
  /** 当前平台是否支持开机自启动（如不支持则设置项不显示） */
  isAutostartSupported: () => invoke<boolean>("autostart_supported"),
  /** 当前是否已开启开机自启动 */
  autostartEnabled: () => autostartIsEnabled(),
  /** 开启开机自启动 */
  autostartTurnOn: () => autostartEnable(),
  /** 关闭开机自启动 */
  autostartTurnOff: () => autostartDisable(),
};
