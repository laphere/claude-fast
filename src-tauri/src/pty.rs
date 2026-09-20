//! App 内嵌终端：portable-pty（Windows ConPTY / Unix openpty）+ 前端 xterm.js。
//!
//! 数据流（设计见 docs/embedded-terminal-plan.md）：
//! - 输出：专用读线程阻塞读 PTY → `ipc::Channel` 二进制 chunk 直传前端
//!   （xterm.js `term.write(Uint8Array)` 自带跨 chunk 的 UTF-8 解码）；
//! - 输入：`pty_write`（前端 term.onData）**只入队**，由会话的专属写线程串行写进
//!   PTY——单写者、顺序即入队顺序，阻塞只落在那条线程上（见 `PtySession.input`）；
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
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::CREATE_NO_WINDOW;

/// 单个终端会话：master 供 resize、child/killer 供击杀与回收、输入走 `input` 队列
struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// PTY 输入的入队端：`pty_write` 把字节塞进来（非阻塞），由 spawn 时起的
    /// **专属写线程**按序写进 PTY。为什么要独立线程而不是命令体直接写：
    /// ① 管道写会阻塞（对端不读时 `write_all` 一直卡着），直接写就只有两条烂路
    ///    ——要么持着 writer 锁卡住，要么每次调用派一个线程池任务（后者既不保序、
    ///    又把「持锁做阻塞写」留给别人）；
    /// ② 系统终端就是这么做的：iTerm2 把 pty 写派发到**专属串行队列**（因为阻塞主
    ///    队列不可接受），Windows Terminal 也为「持锁期间 WriteFile」专门修过死锁
    ///    （microsoft/terminal PR #16224，4 KiB 输入管道塞满即复现）。结论是同一条：
    ///    写要能自由阻塞，但只阻塞它自己——单写者 + FIFO 队列，顺序不需要额外机制。
    /// 写线程的生命周期**挂在会话上**：会话被清表（读线程 EOF）→ Arc 落地 → 本
    /// Sender 最后一份丢弃 → `recv` 返回 Err → 线程自然收尾，无需单独管理。
    input: Sender<Vec<u8>>,
    /// 子进程 pid，**spawn 时取一次存下**（非 Windows 用不到，只在杀树时读）：
    /// kill 要拿它跑 `taskkill /T /F`，而**不能**为此去锁 `child`——读线程在 EOF
    /// 之后要持着 `child` 锁 `wait()` 等退出码，kill 若也来抢这把锁就成了
    /// 「wait 等进程退出 → 进程等 kill → kill 等锁」的互相等待。顺带也把一把锁
    /// 横跨整个 taskkill 的写法去掉（那个外部进程要跑上百 ms 到数秒；WT 专门修过
    /// 「持锁期间做阻塞的外部调用」，见 microsoft/terminal PR #16224）。
    #[cfg_attr(not(windows), allow(dead_code))]
    pid: Option<u32>,
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

/// 前端键盘输入写入 PTY（data 为 UTF-8 字符串，xterm.js onData 原文）。
/// **只入队、不写**：真正的写由会话的专属写线程串行完成（见 `PtySession.input`）。
/// 所以这里既不占线程池、也不持任何锁——`send` 在无界通道上不会阻塞。
///
/// **刻意不写 `async`**：Tauri 里带 `async` 的命令会被派成独立任务丢进异步运行时
/// （多线程、完成次序不保证），而不带 `async` 的命令由 IPC 处理器**内联、按消息到达
/// 次序**执行。前端 `sendInput`（尤其 `pendingInput` 的补发循环）是在一个 tick 里连发
/// 多个 invoke 的，只有内联执行才能让「入队顺序 = 前端发送顺序」真正成立——这是单写者
/// 队列保序链条上最后一段（也是 docs/embedded-terminal-plan.md §6.9 里记的那个「残留
/// 窗口」）。命令体只有一次短锁 + 一次无界 send，内联不构成 UI 阻塞。
#[tauri::command]
pub(crate) fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = get_session(&state, id)?;
    session
        .input
        .send(data.into_bytes())
        .map_err(|_| "终端已关闭".to_string())
}

/// 终端尺寸变更（前端容器 resize 防抖后调用）。resize 同样是可能阻塞的
/// 管道 IO（持 master 锁），处理同 pty_write。
#[tauri::command]
pub(crate) async fn pty_resize(app: AppHandle, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PtyState>();
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
    })
    .await
    .unwrap_or_else(|e| Err(format!("尺寸调整任务异常退出：{e}")))
}

/// 关闭终端会话：kill 直接子进程 + Windows 杀进程树兜底。
/// 读线程随后收到 EOF，自行 wait/广播/清表——本函数不做清场。
/// 走阻塞线程池：Windows 那步 `taskkill /T /F` 要**等**外部进程跑完（大 claude/node
/// 树上一百 ms 到数秒），直接挂在 async 命令上会钉死一个 tokio worker；调用方本来
/// 就 `await` 它（删会话必须「先杀完进程、再动会话文件」），进池不影响这套顺序。
#[tauri::command]
pub(crate) async fn pty_kill(app: AppHandle, id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PtyState>();
        kill_session(&state, id)
    })
    .await
    .unwrap_or_else(|e| Err(format!("关闭终端任务异常退出：{e}")))
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
    // 会话 id 从 1 起（0 保留，前端可用 0 判断「尚未 spawn」的异常态）。
    // 提到这里取：下面的写线程要用它命名，而线程必须赶在子进程之前起来（失败时
    // 无需清理——那会儿还没有任何东西被拉起来）；失败路径上多耗一个 id 无副作用。
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    /* 专属写线程：PTY 输入的唯一写者，顺序 = 入队顺序（为什么不让命令体直接写，
     *  见 PtySession.input 的注释）。它独占 writer、不持任何锁，卡住也只卡自己。
     *  `recv` 返回 Err = 发送端已全部丢弃（会话被清表，或这里后续步骤失败提前
     *  返回）→ 线程自然收尾，不需要谁去 join 或显式通知。 */
    std::thread::Builder::new()
        .name(format!("pty-writer-{id}"))
        .spawn(move || {
            let mut writer = writer;
            while let Ok(buf) = input_rx.recv() {
                if let Err(e) = writer.write_all(&buf) {
                    // 写失败 = 这个 PTY 的输入侧已废（进程没了 / 管道断了）：跳出，
                    // 队列里剩下的输入一并丢弃。这里是**唯一**的知情点——原先命令体
                    // 直接写时错误还能回给调用方，换成队列后就没有回程了。留一行日志：
                    // **dev 下可见**（debug 构建带控制台），release 无控制台写不出去，
                    // 那种构建里用户侧的信号只剩「PTY 一废 → 读线程 EOF → pty-exit →
                    // tab 显示已退出」。正常关闭不走这条：那是由「会话清表 → 发送端
                    // 全部丢弃 → recv 返回 Err」收尾的。
                    eprintln!("终端 {id} 写入失败，输入通道关闭：{e}");
                    break;
                }
            }
        })
        .map_err(|e| format!("启动终端写线程失败：{e}"))?;
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("获取终端输出通道失败：{e}"))?;
    let child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 claude 失败：{e}"))?;
    // 父进程侧立即丢弃 slave 句柄：子进程退出后读端才能收到 EOF
    drop(slave);

    let killer = child.clone_killer();
    // pid 也在这里取走存下：portable-pty 返回的是 spawn 时记下的那个值，事后取与
    // 当时取同值，提前存纯粹是为了让 kill 不必去锁 `child`（见 PtySession.pid）
    let pid = child.process_id();
    let session = Arc::new(PtySession {
        master: Mutex::new(master),
        input,
        pid,
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
    // pid 取 spawn 时存下的那份，**不碰 `child` 锁**（理由见 PtySession.pid 的注释）
    #[cfg(windows)]
    if let Some(pid) = session.pid {
        kill_process_tree(pid);
    }
    if let Ok(mut k) = session.killer.lock() {
        let _ = k.kill();
    }
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

/// 会话 id 只放行 uuid 形态：该值直接拼进 `claude --resume <id>` / `--session-id <id>`，
/// 非 uuid 内容可能是任意 flag。校验直接复用 lib.rs 的 `is_valid_uuid`——**会话 id 的
/// 格式只能有一处定义**；这里原先另写了一份更松的（只查长度 + hex/连字符，不查位置），
/// 连「36 个连字符」都放行，与 lib.rs 那份早晚分叉。
fn validate_session_id(id: &str) -> Result<(), String> {
    if crate::is_valid_uuid(id) {
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
        // 连字符**位置**也要对（复用 lib.rs 的 is_valid_uuid）：形状看着像、位置全错的
        // 串同样拒绝——上面那份更松的实现会放过这两个
        assert!(validate_session_id("------------------------------------").is_err());
        assert!(validate_session_id("3fa85f6-45717-4562-b3fc-2c963f66afa6").is_err());
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
