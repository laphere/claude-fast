// 配置读写（对齐 v2.0.0 的 load_config / save_config：.bak 回退 + 三步原子写 + 读改写）
import * as fs from "node:fs";
import * as path from "node:path";

/** 供应商条目（供应商切换功能；settingsConfig = 切换时整文件替换 ~/.claude/settings.json 的内容）。
 *  ⚠️ settingsConfig 必须是 **JSON 对象**，与前端的 `src/types.ts` 及 v2.0.0 的
 *  `settings_config: Value` 一致——存字符串会让 `String(对象)` 静默写成 "[object Object]"。 */
export interface ProviderInfo {
  id: string;
  name: string;
  settingsConfig: Record<string, unknown>;
  websiteUrl?: string | null;
  category?: string | null;
  /** 未知的额外键原样保留（本进程不认识 ≠ 可以丢） */
  [k: string]: unknown;
}

/** 置顶会话条目：file 是会话 jsonl **绝对路径**（重命名只追加 customTitle 不改文件名、
 *  回收站恢复回原路径，故可作稳定锚点）；projectPath 在置顶时刻记录——
 *  mangled 目录名反解项目路径是启发式枚举，不能反查。 */
export interface PinnedSession {
  file: string;
  projectPath: string;
}

export interface Config {
  /** 用户手动排序的项目绝对路径（全局拖拽排序真源；未收录项按名称追加在后） */
  order: string[];
  /** 手动添加的项目路径清单（Claude 会话扫描之外的补充） */
  projects: string[];
  /** 被用户从列表移除的项目路径（会话扫描会重新发现它们，需排除） */
  excluded: string[];
  dark: boolean;
  /** null = 每次询问；"quit" = 直接退出；"minimize" = 最小化到托盘 */
  closeAction: string | null;
  /** Claude Code 供应商清单 */
  providers: ProviderInfo[];
  /** 当前启用供应商 id（null = 尚未启用过） */
  currentProvider: string | null;
  /** 置顶会话清单（全局聚合区）。顺序即展示顺序：新置顶插最前，不支持拖拽改序 */
  pinnedSessions: PinnedSession[];
  /** 兼容层：旧「收藏置顶」清单（去脚本化后存项目路径，顺序即显示顺序）。
   *  读取时迁移进 `order`；写盘暂时保留，待前端切到 `order` 后删除本字段。 */
  favorites: string[];
  /** 磁盘上的**未知顶层字段**，读改写时原样写回。
   *  不保留的话，本进程一次保存就会把别的版本新增的键静默清掉。 */
  unknownFields: Record<string, unknown>;
}

/** 可写字段（unknownFields 不可由调用方设置） */
export type ConfigPatch = Partial<Omit<Config, "unknownFields">>;

const OUT_KEYS = [
  "order",
  "projects",
  "excluded",
  "dark",
  "closeAction",
  "providers",
  "currentProvider",
  "pinnedSessions",
  "favorites",
] as const;

export function defaultConfig(): Config {
  return {
    order: [],
    projects: [],
    excluded: [],
    dark: false,
    closeAction: null,
    providers: [],
    currentProvider: null,
    pinnedSessions: [],
    favorites: [],
    unknownFields: {},
  };
}

/** 剥离 UTF-8 BOM 后解析 JSON（Windows 编辑器可能带 BOM 写入） */
function parseJsonWithBom(raw: Buffer): unknown {
  const body = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? raw.subarray(3)
    : raw;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** settingsConfig 归一成对象。正规形态是对象（v2.0.0 与本进程都这么写）；
 *  字符串形态只可能来自早期构建的误写，尽力 JSON.parse 还原，还原不了给空对象
 *  （留 `"[object Object]"` 这种字面量只会让后续每一次保存把它固化下去）。 */
export function normalizeSettingsConfig(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 落到空对象
    }
  }
  return {};
}

function normalizeProviders(v: unknown): ProviderInfo[] {
  if (!Array.isArray(v)) return [];
  const out: ProviderInfo[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    out.push({
      ...o,
      id: o.id === undefined ? "" : String(o.id),
      name: o.name === undefined ? "" : String(o.name),
      settingsConfig: normalizeSettingsConfig(o.settingsConfig),
      // v2.0.0 是 `Option<String>` 且无 skip_serializing_if → 缺失/null 一律写成显式 null
      websiteUrl: typeof o.websiteUrl === "string" ? o.websiteUrl : null,
      category: typeof o.category === "string" ? o.category : null,
    });
  }
  return out;
}

function normalizePins(v: unknown): PinnedSession[] {
  if (!Array.isArray(v)) return [];
  const out: PinnedSession[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.file !== "string") continue;
    out.push({ file: o.file, projectPath: o.projectPath === undefined ? "" : String(o.projectPath) });
  }
  return out;
}

/** 把磁盘上的对象规范化成本进程的 Config（宽松：认得的字段逐个归一，
 *  不认得的一律进 unknownFields 而不是丢掉） */
export function decodeConfig(v: unknown): Config {
  if (!v || typeof v !== "object" || Array.isArray(v)) return defaultConfig();
  const obj = v as Record<string, unknown>;
  const cfg = defaultConfig();

  cfg.order = stringArray(obj.order);
  cfg.projects = stringArray(obj.projects);
  cfg.excluded = stringArray(obj.excluded);
  cfg.dark = obj.dark === true;
  cfg.closeAction = obj.closeAction === "quit" || obj.closeAction === "minimize" ? obj.closeAction : null;
  cfg.providers = normalizeProviders(obj.providers);
  cfg.currentProvider = typeof obj.currentProvider === "string" ? obj.currentProvider : null;
  cfg.pinnedSessions = normalizePins(obj.pinnedSessions);
  cfg.favorites = stringArray(obj.favorites);

  // 迁移：旧配置只有 favorites（收藏置顶），用它当显示顺序的初值。
  // 仅在 order **键不存在**时迁移——显式写出的空数组不能被旧字段覆盖回来。
  if (obj.order === undefined && cfg.favorites.length > 0) {
    cfg.order = [...cfg.favorites];
  }

  for (const [k, val] of Object.entries(obj)) {
    if (!(OUT_KEYS as readonly string[]).includes(k)) cfg.unknownFields[k] = val;
  }
  return cfg;
}

/** 序列化：known 键覆盖 unknownFields，键顺序与 v2.0.0 的 Config 声明顺序一致（便于两端 diff）。 */
export function encodeConfig(cfg: Config): string {
  const out: Record<string, unknown> = { ...cfg.unknownFields };
  out.order = cfg.order;
  out.projects = cfg.projects;
  out.excluded = cfg.excluded;
  out.dark = cfg.dark;
  out.closeAction = cfg.closeAction;
  out.providers = cfg.providers;
  out.currentProvider = cfg.currentProvider;
  out.pinnedSessions = cfg.pinnedSessions;
  out.favorites = cfg.favorites;
  return JSON.stringify(out, null, 2);
}

function readConfigFile(p: string): Config | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(p);
  } catch {
    return null;
  }
  const parsed = parseJsonWithBom(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return decodeConfig(parsed);
}

/** 读取配置：主文件损坏时自动回退到 .bak 并恢复主文件（清单/置顶不丢失） */
export function loadConfig(root: string): Config {
  const cfgPath = path.join(root, "config.json");
  const bakPath = path.join(root, "config.json.bak");
  const c = readConfigFile(cfgPath);
  if (c) return c;
  const bak = readConfigFile(bakPath);
  if (bak) {
    try {
      fs.copyFileSync(bakPath, cfgPath);
    } catch {
      // 恢复失败不阻塞读取
    }
    return bak;
  }
  return defaultConfig();
}

/** 落盘三步保护：写临时文件 → 旧文件备份为 .bak → 原子替换。
 *  ⚠️ 裸写入口：**不要**在 `withConfigLock` 内调用它，也不要在没有读改写语义的地方直接调——
 *  前端/命令层一律走 `updateConfig`。 */
export function saveConfig(root: string, cfg: Config): void {
  const json = encodeConfig(cfg);
  const cfgPath = path.join(root, "config.json");
  const bakPath = path.join(root, "config.json.bak");
  const tmpPath = path.join(root, "config.json.tmp");
  fs.writeFileSync(tmpPath, json, "utf8");
  if (fs.existsSync(cfgPath)) {
    fs.copyFileSync(cfgPath, bakPath);
  }
  fs.renameSync(tmpPath, cfgPath);
}

// ---------------- 写串行化（Node 侧等价于 Rust 的 CONFIG_LOCK） ----------------

const WRITE_CHAINS = new Map<string, Promise<unknown>>();

/**
 * 串行化「读 → 改 → 写」：同一数据根上的写操作排队执行。
 * ⚠️ **持锁期间不得再调用另一个会取锁的函数**（本函数 / `updateConfig`）——链式锁不可重入。
 * 两种嵌套的实际后果不同，但都别写：回调里 `await` 一个取锁函数会把这个回调自己排在
 * 未完成的链条后面 → 真死锁（`withConfigLock` 内 `await updateConfig` 实测永不返回）；
 * 回调里同步调 `mutateConfig` 不死锁，但内层被推迟到外层结束之后执行，**期间读到的
 * 是外层写盘前的旧内容**，且改动顺序与代码书写顺序相反。Rust 侧 std Mutex 同款约束。
 */
export function withConfigLock<T>(root: string, fn: () => T): Promise<T> {
  const key = path.resolve(root);
  const prev = WRITE_CHAINS.get(key) ?? Promise.resolve();
  // 前一个操作失败不能让后面的操作被跳过 → 成功/失败都继续
  const next = prev.then(fn, fn);
  WRITE_CHAINS.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function applyPatch(cfg: Config, patch: ConfigPatch): void {
  const p = patch as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
  if (has("order")) cfg.order = stringArray(p.order);
  if (has("projects")) cfg.projects = stringArray(p.projects);
  if (has("excluded")) cfg.excluded = stringArray(p.excluded);
  if (has("dark")) cfg.dark = p.dark === true;
  if (has("closeAction")) {
    cfg.closeAction = p.closeAction === "quit" || p.closeAction === "minimize" ? p.closeAction : null;
  }
  if (has("providers")) cfg.providers = normalizeProviders(p.providers);
  if (has("currentProvider")) {
    cfg.currentProvider = typeof p.currentProvider === "string" ? p.currentProvider : null;
  }
  if (has("pinnedSessions")) cfg.pinnedSessions = normalizePins(p.pinnedSessions);
  if (has("favorites")) cfg.favorites = stringArray(p.favorites);
}

/**
 * 配置更新的通用入口：**读改写**而非从参数重建。
 * 从参数重建会静默清掉调用方没传的字段（v2.0.0 踩过：设置对话框一保存就把供应商清单清空），
 * 这里先读盘、只改调用方要改的部分，再走三步保护落盘；整个过程持锁串行。
 *
 * 内容一字未变则不落盘：`.bak` 是主文件损坏时的唯一退路，而每次启动都无条件保存
 * 会把上一份 `.bak` 轮换成刚写出的 main（备份被无意义地冲掉，且让用户真正需要
 * 回滚时只剩同一份坏数据）。v2.0.0 同样只在确有改动时写。
 */
export function mutateConfig(root: string, mutate: (cfg: Config) => void): Promise<Config> {
  return withConfigLock(root, () => {
    const cfg = loadConfig(root);
    const before = encodeConfig(cfg);
    mutate(cfg);
    if (encodeConfig(cfg) !== before) saveConfig(root, cfg);
    return cfg;
  });
}

/** `mutateConfig` 的 patch 形式：只覆盖 patch 里**出现过**的键 */
export function updateConfig(root: string, patch: ConfigPatch): Promise<Config> {
  return mutateConfig(root, (cfg) => applyPatch(cfg, patch));
}

// ---------------- 置顶会话清单的清理语义（与 v2.0.0 同） ----------------

/** 撤掉指定项目的置顶条目：项目从列表移除、或项目会话数据被清除时调用，
 *  否则置顶区会留下所属项目已不在列表里的孤儿条目 */
export function dropPinsForProjects(cfg: Config, paths: string[]): void {
  const drop = paths.map((p) => p.toLowerCase());
  cfg.pinnedSessions = cfg.pinnedSessions.filter(
    (p) => !drop.includes(p.projectPath.toLowerCase()),
  );
}

/** 清掉会话文件已不存在的置顶条目。**只**在「彻底删除」类操作后调用：
 *  删除进回收站后文件同样不在原路径，但条目必须留着等恢复，故 delete_session 不调用本函数。 */
export function pruneDeadPins(cfg: Config, exists: (file: string) => boolean = fs.existsSync): void {
  cfg.pinnedSessions = cfg.pinnedSessions.filter((p) => exists(p.file));
}
