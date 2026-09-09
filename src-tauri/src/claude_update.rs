//! Claude Code 检查更新与一键升级——移植自 cc-switch 的「本地环境检查」：
//! 当前版本 = 定位命令行实际命中的 claude 可执行后执行 `claude --version`；
//! 最新版本 = npm registry 的 `/latest` 端点（cc-switch 取全量文档的
//! dist-tags.latest 并为抢跑通道纳入 next，本处稳定通道等价简化）；
//! 升级 = 隐藏窗口执行锚定绝对路径的 `claude update`，失败兜底
//! `npm i -g @anthropic-ai/claude-code@latest`（cc-switch 的 WindowsBatch 白名单语义）。

use serde::Serialize;
use std::cmp::Ordering;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::CREATE_NO_WINDOW;

/// npm 包名（Claude Code 官方发行包）
const NPM_PACKAGE: &str = "@anthropic-ai/claude-code";
/// 查询 npm registry 的超时（与 model_fetch 的 FETCH_TIMEOUT_SECS 一致）
const FETCH_TIMEOUT_SECS: u64 = 15;
/// `where` / `command -v` 定位超时（与 check_claude 的 3 秒同款）
const LOCATE_TIMEOUT_SECS: u64 = 3;
/// `claude --version` 超时——npm shim 要拉起 node，冷启动可能数秒，放宽到 10 秒
const VERSION_TIMEOUT_SECS: u64 = 10;
/// 升级命令超时——npm 全局安装可能很慢，给足 10 分钟
const UPGRADE_TIMEOUT_SECS: u64 = 600;
/// 升级输出回传前端的尾部截断长度（按字符）
const OUTPUT_TAIL_CHARS: usize = 2000;

/// 检查结果（camelCase 序列化给前端）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUpdateStatus {
    /// 本地 claude 版本（探测失败为 null）
    pub current_version: Option<String>,
    /// npm registry 最新版本（查询失败为 null）
    pub latest_version: Option<String>,
    /// latest 严格大于 current 才为 true（预发布/本地抢跑不误报）
    pub update_available: bool,
    /// 本地探测失败原因
    pub current_error: Option<String>,
    /// 网络查询失败原因
    pub latest_error: Option<String>,
    /// 命中的 claude 可执行路径（诊断用）
    pub install_path: Option<String>,
}

impl ClaudeUpdateStatus {
    /// spawn_blocking 失败时的兜底状态（两路都标记失败，前端两行都显示错误）
    pub fn errored(msg: &str) -> Self {
        Self {
            current_version: None,
            latest_version: None,
            update_available: false,
            current_error: Some(msg.to_string()),
            latest_error: Some(msg.to_string()),
            install_path: None,
        }
    }
}

// ---------------- 检查 ----------------

/// 完整检查：本地探测 + 网络查询并发（网络慢时不拖累本地结果），
/// 在阻塞线程池中调用，不卡 UI。
pub fn update_status() -> ClaudeUpdateStatus {
    let remote_handle = std::thread::spawn(latest_claude_version);
    let local = probe_local();
    let remote = remote_handle
        .join()
        .unwrap_or_else(|_| Err("查询线程异常退出".to_string()));

    let (current_version, current_error, install_path) = match &local {
        Ok((v, p)) => (Some(v.clone()), None, Some(p.display().to_string())),
        Err(e) => (None, Some(e.clone()), None),
    };
    let (latest_version, latest_error) = match &remote {
        Ok(v) => (Some(v.clone()), None),
        Err(e) => (None, Some(e.clone())),
    };
    let update_available = match (&local, &remote) {
        (Ok((c, _)), Ok(l)) => compare_versions(l, c) == Ordering::Greater,
        _ => false,
    };
    ClaudeUpdateStatus {
        current_version,
        latest_version,
        update_available,
        current_error,
        latest_error,
        install_path,
    }
}

/// 本地探测：定位 + 执行 `--version` + 提取版本号
fn probe_local() -> Result<(String, PathBuf), String> {
    let path = locate_claude().ok_or_else(|| "未找到 claude 命令".to_string())?;
    let output = run_version_command(&path)?;
    let version = extract_version(&output).ok_or_else(|| {
        format!(
            "无法从 claude --version 输出解析版本号：{}",
            first_line(&output)
        )
    })?;
    Ok((version, path))
}

/// 定位命令行实际命中的 claude 可执行：Windows 用 `where claude`
/// （过滤 Microsoft Store 的 App Execution Alias，防止误启动商店），
/// macOS/Linux 用 `command -v`。
fn locate_claude() -> Option<PathBuf> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("where");
        c.arg("claude").creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "command -v claude"]);
        c
    };
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let (_, stdout, _) = wait_with_timeout(&mut child, Duration::from_secs(LOCATE_TIMEOUT_SECS))?;
    let lines: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    #[cfg(windows)]
    {
        pick_windows_hit(&lines).map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        lines.into_iter().next().map(PathBuf::from)
    }
}

/// Windows 下 `where` 可能同时命中多个形态（npm 全局目录里 sh shim 无扩展名
/// 排在 .cmd 前面是常态），而 Rust 无法直接 spawn 无扩展名的 sh 脚本——按
/// cmd 的 PATHEXT 语义择优：.exe > .cmd/.bat > 无扩展名；同级保持 where 顺序
#[cfg(any(windows, test))]
fn pick_windows_hit(lines: &[String]) -> Option<String> {
    let rank = |l: &str| {
        let ext = Path::new(l)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "exe" => 0,
            "cmd" | "bat" => 1,
            "" => 2,
            _ => 3,
        }
    };
    lines
        .iter()
        // WindowsApps 下的 claude 是商店别名占位文件，执行会弹商店
        .filter(|l| !l.contains("WindowsApps"))
        .min_by_key(|l| rank(l))
        .cloned()
}

/// 对定位到的可执行执行 `--version`，返回合并后的输出（stdout + stderr）。
/// Windows 的 .cmd/.bat shim 不能直接 spawn，须经 `cmd /D /S /C call`。
fn run_version_command(claude_path: &Path) -> Result<String, String> {
    let mut child = spawn_version_probe(claude_path)?;
    match wait_with_timeout(&mut child, Duration::from_secs(VERSION_TIMEOUT_SECS)) {
        Some((_, stdout, stderr)) => Ok(format!("{stdout}\n{stderr}")),
        None => Err("claude --version 执行超时".to_string()),
    }
}

fn spawn_version_probe(claude_path: &Path) -> Result<Child, String> {
    let mut builder = build_version_probe_command(claude_path);
    builder
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("执行 claude --version 失败：{e}"))
}

#[cfg(windows)]
fn build_version_probe_command(claude_path: &Path) -> Command {
    let ext = claude_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut c = if ext == "cmd" || ext == "bat" {
        let mut c = Command::new("cmd");
        c.args(["/D", "/S", "/C", "call"]);
        c.arg(claude_path).arg("--version");
        c
    } else {
        let mut c = Command::new(claude_path);
        c.arg("--version");
        c
    };
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(windows))]
fn build_version_probe_command(claude_path: &Path) -> Command {
    let mut c = Command::new(claude_path);
    c.arg("--version");
    c
}

/// 查询 npm registry 最新稳定版（`/latest` 端点只含该版本的 package.json，
/// 体量小；取 JSON 的 `version` 字段）
fn latest_claude_version() -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{NPM_PACKAGE}/latest");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build();
    let resp = agent
        .get(&url)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("查询 npm registry 失败：{e}"))?;
    let mut body = String::new();
    resp.into_reader()
        .take(1024 * 1024) // 防御：响应体上限 1MB（/latest 本身只有几 KB）
        .read_to_string(&mut body)
        .map_err(|e| format!("读取 npm registry 响应失败：{e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("npm registry 响应不是合法 JSON：{e}"))?;
    parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "npm registry 响应缺少 version 字段".to_string())
}

// ---------------- 升级 ----------------

/// 一键升级：`claude update` 失败兜底 `npm i -g @anthropic-ai/claude-code@latest`。
/// 隐藏窗口静默执行，输出重定向到临时文件（npm 安装输出体量不可控，
/// 管道会填满死锁，文件不会），结束后回传输出尾部。
pub fn run_upgrade() -> Result<String, String> {
    let claude_path = locate_claude().ok_or_else(|| "未找到 claude 命令，无法升级".to_string())?;
    let npm_cmd = sibling_or_path_npm(&claude_path);

    let pid = std::process::id();
    let tmp = std::env::temp_dir();
    let script_path = tmp.join(format!("claude_fast_update_{pid}.{}", script_ext()));
    let out_path = tmp.join(format!("claude_fast_update_{pid}.log"));

    let script_text = build_upgrade_script(&claude_path.display().to_string(), &npm_cmd);
    std::fs::write(&script_path, script_text)
        .map_err(|e| format!("写升级脚本失败：{e}"))?;

    let result = execute_upgrade_script(&script_path, &out_path);
    let tail = std::fs::read_to_string(&out_path)
        .map(|s| tail_chars(&s, OUTPUT_TAIL_CHARS))
        .unwrap_or_default();
    // 临时文件 best-effort 清理
    let _ = std::fs::remove_file(&script_path);
    let _ = std::fs::remove_file(&out_path);

    match result {
        Err(e) => Err(e),
        Ok(true) => Ok(format!("升级命令执行完成。{tail}").trim().to_string()),
        Ok(false) => Err(format!("升级命令执行失败，请检查输出：{tail}").trim().to_string()),
    }
}

fn script_ext() -> &'static str {
    #[cfg(windows)]
    {
        "bat"
    }
    #[cfg(not(windows))]
    {
        "sh"
    }
}

/// npm 兜底命令：优先 claude 同目录的 npm（GUI 启动的进程 PATH 可能不全），
/// 找不到再裸用 PATH 里的 npm
fn sibling_or_path_npm(claude_path: &Path) -> String {
    if let Some(dir) = claude_path.parent() {
        #[cfg(windows)]
        let candidates = [dir.join("npm.cmd"), dir.join("npm.exe")];
        #[cfg(not(windows))]
        let candidates = [dir.join("npm")];
        for c in candidates {
            if c.is_file() {
                return c.display().to_string();
            }
        }
    }
    "npm".to_string()
}

/// Windows 升级脚本内容：.bat 里调 .cmd 必须加 call，否则执行完不会返回；
/// 失败兜底装 npm 最新版，最终 errorlevel 透传给 cmd /C 的退出码
#[cfg(any(windows, test))]
fn build_upgrade_bat(claude_path: &str, npm_cmd: &str) -> String {
    format!(
        "@echo off\r\n\
         call \"{claude}\" update\r\n\
         if errorlevel 1 call \"{npm}\" i -g @anthropic-ai/claude-code@latest\r\n\
         if errorlevel 1 exit /b %errorlevel%\r\n",
        claude = claude_path,
        npm = npm_cmd,
    )
}

/// macOS/Linux 升级命令：单行 sh，`||` 兜底
#[cfg(any(not(windows), test))]
#[cfg_attr(windows, allow(dead_code))] // Windows 测试构建仅为声明验证编译，不实际调用
fn build_upgrade_sh(claude_path: &str, npm_cmd: &str) -> String {
    format!(
        "{} update || {} i -g @anthropic-ai/claude-code@latest",
        sh_quote(claude_path),
        sh_quote(npm_cmd)
    )
}

/// sh 单引号包裹：成对 `'` 转义为 `'\''`（闭合、转义引号、重开）
#[cfg(any(not(windows), test))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn build_upgrade_script(claude_path: &str, npm_cmd: &str) -> String {
    #[cfg(windows)]
    {
        build_upgrade_bat(claude_path, npm_cmd)
    }
    #[cfg(not(windows))]
    {
        build_upgrade_sh(claude_path, npm_cmd)
    }
}

/// 执行升级脚本：输出重定向到临时文件，超时 10 分钟；返回
/// Ok(true)=成功 / Ok(false)=命令失败 / Err=启动或超时失败
fn execute_upgrade_script(script_path: &Path, out_path: &Path) -> Result<bool, String> {
    let out_file = File::create(out_path).map_err(|e| format!("创建升级输出文件失败：{e}"))?;
    let err_file = out_file
        .try_clone()
        .map_err(|e| format!("创建升级输出文件失败：{e}"))?;
    let mut child = spawn_upgrade_process(script_path, out_file, err_file)?;
    match wait_with_timeout(&mut child, Duration::from_secs(UPGRADE_TIMEOUT_SECS)) {
        Some((success, _, _)) => Ok(success),
        None => Err("升级超时（10 分钟），已强制终止".to_string()),
    }
}

fn spawn_upgrade_process(script_path: &Path, out: File, err: File) -> Result<Child, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/D", "/S", "/C"]).arg(script_path);
        // 升级必须全程静默：不设这个标志 cmd 会弹命令行窗口（对齐 cc-switch 行为）
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.arg(script_path);
        c
    };
    cmd.stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("执行升级脚本失败：{e}"))
}

// ---------------- 通用工具 ----------------

/// 带超时地等待子进程退出并收集管道输出；超时 kill 后返回 None。
/// 约定：管道输出须为小体量（几 KB 内，如 --version / where 的输出），
/// 轮询期间不读管道，体量大会撑满缓冲区导致子进程写阻塞、此处误判超时——
/// 升级这类大输出必须走文件重定向。
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<(bool, String, String)> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    // 进程已退出，写入端已关闭，剩余管道数据一次读尽
    let mut out = Vec::new();
    let mut err = Vec::new();
    if let Some(mut r) = child.stdout.take() {
        let _ = r.read_to_end(&mut out);
    }
    if let Some(mut r) = child.stderr.take() {
        let _ = r.read_to_end(&mut err);
    }
    let success = child
        .try_wait()
        .ok()
        .flatten()
        .map(|s| s.success())
        .unwrap_or(false);
    Some((
        success,
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
    ))
}

/// 从输出提取首个 `x.y.z` 或 `x.y.z-后缀`（等价正则 `\d+\.\d+\.\d+(-[\w.]+)?`，
/// 不为此引入 regex 依赖）
pub fn extract_version(output: &str) -> Option<String> {
    let b = output.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            if let Some(v) = try_parse_version_at(b, i) {
                return Some(v);
            }
        }
        i += 1;
    }
    None
}

/// 从 b[start] 起尝试解析 `数字.数字.数字(-后缀)?`，成功返回匹配文本
fn try_parse_version_at(b: &[u8], start: usize) -> Option<String> {
    let mut i = start;
    for group in 0..3 {
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == s {
            return None;
        }
        if group < 2 {
            if i >= b.len() || b[i] != b'.' {
                return None;
            }
            i += 1;
        }
    }
    let mut end = i;
    if i < b.len() && b[i] == b'-' {
        let mut j = i + 1;
        while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'.') {
            j += 1;
        }
        if j > i + 1 {
            end = j;
        }
    }
    Some(String::from_utf8_lossy(&b[start..end]).into_owned())
}

// ---------------- 版本比较（semver 语义，移植自 cc-switch） ----------------

/// 预发布段标识符：数字段按数值比较且 < 非数字段（semver 规范第 11 条）
#[derive(PartialEq, Eq, PartialOrd, Ord, Debug)]
enum PreId {
    Num(u64),
    Text(String),
}

/// 比较两个版本号：core 三段逐位数值比较（缺位补 0），预发布段遵循
/// semver：无预发布 > 有预发布；前缀相等时标识符多的一侧更大。
/// 「可升级」= compare_versions(latest, current) == Greater，
/// 本地抢跑（如装了 next 通道）时不会误报。
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (a_core, a_pre) = parse_version(a);
    let (b_core, b_pre) = parse_version(b);
    for i in 0..a_core.len().max(b_core.len()) {
        let x = a_core.get(i).copied().unwrap_or(0);
        let y = b_core.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    match (a_pre.is_empty(), b_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => compare_pre(&a_pre, &b_pre),
    }
}

/// 拆解 `core(-pre)?`：core 各段 parse 失败按 0（宽容脏数据），预发布段
/// 按 `.` 切分、纯数字段归 Num
fn parse_version(s: &str) -> (Vec<u64>, Vec<PreId>) {
    let s = s.trim();
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let core_ids: Vec<u64> = core
        .split('.')
        .map(|seg| seg.trim().parse().unwrap_or(0))
        .collect();
    let pre_ids: Vec<PreId> = pre
        .map(|p| {
            p.split('.')
                .map(|seg| match seg.trim().parse::<u64>() {
                    Ok(n) => PreId::Num(n),
                    Err(_) => PreId::Text(seg.trim().to_string()),
                })
                .collect()
        })
        .unwrap_or_default();
    (core_ids, pre_ids)
}

fn compare_pre(a: &[PreId], b: &[PreId]) -> Ordering {
    for i in 0..a.len().max(b.len()) {
        match (a.get(i), b.get(i)) {
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
            }
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (None, None) => break,
        }
    }
    Ordering::Equal
}

/// 取字符串尾部 max_chars 个字符（按字符截断，避免中文切成乱码半字）
fn tail_chars(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        s.to_string()
    } else {
        s.chars().skip(count - max_chars).collect()
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

// ---------------- 单测 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_version_基础提取() {
        // claude --version 实际输出形态
        assert_eq!(
            extract_version("2.1.263 (Claude Code)"),
            Some("2.1.263".to_string())
        );
        assert_eq!(
            extract_version("claude 1.2.3\nbuild info"),
            Some("1.2.3".to_string())
        );
    }

    #[test]
    fn extract_version_带预发布后缀() {
        assert_eq!(
            extract_version("2.2.0-next.1 (Claude Code)"),
            Some("2.2.0-next.1".to_string())
        );
        assert_eq!(
            extract_version("1.0.0-beta_2"),
            Some("1.0.0-beta_2".to_string())
        );
    }

    #[test]
    fn extract_version_噪声与多行输出() {
        // npm shim 可能在前面打告警、版本藏在中间
        assert_eq!(
            extract_version("npm warn deprecated\n\nv3.4.5 (latest)\ndone"),
            Some("3.4.5".to_string())
        );
    }

    #[test]
    fn extract_version_无版本返回_none() {
        assert_eq!(extract_version("command not found"), None);
        assert_eq!(extract_version(""), None);
        // 残缺数字不该误报
        assert_eq!(extract_version("version is ..12 and 1.2"), None);
    }

    #[test]
    fn compare_versions_相等与逐位比较() {
        use Ordering::*;
        assert_eq!(compare_versions("2.1.263", "2.1.263"), Equal);
        assert_eq!(compare_versions("2.1.264", "2.1.263"), Greater);
        assert_eq!(compare_versions("2.2.0", "2.1.99"), Greater);
        assert_eq!(compare_versions("3.0.0", "2.99.99"), Greater);
        // 段数不足补 0
        assert_eq!(compare_versions("2.1.0", "2.1"), Equal);
    }

    #[test]
    fn compare_versions_预发布低于正式版() {
        use Ordering::*;
        assert_eq!(compare_versions("2.1.0-beta.1", "2.1.0"), Less);
        assert_eq!(compare_versions("2.1.0", "2.1.0-beta.1"), Greater);
    }

    #[test]
    fn compare_versions_预发布段间比较() {
        use Ordering::*;
        // 字母段按字典序
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-beta"), Less);
        // 前缀相等时标识符多的一侧更大
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-alpha.1"), Less);
        assert_eq!(compare_versions("1.0.0-beta.2", "1.0.0-beta"), Greater);
        // 数字段按数值、且数字段 < 非数字段
        assert_eq!(compare_versions("1.0.0-2", "1.0.0-10"), Less);
        assert_eq!(compare_versions("1.0.0-1", "1.0.0-a"), Less);
    }

    #[test]
    fn compare_versions_本地抢跑不误报可升级() {
        // 用户装了高于 latest 的 next 通道版本时，latest > current 不成立
        use Ordering::*;
        assert_eq!(compare_versions("2.1.266", "2.2.0-next.1"), Less);
    }

    #[cfg(windows)]
    #[test]
    fn 升级bat_锚定路径与兜底链() {
        let s = build_upgrade_bat(r"C:\Users\x\npm\claude.cmd", r"C:\Users\x\npm\npm.cmd");
        assert!(s.starts_with("@echo off"));
        assert!(s.contains(r#"call "C:\Users\x\npm\claude.cmd" update"#));
        // 失败兜底：npm 全局安装最新版
        assert!(s.contains(r#"call "C:\Users\x\npm\npm.cmd" i -g @anthropic-ai/claude-code@latest"#));
        // 透传 errorlevel
        assert!(s.contains("if errorlevel 1 exit /b %errorlevel%"));
        // Windows 批处理必须 CRLF
        assert!(s.contains("\r\n"));
    }

    #[cfg(not(windows))]
    #[test]
    fn 升级sh_锚定路径与兜底链() {
        let s = build_upgrade_sh("/usr/local/bin/claude", "/usr/local/bin/npm");
        assert_eq!(
            s,
            "'/usr/local/bin/claude' update || '/usr/local/bin/npm' i -g @anthropic-ai/claude-code@latest"
        );
    }

    #[test]
    fn sh_quote_含引号路径正确转义() {
        assert_eq!(sh_quote("/opt/claude"), "'/opt/claude'");
        assert_eq!(sh_quote("/op't claude"), "'/op'\\''t claude'");
    }

    #[test]
    fn tail_chars_超长按字符截尾() {
        assert_eq!(tail_chars("abcdef", 3), "def");
        assert_eq!(tail_chars("短", 10), "短");
        let long = "汉".repeat(3000);
        assert_eq!(tail_chars(&long, 2000).chars().count(), 2000);
    }

    #[test]
    fn parse_version_宽容脏数据() {
        let (core, pre) = parse_version(" 2.1.263-x.7 ");
        assert_eq!(core, vec![2, 1, 263]);
        assert_eq!(pre, vec![PreId::Text("x".into()), PreId::Num(7)]);
        // 非数字段按 0 处理，不 panic
        let (core2, _) = parse_version("dev");
        assert_eq!(core2, vec![0]);
    }

    #[test]
    fn windows候选_按可执行形态择优() {
        // npm 全局目录的常态：无扩展名 sh shim 排在 .cmd 前面，应选 .cmd
        let lines = vec![
            r"E:\npm-global\claude".to_string(),
            r"E:\npm-global\claude.cmd".to_string(),
        ];
        assert_eq!(
            pick_windows_hit(&lines),
            Some(r"E:\npm-global\claude.cmd".to_string())
        );
        // 原生安装的 .exe 优先于 .cmd
        let exe_first = vec![
            r"C:\Program Files\claude\claude.exe".to_string(),
            r"E:\npm-global\claude.cmd".to_string(),
        ];
        assert_eq!(
            pick_windows_hit(&exe_first),
            Some(r"C:\Program Files\claude\claude.exe".to_string())
        );
        // 商店别名被过滤，不遮蔽真实安装
        let store = vec![
            r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\claude.exe".to_string(),
            r"E:\npm-global\claude.cmd".to_string(),
        ];
        assert_eq!(
            pick_windows_hit(&store),
            Some(r"E:\npm-global\claude.cmd".to_string())
        );
        // 全部被过滤时返回 None
        assert_eq!(pick_windows_hit(&[r"C:\WindowsApps\claude.exe".to_string()]), None);
    }

    #[cfg(windows)]
    #[test]
    fn 升级bat_errorlevel链_端到端模拟() {
        // 用真实的 build_upgrade_bat 产物验证语义：
        // ① claude update 成功 → 兜底不执行；② 失败 → npm 兜底执行且退出码 0；
        // ③ 两者都失败 → 退出码非 0
        let dir = std::env::temp_dir().join(format!("claude_fast_bat_sim_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("claude.cmd");
        let npm = dir.join("npm.cmd");
        let marker = dir.join("npm_ran.marker");

        let run_bat = |claude_body: &str, npm_body: &str| {
            std::fs::write(&claude, claude_body).unwrap();
            std::fs::write(&npm, npm_body.replace("MARKER", &marker.display().to_string())).unwrap();
            let bat = dir.join("upgrade.bat");
            std::fs::write(&bat, build_upgrade_bat(&claude.display().to_string(), &npm.display().to_string())).unwrap();
            let _ = std::fs::remove_file(&marker);
            Command::new("cmd").args(["/D", "/S", "/C"]).arg(&bat).status().unwrap()
        };

        let ok_npm = "@echo off\r\ntype nul > \"MARKER\"\r\nexit /b 0\r\n";
        let fail_claude = "@echo off\r\nexit /b 1\r\n";
        // ① 主命令成功：兜底不触发
        assert!(run_bat("@echo off\r\nexit /b 0\r\n", ok_npm).success());
        assert!(!marker.exists(), "主命令成功时不应执行 npm 兜底");
        // ② 主命令失败：兜底执行并成功，整体退出 0
        assert!(run_bat(fail_claude, ok_npm).success());
        assert!(marker.exists(), "主命令失败时应执行 npm 兜底");
        // ③ 兜底也失败：整体非 0（errorlevel 透传）
        std::fs::write(&npm, "@echo off\r\nexit /b 3\r\n").unwrap();
        assert!(!run_bat(fail_claude, "@echo off\r\nexit /b 3\r\n").success());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sibling_or_path_npm_无兄弟时回退裸命令() {
        // 临时目录下没有 npm，应回退 PATH 裸命令
        let dir = std::env::temp_dir().join("claude_fast_no_npm_sibling");
        let _ = std::fs::create_dir_all(&dir);
        let claude = dir.join(if cfg!(windows) { "claude.cmd" } else { "claude" });
        assert_eq!(sibling_or_path_npm(&claude), "npm");
        let _ = std::fs::remove_dir(&dir);
    }
}
