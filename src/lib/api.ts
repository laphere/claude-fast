// 后端命令封装（Electron 主进程 IPC）。
//
// 设计：函数面与 `v2.0.0`（Tauri 版）的 `src/lib/api.ts` **逐签名一致**，
// 这样从 v2.0.0 搬过来的 UI 组件不需要改造；差异只在最底层传输——
// Tauri 是 `invoke(cmd, args)` + `Channel`，这里是 `window.claudeFast.invoke(channel, payload)`
// + `chat:event:<token>` 单向推送。
//
// 通道名与 payload 的**编译期约束在 preload**（`electron/ipc-contract.ts` 的 IpcContract），
// 这里的 `invoke<T>` 只负责把结果类型标出来。
import type { IpcChannel } from "../../electron/ipc-contract";
import { Channel } from "./channel";
import type {
  ChatEvent,
  ChatImage,
  ChatPermissionMode,
  ClaudeProject,
  ClaudeUpdateStatus,
  Config,
  FetchedModel,
  PinnedSession,
  PinnedSessionInfo,
  ProviderImportOutcome,
  ProviderInfo,
  ProviderListState,
  ProviderSwitchOutcome,
  SessionInfo,
  SessionMessages,
  SessionSearchHit,
  SessionUserPrompt,
  TrashedSession,
  UsageResult,
  UsageStats,
} from "../types";

const bridge = window.claudeFast;

function invoke<T>(channel: IpcChannel, payload?: unknown): Promise<T> {
  return bridge.invoke(channel as never, payload as never) as Promise<T>;
}

/** 对话事件推送用的 token 序号：保证同窗口多 tab 的事件不乱串 */
let chatTokenSeq = 0;

/** 会话 id → 事件订阅的退订函数（chatClose 时调用，避免监听随 tab 关闭而泄漏） */
const chatUnsubs = new Map<string, () => void>();

/** 系统对话框的过滤器（对应 Tauri plugin-dialog 的 `{ name, extensions }`） */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** Tauri 后端命令封装（项目清单为路径模型） */
export const api = {
  // ---------- 项目清单 ----------
  /** 项目清单：后端扫描时顺带判定的 missing 直接映射为 healthy，启动时不重复检查 */
  listProjects: () =>
    invoke<{ key: string; name: string; path: string; missing: boolean }[]>("list_projects").then(
      (list) => list.map(({ key, name, path, missing }) => ({ key, name, path, healthy: !missing })),
    ),
  loadConfig: () => invoke<Config>("load_config"),
  saveConfig: (
    order: string[],
    pinnedSessions: PinnedSession[],
    projects: string[],
    excluded: string[],
    dark: boolean,
    closeAction?: string | null,
    defaultInteraction?: "chat" | "terminal",
  ) =>
    invoke("save_config", {
      order,
      pinnedSessions,
      projects,
      excluded,
      dark,
      closeAction,
      defaultInteraction,
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
  /** 手动健康检查弹窗复查用（打开时现场重查所有目录） */
  checkProjects: (paths: string[]) => invoke<boolean[]>("check_projects", { paths }),
  // ---------- 批量添加 ----------
  scanClaudeProjects: () => invoke<ClaudeProject[]>("scan_claude_projects"),
  getClaudeProjectsDir: () => invoke<string>("get_claude_projects_dir"),
  /** 清除失效项目的 Claude Code 会话数据（~/.claude/projects 数据目录，不可恢复），返回删除数 */
  purgeClaudeProjectData: (paths: string[]) =>
    invoke<number>("purge_claude_project_data", { paths }),
  // ---------- 会话管理 ----------
  listSessions: (projectPath: string) => invoke<SessionInfo[]>("list_sessions", { projectPath }),
  /** 置顶会话清单（跨项目聚合；后端按 config 顺序实时解析元数据，失效文件自动跳过） */
  listPinnedSessions: () => invoke<PinnedSessionInfo[]>("list_pinned_sessions"),
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
  getDataRoot: () => invoke<{ path: string; installMode: boolean }>("get_data_root"),
  quitApp: () => invoke("quit_app"),
  /** 解析会话默认权限模式（permissions.defaultMode：项目 local > 项目 > 用户级），
   *  未配置返回 null（CLI 自身默认） */
  chatDefaultPermissionMode: (projectPath: string) =>
    invoke<string | null>("chat_default_permission_mode", { projectPath }),
  /** 启动对话进程（sessionFile 为 null = 新对话；permissionMode 为 null =
   *  跟随 settings.json 的 defaultMode，不传 --permission-mode），
   *  返回跟踪用的会话 id；事件经 Channel 流式推送（必须先挂 onmessage 再调用） */
  chatStart: async (
    projectPath: string,
    sessionFile: string | null,
    permissionMode: ChatPermissionMode | null,
    onEvent: Channel<ChatEvent>,
  ): Promise<string> => {
    const token = `c${++chatTokenSeq}-${Date.now()}`;
    const off = bridge.onChatEvent(token, (event) => onEvent.onmessage?.(event as ChatEvent));
    try {
      const sessionId = await invoke<string>("chat_start", {
        projectPath,
        sessionFile,
        permissionMode,
        token,
      });
      // 记下退订函数：chatClose 时摘掉监听。不摘的话每开过一个对话 tab 就永久
      // 留一个 ipcRenderer 监听（token 每次唯一，功能上无影响，纯泄漏）。
      chatUnsubs.get(sessionId)?.();
      chatUnsubs.set(sessionId, off);
      return sessionId;
    } catch (e) {
      // 启动失败要立刻退订，否则这个 token 的监听会一直挂着
      off();
      throw e;
    }
  },
  /** 发一条消息：text 为 "" 且带图片 = 纯图消息 */
  /** 返回 false = 启动期间用户已按停止，这条消息被后端撤回（调用方要撤掉乐观气泡） */
  chatSend: (sessionId: string, text: string, images: ChatImage[] = []) =>
    invoke<boolean>("chat_send", { sessionId, text, images }),
  /** 预热会话进程（点「继续对话」时调）：把 CLI 先起好，resume 也在这一刻发生。
   *  失败不用处理——预热不是用户操作，报错留给发送路径 */
  chatPrewarm: (sessionId: string) => invoke<void>("chat_prewarm", { sessionId }),
  /** 中断当前轮（等价终端里的 Esc） */
  chatInterrupt: (sessionId: string) => invoke("chat_interrupt", { sessionId }),
  /** 运行中切换权限模式（等价终端 Shift+Tab；CLI 回执失败会以 error 事件浮出） */
  chatSetPermissionMode: (sessionId: string, mode: ChatPermissionMode) =>
    invoke("chat_set_permission_mode", { sessionId, mode }),
  /** 权限 / 方案审批 / 提问的应答；denyMessage 仅拒绝时生效。
   *  ⚠️ 提问（AskUserQuestion）必须经 `answers` 回传（key = 题目完整文本），
   *  只回 allow 不带 answers 等于「用户没选」——不报错但静默失效 */
  chatPermissionResponse: (
    sessionId: string,
    requestId: string,
    allow: boolean,
    denyMessage?: string,
    answers?: Record<string, string>,
    response?: string,
  ) =>
    invoke("chat_permission_response", {
      sessionId,
      requestId,
      allow,
      denyMessage,
      answers,
      response,
    }),
  /** 关闭对话进程（关 stdin 优雅退出，超时强杀） */
  chatClose: (sessionId: string) => {
    // 先退订再关进程：进程退出事件不需要再送到已经要销毁的 tab
    chatUnsubs.get(sessionId)?.();
    chatUnsubs.delete(sessionId);
    return invoke("chat_close", { sessionId });
  },
  // ---------- 内嵌终端（node-pty） ----------
  /** 启动 claude 终端会话（先订阅 onPtyData/onPtyExit 再调用——订阅必须先行，
   *  主进程早于应答就会推首字节）。返回后端会话表的数字键 */
  ptySpawnClaude: (
    cwd: string,
    resumeSessionId: string | null,
    newSessionId: string | null,
    cols: number,
    rows: number,
    token: string,
  ) =>
    invoke<{ id: number; pid: number }>("pty_spawn_claude", {
      cwd,
      resumeSessionId,
      newSessionId,
      cols,
      rows,
      token,
    }),
  /** 键盘输入写入 PTY（xterm.js onData 原文） */
  ptyWrite: (id: number, data: string) => invoke("pty_write", { id, data }),
  /** 终端尺寸变更 */
  ptyResize: (id: number, cols: number, rows: number) =>
    invoke("pty_resize", { id, cols, rows }),
  /** 结束终端会话（taskkill /T /F 杀树；返回 = 树已杀完） */
  ptyKill: (id: number) => invoke("pty_kill", { id }),
  /** 按会话 id 读会话标题（终端 tab 的会话名兜底）；文件未落盘返回 null */
  sessionTitleFor: (projectPath: string, sessionId: string) =>
    invoke<string | null>("session_title_for", { projectPath, sessionId }),
  /** app 内新对话的落盘探测：返回会话 jsonl 路径 + 当前标题；文件未落盘/无实质
   *  内容返回 null。首轮结束后轮询，拿到即把新对话 tab 升级成续聊态
   *  （头部统计/右上角按钮随之可用，tab 标题同步、左栏会话列表补条目） */
  chatSessionMeta: (projectPath: string, sessionId: string) =>
    invoke<{ file: string; title: string } | null>("chat_session_meta", {
      projectPath,
      sessionId,
    }),
  /** 剪贴板里若放着**图片文件**（资源管理器「复制」），返回其路径；否则 null */
  clipboardImagePath: () => invoke<string | null>("clipboard_image_path"),
  /** 订阅某个终端 token 的输出字节流；返回取消订阅函数 */
  onPtyData: (token: string, cb: (chunk: Uint8Array) => void) =>
    bridge.onPtyData(token, cb),
  /** 订阅某个终端 token 的退出事件；返回取消订阅函数 */
  onPtyExit: (token: string, cb: (code: number | null) => void) =>
    bridge.onPtyExit(token, cb),
  // ---------- 供应商切换 ----------
  /** 供应商清单（首次调用自动把 live 配置收编为 default 供应商） */
  providerList: () => invoke<ProviderListState>("provider_list"),
  /** 新增/更新供应商（id 为空 = 新增） */
  providerSave: (provider: ProviderInfo) =>
    invoke<ProviderListState>("provider_save", { provider }),
  /** 删除供应商（禁止删除当前启用的） */
  providerDelete: (id: string) => invoke<ProviderListState>("provider_delete", { id }),
  /** 拖拽排序持久化：按 ids 顺序重排清单 */
  providerReorder: (ids: string[]) => invoke<ProviderListState>("provider_reorder", { ids }),
  /** 切换供应商：回填离任 → 记 current → 整文件原子替换 settings.json */
  providerSwitch: (id: string) => invoke<ProviderSwitchOutcome>("provider_switch", { id }),
  /** 从 CC Switch「导出配置」的 SQL 备份导入 Claude 供应商 */
  providerImportCcswitch: (filePath: string) =>
    invoke<ProviderImportOutcome>("provider_import_ccswitch", { filePath }),
  /** 读取当前 live 配置（~/.claude/settings.json），供表单导入 */
  providerReadLive: () => invoke<Record<string, unknown> | null>("provider_read_live"),
  /** 拉取供应商可用模型列表（OpenAI 兼容 /v1/models，候选地址逐个探测） */
  fetchModels: (baseUrl: string, apiKey: string) =>
    invoke<FetchedModel[]>("fetch_models_for_config", { baseUrl, apiKey }),
  /** 查询供应商 Coding Plan 用量（非已知厂商返回 supported=false） */
  providerQueryUsage: (id: string) => invoke<UsageResult>("provider_query_usage", { id }),
  /** 用系统默认浏览器打开外部链接（官网 / 获取 API Key） */
  openUrl: (url: string) => invoke("open_url", { url }),
  // ---------- 系统对话框（替代 @tauri-apps/plugin-dialog） ----------
  /** 选择文件夹，取消返回 null */
  pickFolder: (title: string) => invoke<string | null>("pick_folder", { title }),
  /** 选择文件（如 CC Switch 的 SQL 备份），取消返回 null */
  pickFile: (title: string, filters: DialogFilter[] = []) =>
    invoke<string | null>("pick_file", { title, filters }),
  /** 另存为对话框，取消返回 null */
  saveFileDialog: (title: string, defaultPath: string, filters: DialogFilter[] = []) =>
    invoke<string | null>("save_file", { title, defaultPath, filters }),
  // ---------- 开机自启动 ----------
  /** 当前平台是否支持开机自启动（如不支持则设置项不显示） */
  isAutostartSupported: () => invoke<boolean>("autostart_supported"),
  /** 当前是否已开启开机自启动 */
  autostartEnabled: () => invoke<boolean>("autostart_enabled"),
  /** 开启开机自启动 */
  autostartTurnOn: () => invoke("autostart_turn_on"),
  /** 关闭开机自启动 */
  autostartTurnOff: () => invoke("autostart_turn_off"),
  // ---------- 窗口控制 ----------
  /** 隐藏窗口（最小化到托盘） */
  hideWindow: () => invoke("window_hide"),
  /** 强制销毁窗口（close_action = quit 时绕过关闭拦截） */
  destroyWindow: () => invoke("window_destroy"),
  /** 订阅窗口关闭请求（主进程拦截 close 后转发）；返回取消订阅函数 */
  onCloseRequested: (cb: () => void) => bridge.onCloseRequested(cb),
  /** 订阅窗口获得焦点（替代 Tauri 的 onFocusChanged）；返回取消订阅函数 */
  onFocusChanged: (cb: () => void) => bridge.onWindowFocused(cb),
};
