// IPC 通道契约：preload 与 main 共用的 payload 类型表。
// 每个通道的 payload 是**单个对象**（ipcRenderer.invoke(channel, payload)），
// 主进程 handler 收到的第一个参数是 IpcMainInvokeEvent，经 handle() 包装剥离后
// 才是这里的 payload——两侧签名由本表在编译期对齐，防止参数错位。
//
// 通道集合同时是**渲染进程的能力白名单**：preload 只放行本表里的键
// （`IPC_CHANNELS`），不在表里的一律拒绝。

import type { ChatImage, ChatPermissionMode } from "./backend/chat";

/** 置顶会话条目（与 config.json 里的形状一致） */
export interface PinnedSessionPayload {
  file: string;
  projectPath: string;
}

export interface IpcContract {
  // ---------- 项目清单（路径模型，去脚本化） ----------
  list_projects: void;
  load_config: void;
  /** 保存配置：主进程**读改写**，只覆盖 payload 里出现过的键（缺省 = 不动该字段） */
  save_config: {
    order?: string[];
    pinnedSessions?: PinnedSessionPayload[];
    projects?: string[];
    excluded?: string[];
    dark?: boolean;
    closeAction?: string | null;
    defaultInteraction?: string;
  };
  add_project: { path: string };
  remove_project: { path: string };
  launch_project: { path: string };
  open_folder: { path: string };
  check_claude: void;
  /** Claude Code 更新检查：本地版本 vs npm registry 最新稳定版 */
  claude_update_status: void;
  /** Claude Code 一键升级：返回输出尾部 */
  claude_run_upgrade: void;
  check_projects: { paths: string[] };
  // ---------- 批量添加 ----------
  scan_claude_projects: void;
  get_claude_projects_dir: void;
  /** 清除失效项目的 Claude Code 会话数据（不可恢复），返回删除数 */
  purge_claude_project_data: { paths: string[] };
  // ---------- 会话管理 ----------
  list_sessions: { projectPath: string };
  /** 置顶会话清单（跨项目聚合，按 config 顺序实时解析元数据） */
  list_pinned_sessions: void;
  rename_session: { file: string; newTitle: string };
  delete_session: { file: string };
  list_trashed_sessions: void;
  restore_session: { file: string };
  purge_session: { file: string };
  purge_trash: void;
  get_session_messages: { file: string; offset?: number };
  search_session_messages: { file: string; keyword: string };
  get_session_user_prompts: { file: string };
  export_session: { file: string; destPath: string; format: string };
  get_usage_stats: { tzOffsetMinutes: number };
  resume_session: { file: string; projectPath: string };
  // ---------- app 内对话（Agent SDK） ----------
  /** 解析会话默认权限模式（项目 local > 项目 > 用户级），未配置返回 null */
  chat_default_permission_mode: { projectPath: string };
  /** 启动对话会话：事件经 `chat:event:<token>` 单向推送（token 由渲染层生成） */
  chat_start: {
    projectPath: string;
    sessionFile: string | null;
    permissionMode: ChatPermissionMode | null;
    token: string;
  };
  /** text 为 "" + images 非空 = 纯图消息（与 v2.0.0 的 `text: String` 同形） */
  chat_send: { sessionId: string; text: string; images: ChatImage[] };
  chat_interrupt: { sessionId: string };
  chat_set_permission_mode: { sessionId: string; mode: ChatPermissionMode };
  /** 权限 / 方案审批 / 提问的应答；denyMessage 仅拒绝时生效。
   *  ⚠️ `answers` 是 `AskUserQuestion` 的**唯一**有效回传方式——只回 allow 不带它
   *  等于「用户没选」，不报错但静默失效（见 docs/agent-sdk-interactive-tools.md） */
  chat_permission_response: {
    sessionId: string;
    requestId: string;
    allow: boolean;
    denyMessage?: string;
    /** 提问的选择：key = 题目完整文本（多选逗号分隔） */
    answers?: Record<string, string>;
    /** 用户没选选项、直接打字的自由文本（对应 AskUserQuestionOutput.response） */
    response?: string;
  };
  chat_close: { sessionId: string };
  // ---------- 内嵌终端（node-pty，对齐 Tauri 线 pty_* 命令面） ----------
  /** 启动 claude 终端会话：输出经 `pty:data:<token>`、退出经 `pty:exit:<token>`
   *  单向推送（token 由渲染层生成，先订阅再 invoke——早于应答的事件零丢失） */
  pty_spawn_claude: {
    cwd: string;
    resumeSessionId: string | null;
    newSessionId: string | null;
    cols: number;
    rows: number;
    token: string;
  };
  /** 键盘输入写入 PTY（xterm.js onData 原文） */
  pty_write: { id: number; data: string };
  /** 终端尺寸变更（FitAddon 防抖后调用） */
  pty_resize: { id: number; cols: number; rows: number };
  /** 结束终端会话（先 taskkill /T /F 杀树再 pty.kill；返回 = 树已杀完） */
  pty_kill: { id: number };
  /** 按会话 id 读会话标题（终端 tab 的会话名兜底）；文件未落盘返回 null */
  session_title_for: { projectPath: string; sessionId: string };
  /** 剪贴板里若放着**图片文件**（资源管理器「复制」），返回其路径；否则 null。
   *  只读不动剪贴板；位图/纯文本/非图片文件/非 Windows 一律 null */
  clipboard_image_path: void;
  // ---------- 供应商切换 ----------
  provider_list: void;
  provider_save: { provider: unknown };
  provider_delete: { id: string };
  provider_reorder: { ids: string[] };
  provider_switch: { id: string };
  provider_import_ccswitch: { filePath: string };
  provider_read_live: void;
  fetch_models_for_config: { baseUrl: string; apiKey: string };
  provider_query_usage: { id: string };
  open_url: { url: string };
  // ---------- 其他 ----------
  get_data_root: void;
  quit_app: void;
  autostart_supported: void;
  autostart_enabled: void;
  autostart_turn_on: void;
  autostart_turn_off: void;
  // ---------- 窗口控制 ----------
  pick_folder: { title: string };
  /** 选择文件（如 CC Switch 的 SQL 备份）；filters 形如 `[{name, extensions}]` */
  pick_file: { title: string; filters?: { name: string; extensions: string[] }[] };
  /** 另存为对话框（导出会话用） */
  save_file: {
    title: string;
    defaultPath: string;
    filters?: { name: string; extensions: string[] }[];
  };
  window_hide: void;
  window_destroy: void;
}

export type IpcChannel = keyof IpcContract;

/** 渲染进程可用的通道白名单（preload 运行时校验；新增通道必须同步这里）。
 *  ⚠️ 必须写成 `as const` 的字面量元组，不能声明成 `readonly IpcChannel[]`——
 *  后者会把元素类型拓宽成整个 `IpcChannel` 联合，下面的穷尽性断言就永远成立、形同虚设
 *  （实测：漏掉一个通道时 tsc 仍然退出 0）。 */
export const IPC_CHANNELS = [
  "list_projects",
  "load_config",
  "save_config",
  "add_project",
  "remove_project",
  "launch_project",
  "open_folder",
  "check_claude",
  "claude_update_status",
  "claude_run_upgrade",
  "check_projects",
  "scan_claude_projects",
  "get_claude_projects_dir",
  "purge_claude_project_data",
  "list_sessions",
  "list_pinned_sessions",
  "rename_session",
  "delete_session",
  "list_trashed_sessions",
  "restore_session",
  "purge_session",
  "purge_trash",
  "get_session_messages",
  "search_session_messages",
  "get_session_user_prompts",
  "export_session",
  "get_usage_stats",
  "resume_session",
  "chat_default_permission_mode",
  "chat_start",
  "chat_send",
  "chat_interrupt",
  "chat_set_permission_mode",
  "chat_permission_response",
  "chat_close",
  "pty_spawn_claude",
  "pty_write",
  "pty_resize",
  "pty_kill",
  "session_title_for",
  "clipboard_image_path",
  "provider_list",
  "provider_save",
  "provider_delete",
  "provider_reorder",
  "provider_switch",
  "provider_import_ccswitch",
  "provider_read_live",
  "fetch_models_for_config",
  "provider_query_usage",
  "open_url",
  "get_data_root",
  "quit_app",
  "autostart_supported",
  "autostart_enabled",
  "autostart_turn_on",
  "autostart_turn_off",
  "pick_folder",
  "pick_file",
  "save_file",
  "window_hide",
  "window_destroy",
] as const;

// ---------------- 白名单与契约的双向断言（编译期） ----------------
// 只声明成类型数组挡不住「漏项」：新增契约键却忘了加进数组时 tsc 照样通过，
// 运行期才在 preload 抛「不允许的 IPC 通道：x」。两个方向都钉住：
/** 多余项：数组里出现契约之外的通道 → 赋值失败 */
const _channelsInContract: readonly IpcChannel[] = IPC_CHANNELS;
/** 漏项：契约里有而数组里没有的通道 → MissingChannel 非 never → 不可赋值给 never */
type MissingChannel = Exclude<IpcChannel, (typeof IPC_CHANNELS)[number]>;
const _channelsExhaustive: MissingChannel extends never ? true : never = true;
void _channelsInContract;
void _channelsExhaustive;
