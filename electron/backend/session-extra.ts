// 会话域增强命令（搜索 / 用户发言提取 / 导出 / 清除失效项目数据 / 置顶会话清单）。
// 行为对齐 v2.0.0（Tauri + Rust，src-tauri/src/lib.rs 的
// search_session_messages / get_session_user_prompts / export_session /
// render_session_markdown / purge_claude_project_data / list_pinned_sessions）。
//
// 只新建本文件，不改动任何既有模块；可复用 sessions.ts / config.ts / mangle.ts /
// text.ts / paths.ts 的导出，但会话文件校验一律走本文件的 resolveSessionFile——
// 因为它会先 canonicalize 再做前缀判断（见下方铁律注释），而 sessions.ts 的
// validateSessionFile 用的是 path.relative 词法比较，不满足「规范化 `..`」要求。
import * as fs from "node:fs";
import * as path from "node:path";

import {
  parseSessionMessages,
  readHeadTail,
  sessionMetaFromLite,
  type SessionMessage,
} from "./sessions";
// 转发 SessionMessage 类型，便于下游（测试 / 前端）从本模块统一引用
export type { SessionMessage } from "./sessions";
import { type PinnedSession } from "./config";
import { mangleProjectPath, isValidUuid } from "./mangle";
import { cleanSummary } from "./text";
import { claudeProjectsDir } from "./paths";

/** 搜索命中上限：前端对跨分页命中做跳转与展开 diff 卡，过多反而失去焦点意义 */
export const MAX_SEARCH_HITS = 200;

/** 会话全文搜索的命中（一条命中 = 一个内容块）。字段逐字节对齐 v2.0.0 的 SessionSearchHit */
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

/** 对话进度条的一格：一条用户发言（左侧导航轨用）。字段对齐 v2.0.0 的 SessionUserPrompt */
export interface SessionUserPrompt {
  /** 消息全局序号（与 get_session_messages 的序号一致，点击定位用） */
  index: number;
  /** 发言文本（清洗后，供悬停预览） */
  text: string;
  timestamp?: string | null;
}

/** 置顶区展示项：会话元数据 + 所属项目路径。字段对齐 v2.0.0 的 PinnedSessionInfo */
export interface PinnedSessionInfo {
  sessionId: string;
  /** 显示标题：customTitle > aiTitle > 首条用户消息 */
  title: string;
  /** 副行摘要 */
  summary: string;
  /** 最后修改时间（epoch ms） */
  lastModified: number;
  /** jsonl 文件绝对路径 */
  file: string;
  /** 所属项目绝对路径（显示项目名徽标、判断项目失效、resume 时用） */
  projectPath: string;
}

// ----------------------------------------------------------------------------
// 会话文件校验（铁律：先 canonicalize 再做前缀判断）
// ----------------------------------------------------------------------------

/**
 * 校验会话文件路径：必须位于 Claude Code 项目目录下、名为 `<uuid>.jsonl`。
 * 返回规范化后的绝对路径与 session id。
 *
 * 铁律：必须先 `realpathSync` 把 `..`、符号链接、大小写都折成真实路径，
 * 再做「是否落在 projectsDir 内」的前缀判断。若只做 path.relative 词法前缀，
 * `projects/../outside/x.jsonl` 这种路径会穿过边界（sessions.ts 的旧做法在
 * 这里被刻意覆盖）。canonicalize 失败（文件/目录不存在）直接报错，不给穿越机会。
 */
function resolveSessionFile(
  file: string,
  projectsDir: string,
): { path: string; sessionId: string } {
  const name = path.basename(file);
  if (!name.endsWith(".jsonl")) throw new Error("非法会话文件");
  const sessionId = name.slice(0, -".jsonl".length);
  if (!isValidUuid(sessionId)) throw new Error("非法会话文件");

  // 目录也必须真实存在才能规范化；目录本身都不存在时文件不可能在它里面
  let dirCanon: string;
  try {
    dirCanon = fs.realpathSync(projectsDir);
  } catch {
    throw new Error("会话文件不在 Claude Code 目录中");
  }
  let fileCanon: string;
  try {
    fileCanon = fs.realpathSync(file); // 文件不存在 → 直接「不存在」错误
  } catch {
    throw new Error("会话文件不存在");
  }
  // 组件级前缀判断（与 Rust Path::starts_with 一致，非字符串前缀）
  const rel = path.relative(dirCanon, fileCanon);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("会话文件不在 Claude Code 目录中");
  }
  return { path: fileCanon, sessionId };
}

// ----------------------------------------------------------------------------
// 会话全文搜索
// ----------------------------------------------------------------------------

/**
 * 构造命中上下文片段：命中处前后各 radius 个字符切片并单行化。
 * Rust 用 floor/ceil_char_boundary 防 panic；这里用代码点切片（[...str]），
 * 对 ASCII 测试内容完全等价，偶发代理对边界漂移可接受。
 */
function makeSnippet(text: string, hit: number, kwLen: number, radius: number): string {
  const chars = [...text];
  const start = Math.max(0, hit - radius);
  const end = Math.min(chars.length, hit + kwLen + radius);
  return chars.slice(start, end).join("").replace(/\n/g, " ");
}

/**
 * 全文件全文搜索：text 块 + tool_use 输入，跳过 thinking / tool_result；
 * 大小写不敏感，按消息顺序返回，最多 MAX_SEARCH_HITS 条。
 * 命中结构（消息序号 + 块序号 + 上下文片段）供前端跨分页跳转与展开 diff 卡。
 */
export function searchSessionMessages(
  file: string,
  keyword: string,
  projectsDir: string = claudeProjectsDir(),
): SessionSearchHit[] {
  const kw = keyword.trim().toLowerCase();
  if (kw === "") return [];
  const { path: p } = resolveSessionFile(file, projectsDir);
  const content = fs.readFileSync(p, "utf8");
  const messages = parseSessionMessages(content);
  const out: SessionSearchHit[] = [];
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index];
    const blocks = m.blocks;
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const b = blocks[blockIndex];
      // thinking / tool_result / image 等一律跳过，只搜 text 与 tool_use 输入
      let hay: string;
      if (b.kind === "text") {
        hay = b.text ?? "";
      } else if (b.kind === "tool_use") {
        let s = b.name ?? "";
        if (b.input !== undefined && b.input !== null) {
          s += " " + JSON.stringify(b.input);
        }
        hay = s;
      } else {
        continue;
      }
      const lower = hay.toLowerCase();
      const hit = lower.indexOf(kw);
      if (hit === -1) continue;
      out.push({
        index,
        blockIndex,
        kind: m.kind,
        snippet: makeSnippet(hay, hit, kw.length, 40),
      });
      if (out.length >= MAX_SEARCH_HITS) return out; // 命中上限，提前结束
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// 对话进度条：用户发言提取（左侧导航轨）
// ----------------------------------------------------------------------------

/**
 * 提取全部用户发言（对话进度条导航用）。命令消息（如 `/init`，content 含
 * `<command-name>` / `<command-message>` / `<local-command-stdout>`）必须跳过——
 * 它们不是用户实质输入；`[Request interrupted` 这类系统消息同样跳过。
 * 返回每条发言的全局序号 + 清洗后文本 + 时间戳（供悬停预览与定位跳转）。
 */
export function getSessionUserPrompts(
  file: string,
  projectsDir: string = claudeProjectsDir(),
): SessionUserPrompt[] {
  const { path: p } = resolveSessionFile(file, projectsDir);
  const content = fs.readFileSync(p, "utf8");
  const messages = parseSessionMessages(content);
  const out: SessionUserPrompt[] = [];
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index];
    if (m.kind !== "user") continue;
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text ?? "")
      .join(" ");
    // 命令消息的标记来自 CLI 写入的原始 content，需在此过滤
    if (
      text.includes("<command-name>") ||
      text.includes("<command-message>") ||
      text.includes("<local-command-stdout>") ||
      text.trimStart().startsWith("[Request interrupted")
    ) {
      continue;
    }
    const cleaned = cleanSummary(text);
    if (cleaned === "") continue; // 清洗后为空（纯 XML 包裹等）不算有效发言
    out.push({ index, text: cleaned, timestamp: m.timestamp ?? null });
  }
  return out;
}

// ----------------------------------------------------------------------------
// 导出（Markdown 渲染 / JSONL 原样复制）
// ----------------------------------------------------------------------------

/** 把 ISO 时间戳简化为「YYYY-MM-DD HH:MM」（非法/缺失返回空串） */
function formatTsDisplay(iso?: string | null): string {
  if (!iso) return "";
  // ISO 时间戳为 ASCII，charCodeAt 取 'T'（索引 10）安全
  if (iso.length >= 16 && iso.charCodeAt(10) === 84 /* 'T' */) {
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return "";
}

/**
 * 工具摘要行（导出 Markdown 用）：input 不转储原文，只留可读摘要。
 * 语义对齐 Rust 的 tool_summary_line + 前端 toolSummary。
 */
function toolSummaryLine(name: string, input: unknown): string {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const get = (k: string): string =>
    typeof obj[k] === "string" ? (obj[k] as string) : "";
  // Windows/Linux 路径都按 / 或 \ 切，取末段做文件名（带盘符的 Windows 路径亦兼容）
  const leaf = (p: string): string => p.split(/[/\\]/).pop() ?? p;
  const clip = (s: string, n: number): string => {
    const chars = [...s];
    return chars.length > n ? chars.slice(0, n).join("") + "…" : s;
  };
  switch (name) {
    case "Bash":
      return `Bash · ${clip(get("command"), 120)}`;
    case "Read":
      return `Read · ${leaf(get("file_path"))}`;
    case "Write":
      return `Write · ${leaf(get("file_path"))}`;
    case "Edit":
      return `Edit · ${leaf(get("file_path"))}`;
    case "MultiEdit":
      return `MultiEdit · ${leaf(get("file_path"))}`;
    case "Glob":
      return `Glob · ${get("pattern")}`;
    case "Grep":
      return `Grep · ${get("pattern")}`;
    case "Agent":
      return `Agent · ${get("description")}`;
    case "TodoWrite":
      return "TodoWrite · 更新任务列表";
    default:
      return name;
  }
}

/** 单条消息渲染为 Markdown 小节（text 原样 / thinking 引用块 / tool_use 摘要 / tool_result 截断 200 / image 占位） */
function renderMessageMarkdown(msg: SessionMessage, toolNames: Map<string, string>): string {
  let out = "";
  const who =
    msg.kind === "user"
      ? "用户"
      : msg.model
        ? `Claude（${msg.model}）`
        : "Claude";
  const ts = formatTsDisplay(msg.timestamp);
  out += "\n## " + who;
  if (ts !== "") out += " · " + ts;
  out += "\n";
  for (const b of msg.blocks) {
    switch (b.kind) {
      case "text":
        if (b.text) {
          out += b.text + "\n";
        }
        break;
      // thinking 压缩为引用块，不展开（避免把冗长推理灌进导出文档）
      case "thinking":
        out += "> 💭 思考过程（省略）\n";
        break;
      case "tool_use": {
        const line = toolSummaryLine(b.name ?? "工具", b.input);
        out += "🔧 " + line + "\n";
        break;
      }
      case "tool_result": {
        // 用 tool_use_id 跨消息关联出工具名（与前端的 toolNames 同语义）
        const name = (b.toolUseId && toolNames.get(b.toolUseId)) ?? "工具";
        const text = b.text ?? "";
        const chars = [...text];
        // 截断 200 字符：tool_result 常含大段文件内容，全量转储会让导出文档失控
        const body = chars.length > 200 ? chars.slice(0, 200).join("") + "…" : text;
        out += `📄 ${name} 结果：${body.replace(/\n/g, " ")}\n`;
        break;
      }
      // 图片在 Markdown 里无法内联，记占位符（与查看器 image 分支一致）
      case "image":
        out += "🖼️ [图片]\n";
        break;
      default:
        break;
    }
  }
  return out;
}

/** 渲染整个会话为 Markdown（不走分页，全量渲染） */
export function renderSessionMarkdown(messages: SessionMessage[], title: string): string {
  // tool_use_id → 工具名（跨消息关联，tool_result 才能反查出工具名）
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_use" && b.toolUseId) {
        toolNames.set(b.toolUseId, b.name ?? "");
      }
    }
  }
  const t = title.trim();
  let out = `# ${t === "" ? "未命名会话" : t}\n> 导出自 CC Desktop · ${messages.length} 条消息\n`;
  for (const m of messages) {
    out += renderMessageMarkdown(m, toolNames);
  }
  return out;
}

/** 解析导出用的标题：复用会话元数据回退链，取不到或为空时回退「未命名会话」 */
function resolveExportTitle(filePath: string, sessionId: string): string {
  const ht = readHeadTail(filePath);
  if (ht) {
    const info = sessionMetaFromLite(ht.head, ht.tail, sessionId, 0);
    if (info && info.title.trim() !== "") return info.title;
  }
  return "未命名会话";
}

/**
 * 导出会话到指定路径。markdown = 渲染为文档（text 原样 / thinking 引用块 /
 * tool_use 摘要行不转储 input / tool_result 截断 200 / image 占位）；jsonl = 原文复制。
 * 返回写入的字节数。
 *
 * 防覆盖：Windows 文件系统大小写不敏感，仅靠 === 比较会被 `X.JSONL` 绕过，
 * 故用 ignore-case 比对，禁止导出到会话文件本身。
 */
export function exportSession(
  file: string,
  destPath: string,
  format: string,
  projectsDir: string = claudeProjectsDir(),
): number {
  const { path: p, sessionId } = resolveSessionFile(file, projectsDir);
  if (path.resolve(destPath).toLowerCase() === path.resolve(p).toLowerCase()) {
    throw new Error("导出目标不能是会话文件本身");
  }
  const content = fs.readFileSync(p, "utf8");
  let bytes: Buffer;
  if (format === "markdown") {
    const title = resolveExportTitle(p, sessionId);
    bytes = Buffer.from(renderSessionMarkdown(parseSessionMessages(content), title), "utf8");
  } else if (format === "jsonl") {
    bytes = Buffer.from(content, "utf8"); // 原样复制，保留 Claude Code 原始 jsonl
  } else {
    throw new Error(`不支持的导出格式：${format}`);
  }
  fs.writeFileSync(destPath, bytes);
  return bytes.length;
}

// ----------------------------------------------------------------------------
// 清除失效项目数据（~/.claude/projects/<mangled>，不可恢复）
// ----------------------------------------------------------------------------

/**
 * 单个失效项目数据目录的清除（独立成函数便于测试）。返回是否实际删除。
 * 三道防线，确保只删「精确同名、真实路径已消失」的那一个目录：
 *  1. mangle 结果必为 projects 的直接子目录（parent 校验，防结构不变量的未来破坏）；
 *  2. 真实项目路径当前仍存在（项目被还原/外接盘插回）→ 不是死数据，跳过；
 *  3. 目录名精确相等匹配（mangle 后逐字节相同），不是前缀/模糊/包含。
 * 与 Rust 不同，这里不做 canonicalize（Rust 也是词法 parent 判断）——mangle 已把
 * `:` `\` `/` `_` `.` 全替换为 `-`，`..` 也会变成 `--`，结构上不可能逃出 projectsDir。
 */
function purgeOneProjectData(projectsDir: string, projectPath: string): boolean {
  const mangled = mangleProjectPath(projectPath.trim());
  if (mangled === "") return false; // 空串无法定位，直接放弃
  const target = path.join(projectsDir, mangled);
  // 防线 1：target 必须是 projectsDir 的直接子目录
  if (path.resolve(path.dirname(target)) !== path.resolve(projectsDir)) return false;
  // 防线 2：真实项目路径仍存活 → 不算失效，跳过（不删）
  const real = projectPath.trim();
  if (fs.existsSync(real) && fs.statSync(real).isDirectory()) return false;
  // 防线 3：目标目录必须精确存在才删（精确同名，不是前缀/模糊）
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

/**
 * 清除失效项目在 Claude Code 项目目录下的会话数据（含全部 jsonl，不可恢复）。
 * 返回成功删除的目录数；不满足删除条件（目录不存在/项目还活着）的不计入也不报错。
 * projectsDir 缺省按 CLAUDE_CONFIG_DIR / ~/.claude/projects 定位，便于测试注入临时目录。
 */
export function purgeClaudeProjectData(
  paths: string[],
  projectsDir: string = claudeProjectsDir(),
): number {
  const dir = path.resolve(projectsDir);
  let removed = 0;
  for (const projectPath of paths) {
    if (purgeOneProjectData(dir, projectPath)) removed++;
  }
  return removed;
}

// ----------------------------------------------------------------------------
// 置顶会话清单（按 config 顺序实时解析元数据，不存快照）
// ----------------------------------------------------------------------------

/**
 * 按 config 的置顶清单顺序逐个**实时**解析元数据（不存快照），文件缺失的条目
 * 静默跳过不报错。每条带所属项目路径，前端置顶区可用项目名徽标 + 标题消歧。
 *
 * 与 Rust 的 pinned_meta_in 一致：先过滤「必须 .jsonl 结尾 + 落在 projectsDir 内
 * + 文件名是合法 uuid」，再 read_head_tail + session_meta_from_lite；任一失败即跳过。
 * 这里用 path.relative 做组件级前缀判断（pinned 是后端可信清单，无需 canonicalize
 * 防穿越；且与 sessions.ts 既有约定保持一致）。
 */
export function listPinnedSessions(
  projectsDir: string,
  pins: PinnedSession[],
): PinnedSessionInfo[] {
  const out: PinnedSessionInfo[] = [];
  for (const pin of pins) {
    const p = pin.file;
    const name = path.basename(p);
    if (!name.endsWith(".jsonl")) continue;
    // 组件级前缀判断（等价 Rust Path::starts_with，防 projectsX 误命中 projects）
    const rel = path.relative(projectsDir, p);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!isValidUuid(sessionId)) continue;
    const ht = readHeadTail(p);
    if (!ht) continue;
    const info = sessionMetaFromLite(ht.head, ht.tail, sessionId, Math.round(ht.mtime));
    if (!info) continue;
    out.push({
      sessionId: info.sessionId,
      title: info.title,
      summary: info.summary,
      lastModified: info.lastModified,
      file: p,
      projectPath: pin.projectPath,
    });
  }
  return out;
}
