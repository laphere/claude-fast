// 本机 Claude Code 版本检查与一键升级（移植自 v2.0.0 的 src-tauri/src/claude_update.rs）
//
// 设计要点（与 Rust 版逐语义对齐）：
// - 纯逻辑（semver 比较 / 候选路径择优 / 版本输出解析 / npm 响应解析 /
//   升级脚本构造）与 IO（spawn / fetch / 文件）彻底分离，纯函数单独导出便于单测。
// - 所有 IO 都走 IoDeps 注入：单测用假执行器，绝不真跑 npm / 网络；
//   主代理接线时传默认 nodeIo 即可。
// - 探测一律 windowsHide: true，防后台命令闪黑窗（与 platform.ts 的 checkClaude 一致）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// npm 包名（Claude Code 官方发行包）
const NPM_PACKAGE = "@anthropic-ai/claude-code";
// 查询 npm registry 的端点（只含 latest 的 package.json，稳定通道，预发布不误报）
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;

// 各阶段超时（毫秒）。定位 / 版本探测给短超时避免 UI 卡住；
// 升级给足 10 分钟（npm 全局安装可能很慢）。
const LOCATE_TIMEOUT_MS = 3 * 1000;
const VERSION_TIMEOUT_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const UPGRADE_TIMEOUT_MS = 600 * 1000;
// 升级输出回传前端的尾部截断长度（按字符，避免中文切成乱码半字）
const OUTPUT_TAIL_CHARS = 2000;

// ================ 对外返回形状（与 src/types.ts 的 ClaudeUpdateStatus 逐字段一致） ================

/** 本机 Claude Code 版本检查结果（camelCase，前端原样消费） */
export interface ClaudeUpdateStatus {
  /** 本地 claude 版本（未安装/探测失败为 null） */
  currentVersion: string | null;
  /** npm 最新稳定版（网络失败为 null） */
  latestVersion: string | null;
  /** latest 严格大于 current 才为 true（预发布/本地抢跑不误报） */
  updateAvailable: boolean;
  /** 本地探测失败原因 */
  currentError: string | null;
  /** 网络查询失败原因 */
  latestError: string | null;
  /** 命中的 claude 可执行路径（诊断用） */
  installPath: string | null;
}

// ================ IoDeps：所有副作用都经此注入 ================

/** 一条命令的执行结果（合并 stdout/stderr 后由调用方按需解析） */
export interface SpawnResult {
  /** 退出码；进程被杀/启动失败为 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被强制终止 */
  timedOut: boolean;
}

/** 升级脚本执行结果 */
export interface UpgradeRunResult {
  /** 退出码为 0 视为成功 */
  success: boolean;
  timedOut: boolean;
}

/** 全部 IO 依赖；主代理接线时传默认 nodeIo，单测传假实现 */
export interface IoDeps {
  platform: NodeJS.Platform;
  /** 执行命令（定位/版本探测这类小体量输出走管道），带超时与 windowsHide */
  run(
    cmd: string,
    args: string[],
    opts: { timeoutMs: number; windowsHide: boolean },
  ): Promise<SpawnResult>;
  /** GET 文本（npm registry） */
  fetchText(url: string): Promise<string>;
  /** 执行升级脚本：输出重定向到 outPath 文件（避免大输出撑满管道死锁），带超时 */
  runUpgradeScript(
    scriptPath: string,
    outPath: string,
    platform: NodeJS.Platform,
    timeoutMs: number,
  ): Promise<UpgradeRunResult>;
  /** 文件存在性（siblingOrPathNpm 找同目录 npm 用） */
  fileExists(p: string): boolean;
  /** 系统临时目录 */
  tmpDir(): string;
  /** 当前进程 pid（临时文件名去重） */
  pid(): number;
  writeFile(p: string, text: string): void;
  readFile(p: string): string | null;
  removeFile(p: string): void;
}

// 默认 node 实现：主代理接线用，单测不触及（注入假实现覆盖）
const nodeIo: IoDeps = {
  platform: process.platform,

  run(cmd, args, opts) {
    return new Promise<SpawnResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          windowsHide: opts.windowsHide,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        // spawn 抛错（如命令不存在）= 启动失败，按失败返回
        resolve({ code: null, stdout: "", stderr: String(e), timedOut: false });
        return;
      }
      let stdout = "";
      let stderr = "";
      let done = false;
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      const finish = (r: SpawnResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      // 轮询式超时：超时即 kill，避免子进程挂起拖累 UI
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已退出：忽略
        }
        finish({ code: null, stdout, stderr, timedOut: true });
      }, opts.timeoutMs);
      child.on("error", (e) =>
        finish({ code: null, stdout, stderr: String(e), timedOut: false }),
      );
      child.on("close", (code) =>
        finish({ code: code ?? null, stdout, stderr, timedOut: false }),
      );
    });
  },

  async fetchText(url) {
    // AbortSignal.timeout 统一管住网络超时，避免 UI 卡在网络
    const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.text();
  },

  runUpgradeScript(scriptPath, outPath, platform, timeoutMs) {
    // 输出重定向到文件而非管道：npm 安装输出体量不可控，管道会填满死锁，
    // 文件不会。windowsHide 保证全程静默不弹窗口。
    return new Promise<UpgradeRunResult>((resolve) => {
      let fd: number;
      try {
        fd = fs.openSync(outPath, "w");
      } catch (e) {
        resolve({ success: false, timedOut: false });
        return;
      }
      const cmd = platform === "win32" ? "cmd" : "/bin/sh";
      const args = platform === "win32" ? ["/D", "/S", "/C", scriptPath] : [scriptPath];
      const child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
      let done = false;
      const finish = (r: UpgradeRunResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已退出：忽略
        }
        finish({ success: false, timedOut: true });
      }, timeoutMs);
      child.on("error", () => finish({ success: false, timedOut: false }));
      child.on("close", (code) =>
        finish({ success: code === 0, timedOut: false }),
      );
    });
  },

  fileExists: (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
  tmpDir: () => os.tmpdir(),
  pid: () => process.pid,
  writeFile: (p, text) => fs.writeFileSync(p, text, "utf8"),
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  removeFile: (p) => {
    try {
      fs.unlinkSync(p);
    } catch {
      // best-effort 清理：忽略
    }
  },
};

// ================ 纯函数（可单测，无副作用） ================

/** 从输出文本提取首个 `x.y.z(-后缀)?`（等价 Rust 的 `\d+\.\d+\.\d+(-[\w.]+)?`）。
 *  不引正则依赖，逐字符扫描；脏数据（不足三段）返回 null。 */
export function extractVersion(output: string): string | null {
  let i = 0;
  while (i < output.length) {
    const ch = output[i];
    if (ch >= "0" && ch <= "9") {
      const v = tryParseVersionAt(output, i);
      if (v) return v;
    }
    i++;
  }
  return null;
}

function tryParseVersionAt(s: string, start: number): string | null {
  let i = start;
  for (let group = 0; group < 3; group++) {
    const segStart = i;
    while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
    if (i === segStart) return null; // 该段不是数字
    if (group < 2) {
      // 前两段后必须跟 '.'，否则不是合法 x.y.z
      if (i >= s.length || s[i] !== ".") return null;
      i++;
    }
  }
  let end = i;
  // 预发布后缀：'-' 之后是字母/数字/下划线/点
  if (i < s.length && s[i] === "-") {
    let j = i + 1;
    while (
      j < s.length &&
      ((s[j] >= "0" && s[j] <= "9") ||
        (s[j] >= "A" && s[j] <= "Z") ||
        (s[j] >= "a" && s[j] <= "z") ||
        s[j] === "_" ||
        s[j] === ".")
    ) {
      j++;
    }
    if (j > i + 1) end = j; // 至少要有 1 个有效字符才认作后缀
  }
  return s.slice(start, end);
}

/** 预发布标识符：数字段按数值比较且 < 文本段（semver 规范第 11 条）。
 *  用 number 表示纯数字段，string 表示文本段。 */
type PreId = number | string;

/** 拆解 `core(-pre)?`：core 各段 parse 失败按 0（宽容脏数据），预发布段按 `.` 切分、
 *  纯数字段归 number（与 Rust 的 u64 parse 语义一致，含前导零也认数字）。 */
function parseVersion(s: string): { core: number[]; pre: PreId[] } {
  const t = s.trim();
  const dash = t.indexOf("-");
  let coreStr: string;
  let preStr: string | null = null;
  if (dash >= 0) {
    coreStr = t.slice(0, dash);
    preStr = t.slice(dash + 1);
  } else {
    coreStr = t;
  }
  const core = coreStr
    .split(".")
    .map((seg) => {
      const n = parseInt(seg.trim(), 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const pre: PreId[] = [];
  if (preStr !== null) {
    for (const seg of preStr.split(".")) {
      const ts = seg.trim();
      const n = parseInt(ts, 10);
      pre.push(Number.isNaN(n) ? ts : n);
    }
  }
  return { core, pre };
}

function comparePre(a: PreId[], b: PreId[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // 前缀相等时标识符多的一侧更大
    if (y === undefined) return 1;
    const xn = typeof x === "number";
    const yn = typeof y === "number";
    if (xn && yn) {
      if (x !== y) return x < y ? -1 : 1;
    } else if (xn && !yn) {
      return -1; // 数字段 < 非数字段
    } else if (!xn && yn) {
      return 1;
    } else {
      // 两侧都是文本段：按字符串序（ASCII/Unicode 码点序，与现实版本字母序一致）
      if (x < y) return -1;
      else if (x > y) return 1;
    }
  }
  return 0;
}

/** 严格 semver 比较：a > b 返回 1，相等 0，a < b 返回 -1。
 *  core 三段逐位数值比较（缺位补 0）；预发布遵循 semver——无预发布 > 有预发布、
 *  前缀相等时标识符多的一侧更大。「可升级」= compareVersions(latest, current) > 0。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const aEmpty = pa.pre.length === 0;
  const bEmpty = pb.pre.length === 0;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty && !bEmpty) return 1; // 无预发布 > 有预发布
  if (!aEmpty && bEmpty) return -1;
  return comparePre(pa.pre, pb.pre);
}

/** Windows 下按 PATHEXT 语义择优：.exe > .cmd/.bat > 无扩展名；
 *  同级保持 where 原始顺序（首个最小 rank 胜出）；
 *  过滤 WindowsApps 商店别名（执行会弹商店，不能真启动 claude）。 */
export function pickWindowsHit(lines: string[]): string | null {
  const rankOf = (l: string): number => {
    const ext = path
      .extname(l)
      .toLowerCase()
      .replace(/^\./, "");
    if (ext === "exe") return 0;
    if (ext === "cmd" || ext === "bat") return 1;
    if (ext === "") return 2;
    return 3;
  };
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    if (l.includes("WindowsApps")) continue; // 商店别名占位文件，执行会弹商店
    const r = rankOf(l);
    // 严格小于才替换：平局保留首个命中，符合 where 顺序优先
    if (r < bestRank) {
      bestRank = r;
      best = l;
    }
  }
  return best;
}

/** 解析 npm registry `/latest` 响应：取 JSON 的 version 字段；
 *  非法 JSON 或缺字段返回 null（由调用方转成 latestError）。 */
export function parseNpmLatestVersion(body: string): string | null {
  try {
    const json = JSON.parse(body) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

/** 构造定位 claude 的命令：Windows `where claude`，其余 `sh -c "command -v claude"`。 */
export function buildLocateCommand(platform: NodeJS.Platform): {
  cmd: string;
  args: string[];
} {
  if (platform === "win32") return { cmd: "where", args: ["claude"] };
  return { cmd: "/bin/sh", args: ["-c", "command -v claude"] };
}

/** 构造 `--version` 探测命令：Windows 的 .cmd/.bat shim 不能直接 spawn，
 *  须经 `cmd /D /S /C call`；.exe 与无扩展名（含 macOS/Linux）直接执行。 */
export function buildVersionProbeCommand(
  claudePath: string,
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } {
  if (platform === "win32") {
    const ext = path.extname(claudePath).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      return { cmd: "cmd", args: ["/D", "/S", "/C", "call", claudePath, "--version"] };
    }
    return { cmd: claudePath, args: ["--version"] };
  }
  return { cmd: claudePath, args: ["--version"] };
}

/** Windows 升级脚本：.bat 里调 .cmd 必须加 call，否则执行完不返回；
 *  失败兜底 npm 全局安装最新版，最终 errorlevel 透传给退出码；
 *  必须 CRLF（Windows 批处理）。 */
export function buildUpgradeBat(claudePath: string, npmCmd: string): string {
  return (
    `@echo off\r\n` +
    `call "${claudePath}" update\r\n` +
    `if errorlevel 1 call "${npmCmd}" i -g @anthropic-ai/claude-code@latest\r\n` +
    `if errorlevel 1 exit /b %errorlevel%\r\n`
  );
}

/** macOS/Linux 升级命令：单行 sh，`||` 兜底。 */
export function buildUpgradeSh(claudePath: string, npmCmd: string): string {
  return `${shQuote(claudePath)} update || ${shQuote(npmCmd)} i -g @anthropic-ai/claude-code@latest`;
}

/** sh 单引号包裹：成对 `'` 转义为 `'\''`（闭合、转义引号、重开）。 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** npm 兜底命令：优先 claude 同目录的 npm（GUI 启动的进程 PATH 可能不全），
 *  找不到再裸用 PATH 里的 npm。exists 可注入以便单测。 */
export function siblingOrPathNpm(
  claudePath: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const dir = path.dirname(claudePath);
  const candidates =
    platform === "win32"
      ? [path.join(dir, "npm.cmd"), path.join(dir, "npm.exe")]
      : [path.join(dir, "npm")];
  for (const c of candidates) {
    try {
      if (exists(c)) return c;
    } catch {
      // 访问失败：跳过
    }
  }
  return "npm";
}

/** 取字符串尾部 maxChars 个字符（按字符截断，避免中文切成乱码半字）。 */
export function tailChars(s: string, maxChars: number): string {
  const count = [...s].length;
  if (count <= maxChars) return s;
  return [...s].slice(count - maxChars).join("");
}

function firstLine(s: string): string {
  const l = s.split(/\r?\n/)[0];
  return l ? l.trim() : "";
}

// ================ 内部编排 ================

/** 定位本机 claude 可执行：跑定位命令 → 按平台择优。找不到返回 null。 */
async function locateClaude(d: Required<IoDeps>): Promise<string | null> {
  const loc = buildLocateCommand(d.platform);
  const r = await d.run(loc.cmd, loc.args, {
    timeoutMs: LOCATE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (r.timedOut || r.code !== 0) return null;
  const lines = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return d.platform === "win32" ? pickWindowsHit(lines) : lines[0];
}

// ================ 对外导出函数 ================

/** 检查本机 claude 版本 vs npm registry 最新稳定版。
 *  本地探测与网络查询并发（网络慢不拖累本地结果）；任一失败只标记该路错误，
 *  不整体失败。updateAvailable 仅当 latest 严格大于 current 时为 true。 */
export async function claudeUpdateStatus(
  deps: Partial<IoDeps> = {},
): Promise<ClaudeUpdateStatus> {
  const d = { ...nodeIo, ...deps } as Required<IoDeps>;

  // 本地探测：定位 + 执行 --version + 提取版本号
  const probeLocal = async (): Promise<
    { ok: true; version: string; path: string } | { ok: false; error: string }
  > => {
    const claudePath = await locateClaude(d);
    if (!claudePath) return { ok: false, error: "未找到 claude 命令" };
    const probe = buildVersionProbeCommand(claudePath, d.platform);
    const r = await d.run(probe.cmd, probe.args, {
      timeoutMs: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.timedOut) return { ok: false, error: "claude --version 执行超时" };
    if (r.code !== 0)
      return { ok: false, error: `执行 claude --version 失败（退出码 ${r.code}）` };
    const out = `${r.stdout}\n${r.stderr}`;
    const version = extractVersion(out);
    if (!version)
      return {
        ok: false,
        error: `无法从 claude --version 输出解析版本号：${firstLine(out)}`,
      };
    return { ok: true, version, path: claudePath };
  };

  // 网络查询：npm registry /latest
  const queryLatest = async (): Promise<
    { ok: true; version: string } | { ok: false; error: string }
  > => {
    try {
      const body = await d.fetchText(REGISTRY_URL);
      const version = parseNpmLatestVersion(body);
      if (!version)
        return { ok: false, error: "npm registry 响应缺少 version 字段" };
      return { ok: true, version };
    } catch (e) {
      return { ok: false, error: `查询 npm registry 失败：${String(e)}` };
    }
  };

  // 两路并发，互不拖累
  const [local, remote] = await Promise.all([probeLocal(), queryLatest()]);

  const currentVersion = local.ok ? local.version : null;
  const currentError = local.ok ? null : local.error;
  const installPath = local.ok ? local.path : null;
  const latestVersion = remote.ok ? remote.version : null;
  const latestError = remote.ok ? null : remote.error;
  const updateAvailable =
    local.ok && remote.ok && compareVersions(remote.version, local.version) > 0;

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    currentError,
    latestError,
    installPath,
  };
}

/** 一键升级：隐藏窗口执行临时脚本，`claude update` 失败兜底
 *  `npm i -g @anthropic-ai/claude-code@latest`（npm 优先取 claude 同目录兄弟文件），
 *  输出重定向临时文件、回传尾部 2000 字。成功返回提示+尾部；失败/超时抛 Error。 */
export async function claudeRunUpgrade(
  deps: Partial<IoDeps> = {},
): Promise<string> {
  const d = { ...nodeIo, ...deps } as Required<IoDeps>;

  const claudePath = await locateClaude(d);
  if (!claudePath) throw new Error("未找到 claude 命令，无法升级");

  // npm 兜底优先同目录兄弟文件（GUI 进程 PATH 可能不全）
  const npmCmd = siblingOrPathNpm(claudePath, d.platform, d.fileExists);

  const ext = d.platform === "win32" ? "bat" : "sh";
  const scriptPath = path.join(d.tmpDir(), `claude_fast_update_${d.pid()}.${ext}`);
  const outPath = path.join(d.tmpDir(), `claude_fast_update_${d.pid()}.log`);

  // 构造脚本：Windows 走 bat（call + errorlevel 兜底链），其余走 sh（|| 兜底）
  const script =
    d.platform === "win32"
      ? buildUpgradeBat(claudePath, npmCmd)
      : buildUpgradeSh(claudePath, npmCmd);
  d.writeFile(scriptPath, script);

  const result = await d.runUpgradeScript(
    scriptPath,
    outPath,
    d.platform,
    UPGRADE_TIMEOUT_MS,
  );

  // 读回输出尾部（升级输出体量不可控，只回传末尾 2000 字）
  const tail = tailChars(d.readFile(outPath) ?? "", OUTPUT_TAIL_CHARS);

  // best-effort 清理临时文件
  d.removeFile(scriptPath);
  d.removeFile(outPath);

  if (result.timedOut) throw new Error("升级超时（10 分钟），已强制终止");
  if (!result.success)
    throw new Error(`升级命令执行失败，请检查输出：${tail}`.trim());
  return `升级命令执行完成。${tail}`.trim();
}
