// 全局使用统计（token 用量仪表盘 + 持久台账）
//
// 口径严格对齐 v2.0.0（Tauri/Rust 后端）：逐字段照搬 Rust 的 get_usage_stats /
// aggregate_stats_ledger / scan_file_usage / better_usage_row，以及 src/types.ts 的
// UsageStats 返回形状。所有「为什么不能这样」的坑都在对应函数里写清（见 better_usage_row
// 的「不能取首行」、buildUsageStats 的「每日会话数按最后活跃日」、localDateOf 的时区归属）。
//
// 设计：IO 层（文件读取 / 台账读写 / 目录枚举）与聚合层（纯函数）分离——
// 扫描/解析函数全部接收可注入的 FileSystemLike 与 tz 偏移，聚合与归属逻辑是纯函数，
// 方便单测（见 usage-stats.test.ts）。

import * as fsNode from "node:fs";
import * as path from "node:path";
import { isValidUuid, unmangleCandidates } from "./mangle";
import { claudeProjectsDir, resolveRootDir } from "./paths";
import { loadConfig } from "./config";

// ---------------------------------------------------------------------------
// 类型（与 v2.0.0 src/types.ts 的 UsageStats 逐字段一致；前端 StatsDialog 原样消费）
// ---------------------------------------------------------------------------

/** 排行条目（项目/模型）的单日用量，供前端按时间范围过滤 */
export interface RankDayUsage {
  /** YYYY-MM-DD */
  date: string;
  tokens: number;
  messages: number;
  /** 该日归属的会话数（最后活跃日口径）；模型行恒为 0 */
  sessions: number;
}

/** 单个模型的用量汇总（子代理消息也计入——独立落盘的 <会话>/subagents/*.jsonl 真实消耗） */
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
  /** 归属到该日的会话数：会话按「最后活跃日」归属，跨天会话只计一次 */
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

/**
 * 全局使用统计（仪表盘）。口径 = **历史累计消耗**：后端用量台账持久记录每个会话
 * 文件的贡献，已删除会话仍计入；excluded 项目不计（含其历史）；订阅版 jsonl 无
 * costUSD，故只统计 token。
 */
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

// ---------------------------------------------------------------------------
// 台账类型（数据根 stats-ledger.json）
// ---------------------------------------------------------------------------

/** 一条 assistant 消息归一后的 usage */
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 单文件扫描中间结果（聚合用 Map，写入台账时再转 Record） */
export interface FileUsage {
  messages: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** date -> [tokens, messages]（按本地时区归属） */
  perDay: Map<string, [number, number]>;
  /** model -> [tokens, messages] */
  perModel: Map<string, [number, number]>;
  /** date -> model -> [tokens, messages]（项目/模型排行按范围过滤用） */
  perDayModel: Map<string, Map<string, [number, number]>>;
}

/** 台账中的单个会话文件记录（该 jsonl 最后一次被扫描时的用量） */
export interface LedgerEntry {
  mtime: number;
  size: number;
  sessionId: string;
  /** 项目 mangled 目录名（文件删除后仍能反解候选路径判断是否被排除） */
  projectDir: string;
  projectName: string;
  projectPath: string;
  messages: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** date -> [tokens, messages]（按记录时的本地时区归属） */
  perDay: Record<string, [number, number]>;
  /** model -> [tokens, messages] */
  perModel: Record<string, [number, number]>;
  /** date -> model -> [tokens, messages]（项目/模型排行按范围过滤用） */
  perDayModel: Record<string, Record<string, [number, number]>>;
}

/** 用量台账（数据根 stats-ledger.json） */
export interface StatsLedger {
  /** 台账结构版本：不一致（含旧文件缺字段 → 0）则现存文件全部重扫一次 */
  version: number;
  /** 记录时的时区偏移（分钟）：per_day 与时区相关，变化则现存文件全部重扫 */
  tzOffsetMinutes: number;
  /** key = 会话文件绝对路径 */
  files: Record<string, LedgerEntry>;
}

/**
 * 台账口径版本：磁盘上 version 更小的台账口径不同（v2 前缺 per_day_model、
 * v3 前漏扫子代理文件且 message.id 误取占位行把整条消息记成 0），须全量重扫。
 */
export const LEDGER_VERSION = 3;

/** 占位消息模型名：Claude Code 本地生成的打断应答/API 报错回显，usage 恒 0 */
const SYNTHETIC_MODEL = "<synthetic>";

// ---------------------------------------------------------------------------
// 可注入的文件系统（IO 与聚合分离，便于单测）
// ---------------------------------------------------------------------------

export interface FsStats {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FileSystemLike {
  readFileSync(p: string, encoding: "utf8"): string;
  /** 缺失返回 null（对齐 Rust 的 metadata().ok()） */
  statSync(p: string): FsStats | null;
  readdirSync(p: string): string[];
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
}

/** 默认实现：直接包 node:fs，stat/readdir 失败时返回安全默认值 */
export const nodeFs: FileSystemLike = {
  readFileSync: (p) => fsNode.readFileSync(p, "utf8"),
  statSync: (p) => {
    try {
      return fsNode.statSync(p);
    } catch {
      return null;
    }
  },
  readdirSync: (p) => {
    try {
      return fsNode.readdirSync(p);
    } catch {
      return [];
    }
  },
  writeFileSync: (p, d) => fsNode.writeFileSync(p, d, "utf8"),
  renameSync: (from, to) => {
    try {
      fsNode.renameSync(from, to);
    } catch {
      /* 原子替换失败不阻塞统计 */
    }
  },
};

// ---------------------------------------------------------------------------
// 日期 / 时间戳：UTC → 本地时区日期（对齐 Rust 的 iso_to_epoch_ms / civil_from_days）
// ---------------------------------------------------------------------------

/** 截断除法（对齐 Rust 整数 `/` 向零截断，负年份时 floor 会得到错误结果） */
function truncDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** civil 日期（年, 月, 日）→ 自 1970-01-01 起的天数（对齐 Rust days_from_civil） */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = truncDiv(yy >= 0 ? yy : yy - 399, 400);
  const yoe = yy - era * 400;
  const doy = truncDiv(153 * m - 457, 5) + d - 1;
  const doe = yoe * 365 + truncDiv(yoe, 4) - truncDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 自 1970-01-01 起的天数 → civil 日期（对齐 Rust civil_from_days） */
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = truncDiv(zz >= 0 ? zz : zz - 146096, 146097);
  const doe = zz - era * 146097;
  const yoe = truncDiv(
    doe - truncDiv(doe, 1460) + truncDiv(doe, 36524) - truncDiv(doe, 146096),
    365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + truncDiv(yoe, 4) - truncDiv(yoe, 100));
  const mp = truncDiv(5 * doy + 2, 153);
  const d = doy - truncDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

/** ISO-8601 UTC 时间戳（Claude Code jsonl 固定格式）→ epoch 毫秒；解析失败返回 null */
export function isoToEpochMs(iso: string): number | null {
  // YYYY-MM-DDTHH:MM:SS(.mmm)?Z? —— Claude Code 的时间是 UTC 带 Z；只取位置不做时区换算
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(iso);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const h = +m[4];
  const mi = +m[5];
  const s = +m[6];
  const ms = m[7] ? Math.round(+`0.${m[7]}` * 1000) : 0;
  const days = daysFromCivil(y, mo, d);
  return (days * 86400 + h * 3600 + mi * 60 + s) * 1000 + ms;
}

/**
 * UTC epoch 毫秒 + 时区偏移（分钟，东八区 = 480）→ 本地日期 YYYY-MM-DD。
 * **为什么按本地时区归属**：timestamp 是 UTC，直接截日期会让单日统计错位一个时区
 * （如东八区晚间高峰归到错误的日期）。用 div_euclid（向负无穷取整）保证跨零点正确。
 */
export function localDateOf(epochMs: number, tzOffsetMinutes: number): string {
  const days = Math.floor((epochMs + tzOffsetMinutes * 60_000) / 86_400_000);
  const [y, m, d] = civilFromDays(days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

// ---------------------------------------------------------------------------
// 单文件 usage 解析 / 代表行取舍
// ---------------------------------------------------------------------------

/** 解析 jsonl 行的 usage（兼容新旧两种格式：顶层 input_tokens 或嵌套 {input,cache_read,...}） */
function parseUsage(v: unknown): Usage | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const num = (k: string): number => {
    const x = obj[k];
    return typeof x === "number" && Number.isFinite(x) ? x : 0;
  };
  let inputTokens: number;
  let cacheReadInputTokens: number;
  let cacheCreationInputTokens: number;
  const it = obj["input_tokens"];
  if (typeof it === "number") {
    inputTokens = it;
    cacheReadInputTokens = num("cache_read_input_tokens");
    cacheCreationInputTokens = num("cache_creation_input_tokens");
  } else if (it && typeof it === "object") {
    // 新格式：usage.input_tokens 是个对象 {input, cache_read, cache_creation}
    const o = it as Record<string, unknown>;
    const read = (k: string): number => {
      const x = o[k];
      return typeof x === "number" && Number.isFinite(x) ? x : 0;
    };
    inputTokens = read("input");
    // 嵌套字段缺省时回退到顶层（部分版本两层都有），取较大者避免漏算
    cacheReadInputTokens = Math.max(read("cache_read"), num("cache_read_input_tokens"));
    cacheCreationInputTokens = Math.max(read("cache_creation"), num("cache_creation_input_tokens"));
  } else {
    inputTokens = num("input_tokens");
    cacheReadInputTokens = num("cache_read_input_tokens");
    cacheCreationInputTokens = num("cache_creation_input_tokens");
  }
  return {
    inputTokens,
    outputTokens: num("output_tokens"),
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}

/** 一次响应流式写入产生的候选快照（同 message.id 多行之一） */
export interface UsageRow {
  /** 带 stop_reason——流式收尾行，usage 是这次响应的最终值 */
  finalRow: boolean;
  tokens: number;
  usage: Usage;
  model: string;
  /** 本地时区日期（YYYY-MM-DD） */
  date: string | null;
}

/**
 * 新行是否该取代旧行成为 message.id 的代表行：**收尾行优先**（带 stop_reason 的那条），
 * 同为收尾行或同为中间行时取 token 更大者。
 *
 * **为什么不能取首行**：部分写入次序下同一响应的前几行 usage 全 0（只有 thinking/text
 * 块、没有 stop_reason），真实用量在收尾行上——取首行会把整条消息记成 0
 * （实测有会话因此只统计到真实值的 1.3%）。也**不能逐行相加**：成倍虚高。
 */
export function betterUsageRow(candidate: UsageRow, current: UsageRow): boolean {
  if (candidate.finalRow !== current.finalRow) {
    return candidate.finalRow;
  }
  return candidate.tokens > current.tokens;
}

/**
 * 流式扫描一个 jsonl 的用量（核心逻辑）。按 message.id 取代表行（见 better_usage_row）；
 * 日期按本地时区归属。只提取 assistant 行的 usage/timestamp/model，不构造消息。
 */
export function scanFileUsage(content: string, tzOffsetMinutes: number): FileUsage {
  // 先按 id 收敛出代表行，读完再聚合（取首行的错误只能靠「读完才知道哪行是收尾行」避免）
  const rows = new Map<string, UsageRow>();
  // 无 message.id 的行无从去重（罕见），逐条计入
  const anonymous: UsageRow[] = [];

  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue; // 坏行忽略
    }
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    if (obj["type"] !== "assistant") continue;
    const msg = obj["message"] as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;
    const usage = parseUsage(msg["usage"]);
    if (!usage) continue;
    // model 优先取 message.model，其次顶层 model，都没有则 "unknown"
    let model =
      typeof msg["model"] === "string"
        ? (msg["model"] as string)
        : typeof obj["model"] === "string"
          ? (obj["model"] as string)
          : "unknown";
    // <synthetic> 是 Claude Code 本地生成的占位助手消息（打断应答/API 报错回显），
    // usage 恒为 0：跳过，不进模型分布与消息计数
    if (model === SYNTHETIC_MODEL) continue;
    const date =
      typeof obj["timestamp"] === "string"
        ? (() => {
            const ms = isoToEpochMs(obj["timestamp"] as string);
            return ms === null ? null : localDateOf(ms, tzOffsetMinutes);
          })()
        : null;
    const row: UsageRow = {
      finalRow: typeof msg["stop_reason"] === "string",
      tokens:
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens,
      usage,
      model,
      date,
    };
    const id = typeof msg["id"] === "string" ? (msg["id"] as string) : null;
    if (id) {
      const old = rows.get(id);
      if (!old || betterUsageRow(row, old)) rows.set(id, row);
    } else {
      anonymous.push(row);
    }
  }

  const u: FileUsage = {
    messages: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    perDay: new Map(),
    perModel: new Map(),
    perDayModel: new Map(),
  };
  for (const row of [...rows.values(), ...anonymous]) {
    u.messages += 1;
    u.tokens += row.tokens;
    u.inputTokens += row.usage.inputTokens;
    u.outputTokens += row.usage.outputTokens;
    u.cacheReadTokens += row.usage.cacheReadInputTokens;
    u.cacheCreationTokens += row.usage.cacheCreationInputTokens;
    if (row.date) {
      const e = inc2(u.perDay, row.date);
      e[0] += row.tokens;
      e[1] += 1;
      const de = incMap(u.perDayModel, row.date);
      const dem = inc2(de, row.model);
      dem[0] += row.tokens;
      dem[1] += 1;
    }
    const m = inc2(u.perModel, row.model);
    m[0] += row.tokens;
    m[1] += 1;
  }
  return u;
}

function inc2(map: Map<string, [number, number]>, k: string): [number, number] {
  let e = map.get(k);
  if (!e) {
    e = [0, 0];
    map.set(k, e);
  }
  return e;
}

function incMap(map: Map<string, Map<string, [number, number]>>, k: string): Map<string, [number, number]> {
  let e = map.get(k);
  if (!e) {
    e = new Map();
    map.set(k, e);
  }
  return e;
}

// ---------------------------------------------------------------------------
// 目录枚举（固定深度、不递归，对齐 Claude Code 落盘布局）
// ---------------------------------------------------------------------------

/**
 * 枚举一个项目目录下的用量 jsonl（固定深度、不递归）：
 *   <项目>/*.jsonl                                      主会话
 *   <项目>/<会话 uuid>/subagents/*.jsonl                Task/Agent 子代理
 *   <项目>/<会话 uuid>/subagents/workflows/wf_<ID>/*.jsonl  Workflow 子代理
 * 返回 { path, sessionId }。子代理文件**归属其父会话 id**——它们不是独立会话，
 * 拿 agent-xxx 当会话 id 会让会话数随子代理数量虚增。只认 uuid 命名的目录，
 * 项目目录下的 memory/ 等无关目录自然跳过。
 *
 * 漏掉 subagents 一层会让子代理（很吃 token）的消耗整块消失——实测某模型因此
 * 只统计到真实值的一半。
 */
export function usageJsonlFiles(
  dir: string,
  fs: FileSystemLike = nodeFs,
): Array<{ path: string; sessionId: string }> {
  const out: Array<{ path: string; sessionId: string }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (!st) continue;
    if (st.isFile()) {
      if (name.endsWith(".jsonl")) {
        const sid = name.slice(0, -".jsonl".length);
        if (isValidUuid(sid)) out.push({ path: p, sessionId: sid });
      }
      continue;
    }
    if (!isValidUuid(name)) continue; // 只认 uuid 目录，memory/tool-results 等自然跳过
    // 子代理目录：直接子层所有 .jsonl 收下（不递归、不按文件名过滤）
    pushJsonlFilesIn(path.join(p, "subagents"), name, out, fs);
    // Workflow 子代理比普通子代理多嵌套一层 workflows/wf_<ID>/
    const workflowsDir = path.join(p, "subagents", "workflows");
    let wfEntries: string[];
    try {
      wfEntries = fs.readdirSync(workflowsDir);
    } catch {
      wfEntries = [];
    }
    for (const w of wfEntries) {
      const wp = path.join(workflowsDir, w);
      const wst = fs.statSync(wp);
      if (wst && wst.isDirectory()) {
        pushJsonlFilesIn(wp, name, out, fs);
      }
    }
  }
  return out;
}

/** 目录下直接子层的 .jsonl 全部收下（不递归）。不按文件名过滤：子代理目录里的
 *  journal.jsonl 没有 assistant 行，扫描时天然跳过。 */
function pushJsonlFilesIn(
  dir: string,
  sessionId: string,
  out: Array<{ path: string; sessionId: string }>,
  fs: FileSystemLike,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st && st.isFile() && name.endsWith(".jsonl")) {
      out.push({ path: p, sessionId });
    }
  }
}

// ---------------------------------------------------------------------------
// 台账读写（数据根 stats-ledger.json）
// ---------------------------------------------------------------------------

export function ledgerPath(root: string): string {
  return path.join(root, "stats-ledger.json");
}

function defaultLedger(): StatsLedger {
  return { version: 0, tzOffsetMinutes: 0, files: {} };
}

/** 读取台账：文件缺失/损坏时返回空台账（丢失的只是已删会话历史，现存文件会重建） */
export function loadLedger(root: string, fs: FileSystemLike = nodeFs): StatsLedger {
  try {
    const s = fs.readFileSync(ledgerPath(root), "utf8");
    const parsed = JSON.parse(s) as Partial<StatsLedger> | null;
    if (!parsed || typeof parsed !== "object") return defaultLedger();
    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      tzOffsetMinutes: typeof parsed.tzOffsetMinutes === "number" ? parsed.tzOffsetMinutes : 0,
      files: parsed.files && typeof parsed.files === "object" ? (parsed.files as Record<string, LedgerEntry>) : {},
    };
  } catch {
    return defaultLedger();
  }
}

/** 写临时文件 → 原子替换（台账可从现存文件重建，不做 .bak） */
export function saveLedger(root: string, ledger: StatsLedger, fs: FileSystemLike = nodeFs): void {
  const p = ledgerPath(root);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger));
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// 内存缓存（与台账双层命中：弹窗反复打开时只有变更过的 jsonl 需要重扫）
// ---------------------------------------------------------------------------

const USAGE_CACHE = new Map<string, { mtime: number; size: number; tz: number; usage: FileUsage }>();

/** 清空内存用量缓存（仅单测用） */
export function clearUsageCache(): void {
  USAGE_CACHE.clear();
}

function scanFileFromFile(p: string, tz: number, fs: FileSystemLike, st: FsStats): FileUsage | null {
  // 内存缓存命中（mtime+size+tz 三层一致）→ 跳过文件读取（与台账共同构成双层命中）
  const cached = USAGE_CACHE.get(p);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size && cached.tz === tz) {
    return cached.usage;
  }
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const u = scanFileUsage(content, tz);
  USAGE_CACHE.set(p, { mtime: st.mtimeMs, size: st.size, tz, usage: u });
  return u;
}

// ---------------------------------------------------------------------------
// 聚合（纯函数）：台账条目 → UsageStats
// ---------------------------------------------------------------------------

export function emptyUsageStats(): UsageStats {
  return {
    sessions: 0,
    messages: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    earliest: null,
    latest: null,
    perDay: [],
    perProject: [],
    perModel: [],
  };
}

/**
 * 汇总全部台账条目（含已删除会话）为 UsageStats。纯函数：不碰文件、不碰时钟。
 *
 * **每日会话数按「最后活跃日」归属**——跨天会话只计一次：每个会话只在它的 per_day
 * 最末一天（=最后活跃日）计入 sessions。理由：若按「当天活跃」逐日计入，跨天会话
 * 会被重复累加，出现「全部会话数 < 近30天会话数」的反直觉结果；而按最后活跃日归属
 * 后，任意日期窗口内每日 sessions 累加恰好等于窗口内去重会话数。
 *
 * 注意：excluded 过滤在 aggregateStatsLedger 里对 ledger.files 做 retain 完成，
 * 这里只负责纯聚合（传入的 entries 已是过滤后的）。
 */
export function buildUsageStats(entries: LedgerEntry[]): UsageStats {
  const stats = emptyUsageStats();

  // 已计会话（按 session_id 去重，不随子代理/workflow 文件数虚增）
  const seenSessions = new Set<string>();

  // 每日会话数（date -> sessionId 集合）：会话归属其最后活跃日，跨天只计一次
  const daySessions = new Map<string, Set<string>>();
  // 当日活跃会话（date -> sessionId 集合）：跨天会话在每个活跃日都计（tooltip 用）
  const dayActive = new Map<string, Set<string>>();
  // 每日 token/消息总量
  const dayMap = new Map<string, [number, number]>();
  // 模型总量
  const modelMap = new Map<string, [number, number]>();
  // 模型按天明细（model -> date -> [tokens, messages]），趋势图堆叠段用
  const modelDays = new Map<string, Map<string, [number, number]>>();

  // 项目聚合（按真实路径去重；sessions 按 session_id 去重，子代理/workflow 文件
  // 的 session_id 记的是父会话，按文件计数会把一个会话算成好几个）
  interface ProjectAgg {
    name: string;
    ppath: string;
    sessions: number;
    sessionIds: Set<string>;
    messages: number;
    tokens: number;
    days: Map<string, [number, number]>;
    daySessions: Map<string, Set<string>>;
  }
  const projectMap = new Map<string, ProjectAgg>();

  for (const e of entries) {
    if (!seenSessions.has(e.sessionId)) {
      seenSessions.add(e.sessionId);
      stats.sessions += 1;
    }
    stats.messages += e.messages;
    stats.tokens += e.tokens;
    stats.inputTokens += e.inputTokens;
    stats.outputTokens += e.outputTokens;
    stats.cacheReadTokens += e.cacheReadTokens;
    stats.cacheCreationTokens += e.cacheCreationTokens;

    // per_day：token/消息按天累加；会话「最后活跃日」口径记一次
    const dayKeys = Object.keys(e.perDay).sort();
    for (const d of dayKeys) {
      const [tk, ms] = e.perDay[d];
      const dm = inc2(dayMap, d);
      dm[0] += tk;
      dm[1] += ms;
      addToSet(dayActive, d, e.sessionId);
    }
    // 最后活跃日 = per_day 的最大日期（YYYY-MM-DD 字典序即时间序）
    const lastDay = dayKeys.length > 0 ? dayKeys[dayKeys.length - 1] : null;
    if (lastDay) addToSet(daySessions, lastDay, e.sessionId);

    for (const [mo, [tk, ms]] of Object.entries(e.perModel)) {
      const mm = inc2(modelMap, mo);
      mm[0] += tk;
      mm[1] += ms;
    }
    for (const [d, models] of Object.entries(e.perDayModel)) {
      for (const [mo, [tk, ms]] of Object.entries(models)) {
        const md = incMap(modelDays, mo);
        const e2 = inc2(md, d);
        e2[0] += tk;
        e2[1] += ms;
      }
    }

    const pa = projectMap.get(e.projectPath);
    if (!pa) {
      projectMap.set(e.projectPath, {
        name: e.projectName,
        ppath: e.projectPath,
        sessions: 0,
        sessionIds: new Set(),
        messages: 0,
        tokens: 0,
        days: new Map(),
        daySessions: new Map(),
      });
    }
    const pag = projectMap.get(e.projectPath)!;
    if (!pag.sessionIds.has(e.sessionId)) {
      pag.sessionIds.add(e.sessionId);
      pag.sessions += 1;
    }
    pag.messages += e.messages;
    pag.tokens += e.tokens;
    for (const d of dayKeys) {
      const [tk, ms] = e.perDay[d];
      const de = inc2(pag.days, d);
      de[0] += tk;
      de[1] += ms;
    }
    if (lastDay) addToSet(pag.daySessions, lastDay, e.sessionId);
  }

  const dayKeysAll = [...dayMap.keys()].sort();
  stats.earliest = dayKeysAll.length > 0 ? dayKeysAll[0] : null;
  stats.latest = dayKeysAll.length > 0 ? dayKeysAll[dayKeysAll.length - 1] : null;

  stats.perDay = dayKeysAll.map((date) => ({
    date,
    tokens: dayMap.get(date)![0],
    messages: dayMap.get(date)![1],
    sessions: daySessions.get(date)?.size ?? 0,
    activeSessions: dayActive.get(date)?.size ?? 0,
  }));

  // 模型按 token 倒序；聚合出口再滤一次 <synthetic>（兜底老台账已存条目）
  stats.perModel = [...modelMap.entries()]
    .filter(([model]) => model !== SYNTHETIC_MODEL)
    .map(([model, [tk, ms]]) => ({
      model,
      tokens: tk,
      messages: ms,
      perDay: [...(modelDays.get(model) ?? new Map()).entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([date, [t, m]]) => ({ date, tokens: t, messages: m, sessions: 0 })),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  stats.perProject = [...projectMap.values()]
    .map((pa) => ({
      name: pa.name,
      path: pa.ppath,
      sessions: pa.sessions,
      messages: pa.messages,
      tokens: pa.tokens,
      perDay: [...pa.days.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([date, [tk, ms]]) => ({
          date,
          tokens: tk,
          messages: ms,
          sessions: pa.daySessions.get(date)?.size ?? 0,
        })),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return stats;
}

function addToSet(map: Map<string, Set<string>>, k: string, v: string): void {
  let s = map.get(k);
  if (!s) {
    s = new Set();
    map.set(k, s);
  }
  s.add(v);
}

// ---------------------------------------------------------------------------
// 聚合（IO 层）：扫描现存文件 + 台账重扫/命中 + 排除 → UsageStats
// ---------------------------------------------------------------------------

export interface ProjectRef {
  /** 显示名 */
  name: string;
  /** 真实路径 */
  path: string;
  /** mangled 项目目录（<projectsDir>/<mangled>） */
  dir: string;
}

/**
 * 汇总所有项目的用量统计。台账驱动：现存且未变的文件复用上次记录，变更的重扫覆盖，
 * 消失的保留历史——统计 = 全部台账条目之和（含已删除会话）。
 *
 * - 时区变化：per_day 与时区相关，现存文件需全部重扫（已删条目保留旧时区归属）
 * - LEDGER_VERSION 不一致（旧文件缺 per_day_model）：同理全部重扫一次
 * - 现存文件 mtime+size 未变（且时区一致、版本一致）→ 台账命中，跳过重扫
 *   （外加内存 USAGE_CACHE 双层命中）
 */
export function aggregateStatsLedger(
  projects: ProjectRef[],
  excluded: string[],
  tzOffsetMinutes: number,
  ledger: StatsLedger,
  fs: FileSystemLike = nodeFs,
): UsageStats {
  // 时区或版本变化 → 现存文件全部重扫
  const tzChanged = ledger.tzOffsetMinutes !== tzOffsetMinutes;
  ledger.tzOffsetMinutes = tzOffsetMinutes;
  const fullRescan = tzChanged || ledger.version !== LEDGER_VERSION;
  ledger.version = LEDGER_VERSION;

  // ---- 刷新现存文件 ----
  for (const proj of projects) {
    const projectDir = path.basename(proj.dir);
    for (const { path: p, sessionId } of usageJsonlFiles(proj.dir, fs)) {
      const key = p;
      const st = fs.statSync(p);
      const mtime = st?.mtimeMs ?? 0;
      const size = st?.size ?? 0;
      // 命中台账且未变更（且时区未变、版本一致）→ 无需重扫；项目显示名/路径随扫描刷新
      if (!fullRescan) {
        const entry = ledger.files[key];
        if (entry && entry.mtime === mtime && entry.size === size) {
          entry.projectName = proj.name;
          entry.projectPath = proj.path;
          continue;
        }
      }
      const u = st ? scanFileFromFile(p, tzOffsetMinutes, fs, st) : null;
      if (!u || u.messages === 0) continue; // 无任何 token 数据的会话不占统计口径
      // **per_day 与 per_day_model 在同一个 if 块里一起写**——漏写其一会让老台账
      // 缺字段，触发全量重扫（v2 前缺 per_day_model 的教训）
      ledger.files[key] = {
        mtime,
        size,
        sessionId,
        projectDir,
        projectName: proj.name,
        projectPath: proj.path,
        messages: u.messages,
        tokens: u.tokens,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        perDay: mapToRecord(u.perDay),
        perModel: mapToRecord(u.perModel),
        perDayModel: nestedMapToRecord(u.perDayModel),
      };
    }
  }

  // ---- 被排除项目的历史一并移除（与现存口径一致：排除即整体不计）----
  ledger.files = Object.fromEntries(
    Object.entries(ledger.files).filter(([, e]) => {
      const candidates = unmangleCandidates(e.projectDir);
      return !candidates.some((c) => excluded.some((x) => x.toLowerCase() === c.toLowerCase()));
    }),
  );

  // ---- 聚合全部台账条目（含已删除会话）----
  return buildUsageStats(Object.values(ledger.files));
}

function mapToRecord(map: Map<string, [number, number]>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [k, v] of map) out[k] = [v[0], v[1]];
  return out;
}

function nestedMapToRecord(
  map: Map<string, Map<string, [number, number]>>,
): Record<string, Record<string, [number, number]>> {
  const out: Record<string, Record<string, [number, number]>> = {};
  for (const [d, inner] of map) out[d] = mapToRecord(inner);
  return out;
}

// ---------------------------------------------------------------------------
// 顶层入口（真实 IO；主代理负责 IPC 接线时调用）
// ---------------------------------------------------------------------------

export interface GetUsageStatsOptions {
  /** Claude Code 项目目录（会话 jsonl 所在）；默认按 CLAUDE_CONFIG_DIR / ~/.claude/projects 定位 */
  projectsDir?: string;
  /** 数据根目录（stats-ledger.json 所在）；默认按便携/安装模式解析 */
  dataRoot?: string;
  /** 被排除的项目路径清单；默认读 config.json 的 excluded */
  excluded?: string[];
  /** 本地时区偏移（分钟，东八区 = 480）；默认 0（前端应传入真实偏移） */
  tzOffsetMinutes?: number;
  /** 注入文件系统（单测用） */
  fs?: FileSystemLike;
  /** 平台 / 环境变量 / 可执行路径（单测或自定义场景用） */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

/**
 * 全局使用统计（仪表盘）入口。口径：excluded 项目不统计；已删除项目仍统计（台账保留）；
 * 会话文件删除后其历史用量保留在台账中（统计 = 历史累计消耗）。
 *
 * 主代理接线时：前端传本地时区偏移（tzOffsetMinutes），本函数定位项目目录与数据根、
 * 读取 excluded、跑台账聚合并把台账落盘；并发由调用方串行化（参考 config 的写串行）。
 */
export async function getUsageStats(opts: GetUsageStatsOptions = {}): Promise<UsageStats> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const projectsDir = opts.projectsDir ?? claudeProjectsDir(platform, env);
  const dataRoot = opts.dataRoot ?? resolveRootDir(execPath, platform, env).root;
  const excluded = opts.excluded ?? loadConfig(dataRoot).excluded;
  const tz = opts.tzOffsetMinutes ?? 0;
  const fs = opts.fs ?? nodeFs;

  const projects: ProjectRef[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return emptyUsageStats();
  }
  for (const mangled of entries) {
    const d = path.join(projectsDir, mangled);
    const st = fs.statSync(d);
    if (!st || !st.isDirectory()) continue;
    const candidates = unmangleCandidates(mangled, platform);
    const real = candidates.find((c) => {
      const cs = fs.statSync(c);
      return cs ? cs.isDirectory() : false;
    });
    // 与列表口径一致：任一候选路径命中排除清单即不统计
    const isExcluded = candidates.some((c) => excluded.some((x) => x.toLowerCase() === c.toLowerCase()));
    if (isExcluded) continue;
    const name = real ? path.basename(real) : mangled;
    const p = real ?? candidates[0] ?? mangled;
    projects.push({ name, path: p, dir: d });
  }

  const ledger = loadLedger(dataRoot, fs);
  const stats = aggregateStatsLedger(projects, excluded, tz, ledger, fs);
  saveLedger(dataRoot, ledger, fs);
  return stats;
}
