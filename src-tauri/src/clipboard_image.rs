//! 剪贴板图片路径提取：把「复制的图片文件」补成 claude 能吃的**粘贴文本**。
//!
//! 背景（2026-09-20 实测）：
//! 在 cmd 里复制一个图片文件、Ctrl+V 到 claude 会话里是能贴出 `[Image #1]` 的
//! ——因为 **Ctrl+V 由 conhost（控制台宿主）处理**：它读到剪贴板里的 CF_HDROP
//! 文件列表后，把**文件路径以文本形式**塞进输入流，claude 收到一段「粘贴文本」，
//! 识别出这是图片路径就转成图片附件。
//!
//! 而内嵌终端里 Ctrl+V 走 xterm.js 的 paste：浏览器的 paste 事件对 CF_HDROP
//! **不带任何文本**，一个字节都送不出去；claude 自己读剪贴板的两条路也都不认
//! 文件列表（①位图路 `ContainsImage()` 答 False；②路径路用的是纯
//! `powershell -NoProfile -Command Get-Clipboard`，PS 5.1 对文件列表返回空），
//! 于是报 `No image found in clipboard. Use alt+v to paste images.`。
//!
//! 本模块做的就是 conhost 那一步的等价物：读出文件列表里首个图片文件的路径，
//! 交给前端**当作粘贴文本**送进 PTY（`Terminal.paste()`，会自动按 bracketed
//! paste 模式包裹）。**不碰用户剪贴板**——实测把路径作为粘贴文本送进去，claude
//! 立刻转成 `[Image #1]`。
//!
//! macOS 无需处理：claude 读剪贴板对 Finder 复制用的是 `osascript … «class furl»`，
//! 本就返回 POSIX 路径。

/// claude 认的图片扩展名——与其源码正则 `\.(png|jpe?g|gif|webp)$` **严格一致**。
/// 白名单之外（bmp/tiff/heic…）即使把路径送进去 claude 也不会转成图片，故不处理。
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// 该路径是否是 claude 能识别的图片（扩展名白名单，大小写不敏感）
fn is_supported_image_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 从文件列表里挑出首个图片文件（纯逻辑，跨平台可测）
fn pick_image_file<S: AsRef<str>>(files: &[S]) -> Option<&str> {
    files
        .iter()
        .map(|f| f.as_ref())
        .find(|p| is_supported_image_path(p))
}

/// 剪贴板里首个图片文件的路径；没有（或读不到）返回 None。
/// 失败一律当作「无」——调用方退回到普通粘贴键，不阻塞、不报错。
pub fn image_file_path_in_clipboard() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let files = read_clipboard_files()?;
        Ok(pick_image_file(&files).map(str::to_string))
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// 前端在发送粘贴键之前调用；返回 Some(路径) 时前端把路径当粘贴文本送进终端。
/// 剪贴板可能被别的进程短暂占用（内部有重试 + sleep），故走阻塞线程池，不卡 UI。
#[tauri::command]
pub(crate) async fn clipboard_image_path() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(image_file_path_in_clipboard)
        .await
        .unwrap_or_else(|e| Err(format!("读取剪贴板任务异常退出：{e}")))
}

// ---------------- Windows 剪贴板 ----------------

/// CF_HDROP 是稳定的 Win32 常量；windows-sys 把 CF_* 放在 Ole 模块里，
/// 为一个值引入整个 feature 不划算，就地定义（数值取自 Win32 头文件）
#[cfg(windows)]
const CF_HDROP: u32 = 15;

/// `DragQueryFileW` 取文件总数的哨兵索引
#[cfg(windows)]
const DRAG_QUERY_FILE_COUNT: u32 = 0xFFFF_FFFF;

/// 打开剪贴板：用户刚复制完，剪贴板可能仍被别的进程短暂持有 → 重试若干次。
/// 全程最长 ~200ms，故只应在阻塞线程池中调用。
#[cfg(windows)]
fn open_clipboard_with_retry() -> bool {
    use windows_sys::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..10 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

/// 读取剪贴板文件列表（CF_HDROP）；剪贴板里没有文件列表时返回空表。
/// 注意：`GetClipboardData` 的句柄只在 `CloseClipboard` 前有效，故路径必须在闭内取出。
/// **只读**——不调用 EmptyClipboard/SetClipboardData，用户剪贴板一字不改。
#[cfg(windows)]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable,
    };
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    if !open_clipboard_with_retry() {
        return Err("打开剪贴板失败（被其它程序占用）".to_string());
    }
    let files = (|| -> Vec<String> {
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
            return Vec::new();
        }
        let hdrop = unsafe { GetClipboardData(CF_HDROP) };
        if hdrop.is_null() {
            return Vec::new();
        }
        let count = unsafe { DragQueryFileW(hdrop, DRAG_QUERY_FILE_COUNT, std::ptr::null_mut(), 0) };
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            // cch=0 时返回该路径所需缓冲长度（不含结尾 NUL）
            let len = unsafe { DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0) };
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let copied = unsafe { DragQueryFileW(hdrop, i, buf.as_mut_ptr(), buf.len() as u32) };
            if copied == 0 {
                continue;
            }
            buf.truncate(copied as usize);
            out.push(String::from_utf16_lossy(&buf));
        }
        out
    })();
    unsafe { CloseClipboard() };
    Ok(files)
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_whitelisted_image_extensions() {
        // 白名单与 claude 源码正则 \.(png|jpe?g|gif|webp)$ 一致
        assert!(is_supported_image_path(r"C:\Users\a\Desktop\shot.png"));
        assert!(is_supported_image_path(r"C:\a\b.JPG"));
        assert!(is_supported_image_path(r"C:\a\b.jpeg"));
        assert!(is_supported_image_path("/Users/a/b.gif"));
        assert!(is_supported_image_path(r"C:\a\b.WebP"));
    }

    #[test]
    fn rejects_non_whitelisted_or_malformed_paths() {
        // bmp/tiff/heic 不在 claude 白名单内：送进去也不会变成图片，必须拒绝
        assert!(!is_supported_image_path(r"C:\a\b.bmp"));
        assert!(!is_supported_image_path(r"C:\a\b.tiff"));
        assert!(!is_supported_image_path(r"C:\a\b.heic"));
        assert!(!is_supported_image_path(r"C:\a\b.png.txt"));
        assert!(!is_supported_image_path(r"C:\a\noext"));
        assert!(!is_supported_image_path(""));
    }

    #[test]
    fn picks_first_image_among_multiple_files() {
        let files = vec![
            r"C:\a\notes.txt".to_string(),
            r"C:\a\doc.pdf".to_string(),
            r"C:\a\pic.png".to_string(),
            r"C:\a\other.jpg".to_string(),
        ];
        assert_eq!(pick_image_file(&files), Some(r"C:\a\pic.png"));
    }

    #[test]
    fn picks_nothing_when_no_image_present() {
        let files = vec![r"C:\a\notes.txt".to_string(), r"C:\a\raw.bmp".to_string()];
        assert_eq!(pick_image_file(&files), None);
        let empty: Vec<String> = Vec::new();
        assert_eq!(pick_image_file(&empty), None);
    }
}
