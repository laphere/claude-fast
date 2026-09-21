/** 剪贴板里若放着**图片文件**（资源管理器「复制」），返回其路径；否则 null。
 *  移植自 embedded-terminal 分支 src-tauri/src/clipboard_image.rs（Win32 CF_HDROP +
 *  DragQueryFileW → Electron clipboard 读同一份 CF_HDROP 字节自己解）。
 *
 *  cmd 里的 Ctrl+V 能贴图，是 conhost 把文件路径当文本塞进了输入流——内嵌终端
 *  的 xterm 不做这件事（浏览器 paste 对文件列表不带文本），而 claude 自己读剪贴板
 *  的两条路也都不认文件列表（①位图路 ContainsImage() 答 False；②路径路用纯
 *  PowerShell 的 Get-Clipboard，PS 5.1 对文件列表返回空），于是报
 *  `No image found in clipboard. Use alt+v to paste images.`。本模块补的就是 conhost
 *  那一步：前端拿到路径后用 `Terminal.paste()` 当**粘贴文本**送进 PTY（claude 见到
 *  图片路径即转成 [Image #1]）。只读，不动用户剪贴板。
 *  白名单与 claude 源码正则严格一致（png/jpg/jpeg/gif/webp），bmp/tiff/heic 不送
 *  （送过去 claude 也不会转）。macOS 无需处理（Finder 复制放的是 furl，claude 的
 *  osascript 路径路本就能读到）——非 win32 恒 null。 */
import { clipboard } from "electron";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** 解析 CF_HDROP 的 DROPFILES 字节，取出文件路径列表。
 *  布局：DWORD pFiles（文件区偏移，通常 20）| POINT pt（8B）| BOOL fNC（4B）|
 *  BOOL fWide（4B）| 文件区（fWide≠0 为 UTF-16LE，双 \0 结尾的路径串列表，
 *  整体再以一个空串收尾）。pFiles < 20 或越界 = 不是合法 DROPFILES。 */
export function parseDropFiles(buf: Uint8Array): string[] {
  if (buf.length < 20) return [];
  const pFiles = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
  const fWide = buf[16] | (buf[17] << 8) | (buf[18] << 16) | (buf[19] << 24);
  if (pFiles < 20 || pFiles >= buf.length) return [];
  const body = buf.subarray(pFiles);
  if (fWide !== 0) {
    // UTF-16LE：按 \u0000 切，末尾的空串丢掉
    let s = "";
    for (let i = 0; i + 1 < body.length; i += 2) {
      s += String.fromCharCode(body[i] | (body[i + 1] << 8));
    }
    return s.split("\u0000").filter((p) => p !== "");
  }
  // ANSI 变体（fWide=0）：按字节 \0 切
  const text = Buffer.from(body).toString("latin1");
  return text.split("\u0000").filter((p) => p !== "");
}

/** 取剪贴板文件列表里**首个**图片文件的路径；没有返回 null。
 *  Chromium 的剪贴板把 CF_HDROP 暴露为 "FileNameW" 格式（Windows 侧）——
 *  列表里没有它就说明剪贴板不是文件复制（位图/文本都轮不到这里）。 */
export function clipboardImagePath(): string | null {
  if (process.platform !== "win32") return null;
  const formats = clipboard.availableFormats();
  if (!formats.includes("FileNameW")) return null;
  const files = parseDropFiles(new Uint8Array(clipboard.readBuffer("FileNameW")));
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    const ext = dot >= 0 ? f.slice(dot + 1).toLowerCase() : "";
    if (IMAGE_EXTS.has(ext)) return f;
  }
  return null;
}
