// 会话管理：列表 / 元数据轻量提取 / 重命名 / 内容解析（对齐原 Tauri 后端 sessions 部分）
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidUuid, mangleProjectPath } from "./mangle";
import { blockText, cleanSummary, cleanTitle, extractXmlTag } from "./text";
// 同一 message.id 的代表行取舍规则与用量台账**共用同一个函数**（收尾行优先）：
// 会话头部的 token 统计必须与统计仪表盘对上，两处各写一份必然漂移。
import { betterUsageRow, type UsageRow } from "./usage-stats";

/** 会话内容渲染的最大消息数（防止超大 jsonl 拖垮 UI） */
export const MAX_SESSION_MESSAGES = 500;

/** jsonl 轻量读取的 head/tail 缓冲大小：会话文件可达数 MB 甚至更大，
 *  只读首尾各 64KB 即可提取全部元数据（与 cc-haha 的 LITE_READ_BUF_SIZE 一致）。 */
export const LITE_READ_BUF_SIZE = 64 * 1024;

export interface SessionInfo {
  /** 会话 ID（uuid，即 jsonl 文件名） */
  sessionId: string;
  /** 最终显示标题：customTitle > aiTitle > 首条用户消息 */
  title: string;
  /** 副行摘要：customTitle > lastPrompt > summary 字段 > 首条用户消息 */
  summary: string;
  /** 最后修改时间（文件 mtime，epoch ms） */
  lastModified: number;
  /** jsonl 文件绝对路径（重命名时回传） */
  file: string;
}

export interface ContentBlock {
  /** text | thinking | tool_use | tool_result | image */
  kind: string;
  text?: string | null;
  /** tool_use 工具名 */
  name?: string | null;
  /** tool_use 输入（JSON 原样） */
  input?: unknown;
  /** tool_result 关联的 tool_use id */
  toolUseId?: string | null;
  isError?: boolean | null;
  /** image 块的 media_type（image/png 等） */
  mediaType?: string | null;
  /** image 块的 base64 裸数据（无 data: 前缀） */
  data?: string | null;
}

/** 单条 assistant 消息的 token 用量（jsonl usage 的两种格式已归一） */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 会话级 token 统计（对**全量**消息聚合，分页切片不影响准确性） */
export interface SessionUsageStats {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 总 token（输入 + 输出 + 缓存读取 + 缓存写入） */
  totalTokens: number;
}

export interface SessionMessage {
  /** user | assistant */
  kind: string;
  blocks: ContentBlock[];
  timestamp?: string | null;
  /** assistant 的模型名 */
  model?: string | null;
  /** assistant 的 token 用量（user 消息、以及同 id 的后续段为 null） */
  usage?: Usage | null;
}

export interface SessionMessages {
  messages: SessionMessage[];
  /** 还有更早的消息未加载（向上分页用） */
  hasMore: boolean;
  total: number;
  /** 本批起始位置（0 = 从最早一条开始） */
  offset: number;
  /** 会话级 token 统计（全量聚合，与本次切片无关） */
  stats: SessionUsageStats;
}

type Json = Record<string, unknown>;

/** 把一段 jsonl 文本按行解析为 JSON（坏行忽略——head/tail 边界行可能被截断） */
export function parseJsonLines(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Json);
    } catch {
      // 坏行忽略
    }
  }
  return out;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBool(v: unknown): boolean {
  return v === true;
}

/** 在行列表中取**最后一条**指定 type 行的字符串字段（tail 优先，head 兜底） */
export function lastFieldOfType(
  lines: Json[],
  ty: string,
  field: string,
): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i];
    if (v.type === ty) {
      const s = asString(v[field]);
      if (s !== null && s.trim() !== "") return s;
    }
  }
  return null;
}

/** 提取首个**非命令**的 user 消息文本（字符串 content 或 text 块数组）。
 *  命令消息（/init、/clear 等，content 含 <command-name>/<command-message>）
 *  不算实质对话内容：只有命令没有普通对话的会话无需展示。 */
export function extractFirstPrompt(head: Json[]): string | null {
  for (const v of head) {
    if (v.type !== "user") continue;
    if (asBool(v.isMeta)) continue;
    const msg = v.message as Json | undefined;
    if (!msg || msg.role !== "user") continue;
    let text: string;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<Json>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join(" ");
    } else {
      continue;
    }
    // 命令消息跳过（不算实质内容）
    if (text.includes("<command-name>") || text.includes("<command-message>")) continue;
    // 清洗后为空（如纯 XML 包裹且内容为空的极端情况）→ 跳过该条
    const cleaned = cleanSummary(text);
    if (cleaned !== "") return cleaned;
  }
  return null;
}

/** 从 head/tail 提取会话元数据。null = 该文件不是有效会话（sidechain 等）。 */
export function sessionMetaFromLite(
  head: string,
  tail: string,
  sessionId: string,
  lastModified: number,
): SessionInfo | null {
  const headLines = parseJsonLines(head);
  const tailLines = parseJsonLines(tail);
  // sidechain 会话（并行子会话）不在列表中展示
  if (headLines.length > 0 && asBool(headLines[0].isSidechain)) return null;
  // 标题优先级：手动重命名 > AI 自动标题 > 首条用户消息
  const customTitle =
    lastFieldOfType(tailLines, "custom-title", "customTitle") ??
    lastFieldOfType(headLines, "custom-title", "customTitle");
  const aiTitle =
    lastFieldOfType(tailLines, "ai-title", "aiTitle") ??
    lastFieldOfType(headLines, "ai-title", "aiTitle");
  const firstPrompt = extractFirstPrompt(headLines);
  // 摘要回退链：customTitle > lastPrompt > summary 字段 > 首条消息
  const summaryRaw =
    customTitle ??
    lastFieldOfType(tailLines, "last-prompt", "lastPrompt") ??
    lastFieldOfType(headLines, "last-prompt", "lastPrompt") ??
    lastFieldOfType(tailLines, "summary", "summary") ??
    lastFieldOfType(headLines, "summary", "summary") ??
    firstPrompt;
  const summary = summaryRaw !== null ? cleanSummary(summaryRaw) : "";
  const titleRaw = customTitle ?? aiTitle ?? firstPrompt;
  let title = titleRaw !== null ? cleanSummary(titleRaw) : "";
  if (title === "") title = "未命名会话";
  // 只有元数据（无任何内容）的会话跳过：含只执行了 /init 等命令的会话
  if (summary === "" && title === "未命名会话") return null;
  return { sessionId, title, summary, lastModified, file: "" };
}

/** 读取会话 jsonl 的 head/tail（单 fd 两次 read），返回原始文本。空文件返回 null。 */
export function readHeadTail(
  p: string,
): { head: string; tail: string; mtime: number } | null {
  let fd: number;
  let size: number;
  let mtime: number;
  try {
    fd = fs.openSync(p, "r");
    const st = fs.fstatSync(fd);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    return null;
  }
  try {
    if (size === 0) return null;
    const buf = Buffer.alloc(LITE_READ_BUF_SIZE);
    const headN = fs.readSync(fd, buf, 0, LITE_READ_BUF_SIZE, 0);
    const head = buf.subarray(0, headN).toString("utf8");
    let tail = head;
    if (size > LITE_READ_BUF_SIZE) {
      const tailN = fs.readSync(fd, buf, 0, LITE_READ_BUF_SIZE, size - LITE_READ_BUF_SIZE);
      tail = buf.subarray(0, tailN).toString("utf8");
    }
    return { head, tail, mtime };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/** 列出某项目（真实路径）的 Claude Code 会话，按最后修改时间倒序 */
export function listSessions(projectsDir: string, projectPath: string): SessionInfo[] {
  const dir = path.join(projectsDir, mangleProjectPath(projectPath));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    const sessionId = name.slice(0, -".jsonl".length);
    if (!isValidUuid(sessionId)) continue;
    const ht = readHeadTail(p);
    if (!ht) continue;
    const info = sessionMetaFromLite(ht.head, ht.tail, sessionId, Math.round(ht.mtime));
    if (info) {
      info.file = p;
      out.push(info);
    }
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}

/** 校验会话文件路径：必须位于 Claude Code 项目目录下、名称为 <uuid>.jsonl。
 *  返回解析后的绝对路径与 session id。
 *
 *  两道判断，顺序不能反：
 *  ① **词法**作用域（`path.relative`）——挡住 `..`，且不碰文件系统，越界路径能给出准确报错；
 *  ② **canonicalize** 后的作用域——词法比较挡不住「目录里有符号链接指到外面」，
 *     realpath 之后才是真实落点。文件不存在时 realpath 失败即拒绝（本函数服务于
 *     重命名/删除，文件本就必须存在）。 */
export function validateSessionFile(
  file: string,
  projectsDir: string,
): { path: string; sessionId: string } {
  const p = path.resolve(file);
  const name = path.basename(p);
  if (!name.endsWith(".jsonl")) throw new Error("非法会话文件");
  const sessionId = name.slice(0, -".jsonl".length);
  if (!isValidUuid(sessionId)) throw new Error("非法会话文件");
  // 组件级前缀比较（对齐 Rust Path::starts_with，非字符串前缀）
  const rel = path.relative(projectsDir, p);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("会话文件不在 Claude Code 目录中");
  }
  let real: string;
  let realDir: string;
  try {
    real = fs.realpathSync(p);
    realDir = fs.realpathSync(projectsDir);
  } catch {
    throw new Error("会话文件不存在");
  }
  const realRel = path.relative(realDir, real);
  if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error("会话文件不在 Claude Code 目录中");
  }
  return { path: real, sessionId };
}

/** 向会话 jsonl 追加 custom-title 行（与 Claude Code CLI 的 /rename 同机制，
 *  不修改/覆盖原文件）。 */
export function appendCustomTitle(p: string, sessionId: string, title: string): void {
  const line = JSON.stringify({
    type: "custom-title",
    customTitle: title,
    sessionId,
  });
  fs.appendFileSync(p, line + "\n", "utf8");
}

/** 重命名会话：标题清洗（去控制字符、trim、限长）后向 jsonl 追加 custom-title 行 */
export function renameSession(file: string, newTitle: string, projectsDir: string): void {
  const { path: p, sessionId } = validateSessionFile(file, projectsDir);
  const title = cleanTitle(newTitle);
  if (title === "") throw new Error("标题不能为空");
  appendCustomTitle(p, sessionId, title);
}

/** 解析一条消息的 content 为内容块列表。命令消息（<command-name> 等）返回空。 */
export function parseContentBlocks(
  content: unknown,
  _role: string,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (typeof content === "string") {
    const s = content;
    // 命令消息（/init 等）不算实质对话内容
    if (s.includes("<command-name>") || s.includes("<command-message>")) return out;
    // 后台任务完成通知（<task-notification> 包裹，Claude Code 以 user 字符串
    // 消息写入）→ 按工具结果展示，不当作普通用户输入。
    if (s.includes("<task-notification>")) {
      const text =
        extractXmlTag(s, "result") ??
        extractXmlTag(s, "summary") ??
        extractXmlTag(s, "task-notification");
      if (text !== null) {
        out.push({
          kind: "tool_result",
          text,
          name: null,
          input: null,
          toolUseId: extractXmlTag(s, "tool-use-id"),
          isError: null,
        });
      }
      return out;
    }
    const t = s.trim();
    if (t !== "") out.push({ kind: "text", text: t, name: null, input: null, toolUseId: null, isError: null });
    return out;
  }
  if (Array.isArray(content)) {
    for (const b of content as Array<Json>) {
      const ty = asString(b.type);
      if (!ty) continue;
      if (ty === "text" || ty === "thinking") {
        // text 块字段是 text；thinking 块字段是 thinking；tool_result 才是 content
        const raw = b.text ?? b.thinking ?? b.content;
        const t = blockText(raw as string | Array<Json>);
        if (t !== null) {
          out.push({ kind: ty, text: t, name: null, input: null, toolUseId: null, isError: null });
        }
      } else if (ty === "tool_use") {
        const name = asString(b.name) ?? "";
        if (name !== "") {
          out.push({
            kind: "tool_use",
            text: null,
            name,
            input: b.input ?? null,
            toolUseId: asString(b.id),
            isError: null,
          });
        }
      } else if (ty === "tool_result") {
        const t = blockText(b.content as string | Array<Json>);
        if (t !== null) {
          out.push({
            kind: "tool_result",
            text: t,
            name: null,
            input: null,
            toolUseId: asString(b.tool_use_id),
            isError: typeof b.is_error === "boolean" ? b.is_error : null,
          });
        }
      } else if (ty === "image") {
        // 用户贴图/拖图的消息在 jsonl 里是 image 块（source.type=base64）。
        // 少这一支的后果：查看器里历史图片整块消失（ChatView 本来就会渲染
        // kind === "image"，只是后端从来不产出），导出 markdown 的图片占位也成了死代码。
        // 判据逐字对齐 v2.0.0 的 parse_content_blocks（lib.rs:1723-1736）：只看
        // source.media_type / source.data **两者都非空**，不额外要求 source.type——
        // 否则会为一个空壳 image 块多导出一行「🖼️ [图片]」。
        const src = (b.source ?? {}) as Json;
        const mediaType = asString(src.media_type);
        const data = asString(src.data);
        if (mediaType && data) {
          out.push({
            kind: "image",
            text: null,
            name: null,
            input: null,
            toolUseId: null,
            isError: null,
            mediaType,
            data,
          });
        }
      }
    }
  }
  return out;
}

/** 解析 jsonl 全文为会话消息列表：
 *  只提取 user/assistant 消息，过滤元数据行 / sidechain / isMeta / 命令消息。 */
export function parseSessionMessages(content: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  /** 上一条已入列消息的 `message.id` */
  let lastMsgId: string | null = null;
  /** message.id → 该 id 的**代表行** usage（收尾行优先，与用量台账同口径） */
  const bestUsage = new Map<string, UsageRow>();
  /** message.id → 它的首个存活消息下标（代表行的 usage 最终落到这条上） */
  const idToIndex = new Map<string, number>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let v: Json;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const ty = asString(v.type);
    if (ty !== "user" && ty !== "assistant") continue;
    // sidechain / isMeta 消息跳过（与列表过滤语义一致）
    if (asBool(v.isSidechain) || asBool(v.isMeta)) continue;
    const msg = v.message as Json | undefined;
    if (!msg) continue;
    const role = asString(msg.role);
    if (role !== "user" && role !== "assistant") continue;
    const blocks = parseContentBlocks(msg.content, role);
    if (blocks.length === 0) continue;
    const msgId = asString(msg.id);
    const usage = parseUsage(msg.usage);
    // 同 id 的多行是**一次响应的流式快照**：首行 usage 恒为 0（或只有占位），真实值在
    // 带 stop_reason 的收尾行上；而逐行相加又会成倍虚高。故按 id 收敛出代表行
    // （收尾行优先，同优先级取 token 更大者）——复用台账的 betterUsageRow，别在这里
    // 另写一份：两处口径漂移过一次（台账 v3 前取首行，实测只统计到真实值的 1.3%）。
    if (msgId !== null && usage) {
      const row: UsageRow = {
        finalRow: asString(msg.stop_reason) !== null,
        tokens:
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheReadInputTokens +
          usage.cacheCreationInputTokens,
        usage,
        model: asString(msg.model) ?? "unknown",
        date: null,
      };
      const cur = bestUsage.get(msgId);
      if (!cur || betterUsageRow(row, cur)) bestUsage.set(msgId, row);
    }
    // 相邻同 id：代理多段迭代共用一个 `message.id`，后段是同一响应的续块，
    // 并入上一条而不是各自成条——否则消息数虚高一截（真实会话实测 +30~80%），
    // 连带 Markdown 导出的「## 消息 N」小节数与 500 条分页覆盖的轮次都失真。
    if (msgId !== null && msgId === lastMsgId) {
      const last = messages[messages.length - 1];
      if (last) {
        last.blocks.push(...blocks);
        continue;
      }
    }
    messages.push({
      kind: role,
      blocks,
      timestamp: asString(v.timestamp),
      model: asString(msg.model),
      // 先留空，循环结束后按 id 落代表行；无 id 的行无从收敛（罕见），
      // 直接记自己那一行的 usage——宁可多算也不静默丢
      usage: msgId === null ? usage : null,
    });
    if (msgId !== null && !idToIndex.has(msgId)) {
      idToIndex.set(msgId, messages.length - 1);
    }
    lastMsgId = msgId;
  }
  // 第二遍：代表行的 usage 落到该 id 的首个存活消息上（收尾行可能在很后面，
  // 单遍扫描时还不知道它长什么样）
  for (const [id, row] of bestUsage) {
    const idx = idToIndex.get(id);
    if (idx !== undefined) messages[idx].usage = row.usage;
  }
  return messages;
}

/** 防御式解析 usage 字段：旧格式各字段是数字，新格式 `input_tokens` 是
 *  `{input, cache_read, cache_creation}` 嵌套对象。无 usage 返回 null。 */
export function parseUsage(v: unknown): Usage | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const obj = v as Json;
  /** 非负整数才计入（对应 v2 线的 as_u64：负数/NaN/字符串一律当 0） */
  const norm = (x: unknown): number =>
    typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  const num = (k: string): number => norm(obj[k]);
  const it = obj.input_tokens;
  let inputTokens: number;
  let cacheRead: number;
  let cacheCreation: number;
  if (typeof it === "number") {
    inputTokens = norm(it);
    cacheRead = num("cache_read_input_tokens");
    cacheCreation = num("cache_creation_input_tokens");
  } else if (it && typeof it === "object" && !Array.isArray(it)) {
    const o = it as Json;
    const read = (k: string): number => norm(o[k]);
    inputTokens = read("input");
    // 新格式嵌套字段缺省时回退到顶层（部分版本两层都有）
    cacheRead = Math.max(read("cache_read"), num("cache_read_input_tokens"));
    cacheCreation = Math.max(read("cache_creation"), num("cache_creation_input_tokens"));
  } else {
    inputTokens = num("input_tokens");
    cacheRead = num("cache_read_input_tokens");
    cacheCreation = num("cache_creation_input_tokens");
  }
  return {
    inputTokens,
    outputTokens: num("output_tokens"),
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
}

/** 对**全量**消息聚合 token 统计（usage 在解析时就保留，分页切片不影响准确性）。
 *  同 id 的后续段 usage 为 null，故不会重复累加。 */
export function aggregateUsage(messages: SessionMessage[]): SessionUsageStats {
  const stats: SessionUsageStats = {
    messageCount: messages.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  for (const m of messages) {
    if (!m.usage) continue;
    stats.inputTokens += m.usage.inputTokens;
    stats.outputTokens += m.usage.outputTokens;
    stats.cacheReadTokens += m.usage.cacheReadInputTokens;
    stats.cacheCreationTokens += m.usage.cacheCreationInputTokens;
  }
  stats.totalTokens =
    stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
  return stats;
}

/** 向上分页切片：默认返回**最后** limit 条（打开会话时焦点在最新）；
 *  传 offset 返回从该位置起的 limit 条（加载更早时传 offset - limit）。 */
export function sliceMessages(
  all: SessionMessage[],
  offset?: number,
  limit?: number,
): SessionMessages {
  // stats 在切片**前**对全量聚合——分页只影响 messages，不影响头部统计
  const stats = aggregateUsage(all);
  const total = all.length;
  const lim = Math.min(2000, Math.max(1, limit ?? MAX_SESSION_MESSAGES));
  const start = offset !== undefined ? Math.min(offset, total) : Math.max(0, total - lim);
  const end = Math.min(start + lim, total);
  const messages = start < end ? all.slice(start, end) : [];
  return { messages, hasMore: start > 0, total, offset: start, stats };
}

/** 读取会话内容（只读查看用，向上分页） */
export function getSessionMessages(
  file: string,
  projectsDir: string,
  offset?: number,
  limit?: number,
): SessionMessages {
  const { path: p } = validateSessionFile(file, projectsDir);
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`读取会话文件失败：${String(e)}`);
  }
  return sliceMessages(parseSessionMessages(content), offset, limit);
}
