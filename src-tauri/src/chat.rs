//! app 内直接对话：托管官方 claude CLI 子进程（stdio stream-json 模式）。
//!
//! 架构对应 cc-haha 的三层能力，改造为 Rust + 官方 CLI：
//! 1. 进程托管层（对应 conversationService.ts）：spawn
//!    `claude --print --input-format stream-json --output-format stream-json
//!    --include-partial-messages`，stdin 发消息、stdout 解析流；
//! 2. 消息翻译层（对应 translateCliMessage / cliMessageParsing / streamBlocks）：
//!    StreamAssembler 把 CLI 原始事件翻译成前端友好的 ChatEvent 增量流；
//! 3. 前端 ChatView（对应 chatStore）：经 Tauri ipc::Channel 接收事件渲染。
//!
//! 新对话/续聊由 CLI 自己写入 ~/.claude/projects 原生 jsonl，
//! 自动进入现有会话列表（list_sessions 扫描），终端也能 resume——与
//! 启动器/查看器完全同源，无需额外持久化。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 控制台子进程不创建新窗口（与 lib.rs 的常量同值，chat.rs 独立声明避免跨模块耦合）
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// claude 可执行文件定位结果缓存（一次解析，整个进程生命周期复用）
static CLAUDE_EXE: OnceLock<Option<String>> = OnceLock::new();

// ---------------- 前端事件协议（经 ipc::Channel 推送） ----------------

/// token 用量（与 lib.rs 的 Usage 对齐，serde camelCase）
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

/// 推送给前端的事件（tag = type，字段 camelCase，与 src/types.ts 的 ChatEvent 对齐）
#[derive(Serialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    /// system(init)：CLI 就绪（真实 session id 以此为准——resume 可能派生新 id）
    SessionReady {
        session_id: String,
        model: Option<String>,
    },
    /// 轮次状态：thinking = 新一轮开始；idle = 本轮结束
    Status { state: String },
    /// 文本/思考块开始（流式增量开始）
    ContentStart { kind: String },
    /// 增量：text / thinking / tool_input（partial_json 片段）
    Delta { kind: String, text: String },
    /// tool_use 块开始（id/name 在 content_block_start 里就绪）
    ToolUseStart {
        tool_use_id: String,
        name: String,
    },
    /// tool_use 块结束（input JSON 组装完成）
    ToolUseComplete {
        tool_use_id: String,
        name: String,
        input: Value,
    },
    /// CLI 回传的工具结果（user 消息里的 tool_result 块）
    ToolResult {
        tool_use_id: String,
        is_error: bool,
        text: String,
    },
    /// assistant 完整消息到达（usage 落账；流式已渲染的内容前端按去重丢弃）
    MessageComplete { usage: ChatUsage },
    /// 权限确认请求（control_request can_use_tool）
    PermissionRequest {
        request_id: String,
        tool_name: String,
        input: Value,
    },
    /// 权限请求被 CLI 取消（control_cancel_request）
    PermissionCancelled { request_id: String },
    /// result：本轮结束（usage 为本轮总计）
    TurnEnd {
        is_error: bool,
        result_text: Option<String>,
        usage: Option<ChatUsage>,
    },
    /// 进程退出（code None = 信号终止；非正常退出附 stderr 诊断尾部）
    Exited {
        code: Option<i32>,
        stderr_tail: Option<String>,
    },
    /// 内部错误（spawn 失败/解析异常等）
    Error { message: String },
}

// ---------------- stdin 载荷构造（纯函数，可测） ----------------

/// 用户消息（官方 stream-json 输入协议）
fn build_user_message(session_id: &str, text: &str) -> Value {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }],
        },
        "parent_tool_use_id": null,
        "session_id": session_id,
    })
}

/// control 请求（set_permission_mode 等，request 部分由调用方定形）
fn build_control_request_with(
    request_id: &str,
    request: Value,
) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    })
}

/// control 请求（interrupt 等，只有 subtype 的简单请求）
fn build_control_request(request_id: &str, subtype: &str) -> Value {
    build_control_request_with(request_id, json!({ "subtype": subtype }))
}

/// 运行中切换权限模式（等价终端里的 Shift+Tab）：CLI 回 control_response 回执，
/// 失败时经翻译层变成 Error 事件推给前端
fn build_set_permission_mode(request_id: &str, mode: &str) -> Value {
    build_control_request_with(
        request_id,
        json!({ "subtype": "set_permission_mode", "mode": mode }),
    )
}

/// 权限响应（allow/deny；deny 时 CLI 把拒绝作为 tool_result 喂回模型，不 abort）。
/// allow 不带 updatedInput = CLI 使用原始 input 原样执行。
fn build_permission_response(request_id: &str, allow: bool) -> Value {
    let inner = if allow {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny", "message": "用户在 claude-fast 中拒绝执行该工具" })
    };
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": inner,
        },
    })
}

/// 权限模式白名单（与官方 CLI `--permission-mode` 取值一致，v2.1.x 共 6 种；
/// 旧版的 "default" 已更名为 "manual"——每个工具都手动确认）
pub const PERMISSION_MODES: [&str; 6] = [
    "manual",
    "auto",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
];

/// spawn 参数向量（纯函数）：新对话 --session-id / 续聊 --resume，
/// 模型为空/缺省时不传 --model（用 CLI 默认）。
/// permission_mode 由调用方保证在 PERMISSION_MODES 内（manual/auto/acceptEdits/
/// plan/bypassPermissions/dontAsk）——manual 每个工具都确认，bypass 不再发
/// can_use_tool 直接执行，plan 只读规划。
fn build_cli_args(
    session_id: &str,
    resume: bool,
    model: Option<&str>,
    permission_mode: &str,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        // 桌面对话依赖增量事件；缺了它只有轮次结束才见到完整消息（cc-haha 同款注释场景）
        "--include-partial-messages".to_string(),
        "--permission-mode".to_string(),
        permission_mode.to_string(),
    ];
    if resume {
        args.push("--resume".to_string());
    } else {
        args.push("--session-id".to_string());
    }
    args.push(session_id.to_string());
    if let Some(m) = model {
        let m = m.trim();
        if !m.is_empty() {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
    }
    args
}

// ---------------- 消息翻译层（StreamAssembler，纯逻辑可测） ----------------

/// 流式期间正在组装的内容块
struct PendingBlock {
    kind: String,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    /// text/thinking 的累计文本，或 tool_use 的 partial_json 累计
    text: String,
}

/// CLI 原始消息 → ChatEvent 的翻译器（每会话一个，跨行维护去重与流式状态）。
/// 对应 cc-haha 的 translateCliMessage + SessionStreamState（简化：无子 agent scope）。
pub struct StreamAssembler {
    /// 已被流式渲染过的 assistant message.id——完整 assistant 消息到达时去重，
    /// 防止同一份内容渲染两遍（cc-haha 的核心去重规则）
    streamed_msg_ids: HashSet<String>,
    /// 当前消息流式中的内容块（key = content block index）
    blocks: BTreeMap<u64, PendingBlock>,
}

impl StreamAssembler {
    pub fn new() -> Self {
        Self {
            streamed_msg_ids: HashSet::new(),
            blocks: BTreeMap::new(),
        }
    }

    /// 翻译一行 CLI stdout 输出。非 JSON 行静默跳过（防御 stdout 混入诊断输出）。
    pub fn translate(&mut self, line: &str) -> Vec<ChatEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match msg.get("type").and_then(Value::as_str) {
            Some("system") => system_ready_events(&msg),
            Some("assistant") => self.translate_assistant(&msg),
            Some("user") => Self::translate_user(&msg),
            Some("stream_event") => self.translate_stream_event(&msg),
            Some("result") => translate_result(&msg),
            Some("control_request") => translate_control_request(&msg),
            Some("control_cancel_request") => {
                vec![ChatEvent::PermissionCancelled {
                    request_id: msg
                        .get("request_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                }]
            }
            Some("control_response") => {
                // CLI 对我们 control_request 的回执：error 子类型要浮出给前端
                let resp = msg.get("response").cloned().unwrap_or(json!({}));
                if resp.get("subtype").and_then(Value::as_str) == Some("error") {
                    vec![ChatEvent::Error {
                        message: format!(
                            "CLI 拒绝请求：{}",
                            resp.get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("未知原因")
                        ),
                    }]
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        }
    }

    fn translate_assistant(&mut self, msg: &Value) -> Vec<ChatEvent> {
        let Some(message) = msg.get("message") else {
            return Vec::new();
        };
        let msg_id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let usage = parse_usage(message.get("usage")).unwrap_or_default();
        // 已流式渲染过 → 只补 usage，不重复产出内容（cc-haha 去重规则）
        if !msg_id.is_empty() && self.streamed_msg_ids.contains(&msg_id) {
            return vec![ChatEvent::MessageComplete { usage }];
        }
        let mut events = Vec::new();
        for block in block_list(message.get("content")) {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        events.push(ChatEvent::ContentStart {
                            kind: "text".into(),
                        });
                        events.push(ChatEvent::Delta {
                            kind: "text".into(),
                            text: text.to_string(),
                        });
                    }
                }
                Some("thinking") => {
                    let text = block
                        .get("thinking")
                        .or_else(|| block.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !text.is_empty() {
                        events.push(ChatEvent::ContentStart {
                            kind: "thinking".into(),
                        });
                        events.push(ChatEvent::Delta {
                            kind: "thinking".into(),
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    events.push(ChatEvent::ToolUseStart {
                        tool_use_id: id.clone(),
                        name: name.clone(),
                    });
                    events.push(ChatEvent::ToolUseComplete {
                        tool_use_id: id,
                        name,
                        input,
                    });
                }
                _ => {}
            }
        }
        events.push(ChatEvent::MessageComplete { usage });
        events
    }

    /// CLI 回传的 user 消息：tool_result 载体（重放/回显场景也走这里）
    fn translate_user(msg: &Value) -> Vec<ChatEvent> {
        let Some(message) = msg.get("message") else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for block in block_list(message.get("content")) {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            events.push(ChatEvent::ToolResult {
                tool_use_id: block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                text: tool_result_text(block),
            });
        }
        events
    }

    fn translate_stream_event(&mut self, msg: &Value) -> Vec<ChatEvent> {
        let Some(event) = msg.get("event") else {
            return Vec::new();
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                // 记录本条 assistant 消息 id：完整消息到达时据此去重
                if let Some(id) = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.streamed_msg_ids.insert(id.to_string());
                }
                vec![ChatEvent::Status {
                    state: "thinking".into(),
                }]
            }
            Some("content_block_start") => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let block = event.get("content_block").cloned().unwrap_or(json!({}));
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        self.blocks.insert(
                            index,
                            PendingBlock {
                                kind: "tool_use".into(),
                                tool_use_id: Some(id.clone()),
                                tool_name: Some(name.clone()),
                                text: String::new(),
                            },
                        );
                        vec![ChatEvent::ToolUseStart {
                            tool_use_id: id,
                            name,
                        }]
                    }
                    Some(kind @ ("text" | "thinking")) => {
                        self.blocks.insert(
                            index,
                            PendingBlock {
                                kind: kind.to_string(),
                                tool_use_id: None,
                                tool_name: None,
                                text: String::new(),
                            },
                        );
                        vec![ChatEvent::ContentStart {
                            kind: kind.to_string(),
                        }]
                    }
                    _ => Vec::new(),
                }
            }
            Some("content_block_delta") => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let delta = event.get("delta").cloned().unwrap_or(json!({}));
                let (kind, text) = match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => ("text", delta.get("text").and_then(Value::as_str)),
                    Some("thinking_delta") => {
                        ("thinking", delta.get("thinking").and_then(Value::as_str))
                    }
                    Some("input_json_delta") => (
                        "tool_input",
                        delta.get("partial_json").and_then(Value::as_str),
                    ),
                    _ => ("", None),
                };
                if let (Some(pending), Some(text)) = (self.blocks.get_mut(&index), text) {
                    pending.text.push_str(text);
                }
                match (kind, text) {
                    ("", _) | (_, None) => Vec::new(),
                    (kind, Some(text)) => vec![ChatEvent::Delta {
                        kind: kind.to_string(),
                        text: text.to_string(),
                    }],
                }
            }
            Some("content_block_stop") => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let Some(pending) = self.blocks.remove(&index) else {
                    return Vec::new();
                };
                if pending.kind != "tool_use" {
                    return Vec::new();
                }
                // 组装 input JSON（失败降级为空对象，tool_result 仍可凭 id 关联）
                let input = if pending.text.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str::<Value>(&pending.text).unwrap_or(json!({}))
                };
                vec![ChatEvent::ToolUseComplete {
                    tool_use_id: pending.tool_use_id.unwrap_or_default(),
                    name: pending.tool_name.unwrap_or_default(),
                    input,
                }]
            }
            _ => Vec::new(),
        }
    }
}

impl Default for StreamAssembler {
    fn default() -> Self {
        Self::new()
    }
}

/// system(init) → SessionReady（真实 session id / model）
fn system_ready_events(msg: &Value) -> Vec<ChatEvent> {
    if msg.get("subtype").and_then(Value::as_str) != Some("init") {
        return Vec::new();
    }
    vec![ChatEvent::SessionReady {
        session_id: msg
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        model: msg.get("model").and_then(Value::as_str).map(str::to_string),
    }]
}

/// result → turn_end + idle
fn translate_result(msg: &Value) -> Vec<ChatEvent> {
    let is_error = matches!(
        msg.get("subtype").and_then(Value::as_str),
        Some("error_max_turns") | Some("error_during_execution")
    ) || msg
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    vec![
        ChatEvent::TurnEnd {
            is_error,
            result_text: msg
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string),
            usage: parse_usage(msg.get("usage")),
        },
        ChatEvent::Status {
            state: "idle".into(),
        },
    ]
}

/// control_request(can_use_tool) → 权限确认请求
fn translate_control_request(msg: &Value) -> Vec<ChatEvent> {
    let request = msg.get("request").cloned().unwrap_or(json!({}));
    if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
        return Vec::new();
    }
    vec![ChatEvent::PermissionRequest {
        request_id: msg
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        tool_name: request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        input: request.get("input").cloned().unwrap_or(json!({})),
    }]
}

/// content 数组容错提取：数组原样 / 单对象包装成数组 / 缺失返回空
fn block_list(content: Option<&Value>) -> Vec<&Value> {
    match content {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(item @ Value::Object(_)) => vec![item],
        _ => Vec::new(),
    }
}

/// tool_result 的文本：content 可能是字符串，也可能是块数组（[{type:"text",text}]）
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    b.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// usage 防御式解析（与 lib.rs 的 parse_usage 同口径：数字字段为主）
fn parse_usage(v: Option<&Value>) -> Option<ChatUsage> {
    let v = v?;
    let num = |key: &str| v.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(ChatUsage {
        input_tokens: num("input_tokens"),
        output_tokens: num("output_tokens"),
        cache_read_input_tokens: num("cache_read_input_tokens"),
        cache_creation_input_tokens: num("cache_creation_input_tokens"),
    })
}

// ---------------- 进程托管（ChatManager） ----------------

/// 一个活跃对话的子进程（stdin 取出即关 = 让 CLI 收到 EOF 优雅退出）
struct ChatSession {
    child: Child,
    stdin: Option<ChildStdin>,
    /// stderr 诊断尾部（崩溃时随 Exited 事件带给前端）
    stderr_tail: Arc<Mutex<String>>,
}

/// 全部活跃对话（Tauri State）。key = 我们跟踪的会话 id
/// （新对话 = 生成的 uuid；续聊 = 原 session id）。
/// Clone 是廉价引用计数（sessions 为 Arc），可整体 move 进工作线程。
#[derive(Clone, Default)]
pub struct ChatManager {
    sessions: Arc<Mutex<HashMap<String, ChatSession>>>,
}

impl ChatManager {
    /// app 退出时清理：关 stdin 让 CLI 优雅退出，超时强杀
    pub fn stop_all(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (_, mut sess) in sessions.drain() {
            drop(sess.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut exited = false;
            while Instant::now() < deadline {
                match sess.child.try_wait() {
                    Ok(Some(_)) => {
                        exited = true;
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            if !exited {
                let _ = sess.child.kill();
                let _ = sess.child.wait();
            }
        }
    }
}

/// 定位 claude 可执行文件（缓存）。Windows 上 `Command::new("claude")` 只解析
/// .exe 而官方安装常是 .cmd，必须先 `where claude` 拿全路径；macOS 用 command -v。
/// 均限 3 秒超时（PATH 含网络盘时防卡死，与 check_claude 同策略）。
fn resolve_claude_exe() -> Result<String, String> {
    let cached = CLAUDE_EXE.get_or_init(|| resolve_claude_exe_impl().ok());
    cached
        .clone()
        .ok_or_else(|| "未找到 claude 命令（请确认已安装 Claude Code CLI）".to_string())
}

fn resolve_claude_exe_impl() -> Result<String, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("where");
        c.arg("claude");
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "command -v claude"]);
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
    else {
        return Err("未找到 claude 命令（请确认已安装 Claude Code CLI）".to_string());
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("定位 claude 命令超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err("定位 claude 命令失败".to_string()),
        }
    }
    let Ok(output) = child.wait_with_output() else {
        return Err("定位 claude 命令失败".to_string());
    };
    if !output.status.success() {
        return Err("未找到 claude 命令（请确认已安装 Claude Code CLI）".to_string());
    }
    let lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    pick_claude_candidate(&lines)
        .ok_or_else(|| "未找到可执行的 claude 命令（PATH 里只有垫片脚本）".to_string())
}

/// Windows 候选挑选（纯函数，可测）：`where claude` 会把 npm 的三个垫片一起列出
/// ——`claude`（sh 脚本）、`claude.cmd`、`claude.ps1`。CreateProcess 只能直接跑
/// PE 可执行文件，选错会报 os error 193（%1 不是有效的 Win32 应用程序）。
/// 优先 .exe（原生安装）；否则 .cmd/.bat（npm 垫片，Rust std 会经 cmd.exe 托管）；
/// sh/ps1/无扩展名垫片一律跳过。
#[cfg(windows)]
fn pick_claude_candidate(lines: &[String]) -> Option<String> {
    let is = |l: &str, exts: &[&str]| {
        let lo = l.to_lowercase();
        exts.iter().any(|e| lo.ends_with(e))
    };
    lines
        .iter()
        .find(|l| is(l, &[".exe"]))
        .or_else(|| lines.iter().find(|l| is(l, &[".cmd", ".bat"])))
        .cloned()
}

/// macOS/Linux：execve 由内核处理 shebang，`command -v` 的首个结果直接可用
#[cfg(not(windows))]
fn pick_claude_candidate(lines: &[String]) -> Option<String> {
    lines.first().cloned()
}

// ---------------- 单元测试（候选挑选） ----------------

#[cfg(windows)]
#[test]
fn pick_claude_candidate_prefers_exe_over_shims() {
    let lines = vec![
        "C:\\Users\\u\\AppData\\Roaming\\npm\\claude".to_string(),
        "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd".to_string(),
        "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.ps1".to_string(),
    ];
    assert_eq!(
        pick_claude_candidate(&lines),
        Some("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd".to_string())
    );
}

#[cfg(windows)]
#[test]
fn pick_claude_candidate_native_exe_wins() {
    let lines = vec![
        "C:\\Users\\u\\.local\\bin\\claude.exe".to_string(),
        "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd".to_string(),
    ];
    assert_eq!(
        pick_claude_candidate(&lines),
        Some("C:\\Users\\u\\.local\\bin\\claude.exe".to_string())
    );
}

#[cfg(windows)]
#[test]
fn pick_claude_candidate_rejects_shim_only() {
    let lines = vec![
        "/usr/bin/claude".to_string(),
        "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.ps1".to_string(),
    ];
    assert_eq!(pick_claude_candidate(&lines), None);
}

/// 等待子进程退出：最多 timeout，未退出则强杀（阻塞，须在阻塞线程池调用）
fn wait_then_kill(child: &mut Child, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let mut exited = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// 启动对话进程。session_file 为 None = 新对话（生成 uuid）；
/// 有值 = 续聊（复用 validate_session_file 安全校验）。
/// 返回我们跟踪的会话 id（后续 chat_send 等命令凭它寻址）。
#[tauri::command]
pub async fn chat_start(
    app: AppHandle,
    project_path: String,
    session_file: Option<String>,
    permission_mode: Option<String>,
    on_event: Channel<ChatEvent>,
    state: State<'_, ChatManager>,
) -> Result<String, String> {
    let dir = project_path.trim().to_string();
    if !Path::new(&dir).is_dir() {
        return Err("项目路径不存在".to_string());
    }
    let permission_mode = permission_mode.unwrap_or_else(|| "manual".to_string());
    if !PERMISSION_MODES.contains(&permission_mode.as_str()) {
        return Err(format!("未知权限模式：{permission_mode}"));
    }
    let (session_id, resume) = match &session_file {
        Some(file) => {
            let (_, id) = super::validate_session_file(file)?;
            (id, true)
        }
        None => (uuid::Uuid::new_v4().to_string(), false),
    };
    let exe = tauri::async_runtime::spawn_blocking(resolve_claude_exe)
        .await
        .map_err(|e| format!("定位 claude 失败：{e}"))??;
    let args = build_cli_args(&session_id, resume, None, &permission_mode);
    let manager = state.inner().clone();
    let event = on_event;
    let key = session_id.clone();
    let app_handle = app;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cmd = Command::new(&exe);
        cmd.args(&args)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("启动 claude 失败：{e}"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let tail = Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut t) = tail.lock() {
                        t.push_str(&line);
                        t.push('\n');
                        // 只保留尾部 4000 字符诊断（手动找字符边界，防切进 UTF-8 中间）
                        let len = t.len();
                        if len > 4000 {
                            let mut cut = len - 4000;
                            while !t.is_char_boundary(cut) {
                                cut += 1;
                            }
                            t.drain(..cut);
                        }
                    }
                }
            });
        }

        // stdout → 翻译 → Channel
        if let Some(stdout) = stdout {
            let ev = event.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                let mut asm = StreamAssembler::new();
                for line in reader.lines().map_while(Result::ok) {
                    for event in asm.translate(&line) {
                        if ev.send(event).is_err() {
                            return; // 前端已关闭
                        }
                    }
                }
            });
        }

        // 注册会话（key 已存在说明重复调用，先关旧进程）
        if let Some(mut old) = manager
            .sessions
            .lock()
            .unwrap()
            .insert(key.clone(), ChatSession { child, stdin, stderr_tail })
        {
            drop(old.stdin.take());
            let _ = old.child.kill();
            let _ = old.child.wait();
        }

        // 退出监视：轮询 try_wait，退出后发 Exited 事件并移除会话；
        // 会话被 chat_close 移除时本线程静默退出（前端主动关闭无需事件）
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let state = app_handle.state::<ChatManager>();
            let Ok(mut sessions) = state.sessions.lock() else {
                return;
            };
            let Some(sess) = sessions.get_mut(&key) else {
                return;
            };
            match sess.child.try_wait() {
                Ok(Some(status)) => {
                    let Some((_, removed)) = sessions.remove_entry(&key) else {
                        return;
                    };
                    drop(sessions);
                    let tail = removed
                        .stderr_tail
                        .lock()
                        .ok()
                        .map(|t| t.clone())
                        .filter(|t| !t.trim().is_empty());
                    let _ = event.send(ChatEvent::Exited {
                        code: status.code(),
                        stderr_tail: tail,
                    });
                    return;
                }
                Ok(None) => continue,
                Err(_) => {
                    sessions.remove(&key);
                    return;
                }
            }
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("启动对话失败：{e}"))??;

    Ok(session_id)
}

/// 发送用户消息
#[tauri::command]
pub async fn chat_send(
    session_id: String,
    text: String,
    state: State<'_, ChatManager>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }
    let payload = build_user_message(&session_id, &text).to_string();
    write_stdin(&state, &session_id, payload).await
}

/// 中断当前轮（control_request interrupt；CLI 停止后回传 result 结束本轮）
#[tauri::command]
pub async fn chat_interrupt(
    session_id: String,
    state: State<'_, ChatManager>,
) -> Result<(), String> {
    let payload = build_control_request(
        &format!("cf-interrupt-{}", uuid::Uuid::new_v4().simple()),
        "interrupt",
    )
    .to_string();
    write_stdin(&state, &session_id, payload).await
}

/// 运行中切换权限模式（等价终端 Shift+Tab；default/acceptEdits/plan/bypassPermissions）。
/// CLI 回执失败时由翻译层转成 Error 事件推给前端。
#[tauri::command]
pub async fn chat_set_permission_mode(
    session_id: String,
    mode: String,
    state: State<'_, ChatManager>,
) -> Result<(), String> {
    if !PERMISSION_MODES.contains(&mode.as_str()) {
        return Err(format!("未知权限模式：{mode}"));
    }
    let payload = build_set_permission_mode(
        &format!("cf-mode-{}", uuid::Uuid::new_v4().simple()),
        &mode,
    )
    .to_string();
    write_stdin(&state, &session_id, payload).await
}

/// 权限确认响应（allow 不带 updatedInput = CLI 用原始 input）
#[tauri::command]
pub async fn chat_permission_response(
    session_id: String,
    request_id: String,
    allow: bool,
    state: State<'_, ChatManager>,
) -> Result<(), String> {
    let payload = build_permission_response(&request_id, allow).to_string();
    write_stdin(&state, &session_id, payload).await
}

/// 关闭对话：关 stdin 让 CLI 优雅退出（收到 EOF 自行结束并落盘），
/// 最多等 3 秒，未退出则强杀。
#[tauri::command]
pub async fn chat_close(session_id: String, state: State<'_, ChatManager>) -> Result<(), String> {
    // 先取走会话（锁守卫不能跨 await）
    let removed = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(mut s) = removed {
        drop(s.stdin.take());
        tauri::async_runtime::spawn_blocking(move || wait_then_kill(&mut s.child, Duration::from_secs(3)))
            .await
            .ok();
    }
    Ok(())
}

/// 向会话 stdin 写一行 JSON（串行化于 manager 锁内）
async fn write_stdin(
    state: &State<'_, ChatManager>,
    session_id: &str,
    payload: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "会话状态异常".to_string())?;
    let sess = sessions
        .get_mut(session_id)
        .ok_or_else(|| "对话已结束".to_string())?;
    let stdin = sess
        .stdin
        .as_mut()
        .ok_or_else(|| "对话已结束".to_string())?;
    stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("发送失败：{e}"))
}

// ---------------- 单元测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 参数/载荷构造 ----

    #[test]
    fn cli_args_new_session_and_model() {
        let args = build_cli_args("abc", false, Some("sonnet"), "manual");
        assert!(args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        let pos = args.iter().position(|a| a == "--session-id").unwrap();
        assert_eq!(args[pos + 1], "abc");
        assert!(args.windows(2).any(|w| w[0] == "--model" && w[1] == "sonnet"));
        assert!(args.windows(2).any(|w| w[0] == "--permission-mode"));
    }

    #[test]
    fn cli_args_resume_and_blank_model_omitted() {
        let args = build_cli_args("abc", true, Some("  "), "manual");
        assert!(args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--model".to_string()));
        // 基础参数齐备
        for required in ["--print", "--verbose", "--include-partial-messages"] {
            assert!(args.contains(&required.to_string()), "缺 {required}");
        }
    }

    #[test]
    fn cli_args_permission_mode_passed_through() {
        let args = build_cli_args("abc", false, None, "plan");
        let pos = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pos + 1], "plan");
        let args = build_cli_args("abc", false, None, "bypassPermissions");
        assert!(args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn set_permission_mode_payload_shape() {
        let v = build_set_permission_mode("req-1", "acceptEdits");
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req-1");
        assert_eq!(v["request"]["subtype"], "set_permission_mode");
        assert_eq!(v["request"]["mode"], "acceptEdits");
    }

    #[test]
    fn translate_control_response_error_surfaces() {
        let mut asm = StreamAssembler::new();
        assert!(asm
            .translate(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}"#)
            .is_empty());
        let events = asm.translate(
            r#"{"type":"control_response","response":{"subtype":"error","error":"bypass mode not allowed"}}"#,
        );
        assert!(matches!(
            &events[0],
            ChatEvent::Error { message } if message.contains("bypass mode not allowed")
        ));
    }

    #[test]
    fn user_message_payload_shape() {
        let v = build_user_message("sess-1", "你好\n第二行");
        assert_eq!(v["type"], "user");
        assert_eq!(v["session_id"], "sess-1");
        assert_eq!(v["parent_tool_use_id"], Value::Null);
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "text");
        assert_eq!(v["message"]["content"][0]["text"], "你好\n第二行");
        // 可反解
        let round: Value = serde_json::from_str(&v.to_string()).unwrap();
        assert_eq!(round, v);
    }

    #[test]
    fn permission_response_allow_and_deny() {
        let allow = build_permission_response("req-1", true);
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["subtype"], "success");
        assert_eq!(allow["response"]["request_id"], "req-1");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");

        let deny = build_permission_response("req-2", false);
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
        assert!(deny["response"]["response"]["message"]
            .as_str()
            .unwrap()
            .contains("拒绝"));
    }

    // ---- 翻译层：流式序列 ----

    /// 完整流式轮次：init → message_start → text 块 → tool_use 块 → 完整 assistant
    /// （同 msg id 应去重）→ tool_result → result
    #[test]
    fn translate_full_streaming_turn() {
        let mut asm = StreamAssembler::new();
        let mut events = Vec::new();

        events.extend(asm.translate(
            r#"{"type":"system","subtype":"init","session_id":"s-1","model":"claude-x"}"#,
        ));
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}"#,
        ));
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
        ));
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}}"#,
        ));
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
        ));
        // tool_use：start（带 id/name）→ input_json 增量 → stop
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}}"#,
        ));
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}}"#,
        ));
        events.extend(asm.translate(
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#,
        ));

        // system → session_ready；message_start → thinking；text 增量与 tool_use 齐全
        assert!(matches!(events[0], ChatEvent::SessionReady { .. }));
        assert!(matches!(&events[1], ChatEvent::Status { state } if state == "thinking"));
        assert!(matches!(&events[2], ChatEvent::ContentStart { kind } if kind == "text"));
        assert!(matches!(&events[3], ChatEvent::Delta { kind, text } if kind == "text" && text == "你好"));
        assert!(matches!(&events[4], ChatEvent::ToolUseStart { tool_use_id, name } if tool_use_id == "t1" && name == "Bash"));
        let Some(ChatEvent::ToolUseComplete { tool_use_id, input, .. }) = events
            .iter()
            .find(|e| matches!(e, ChatEvent::ToolUseComplete { .. }))
        else {
            panic!("缺 tool_use_complete");
        };
        assert_eq!(tool_use_id, "t1");
        assert_eq!(input["command"], "ls");

        // 完整 assistant（同 msg id m1）→ 只补 usage，不重复产出文本增量
        let assistant = r#"{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"你好"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;
        events.extend(asm.translate(assistant));
        let text_deltas = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::Delta { kind, .. } if kind == "text"))
            .count();
        assert_eq!(text_deltas, 1, "流式后完整消息不应再产出文本增量");
        assert!(matches!(
            events.last(),
            Some(ChatEvent::MessageComplete { .. })
        ));

        // tool_result（content 为块数组形态）
        events.extend(asm.translate(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":[{"type":"text","text":"file1\nfile2"}]}]}}"#,
        ));
        assert!(matches!(
            events.last(),
            Some(ChatEvent::ToolResult { is_error: false, text, .. }) if text == "file1\nfile2"
        ));

        // result → turn_end + idle
        events.extend(asm.translate(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"完成","usage":{"input_tokens":10,"output_tokens":20}}"#,
        ));
        assert!(matches!(
            events[events.len() - 2],
            ChatEvent::TurnEnd { is_error: false, .. }
        ));
        assert!(matches!(&events[events.len() - 1], ChatEvent::Status { state } if state == "idle"));
    }

    #[test]
    fn translate_unstreamed_assistant_renders_full_content() {
        let mut asm = StreamAssembler::new();
        let events = asm.translate(
            r#"{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"thinking","thinking":"想想"},{"type":"text","text":"答案"}]}}"#,
        );
        assert!(matches!(&events[0], ChatEvent::ContentStart { kind } if kind == "thinking"));
        assert!(matches!(&events[1], ChatEvent::Delta { kind, text } if kind == "thinking" && text == "想想"));
        assert!(matches!(&events[2], ChatEvent::ContentStart { kind } if kind == "text"));
        assert!(matches!(&events[3], ChatEvent::Delta { kind, text } if kind == "text" && text == "答案"));
        assert!(matches!(
            events.last(),
            Some(ChatEvent::MessageComplete { .. })
        ));
    }

    #[test]
    fn translate_tool_result_string_content_and_error() {
        let mut asm = StreamAssembler::new();
        let events = asm.translate(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t9","is_error":true,"content":"boom"}]}}"#,
        );
        assert!(matches!(
            events.first(),
            Some(ChatEvent::ToolResult { is_error: true, text, .. }) if text == "boom"
        ));
    }

    #[test]
    fn translate_permission_request_and_cancel() {
        let mut asm = StreamAssembler::new();
        let events = asm.translate(
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"}}}"#,
        );
        assert!(matches!(
            &events[0],
            ChatEvent::PermissionRequest { request_id, tool_name, input }
                if request_id == "r1" && tool_name == "Bash" && input["command"] == "rm -rf /"
        ));
        let events = asm.translate(r#"{"type":"control_cancel_request","request_id":"r1"}"#);
        assert!(matches!(
            &events[0],
            ChatEvent::PermissionCancelled { request_id } if request_id == "r1"
        ));
    }

    #[test]
    fn translate_skips_non_json_and_empty_lines() {
        let mut asm = StreamAssembler::new();
        assert!(asm.translate("").is_empty());
        assert!(asm.translate("not json at all").is_empty());
        assert!(asm.translate(r#"{"type":"control_response"}"#).is_empty());
    }

    #[test]
    fn translate_result_error_variants() {
        let mut asm = StreamAssembler::new();
        let events =
            asm.translate(r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#);
        assert!(matches!(
            events.first(),
            Some(ChatEvent::TurnEnd { is_error: true, .. })
        ));
    }

    #[test]
    fn usage_parsing_defaults() {
        let usage = parse_usage(Some(&json!({"input_tokens": 3}))).unwrap();
        assert_eq!(usage.input_tokens, 3);
        assert_eq!(usage.output_tokens, 0);
        assert!(parse_usage(None).is_none());
    }
}
