export interface Project {
  /** 唯一键 = 项目绝对路径 */
  key: string;
  /** 叶子目录名（显示用） */
  name: string;
  /** 项目绝对路径 */
  path: string;
  /** undefined = 尚未检查（列表先渲染，后台异步检查后回填）；false = 路径已不存在 */
  healthy?: boolean;
}

export type CloseAction = "quit" | "minimize" | null;

export interface Config {
  /** 收藏的项目绝对路径（置顶） */
  favorites: string[];
  /** 手动添加的项目路径清单 */
  projects: string[];
  /** 被用户从列表移除的项目路径（会话扫描会重新发现它们，需排除） */
  excluded?: string[];
  dark: boolean;
  /** null/undefined = 每次询问；"quit" = 直接退出；"minimize" = 最小化到托盘 */
  closeAction?: CloseAction;
}

export interface CreateResult {
  file: string;
  existed: boolean;
}

export interface ClaudeProject {
  name: string;
  path: string;
  /** true = 真实路径已不存在（项目代码被删除），不可启动 */
  missing: boolean;
}

/** Claude Code 会话元数据（来自 ~/.claude/projects 下 jsonl 的轻量解析） */
export interface SessionInfo {
  sessionId: string;
  /** 显示标题：customTitle > aiTitle > 首条用户消息 */
  title: string;
  /** 副行摘要：customTitle > lastPrompt > summary > 首条用户消息 */
  summary: string;
  /** 最后修改时间（epoch ms） */
  lastModified: number;
  /** jsonl 文件绝对路径（重命名时回传） */
  file: string;
}

/** 回收站中的会话备份（删除 = 移入回收站，可恢复） */
export interface TrashedSession {
  /** 备份文件绝对路径（恢复/永久删除时回传） */
  file: string;
  sessionId: string;
  /** 标题（复用会话元数据解析） */
  title: string;
  /** 删除时间（YYYYMMDD_HHMMSS） */
  deletedAt: string;
  /** 原项目 mangled 目录名 */
  projectDir: string;
  /** 原项目真实路径（unmangle 解析，可能为 null） */
  projectPath: string | null;
}

/** 会话内容块（阶段二：只读查看） */
export interface ContentBlock {
  /** text | thinking | tool_use | tool_result */
  kind: string;
  text?: string | null;
  name?: string | null;
  input?: unknown;
  toolUseId?: string | null;
  isError?: boolean | null;
}

/** 单条 assistant 消息的 token 用量（jsonl usage 字段，新旧格式已归一） */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 会话级 token 统计（全量聚合，分页不影响准确性） */
export interface SessionUsageStats {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 总 token（输入 + 输出 + 缓存读取 + 缓存写入） */
  totalTokens: number;
}

/** 会话中的一条消息 */
export interface SessionMessage {
  /** user | assistant */
  kind: string;
  blocks: ContentBlock[];
  timestamp?: string | null;
  model?: string | null;
  /** assistant 的 token 用量（user 消息为 undefined） */
  usage?: Usage | null;
}

export interface SessionMessages {
  /** 本批消息（最多 limit 条） */
  messages: SessionMessage[];
  /** 还有更早的消息未加载（向上分页） */
  hasMore: boolean;
  /** 会话总消息数 */
  total: number;
  /** 本批起始位置（0 = 从最早一条开始） */
  offset: number;
  /** 会话级 token / 成本统计 */
  stats: SessionUsageStats;
}

/** 会话全文搜索的命中（一条命中 = 一个内容块） */
export interface SessionSearchHit {
  /** 消息在会话中的全局序号（第一条实质消息 = 0） */
  index: number;
  /** 内容块在消息内的序号 */
  blockIndex: number;
  /** user | assistant */
  kind: string;
  /** 命中上下文片段（单行化） */
  snippet: string;
}

/** 对话进度条的一格：一条用户发言（左侧导航轨用） */
export interface SessionUserPrompt {
  /** 消息全局序号（与 get_session_messages 的序号一致，点击定位用） */
  index: number;
  /** 发言文本（清洗后，供悬停预览） */
  text: string;
  timestamp?: string | null;
}

// ---------------- app 内直接对话（chat.rs ChatEvent 对齐） ----------------

/** 权限模式（与官方 CLI --permission-mode 取值一致，v2.1.x 共 6 种，等价终端 Shift+Tab） */
export type ChatPermissionMode =
  | "manual"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

/** 单条 assistant 消息的 token 用量 */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 后端 chat 模块经 ipc::Channel 推送的流式事件（tag = type） */
export type ChatEvent =
  | {
      type: "session_ready";
      sessionId: string;
      model?: string | null;
      /** init 事件上报的实际生效权限模式（跟随 settings.json 时的回显依据） */
      permissionMode?: string | null;
    }
  | { type: "status"; state: "thinking" | "idle" }
  | { type: "content_start"; kind: "text" | "thinking" }
  | { type: "delta"; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_use_complete"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "message_complete"; usage: ChatUsage }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_cancelled"; requestId: string }
  | {
      type: "turn_end";
      isError: boolean;
      resultText?: string | null;
      usage?: ChatUsage | null;
    }
  | { type: "exited"; code: number | null; stderrTail?: string | null }
  | { type: "error"; message: string };

/** 对话视图内的一条渲染条目（工具调用合并其执行结果，展开即看） */
export type ChatItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "text"; text: string; streaming: boolean }
  | { id: number; kind: "thinking"; text: string; streaming: boolean }
  | {
      id: number;
      kind: "tool_use";
      toolUseId: string;
      name: string;
      input: unknown;
      hasResult: boolean;
      isError: boolean;
      /** 配对到的执行结果文本（无主结果仍单独成条 tool_result） */
      resultText?: string;
    }
  | { id: number; kind: "tool_result"; toolUseId: string; isError: boolean; text: string };

/** 对话中的权限确认请求 */
export interface ChatPermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

/** 单个模型的用量汇总（统计口径：sidechain 子代理消息也计入） */
export interface ModelUsage {
  /** 完整模型名（前端简化显示日期后缀） */
  model: string;
  tokens: number;
  messages: number;
}

/** 单日用量 */
export interface DailyUsage {
  /** YYYY-MM-DD */
  date: string;
  tokens: number;
  /** 归属到该日的会话数：会话按**最后活跃日**归属，跨天会话只计一次，
   *  任意日期窗口内累加 = 窗口内去重会话数（与全部范围的总会话数口径一致） */
  sessions: number;
  messages: number;
}

/** 单项目用量 */
export interface ProjectUsage {
  name: string;
  path: string;
  sessions: number;
  messages: number;
  tokens: number;
}

/** 全局使用统计（仪表盘；口径 = **历史累计消耗**：后端用量台账持久记录每个会话
 *  文件的贡献，已删除会话仍计入；excluded 项目不计（含其历史）；订阅版 jsonl
 *  无 costUSD，故只统计 token） */
export interface UsageStats {
  sessions: number;
  messages: number;
  /** 总 token（输入 + 输出 + 缓存读取 + 缓存写入） */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  earliest?: string | null;
  latest?: string | null;
  /** 按日期升序 */
  perDay: DailyUsage[];
  /** 按 token 倒序 */
  perProject: ProjectUsage[];
  /** 按 token 倒序 */
  perModel: ModelUsage[];
}

/** Claude Code 供应商条目（settingsConfig = 切换时整文件写入 ~/.claude/settings.json 的内容） */
export interface ProviderInfo {
  id: string;
  name: string;
  settingsConfig: Record<string, unknown>;
  websiteUrl?: string | null;
  /** official / cn_official / cloud_provider / aggregator / third_party / custom */
  category?: string | null;
}

/** 供应商清单状态 */
export interface ProviderListState {
  providers: ProviderInfo[];
  currentId: string | null;
}

/** 切换结果（warnings = 回填等非致命告警） */
export interface ProviderSwitchOutcome {
  list: ProviderListState;
  warnings: string[];
}

/** CC Switch SQL 备份导入结果 */
export interface ProviderImportOutcome {
  list: ProviderListState;
  imported: number;
  skipped: number;
  warnings: string[];
}


/** 单个用量窗口（如 5 小时 / 每周），utilization 为 0-100 已用百分比 */
export interface UsageTier {
  /** five_hour / weekly_limit / monthly */
  name: string;
  utilization: number;
  resetsAt?: string | null;
  usedValueUsd?: number | null;
  maxValueUsd?: number | null;
}

/** Coding Plan 用量查询结果；supported=false 表示非已知厂商（前端静默） */
export interface UsageResult {
  success: boolean;
  supported: boolean;
  vendor?: string | null;
  data: UsageTier[];
  error?: string | null;
}
