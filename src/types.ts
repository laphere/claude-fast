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
  /** 用户手动排序的项目绝对路径（全局拖拽排序真源；未收录项按名称追加在后） */
  order: string[];
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
