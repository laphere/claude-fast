//! App 内嵌终端：portable-pty（Windows ConPTY / Unix openpty）+ 前端 xterm.js。
//!
//! 数据流（设计见 docs/embedded-terminal-plan.md）：
//! - 输出：专用读线程阻塞读 PTY → `ipc::Channel` 二进制 chunk 直传前端
//!   （xterm.js `term.write(Uint8Array)` 自带跨 chunk 的 UTF-8 解码）；
//! - 输入：`pty_write`（前端 term.onData）；
//! - 退出：读线程收到 EOF → `child.wait()` → 全局事件 `pty-exit` 广播
//!   `{ id, code }`，前端按 id 过滤后标记对应 tab「已退出」；
//! - 击杀：`pty_kill` 先 `ChildKiller::kill()`，Windows 再 `taskkill /T /F`
//!   兜底杀整棵进程树——claude.cmd 是 cmd→node 链，只杀直接子进程会留下
//!   node 孤儿（node-pty 同样有此问题，VS Code 也未根治，属 ConPTY 语义）；
//! - app 退出：`RunEvent::Exit` 时 `shutdown_all` 清场，防止残留终端进程。
//!
//! claude 可执行定位复用 claude_update.rs 的 `locate_claude`（.exe > .cmd/.bat
//! > 无扩展名 sh shim，过滤商店别名）；.cmd/.bat 不能直接 spawn，经
//! `cmd /D /S /C call` 拉起——与 claude_update 的版本探测同一套链路。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::CREATE_NO_WINDOW;

/// 单个终端会话：master 供 resize、writer 供输入、child/killer 供击杀与回收
struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

/// 全部活跃终端会话表（`app.manage` 托管；读线程退出时自行清理自己的条目）
#[derive(Default)]
pub struct PtyState {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<PtySession>>>,
}

/// `pty-exit` 事件载荷（camelCase；code 为 None = 被信号终止）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    id: u32,
    code: Option<u32>,
}

fn get_session(state: &PtyState, id: u32) -> Result<Arc<PtySession>, String> {
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .ok_or_else(|| "终端会话不存在或已退出".to_string())
}

/// 在 cwd 拉起 claude 交互终端（resume_session_id 非空时 `--resume <id>` 续会话，
/// 新会话用 new_session_id 走 `--session-id <id>`）。cols/rows 由前端 FitAddon
/// 先量好传入，避免 80×24 起步再 resize 的闪变。
#[tauri::command]
pub(crate) async fn pty_spawn_claude(
    app: AppHandle,
    on_data: Channel,
    cwd: String,
    resume_session_id: Option<String>,
    new_session_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PtyState>();
        spawn_claude(
            &app,
            &state,
            on_data,
            cwd,
            resume_session_id,
            new_session_id,
            cols,
            rows,
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("终端启动任务异常退出：{e}")))
}

/// 前端键盘输入写入 PTY（data 为 UTF-8 字符串，xterm.js onData 原文）
#[tauri::command]
pub(crate) async fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = get_session(&state, id)?;
    let mut writer = session.writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入终端失败：{e}"))
}

/// 终端尺寸变更（前端容器 resize 防抖后调用）
#[tauri::command]
pub(crate) async fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = get_session(&state, id)?;
    let master = session.master.lock().unwrap_or_else(|e| e.into_inner());
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败：{e}"))
}

/// 关闭终端会话：kill 直接子进程 + Windows 杀进程树兜底。
/// 读线程随后收到 EOF，自行 wait/广播/清表——本函数不做清场。
#[tauri::command]
pub(crate) async fn pty_kill(app: AppHandle, id: u32) -> Result<(), String> {
    let state = app.state::<PtyState>();
    kill_session(&state, id)
}

/// 会话参数：续聊 `--resume <id>`；新会话 `--session-id <id>`。
///
/// 新会话为什么要把 id 预先生成好塞给 claude：claude 的会话文件就是 `<会话 id>.jsonl`，
/// 预生成 id 等于**提前知道**这个 tab 对应哪个会话文件，才能把会话名同步到 tab 标题上
/// （新会话起名晚于开 tab，且 claude 的 OSC 标题不带「首条用户消息」这一档——详见
/// lib.rs 的 session_title_for）。不预生成就只能靠"最近新建的文件"猜。
///
/// 两个位置都只放行 uuid 形态：这些值直接拼进命令行，非 uuid 内容可能是任意 flag。
fn session_args(
    resume_session_id: Option<&str>,
    new_session_id: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(id) = resume_session_id {
        validate_session_id(id)?;
        return Ok(vec!["--resume".to_string(), id.to_string()]);
    }
    if let Some(id) = new_session_id {
        validate_session_id(id)?;
        return Ok(vec!["--session-id".to_string(), id.to_string()]);
    }
    Ok(Vec::new())
}

fn spawn_claude(
    app: &AppHandle,
    state: &PtyState,
    on_data: Channel,
    cwd: String,
    resume_session_id: Option<String>,
    new_session_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let claude_path = crate::claude_update::locate_claude()
        .ok_or_else(|| "未找到 claude 命令，无法打开终端".to_string())?;
    let mut args = session_args(resume_session_id.as_deref(), new_session_id.as_deref())?;
    let (file, mut cmd_args) = build_claude_command(&claude_path);
    cmd_args.append(&mut args);
    let mut cmd = CommandBuilder::new(&file);
    cmd.args(&cmd_args);
    cmd.cwd(&cwd);
    // 终端能力声明：前端渲染器就是 xterm.js，按真实 xterm 上报能力，
    // claude 才会走 256 色 + truecolor 渲染路径（ConPTY 原样透传 VT 序列）
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // 剥掉「嵌套 Claude」标记：app 若恰好从某个 claude 会话的终端里启动（如
    // tauri dev 在 Claude Code 里跑），子 claude 继承 CLAUDE_CODE_CHILD_SESSION
    // 会认为自己是不留 transcript 的子会话——jsonl 不落盘，本 app 的会话列表
    // 就永远看不到这个会话。ENTRYPOINT/CLAUDECODE 同理是外层会话的标记。
    cmd.env_remove("CLAUDE_CODE_CHILD_SESSION");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
    cmd.env_remove("CLAUDECODE");
    spawn_session(app, state, on_data, cmd, cols, rows)
}

/// Windows：.cmd/.bat shim 不能直接 spawn，经 `cmd /D /S /C call` 拉起并等待
/// 返回（与 claude_update.rs 的版本探测同链）；.exe 与 macOS/Linux 直接 spawn。
fn build_claude_command(claude_path: &Path) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let ext = claude_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            return (
                "cmd".to_string(),
                vec![
                    "/D".to_string(),
                    "/S".to_string(),
                    "/C".to_string(),
                    "call".to_string(),
                    claude_path.display().to_string(),
                ],
            );
        }
    }
    (claude_path.display().to_string(), Vec::new())
}

fn spawn_session(
    app: &AppHandle,
    state: &PtyState,
    on_data: Channel,
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("打开伪终端失败：{e}"))?;
    let master = pair.master;
    let slave = pair.slave;
    let writer = master
        .take_writer()
        .map_err(|e| format!("获取终端输入通道失败：{e}"))?;
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("获取终端输出通道失败：{e}"))?;
    let child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 claude 失败：{e}"))?;
    // 父进程侧立即丢弃 slave 句柄：子进程退出后读端才能收到 EOF
    drop(slave);

    let killer = child.clone_killer();
    // 会话 id 从 1 起（0 保留，前端可用 0 判断「尚未 spawn」的异常态）
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let session = Arc::new(PtySession {
        master: Mutex::new(master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        killer: Mutex::new(killer),
    });
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, session.clone());

    // 读线程：PTY 输出 → Channel 二进制直传；EOF 后等退出码、广播、清表。
    // app 先 clone 成 owned handle 再进闭包——闭包要 'static，借用的 &AppHandle 逃不出去
    let app = app.clone();
    std::thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let mut reader = reader;
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // 发送失败（窗口已销毁等）也不中断排水：进程还活着就继续读，
                        // 避免输出积压撑爆 ConPTY 管道缓冲拖住子进程
                        let _ = on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                    }
                    Err(_) => break,
                }
            }
            let code = session
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .wait()
                .ok()
                .map(|s| s.exit_code());
            let state = app.state::<PtyState>();
            state
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            // wait 不到退出码（被 kill 清场）也必须广播：前端 tab 不能永远「运行中」
            let _ = app.emit("pty-exit", PtyExitEvent { id, code });
        })
        .map_err(|e| format!("启动终端读线程失败：{e}"))?;
    Ok(id)
}

/// kill 会话。Windows 上**必须先 `taskkill /T /F` 再 ChildKiller**：顺序反了的话，
/// killer.kill() 先杀掉直接子进程（claude.cmd 链里的 cmd.exe），孙进程（claude
/// 本体及其 MCP 子进程）就地变成孤儿、父子链断裂，taskkill /T 再按链找树就找
/// 不到了——实测会留下 claude.exe + 其 MCP node 孤儿继续吃 API。趁树完整先整
/// 树击杀，killer.kill 收尾处理伪控制台句柄（进程已死时它只是 no-op）。
fn kill_session(state: &PtyState, id: u32) -> Result<(), String> {
    let session = get_session(state, id)?;
    #[cfg(windows)]
    {
        if let Some(pid) = session
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process_id()
        {
            kill_process_tree(pid);
        }
    }
    if let Ok(mut k) = session.killer.lock() {
        let _ = k.kill();
    }
    #[cfg(not(windows))]
    let _ = session; // 非 Windows 无杀树兜底，ChildKiller 即全部
    Ok(())
}

/// `taskkill /T /F /PID`：按 pid 杀整棵进程树。输出与失败都丢弃——
/// 这是 kill 之后的兜底清扫，目标进程可能已被上一步杀掉而报「找不到进程」。
#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID"])
        .arg(pid.to_string())
        .creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.output();
}

/// app 退出清场：杀光全部终端会话（读线程随后自行收尾；退出路径上不再等事件）
pub fn shutdown_all(app: &AppHandle) {
    let state = app.state::<PtyState>();
    let ids: Vec<u32> = state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .copied()
        .collect();
    for id in ids {
        let _ = kill_session(&state, id);
    }
}

/// 会话 id 只放行 uuid 形态（hex + 连字符，长度 36）：该值直接拼进
/// `claude --resume <id>`，非 uuid 内容可能是任意 flag
fn validate_session_id(id: &str) -> Result<(), String> {
    let ok = id.len() == 36
        && id.bytes().all(|b| {
            b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b) || b == b'-'
        });
    if ok {
        Ok(())
    } else {
        Err(format!("非法的会话 id：{id}"))
    }
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_accepts_uuid() {
        assert!(validate_session_id("3fa85f64-5717-4562-b3fc-2c963f66afa6").is_ok());
        // 大写 hex 也是合法 uuid
        assert!(validate_session_id("3FA85F64-5717-4562-B3FC-2C963F66AFA6").is_ok());
    }

    #[test]
    fn session_id_rejects_flags_and_junk() {
        // 拼进 --resume 参数位置的注入面：flag、路径、引号、过短过长全部拒绝
        assert!(validate_session_id("--dangerously-skip-permissions").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("../evil").is_err());
        assert!(validate_session_id("3fa85f64-5717-4562-b3fc-2c963f66afa").is_err());
        assert!(validate_session_id("3fa85f64-5717-4562-b3fc-2c963f66afa66").is_err());
        // hex 之外的字母不允许（uuid 只含 hex）
        assert!(validate_session_id("3ga85f64-5717-4562-b3fc-2c963f66afa6").is_err());
    }

    #[test]
    fn session_args_resume_and_new_session() {
        let uid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
        assert_eq!(
            session_args(Some(uid), None).unwrap(),
            ["--resume".to_string(), uid.to_string()]
        );
        assert_eq!(
            session_args(None, Some(uid)).unwrap(),
            ["--session-id".to_string(), uid.to_string()]
        );
        // 续聊优先（两者同时给不是正常路径，但不能拼出两条会话参数）
        assert_eq!(
            session_args(Some(uid), Some(uid)).unwrap().len(),
            2
        );
        assert!(session_args(None, None).unwrap().is_empty());
    }

    #[test]
    fn session_args_rejects_non_uuid_in_both_positions() {
        // 参数位注入面：flag / 路径 / 引号 一律拒
        for bad in ["--dangerously-skip-permissions", "../evil", "", "3fa85f64-5717-4562-b3fc-2c963f66afa"] {
            assert!(session_args(None, Some(bad)).is_err(), "{bad} 应被拒");
            assert!(session_args(Some(bad), None).is_err(), "{bad} 应被拒");
        }
    }

    #[test]
    #[cfg(windows)]
    fn claude_command_uses_cmd_call_chain_for_shims() {
        let (file, args) = build_claude_command(Path::new(
            r"C:\Users\x\AppData\Roaming\npm\claude.cmd",
        ));
        assert_eq!(file, "cmd");
        assert_eq!(args[..4], ["/D", "/S", "/C", "call"]);
        assert_eq!(args[4], r"C:\Users\x\AppData\Roaming\npm\claude.cmd");

        let (file, args) = build_claude_command(Path::new(r"C:\bin\claude.exe"));
        assert_eq!(file, r"C:\bin\claude.exe");
        assert!(args.is_empty());
    }

    #[test]
    #[cfg(not(windows))]
    fn claude_command_spawns_directly_on_unix() {
        let (file, args) = build_claude_command(Path::new("/opt/homebrew/bin/claude"));
        assert_eq!(file, "/opt/homebrew/bin/claude");
        assert!(args.is_empty());
    }
}
