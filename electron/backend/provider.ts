// Claude Code 供应商切换（移植自 v2.0.0 provider.rs / cc-switch v3.20.1 最小核心）。
//
// 切换顺序固定：① 回填离任供应商（吸收 live 手工修改）→ ② 记 current →
// ③ sanitize 后整文件原子替换 ~/.claude/settings.json。本文件只导出函数，
// 不注册 IPC——main 进程负责接线。所有清单写入都经 config.ts 的 mutateConfig
// （读改写 + 持锁），绝不直接 loadConfig+saveConfig 重建（会清掉未知字段）。
//
// 注意：本分支的 ProviderInfo.settingsConfig 是「整份 settings.json 的 JSON 字符串」
// （v2.0.0 Rust 侧是 serde_json::Value）。切换/回填时按需 解析↔字符串化。
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  loadConfig,
  mutateConfig,
  type Config,
  type ProviderInfo,
} from "./config";
import { queryUsage, type UsageResult } from "./usage-query";

/** 供应商清单（供 list/save/... 命令返回） */
export interface ProviderListState {
  providers: ProviderInfo[];
  currentId: string | null;
}

/** 切换结果（清单 + 告警；告警不阻塞切换，仅告知调用方） */
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

// ---------------- 路径解析 ----------------

/**
 * 用户级 Claude 配置目录：CLAUDE_CONFIG_DIR 环境变量优先，否则 ~/.claude。
 * 与 v2.0.0 claude_config_dir 同优先级（Windows 用 USERPROFILE、macOS/Linux 用 HOME）。
 */
export function claudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env && env.length > 0) return env;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return path.join(home, ".claude");
}

/**
 * live settings 路径：settings.json 优先，遗留 claude.json 存在时回退，
 * 都不存在时默认 settings.json（切换时会创建）。与 v2.0.0 claude_settings_path_from 一致。
 */
export function claudeSettingsPathFrom(configDir: string): string {
  const settings = path.join(configDir, "settings.json");
  if (fs.existsSync(settings)) return settings;
  const legacy = path.join(configDir, "claude.json");
  if (fs.existsSync(legacy)) return legacy;
  return settings;
}

// ---------------- 读写 / 原子写 ----------------

/** 剥离 UTF-8 BOM 后解析 JSON（Windows 编辑器可能带 BOM 写入） */
function stripBom(raw: Buffer): Buffer {
  return raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? raw.subarray(3)
    : raw;
}

/** 读 JSON 文件；缺失/损坏返回 null（不抛错，调用方自行决定降级） */
function readJsonFile(p: string): unknown | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(p);
  } catch {
    return null;
  }
  try {
    return JSON.parse(stripBom(raw).toString("utf8"));
  } catch {
    return null;
  }
}

/** 读为对象（过滤 null/数组） */
function readJsonObject(p: string): Record<string, unknown> | null {
  const v = readJsonFile(p);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * 原子写文件：写 .tmp → 旧文件备份 .bak → rename（与 save_config 同款三步保护，
 * 切换前的 settings.json 因此总有一份 .bak 可手工恢复）。settings.json 是独立于
 * config.json 的文件，不走 config 锁，但同样需要备份防误覆盖。
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  const bak = filePath + ".bak";
  fs.writeFileSync(tmp, content, "utf8");
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bak);
  fs.renameSync(tmp, filePath);
}

/** 原子写 JSON 对象（2 空格缩进，与本项目序列化风格一致） */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

// ---------------- sanitize ----------------

/**
 * 净化：仅移除 cc-switch 存储层的内部顶层键（外部工具写入、非 Claude Code 配置）。
 * v2.0.0 同时删 camelCase 与 snake_case 两种命名（apiFormat/api_format、
 * openrouterCompatMode/openrouter_compat_mode），这里逐字对齐。
 */
export function sanitizeClaudeSettings(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = { ...(value as Record<string, unknown>) };
  for (const k of [
    "apiFormat",
    "api_format",
    "openrouterCompatMode",
    "openrouter_compat_mode",
  ]) {
    delete obj[k];
  }
  return obj;
}

// ---------------- settingsConfig 解析 ----------------

/** settingsConfig 字符串 → 对象（非法 JSON 返回 null） */
function parseSettingsConfig(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 供应商身份指纹：env 里的 baseURL + 凭证（AUTH_TOKEN 优先，回退 API_KEY）。
 * 回填守卫的判定依据——live 与离任条目指纹一致才允许吸收，否则 live 已被
 * 外部工具改写、照常吸收会把别家配置静默灌进离任条目。None = 无法判定（无 env）。
 */
function extractFingerprint(
  obj: unknown,
): { base: string; cred: string | null } | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const env = (obj as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const envObj = env as Record<string, unknown>;
  const base = typeof envObj.ANTHROPIC_BASE_URL === "string"
    ? envObj.ANTHROPIC_BASE_URL
    : null;
  if (!base) return null;
  let cred: string | null = null;
  if (typeof envObj.ANTHROPIC_AUTH_TOKEN === "string") {
    cred = envObj.ANTHROPIC_AUTH_TOKEN;
  } else if (typeof envObj.ANTHROPIC_API_KEY === "string") {
    cred = envObj.ANTHROPIC_API_KEY;
  }
  return { base, cred };
}

function fingerprintEqual(
  a: { base: string; cred: string | null },
  b: { base: string; cred: string | null },
): boolean {
  return a.base === b.base && a.cred === b.cred;
}

// ---------------- 首启导入 / live 读取 ----------------

/**
 * 首启导入：providers 为空时把 live 配置整文件收编为 default 供应商（不拆 env，整份保留）。
 * 返回 null 表示 live 不存在（无配置可收编）。
 */
export function importDefaultFrom(configDir: string): ProviderInfo | null {
  const live = readJsonFile(claudeSettingsPathFrom(configDir));
  if (live === null) return null;
  return {
    id: "default",
    name: "default",
    settingsConfig: JSON.stringify(live),
    category: "custom",
  };
}

/** 读取 live 配置（供表单「从当前配置导入」）；缺失返回 null */
export function readLiveSettings(configDir: string): Record<string, unknown> | null {
  return readJsonObject(claudeSettingsPathFrom(configDir));
}

// ---------------- 切换 ----------------

export interface SwitchResult {
  warnings: string[];
  currentId: string | null;
}

/**
 * 切换核心（顺序固定，与 v2.0.0 一致）：
 * 1) 回填：live 整文件写回离任供应商（吸收用户在 Claude Code 里的手工修改；
 *    live 缺失/损坏仅告警不阻塞；live 指纹与离任条目不符时跳过回填仅告警）。
 * 2) current 指向目标（先记后写，写失败时 current 已指向新供应商）。
 * 3) sanitize 后整文件原子替换 live。
 * 切给自己时不回填（live 被存储配置整文件覆盖）。
 */
export function switchProviderFrom(
  configDir: string,
  providers: ProviderInfo[],
  currentId: string | null,
  targetId: string,
): SwitchResult {
  const target = providers.find((p) => p.id === targetId);
  if (!target) throw new Error(`供应商 ${targetId} 不存在`);
  const warnings: string[] = [];
  const settingsPath = claudeSettingsPathFrom(configDir);

  if (currentId !== targetId) {
    const cur = currentId;
    if (cur) {
      const slot = providers.find((p) => p.id === cur);
      if (slot) {
        const live = readJsonFile(settingsPath);
        if (live !== null) {
          const liveFp = extractFingerprint(live);
          const slotFp = extractFingerprint(parseSettingsConfig(slot.settingsConfig));
          // 两侧指纹可判定且不一致 = live 已不属于离任供应商，跳过回填仅告警
          if (liveFp && slotFp && !fingerprintEqual(liveFp, slotFp)) {
            warnings.push(`backfill_skipped:${cur}`);
          } else {
            // 指纹一致（吸收手工修改）或无法判定（无 env 等退化情况）→ 整文件吸收
            slot.settingsConfig = JSON.stringify(live);
          }
        } else {
          warnings.push(`backfill_failed:${cur}`);
        }
      }
    }
  }

  const newCurrent = targetId;
  const targetObj = parseSettingsConfig(target.settingsConfig);
  // sanitize 后整文件写盘；无法解析则原样写入（保底，正常不会发生）
  const content =
    targetObj !== null
      ? JSON.stringify(sanitizeClaudeSettings(targetObj), null, 2)
      : target.settingsConfig;
  writeFileAtomic(settingsPath, content);
  return { warnings, currentId: newCurrent };
}

/**
 * 标记重锚定：live 与唯一条目 sanitize 后完全一致而 current 指向别人时，
 * 以磁盘为准修正 current——外部工具改写 settings.json 的自愈，保证「当前」徽标不失真。
 * 0 个匹配（live 有手工改动）或多个匹配（重复条目）时保持原状。返回修正后的 currentId。
 */
export function reanchorCurrentFrom(
  configDir: string,
  providers: ProviderInfo[],
  currentId: string | null,
): string | null {
  const live = readJsonFile(claudeSettingsPathFrom(configDir));
  if (live === null) return currentId;
  const matched = providers.filter((p) => {
    const obj = parseSettingsConfig(p.settingsConfig);
    return obj !== null && deepEqual(sanitizeClaudeSettings(obj), live);
  });
  if (matched.length === 1) {
    if (currentId === matched[0].id) return currentId;
    return matched[0].id;
  }
  return currentId;
}

/** 顺序无关的深比较（JSON 值语义；键序不同也视为相等） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]),
    );
  }
  return false;
}

// ---------------- CC Switch SQL 备份导入 ----------------
//
// 定向解析「导出配置」的通用 SQL 文本：按列名取值（不怕列序/列数变化），仅取
// app_type='claude' 的行；字符串单引号包裹、内部 '' 翻倍转义；无法入文的 TEXT
// 用 CAST(x'..' AS TEXT) 表示，跳过该行。

type SqlVal =
  | { t: "str"; v: string }
  | { t: "int"; v: number }
  | { t: "null" }
  | { t: "opaque" };

function skipWs(b: Uint8Array, i: number): number {
  while (i < b.length) {
    const c = b[i];
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

function findSub(hay: Uint8Array, from: number, needle: Uint8Array): number | null {
  if (needle.length === 0 || from >= hay.length) return null;
  const end = hay.length - needle.length;
  for (let i = from; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return null;
}

/** 解析单引号 SQL 字符串（'' 转义），返回 [内容, 结束位置] */
function parseSqlString(b: Uint8Array, start: number): [string, number] | null {
  if (b[start] !== 0x27) return null; // '
  let out = "";
  let j = start + 1;
  let seg = j;
  for (;;) {
    const c = b[j];
    if (c === 0x27) {
      if (b[j + 1] === 0x27) {
        out += Buffer.from(b.slice(seg, j)).toString("utf8") + "'";
        j += 2;
        seg = j;
      } else {
        out += Buffer.from(b.slice(seg, j)).toString("utf8");
        return [out, j + 1];
      }
    } else if (c === undefined) {
      return null;
    } else {
      j++;
    }
  }
}

/** 解析 CAST(x'..' AS TEXT)，返回结束位置 */
function parseSqlCast(b: Uint8Array, start: number): number | null {
  const head = Buffer.from("CAST(");
  if (b.length < start + head.length) return null;
  for (let i = 0; i < head.length; i++) {
    if (String.fromCharCode(b[start + i]).toLowerCase() !== String.fromCharCode(head[i]).toLowerCase())
      return null;
  }
  let j = skipWs(b, start + head.length);
  if (b[j] !== 0x78 && b[j] !== 0x58) return null; // x / X
  j++;
  const r = parseSqlString(b, j);
  if (!r) return null;
  j = skipWs(b, r[1]);
  const tail = Buffer.from("AS TEXT)");
  if (b.length < j + tail.length) return null;
  for (let i = 0; i < tail.length; i++) {
    if (String.fromCharCode(b[j + i]).toLowerCase() !== String.fromCharCode(tail[i]).toLowerCase())
      return null;
  }
  return j + tail.length;
}

/** 解析单个 SQL 值，返回 [值, 结束位置] */
function parseSqlValue(b: Uint8Array, start: number): [SqlVal, number] | null {
  const i = skipWs(b, start);
  const c = b[i];
  if (c === 0x27) {
    const r = parseSqlString(b, i);
    return r ? [{ t: "str", v: r[0] }, r[1]] : null;
  }
  if (c === 0x43 || c === 0x63) {
    // C / c：可能是 CAST(...)
    const r = parseSqlCast(b, i);
    return r ? [{ t: "opaque" }, r] : null;
  }
  if (b.length - i >= 4) {
    let allN = true;
    for (let k = 0; k < 4; k++) {
      if (String.fromCharCode(b[i + k]).toUpperCase() !== "NULL"[k]) {
        allN = false;
        break;
      }
    }
    if (allN) return [{ t: "null" }, i + 4];
  }
  let j = i;
  while (j < b.length) {
    const ch = b[j];
    if (
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      ch === 0x2d || // -
      ch === 0x2e // .
    ) {
      j++;
    } else break;
  }
  if (j === i) return null;
  const s = Buffer.from(b.slice(i, j)).toString("utf8");
  const n = Number(s);
  return [Number.isFinite(n) ? { t: "int", v: n } : { t: "null" }, j];
}

/** 解析双引号/裸标识符，返回 [标识符, 结束位置] */
function parseSqlIdent(b: Uint8Array, start: number): [string, number] | null {
  const i = skipWs(b, start);
  if (b[i] === 0x22) {
    // "
    const end = b.indexOf(0x22, i + 1);
    if (end < 0) return null;
    return [Buffer.from(b.slice(i + 1, end)).toString("utf8"), end + 1];
  }
  let j = i;
  while (j < b.length) {
    const ch = b[j];
    if (
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      (ch >= 0x41 && ch <= 0x5a) || // A-Z
      (ch >= 0x61 && ch <= 0x7a) || // a-z
      ch === 0x5f // _
    ) {
      j++;
    } else break;
  }
  if (j === i) return null;
  return [Buffer.from(b.slice(i, j)).toString("utf8"), j];
}

/**
 * 解析 CC Switch「导出配置」SQL：返回 (claude 供应商列表（同 id 去重）,
 * 备份标记 is_current 的 id, 告警)。按列名取值、'' 转义、CAST blob 行跳过、
 * 仅取 app_type='claude'。
 */
export function parseCcswitchSql(
  text: string,
): [ProviderInfo[], string | null, string[]] {
  const b = Buffer.from(text, "utf8");
  const providers: ProviderInfo[] = [];
  const warnings: string[] = [];
  let currentId: string | null = null;
  let i = 0;

  for (;;) {
    const off = findSub(b, i, Buffer.from("INSERT INTO"));
    if (off === null) break;
    i = off + "INSERT INTO".length;
    const ident = parseSqlIdent(b, i);
    if (!ident) break;
    i = ident[1];
    if (ident[0] !== "providers") continue; // 非 providers 表不消费语句体

    // 列清单 (a, b, ...)
    i = skipWs(b, i);
    if (b[i] !== 0x28) continue; // (
    i++;
    const columns: string[] = [];
    for (;;) {
      const col = parseSqlIdent(b, i);
      if (!col) break;
      columns.push(col[0]);
      i = col[1];
      i = skipWs(b, i);
      if (b[i] === 0x2c) i++; // ,
      else if (b[i] === 0x29) {
        i++;
        break;
      } else break;
    }

    i = skipWs(b, i);
    if (b.slice(i, i + 6).toString("utf8").toUpperCase() !== "VALUES") continue;
    i += 6;

    for (;;) {
      i = skipWs(b, i);
      if (b[i] !== 0x28) break; // (
      i++;
      const values: SqlVal[] = [];
      for (;;) {
        const v = parseSqlValue(b, i);
        if (!v) break;
        values.push(v[0]);
        i = v[1];
        i = skipWs(b, i);
        if (b[i] === 0x2c) i++; // ,
        else if (b[i] === 0x29) {
          i++;
          break;
        } else break;
      }
      handleSqlRow(columns, values, providers, (id) => {
        currentId = id;
      }, warnings);
      i = skipWs(b, i);
      if (b[i] === 0x2c) i++; // 下一个元组
      else if (b[i] === 0x3b) {
        i++;
        break;
      } // ;
      else break;
    }
  }
  return [providers, currentId, warnings];
}

function sqlInt(v: SqlVal): number | null {
  return v.t === "int" ? v.v : null;
}

function handleSqlRow(
  columns: string[],
  values: SqlVal[],
  providers: ProviderInfo[],
  setCurrent: (id: string) => void,
  warnings: string[],
): void {
  const get = (name: string): SqlVal | null => {
    const idx = columns.indexOf(name);
    return idx >= 0 && idx < values.length ? values[idx] : null;
  };
  // 仅导入 Claude App 的行（Codex / Gemini 等其它 App 跳过，不告警）
  const appType = get("app_type");
  if (!(appType && appType.t === "str" && appType.v === "claude")) return;

  const id = get("id");
  const name = get("name");
  if (!(id && id.t === "str" && name && name.t === "str" && id.v.length > 0)) {
    warnings.push("跳过 1 行：id/name 缺失");
    return;
  }

  const settingsRaw = get("settings_config");
  if (!settingsRaw || settingsRaw.t !== "str") {
    warnings.push(`跳过「${name.v}」：settings_config 含无法入文的二进制值`);
    return;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(settingsRaw.v);
  } catch {
    warnings.push(`跳过「${name.v}」：settings_config 不是合法 JSON`);
    return;
  }

  if (providers.some((p) => p.id === id.v)) return; // 同批次内按 id 去重

  const websiteUrl = get("website_url");
  const category = get("category");
  if (get("is_current") && sqlInt(get("is_current")!) === 1) setCurrent(id.v);

  providers.push({
    id: id.v,
    name: name.v,
    // 本分支 settingsConfig 是字符串：把 JSON 对象字符串化整份保留
    settingsConfig: JSON.stringify(settings),
    ...(websiteUrl && websiteUrl.t === "str"
      ? { websiteUrl: websiteUrl.v }
      : {}),
    ...(category && category.t === "str" ? { category: category.v } : {}),
  });
}

// ---------------- 命令层（参数注入：configDir + root） ----------------

/**
 * 供应商清单：首启自动把 live 收编为 default（置为 current）；current 失效归零；
 * 标记重锚定以磁盘为准修正脱节的 current。全部读改写在单次持锁内完成。
 */
export async function providerListFrom(
  configDir: string,
  root: string,
): Promise<ProviderListState> {
  const cfg = await mutateConfig(root, (c) => {
    if (c.providers.length === 0) {
      const def = importDefaultFrom(configDir);
      if (def) {
        c.providers.push(def);
        c.currentProvider = def.id;
      }
    }
    // current 指向已删除的供应商 → 归零
    if (c.currentProvider && !c.providers.some((p) => p.id === c.currentProvider)) {
      c.currentProvider = null;
    }
    // 标记重锚定（live 被外部工具改写时以磁盘为准），就地修正 current
    c.currentProvider = reanchorCurrentFrom(configDir, c.providers, c.currentProvider);
  });
  return { providers: cfg.providers, currentId: cfg.currentProvider };
}

/**
 * 新增/更新供应商。保存的条目若是 current，sanitize 后先原子写 live 再落清单
 * （只改清单的话磁盘仍是旧内容，下次切换的回填会把旧 live 灌回清单、静默回滚刚保存的修改）。
 * 非 current 条目仅落清单不碰磁盘。id 为空 = 新增（生成 uuid）。
 */
export async function providerSaveFrom(
  configDir: string,
  root: string,
  input: ProviderInfo,
): Promise<ProviderListState> {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("供应商名称不能为空");
  const parsed = parseSettingsConfig(input.settingsConfig);
  if (parsed === null) throw new Error("settingsConfig 必须是 JSON 对象");

  const cfg = await mutateConfig(root, (c) => {
    const savedCurrent = input.id !== "" && c.currentProvider === input.id;
    const entry: ProviderInfo = { ...input, id: input.id, name: input.name };
    if (entry.id === "") {
      entry.id = randomUUID();
      c.providers.push(entry);
    } else {
      const idx = c.providers.findIndex((p) => p.id === entry.id);
      if (idx >= 0) c.providers[idx] = entry;
      else c.providers.push(entry);
    }
    // 先写 live 后落清单：live 写失败时清单未动，两侧不脱节
    if (savedCurrent) {
      const settingsPath = claudeSettingsPathFrom(configDir);
      writeJsonAtomic(settingsPath, sanitizeClaudeSettings(parsed));
    }
  });
  return { providers: cfg.providers, currentId: cfg.currentProvider };
}

/** 删除供应商（禁止删除当前启用的） */
export async function providerDeleteFrom(
  _configDir: string,
  root: string,
  id: string,
): Promise<ProviderListState> {
  const cfg = await mutateConfig(root, (c) => {
    if (c.currentProvider === id) {
      throw new Error("不能删除当前启用的供应商，请先切换到其他供应商");
    }
    const before = c.providers.length;
    c.providers = c.providers.filter((p) => p.id !== id);
    if (c.providers.length === before) throw new Error(`供应商 ${id} 不存在`);
  });
  return { providers: cfg.providers, currentId: cfg.currentProvider };
}

/**
 * 拖拽排序持久化：按 ids 给定顺序稳定重排清单。未提及的 id（理论不存在，
 * 防御外部并发改动）按原相对顺序沉底、多余的 id 忽略，保证不丢数据。
 */
export async function providerReorderFrom(
  _configDir: string,
  root: string,
  ids: string[],
): Promise<ProviderListState> {
  const cfg = await mutateConfig(root, (c) => {
    const pos = (id: string) => {
      const i = ids.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    c.providers.sort((a, b) => pos(a.id) - pos(b.id));
  });
  return { providers: cfg.providers, currentId: cfg.currentProvider };
}

/** 切换供应商：回填离任 → 记 current → 整文件原子替换 settings.json */
export async function providerSwitchFrom(
  configDir: string,
  root: string,
  id: string,
): Promise<ProviderSwitchOutcome> {
  let warnings: string[] = [];
  let currentId: string | null = null;
  const cfg = await mutateConfig(root, (c) => {
    const r = switchProviderFrom(configDir, c.providers, c.currentProvider, id);
    warnings = r.warnings;
    currentId = r.currentId;
    c.currentProvider = r.currentId;
  });
  return {
    list: { providers: cfg.providers, currentId },
    warnings,
  };
}

/**
 * 从 CC Switch「导出配置」SQL 备份导入：去重合并（同 id 保留现状、幂等），
 * 备份中标记为当前的供应商仅当本地尚无有效 current 时采纳。live 本就是该供应商
 * 配置，这里只对齐标记、不写盘。
 */
export async function providerImportCcswitchFrom(
  root: string,
  filePath: string,
): Promise<ProviderImportOutcome> {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`读取备份失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = stripBom(raw).toString("utf8");
  const [imported, backupCurrent, warnings] = parseCcswitchSql(text);
  if (imported.length === 0) {
    throw new Error(
      "备份中未找到 Claude 供应商：请确认选择的是 CC Switch「导出配置」生成的 SQL 备份文件",
    );
  }
  let added = 0;
  let skipped = 0;
  const cfg = await mutateConfig(root, (c) => {
    for (const p of imported) {
      if (c.providers.some((e) => e.id === p.id)) {
        skipped++; // 与现有清单同 id：保留现状，幂等导入
        continue;
      }
      c.providers.push(p);
      added++;
    }
    const currentValid =
      c.currentProvider !== null &&
      c.providers.some((p) => p.id === c.currentProvider);
    if (!currentValid && backupCurrent && c.providers.some((p) => p.id === backupCurrent)) {
      c.currentProvider = backupCurrent;
    }
  });
  if (skipped > 0) warnings.push(`${skipped} 个供应商与现有清单重复，已跳过`);
  return {
    list: { providers: cfg.providers, currentId: cfg.currentProvider },
    imported: added,
    skipped,
    warnings,
  };
}

/** 读取当前 live 配置（~/.claude/settings.json），供表单导入 */
export function providerReadLiveFrom(configDir: string): Record<string, unknown> | null {
  return readLiveSettings(configDir);
}

/**
 * 查询供应商 Coding Plan 用量：从清单取该供应商 env 的 base_url + 密钥，
 * 命中厂商即用其密钥查询；非已知厂商返回 supported=false 前端静默。
 */
export async function providerQueryUsageFrom(
  root: string,
  id: string,
): Promise<UsageResult> {
  const cfg: Config = loadConfig(root);
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) {
    return {
      success: false,
      supported: false,
      vendor: null,
      data: [],
      error: `供应商 ${id} 不存在`,
    };
  }
  const env = parseSettingsConfig(p.settingsConfig)?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return {
      success: false,
      supported: false,
      vendor: null,
      data: [],
      error: "供应商配置缺少 env",
    };
  }
  const envObj = env as Record<string, unknown>;
  const base =
    typeof envObj.ANTHROPIC_BASE_URL === "string" ? envObj.ANTHROPIC_BASE_URL : null;
  const key =
    typeof envObj.ANTHROPIC_AUTH_TOKEN === "string"
      ? envObj.ANTHROPIC_AUTH_TOKEN
      : typeof envObj.ANTHROPIC_API_KEY === "string"
        ? envObj.ANTHROPIC_API_KEY
        : null;
  if (!base) {
    return {
      success: false,
      supported: false,
      vendor: null,
      data: [],
      error: "供应商配置缺少 ANTHROPIC_BASE_URL",
    };
  }
  return queryUsage(base, key ?? "");
}

// ---------------- openUrl ----------------

/**
 * 用系统默认浏览器打开外部链接（官网 / 获取 API Key）。Windows 走 explorer.exe
 * 免 cmd 转义（避免 URL 里的 & 等被 shell 解释），macOS 走 open。
 */
export function openUrl(url: string): void {
  if (process.platform === "win32") {
    spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}
