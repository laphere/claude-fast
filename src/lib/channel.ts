/** Tauri `Channel<T>` 的等价物：只有一个 `onmessage` 回调槽。
 *  v2.0.0 的 `ChatView` 就是这么用它（`new Channel<ChatEvent>()` → 赋 `onmessage` →
 *  当作 `chatStart` 的最后一个参数传进来），所以这里只需要形状兼容，
 *  真正的订阅由 `api.chatStart` 在内部用 `window.claudeFast.onChatEvent` 完成。 */
export class Channel<T> {
  onmessage?: (message: T) => void;
}
