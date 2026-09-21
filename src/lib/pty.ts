/** 内嵌终端（后端 node-pty + ConPTY）前端封装：spawn / 写入 / resize / 击杀。
 *  移植自 embedded-terminal 分支 src/lib/pty.ts（Tauri Channel → IPC 定向推送），
 *  对外签名与语义逐条保留；差异只在传输：
 *  - 输出/退出走 `pty:data:<token>` / `pty:exit:<token>`（token 本模块预生成、
 *    **先订阅再 invoke**）——主进程在 invoke 应答前就会推首字节（spike 实测 ~13ms），
 *    订阅先行则零丢失，Tauri 侧的 earlyExits 记账从根上不需要（同分支 chat 层同款）；
 *  - 退出监听语义不变：onExit 可能在 spawnClaude resolve **之前**到达（秒退进程），
 *    直接透传给调用方（TerminalPane 用 exited 标志钉住状态，不会被后到的 running
 *    覆盖——那条机制原样保留）。exit 到达即自动退订两个监听：后端在进程退出时
 *    清会话表，此后不会再有该 token 的推送，不退订只是白留监听。 */
import { api } from "./api";

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

/** 终端输出推送用的 token 序号（每窗口单调递增 + 时间戳，保证不乱串） */
let ptyTokenSeq = 0;

/** 在 cwd 拉起 claude 交互终端，返回会话 id（后端会话表的数字键）。
 *  输出走 `pty:data:<token>` 定向推送（Uint8Array），退出走 `pty:exit:<token>`。 */
export async function ptySpawnClaude(opts: PtySpawnOptions): Promise<number> {
  const token = `p${++ptyTokenSeq}-${Date.now()}`;
  // 先订阅、后 invoke：主进程早于应答推送的数据/退出事件一个都不丢。
  // 退订收口：exit 到达 / spawn 失败，二者必居其一，监听不会泄漏。
  let stopped = false;
  const stop = { data: () => {}, exit: () => {} };
  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    stop.data();
    stop.exit();
  };
  stop.data = api.onPtyData(token, opts.onData);
  stop.exit = api.onPtyExit(token, (code) => {
    stopAll();
    opts.onExit(code);
  });
  let handle: { id: number; pid: number };
  try {
    handle = await api.ptySpawnClaude(
      opts.cwd,
      opts.resumeSessionId,
      opts.newSessionId ?? null,
      opts.cols,
      opts.rows,
      token,
    );
  } catch (e) {
    stopAll(); // 没起成就退订，不留永远等不到的监听
    throw e;
  }
  // id 一到就交出去接通输入通道：排队中的输入（多半就是 cmd.exe 启动 ~20-30ms
  // 就发的 DSR 应答，不应答则整条链永久卡在第一帧）在这里按序补发；此刻订阅已就位
  opts.onSpawned?.(handle.id);
  return handle.id;
}

/** 新会话的会话 id（uuid v4）。claude 只认 uuid 形态的 `--session-id`，后端也会按
 *  36 位 hex+连字符的形状再校验一遍（backend/pty.ts 的 sessionArgs）。
 *  `crypto.randomUUID` 需要安全上下文：生产渲染层以 file:// 加载，spike 已实测
 *  可用（2026-09-21，Electron 41/Chromium 146）；万一某个平台没有，
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
  api.ptyWrite(id, data).catch(() => {
    /* 会话已退出时的迟到输入，静默丢弃 */
  });

/** 终端尺寸变更 */
export const ptyResize = (id: number, cols: number, rows: number) =>
  api.ptyResize(id, cols, rows).catch(() => {});

/** 结束终端会话（后端先 taskkill /T /F 杀整棵进程树，返回 = 树已杀完） */
export const ptyKill = (id: number) => api.ptyKill(id).catch(() => {});

/** 剪贴板里若放着**图片文件**（资源管理器「复制」），返回其路径；否则 null。
 *  cmd 里的 Ctrl+V 能贴图，是 conhost 把文件路径当文本塞进了输入流——内嵌终端
 *  的 xterm 不做这件事（浏览器 paste 对文件列表不带文本），故由本命令补上这一步：
 *  前端拿到路径后用 `Terminal.paste()` 当作粘贴文本送进 PTY（见 TerminalPane）。
 *  只读，不动用户剪贴板；位图/纯文本/无图片文件时返回 null。 */
export const clipboardImagePath = () =>
  api.clipboardImagePath().catch(() => null);
