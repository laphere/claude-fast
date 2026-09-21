// 数据根目录定位与 Claude Code 项目目录（对齐 v2.0.0 的 resolve_root_dir /
// looks_like_our_config / claude_projects_dir）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 启动脚本专用目录（相对数据根目录）——去脚本化后仅剩旧数据迁移还要读它 */
export const SCRIPTS_DIR = "scripts";

/** 当前平台的启动脚本扩展名：Windows 用 .bat，macOS/Linux 用 .sh */
export function scriptExt(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "bat" : "sh";
}

/** 旧版便携模式数据根标记文件名（仅旧数据迁移用；**不再参与数据根判定**） */
export function legacyMarker(platform: NodeJS.Platform = process.platform): string {
  return `claude-claude-fast.${scriptExt(platform)}`;
}

function statIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 已知配置字段——**必须与 v2.0.0 `lib.rs` 的 `KNOWN_KEYS` 逐字同表**，
 * 否则同一个便携目录会被两个 app 判成不同结果。给 Config 加字段时两端同步加。
 */
export const KNOWN_CONFIG_KEYS = [
  "order",
  "projects",
  "excluded",
  "dark",
  "closeAction",
  "defaultInteraction",
  "providers",
  "currentProvider",
  "pinnedSessions",
] as const;

/** 剥离 UTF-8 BOM（Windows 编辑器可能带 BOM 写入） */
function stripBom(buf: Buffer): Buffer {
  return buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? buf.subarray(3) : buf;
}

/**
 * 配置文件是否「像本程序的配置」：须为 JSON 对象，且要么是空对象
 * （`{}` = 用户显式引导便携模式的正规姿势，外来工具的配置不会恰好是空对象），
 * 要么命中 **≥2 个**已知字段。
 *
 * 为什么是「≥2」而不是「≥1」：`projects` / `dark` / `order` / `excluded` 都是通用词，
 * 只要求撞上 1 个键，就会把别的工具（乃至手写的 `{"dark":true}`）认成数据根，
 * 代价是认领后任意一次保存都会把它整份覆写（原件只降级成 .bak）。
 * ≥2 不会误杀自家配置：序列化器不跳过空字段，落盘永远写全 8 个键。
 */
export function looksLikeOurConfig(file: string): boolean {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw).toString("utf8"));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return true;
  let hits = 0;
  for (const k of KNOWN_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return false;
}

/**
 * 目录是否数据根：`config.json` 或 `config.json.bak` 过内容校验。
 * **`.bak` 支是必需的**——主文件损坏/被删正是 .bak 存在的意义，若在这里就放弃该目录，
 * 会静默换根：用户看到空清单，而数据其实都在原地。
 */
export function isRootDir(dir: string): boolean {
  return (
    looksLikeOurConfig(path.join(dir, "config.json")) ||
    looksLikeOurConfig(path.join(dir, "config.json.bak"))
  );
}

/** 安装模式数据根：%APPDATA%\claude-fast（Windows）/
 *  ~/Library/Application Support/claude-fast（macOS）。
 *  安装包模式下 exe 位于 Program Files（只读），用户数据统一放这里。 */
export function appDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let base: string;
  if (platform === "win32") {
    base = env.APPDATA ?? "";
  } else if (platform === "darwin") {
    base = path.join(env.HOME ?? "", "Library", "Application Support");
  } else {
    base = env.HOME ?? "";
  }
  if (base === "") {
    // 环境变量缺失时退回 exe 同层子目录：绝对路径，且位于子目录、不在 exe 的祖先链上，
    // 下次启动不会被 isRootDir 当成便携根；exe 路径也取不到时用系统临时目录兜底。
    const fallback = process.execPath ? path.dirname(process.execPath) : os.tmpdir();
    return path.join(fallback, "claude-fast");
  }
  return path.join(base, "claude-fast");
}

/** 便携根查找：从 start 起向上最多 6 级，返回首个满足 `isRootDir` 的目录。
 *  抽成独立函数是为了可测——`resolveRootDir` 的起点是 exe 所在目录，单测控制不了，
 *  而这个循环的**深度**与「首个命中即返回」语义恰恰最该被测。 */
export function resolveRootFrom(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (isRootDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface RootResolution {
  root: string;
  /** true = 安装模式（找不到便携标记，用了 %APPDATA%） */
  installMode: boolean;
}

/**
 * 数据根解析结果**进程内缓存**（按 exe 路径分键，生产环境等价于单例）。
 * 根在进程生命周期内不变，缓存有两个必要理由：
 * ① 判定是 read+parse 级，单次瞬态读失败（杀软保存后独占扫描 / 云盘占位文件未水合 /
 *    网络盘瞬断）会让同一会话内不同命令落到**不同的根**——load 读到空清单、save 写进
 *    另一个目录，表现为「清单自己清空又自己回来」；
 * ② 避免每条命令都向上扫祖先目录并读文件。
 */
const ROOT_CACHE = new Map<string, RootResolution>();

/** 清空数据根缓存（仅单测用；生产环境根不变，不要调用） */
export function resetRootCache(): void {
  ROOT_CACHE.clear();
}

function resolveRootUncached(
  exePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): RootResolution {
  const exeDir = path.dirname(path.resolve(exePath));
  const portable = resolveRootFrom(exeDir);
  if (portable !== null) {
    // 模式判定必须在查找现场做：便携根通常是 exe 的**祖先**目录，
    // 「root != exeDir」恒真，判不出模式
    return { root: portable, installMode: false };
  }
  const app = appDataRoot(platform, env);
  try {
    // 现场创建数据根本身，保证首次 saveConfig 有目录可写
    fs.mkdirSync(app, { recursive: true });
  } catch {
    // 创建失败时仍返回该目录（后续写操作会报具体错误）
  }
  return { root: app, installMode: true };
}

/** 定位数据根目录（双模式）：便携模式（exe 向上 6 级找数据根标记）→ 安装模式回退。 */
export function resolveRootDir(
  exePath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): RootResolution {
  const key = `${path.resolve(exePath)}\u0000${platform}\u0000${env.APPDATA ?? ""}\u0000${env.HOME ?? ""}`;
  const hit = ROOT_CACHE.get(key);
  if (hit) return hit;
  const r = resolveRootUncached(exePath, platform, env);
  ROOT_CACHE.set(key, r);
  return r;
}

/** Claude Code 项目目录（会话 jsonl 所在）：`<Claude 数据目录>/projects`。
 *  优先级：
 *  1. `CLAUDE_CONFIG_DIR` 环境变量（官方支持的自定义数据目录）；
 *  2. 平台默认——Claude Code CLI 的规范路径 `~/.claude/projects` 优先；
 *     macOS 后备：`~/Library/Application Support/Claude/projects`
 *     （Claude Desktop 内置 code 的会话目录，仅当 ~/.claude 缺失且此处存在时用）。 */
export function claudeProjectsDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cfg = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  if (cfg) return path.join(cfg, "projects");
  const home = platform === "win32" ? (env.USERPROFILE ?? "") : (env.HOME ?? "");
  if (platform === "darwin") {
    // CLI 规范路径优先（~/.claude 若是指向 Desktop 数据目录的 symlink，两处等价）
    const cli = path.join(home, ".claude", "projects");
    if (statIsDir(cli)) return cli;
    // 后备：Claude Desktop 内置 code 的会话目录
    const desktop = path.join(home, "Library", "Application Support", "Claude", "projects");
    if (statIsDir(desktop)) return desktop;
    return cli;
  }
  return path.join(home, ".claude", "projects");
}
