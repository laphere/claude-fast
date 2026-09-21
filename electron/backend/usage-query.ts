// Coding Plan 套餐用量查询（移植自 v2.0.0 usage_query.rs）。
//
// 五家厂商适配器（Kimi / 智谱 GLM / MiniMax / ZenMux / OpenCode Go）。凭据从供应商
// 配置的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 现场取，base_url 命中即查，
// 无需 per-provider 配置。解析函数为纯函数、fixture 可测；HTTP 用 Node 内置 fetch。
//
// 401/403 统一报「认证失败」；millis→ISO8601 为纯算法实现（不引 chrono 等价物）。
const QUERY_TIMEOUT_MS = 15_000;

/** 单个用量窗口（如 5 小时 / 每周）。utilization 为 0-100 的已用百分比。 */
export interface UsageTier {
  /** five_hour / weekly_limit / monthly */
  name: string;
  utilization: number;
  /** ISO 8601；null = 不展示倒计时 */
  resetsAt: string | null;
  usedValueUsd: number | null;
  maxValueUsd: number | null;
}

/** 查询结果。supported=false 表示该供应商不在已知厂商列表（前端静默不显示）。 */
export interface UsageResult {
  success: boolean;
  supported: boolean;
  vendor: string | null;
  data: UsageTier[];
  error: string | null;
}

function unsupported(): UsageResult {
  return { success: false, supported: false, vendor: null, data: [], error: null };
}
function ok(vendor: string, tiers: UsageTier[]): UsageResult {
  return { success: true, supported: true, vendor, data: tiers, error: null };
}
function err(vendor: string, msg: string): UsageResult {
  return { success: false, supported: true, vendor, data: [], error: msg };
}

// ---------------- 小工具：JSON 导航 ----------------

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asArr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
/** 解析为数字：兼容数字与字符串格式（如 100 和 "100"） */
function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------- 厂商探测 ----------------

/**
 * 探测 base_url 属于哪家 Coding Plan 厂商（小写比较）。命中即用其密钥查询；
 * 普通中转（不带 /coding 等特征域名）不命中，返回 null（前端静默）。
 */
export function detectVendor(baseUrl: string): string | null {
  const url = baseUrl.toLowerCase();
  if (url.includes("api.kimi.com/coding")) return "kimi";
  if (url.includes("bigmodel.cn") || url.includes("api.z.ai")) return "zhipu";
  if (url.includes("api.minimaxi.com") || url.includes("api.minimax.io")) return "minimax";
  if (url.includes("zenmux")) return "zenmux";
  if (url.includes("opencode.ai/zen/go")) return "opencode_go";
  return null;
}

// ---------------- 时间 ----------------

/** 毫秒时间戳 → UTC ISO 8601（YYYY-MM-DDTHH:MM:SS.mmmZ）。纯算法（Hinnant civil-from-days），不引入 chrono 依赖 */
export function millisToIso8601(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const secs = Math.floor(ms / 1000);
  const millisPart = Math.floor(ms % 1000);
  const days = Math.floor(secs / 86400);
  const sod = ((secs % 86400) + 86400) % 86400;
  const h = Math.floor(sod / 3600);
  const m = Math.floor((sod % 3600) / 60);
  const s = sod % 60;

  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = ((z % 146097) + 146097) % 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;

  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(millisPart, 3)}Z`;
}

/**
 * 从 JSON 值提取重置时间：字符串直接返回（ISO 8601）；
 * 数字自动判断秒/毫秒（< 1e12 为秒）并转 ISO；0/负值（占位）返回 null。
 */
export function extractResetTime(value: unknown): string | null {
  if (typeof value === "string") return value;
  const n = asNum(value);
  if (n !== null) {
    if (n <= 0) return null;
    const ms = n < 1_000_000_000_000 ? n * 1000 : n;
    return millisToIso8601(ms);
  }
  return null;
}

/** limit/remaining 差值 → 已用百分比 tier */
export function usedRatioTier(
  name: string,
  limit: number,
  remaining: number,
  resetsAt: string | null,
): UsageTier {
  const used = Math.max(0, limit - remaining);
  const utilization = limit > 0 ? (used / limit) * 100 : 0;
  return { name, utilization, resetsAt, usedValueUsd: null, maxValueUsd: null };
}

// ---------------- 各厂商响应解析 ----------------

/** Kimi：limits[].detail{limit,remaining,resetTime} → 5 小时窗口；usage{...} → 周窗口 */
export function parseKimiTiers(body: unknown): UsageTier[] {
  const tiers: UsageTier[] = [];
  const limits = asArr(asObj(body)?.limits);
  if (limits) {
    for (const item of limits) {
      const detail = asObj(asObj(item)?.detail);
      if (!detail) continue;
      const limit = asNum(detail.limit) ?? 1.0;
      const remaining = asNum(detail.remaining) ?? 0.0;
      const resetsAt = extractResetTime(detail.resetTime);
      tiers.push(usedRatioTier("five_hour", limit, remaining, resetsAt));
    }
  }
  const usage = asObj(asObj(body)?.usage);
  if (usage) {
    const limit = asNum(usage.limit) ?? 1.0;
    const remaining = asNum(usage.remaining) ?? 0.0;
    const resetsAt = extractResetTime(usage.resetTime);
    tiers.push(usedRatioTier("weekly_limit", limit, remaining, resetsAt));
  }
  return tiers;
}

type ZhipuEntry = [number | null, number, string | null];

/**
 * 智谱 TOKENS_LIMIT/CREDIT_LIMIT 条目按 unit 字段分类：unit:3 → 5 小时，unit:6 → 每周。
 * unit 缺失/不识别时走兜底启发式：无 nextResetTime 的条目优先归 five_hour（5h 桶在
 * 0% 时可能无 reset），其余按 reset 升序依次填空槽。老套餐只回 1 条自然降级为仅 5h。
 */
export function parseZhipuTokenTiers(data: unknown): UsageTier[] {
  let fiveHour: ZhipuEntry | null = null;
  let weekly: ZhipuEntry | null = null;
  const unclassified: ZhipuEntry[] = [];

  const limits = asArr(asObj(data)?.limits);
  if (limits) {
    for (const item of limits) {
      const o = asObj(item);
      if (!o) continue;
      const typeStr = asStr(o.type) ?? "";
      const lower = typeStr.toLowerCase();
      if (lower !== "tokens_limit" && lower !== "credit_limit") continue;
      const percentage = asNum(o.percentage) ?? 0.0;
      const resetMs = asNum(o.nextResetTime);
      const resetIso = resetMs !== null ? millisToIso8601(resetMs) : null;
      const entry: ZhipuEntry = [resetMs, percentage, resetIso];
      const unit = asNum(o.unit);
      if (unit === 3 && fiveHour === null) fiveHour = entry;
      else if (unit === 6 && weekly === null) weekly = entry;
      else unclassified.push(entry);
    }
  }

  // 无 reset 的条目优先（升序兜底时占 five_hour），其余按 reset 升序
  unclassified.sort((a, b) => {
    const ha = a[0] !== null ? 1 : 0;
    const hb = b[0] !== null ? 1 : 0;
    if (ha !== hb) return ha - hb;
    return (a[0] ?? 0) - (b[0] ?? 0);
  });
  for (const e of unclassified) {
    if (fiveHour === null) fiveHour = e;
    else if (weekly === null) weekly = e;
  }

  const tiers: UsageTier[] = [];
  for (const [name, slot] of [
    ["five_hour", fiveHour],
    ["weekly_limit", weekly],
  ] as const) {
    if (slot) {
      tiers.push({
        name,
        utilization: slot[1],
        resetsAt: slot[2],
        usedValueUsd: null,
        maxValueUsd: null,
      });
    }
  }
  return tiers;
}

/** 智谱配额端点与用户 coding 端点同 host：bigmodel.cn → open.bigmodel.cn，其余（api.z.ai）→ api.z.ai */
function zhipuQuotaBase(baseUrl: string): string {
  return baseUrl.toLowerCase().includes("bigmodel.cn")
    ? "https://open.bigmodel.cn"
    : "https://api.z.ai";
}

/**
 * MiniMax：model_remains[] 里只取 model_name == "general"（跳过 video 等）。
 * 接口给的是「剩余百分比」，反转为已用；5h 桶始终存在，周桶仅 current_weekly_status==1
 * 时激活（无周限额套餐为 3，恒 100%，不展示）。
 */
export function parseMinimaxTiers(body: unknown): UsageTier[] {
  const tiers: UsageTier[] = [];
  const modelRemains = asArr(asObj(body)?.model_remains);
  if (!modelRemains) return tiers;
  const item = modelRemains.find(
    (m) => asStr(asObj(m)?.model_name) === "general",
  );
  if (!item) return tiers;
  const o = asObj(item)!;

  const remainPct = asNum(o.current_interval_remaining_percent);
  if (remainPct !== null) {
    const resetsAt = asNum(o.end_time) !== null ? millisToIso8601(asNum(o.end_time)!) : null;
    tiers.push({
      name: "five_hour",
      utilization: 100 - remainPct,
      resetsAt,
      usedValueUsd: null,
      maxValueUsd: null,
    });
  }

  if (asNum(o.current_weekly_status) === 1) {
    const wp = asNum(o.current_weekly_remaining_percent);
    if (wp !== null) {
      const resetsAt =
        asNum(o.weekly_end_time) !== null
          ? millisToIso8601(asNum(o.weekly_end_time)!)
          : null;
      tiers.push({
        name: "weekly_limit",
        utilization: 100 - wp,
        resetsAt,
        usedValueUsd: null,
        maxValueUsd: null,
      });
    }
  }
  return tiers;
}

/** ZenMux：data.quota_5_hour / quota_7_day。usage_percentage 是 0-1 小数，×100 展示；附带美元金额 */
export function parseZenmuxTiers(data: unknown): UsageTier[] {
  const tiers: UsageTier[] = [];
  const o = asObj(data);
  if (!o) return tiers;
  for (const [key, name] of [
    ["quota_5_hour", "five_hour"],
    ["quota_7_day", "weekly_limit"],
  ] as const) {
    const q = asObj(o[key]);
    if (!q) continue;
    const usagePct = asNum(q.usage_percentage) ?? 0.0;
    const resetsAt = asStr(q.resets_at);
    tiers.push({
      name,
      utilization: usagePct * 100,
      resetsAt,
      usedValueUsd: asNum(q.used_value_usd),
      maxValueUsd: asNum(q.max_value_usd),
    });
  }
  return tiers;
}

/**
 * OpenCode Go：usage.rolling|weekly|monthly{status,percent,resetsAt}（percent 为已用整数）。
 * percent=0 时上游 resetsAt 是「now+窗口时长」占位值，丢弃不展示倒计时。
 */
export function parseOpencodeGoTiers(body: unknown): UsageTier[] {
  const usage = asObj(asObj(body)?.usage);
  if (!usage) return [];
  const tiers: UsageTier[] = [];
  for (const [key, tierName] of [
    ["rolling", "five_hour"],
    ["weekly", "weekly_limit"],
    ["monthly", "monthly"],
  ] as const) {
    const w = asObj(usage[key]);
    if (!w) continue;
    const percent = asNum(w.percent);
    if (percent === null) continue;
    const resetsAt = percent > 0 ? extractResetTime(w.resetsAt) : null;
    tiers.push({
      name: tierName,
      utilization: percent,
      resetsAt,
      usedValueUsd: null,
      maxValueUsd: null,
    });
  }
  return tiers;
}

// ---------------- HTTP ----------------

/** 响应体上限：**本进程新增**的防御（v2.0.0 的 `usage_query.rs` 读体不设限，
 *  读体失败还单独报「读取响应失败」）。上限取值与 model_fetch.rs 的 10MB/64KB 对齐。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** 读响应体并按字节数限长：**读完上限就停**（保留已读到的部分，与 v2.0.0 的
 *  `.take(n).read_to_string()` 同语义——那边也是截断而非报错）。
 *  ⚠️ model-fetch.ts 里有一份逐字相同的拷贝（同 truncateBody），改这里要同步那份。 */
async function readCapped(resp: Response, limit: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      chunks.push(value.subarray(0, Math.max(0, limit - (total - value.byteLength))));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 已经是「面向用户说清楚了」的错误前缀：不再套「网络错误」外壳 */
const FINAL_ERROR_PREFIXES = ["认证失败", "接口错误", "响应解析失败"];

/** GET JSON：401/403 单独报认证失败；其余状态码/网络错误原样带回 */
async function httpGetJson(url: string, headers: [string, string][]): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUERY_TIMEOUT_MS);
  try {
    const h: Record<string, string> = { Accept: "application/json" };
    for (const [k, v] of headers) h[k] = v;
    const resp = await fetch(url, { signal: ctrl.signal, headers: h });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`认证失败 (HTTP ${resp.status})：API Key 无效或无权限`);
    }
    if (!resp.ok) {
      const body = await readCapped(resp, MAX_ERROR_BODY_BYTES).catch(() => "");
      throw new Error(`接口错误 (HTTP ${resp.status}): ${truncateBody(body)}`);
    }
    const text = await readCapped(resp, MAX_BODY_BYTES);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`响应解析失败: ${e.message}`);
    // 网络层错误（含超时中止）统一加前缀，别把 undici 的原文（如 "This operation was aborted"）
    // 直接甩给用户——v2.0.0 是「网络错误: {e}」
    const msg = e instanceof Error ? e.message : String(e);
    if (FINAL_ERROR_PREFIXES.some((p) => msg.startsWith(p))) throw e;
    throw new Error(`网络错误: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 截断到 300：**长度判据看字节、截断按码点**——这是 v2.0.0 `usage_query.rs:137`
 *  的原样（`body.len()` 是字节数，`chars().take(300)` 是码点），与本文件同名函数在
 *  model_fetch.rs 那份（两边都按码点）刻意不同，别"顺手统一"掉。
 *  结论：≥100 个汉字（>300 字节）时会比 model-fetch 那份**多**加一个省略号。 */
function truncateBody(body: string): string {
  if (Buffer.byteLength(body) <= 300) return body;
  return [...body].slice(0, 300).join("") + "…";
}

// ---------------- 查询编排 ----------------

/**
 * 查询入口：探测厂商 → 走对应适配器。非已知厂商返回 supported=false；
 * 401/403 报「认证失败」；解析为空（响应形态不认识）也记为失败但 supported=true。
 */
export async function queryUsage(
  baseUrl: string,
  apiKey: string,
): Promise<UsageResult> {
  const vendor = detectVendor(baseUrl);
  if (!vendor) return unsupported();

  try {
    let tiers: UsageTier[];
    switch (vendor) {
      case "kimi":
        tiers = parseKimiTiers(
          await httpGetJson("https://api.kimi.com/coding/v1/usages", [
            ["Authorization", `Bearer ${apiKey}`],
          ]),
        );
        break;
      case "zhipu":
        tiers = parseZhipuTokenTiers(
          await httpGetJson(
            `${zhipuQuotaBase(baseUrl)}/api/monitor/usage/quota/limit`,
            [
              ["Authorization", apiKey], // 注意：智谱不加 Bearer 前缀
              ["Content-Type", "application/json"],
              ["Accept-Language", "en-US,en"],
            ],
          ),
        );
        break;
      case "minimax": {
        const isCn = baseUrl.toLowerCase().includes("minimaxi.com");
        const domain = isCn ? "api.minimaxi.com" : "api.minimax.io";
        const url = `https://${domain}/v1/api/openplatform/coding_plan/remains`;
        const body = await httpGetJson(url, [
          ["Authorization", `Bearer ${apiKey}`],
          ["Content-Type", "application/json"],
        ]);
        const baseResp = asObj(asObj(body)?.base_resp);
        if (baseResp) {
          const code = asNum(baseResp.status_code) ?? -1;
          if (code !== 0) {
            throw new Error(
              `接口错误 (code ${code}): ${asStr(baseResp.status_msg) ?? "Unknown error"}`,
            );
          }
        }
        tiers = parseMinimaxTiers(body);
        break;
      }
      case "zenmux": {
        const body = await httpGetJson(baseUrl, [
          ["Authorization", `Bearer ${apiKey}`],
          ["Accept", "application/json"],
        ]);
        if (asObj(body)?.success !== true) {
          // 与 v2.0.0 同款前缀：裸 message 看不出是「接口返回了业务失败」
          throw new Error(`接口错误: ${asStr(asObj(body)?.message) ?? "Unknown error"}`);
        }
        const data = asObj(body)?.data;
        if (!data) throw new Error("响应缺少 data 字段");
        tiers = parseZenmuxTiers(data);
        break;
      }
      case "opencode_go": {
        const parsed = parseOpencodeGoTiers(
          await httpGetJson("https://opencode.ai/zen/go/v1/usage", [
            ["Authorization", `Bearer ${apiKey}`],
          ]),
        );
        // 这一家的空 tiers 单独报（v2.0.0 同文案）：端点没数据与端点变更要区分
        if (parsed.length === 0) return err(vendor, "响应形态不认识（端点可能已变更）");
        return ok(vendor, parsed);
      }
      default:
        return unsupported();
    }
    if (tiers.length === 0) return err(vendor, "响应形态不认识");
    return ok(vendor, tiers);
  } catch (e) {
    return err(vendor, e instanceof Error ? e.message : String(e));
  }
}
