// preload：contextBridge 暴露受控 API（渲染进程无 Node 权限，全部经 IPC 白名单通道）。
// 调用受 `electron/ipc-contract.ts` 的类型与 `IPC_CHANNELS` 白名单双重约束：
// 类型在编译期对齐通道与参数，白名单在运行期兜底（渲染层传表外的通道名会被直接拒绝）。
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type IpcChannel, type IpcContract } from "./ipc-contract";

const ALLOWED = new Set<string>(IPC_CHANNELS);

/** 通道级调用（类型由 IpcContract 约束；运行时校验白名单） */
function invoke<K extends IpcChannel>(channel: K, payload: IpcContract[K]): Promise<unknown> {
  if (!ALLOWED.has(channel)) {
    return Promise.reject(new Error(`不允许的 IPC 通道：${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

const api = {
  /** 通用调用入口：`src/lib/api.ts` 在此之上复刻 Tauri 版的函数面 */
  invoke,
  /** 订阅某个对话 token 的事件流；返回取消订阅函数 */
  onChatEvent: (token: string, cb: (event: unknown) => void): (() => void) => {
    const channel = `chat:event:${token}`;
    const handler = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  /** 订阅某个终端 token 的输出字节流（Uint8Array）；返回取消订阅函数 */
  onPtyData: (token: string, cb: (chunk: Uint8Array) => void): (() => void) => {
    const channel = `pty:data:${token}`;
    const handler = (_e: unknown, chunk: Uint8Array) => cb(chunk);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  /** 订阅某个终端 token 的退出事件（code 为 null = 被信号终止）；返回取消订阅函数 */
  onPtyExit: (token: string, cb: (code: number | null) => void): (() => void) => {
    const channel = `pty:exit:${token}`;
    const handler = (_e: unknown, code: number | null) => cb(code);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  /** 订阅窗口关闭请求（主进程拦截 close 后转发）；返回取消订阅函数 */
  onCloseRequested: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("window:close-requested", handler);
    return () => {
      ipcRenderer.removeListener("window:close-requested", handler);
    };
  },
  /** 订阅窗口获得焦点（替代 Tauri 的 onFocusChanged，托盘/单实例唤起也走它） */
  onWindowFocused: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("window:focused", handler);
    return () => {
      ipcRenderer.removeListener("window:focused", handler);
    };
  },
};

contextBridge.exposeInMainWorld("claudeFast", api);

export type ClaudeFastBridge = typeof api;
