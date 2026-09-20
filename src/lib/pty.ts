/** 内嵌终端（后端 portable-pty + ConPTY）前端封装：spawn / 写入 / resize / 击杀 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PtySpawnOptions {
  /** claude 的工作目录（项目绝对路径） */
  cwd: string;
  /** 续聊的会话 id（uuid，即 jsonl 文件名）；null = 新会话 */
  resumeSessionId: string | null;
  /** 新会话（resumeSessionId 为 null 时）预生成的会话 id，经 `--session-id` 交给 claude：
   *  claude 的会话文件就是 `<会话 id>.jsonl`，预生成等于提前知道 tab 对应哪个会话文件，
   *  会话名才能回填到 tab 标题上（见 lib/term-title.ts 与 App 的标题补挂）。 */
  newSessionId?: string | null;
  cols: number;
  rows: number;
  /** PTY 输出二进制 chunk（xterm.js 可直接 write，自带跨 chunk UTF-8 解码） */
  onData: (chunk: Uint8Array) => void;
  /** 进程退出（code 为 null = 被信号终止） */
  onExit: (code: number | null) => void;
  /** 拿到 pty id 的**即时**回调（spawn 应答一到就调，先于函数 resolve）。
   *  调用方要把这之前产生的终端输入缓存起来、在这里按序补发——spawn 的 IPC
   *  往返期间 xterm 就可能要回灌 cmd.exe 的 DSR 应答（理由见 TerminalPane 里
   *  pendingInput 的注释），丢掉会让终端永久黑屏零输出。 */
  onSpawned?: (id: number) => void;
}

/** 在 cwd 拉起 claude 交互终端，返回会话 id。
 *  输出走 ipc::Channel 二进制直传（Tauri 2 的 Channel 对 Raw 载荷在 JS 侧
 *  交付 ArrayBuffer），退出走全局 pty-exit 事件（按 id 过滤，听完即退订）。 */
export async function ptySpawnClaude(opts: PtySpawnOptions): Promise<number> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buf) => {
    if (buf && buf.byteLength > 0) opts.onData(new Uint8Array(buf));
  };
  // 退出监听必须先于 spawn 就位：后端读线程在 pty_spawn_claude 返回之前就已
  // 开跑，秒退的进程（shim 被删、claude 立即报错）会把 pty-exit 发在 invoke
  // 应答之前——Tauri 事件不缓存，晚注册 = 事件发给空气，tab 永远停在「运行中」。
  // 此时 id 还不知道，事件先落 earlyExits 记账，invoke 返回后对号补发。
  const earlyExits: { id: number; code: number | null }[] = [];
  let myId: number | null = null;
  let unlisten: (() => void) | undefined;
  const stop = await listen<{ id: number; code: number | null }>("pty-exit", (e) => {
    if (myId === null) {
      earlyExits.push(e.payload);
      return;
    }
    if (e.payload.id === myId) {
      unlisten?.();
      opts.onExit(e.payload.code);
    }
  });
  unlisten = stop;
  let id: number;
  try {
    id = await invoke<number>("pty_spawn_claude", {
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      newSessionId: opts.newSessionId ?? null,
      cols: opts.cols,
      rows: opts.rows,
      onData: channel,
    });
  } catch (e) {
    stop(); // 没起成就退订，不留一个永远等不到的监听
    throw e;
  }
  myId = id;
  // id 一到就交出去接通输入通道：排队中的输入（多半是 cmd.exe 启动 ~20-30ms
  // 就发的 DSR 应答，不应答则整条链永久卡在第一帧）在这里按序补发；退出监听
  // 此时已就位，不再欠一次 IPC 往返
  opts.onSpawned?.(id);
  const early = earlyExits.find((e) => e.id === id);
  if (early) {
    stop();
    opts.onExit(early.code); // 进程在 invoke 往返期间就已退出：补发退出事件
  }
  return id;
}

/** 新会话的会话 id（uuid v4）。claude 只认 uuid 形态的 `--session-id`，后端也会按
 *  36 位 hex+连字符的形状再校验一遍（见 pty.rs 的 session_args）。
 *  `crypto.randomUUID` 需要安全上下文：Tauri 在 Windows 用 `http://tauri.localhost`、
 *  macOS 用 `tauri://localhost`，两者都被当作可信来源，正常都有；万一某个平台没有，
 *  退到自己拼一个（形状对就够用——它只是文件名，不参与任何密码学用途）。 */
export function newSessionId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const hex = "0123456789abcdef";
  const pick = (n: number) => Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]).join("");
  // 版本位固定 4、变体位固定 a：与 randomUUID 同形状（后端只看 hex 与连字符）
  return `${pick(8)}-${pick(4)}-4${pick(3)}-a${pick(3)}-${pick(12)}`;
}

/** 键盘输入写入终端（data 为 xterm.js onData 的原文） */
export const ptyWrite = (id: number, data: string) =>
  invoke("pty_write", { id, data }).catch(() => {
    /* 会话已退出时的迟到输入，静默丢弃 */
  });

/** 终端尺寸变更 */
export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke("pty_resize", { id, cols, rows }).catch(() => {});

/** 结束终端会话（后端先 kill 直接子进程，再 taskkill /T /F 杀进程树兜底） */
export const ptyKill = (id: number) => invoke("pty_kill", { id }).catch(() => {});

/** 剪贴板里若放着**图片文件**（资源管理器「复制」），返回其路径；否则 null。
 *  cmd 里的 Ctrl+V 能贴图，是 conhost 把文件路径当文本塞进了输入流——内嵌终端
 *  的 xterm 不做这件事（浏览器 paste 对文件列表不带文本），故由本命令补上这一步：
 *  前端拿到路径后用 `Terminal.paste()` 当作粘贴文本送进 PTY（见 TerminalPane）。
 *  只读，不动用户剪贴板；位图/纯文本/无图片文件时返回 null。 */
export const clipboardImagePath = () =>
  invoke<string | null>("clipboard_image_path").catch(() => null);
