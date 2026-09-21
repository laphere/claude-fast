// 拉取供应商可用模型列表（移植自 v2.0.0 model_fetch.rs）。
//
// OpenAI 兼容 GET /v1/models 的候选地址探测：base 以版本段 /v{N} 结尾时拼 {base}/models；
// 命中 /anthropic、/coding 等兼容后缀再追加剥后缀的 {root}/v1/models；Bearer 认证；
// 404/405 换下一候选；解析 {data:[{id, owned_by}]} 按 id 排序去重。
//
// 用 Node 内置 fetch（不引第三方 HTTP 库），带超时（AbortController）。纯逻辑
// （候选构造 / 响应解析）与 IO（fetch）分离，方便单测。
const FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_MAX_CHARS = 300;
/** 响应体上限：v2.0.0 同款防御（异常端点返回超大响应体时不吃光内存） */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** 拉到的单个模型（ownedBy 用于前端下拉按厂商分组，缺失归 "Other"） */
export interface FetchedModel {
  id: string;
  /** 缺失时为 undefined（序列化为 null 或不出现） */
  ownedBy?: string | null;
}

/**
 * 已知的「Anthropic 协议兼容子路径」后缀；按声明顺序匹配（最长前缀优先）。
 * baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 {root}/v1/models / /models」。
 */
const KNOWN_COMPAT_SUFFIXES: string[] = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
];

/** 候选顺序：版本段结尾拼 {base}/models；其余拼 {base}/v1/models；兼容后缀追加剥离后根路径 */
export function buildModelsUrlCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new Error("接入地址为空");

  const candidates: string[] = [];
  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith("/v1")) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped !== null) {
    const root = stripped.replace(/\/+$/, "");
    if (root !== "" && root.includes("://")) {
      candidates.push(`${root}/v1/models`);
      candidates.push(`${root}/models`);
    }
  }

  // 去重并保持首次出现顺序
  const unique: string[] = [];
  for (const c of candidates) if (!unique.includes(c)) unique.push(c);
  return unique;
}

/** 判断 baseURL 是否以 OpenAI 风格版本段 /v{N} 结尾（如 /v1、.../paas/v4） */
function endsWithVersionSegment(url: string): boolean {
  const last = url.split("/").pop() ?? "";
  const digits = last.startsWith("v") ? last.slice(1) : null;
  return (
    digits !== null &&
    digits.length > 0 &&
    [...digits].every((c) => c >= "0" && c <= "9")
  );
}

/** 命中已知兼容后缀时返回剥离后缀的路径，否则 null */
function stripCompatSuffix(baseUrl: string): string | null {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) return baseUrl.slice(0, baseUrl.length - suffix.length);
  }
  return null;
}

/** 解析 OpenAI 兼容的模型列表响应 {data: [{id, owned_by}]}（排序 + 去重） */
export function parseModelsResponse(body: string): FetchedModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("响应不是合法 JSON");
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error("响应缺少 data 数组");

  const models: FetchedModel[] = [];
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const id = (m as Record<string, unknown>).id;
    if (typeof id !== "string") continue;
    const owned = (m as Record<string, unknown>).owned_by;
    models.push({
      id,
      ownedBy: typeof owned === "string" ? owned : owned === null ? null : undefined,
    });
  }
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 按 id 去重，保留排序后首个（重复项的 ownedBy 丢弃）
  const seen = new Set<string>();
  const out: FetchedModel[] = [];
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** 按**码点**截断（Rust 的 `chars().take(300)`；按码元切会把代理对劈成半个字符） */
function truncateBody(body: string): string {
  const chars = [...body];
  if (chars.length <= ERROR_BODY_MAX_CHARS) return body;
  return chars.slice(0, ERROR_BODY_MAX_CHARS).join("") + "…";
}

interface TryResult {
  ok: boolean;
  models?: FetchedModel[];
  retryable: boolean;
  error: string;
}

/** 读响应体并按字节数限长：**读完上限就停**（保留已读到的部分，与 v2.0.0 的
 *  `.take(n).read_to_string()` 同语义——那边也是截断而非报错）。
 *  ⚠️ usage-query.ts 里有一份逐字相同的拷贝（同 truncateBody），改这里要同步那份。 */
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

/** 单个候选地址探测：成功解析模型；404/405 可换下一候选；其余错误立即失败 */
async function fetchModelsFromUrl(url: string, apiKey: string): Promise<TryResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (resp.status === 404 || resp.status === 405) {
      // 端点不存在/不支持该方法的探测，换下一个候选
      return { ok: false, retryable: true, error: `HTTP ${resp.status}` };
    }
    if (!resp.ok) {
      const body = await readCapped(resp, MAX_ERROR_BODY_BYTES).catch(() => "");
      return {
        ok: false,
        retryable: false,
        error: `HTTP ${resp.status}: ${truncateBody(body)}`,
      };
    }
    const text = await readCapped(resp, MAX_BODY_BYTES);
    try {
      return { ok: true, models: parseModelsResponse(text), retryable: false, error: "" };
    } catch (e) {
      return {
        ok: false,
        retryable: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } catch (e) {
    // 网络错误 / 超时中断：立即失败（不换候选）
    return {
      ok: false,
      retryable: false,
      error: `网络错误: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取供应商可用模型列表：候选 URL 逐个尝试，404/405 换下一个，
 * 其余错误立即失败；2xx 解析 {data:[{id,owned_by}]} 按 id 排序去重。
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
): Promise<FetchedModel[]> {
  const candidates = buildModelsUrlCandidates(baseUrl);
  let lastError = "";
  for (const url of candidates) {
    const r = await fetchModelsFromUrl(url, apiKey);
    if (r.ok && r.models) return r.models;
    if (!r.retryable) throw new Error(r.error);
    lastError = r.error;
  }
  throw new Error(`所有候选地址均失败：${lastError}`);
}
