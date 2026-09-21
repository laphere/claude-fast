// App 内嵌终端后端：node-pty（Windows ConPTY / Unix openpty）+ 前端 xterm.js。
// 移植自 embedded-terminal 分支 src-tauri/src/pty.rs（portable-pty → node-pty），
// 语义逐条对齐；宿主差异按 2026-09-21 spike 实测标定
// （.workbuddy/terminal-port-spike/CONCLUSIONS.md）：
// - 输出：node-pty 的 onData 在 Windows 给 Buffer、Unix 给 string——必须统一成
//   Uint8Array 再推渲染层，否则 bold-bright.ts 的字节级扫描在 macOS 上静默失效
//   （只是"粗体不变亮"，不报错）；
// - 输入：node-pty 的 write 走异步 socket、按到达序排队；Electron 的 IPC handler
//   按消息到达次序执行，渲染层同一 tick 连发的写入天然保序——Tauri 侧「专属写线程」
//   解决的「阻塞 handler」与「保序」两个问题在这里都不存在，不再需要队列；
// - kill：Windows **先 `taskkill /PID <pid> /T /F`（等它跑完）再 pty.kill()**。
//   node-pty 自己的 kill（Windows GetConsoleProcessList+process.kill / Unix SIGHUP）
//   不等价于杀树：claude.cmd 是 cmd→node 链，只杀直接子进程会留 claude/MCP 孤儿
//   持续吃 API（Tauri 线实测）。反序会让孙进程孤儿化（树断了 taskkill 找不到）。
//   **本模块的 kill 返回 = 进程树已杀完**——「删会话先杀完进程再动文件」依赖它；
// - 通道：token 由渲染层预生成、先订阅 `pty:data:<token>` 再 invoke——主进程在
//   invoke 应答之前就可能推数据/退出事件（spike 实测首字节 ~13ms），订阅先行则
//   零丢失，Tauri 侧 earlyExits 的记账在这里从根上不需要（同分支 chat 层同款设计）；
// - ⚠️ node-pty 不做 PATH 解析（裸名报 File not found）：cmd 包装用 ComSpec 全路径、
//   claude 走 locate 出来的绝对路径；含空格的单参数会被 node-pty 加引号（cmd /S /C
//   形态直接语法错误）——claude 链的参数全无空格，不受影响。
import { execFile } from "node:child_process";
import path from "node:path";
import * as nodePty from "node-pty";
import { isValidUuid } from "./mangle";
import { buildLocateCommand, pickWindowsHit } from "./claude-update";

export interface PtySpawnOptions {
  /** claude 的工作目录（项目绝对路径） */
  cwd: string;
  /** 续聊的会话 id（uuid）；null = 新会话 */
  resumeSessionId: string | null;
  /** 新会话预生成的会话 id（`--session-id`，uuid） */
  newSessionId: string | null;
  cols: number;
  rows: number;
  /** 渲染层预生成的订阅 token（`pty:data:<token>` / `pty:exit:<token>` 用） */
  token: string;
}

/** 会话参数：续聊 `--resume <id>`；新会话 `--session-id <id>`。
 *  两个位置都只放行 uuid 形态：这些值直接拼进命令行，非 uuid 内容可能是任意 flag。
 *  （对齐 pty.rs 的 session_args / is_valid_uuid——只有一个定义，别处复用 isValidUuid。） */
export function sessionArgs(
  resumeSessionId: string | null,
  newSessionId: string | null,
): string[] {
  if (resumeSessionId !== null) {
    if (!isValidUuid(resumeSessionId)) throw new Error(`非法的会话 id：${resumeSessionId}`);
    return ["--resume", resumeSessionId];
  }
  if (newSessionId !== null) {
    if (!isValidUuid(newSessionId)) throw new Error(`非法的会话 id：${newSessionId}`);
    return ["--session-id", newSessionId];
  }
  return [];
}

/** Windows：.cmd/.bat shim 不能直接 spawn（node-pty 不启 shell），经
 *  `cmd /D /S /C call` 拉起并等待返回；.exe 与 macOS/Linux 直接 spawn。
 *  ⚠️ cmd 用 ComSpec 全路径（node-pty 不做 PATH 解析，裸名 File not found）。 */
export function buildClaudeCommand(
  claudePath: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === "win32") {
    const ext = path.extname(claudePath).slice(1).toLowerCase();
    if (ext === "cmd" || ext === "bat") {
      return {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/D", "/S", "/C", "call", claudePath],
      };
    }
  }
  return { file: claudePath, args: [] };
}

/** 定位本机 claude 可执行（`where` / `command -v` → PATHEXT 择优，过滤商店别名）。
 *  与 claude-update.ts 的探测同一条链（复用 buildLocateCommand / pickWindowsHit）。 */
export async function locateClaude(): Promise<string | null> {
  const loc = buildLocateCommand(process.platform);
  return await new Promise((resolve) => {
    execFile(
      loc.cmd,
      loc.args,
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines.length === 0) return resolve(null);
        resolve(process.platform === "win32" ? pickWindowsHit(lines) : lines[0]);
      },
    );
  });
}

/** 终端能力声明 + 剥「嵌套 Claude」标记（对齐 pty.rs spawn_claude）：
 *  前端渲染器就是 xterm.js，按真实 xterm 上报 TERM/COLORTERM，claude 才会走
 *  256 色 + truecolor 路径；app 从 claude 会话终端里启动时若不剥
 *  CLAUDE_CODE_CHILD_SESSION 等标记，子会话会认为自己是不留 transcript 的
 *  子会话——jsonl 不落盘，会话列表永远看不到它。 */
export function buildSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  return env;
}

// ---------------- 会话表 ----------------

interface PtySession {
  proc: import("node-pty").IPty;
  /** spawn 时取一次存下（kill 杀树用；不事后取——退出回收有竞态） */
  pid: number;
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

export interface PtyHandle {
  id: number;
  pid: number;
}

/** 全部活跃终端会话（读线程退出时自行清理自己的条目）。
 *  id 从 1 起（0 保留，渲染层可用 0 判断「尚未 spawn」的异常态）。 */
export class PtyManager {
  private nextId = 1;
  private sessions = new Map<number, PtySession>();

  /** 在 cwd 拉起 claude 交互终端。输出/退出经回调即时推送（订阅已由渲染层
   *  在 invoke 之前就位，早于应答的事件零丢失）。 */
  async spawnClaude(
    opts: PtySpawnOptions,
    hooks: { onData: (chunk: Uint8Array) => void; onExit: (code: number | null) => void },
  ): Promise<PtyHandle> {
    const claudePath = await locateClaude();
    if (!claudePath) throw new Error("未找到 claude 命令，无法打开终端");
    const { file, args } = buildClaudeCommand(claudePath);
    const argv = [...args, ...sessionArgs(opts.resumeSessionId, opts.newSessionId)];
    const cols = Math.max(2, Math.trunc(opts.cols));
    const rows = Math.max(1, Math.trunc(opts.rows));
    // node-pty 对 cols/rows ≤0 直接抛；FitAddon 量好再传，这里只兜底钳制
    const proc = nodePty.spawn(file, argv, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: buildSpawnEnv(process.env),
      useConpty: true,
    });
    const id = this.nextId++;
    const session: PtySession = {
      proc,
      pid: proc.pid,
      onData: hooks.onData,
      onExit: hooks.onExit,
    };
    this.sessions.set(id, session);
    proc.onData((d) => {
      // Windows Buffer / Unix string → 统一 Uint8Array（见文件头）。
      // typings 只声明了 string，Windows 实际给 Buffer（简报 §4），按 unknown 分叉
      const chunk = d as unknown;
      if (typeof chunk === "string") session.onData(new TextEncoder().encode(chunk));
      else if (chunk instanceof Uint8Array) {
        session.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      session.onExit(exitCode);
    });
    return { id, pid: proc.pid };
  }

  /** 键盘输入写入 PTY（渲染层 term.onData 的原文，UTF-8 字符串）。
   *  不存在的会话（已退出）静默丢弃——迟到的输入没有去处。 */
  write(id: number, data: string): void {
    this.sessions.get(id)?.proc.write(data);
  }

  /** 终端尺寸变更（幂等；渲染层守卫 cols>=2/rows>=1，这里再兜一次） */
  resize(id: number, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || cols < 2 || rows < 1) return;
    try {
      s.proc.resize(cols, rows);
    } catch {
      // 会话正在退出时的 resize：无害，忽略
    }
  }

  /** 关闭终端会话。Windows 杀树契约：taskkill /T /F **跑完**才返回——
   *  删除会话的语义依赖「kill 返回 = 进程树已死」（先杀完进程、再动会话文件）。 */
  async kill(id: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill",
          ["/T", "/F", "/PID", String(s.pid)],
          { windowsHide: true },
          () => resolve(), // 目标可能已退：找不到进程也算杀完
        );
      });
    }
    try {
      s.proc.kill();
    } catch {
      // 进程已死时的 kill 是 no-op，异常忽略
    }
  }

  /** app 退出清场：杀光全部终端会话（各调用方不等待；进程亡即树亡）。 */
  shutdownAll(): void {
    for (const id of [...this.sessions.keys()]) {
      void this.kill(id);
    }
  }
}
