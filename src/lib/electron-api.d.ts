// preload（electron/preload.ts）经 contextBridge 暴露的桥接 API 类型声明。
// 类型与 `electron/ipc-contract.ts` 共用同一张表——通道名与 payload 在编译期对齐，
// 运行期还有 preload 的白名单兜底。渲染进程除此以外没有任何 Node/远程能力。
import type { IpcChannel, IpcContract } from "../../electron/ipc-contract";

export interface ClaudeFastBridge {
  /** 通道级调用（`src/lib/api.ts` 在此之上复刻 Tauri 版的函数面） */
  invoke: <K extends IpcChannel>(channel: K, payload: IpcContract[K]) => Promise<unknown>;
  /** 订阅某个对话 token 的事件流；返回取消订阅函数 */
  onChatEvent: (token: string, cb: (event: unknown) => void) => () => void;
  /** 订阅某个终端 token 的输出字节流（Uint8Array）；返回取消订阅函数 */
  onPtyData: (token: string, cb: (chunk: Uint8Array) => void) => () => void;
  /** 订阅某个终端 token 的退出事件（code 为 null = 被信号终止）；返回取消订阅函数 */
  onPtyExit: (token: string, cb: (code: number | null) => void) => () => void;
  /** 订阅窗口关闭请求（主进程拦截 close 后转发）；返回取消订阅函数 */
  onCloseRequested: (cb: () => void) => () => void;
  /** 订阅窗口获得焦点；返回取消订阅函数 */
  onWindowFocused: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    claudeFast: ClaudeFastBridge;
  }
}

export {};
