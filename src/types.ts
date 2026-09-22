export interface Project {
  /** 唯一键 = 项目绝对路径 */
  key: string;
  /** 叶子目录名（显示用） */
  name: string;
  /** 项目绝对路径 */
  path: string;
  /** false = 路径已不存在（后端 list_projects 扫描时随 missing 判定；健康检查弹窗复查后本地更新） */
  healthy: boolean;
}

export type CloseAction = "quit" | "minimize" | null;

export interface Config {
  /** 用户手动排序的项目绝对路径（全局拖拽排序真源；未收录项按名称追加在后） */
  order: string[];
  /** 置顶会话清单（全局聚合区；顺序即展示顺序，新置顶插最前） */
  pinnedSessions?: PinnedSession[];
  /** 手动添加的项目路径清单 */
  projects: string[];
  /** 被用户从列表移除的项目路径（会话扫描会重新发现它们，需排除） */
  excluded?: string[];
  dark: boolean;
  /** null/undefined = 每次询问；"quit" = 直接退出；"minimize" = 最小化到托盘 */
  closeAction?: CloseAction;
  /** 新开内容 tab 的默认交互方式："chat" = 页面对话（Agent SDK）；"terminal" = 内嵌终端。
   *  只决定「项目行 + / 点会话行」默认开哪种 tab；已开的 tab 不受切换影响（两种共存）。 */
  defaultInteraction?: "chat" | "terminal";
}

/** 置顶会话条目（持久化在 config 里） */
export interface PinnedSession {
  /** 会话 jsonl 文件绝对路径；重命名不改文件名、回收站恢复回原路径，故可作稳定锚点 */
  file: string;
  /** 所属项目绝对路径（置顶时刻记录，不靠 mangled 目录名反推） */
  projectPath: string;
}

export interface ClaudeProject {
  name: string;
  path: string;
  /** true = 真实路径已不存在（项目代码被删除），不可启动 */
  missing: boolean;
}

// ---------------- 内嵌终端（自 embedded-terminal 分支 src/types.ts 逐字搬入） ----------------

/** 内容区内嵌终端 tab（真 claude CLI 跑在 PTY 里，xterm.js 渲染） */
export interface TerminalTab {
  /** 前端 tab 标识（spawn 完成前就要渲染 tab，不用 pty id） */
  id: string;
  /** tab 标题（resume = 会话标题；新会话 = 项目名）。
   *  会话一有名字就被 claude 写进终端标题（OSC 0），由 TerminalPane 的 onTitle
   *  实时覆盖成真会话名（见 lib/term-title.ts）——初始值只是「还没起名」时的占位 */
  title: string;
  /** claude 的工作目录（项目绝对路径） */
  projectPath: string;
  /** 续聊的会话 id（uuid）；null = 新会话 */
  resumeSessionId: string | null;
  /** 新会话预生成的会话 id（`--session-id`；续聊 tab 为 null）：claude 的会话文件
   *  就是 `<id>.jsonl`，靠它把会话名回填到 tab 标题（见 App 的标题补挂） */
  newSessionId: string | null;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
}

/** claude 是否正在干活（由终端屏幕状态行探测，见 TerminalPane 的 detectActivity）。
 *  注意与 TerminalTab["status"] 的区别：status 只说"进程还活着"，处在 prompt 等输入的
 *  会话同样是 running；busy 才是"正在干活"。
 *  unknown = 屏幕上看不出来（用户滚在历史里 / claude 改了文案）——调用方按 busy 处理。 */
export type TabActivity = "busy" | "idle" | "unknown";

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

/** 置顶区展示项：会话元数据 + 所属项目路径（后端按置顶清单实时解析） */
export interface PinnedSessionInfo extends SessionInfo {
  /** 所属项目绝对路径：显示项目名徽标、判断项目失效、resume 时用 */
  projectPath: string;
}

/** 回收站中的会话备份（删除 = 移入回收站，可恢复） */
export interface TrashedSession {
  /** 备份文件绝对路径（恢复/永久删除时回传） */
  file: string;
  sessionId: string;
  /** 标题（复用会话元数据解析） */
  title: string;
  /** 删除时间（后端按 UTC 生成：YYYYMMDD_HHMMSS，前端转本地时区显示） */
  deletedAt: string;
  /** 原项目 mangled 目录名 */
  projectDir: string;
  /** 原项目真实路径（unmangle 解析，可能为 null） */
  projectPath: string | null;
}

/** 会话内容块（只读查看） */
export interface ContentBlock {
  /** text | thinking | tool_use | tool_result | image */
  kind: string;
  text?: string | null;
  name?: string | null;
  input?: unknown;
  toolUseId?: string | null;
  isError?: boolean | null;
  /** image 块的 media_type（image/png 等） */
  mediaType?: string | null;
  /** image 块的 base64 裸数据（无 data: 前缀） */
  data?: string | null;
}

/** 单条 assistant 消息的 token 用量（jsonl usage 字段的两种格式已归一） */
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

/** 粘贴/拖拽的图片附件（data 为 base64 裸数据，无 data: 前缀） */
export interface ChatImage {
  mediaType: string;
  data: string;
}

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
      /** init.effort：本轮会发给模型的思考强度。CLI 文档说只有 Remote Control 类宿主
       * （终端 / Desktop / VS Code）会上报，SDK 宿主可能拿不到 → 取不到就是 null，
       * 界面据此不显示这一项，别给它编默认值 */
      effort?: string | null;
    }
  | { type: "status"; state: "thinking" | "idle" }
  | {
      /** 上下文占用（`Query.getContextUsage()` 的读数），init 一到与每轮结束各推一次。
       *  用户要求「像终端状态行那样一启动就有」，所以不能等第一轮跑完。
       *  ⚠️ 这里送的是**原始数字**而不是 API 的 `percentage` —— 那个字段是 0-100 还是
       *  0-1 没验过（该 API 在 docs/agent-sdk-capabilities.md 里标「型」），
       *  前端自己算比值，单位问题就不存在了 */
      type: "context_usage";
      usedTokens: number;
      windowTokens: number;
      /** 主模型名（顺带捎回来，省得依赖 session_ready 那条路径） */
      model?: string | null;
    }
  | { type: "content_start"; kind: "text" | "thinking" }
  | { type: "delta"; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_use_complete"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "message_complete"; usage: ChatUsage }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_cancelled"; requestId: string }
  /** ExitPlanMode 方案审批：plan 为方案正文；应答 = allow（退出计划模式继续执行）
   *  / deny（留在计划模式） */
  | { type: "plan_approval"; requestId: string; plan: string }
  | {
      type: "turn_end";
      isError: boolean;
      resultText?: string | null;
      /** ⚠️ 本轮（不是累计）的用量：result.usage 在流式会话里就是 per-turn 的，
       *  所以 input+cache 三项之和 ≈ 当前上下文已占用的量，做百分比要用它。
       *  别拿 message_complete 那条（前端是累加的，越用越大） */
      usage?: ChatUsage | null;
      /** 主模型的上下文窗口（result.modelUsage 里那条的 contextWindow）；取不到为 null */
      contextWindow?: number | null;
    }
  | { type: "exited"; code: number | null; stderrTail?: string | null }
  | { type: "error"; message: string };

/** 对话视图内的一条渲染条目（工具调用合并其执行结果，展开即看） */
export type ChatItem =
  | { id: number; kind: "user"; text: string; images?: ChatImage[] }
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

/** 排行条目（项目/模型）的单日用量，供前端按时间范围过滤 */
export interface RankDayUsage {
  /** YYYY-MM-DD */
  date: string;
  tokens: number;
  messages: number;
  /** 该日归属的会话数（最后活跃日口径）；模型行恒为 0 */
  sessions: number;
}

/** 单个模型的用量汇总（统计口径：子代理消息也计入——内联在父文件里的
 *  sidechain 行与独立落盘的 `<会话>/subagents/*.jsonl` 都算真实消耗） */
export interface ModelUsage {
  /** 完整模型名（前端简化显示日期后缀） */
  model: string;
  tokens: number;
  messages: number;
  /** 按日期升序（范围过滤用；sessions 恒为 0） */
  perDay: RankDayUsage[];
}

/** 单日用量 */
export interface DailyUsage {
  /** YYYY-MM-DD */
  date: string;
  tokens: number;
  /** 归属到该日的会话数：会话按**最后活跃日**归属，跨天会话只计一次，
   *  任意日期窗口内累加 = 窗口内去重会话数（与全部范围的总会话数口径一致） */
  sessions: number;
  /** 当日活跃会话数（该日有任何消息的会话，跨天会话每天都计）——趋势图 tooltip 用 */
  activeSessions: number;
  messages: number;
}

/** 单项目用量 */
export interface ProjectUsage {
  name: string;
  path: string;
  sessions: number;
  messages: number;
  tokens: number;
  /** 按日期升序（范围过滤用；sessions 为最后活跃日归属） */
  perDay: RankDayUsage[];
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

/** 拉取到的供应商可用模型（ownedBy 用于下拉按厂商分组，缺失归 Other） */
export interface FetchedModel {
  id: string;
  ownedBy?: string | null;
}

/** Claude Code 更新检查结果（本机版本 vs npm registry 最新稳定版） */
export interface ClaudeUpdateStatus {
  /** 本地 claude 版本（未安装/探测失败为 null） */
  currentVersion: string | null;
  /** npm 最新稳定版（网络失败为 null） */
  latestVersion: string | null;
  /** latest 严格大于 current 才为 true */
  updateAvailable: boolean;
  /** 本地探测失败原因 */
  currentError: string | null;
  /** 网络查询失败原因 */
  latestError: string | null;
  /** 命中的 claude 可执行路径（诊断用） */
  installPath: string | null;
}
