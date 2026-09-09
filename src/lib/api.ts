import { invoke } from "@tauri-apps/api/core";
import {
  isEnabled as autostartIsEnabled,
  enable as autostartEnable,
  disable as autostartDisable,
} from "@tauri-apps/plugin-autostart";
import type {
  ClaudeProject,
  ClaudeUpdateStatus,
  FetchedModel,
  ProviderImportOutcome,
  ProviderInfo,
  ProviderListState,
  ProviderSwitchOutcome,
  UsageResult,
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
  /** Claude Code 更新检查：本地版本 vs npm registry 最新稳定版 */
  claudeUpdateStatus: () => invoke<ClaudeUpdateStatus>("claude_update_status"),
  /** Claude Code 一键升级：claude update 失败兜底 npm 全局安装，返回输出尾部 */
  claudeRunUpgrade: () => invoke<string>("claude_run_upgrade"),
  checkProjects: (paths: string[]) => invoke<boolean[]>("check_projects", { paths }),
  // ---------- 批量添加 ----------
  scanClaudeProjects: () => invoke<ClaudeProject[]>("scan_claude_projects"),
  getClaudeProjectsDir: () => invoke<string>("get_claude_projects_dir"),

  // ---------- 供应商切换 ----------
  /** 供应商清单（首次调用自动把 live 配置收编为 default 供应商） */
  providerList: () => invoke<ProviderListState>("provider_list"),
  /** 新增/更新供应商（id 为空 = 新增） */
  providerSave: (provider: ProviderInfo) =>
    invoke<ProviderListState>("provider_save", { provider }),
  /** 删除供应商（禁止删除当前启用的） */
  providerDelete: (id: string) =>
    invoke<ProviderListState>("provider_delete", { id }),
  /** 拖拽排序持久化：按 ids 顺序重排清单 */
  providerReorder: (ids: string[]) =>
    invoke<ProviderListState>("provider_reorder", { ids }),
  /** 切换供应商：回填离任 → 记 current → 整文件原子替换 settings.json */
  providerSwitch: (id: string) =>
    invoke<ProviderSwitchOutcome>("provider_switch", { id }),
  /** 从 CC Switch「导出配置」的 SQL 备份导入 Claude 供应商 */
  providerImportCcswitch: (filePath: string) =>
    invoke<ProviderImportOutcome>("provider_import_ccswitch", { filePath }),
  /** 读取当前 live 配置（~/.claude/settings.json），供表单导入 */
  providerReadLive: () =>
    invoke<Record<string, unknown> | null>("provider_read_live"),
  /** 拉取供应商可用模型列表（OpenAI 兼容 /v1/models，候选地址逐个探测） */
  fetchModels: (baseUrl: string, apiKey: string) =>
    invoke<FetchedModel[]>("fetch_models_for_config", { baseUrl, apiKey }),
  /** 查询供应商 Coding Plan 用量（非已知厂商返回 supported=false） */
  providerQueryUsage: (id: string) =>
    invoke<UsageResult>("provider_query_usage", { id }),
  /** 用系统默认浏览器打开外部链接（官网 / 获取 API Key） */
  openUrl: (url: string) => invoke("open_url", { url }),
  /** 清除失效项目的 Claude Code 会话数据（~/.claude/projects 数据目录，不可恢复），返回删除数 */
  purgeClaudeProjectData: (paths: string[]) =>
    invoke<number>("purge_claude_project_data", { paths }),
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
