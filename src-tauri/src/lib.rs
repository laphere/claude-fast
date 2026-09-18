use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Claude Code 供应商配置切换（移植自 cc-switch 最小核心）
pub mod provider;

/// 拉取供应商可用模型列表（移植自 cc-switch model_fetch）
pub mod model_fetch;

/// Coding Plan 套餐用量查询（移植自 cc-switch coding_plan 适配器）
pub mod usage_query;

/// Claude Code 检查更新与一键升级（移植自 cc-switch 本地环境检查）
pub mod claude_update;

/// 控制台子进程不创建新窗口（GUI 主进程 spawn where 等工具时防止闪黑窗口，仅 Windows）
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 启动脚本专用目录（相对数据根目录）
const SCRIPTS_DIR: &str = "scripts";

/// config.json 全程无内存态，每次读改写都是「load → 改 → save」三段式；Tauri 命令
/// 在多线程上并发执行，不加锁时后写者会拿自己读到的旧快照覆盖对方的修改
/// （拖拽排序撞上 purge 丢置顶、并发加项目丢清单等）。所有 config 读改写入口必须持有此锁，
/// 且持锁期间严禁调用另一个持锁函数（std Mutex 不可重入，会死锁）
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn config_lock() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// stats-ledger.json 的读改写锁（同 CONFIG_LOCK 的理由：台账 load → 聚合 → save
/// 并发交错会丢掉刚登记的已删会话历史）。与 CONFIG_LOCK 分开，统计耗时不应阻塞配置写
static LEDGER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn ledger_lock() -> std::sync::MutexGuard<'static, ()> {
    LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 当前平台的启动脚本扩展名：Windows 用 .bat，macOS 用 .sh
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

/// 旧版便携模式数据根标记文件名（Windows 为 claude-claude-fast.bat）
fn legacy_marker() -> String {
    format!("claude-claude-fast.{}", script_ext())
}

// ---------------- 数据模型 ----------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItem {
    /// 唯一键 = 项目绝对路径
    key: String,
    /// 叶子目录名（显示用）
    name: String,
    /// 项目绝对路径
    path: String,
    /// true = 路径当前不存在（标红、不可启动）
    missing: bool,
    // healthy 不在 list_projects 中计算（避免启动时阻塞在目录检查上），
    // 由前端调用 check_projects 异步获取后回填。
}

/// 置顶会话条目
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PinnedSession {
    /// 会话 jsonl 文件绝对路径。稳定锚点：重命名只向文件追加 customTitle（文件名不变），
    /// 删除进回收站后恢复也回到原路径，因此条目能跨「删除 → 恢复」存活
    file: String,
    /// 所属项目绝对路径（置顶时刻记录）。mangled 目录名反解项目路径是启发式枚举
    /// （每个 `-` 可能是分隔符或原字符），不能作为展示依据，所以不反查
    project_path: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 用户手动排序的项目绝对路径（全局拖拽排序真源；未收录项按名称追加在后）。
    /// 旧版 favorites 键经 serde alias 承接为初始排序，写回后键名变为 order
    #[serde(default, alias = "favorites")]
    order: Vec<String>,
    /// 手动添加的项目路径清单（Claude 会话扫描之外的补充）
    #[serde(default)]
    projects: Vec<String>,
    /// 被用户从列表移除的项目路径：会话扫描会重新发现它们，
    /// 用排除清单让「移除」对扫描来源的项目同样生效
    #[serde(default)]
    excluded: Vec<String>,
    /// 旧 config 缺该字段时不能让整份配置解析失败（其余字段全有 default，
    /// 唯独它漏了会让用户清单/置顶/供应商静默回退默认值）；false 与前端初值一致
    #[serde(default)]
    dark: bool,
    /// 关闭窗口行为：None=每次询问；Some("quit")=直接退出；Some("minimize")=最小化到托盘
    #[serde(default)]
    close_action: Option<String>,
    /// Claude Code 供应商清单（供应商切换功能）
    #[serde(default)]
    providers: Vec<provider::ProviderInfo>,
    /// 当前启用供应商 id（None=尚未启用过）
    #[serde(default)]
    current_provider: Option<String>,
    /// 置顶会话清单（全局聚合区）。顺序即展示顺序：新置顶插最前，不支持拖拽改序
    #[serde(default)]
    pinned_sessions: Vec<PinnedSession>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    path: String,
    install_mode: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProject {
    /// 真实路径的叶子目录名（用于显示）
    name: String,
    /// 解析出的真实路径（不存在时为首选候选路径）
    path: String,
    /// true = 真实路径已不存在（项目代码被删除）
    missing: bool,
}

/// 会话元数据（从 jsonl 的 head/tail 轻量提取，不读全文件）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// 会话 ID（uuid，即 jsonl 文件名）
    session_id: String,
    /// 最终显示标题：customTitle > aiTitle > 首条用户消息
    title: String,
    /// 副行摘要：customTitle > lastPrompt > summary 字段 > 首条用户消息
    summary: String,
    /// 最后修改时间（文件 mtime，epoch ms）
    last_modified: i64,
    /// jsonl 文件绝对路径（重命名时回传）
    file: String,
}

/// 会话内容块（对齐 Claude Code jsonl 的 content 块格式）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    /// text | thinking | tool_use | tool_result
    kind: String,
    /// text/thinking/tool_result 的文本内容
    text: Option<String>,
    /// tool_use 工具名
    name: Option<String>,
    /// tool_use 输入（JSON 原样）
    input: Option<serde_json::Value>,
    /// tool_result 关联的 tool_use id
    tool_use_id: Option<String>,
    /// tool_result 是否报错
    is_error: Option<bool>,
}

/// 单条 assistant 消息的 token 用量（防御式解析：旧版数字字段与新版
/// `input_tokens: {cache_read, cache_creation, input}` 嵌套对象都兼容）
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

/// 会话中的一条消息（user / assistant）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    /// user | assistant
    kind: String,
    blocks: Vec<ContentBlock>,
    timestamp: Option<String>,
    /// assistant 的模型名
    model: Option<String>,
    /// assistant 的 token 用量（user 消息为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
}

/// 会话级 token 统计（parse 全量消息后聚合，分页不影响准确性）
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageStats {
    /// 会话总消息数
    message_count: usize,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    /// 总 token（输入 + 输出 + 缓存读取 + 缓存写入）
    total_tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessages {
    /// 本批消息（最多 limit 条）
    messages: Vec<SessionMessage>,
    /// 还有更早的消息未加载（向上分页用）
    has_more: bool,
    /// 会话总消息数
    total: usize,
    /// 本批起始位置（0 = 从最早一条开始）
    offset: usize,
    /// 会话级 token / 成本统计
    stats: SessionUsageStats,
}

/// 会话全文搜索的命中（一条命中 = 一个内容块）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    /// 消息在会话中的全局序号（第一条实质消息 = 0）
    index: usize,
    /// 内容块在消息内的序号
    block_index: usize,
    /// user | assistant
    kind: String,
    /// 命中上下文：命中处前后各一段字符（单行化）
    snippet: String,
}

/// 会话内容渲染的最大消息数（防止超大 jsonl 拖垮 UI）
const MAX_SESSION_MESSAGES: usize = 500;

/// 会话全文搜索的最多命中数（结果列表上限，防止超大 jsonl 拖垮 UI）
const MAX_SEARCH_HITS: usize = 200;

// ---------------- 路径定位 ----------------

/// 判断目录是否为数据根：三支候选——存量布局（`config.json` + `scripts/`
/// 同在）、去脚本化布局（`config.json` 或 `config.json.bak` 过内容校验）、
/// 旧布局标记 `claude-claude-fast.<bat|sh>`。
///
/// 存量布局做**无条件**短路，不走内容校验：这些是脚本时代就存在的便携目录，
/// 给它们的 config 也加校验会让「原本能用」变「config 一损坏就找不到数据根」，
/// 那是实打实的回归。
///
/// 后两支必须校验内容：便携判定向上扫 exe 的 6 级祖先，安装模式下第 5/6 级
/// 正是用户主目录与 `C:\Users`，只凭文件名认领会把其他工具的 config.json
/// 当作数据根，而 setup 里的 `ensure_projects_migrated` 在**首次启动**就会
/// 把它整份覆写（原件降级 .bak）。`.bak` 那支是必需的：主文件损坏/被删正是
/// .bak 兜底存在的意义，根判定不能先一步放弃该目录（否则静默换根、
/// 用户看到空清单，而数据与 .bak 都还在原地）。
fn is_root_dir(dir: &Path) -> bool {
    if dir.join("config.json").is_file() && dir.join(SCRIPTS_DIR).is_dir() {
        return true;
    }
    looks_like_our_config(&dir.join("config.json"))
        || looks_like_our_config(&dir.join("config.json.bak"))
        || dir.join(legacy_marker()).is_file()
}

/// 配置文件是否像本程序的配置：须为 JSON 对象，且要么是空对象（`{}`——
/// 用户显式引导便携模式的正规姿势，外来工具的配置不会恰好是空对象），
/// 要么命中 **≥2 个**已知字段。
///
/// 为什么是「≥2」而不是「≥1」：`projects` / `dark` / `order` / `excluded`
/// 都是通用词，只要求撞上 1 个键就会把别的工具（乃至手写的
/// `{"dark":true}`）认成数据根，代价是把它覆写掉。≥2 且不误杀自家配置——
/// 无 `scripts/` 的目录只可能由去脚本化之后的版本写出，而那时的序列化器
/// 没有 `skip_serializing_if`，永远写全 9 个键。
///
/// 键名含 serde alias（`favorites`）；给 `Config` 加字段时记得同步 KNOWN_KEYS。
fn looks_like_our_config(path: &Path) -> bool {
    let Ok(raw) = fs::read(path) else {
        return false;
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(strip_bom(&raw)) else {
        return false;
    };
    let Some(obj) = v.as_object() else {
        return false;
    };
    if obj.is_empty() {
        return true;
    }
    const KNOWN_KEYS: [&str; 9] = [
        "order",
        "favorites",
        "projects",
        "excluded",
        "dark",
        "closeAction",
        "providers",
        "currentProvider",
        "pinnedSessions",
    ];
    let mut hits = 0;
    for k in KNOWN_KEYS {
        if obj.contains_key(k) {
            hits += 1;
            if hits >= 2 {
                return true;
            }
        }
    }
    false
}

/// 安装模式数据根：%APPDATA%\claude-fast（Windows）/
/// ~/Library/Application Support/claude-fast（macOS）。
/// 安装包模式下 exe 位于 Program Files（只读），用户数据统一放这里。
fn app_data_root() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA").unwrap_or_default();
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(|h| format!("{}/Library/Application Support", h))
        .unwrap_or_default();
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(base).join("claude-fast")
}

/// 便携根查找：从 start 起向上最多 6 级，返回首个满足 `is_root_dir` 的目录。
/// 抽成独立函数是为了可测——`resolve_root_uncached` 的起点是 exe 所在目录，
/// 单测控制不了，而这个循环的**深度**与「首个命中即返回」语义恰恰最该被测。
fn resolve_root_from(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..6 {
        if is_root_dir(&dir) {
            return Some(dir);
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    None
}

/// 数据根解析结果**进程内缓存**。根在进程生命周期内不变（exe 位置固定），
/// 缓存有两个必要理由：
/// ① 判定已从 stat 级（is_file/is_dir）升到 read+parse 级，单次瞬态读失败
///    （杀软保存后独占扫描、云盘占位文件未水合、网络盘瞬断）会让同一会话内
///    不同命令落到**不同的根**——load 读到一份空清单、save 写进另一个目录，
///    表现为「清单自己清空又自己回来」；
/// ② 避免每条命令（十余处调用点）都向上扫祖先目录并读文件。
static ROOT_CACHE: std::sync::OnceLock<(PathBuf, bool)> = std::sync::OnceLock::new();

/// 定位数据根目录（双模式）：
/// 1. **便携模式**：exe 所在目录向上（最多 6 级）查找首个根目录标记
///    （见 `is_root_dir`）——开发目录、整体移动的文件夹、绿色版走此路径。
/// 2. **安装模式**：找不到便携标记时回退到应用数据目录
///    （%APPDATA%\claude-fast），首次运行自动创建该目录
///    （scripts/ 是脚本时代遗留，去脚本化后不再创建；存量目录里的
///    旧脚本保留在磁盘，仅供 ensure_projects_migrated 解析，不删）。
///
/// 返回 (数据根, 是否安装模式)。模式判定必须在查找现场做：
/// 便携根通常是 exe 的**祖先**目录，「root != exe_dir」恒真，判不出模式
fn resolve_root_with_mode() -> (PathBuf, bool) {
    ROOT_CACHE.get_or_init(resolve_root_uncached).clone()
}

fn resolve_root_uncached() -> (PathBuf, bool) {
    let exe = std::env::current_exe().unwrap_or_default();
    let start = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    if let Some(root) = resolve_root_from(&start) {
        return (root, false);
    }
    // 安装模式：现场创建数据根本身（旧版在此顺带创建 scripts/，是其副作用
    // 保证了首次 save_config 有目录可写——去掉 scripts/ 后创建根目录必须保留）
    let app = app_data_root();
    let _ = fs::create_dir_all(&app);
    (app, true)
}

fn resolve_root_dir() -> PathBuf {
    resolve_root_with_mode().0
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

fn read_config_file(path: &Path) -> Option<Config> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(strip_bom(&raw)).ok()
}

/// 从启动脚本内容解析 `cd` 行中的目录路径。兼容 bat 的 `cd /d "..."` 与
/// sh 的 `cd "/path"` / `cd /path`（带引号/不带引号均可）。
fn parse_cd_path(content: &str) -> Option<String> {
    for line in content.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        // bat: `cd /d "path"`；sh: `cd "/path"` / `cd /path`（前缀长度固定）
        let rest = if lower.starts_with("cd /d") {
            &t[5..]
        } else if lower.starts_with("cd ") {
            &t[3..]
        } else {
            continue;
        };
        let rest = rest.trim();
        if let Some(stripped) = rest.strip_prefix('"') {
            if let Some(end) = stripped.find('"') {
                return Some(stripped[..end].to_string());
            }
        } else {
            let p = rest.split_whitespace().next().unwrap_or("");
            if !p.is_empty() {
                return Some(p.to_string());
            }
        }
    }
    None
}

// ---------------- commands ----------------

// ---------------- 项目清单（去脚本化） ----------------

fn stat_is_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

/// 构建主列表：Claude 会话扫描 ∪ config.projects 手动清单，按路径去重，
/// 并剔除排除清单（用户已移除）中的项目。
/// missing = 路径当前不存在（仍显示、标红、不可启动）。
fn list_projects_impl(
    projects_dir: &Path,
    manual: &[String],
    excluded: &[String],
) -> Vec<ProjectItem> {
    let mut out: Vec<ProjectItem> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let is_excluded =
        |p: &str| excluded.iter().any(|x| x.eq_ignore_ascii_case(p));
    let push = |item: ProjectItem, out: &mut Vec<ProjectItem>, seen: &mut Vec<String>| {
        let key = item.key.to_lowercase();
        if !seen.iter().any(|s| *s == key) {
            seen.push(key);
            out.push(item);
        }
    };
    for s in scan_claude_projects_blocking(projects_dir) {
        if is_excluded(&s.path) {
            continue; // 用户已移除：即使会话扫描重新发现也不显示
        }
        push(
            ProjectItem {
                key: s.path.clone(),
                name: s.name.clone(),
                path: s.path,
                missing: s.missing,
            },
            &mut out,
            &mut seen,
        );
    }
    for mp in manual {
        if is_excluded(mp) {
            continue;
        }
        let name = Path::new(mp)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| mp.clone());
        push(
            ProjectItem {
                key: mp.clone(),
                name,
                path: mp.clone(),
                missing: !stat_is_dir(mp),
            },
            &mut out,
            &mut seen,
        );
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 把一个项目路径加入手动清单（已在清单中则原样返回）。路径必须是存在的目录。
fn add_project_to(manual: &mut Vec<String>, dir: &str) {
    if !stat_is_dir(dir) {
        return;
    }
    if !manual.iter().any(|p| p.eq_ignore_ascii_case(dir)) {
        manual.push(dir.to_string());
    }
}

/// 从手动清单移除项目路径（收藏同步移除由调用方处理）
fn remove_project_from(manual: &mut Vec<String>, dir: &str) {
    manual.retain(|p| !p.eq_ignore_ascii_case(dir));
}

/// 解析数据根 scripts/ 下旧启动脚本（Tauri 版遗留）→ 脚本 stem → cd 路径。
/// 用于去脚本化的一次性迁移；脚本文件本身保留不动。
fn legacy_script_paths(scripts: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(entries) = fs::read_dir(scripts) else {
        return map;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !stem.to_lowercase().starts_with("claude-") {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext != script_ext() {
            continue;
        }
        if let Some(cd) = parse_cd_path(&fs::read_to_string(&p).unwrap_or_default()) {
            map.insert(stem.to_string(), cd);
        }
    }
    map
}

/// 旧脚本清单一次性迁移（去脚本化）：解析旧脚本的 cd 路径完成 key → 项目路径映射：
///   projects = 全部脚本指向的项目路径
///   order    = 旧收藏 key 映射后的项目路径（找不到的丢弃）——旧「收藏」语义就是置顶，
///              故承接为排序最前的几项，用户的置顶意图不丢
/// 判定：config.json 原始内容含 "projects" 字段（或无 config 文件）即视为已迁移。
fn ensure_projects_migrated() {
    ensure_projects_migrated_in(&resolve_root_dir());
}

fn ensure_projects_migrated_in(root: &Path) {
    let cfg_path = root.join("config.json");
    let Ok(text) = fs::read_to_string(&cfg_path) else {
        return; // 无 config（全新安装）
    };
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    if raw.get("projects").is_some() {
        return; // 已迁移
    }
    let key_to_path = legacy_script_paths(&root.join(SCRIPTS_DIR));
    let legacy_favs: Vec<String> = raw
        .get("favorites")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let _guard = config_lock();
    let cfg = load_config_from(root);
    let mut projects: Vec<String> = Vec::new();
    for p in key_to_path.values() {
        if !projects.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            projects.push(p.clone());
        }
    }
    let mut order: Vec<String> = Vec::new();
    for k in legacy_favs {
        if let Some(p) = key_to_path.get(&k) {
            if !order.iter().any(|x| x.eq_ignore_ascii_case(p)) {
                order.push(p.clone());
            }
        }
    }
    let mut cfg = cfg;
    cfg.projects = projects;
    cfg.order = order;
    // 直接整份落盘；save_config_to 内部也持锁，嵌套会死锁
    let _ = save_config_file(root, &cfg);
}

#[tauri::command]
async fn list_projects() -> Vec<ProjectItem> {
    // 同步命令在主线程执行：unmangle 枚举 + 每路径 is_dir 是重 I/O，会卡 UI
    tauri::async_runtime::spawn_blocking(|| {
        let cfg = load_config();
        list_projects_impl(&claude_projects_dir(), &cfg.projects, &cfg.excluded)
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn add_project(path: String) -> Result<(), String> {
    let _guard = config_lock();
    let mut cfg = load_config();
    if !stat_is_dir(&path) {
        return Err("路径不存在或不是文件夹".to_string());
    }
    add_project_to(&mut cfg.projects, &path);
    // 重新加入 = 解除排除
    cfg.excluded.retain(|x| !x.eq_ignore_ascii_case(&path));
    // cfg 就来自持锁下的最新读取，直接整份落盘即可；
    // 不能再走 save_config（内部也持锁，std Mutex 不可重入会死锁）
    save_config_file(&resolve_root_dir(), &cfg)
}

#[tauri::command]
fn remove_project(path: String) -> Result<(), String> {
    let _guard = config_lock();
    let mut cfg = load_config();
    remove_project_from(&mut cfg.projects, &path);
    // 手动排序里同步移除（排序键与列表键同为项目路径）
    remove_project_from(&mut cfg.order, &path);
    // 该项目的置顶会话一并撤掉：否则置顶区会留下所属项目已不在列表里的孤儿条目
    drop_pins_for_projects(&mut cfg, std::slice::from_ref(&path));
    // 加入排除清单：会话扫描会重新发现该项目，必须过滤才能让「移除」生效
    if !cfg
        .excluded
        .iter()
        .any(|x| x.eq_ignore_ascii_case(&path))
    {
        cfg.excluded.push(path.clone());
    }
    save_config_file(&resolve_root_dir(), &cfg)
}

/// 读取配置：主文件损坏时自动回退到 .bak 并恢复主文件（用户数据不丢失）
#[tauri::command]
fn load_config() -> Config {
    load_config_from(&resolve_root_dir())
}

fn load_config_from(root: &Path) -> Config {
    let cfg_path = root.join("config.json");
    let bak_path = root.join("config.json.bak");
    if let Some(c) = read_config_file(&cfg_path) {
        return c;
    }
    if let Some(c) = read_config_file(&bak_path) {
        let _ = fs::copy(&bak_path, &cfg_path);
        return c;
    }
    Config::default()
}

/// 保存配置：写临时文件 → 旧文件备份为 .bak → 原子替换
#[tauri::command]
fn save_config(
    order: Vec<String>,
    pinned_sessions: Vec<PinnedSession>,
    projects: Vec<String>,
    excluded: Vec<String>,
    dark: bool,
    close_action: Option<String>,
) -> Result<(), String> {
    save_config_to(
        &resolve_root_dir(),
        order,
        pinned_sessions,
        projects,
        excluded,
        dark,
        close_action,
    )
}

fn save_config_to(
    root: &Path,
    order: Vec<String>,
    pinned_sessions: Vec<PinnedSession>,
    projects: Vec<String>,
    excluded: Vec<String>,
    dark: bool,
    close_action: Option<String>,
) -> Result<(), String> {
    let _guard = config_lock();
    // 读改写而非重建：保留 save_config 参数之外的字段（providers / current_provider），
    // 否则设置对话框一保存就会把供应商清单清空
    let mut cfg = load_config_from(root);
    cfg.order = order;
    cfg.pinned_sessions = pinned_sessions;
    cfg.projects = projects;
    cfg.excluded = excluded;
    cfg.dark = dark;
    cfg.close_action = close_action;
    save_config_file(root, &cfg)
}

/// 撤掉指定项目的置顶会话：项目从列表移除、或项目会话数据被清除时调用，
/// 否则置顶区会留下所属项目已不在列表里的孤儿条目
fn drop_pins_for_projects(cfg: &mut Config, paths: &[String]) {
    cfg.pinned_sessions
        .retain(|p| !paths.iter().any(|x| x.eq_ignore_ascii_case(&p.project_path)));
}

/// 清掉会话文件已不存在的置顶条目。只在「彻底删除」类操作后调用：会话删除进回收站后
/// 文件同样不在原路径，但条目必须留着等恢复，因此 delete_session 不调用本函数。
fn prune_dead_pins(cfg: &mut Config) {
    cfg.pinned_sessions.retain(|p| Path::new(&p.file).is_file());
}

/// 配置落盘三步保护：写临时文件 → 旧文件备份为 .bak → 原子替换
fn save_config_file(root: &Path, cfg: &Config) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    let bak_path = root.join("config.json.bak");
    let tmp_path = root.join("config.json.tmp");
    fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    if cfg_path.exists() {
        fs::copy(&cfg_path, &bak_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, &cfg_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 启动项目（新会话）：新开终端，cd 到项目目录运行 claude。
/// 不经过任何脚本文件；Windows ShellExecuteW 启动 `cmd /k cd /d "dir" && claude`
/// （默认终端委托，整树同一控制台会话）；macOS 临时 sh + Terminal.app。
#[tauri::command]
fn launch_project(path: String) -> Result<(), String> {
    let dir = path.trim().to_string();
    if !Path::new(&dir).is_dir() {
        return Err("项目路径不存在".to_string());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        // /k 让 claude 退出后窗口保留、便于查看输出
        let cmdline = format!("/k cd /d \"{dir}\" && claude");
        let exe: Vec<u16> = "cmd.exe".encode_utf16().chain(Some(0)).collect();
        let params: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        let wd: Vec<u16> = dir.encode_utf16().chain(Some(0)).collect();
        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                exe.as_ptr(),
                params.as_ptr(),
                wd.as_ptr(),
                SW_SHOW,
            )
        };
        if res as isize > 32 {
            Ok(())
        } else {
            Err(format!("启动失败（ShellExecute 返回 {}）", res as isize))
        }
    }
    #[cfg(not(windows))]
    {
        // macOS：临时 sh + Terminal.app（无需 osascript 自动化权限）
        let sh = std::env::temp_dir().join(format!(
            "claude-fast-open-{}-{}.sh",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        // 路径必须放进双引号：sh_quote 只转义 `\ " $ \``，不包引号时空格会拆参数、
        // `;` 等字符会逃逸成命令分隔符（resume 脚本的 `cd \"{}\"` 是同款正确写法）
        fs::write(
            &sh,
            format!(
                "#!/bin/bash\ncd \"{}\" || exit 1\nexec claude\n",
                sh_quote(&dir)
            ),
        )
        .map_err(|e| format!("写入临时脚本失败：{e}"))?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&sh, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置临时脚本权限失败：{e}"))?;
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&sh)
            .spawn()
            .map_err(|e| format!("启动 Terminal 失败：{e}"))?;
        Ok(())
    }
}

// ---------------- 会话继续对话（v2.0.0 阶段二：方向 B resume） ----------------

/// shell 双引号内转义（macOS 命令行拼装用：路径可能含 `"`、`$`、反引号、`\`，
/// 转义后放入 `cd "..."` 不会被展开/截断）。
/// Windows 构建中仅被 macOS 专属代码引用（launch_project 的非 windows 分支）。
#[allow(dead_code)]
fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if c == '\\' || c == '"' || c == '$' || c == '`' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}


/// 校验 resume 的项目路径（防命令注入，两平台共用）：
/// 空路径拒绝；控制字符一律拒绝；路径必须真实存在。
/// Windows：路径拼进 `cd /d "<路径>"` 双引号内，`& | < > ^ ( )` 均为字面量不构成注入，
/// 只需拒掉引号内仍有效的字符——`"`（截断引号）与 `%`（环境变量展开，`%APPDATA%` 等
/// 引号内照样展开）；`!`（延迟展开变量，防御注册表 AutoRun 开启 delayed expansion）
/// macOS：路径经 sh_quote 转义后放进 `cd "..."`，双引号内 `$ ` \ "` 之外的特殊字符
/// 均为字面量，故不再额外拒字符——否则会误伤含 `(` `)` `'` `\` 等的合法 mac 路径
/// （这类路径在「新建/启动」能通过，resume 却拒绝，造成行为不一致）。
fn validate_resume_path(project_path: &str) -> Result<(), String> {
    let proj = project_path.trim();
    if proj.is_empty() {
        return Err("项目路径不能为空".to_string());
    }
    #[cfg(windows)]
    {
        let forbidden = ['"', '%', '!'];
        for c in forbidden {
            if proj.contains(c) {
                return Err("项目路径包含非法字符".to_string());
            }
        }
    }
    if proj.chars().any(|c| c.is_control()) {
        return Err("项目路径包含非法字符".to_string());
    }
    if !Path::new(proj).is_dir() {
        return Err("项目路径不存在".to_string());
    }
    Ok(())
}

/// 构造 resume 的 cmd 命令行（Windows）：
/// `cmd /k cd /d "<项目路径>" && claude --resume <session-id>`
#[cfg(windows)]
fn build_resume_cmdline(project_path: &str, session_id: &str) -> Result<String, String> {
    validate_resume_path(project_path)?;
    let proj = project_path.trim();
    Ok(format!("/k cd /d \"{proj}\" && claude --resume {session_id}"))
}

/// 构造 resume 的临时脚本内容（macOS）：
/// `cd "/path" && exec claude --resume <id>`，写入临时文件后由 Terminal 运行。
/// 路径经 sh_quote 转义 + validate_resume_path 校验，无注入面。
#[cfg(not(windows))]
fn build_resume_script(project_path: &str, session_id: &str) -> Result<String, String> {
    validate_resume_path(project_path)?;
    let proj = project_path.trim();
    Ok(format!(
        "#!/bin/bash\ncd \"{}\" || exit 1\nexec claude --resume {session_id}\n",
        sh_quote(proj)
    ))
}

/// 继续对话：新开终端窗口，在项目目录运行 `claude --resume <session-id>`
/// （打开 claude 并 resume 到该会话；用户在 claude 里继续对话，退出 claude 即结束）。
/// Windows：ShellExecuteW 新开 cmd；macOS：临时 .sh + Terminal.app 打开。
#[tauri::command]
fn resume_session(file: String, project_path: String) -> Result<(), String> {
    let (_path, session_id) = validate_session_file(&file)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        let cmdline = build_resume_cmdline(&project_path, &session_id)?;
        let exe: Vec<u16> = "cmd.exe".encode_utf16().chain(Some(0)).collect();
        let params: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        let dir: Vec<u16> = Path::new(project_path.trim())
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                exe.as_ptr(),
                params.as_ptr(),
                dir.as_ptr(),
                SW_SHOW,
            )
        };
        if res as isize > 32 {
            Ok(())
        } else {
            Err(format!("启动失败（ShellExecute 返回 {}）", res as isize))
        }
    }
    #[cfg(not(windows))]
    {
        // 临时脚本放系统临时目录（内容幂等，同名覆盖无害；系统自动清理），
        // 用 `open -a Terminal` 打开——不需要 osascript 自动化权限
        let content = build_resume_script(&project_path, &session_id)?;
        let tmp = std::env::temp_dir().join(format!("claude-fast-resume-{session_id}.sh"));
        fs::write(&tmp, content).map_err(|e| format!("写入临时脚本失败：{e}"))?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置临时脚本权限失败：{e}"))?;
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&tmp)
            .spawn()
            .map_err(|e| format!("启动 Terminal 失败：{e}"))?;
        Ok(())
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = Command::new("explorer.exe");
    #[cfg(not(windows))]
    let mut cmd = Command::new("open");
    cmd.arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// claude 命令可用性检查：在阻塞线程池中执行，不阻塞主线程/UI。
/// Windows 用 `where`、macOS 用 `command -v`；两者都可能因 PATH 含慢速
/// 目录（网络盘等）卡住，限制 3 秒超时。
#[tauri::command]
async fn check_claude() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
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
        let Ok(mut child) = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// 健康检查：并行检查各项目路径是否存在（在阻塞线程池中执行，
/// 不阻塞主线程/UI；某个路径卡住时其余结果不受影响）
#[tauri::command]
async fn check_projects(paths: Vec<String>) -> Vec<bool> {
    let mut tasks = Vec::with_capacity(paths.len());
    for p in paths {
        tasks.push(tauri::async_runtime::spawn_blocking(move || {
            Path::new(&p).is_dir()
        }));
    }
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        out.push(t.await.unwrap_or(false));
    }
    out
}

/// Claude Code 更新检查（本地版本 vs npm 最新）：阻塞线程池执行，不卡 UI
#[tauri::command]
async fn claude_update_status() -> claude_update::ClaudeUpdateStatus {
    tauri::async_runtime::spawn_blocking(claude_update::update_status)
        .await
        .unwrap_or_else(|_| claude_update::ClaudeUpdateStatus::errored("检查任务异常退出"))
}

/// Claude Code 一键升级（claude update 失败兜底 npm 全局安装）：
/// 可能跑数分钟，阻塞线程池执行，不卡 UI
#[tauri::command]
async fn claude_run_upgrade() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(claude_update::run_upgrade)
        .await
        .unwrap_or_else(|e| Err(format!("升级任务异常退出：{e}")))
}

/// Claude Code 项目目录（会话 jsonl 所在）：`<数据根>/projects`。
/// 数据根优先级：
/// 1. `CLAUDE_CONFIG_DIR` 环境变量（官方支持的自定义数据目录，设置后
///    配置/会话/日志整体迁移到该目录下，任何平台都生效）；
/// 2. 平台默认——本项目面向 **Claude Code CLI**（终端 `claude` 命令），
///    其规范路径即 `~/.claude`（macOS/Linux 与 Windows 的
///    `%USERPROFILE%\.claude` 对应）：`~/.claude/projects` **优先**；
///    macOS 后备：`~/Library/Application Support/Claude` 是 **Claude
///    Desktop**（GUI 应用）的数据目录，若用户通过 Desktop 内置的 code
///    功能产生过会话，其 projects 在这里——存在且 `~/.claude` 缺失时才用。
fn claude_projects_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = dir.trim();
        if !d.is_empty() {
            return PathBuf::from(d).join("projects");
        }
    }
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        // CLI 规范路径优先（~/.claude 若是指向 Desktop 数据目录的 symlink，
        // 两处本就是同一目录，返回哪个都等价）
        let cli = PathBuf::from(&home).join(".claude").join("projects");
        if cli.is_dir() {
            return cli;
        }
        // 后备：Claude Desktop 内置 code 的会话目录
        let desktop = PathBuf::from(&home).join("Library/Application Support/Claude/projects");
        if desktop.is_dir() {
            return desktop;
        }
        cli
    }
    #[cfg(not(target_os = "macos"))]
    PathBuf::from(home).join(".claude").join("projects")
}

// ---------------- 会话管理（v2.0.0 阶段一） ----------------

/// jsonl 轻量读取的 head/tail 缓冲大小：会话文件可达数 MB 甚至更大，
/// 只读首尾各 64KB 即可提取全部元数据（与 cc-haha 的 LITE_READ_BUF_SIZE 一致）。
const LITE_READ_BUF_SIZE: usize = 64 * 1024;

/// Claude Code 项目目录名的正向 mangle：`:`、`\`、`/`、`_`、`.` 均替换为 `-`
/// （与 Claude Code 官方规则一致，Windows 与 macOS 通用；macOS 路径
/// `/Users/foo/bar` → `-Users-foo-bar`，根 `/` 占开头一个 `-`）：
///   D:\MyWorkspaces\jikehongbao → D--MyWorkspaces-jikehongbao
///   /Users/me/proj              → -Users-me-proj
fn mangle_project_path(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '_' | '.' => '-',
            _ => c,
        })
        .collect()
}

/// UUID v4 格式校验（会话文件名主体）
fn is_valid_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// 剥离 XML 标签块（如 <command-name>/<command-args> 包裹的标题源）。
/// command-args 块**保留块内文本**（它是标题内容本身），其余块整体剥离；
/// 无闭合标签的孤立 `<` 原样保留。对应 cc-haha cleanSessionTitleSource。
fn strip_xml_blocks(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        if let Some(gt) = rest[start..].find('>') {
            let inner = &rest[start + 1..start + gt];
            let name: String = inner
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !name.is_empty() {
                let close = format!("</{}>", name);
                let after = &rest[start + gt + 1..];
                if let Some(end) = after.find(&close) {
                    if name == "command-name" || name == "command-args" {
                        // 保留块内文本（命令名/参数就是标题内容本身，
                        // 如 /init 会话的标题即 "/init"）
                        out.push_str(&after[..end]);
                        out.push(' ');
                    } else {
                        out.push(' ');
                    }
                    rest = &after[end + close.len()..];
                    continue;
                }
            }
        }
        out.push('<');
        rest = &rest[start + 1..];
    }
    out.push_str(rest);
    out
}

/// 摘要/标题清洗：换行/制表符折叠为空格、剥离 XML 标签块、合并空白、截断
fn clean_summary(s: &str) -> String {
    let s = s
        .chars()
        .map(|c| if c == '\r' || c == '\n' || c == '\t' { ' ' } else { c })
        .collect::<String>();
    let s = strip_xml_blocks(&s);
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(150).collect()
}

/// 把一段 jsonl 文本按行解析为 JSON（坏行忽略——head/tail 边界行可能被截断）
fn parse_json_lines(text: &str) -> Vec<serde_json::Value> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .collect()
}

/// 在行列表中取**最后一条**指定 type 行的字符串字段（tail 优先，head 兜底）
fn last_field_of_type(lines: &[serde_json::Value], ty: &str, field: &str) -> Option<String> {
    lines
        .iter()
        .rev()
        .find_map(|v| {
            if v.get("type").and_then(|t| t.as_str()) == Some(ty) {
                v.get(field)
                    .and_then(|f| f.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .filter(|s| !s.trim().is_empty())
}

/// 提取首个**非命令**的 user 消息文本（字符串 content 或 text 块数组）。
/// 命令消息（/init、/clear 等，content 含 <command-name>/<command-message>）
/// 不算实质对话内容：只有命令没有普通对话的会话无需展示。
fn extract_first_prompt(head: &[serde_json::Value]) -> Option<String> {
    for v in head {
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
            continue;
        }
        let msg = v.get("message")?;
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(arr)) => arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        // 命令消息跳过（不算实质内容）
        if text.contains("<command-name>") || text.contains("<command-message>") {
            continue;
        }
        // 清洗后为空（如纯 XML 包裹且内容为空的极端情况）→ 跳过该条
        let cleaned = clean_summary(&text);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    None
}

/// 从 head/tail 提取会话元数据。None = 该文件不是有效会话（sidechain 等）。
fn session_meta_from_lite(
    head: &str,
    tail: &str,
    session_id: &str,
    last_modified: i64,
) -> Option<SessionInfo> {
    let head_lines = parse_json_lines(head);
    let tail_lines = parse_json_lines(tail);
    // sidechain 会话（并行子会话）不在列表中展示
    if head_lines
        .first()
        .and_then(|v| v.get("isSidechain"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    // 标题优先级：手动重命名 > AI 自动标题 > 首条用户消息
    let custom_title = last_field_of_type(&tail_lines, "custom-title", "customTitle")
        .or_else(|| last_field_of_type(&head_lines, "custom-title", "customTitle"));
    let ai_title = last_field_of_type(&tail_lines, "ai-title", "aiTitle")
        .or_else(|| last_field_of_type(&head_lines, "ai-title", "aiTitle"));
    let first_prompt = extract_first_prompt(&head_lines);
    // 摘要回退链：customTitle > lastPrompt > summary 字段 > 首条消息
    let summary = custom_title
        .clone()
        .or_else(|| last_field_of_type(&tail_lines, "last-prompt", "lastPrompt"))
        .or_else(|| last_field_of_type(&head_lines, "last-prompt", "lastPrompt"))
        .or_else(|| last_field_of_type(&tail_lines, "summary", "summary"))
        .or_else(|| last_field_of_type(&head_lines, "summary", "summary"))
        .or_else(|| first_prompt.clone())
        .map(|s| clean_summary(&s))
        .unwrap_or_default();
    let title = custom_title
        .or(ai_title)
        .or(first_prompt)
        .map(|s| clean_summary(&s))
        .filter(|s| !s.is_empty()) // 清洗后为空视为无标题
        .unwrap_or_else(|| "未命名会话".to_string());
    // 只有元数据（无任何内容）的会话跳过：含只执行了 /init 等命令的会话
    // （命令消息不算实质内容，extract_first_prompt 已跳过）
    if summary.is_empty() && title == "未命名会话" {
        return None;
    }
    Some(SessionInfo {
        session_id: session_id.to_string(),
        title,
        summary,
        last_modified,
        file: String::new(), // 由调用方回填
    })
}

/// 读取会话 jsonl 的 head/tail（单 fd 两次 read），返回原始文本
fn read_head_tail(path: &Path) -> Option<(String, String, i64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let meta = f.metadata().ok()?;
    let size = meta.len();
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; LITE_READ_BUF_SIZE];
    let head_n = f.read(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf[..head_n]).to_string();
    let mut tail = head.clone();
    if size > LITE_READ_BUF_SIZE as u64 {
        f.seek(SeekFrom::Start(size - LITE_READ_BUF_SIZE as u64))
            .ok()?;
        let tail_n = f.read(&mut buf).ok()?;
        tail = String::from_utf8_lossy(&buf[..tail_n]).to_string();
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((head, tail, mtime))
}

/// 列出某项目（真实路径）的 Claude Code 会话，按最后修改时间倒序。
/// 在 Tauri 阻塞线程池执行，不冻结 UI。
#[tauri::command]
async fn list_sessions(project_path: String) -> Vec<SessionInfo> {
    let dir = claude_projects_dir().join(mangle_project_path(&project_path));
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".jsonl") {
            continue;
        }
        let session_id = &name[..name.len() - 6];
        if !is_valid_uuid(session_id) {
            continue;
        }
        let Some((head, tail, mtime)) = read_head_tail(&p) else {
            continue;
        };
        if let Some(mut info) = session_meta_from_lite(&head, &tail, session_id, mtime) {
            info.file = p.to_string_lossy().to_string();
            out.push(info);
        }
    }
    out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    out
}

/// 置顶会话的展示项：会话元数据 + 所属项目路径
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PinnedSessionInfo {
    session_id: String,
    /// 最终显示标题：customTitle > aiTitle > 首条用户消息
    title: String,
    /// 副行摘要：customTitle > lastPrompt > summary > 首条用户消息
    summary: String,
    /// 最后修改时间（文件 mtime，epoch ms）
    last_modified: i64,
    /// jsonl 文件绝对路径（取消置顶时回传）
    file: String,
    /// 所属项目绝对路径：前端据此显示项目名徽标、判断项目失效，并支持 resume
    project_path: String,
}

/// 按置顶清单实时解析元数据（不存快照，重命名/新消息立刻反映）。
/// 文件已不存在的条目直接跳过、不报错：删除进回收站的会话条目是**故意保留**的，
/// 从回收站恢复后路径复原即自动复活；彻底删除由 prune_dead_pins 清条目。
fn pinned_meta_in(pins: &[PinnedSession], projects_dir: &Path) -> Vec<PinnedSessionInfo> {
    let mut out = Vec::new();
    for pin in pins {
        let path = PathBuf::from(&pin.file);
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".jsonl") || !path.starts_with(projects_dir) {
            continue;
        }
        let session_id = name[..name.len() - 6].to_string();
        if !is_valid_uuid(&session_id) {
            continue;
        }
        let Some((head, tail, mtime)) = read_head_tail(&path) else {
            continue;
        };
        let Some(info) = session_meta_from_lite(&head, &tail, &session_id, mtime) else {
            continue;
        };
        out.push(PinnedSessionInfo {
            session_id: info.session_id,
            title: info.title,
            summary: info.summary,
            last_modified: info.last_modified,
            file: path.to_string_lossy().to_string(),
            project_path: pin.project_path.clone(),
        });
    }
    out
}

/// 置顶区数据源：按 config 里的置顶顺序逐个解析，返回顺序即展示顺序
#[tauri::command]
async fn list_pinned_sessions() -> Vec<PinnedSessionInfo> {
    let cfg = load_config();
    pinned_meta_in(&cfg.pinned_sessions, &claude_projects_dir())
}

// ---------------- 会话内容读取（v2.0.0 阶段二：方向 A 只读查看） ----------------

/// 从 content 块数组中提取文本（tool_result 的 content 可能是 string 或数组）
fn block_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<&str> = arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

/// 提取 XML 标签内容（简单字符串匹配，不处理嵌套同名标签）
fn extract_xml_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let rest = &s[start..];
    let end = rest.find(&close)?;
    let t = rest[..end].trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 解析一条消息的 content 为内容块列表。命令消息（<command-name> 等）返回空。
fn parse_content_blocks(content: Option<&serde_json::Value>, role: &str) -> Vec<ContentBlock> {
    let mut out = Vec::new();
    match content {
        Some(serde_json::Value::String(s)) => {
            // 命令消息（/init 等）不算实质对话内容
            if s.contains("<command-name>") || s.contains("<command-message>") {
                return out;
            }
            // 后台任务完成通知（<task-notification> 包裹，Claude Code 以 user 字符串
            // 消息写入）→ 按工具结果展示，不当作普通用户输入。
            // 内容字段：<result> 结果正文（Markdown）> <summary> 一行摘要 > 整块文本；
            // 完整输出在 <output-file> 指向的临时文件里（不跨进程读取）。
            if s.contains("<task-notification>") {
                let text = extract_xml_tag(s, "result")
                    .or_else(|| extract_xml_tag(s, "summary"))
                    .or_else(|| extract_xml_tag(s, "task-notification"));
                if let Some(t) = text {
                    out.push(ContentBlock {
                        kind: "tool_result".to_string(),
                        text: Some(t),
                        name: None,
                        input: None,
                        tool_use_id: extract_xml_tag(s, "tool-use-id"),
                        is_error: None,
                    });
                }
                return out;
            }
            let t = s.trim();
            if !t.is_empty() {
                out.push(ContentBlock {
                    kind: "text".to_string(),
                    text: Some(t.to_string()),
                    name: None,
                    input: None,
                    tool_use_id: None,
                    is_error: None,
                });
            }
        }
        Some(serde_json::Value::Array(arr)) => {
            for b in arr {
                let Some(ty) = b.get("type").and_then(|t| t.as_str()) else {
                    continue;
                };
                match ty {
                    "text" | "thinking" => {
                        // text 块字段是 text；thinking 块字段是 thinking；tool_result 才是 content
                        let raw = b
                            .get("text")
                            .or_else(|| b.get("thinking"))
                            .or_else(|| b.get("content"));
                        if let Some(t) = raw.and_then(block_text) {
                            out.push(ContentBlock {
                                kind: ty.to_string(),
                                text: Some(t),
                                name: None,
                                input: None,
                                tool_use_id: None,
                                is_error: None,
                            });
                        }
                    }
                    "tool_use" => {
                        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if !name.is_empty() {
                            out.push(ContentBlock {
                                kind: "tool_use".to_string(),
                                text: None,
                                name: Some(name.to_string()),
                                input: b.get("input").cloned(),
                                // tool_use 块的 id（tool_result 的 tool_use_id 关联它）
                                tool_use_id: b
                                    .get("id")
                                    .and_then(|i| i.as_str())
                                    .map(String::from),
                                is_error: None,
                            });
                        }
                    }
                    "tool_result" => {
                        let text = b.get("content").and_then(block_text);
                        if let Some(t) = text {
                            out.push(ContentBlock {
                                kind: "tool_result".to_string(),
                                text: Some(t),
                                name: None,
                                input: None,
                                tool_use_id: b.get("tool_use_id").and_then(|i| i.as_str()).map(String::from),
                                is_error: b.get("is_error").and_then(|e| e.as_bool()),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {
            // assistant 的 content 可能是字符串（旧格式），上面 String 分支已处理；
            // 其它类型（如直接文本对象）忽略
            let _ = role;
        }
    }
    out
}

/// 解析 jsonl 全文为会话消息列表（核心逻辑，供 command 与测试复用）：
/// 只提取 user/assistant 消息，过滤元数据行 / sidechain / isMeta / 命令消息。
/// **相邻同 message.id 的 assistant 行合并为一条**：Claude Code 流式写入把
/// 一次响应拆成多行（每块一行，共享 usage），不合并会重复显示且统计虚高。
/// **usage 按 message.id 全局只计一次**：同 id 的多行可能被 user/tool_result
/// 行隔开（代理的多段迭代共用一个 message.id），段间被打断后各自成条显示，
/// 但 usage 若跟着段走会被 aggregate_usage 重复累加（实测 21.3M 显示成 32.8M）。
fn parse_session_messages(content: &str) -> Vec<SessionMessage> {
    let mut messages: Vec<SessionMessage> = Vec::new();
    let mut last_msg_id: Option<String> = None;
    let mut usage_counted_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let Some(ty) = v.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        if ty != "user" && ty != "assistant" {
            continue;
        }
        // sidechain / isMeta 消息跳过（与列表过滤语义一致）
        if v.get("isSidechain").and_then(|s| s.as_bool()).unwrap_or(false) {
            continue;
        }
        if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(role) = msg.get("role").and_then(|r| r.as_str()) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let blocks = parse_content_blocks(msg.get("content"), role);
        if blocks.is_empty() {
            continue;
        }
        let msg_id = msg.get("id").and_then(|i| i.as_str()).map(String::from);
        // 相邻同 id：同一响应的后续块，追加进上一条消息（usage 取首行——各行相同）
        if let (Some(id), Some(last)) = (&msg_id, &last_msg_id) {
            if id == last {
                if let Some(last_msg) = messages.last_mut() {
                    last_msg.blocks.extend(blocks);
                    continue;
                }
            }
        }
        // usage 只在 id 首次出现时计入（HashSet::insert 返回 false = 已见过）；
        // 无 id 的行无从去重，维持原样
        let usage = match &msg_id {
            Some(id) => {
                if usage_counted_ids.insert(id.clone()) {
                    parse_usage(msg.get("usage"))
                } else {
                    None
                }
            }
            None => parse_usage(msg.get("usage")),
        };
        messages.push(SessionMessage {
            kind: role.to_string(),
            blocks,
            timestamp: v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            model: msg.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
            usage,
        });
        last_msg_id = msg_id;
    }
    messages
}

/// 向上分页切片：默认返回**最后** limit 条（打开会话时焦点在最新）；
/// 传 offset 返回从该位置起的 limit 条（加载更早时传 offset - limit）。
fn slice_messages(
    all: Vec<SessionMessage>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> SessionMessages {
    let stats = aggregate_usage(&all);
    let total = all.len();
    let limit = limit.unwrap_or(MAX_SESSION_MESSAGES).clamp(1, 2000);
    let start = match offset {
        Some(o) => o.min(total),
        None => total.saturating_sub(limit),
    };
    let end = (start + limit).min(total);
    let messages = if start < end {
        all[start..end].to_vec()
    } else {
        Vec::new()
    };
    SessionMessages {
        messages,
        has_more: start > 0,
        total,
        offset: start,
        stats,
    }
}

/// 对全量消息聚合 token 统计（usage 是解析时保留的，分页切片不影响准确性）
fn aggregate_usage(messages: &[SessionMessage]) -> SessionUsageStats {
    let mut stats = SessionUsageStats::default();
    stats.message_count = messages.len();
    for m in messages {
        if let Some(u) = &m.usage {
            stats.input_tokens += u.input_tokens;
            stats.output_tokens += u.output_tokens;
            stats.cache_read_tokens += u.cache_read_input_tokens;
            stats.cache_creation_tokens += u.cache_creation_input_tokens;
        }
    }
    stats.total_tokens = stats.input_tokens
        + stats.output_tokens
        + stats.cache_read_tokens
        + stats.cache_creation_tokens;
    stats
}

/// 防御式解析 usage 字段（旧格式字段为数字；新格式 `input_tokens` 是
/// `{cache_read, cache_creation, input}` 嵌套对象）。无 usage 返回 None。
fn parse_usage(v: Option<&serde_json::Value>) -> Option<Usage> {
    let obj = v?.as_object()?;
    let num = |k: &str| obj.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let (input_tokens, cache_read, cache_creation) = match obj.get("input_tokens") {
        Some(serde_json::Value::Number(n)) => (
            n.as_u64().unwrap_or(0),
            num("cache_read_input_tokens"),
            num("cache_creation_input_tokens"),
        ),
        Some(serde_json::Value::Object(o)) => {
            let read = |k: &str| o.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            (
                read("input"),
                // 新格式嵌套字段缺省时回退到顶层（部分版本两层都有）
                read("cache_read").max(num("cache_read_input_tokens")),
                read("cache_creation").max(num("cache_creation_input_tokens")),
            )
        }
        _ => (num("input_tokens"), num("cache_read_input_tokens"), num("cache_creation_input_tokens")),
    };
    Some(Usage {
        input_tokens,
        output_tokens: num("output_tokens"),
        cache_read_input_tokens: cache_read,
        cache_creation_input_tokens: cache_creation,
    })
}

/// 读取会话内容（只读查看用，向上分页）。在 Tauri 线程池执行，不阻塞 UI。
#[tauri::command]
async fn get_session_messages(
    file: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<SessionMessages, String> {
    let (path, _) = validate_session_file(&file)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    Ok(slice_messages(parse_session_messages(&content), offset, limit))
}

/// 对话进度条的一格：一条用户发言（左侧导航轨用）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionUserPrompt {
    /// 消息全局序号（与 get_session_messages 的序号一致，点击定位用）
    index: usize,
    /// 发言文本（清洗后，供悬停预览）
    text: String,
    timestamp: Option<String>,
}

/// 提取全量用户发言（对话进度条）：只有带文本的 user 消息算数——
/// 命令消息（<command-name> 等）、本地命令回显、工具结果消息、
/// 中断提示都不算用户发言。
fn user_prompts_impl(content: &str) -> Vec<SessionUserPrompt> {
    parse_session_messages(content)
        .into_iter()
        .enumerate()
        .filter_map(|(index, m)| {
            if m.kind != "user" {
                return None;
            }
            let text = m
                .blocks
                .iter()
                .filter(|b| b.kind == "text")
                .filter_map(|b| b.text.as_deref())
                .collect::<Vec<_>>()
                .join(" ");
            if text.contains("<command-name>")
                || text.contains("<command-message>")
                || text.contains("<local-command-stdout>")
                || text.trim_start().starts_with("[Request interrupted")
            {
                return None;
            }
            let cleaned = clean_summary(&text);
            if cleaned.is_empty() {
                return None;
            }
            Some(SessionUserPrompt {
                index,
                text: cleaned,
                timestamp: m.timestamp,
            })
        })
        .collect()
}

/// 会话全量用户发言（对话进度条导航）。在 Tauri 线程池执行，不阻塞 UI。
#[tauri::command]
async fn get_session_user_prompts(file: String) -> Result<Vec<SessionUserPrompt>, String> {
    let (path, _) = validate_session_file(&file)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    Ok(user_prompts_impl(&content))
}

// ---------------- 会话全文搜索（会话域增强包） ----------------

/// 构造命中上下文片段：命中处前后各 radius 字节，回退到字符边界后切片。
/// hit 字节偏移来自小写化后的文本（大小写折叠可能改变字节长度），
/// floor/ceil_char_boundary 保证绝不 panic，偶发一两字符漂移可接受。
fn make_snippet(text: &str, hit: usize, kw_len: usize, radius: usize) -> String {
    let len = text.len();
    let start = text.floor_char_boundary(hit.saturating_sub(radius).min(len));
    let end = text.ceil_char_boundary((hit + kw_len + radius).min(len));
    text[start..end].replace('\n', " ")
}

/// 搜索会话内容：text 块全文 + tool_use 的输入 JSON（file_path/command 等），
/// 跳过 thinking / tool_result；大小写不敏感，按消息顺序返回，最多 MAX_SEARCH_HITS 条。
fn search_session_messages_impl(content: &str, keyword: &str) -> Vec<SessionSearchHit> {
    let kw = keyword.trim().to_lowercase();
    if kw.is_empty() {
        return Vec::new();
    }
    let messages = parse_session_messages(content);
    let mut out = Vec::new();
    'outer: for (index, m) in messages.iter().enumerate() {
        for (block_index, b) in m.blocks.iter().enumerate() {
            let hay = match b.kind.as_str() {
                "text" => b.text.clone().unwrap_or_default(),
                "tool_use" => {
                    let mut s = b.name.clone().unwrap_or_default();
                    if let Some(input) = &b.input {
                        s.push(' ');
                        s.push_str(&input.to_string());
                    }
                    s
                }
                _ => continue,
            };
            let lower = hay.to_lowercase();
            let Some(hit) = lower.find(&kw) else {
                continue;
            };
            out.push(SessionSearchHit {
                index,
                block_index,
                kind: m.kind.clone(),
                snippet: make_snippet(&hay, hit, kw.len(), 40),
            });
            if out.len() >= MAX_SEARCH_HITS {
                break 'outer;
            }
        }
    }
    out
}

/// 会话全文搜索（关键词命中消息内容与工具调用输入）。在 Tauri 线程池执行。
#[tauri::command]
async fn search_session_messages(
    file: String,
    keyword: String,
) -> Result<Vec<SessionSearchHit>, String> {
    if keyword.trim().is_empty() {
        return Ok(Vec::new());
    }
    let (path, _) = validate_session_file(&file)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    Ok(search_session_messages_impl(&content, &keyword))
}

// ---------------- 会话导出（会话域增强包） ----------------

/// 把 ISO 时间戳简化为「YYYY-MM-DD HH:MM」（非法/缺失返回空串）
fn format_ts_display(iso: &str) -> String {
    // ISO 时间戳为 ASCII，字节切片安全（长度不足直接放弃）
    if iso.len() >= 16 && iso.as_bytes()[10] == b'T' {
        format!("{} {}", &iso[..10], &iso[11..16])
    } else {
        String::new()
    }
}

/// 工具摘要行（导出 Markdown 用，与前端 toolSummary 语义一致；input 不转储原文）
fn tool_summary_line(name: &str, input: &Option<serde_json::Value>) -> String {
    let obj = input.as_ref().and_then(|v| v.as_object());
    let get = |k: &str| obj.and_then(|o| o.get(k)).and_then(|v| v.as_str()).unwrap_or("");
    let leaf = |p: &str| p.split(['/', '\\']).last().unwrap_or(p).to_string();
    let clip = |s: &str, n: usize| -> String {
        let chars: Vec<char> = s.chars().collect();
        if chars.len() > n {
            chars[..n].iter().collect::<String>() + "…"
        } else {
            s.to_string()
        }
    };
    match name {
        "Bash" => format!("Bash · {}", clip(get("command"), 120)),
        "Read" => format!("Read · {}", leaf(get("file_path"))),
        "Write" => format!("Write · {}", leaf(get("file_path"))),
        "Edit" => format!("Edit · {}", leaf(get("file_path"))),
        "MultiEdit" => format!("MultiEdit · {}", leaf(get("file_path"))),
        "Glob" => format!("Glob · {}", get("pattern")),
        "Grep" => format!("Grep · {}", get("pattern")),
        "Agent" => format!("Agent · {}", get("description")),
        "TodoWrite" => "TodoWrite · 更新任务列表".to_string(),
        other => other.to_string(),
    }
}

/// 单条消息渲染为 Markdown 小节（导出用）：
/// text 原样、thinking 压缩为引用块、tool_use 摘要行、tool_result 截断 200 字符。
fn render_message_markdown(
    msg: &SessionMessage,
    tool_names: &std::collections::HashMap<String, String>,
) -> String {
    let mut out = String::new();
    let who = if msg.kind == "user" {
        "用户".to_string()
    } else {
        match &msg.model {
            Some(m) if !m.is_empty() => format!("Claude（{m}）"),
            _ => "Claude".to_string(),
        }
    };
    let ts = msg.timestamp.as_deref().map(format_ts_display).unwrap_or_default();
    out.push_str("\n## ");
    out.push_str(&who);
    if !ts.is_empty() {
        out.push_str(" · ");
        out.push_str(&ts);
    }
    out.push('\n');
    for b in &msg.blocks {
        match b.kind.as_str() {
            "text" => {
                if let Some(t) = &b.text {
                    out.push_str(t);
                    out.push('\n');
                }
            }
            "thinking" => out.push_str("> 💭 思考过程（省略）\n"),
            "tool_use" => {
                let line =
                    tool_summary_line(b.name.as_deref().unwrap_or("工具"), &b.input);
                out.push_str("🔧 ");
                out.push_str(&line);
                out.push('\n');
            }
            "tool_result" => {
                let name = b
                    .tool_use_id
                    .as_deref()
                    .and_then(|id| tool_names.get(id))
                    .map(|s| s.as_str())
                    .unwrap_or("工具");
                let text = b.text.as_deref().unwrap_or("");
                let chars: Vec<char> = text.chars().collect();
                let body: String = if chars.len() > 200 {
                    chars[..200].iter().collect::<String>() + "…"
                } else {
                    text.to_string()
                };
                out.push_str(&format!("📄 {name} 结果：{}\n", body.replace('\n', " ")));
            }
            _ => {}
        }
    }
    out
}

/// 渲染整个会话为 Markdown（导出用；不走分页，全量渲染）
fn render_session_markdown(messages: &[SessionMessage], title: &str) -> String {
    // tool_use_id → 工具名（与查看器 toolNames 同语义，跨消息关联）
    let mut tool_names = std::collections::HashMap::new();
    for m in messages {
        for b in &m.blocks {
            if b.kind == "tool_use" {
                if let Some(id) = &b.tool_use_id {
                    tool_names.insert(id.clone(), b.name.clone().unwrap_or_default());
                }
            }
        }
    }
    let title = title.trim();
    let mut out = format!(
        "# {}\n> 导出自 Claude助手 · {} 条消息\n",
        if title.is_empty() { "未命名会话" } else { title },
        messages.len()
    );
    for m in messages {
        out.push_str(&render_message_markdown(m, &tool_names));
    }
    out
}

/// 生成导出内容（核心逻辑，供 command 与测试复用）：
/// markdown = 渲染为文档；jsonl = 原样复制（保留原文，不做任何转换）。
fn build_export_bytes(content: &str, format: &str, title: &str) -> Result<Vec<u8>, String> {
    match format {
        "markdown" => Ok(render_session_markdown(&parse_session_messages(content), title).into_bytes()),
        "jsonl" => Ok(content.as_bytes().to_vec()),
        other => Err(format!("不支持的导出格式：{other}")),
    }
}

/// 导出会话到指定路径（markdown / jsonl）。在 Tauri 线程池执行，不阻塞 UI。
/// 返回写入的字节数。
#[tauri::command]
async fn export_session(
    file: String,
    dest_path: String,
    format: String,
) -> Result<u64, String> {
    let (path, session_id) = validate_session_file(&file)?;
    let dest = PathBuf::from(&dest_path);
    // Windows 文件系统大小写不敏感，PathBuf 相等比较却区分大小写，
    // 换大小写即可绕过「不能导出到会话文件本身」的检查覆盖原文件
    #[cfg(windows)]
    if dest.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy()) {
        return Err("导出目标不能是会话文件本身".to_string());
    }
    #[cfg(not(windows))]
    if dest == path {
        return Err("导出目标不能是会话文件本身".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    let title = read_head_tail(&path)
        .and_then(|(head, tail, _)| session_meta_from_lite(&head, &tail, &session_id, 0))
        .map(|i| i.title)
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "未命名会话".to_string());
    let bytes = build_export_bytes(&content, &format, &title)?;
    fs::write(&dest, &bytes).map_err(|e| format!("写入导出文件失败：{e}"))?;
    Ok(bytes.len() as u64)
}

// ---------------- 使用统计仪表盘 ----------------

/// 排行条目（项目/模型）的单日用量，供前端按时间范围过滤
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RankDayUsage {
    /// YYYY-MM-DD（消息 timestamp 的本地日期）
    date: String,
    tokens: u64,
    messages: usize,
    /// 该日归属的会话数（最后活跃日口径）；模型行恒为 0
    sessions: usize,
}

/// 单项目用量
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    /// 项目显示名
    name: String,
    /// 真实路径（unmangle 找到真实存在者；项目已删除时用首选候选）
    path: String,
    sessions: usize,
    messages: usize,
    tokens: u64,
    /// 按日期升序（范围过滤用）
    per_day: Vec<RankDayUsage>,
}

/// 单个模型的用量汇总
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// 完整模型名（前端简化显示日期后缀）
    model: String,
    tokens: u64,
    messages: usize,
    /// 按日期升序（范围过滤用；sessions 恒为 0）
    per_day: Vec<RankDayUsage>,
}

/// 单日用量
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    /// YYYY-MM-DD（消息 timestamp 的日期部分）
    date: String,
    tokens: u64,
    /// 当天有 assistant 消息的会话数（按 sessionId 去重）
    sessions: usize,
    /// 当天活跃的会话数（该日有任何消息的会话，跨天会话每天都计）——
    /// 趋势图 tooltip 用；sessions 是最后活跃日归属，跨天会话的前几天
    /// 会「有 token 却 0 会话」，与直觉不符
    active_sessions: usize,
    messages: usize,
}

/// 全局使用统计（仪表盘数据；订阅版 jsonl 无 costUSD，故只统计 token）
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    sessions: usize,
    messages: usize,
    /// 总 token（输入 + 输出 + 缓存读取 + 缓存写入）
    tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    /// 最早 / 最新消息日期（YYYY-MM-DD）
    earliest: Option<String>,
    latest: Option<String>,
    /// 按日期升序
    per_day: Vec<DailyUsage>,
    /// 按 token 倒序
    per_project: Vec<ProjectUsage>,
    /// 按 token 倒序
    per_model: Vec<ModelUsage>,
}

/// 单个 jsonl 文件的用量聚合（统计口径与查看器不同：**子代理消息也计入**——
/// 旧布局内联在父文件里的 `isSidechain` 行与新布局独立落盘的
/// `<会话>/subagents/*.jsonl` 都是真实 token 消耗；只提取字段不构造消息结构，
/// 比 parse_session_messages 轻得多）。
#[derive(Clone, Default)]
struct FileUsage {
    messages: usize,
    tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    /// date -> (tokens, messages)
    per_day: std::collections::BTreeMap<String, (u64, usize)>,
    /// model -> (tokens, messages)
    per_model: std::collections::HashMap<String, (u64, usize)>,
    /// date -> model -> (tokens, messages)（项目/模型排行按范围过滤用）
    per_day_model: std::collections::BTreeMap<String, std::collections::HashMap<String, (u64, usize)>>,
}

/// 公历日期 → Unix epoch 天数（Howard Hinnant days_from_civil，civil_from_days 的反函数）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ISO-8601 UTC 时间戳（Claude Code jsonl 的固定格式）→ epoch 毫秒。失败返回 None。
fn iso_to_epoch_ms(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(&b[r]).ok()?.parse::<i64>().ok()
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = if b.len() >= 23 { num(20..23).unwrap_or(0) } else { 0 };
    let days = days_from_civil(y, mo, d);
    Some((days * 86400 + h * 3600 + mi * 60 + s) * 1000 + ms)
}

/// UTC epoch 毫秒 + 时区偏移（分钟，东八区 = 480）→ 本地日期 YYYY-MM-DD
fn local_date_of(epoch_ms: i64, tz_offset_minutes: i64) -> String {
    let days = (epoch_ms + tz_offset_minutes * 60_000).div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 同一 message.id 的一个候选快照（流式写入把一次响应拆成多行，见
/// `better_usage_row` 的取舍规则）
struct UsageRow {
    /// 该行带 `stop_reason`——流式的收尾行，usage 是这次响应的最终值
    final_row: bool,
    tokens: u64,
    usage: Usage,
    model: String,
    /// 本地时区日期（YYYY-MM-DD）
    date: Option<String>,
}

/// 新行是否该取代旧行成为 message.id 的代表行：**收尾行优先**（带 `stop_reason`
/// 的那条），同为收尾行或同为中间行时取 token 更大者。
///
/// 不能简单地"取第一次出现"：部分写入次序下同一响应的前几行 usage 全 0（只有
/// thinking/text 块、没有 stop_reason），真实用量在收尾行上——取首行会把整条
/// 消息记成 0（实测有会话因此只统计到真实值的 1.3%）。
fn better_usage_row(new: &UsageRow, old: &UsageRow) -> bool {
    if new.final_row != old.final_row {
        return new.final_row;
    }
    new.tokens > old.tokens
}

/// 流式扫描一个 jsonl 的用量（核心逻辑，供 command 与测试复用）。
/// **按 message.id 取代表行**（见 `better_usage_row`）：同一响应的多行是不同
/// 时刻的快照，逐行相加会成倍虚高，取首行则可能取到全 0 的占位行。
/// **日期按本地时区归属**：timestamp 是 UTC，直接截日期会让单日统计错位
/// 一个时区（如东八区晚间高峰归到错误的日期）。
fn scan_file_usage(content: &str, tz_offset_minutes: i64) -> FileUsage {
    // 先按 id 收敛出代表行，读完再聚合（取首行的错误只能靠"读完才知道哪行是收尾行"避免）
    let mut rows: std::collections::HashMap<String, UsageRow> = std::collections::HashMap::new();
    // 无 message.id 的行无从去重（罕见），逐条计入
    let mut anonymous: Vec<UsageRow> = Vec::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(usage) = parse_usage(msg.get("usage")) else {
            continue;
        };
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .or_else(|| v.get("model").and_then(|m| m.as_str()))
            .unwrap_or("unknown")
            .to_string();
        // <synthetic> 是 Claude Code 本地生成的占位助手消息（打断应答「No response
        // requested.」/API 报错回显），usage 恒为 0：跳过，不进模型分布与消息计数
        if model == "<synthetic>" {
            continue;
        }
        let date = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(iso_to_epoch_ms)
            .map(|ms| local_date_of(ms, tz_offset_minutes));
        let row = UsageRow {
            final_row: msg.get("stop_reason").and_then(|s| s.as_str()).is_some(),
            tokens: usage.input_tokens
                + usage.output_tokens
                + usage.cache_read_input_tokens
                + usage.cache_creation_input_tokens,
            usage,
            model,
            date,
        };
        match msg.get("id").and_then(|i| i.as_str()) {
            Some(id) => {
                let replace = match rows.get(id) {
                    Some(old) => better_usage_row(&row, old),
                    None => true,
                };
                if replace {
                    rows.insert(id.to_string(), row);
                }
            }
            None => anonymous.push(row),
        }
    }

    let mut u = FileUsage::default();
    for row in rows.into_values().chain(anonymous) {
        u.messages += 1;
        u.tokens += row.tokens;
        u.input_tokens += row.usage.input_tokens;
        u.output_tokens += row.usage.output_tokens;
        u.cache_read_tokens += row.usage.cache_read_input_tokens;
        u.cache_creation_tokens += row.usage.cache_creation_input_tokens;
        if let Some(d) = &row.date {
            let e = u.per_day.entry(d.clone()).or_default();
            e.0 += row.tokens;
            e.1 += 1;
            let de = u
                .per_day_model
                .entry(d.clone())
                .or_default()
                .entry(row.model.clone())
                .or_default();
            de.0 += row.tokens;
            de.1 += 1;
        }
        let m = u.per_model.entry(row.model).or_default();
        m.0 += row.tokens;
        m.1 += 1;
    }
    u
}

/// 文件级用量缓存（mtime + size + 时区偏移失效）：弹窗反复打开时只有变更过的
/// jsonl 需要重扫；per_day 已是本地时区日期，时区变化也会触发重扫。size 必
/// 参与判失效——快速连续写入可能落在同一毫秒内（mtime 相同而内容已变，CI 快
/// 速环境必现），与台账「mtime+size 未变才跳过」的口径保持一致
static USAGE_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, u64, i64, FileUsage)>>,
> = std::sync::OnceLock::new();

/// 读取（必要时扫描）一个 jsonl 的用量，带 mtime 缓存
fn file_usage_cached(path: &Path, tz_offset_minutes: i64) -> Option<FileUsage> {
    let cache = USAGE_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    let size = meta.len();
    if let Ok(cache) = cache.lock() {
        if let Some((t, s, tz, u)) = cache.get(path) {
            if *t == mtime && *s == size && *tz == tz_offset_minutes {
                return Some(u.clone());
            }
        }
    }
    let content = fs::read_to_string(path).ok()?;
    let u = scan_file_usage(&content, tz_offset_minutes);
    if let Ok(mut cache) = cache.lock() {
        cache.insert(path.to_path_buf(), (mtime, size, tz_offset_minutes, u.clone()));
    }
    Some(u)
}

// ---------------- 用量台账（stats-ledger.json） ----------------
// 只扫现存文件的话，会话一旦删除（回收站/清空/Claude Code 自身清理），
// 其消耗就从统计里消失。台账按会话文件持久记录每份 jsonl 最后一次扫描
// 的用量：每次统计刷新现存文件的贡献，文件消失则保留最后记录——统计
// 口径因此是**历史累计消耗**。注意：台账建立之前已删除的会话无从恢复。

/// 台账中的单个会话文件记录（该 jsonl 最后一次被扫描时的用量）
#[derive(Serialize, Deserialize, Clone, Default)]
struct LedgerEntry {
    mtime: u64,
    size: u64,
    session_id: String,
    /// 项目 mangled 目录名（文件删除后仍能反解候选路径判断是否被排除）
    project_dir: String,
    project_name: String,
    project_path: String,
    messages: usize,
    tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    /// date -> (tokens, messages)（按记录时的本地时区归属）
    per_day: std::collections::BTreeMap<String, (u64, usize)>,
    /// model -> (tokens, messages)
    per_model: std::collections::HashMap<String, (u64, usize)>,
    /// date -> model -> (tokens, messages)（项目/模型排行按范围过滤用）
    #[serde(default)]
    per_day_model: std::collections::BTreeMap<String, std::collections::HashMap<String, (u64, usize)>>,
}

/// 用量台账（数据根 stats-ledger.json）
#[derive(Serialize, Deserialize, Default)]
struct StatsLedger {
    /// 台账结构版本：不一致（含旧文件缺字段 → 0）则现存文件全部重扫一次
    #[serde(default)]
    version: u32,
    /// 记录时的时区偏移（分钟）：per_day 与时区相关，变化则现存文件全部重扫。
    /// 必须有 default：缺字段会让整本台账反序列化失败清零（version 缺省为 0 ≠
    /// LEDGER_VERSION 会触发全量重扫，所以兜底值不影响口径正确性）
    #[serde(default)]
    tz_offset_minutes: i64,
    /// key = 会话文件绝对路径
    #[serde(default)]
    files: std::collections::HashMap<String, LedgerEntry>,
}

/// v2：LedgerEntry 新增 per_day_model（排行按范围过滤）
/// v3：扫描范围补上 `<会话>/subagents/**` 子代理文件 + 同一 message.id 改取收尾行
///     （旧版取首行，占位行会把整条消息记成 0）——老条目口径不对，须全量重扫
const LEDGER_VERSION: u32 = 3;

fn ledger_path_in(root: &Path) -> PathBuf {
    root.join("stats-ledger.json")
}

/// 读取台账：文件缺失/损坏时返回空台账（丢失的只是已删会话历史，现存文件会重建）
fn load_ledger_from(root: &Path) -> StatsLedger {
    match fs::read_to_string(ledger_path_in(root)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => StatsLedger::default(),
    }
}

/// 写临时文件 → 原子替换（与 save_config 同套路；台账可从现存文件重建，不做 .bak）
fn save_ledger_to(root: &Path, ledger: &StatsLedger) {
    let path = ledger_path_in(root);
    let Ok(json) = serde_json::to_string(ledger) else {
        return;
    };
    let tmp = ledger_path_in(root).with_extension("json.tmp");
    if fs::write(&tmp, json).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// 枚举一个项目目录下的用量 jsonl（固定深度、不递归，与 Claude Code 的落盘布局对齐）：
///
/// ```text
/// <项目>/*.jsonl                                      主会话
/// <项目>/<会话 uuid>/subagents/*.jsonl                Task/Agent 子代理
/// <项目>/<会话 uuid>/subagents/workflows/wf_*/*.jsonl Workflow 子代理
/// ```
///
/// 返回 (文件路径, 归属会话 uuid)。子代理文件**归属其父会话**：它们不是独立会话，
/// 拿 `agent-xxx` 当会话 id 会让会话数随子代理数量虚增。只认 uuid 命名的目录，
/// 项目目录下的 `memory/` 等无关目录自然跳过。
///
/// 漏掉 subagents 一层会让子代理（很吃 token）的消耗整块消失——实测某模型因此
/// 只统计到真实值的一半。
fn usage_jsonl_files(project_dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(project_dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_file() {
            if let Some(sid) = name.strip_suffix(".jsonl") {
                if is_valid_uuid(sid) {
                    out.push((p, sid.to_string()));
                }
            }
            continue;
        }
        if !is_valid_uuid(&name) {
            continue;
        }
        let subagents = p.join("subagents");
        push_jsonl_files_in(&subagents, &name, &mut out);
        // Workflow 子代理比普通子代理多嵌套一层 workflows/wf_<ID>/
        let Ok(workflows) = fs::read_dir(subagents.join("workflows")) else {
            continue;
        };
        for w in workflows.flatten() {
            if w.path().is_dir() {
                push_jsonl_files_in(&w.path(), &name, &mut out);
            }
        }
    }
    out
}

/// 目录下直接子层的 .jsonl 全部收下（不递归）。不按文件名过滤：子代理目录里的
/// `journal.jsonl` 没有 assistant 行，扫描时天然跳过。
fn push_jsonl_files_in(dir: &Path, session_id: &str, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push((p, session_id.to_string()));
        }
    }
}

/// 汇总所有项目的用量统计（核心逻辑，供 command 与测试复用）。
/// projects: (显示名, 真实路径, 项目目录) 列表；日期按 tz_offset_minutes 归属本地时区。
/// 台账驱动：现存且未变的文件复用上次记录，变更的重扫覆盖，消失的保留
/// 历史——统计 = 全部台账条目之和（含已删除会话）。excluded 为排除项目
/// 的路径清单（与其余口径一致：任一候选命中即整体不计，含其历史）。
fn aggregate_stats_ledger(
    projects: &[(String, String, PathBuf)],
    excluded: &[String],
    tz_offset_minutes: i64,
    ledger: &mut StatsLedger,
) -> UsageStats {
    // 时区变化：per_day 与时区相关，现存文件需全部重扫（已删条目保留旧时区归属）
    // 台账版本不一致（旧文件缺 per_day_model）同理全部重扫一次
    let tz_changed = ledger.tz_offset_minutes != tz_offset_minutes;
    ledger.tz_offset_minutes = tz_offset_minutes;
    let full_rescan = tz_changed || ledger.version != LEDGER_VERSION;
    ledger.version = LEDGER_VERSION;

    // ---- 刷新现存文件 ----
    for (name, path, dir) in projects {
        let project_dir = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        for (p, session_id) in usage_jsonl_files(dir) {
            let key = p.to_string_lossy().to_string();
            let meta = fs::metadata(&p).ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let size = meta.map(|m| m.len()).unwrap_or(0);
            // 命中台账且未变更（且时区未变、版本一致）→ 无需重扫；项目显示名/路径随扫描刷新
            if let Some(mtime) = mtime {
                if !full_rescan {
                    if let Some(entry) = ledger.files.get(&key) {
                        if entry.mtime == mtime && entry.size == size {
                            let entry = ledger.files.get_mut(&key).unwrap();
                            entry.project_name = name.clone();
                            entry.project_path = path.clone();
                            continue;
                        }
                    }
                }
            }
            let Some(u) = file_usage_cached(&p, tz_offset_minutes) else {
                continue;
            };
            if u.messages == 0 {
                continue; // 无任何 token 数据的会话不占统计口径
            }
            ledger.files.insert(
                key,
                LedgerEntry {
                    mtime: mtime.unwrap_or(0),
                    size,
                    session_id: session_id.to_string(),
                    project_dir: project_dir.clone(),
                    project_name: name.clone(),
                    project_path: path.clone(),
                    messages: u.messages,
                    tokens: u.tokens,
                    input_tokens: u.input_tokens,
                    output_tokens: u.output_tokens,
                    cache_read_tokens: u.cache_read_tokens,
                    cache_creation_tokens: u.cache_creation_tokens,
                    per_day: u.per_day.clone(),
                    per_model: u.per_model.clone(),
                    per_day_model: u.per_day_model.clone(),
                },
            );
        }
    }

    // ---- 被排除项目的历史一并移除（与现存口径一致：排除即整体不计）----
    ledger.files.retain(|_, e| {
        !unmangle_candidates(&e.project_dir)
            .iter()
            .any(|c| excluded.iter().any(|x| x.eq_ignore_ascii_case(c)))
    });

    // ---- 聚合全部台账条目（含已删除会话）----
    let mut stats = UsageStats::default();
    // 每日会话数（date -> sessionId 集合）：会话归属其**最后活跃日**，
    // 跨天会话只计一次——任意日期窗口内每日 sessions 累加恰好等于窗口内
    // 去重会话数，与「全部」的 stats.sessions 口径一致（否则跨天会话在
    // 窗口内被重复计入，出现「全部比近 30 天还少」的反直觉结果）
    let mut day_sessions: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    // 当日活跃会话（date -> sessionId 集合）：跨天会话在每个活跃日都计，
    // 供趋势图 tooltip 展示「当天到底有几个会话在跑」
    let mut day_active: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    let mut day_map: std::collections::BTreeMap<String, (u64, usize)> =
        std::collections::BTreeMap::new();
    let mut model_map: std::collections::HashMap<String, (u64, usize)> =
        std::collections::HashMap::new();
    // 项目聚合按真实路径去重（同一项目目录的已删/现存条目归并到一行），
    // 同时攒按天明细供前端按范围过滤（项目行内 sessions 用最后活跃日口径，
    // 与汇总卡一致：窗口内累加 = 窗口内去重会话数）
    // 会话数按 session_id 去重（全局与项目行都是）：子代理/workflow 文件的
    // session_id 记的是父会话（见 usage_jsonl_files），按文件计数会把一个
    // 会话算成好几个，也会与「按日累加 = 去重会话数」的口径打架
    let mut seen_sessions: std::collections::HashSet<String> = std::collections::HashSet::new();
    struct ProjectAgg {
        name: String,
        path: String,
        sessions: usize,
        session_ids: std::collections::HashSet<String>,
        messages: usize,
        tokens: u64,
        days: std::collections::BTreeMap<String, (u64, usize)>,
        day_sessions: std::collections::HashMap<String, std::collections::HashSet<String>>,
    }
    let mut project_map: std::collections::HashMap<String, ProjectAgg> =
        std::collections::HashMap::new();
    // 模型按天明细（model -> date -> (tokens, messages)）
    let mut model_days: std::collections::HashMap<
        String,
        std::collections::BTreeMap<String, (u64, usize)>,
    > = std::collections::HashMap::new();
    for e in ledger.files.values() {
        if seen_sessions.insert(e.session_id.clone()) {
            stats.sessions += 1;
        }
        stats.messages += e.messages;
        stats.tokens += e.tokens;
        stats.input_tokens += e.input_tokens;
        stats.output_tokens += e.output_tokens;
        stats.cache_read_tokens += e.cache_read_tokens;
        stats.cache_creation_tokens += e.cache_creation_tokens;
        for (d, (t, m)) in &e.per_day {
            let dm = day_map.entry(d.clone()).or_default();
            dm.0 += t;
            dm.1 += m;
            day_active.entry(d.clone()).or_default().insert(e.session_id.clone());
        }
        // token/消息按天累加，但会话数只记到 per_day 的最后一天
        // （BTreeMap 末 key = 最后活跃日）
        if let Some(last_day) = e.per_day.keys().next_back() {
            day_sessions
                .entry(last_day.clone())
                .or_default()
                .insert(e.session_id.clone());
        }
        for (mo, (t, m)) in &e.per_model {
            let mm = model_map.entry(mo.clone()).or_default();
            mm.0 += t;
            mm.1 += m;
        }
        for (d, models) in &e.per_day_model {
            for (mo, (t, m)) in models {
                let md = model_days.entry(mo.clone()).or_default();
                let e2 = md.entry(d.clone()).or_default();
                e2.0 += t;
                e2.1 += m;
            }
        }
        let pa = project_map
            .entry(e.project_path.clone())
            .or_insert_with(|| ProjectAgg {
                name: e.project_name.clone(),
                path: e.project_path.clone(),
                sessions: 0,
                session_ids: Default::default(),
                messages: 0,
                tokens: 0,
                days: Default::default(),
                day_sessions: Default::default(),
            });
        if pa.session_ids.insert(e.session_id.clone()) {
            pa.sessions += 1;
        }
        pa.messages += e.messages;
        pa.tokens += e.tokens;
        for (d, (t, m)) in &e.per_day {
            let de = pa.days.entry(d.clone()).or_default();
            de.0 += t;
            de.1 += m;
        }
        if let Some(last_day) = e.per_day.keys().next_back() {
            pa.day_sessions
                .entry(last_day.clone())
                .or_default()
                .insert(e.session_id.clone());
        }
    }
    stats.earliest = day_map.keys().next().cloned();
    stats.latest = day_map.keys().next_back().cloned();
    stats.per_day = day_map
        .into_iter()
        .map(|(date, (tokens, messages))| DailyUsage {
            sessions: day_sessions.get(&date).map(|s| s.len()).unwrap_or(0),
            active_sessions: day_active.get(&date).map(|s| s.len()).unwrap_or(0),
            date,
            tokens,
            messages,
        })
        .collect();
    stats.per_model = model_map
        .into_iter()
        // 老台账条目里可能已存有 <synthetic>（零 token 占位消息），聚合出口再滤一次
        .filter(|(model, _)| model != "<synthetic>")
        .map(|(model, (tokens, messages))| ModelUsage {
            per_day: model_days
                .remove(&model)
                .unwrap_or_default()
                .into_iter()
                .map(|(date, (tokens, messages))| RankDayUsage {
                    date,
                    tokens,
                    messages,
                    sessions: 0,
                })
                .collect(),
            model,
            tokens,
            messages,
        })
        .collect();
    stats.per_model.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    stats.per_project = project_map
        .into_values()
        .map(|pa| {
            let ProjectAgg {
                name,
                path,
                sessions,
                session_ids: _,
                messages,
                tokens,
                days,
                day_sessions,
            } = pa;
            ProjectUsage {
                per_day: days
                    .into_iter()
                    .map(|(date, (tokens, messages))| RankDayUsage {
                        sessions: day_sessions.get(&date).map(|s| s.len()).unwrap_or(0),
                        date,
                        tokens,
                        messages,
                    })
                    .collect(),
                name,
                path,
                sessions,
                messages,
                tokens,
            }
        })
        .collect();
    stats.per_project.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    stats
}

/// 一次性聚合（无台账持久化，仅供旧测试语义）
#[cfg(test)]
fn aggregate_stats_in(projects: &[(String, String, PathBuf)], tz_offset_minutes: i64) -> UsageStats {
    let mut ledger = StatsLedger::default();
    aggregate_stats_ledger(projects, &[], tz_offset_minutes, &mut ledger)
}

/// 全局使用统计（仪表盘）。在 Tauri 线程池执行，不阻塞 UI。
/// 口径：excluded（用户已移除）的项目不统计；已删除（missing）的项目仍统计；
/// 会话文件删除后其历史用量保留在台账中（统计 = 历史累计消耗）。
/// tz_offset_minutes：本地时区偏移（东八区 = 480），单日统计按本地日期归属。
#[tauri::command]
async fn get_usage_stats(tz_offset_minutes: Option<i64>) -> Result<UsageStats, String> {
    // 全量扫描属重 I/O，挪到阻塞线程池（tokio worker 上直接做同步文件读会占死 worker）
    tauri::async_runtime::spawn_blocking(move || {
        let dir = claude_projects_dir();
        let excluded = load_config().excluded;
        let mut projects: Vec<(String, String, PathBuf)> = Vec::new();
        let Ok(entries) = fs::read_dir(&dir) else {
            return Ok(UsageStats::default());
        };
        for e in entries.flatten() {
            let d = e.path();
            if !d.is_dir() {
                continue;
            }
            let mangled = e.file_name().to_string_lossy().to_string();
            let candidates = unmangle_candidates(&mangled);
            let real = candidates.iter().find(|c| Path::new(c).exists());
            // 与列表口径一致：任一候选路径命中排除清单即不统计
            let is_excluded = candidates
                .iter()
                .any(|c| excluded.iter().any(|x| x.eq_ignore_ascii_case(c)));
            if is_excluded {
                continue;
            }
            let (name, path) = match real {
                Some(r) => (
                    Path::new(r)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| mangled.clone()),
                    r.clone(),
                ),
                // 项目目录已不存在：用首选候选路径显示（历史会话仍有统计价值）
                None => (
                    mangled.clone(),
                    candidates.first().cloned().unwrap_or(mangled.clone()),
                ),
            };
            projects.push((name, path, d));
        }
        // 台账读改写持锁：并发两次统计会互相覆盖刚登记的条目（丢已删会话历史）
        let _guard = ledger_lock();
        let root = resolve_root_dir();
        let mut ledger = load_ledger_from(&root);
        let stats =
            aggregate_stats_ledger(&projects, &excluded, tz_offset_minutes.unwrap_or(0), &mut ledger);
        save_ledger_to(&root, &ledger);
        Ok(stats)
    })
    .await
    .map_err(|e| format!("统计任务执行失败：{e}"))?
}

/// 向会话 jsonl 追加 custom-title 行（核心逻辑，供 command 与测试复用）
fn append_custom_title(path: &Path, session_id: &str, title: &str) -> Result<(), String> {
    use std::io::Write;
    let line = serde_json::json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": session_id,
    })
    .to_string();
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("打开会话文件失败：{e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("写入会话文件失败：{e}"))
}

/// 校验会话文件路径：必须位于 Claude Code 项目目录下、名称为 <uuid>.jsonl。
/// 返回 (path, session_id)。
fn validate_session_file(file: &str) -> Result<(PathBuf, String), String> {
    validate_session_file_in(file, &claude_projects_dir())
}

fn validate_session_file_in(file: &str, projects_dir: &Path) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(file);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("非法会话文件名")?;
    if !name.ends_with(".jsonl") {
        return Err("非法会话文件".to_string());
    }
    let session_id = name[..name.len() - 6].to_string();
    if !is_valid_uuid(&session_id) {
        return Err("非法会话文件".to_string());
    }
    // starts_with 是逐组件词法前缀匹配，不规范化 `..`（`projects/../x` 也能通过），
    // 必须先 canonicalize 成真实绝对路径再比对（顺带统一 \\?\ 前缀与大小写）
    let dir_canon = projects_dir
        .canonicalize()
        .map_err(|_| "会话文件不在 Claude Code 目录中".to_string())?;
    let canon = path
        .canonicalize()
        .map_err(|_| "会话文件不存在".to_string())?;
    if !canon.starts_with(&dir_canon) {
        return Err("会话文件不在 Claude Code 目录中".to_string());
    }
    Ok((path, session_id))
}

/// 重命名会话：向 jsonl **追加**一行 custom-title（Claude Code CLI 的 /rename
/// 同机制，改完后官方 CLI 与第三方工具均识别新标题）。不修改/覆盖原文件。
#[tauri::command]
fn rename_session(file: String, new_title: String) -> Result<(), String> {
    let (path, session_id) = validate_session_file(&file)?;
    // 标题清洗：去控制字符、trim、限长
    let title: String = new_title
        .chars()
        .map(|c| if c == '\r' || c == '\n' || c == '\t' { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let title: String = title.chars().take(200).collect();
    append_custom_title(&path, &session_id, &title)
}

/// 从 Unix epoch 秒计算公历日期（civil_from_days 算法），返回 (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC 时间戳目录名：YYYYMMDD_HHMMSS（备份/回收站目录用，与全局
/// 「破坏性操作先备份」铁律的 cache_backup_20260807_1300 风格一致）。
/// 注意这是 UTC 墙钟时间；前端回收站按 UTC 解析后转本地时区显示
/// （TrashDialog.formatDeletedAt），别把它当本地时间直接展示
fn utc_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    format!("{y:04}{m:02}{d:02}_{h:02}{mi:02}{s:02}")
}

/// 删除会话文件的核心逻辑：**先备份到 trash_root/<时间戳>/<项目>/ 再删除**
/// （数据安全铁律：破坏性操作先备份；备份即回收站，可恢复）。返回备份文件路径。
fn delete_session_file(path: &Path, trash_root: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("非法会话文件名")?;
    // 保留原项目 mangled 目录名，恢复时直接放回 projects/<mangled>/
    let mangled = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    let backup_dir = trash_root
        .join(utc_timestamp())
        .join(mangled);
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let backup = backup_dir.join(name);
    // 同卷 rename 原子优先；跨卷（便携模式 exe 在别的盘）回退 copy + remove
    if fs::rename(path, &backup).is_err() {
        fs::copy(path, &backup).map_err(|e| format!("备份会话失败：{e}"))?;
        fs::remove_file(path).map_err(|e| format!("删除会话失败：{e}"))?;
    }
    Ok(backup)
}

/// 删除会话：先移入回收站（trash/）再删除原文件。返回备份路径（前端提示可恢复）。
#[tauri::command]
fn delete_session(file: String) -> Result<String, String> {
    let (path, _) = validate_session_file(&file)?;
    let backup = delete_session_file(&path, &trash_root())?;
    Ok(backup.to_string_lossy().to_string())
}

/// 数据根下回收站目录：<root>/trash/sessions
fn trash_root() -> PathBuf {
    resolve_root_dir().join("trash").join("sessions")
}

/// 回收站中的一条会话备份
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashedSession {
    /// 备份文件绝对路径（恢复/永久删除时回传）
    file: String,
    /// 会话 ID
    session_id: String,
    /// 标题（复用会话元数据解析：customTitle > aiTitle > 首条消息）
    title: String,
    /// 删除时间（备份目录名 YYYYMMDD_HHMMSS）
    deleted_at: String,
    /// 原项目 mangled 目录名
    project_dir: String,
    /// 原项目路径（unmangle 反向解析，找到真实存在者；找不到则为空）
    project_path: Option<String>,
}

/// 列出回收站中的全部会话备份（按删除时间倒序）。trash_root 可注入（测试用临时目录）。
fn list_trashed_sessions_in(trash_root: &Path) -> Vec<TrashedSession> {
    let mut out = Vec::new();
    let Ok(batches) = fs::read_dir(trash_root) else {
        return out;
    };
    for batch in batches.flatten() {
        let ts = batch.file_name().to_string_lossy().to_string();
        let Ok(projects) = fs::read_dir(batch.path()) else {
            continue;
        };
        for proj in projects.flatten() {
            let project_dir = proj.file_name().to_string_lossy().to_string();
            let Ok(files) = fs::read_dir(proj.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if !p.is_file() {
                    continue;
                }
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let session_id = name[..name.len() - 6].to_string();
                if !is_valid_uuid(&session_id) {
                    continue;
                }
                // 复用会话元数据解析提取标题
                let title = match read_head_tail(&p) {
                    Some((head, tail, _)) => session_meta_from_lite(&head, &tail, &session_id, 0)
                        .map(|i| i.title)
                        .unwrap_or_else(|| "未命名会话".to_string()),
                    None => "未命名会话".to_string(),
                };
                // 反向解析原项目路径（取真实存在者）
                let project_path = unmangle_candidates(&project_dir)
                    .into_iter()
                    .find(|c| Path::new(c).exists());
                out.push(TrashedSession {
                    file: p.to_string_lossy().to_string(),
                    session_id,
                    title,
                    deleted_at: ts.clone(),
                    project_dir: project_dir.clone(),
                    project_path,
                });
            }
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    out
}

/// 列出回收站中的全部会话备份（按删除时间倒序）
#[tauri::command]
async fn list_trashed_sessions() -> Vec<TrashedSession> {
    // 每个备份文件都要 head/tail 读取与解析，回收站大时明显耗时，挪到阻塞线程池
    tauri::async_runtime::spawn_blocking(|| list_trashed_sessions_in(&trash_root()))
        .await
        .unwrap_or_default()
}

/// 校验回收站备份文件路径：必须位于数据根 trash/sessions/ 下、名称为 <uuid>.jsonl。
/// 返回 (path, session_id, mangled 项目目录名)。
fn validate_trash_file(file: &str) -> Result<(PathBuf, String, String), String> {
    validate_trash_file_in(file, &trash_root())
}

fn validate_trash_file_in(
    file: &str,
    trash_root: &Path,
) -> Result<(PathBuf, String, String), String> {
    let path = PathBuf::from(file);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("非法备份文件")?;
    if !name.ends_with(".jsonl") {
        return Err("非法备份文件".to_string());
    }
    let session_id = name[..name.len() - 6].to_string();
    if !is_valid_uuid(&session_id) {
        return Err("非法备份文件".to_string());
    }
    // 同 validate_session_file_in：canonicalize 后再比对，防 `..` 词法穿越
    let root_canon = trash_root
        .canonicalize()
        .map_err(|_| "备份文件不在回收站中".to_string())?;
    let canon = path
        .canonicalize()
        .map_err(|_| "备份文件不存在".to_string())?;
    if !canon.starts_with(&root_canon) {
        return Err("备份文件不在回收站中".to_string());
    }
    // 备份路径结构：trash/sessions/<ts>/<mangled>/<uuid>.jsonl
    let mangled = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .ok_or("非法备份文件")?
        .to_string();
    Ok((path, session_id, mangled))
}

/// 恢复会话的核心逻辑：移回 projects_root/<mangled>/。返回恢复后的路径。
fn restore_trashed_file(path: &Path, projects_root: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or("非法备份文件")?;
    // 备份路径结构：trash/sessions/<ts>/<mangled>/<uuid>.jsonl
    let mangled = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .ok_or("非法备份文件")?;
    let target_dir = projects_root.join(mangled);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建项目目录失败：{e}"))?;
    let target = target_dir.join(name);
    // 目标已存在（会话已恢复过）→ 拒绝，避免覆盖
    if target.exists() {
        return Err("目标位置已存在同名会话，请先确认是否已恢复过".to_string());
    }
    if fs::rename(path, &target).is_err() {
        fs::copy(path, &target).map_err(|e| format!("恢复会话失败：{e}"))?;
        fs::remove_file(path).map_err(|e| format!("清理备份失败：{e}"))?;
    }
    Ok(target)
}

/// 从回收站恢复会话：移回 ~/.claude/projects/<mangled>/，返回恢复后的路径。
#[tauri::command]
fn restore_session(file: String) -> Result<String, String> {
    let (path, _session_id, _mangled) = validate_trash_file(&file)?;
    let target = restore_trashed_file(&path, &claude_projects_dir())?;
    Ok(target.to_string_lossy().to_string())
}

/// 从回收站永久删除备份（不可恢复）。调用方必须已二次确认。
#[tauri::command]
fn purge_session(file: String) -> Result<(), String> {
    let (path, _, _) = validate_trash_file(&file)?;
    fs::remove_file(&path).map_err(|e| format!("删除备份失败：{e}"))?;
    prune_pins_after_purge();
    Ok(())
}

/// 彻底删除会话后清掉置顶清单里已失效的条目。保存失败只是条目多留一会儿，
/// 不影响删除结果，所以吞掉错误（与旧脚本迁移的落盘处理一致）。
fn prune_pins_after_purge() {
    let _guard = config_lock();
    let mut cfg = load_config();
    prune_dead_pins(&mut cfg);
    let _ = save_config_file(&resolve_root_dir(), &cfg);
}

/// 清空回收站的核心逻辑：彻底删除 trash/sessions 下的全部会话备份（释放磁盘空间，不可恢复）。
/// 调用方必须已二次确认。返回被删除的会话数。
fn purge_trash_in(trash_root: &Path) -> Result<usize, String> {
    let count = list_trashed_sessions_in(trash_root).len();
    if count == 0 {
        return Ok(0);
    }
    for entry in fs::read_dir(trash_root).map_err(|e| format!("读取回收站失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取回收站失败：{e}"))?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("删除备份目录失败：{e}"))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("删除备份失败：{e}"))?;
        }
    }
    Ok(count)
}

/// 清空回收站（彻底删除全部会话备份，释放磁盘空间，不可恢复）。调用方必须已二次确认。
#[tauri::command]
fn purge_trash() -> Result<usize, String> {
    let count = purge_trash_in(&trash_root())?;
    prune_pins_after_purge();
    Ok(count)
}

/// 通用反向解析：把 segments 按分隔符候选集枚举出全部路径。
/// seps[0] 是主分隔符（Windows `\` / macOS `/`），seps[1..] 是可能的
/// 合并字符（`-` `_` `.`）；「层级最多（全用主分隔符）」的候选排最前，
/// 调用方用 exists 验证取真实存在者。段过多（>5）时降级避免组合爆炸。
fn enum_segment_paths(
    segments: &[&str],
    seps: &[char],
    build: impl Fn(&[char]) -> String,
) -> Vec<String> {
    let gaps = segments.len() - 1; // 间隙数：每个间隙可能是主分隔符或合并字符
    if gaps == 0 {
        return vec![build(&[])];
    }
    if gaps > 5 {
        // 段过多：仅生成「全主分隔符」+「单个间隙合并」候选，避免组合爆炸
        let mut out = vec![build(&vec![seps[0]; gaps])];
        for i in 0..gaps {
            for c in &seps[1..] {
                let mut s = vec![seps[0]; gaps];
                s[i] = *c;
                out.push(build(&s));
            }
        }
        return out;
    }
    // 按合并间隙数 m 从少到多枚举（m 少 = 主分隔符多 = 层级多，优先）；
    // 选中间隙再遍历合并字符（- _ .），其余间隙当主分隔符
    let mut out = Vec::new();
    for m in 0..=gaps {
        let combos = combinations(gaps, m);
        for combo in combos {
            // 对选中的 m 个间隙做合并字符笛卡尔积
            let mut cart: Vec<Vec<char>> = vec![Vec::new()];
            for _ in 0..m {
                let mut next = Vec::new();
                for p in &cart {
                    for c in &seps[1..] {
                        let mut q = p.clone();
                        q.push(*c);
                        next.push(q);
                    }
                }
                cart = next;
            }
            for chars in cart {
                let mut seps_used = vec![seps[0]; gaps];
                for (pos, c) in combo.iter().zip(chars.iter()) {
                    seps_used[*pos] = *c;
                }
                out.push(build(&seps_used));
            }
        }
    }
    out
}

/// Claude Code 项目目录名的反向解析（Windows 版）。mangled 规则（实测）：
/// `:`、`\`、`_`、`.` 均替换为 `-`，`-` 保留，例如：
///   D:\MyWorkspaces\jikehongbao     → D--MyWorkspaces-jikehongbao
///   D:\WeChatProjects\tms_app       → D--WeChatProjects-tms-app
///   D:\MyWorkspaces\cms\DoraCMS-3.1 → D--MyWorkspaces-cms-DoraCMS-3-1
/// 反向存在歧义（每个 `-` 可能是 `\`/`_`/`.`/`-`），因此返回**按优先级排序的候选
/// 路径列表**：层级最多（`-` 尽量当分隔符）的解释优先，调用方用 exists 验证取真实存在者。
#[cfg(windows)]
fn unmangle_candidates(name: &str) -> Vec<String> {
    let b = name.as_bytes();
    // 格式：盘符字母 + "--"（':' 与根目录 '\' 各占一个 '-'）
    if b.len() < 3 || !(b[0] as char).is_ascii_alphabetic() || b[1] != b'-' || b[2] != b'-' {
        return Vec::new();
    }
    let drive = b[0] as char;
    let segments: Vec<&str> = name[3..].split('-').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Vec::new();
    }
    let build = |seps: &[char]| -> String {
        let mut s = format!("{}:\\{}", drive, segments[0]);
        for (i, sep) in seps.iter().enumerate() {
            s.push(*sep);
            s.push_str(segments[i + 1]);
        }
        s
    };
    enum_segment_paths(&segments, &['\\', '-', '_', '.'], build)
}

/// Claude Code 项目目录名的反向解析（macOS 版）。macOS 上路径
/// `/Users/foo/bar` 被 mangle 成 `-Users-foo-bar`（`/` 与 `:`、`_`、`.`、`\`
/// 均替换为 `-`，根目录 `/` 占开头一个 `-`）。反向枚举候选，层级最多者优先。
#[cfg(not(windows))]
fn unmangle_candidates(name: &str) -> Vec<String> {
    if !name.starts_with('-') {
        return Vec::new();
    }
    let segments: Vec<&str> = name[1..].split('-').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Vec::new();
    }
    let build = |seps: &[char]| -> String {
        let mut s = format!("/{}", segments[0]);
        for (i, sep) in seps.iter().enumerate() {
            s.push(*sep);
            s.push_str(segments[i + 1]);
        }
        s
    };
    enum_segment_paths(&segments, &['/', '-', '_', '.'], build)
}

/// n 选 k 的下标组合（升序）
fn combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
    fn rec(n: usize, k: usize, start: usize, cur: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if cur.len() == k {
            out.push(cur.clone());
            return;
        }
        for i in start..n {
            cur.push(i);
            rec(n, k, i + 1, cur, out);
            cur.pop();
        }
    }
    let mut out = Vec::new();
    rec(n, k, 0, &mut Vec::new(), &mut out);
    out
}

/// 批量扫描核心（同步）：扫描 Claude Code 项目目录（~/.claude/projects），
/// 把每个 mangled 目录名反向解析出真实路径；真实路径已不存在的项目
/// 标记 missing=true。list_projects_impl 与批量添加共用。
fn scan_claude_projects_blocking(projects_dir: &Path) -> Vec<ClaudeProject> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(projects_dir) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_dir() {
            continue;
        }
        let cands = unmangle_candidates(&name);
        let existing = cands.iter().find(|c| Path::new(c).is_dir());
        let path = existing.cloned().unwrap_or_else(|| {
            cands.first().cloned().unwrap_or_default()
        });
        if path.is_empty() {
            continue;
        }
        let leaf = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        out.push(ClaudeProject {
            name: leaf,
            missing: existing.is_none(),
            path,
        });
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    out
}

/// 批量添加：扫描 Claude Code 项目目录（~/.claude/projects）供批量加入清单。
/// 在阻塞线程池中执行，避免冻结 UI。
#[tauri::command]
async fn scan_claude_projects() -> Vec<ClaudeProject> {
    tauri::async_runtime::spawn_blocking(|| {
        scan_claude_projects_blocking(&claude_projects_dir())
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn get_claude_projects_dir() -> String {
    claude_projects_dir().to_string_lossy().to_string()
}

/// 项目路径 → ~/.claude/projects 下的数据目录。mangle 会把 `: \ / _ .` 都
/// 映射为 `-`，结果不含路径分隔符，必为 projects 目录的直接子目录
/// （无路径穿越风险）；空路径 mangle 后为空，返回 None。
fn claude_data_dir_for(projects_dir: &Path, project_path: &str) -> Option<PathBuf> {
    let mangled = mangle_project_path(project_path.trim());
    if mangled.is_empty() {
        return None;
    }
    Some(projects_dir.join(mangled))
}

/// 单个失效项目的数据目录清除（独立成函数便于测试）。返回是否实际删除。
/// 三道防线，确保只删「精确同名、真实路径已消失」的那一个数据目录：
/// 1. mangle 结果必为 projects 目录的直接子目录（结构不变量，另有单测锁死），
///    运行时再校验 parent，防未来重构破坏前提；
/// 2. 真实路径当前仍存在（检查后项目又被还原/外接盘插回）→ 不是死数据，跳过；
/// 3. 目录名是**精确相等**匹配（mangle 后逐字节相同），不是前缀/模糊/包含，
///    相似名字（proj / proj2 / proj-x）各自对应不同目录，互不波及。
fn purge_one_project_data(projects_dir: &Path, project_path: &str) -> Result<bool, String> {
    let Some(target) = claude_data_dir_for(projects_dir, project_path) else {
        return Ok(false);
    };
    if target.parent() != Some(projects_dir) {
        return Ok(false);
    }
    if Path::new(project_path.trim()).is_dir() || !target.is_dir() {
        return Ok(false);
    }
    fs::remove_dir_all(&target).map_err(|e| format!("删除 {} 失败：{e}", target.display()))?;
    Ok(true)
}

/// 清除失效项目在 Claude Code 用户数据里的会话目录
/// （~/.claude/projects/<mangled>，含全部 jsonl 会话记录，不可恢复）。
/// 返回成功删除的目录数；不满足删除条件（目录不存在/项目还活着）的不计入也不报错。
#[tauri::command]
async fn purge_claude_project_data(paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = claude_projects_dir();
        let mut removed = 0usize;
        for p in &paths {
            if purge_one_project_data(&dir, p)? {
                removed += 1;
            }
        }
        // 项目的会话数据连同置顶条目一起消失，同步撤掉（保存失败不影响已完成的清除）
        let root = resolve_root_dir();
        let _guard = config_lock();
        let mut cfg = load_config_from(&root);
        drop_pins_for_projects(&mut cfg, &paths);
        let _ = save_config_file(&root, &cfg);
        Ok(removed)
    })
    .await
    .map_err(|e| format!("清除会话数据失败：{e}"))?
}

// ---------------- 供应商切换（移植自 cc-switch） ----------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListState {
    providers: Vec<provider::ProviderInfo>,
    current_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSwitchOutcome {
    list: ProviderListState,
    warnings: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderImportOutcome {
    list: ProviderListState,
    imported: usize,
    skipped: usize,
    warnings: Vec<String>,
}

#[tauri::command]
fn provider_list() -> ProviderListState {
    provider_list_from(&provider::claude_config_dir(), &resolve_root_dir())
}

fn provider_list_from(config_dir: &Path, root: &Path) -> ProviderListState {
    let _guard = config_lock();
    let mut cfg = load_config_from(root);
    // 首次使用：自动把 live 配置整文件收编为 default 供应商（cc-switch 语义），
    // 清单为空时 current 必然失效，导入后直接指向 default
    if cfg.providers.is_empty() {
        if let Some(p) = provider::import_default_from(config_dir) {
            cfg.providers.push(p.clone());
            cfg.current_provider = Some(p.id);
            let _ = save_config_file(root, &cfg);
        }
    }
    // current 指向失效（被删等）时归 None
    if let Some(cur) = cfg.current_provider.clone() {
        if !cfg.providers.iter().any(|p| p.id == cur) {
            cfg.current_provider = None;
        }
    }
    // 标记重锚定：live 被外部工具（CC Switch、官方一键配置等）改写时以磁盘为准，
    // 修正脱节的 current 并落盘（失败不阻塞清单展示）
    if provider::reanchor_current_from(config_dir, &cfg.providers, &mut cfg.current_provider) {
        let _ = save_config_file(root, &cfg);
    }
    ProviderListState {
        providers: cfg.providers,
        current_id: cfg.current_provider,
    }
}

#[tauri::command]
fn provider_save(provider: provider::ProviderInfo) -> Result<ProviderListState, String> {
    provider_save_from(&provider::claude_config_dir(), &resolve_root_dir(), provider)
}

fn provider_save_from(
    config_dir: &Path,
    root: &Path,
    input: provider::ProviderInfo,
) -> Result<ProviderListState, String> {
    let _guard = config_lock();
    let mut p = input;
    if p.name.trim().is_empty() {
        return Err("供应商名称不能为空".to_string());
    }
    if !p.settings_config.is_object() {
        return Err("settingsConfig 必须是 JSON 对象".to_string());
    }
    let mut cfg = load_config_from(root);
    // 新增条目 id 尚未生成，不可能命中 current；live 快照供下方同步写盘
    let saved_current = !p.id.is_empty() && cfg.current_provider.as_deref() == Some(p.id.as_str());
    let live_snapshot = p.settings_config.clone();
    if p.id.is_empty() {
        p.id = uuid::Uuid::new_v4().to_string();
        cfg.providers.push(p);
    } else {
        match cfg.providers.iter_mut().find(|e| e.id == p.id) {
            Some(slot) => *slot = p,
            None => cfg.providers.push(p),
        }
    }
    // 保存的是当前供应商时同步写 live：只改清单的话磁盘 settings.json 仍是
    // 旧内容，下次切换的回填（指纹一致即整文件吸收）会把旧 live 灌回清单，
    // 刚保存的修改被静默回滚（模型映射反复「自己变回去」的根源）。
    // 先写 live 后写清单：live 写失败时清单未动，两侧不脱节
    if saved_current {
        let live_path = provider::claude_settings_path_from(config_dir);
        provider::write_json_atomic(
            &live_path,
            &provider::sanitize_claude_settings(&live_snapshot),
        )?;
    }
    save_config_file(root, &cfg)?;
    Ok(ProviderListState {
        providers: cfg.providers,
        current_id: cfg.current_provider,
    })
}

#[tauri::command]
fn provider_delete(id: String) -> Result<ProviderListState, String> {
    provider_delete_from(&provider::claude_config_dir(), &resolve_root_dir(), &id)
}

fn provider_delete_from(
    _config_dir: &Path,
    root: &Path,
    id: &str,
) -> Result<ProviderListState, String> {
    let _guard = config_lock();
    let mut cfg = load_config_from(root);
    if cfg.current_provider.as_deref() == Some(id) {
        return Err("不能删除当前启用的供应商，请先切换到其他供应商".to_string());
    }
    let before = cfg.providers.len();
    cfg.providers.retain(|p| p.id != id);
    if cfg.providers.len() == before {
        return Err(format!("供应商 {id} 不存在"));
    }
    save_config_file(root, &cfg)?;
    Ok(ProviderListState {
        providers: cfg.providers,
        current_id: cfg.current_provider,
    })
}

#[tauri::command]
fn provider_reorder(ids: Vec<String>) -> Result<ProviderListState, String> {
    provider_reorder_from(&provider::claude_config_dir(), &resolve_root_dir(), &ids)
}

/// 拖拽排序持久化：按 ids 给定顺序稳定重排清单。未提及的 id（理论不存在，
/// 防御外部并发改动）按原相对顺序沉底、多余的 id 忽略，保证不丢数据
fn provider_reorder_from(
    _config_dir: &Path,
    root: &Path,
    ids: &[String],
) -> Result<ProviderListState, String> {
    let _guard = config_lock();
    let mut cfg = load_config_from(root);
    cfg.providers
        .sort_by_key(|p| ids.iter().position(|id| p.id == *id).unwrap_or(usize::MAX));
    save_config_file(root, &cfg)?;
    Ok(ProviderListState {
        providers: cfg.providers,
        current_id: cfg.current_provider,
    })
}

#[tauri::command]
fn provider_switch(id: String) -> Result<ProviderSwitchOutcome, String> {
    provider_switch_from(&provider::claude_config_dir(), &resolve_root_dir(), &id)
}

fn provider_switch_from(
    config_dir: &Path,
    root: &Path,
    id: &str,
) -> Result<ProviderSwitchOutcome, String> {
    let _guard = config_lock();
    let mut cfg = load_config_from(root);
    let warnings = provider::switch_provider_from(
        config_dir,
        &mut cfg.providers,
        &mut cfg.current_provider,
        id,
    )?;
    save_config_file(root, &cfg)?;
    Ok(ProviderSwitchOutcome {
        list: ProviderListState {
            providers: cfg.providers,
            current_id: cfg.current_provider,
        },
        warnings,
    })
}

#[tauri::command]
fn provider_import_ccswitch(file_path: String) -> Result<ProviderImportOutcome, String> {
    provider_import_ccswitch_from(
        &provider::claude_config_dir(),
        &resolve_root_dir(),
        &file_path,
    )
}

fn provider_import_ccswitch_from(
    _config_dir: &Path,
    root: &Path,
    file_path: &str,
) -> Result<ProviderImportOutcome, String> {
    let raw = fs::read(file_path).map_err(|e| format!("读取备份失败: {e}"))?;
    let text = String::from_utf8_lossy(strip_bom(&raw)).into_owned();
    let (mut imported, backup_current, mut warnings) = provider::parse_ccswitch_sql(&text);
    if imported.is_empty() {
        return Err(
            "备份中未找到 Claude 供应商：请确认选择的是 CC Switch「导出配置」生成的 SQL 备份文件"
                .to_string(),
        );
    }
    let _guard = config_lock();
    let mut cfg = load_config_from(root);
    let mut added = 0usize;
    let mut skipped = 0usize;
    for p in imported.drain(..) {
        if cfg.providers.iter().any(|e| e.id == p.id) {
            skipped += 1; // 与现有清单同 id：保留现状，幂等导入
            continue;
        }
        cfg.providers.push(p);
        added += 1;
    }
    // 备份中标记为当前的供应商：仅当本地尚无有效 current 时采纳。
    // live 文件本就是该供应商的配置，这里只对齐标记、不写盘。
    let current_valid = cfg
        .current_provider
        .as_ref()
        .map(|c| cfg.providers.iter().any(|p| &p.id == c))
        .unwrap_or(false);
    if !current_valid {
        if let Some(cid) = backup_current {
            if cfg.providers.iter().any(|p| p.id == cid) {
                cfg.current_provider = Some(cid);
            }
        }
    }
    save_config_file(root, &cfg)?;
    if skipped > 0 {
        warnings.push(format!("{skipped} 个供应商与现有清单重复，已跳过"));
    }
    Ok(ProviderImportOutcome {
        list: ProviderListState {
            providers: cfg.providers,
            current_id: cfg.current_provider,
        },
        imported: added,
        skipped,
        warnings,
    })
}

#[tauri::command]
fn provider_read_live() -> Option<serde_json::Value> {
    provider::read_live_settings(&provider::claude_config_dir())
}

/// 拉取供应商可用模型列表（OpenAI 兼容 /v1/models，候选地址逐个探测）
#[tauri::command]
async fn fetch_models_for_config(
    base_url: String,
    api_key: String,
) -> Result<Vec<model_fetch::FetchedModel>, String> {
    // 逐候选 15s 超时、最多 4 个候选，网络差时同步执行可冻结 UI 近 1 分钟
    tauri::async_runtime::spawn_blocking(move || model_fetch::fetch_models(&base_url, &api_key))
        .await
        .map_err(|e| format!("模型拉取任务执行失败：{e}"))?
}

/// 查询供应商的 Coding Plan 用量（凭据取自其 settingsConfig.env；
/// 非已知厂商返回 supported=false，前端静默）
#[tauri::command]
async fn provider_query_usage(id: String) -> usage_query::UsageResult {
    // 配额查询走 HTTP（逐接口超时），同步执行会阻塞主线程
    match tauri::async_runtime::spawn_blocking(move || {
        provider_usage_from(&resolve_root_dir(), &id)
    })
    .await
    {
        Ok(r) => r,
        Err(_) => usage_query::UsageResult::unsupported(),
    }
}

fn provider_usage_from(root: &Path, id: &str) -> usage_query::UsageResult {
    let cfg = load_config_from(root);
    let Some(p) = cfg.providers.iter().find(|p| p.id == id) else {
        return usage_query::UsageResult::unsupported();
    };
    let env = p.settings_config.get("env").cloned().unwrap_or_default();
    let base = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let key = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .and_then(|v| v.as_str())
        .or_else(|| env.get("ANTHROPIC_API_KEY").and_then(|v| v.as_str()))
        .unwrap_or("");
    let Some(vendor) = usage_query::detect_vendor(base) else {
        return usage_query::UsageResult::unsupported();
    };
    if base.is_empty() || key.is_empty() {
        return usage_query::UsageResult {
            success: false,
            supported: true,
            vendor: Some(vendor.to_string()),
            data: vec![],
            error: Some("未配置接入地址或 API Key".to_string()),
        };
    }
    usage_query::query_usage(base, key)
}

/// 用系统默认浏览器打开外部链接（供应商官网 / 获取 API Key）。
/// Windows 走 explorer 打开 URL（不经过 cmd，无引号/特殊字符转义问题）。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open_url_impl(&url)
}

fn open_url_impl(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!("仅支持 http/https 链接：{trimmed}"));
    }
    #[cfg(windows)]
    {
        Command::new("explorer").arg(trimmed).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(trimmed).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Command::new("xdg-open").arg(trimmed).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 返回数据根信息：path = 数据根目录；installMode = true 表示处于安装模式
/// （数据根在 %APPDATA% 而非 exe 所在目录）
#[tauri::command]
fn get_data_root() -> DataRootInfo {
    let (root, install_mode) = resolve_root_with_mode();
    DataRootInfo {
        path: root.to_string_lossy().to_string(),
        install_mode,
    }
}

// ---------------- 入口 ----------------

// ---------------- 单元测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

/// purge 端到端性质：真实路径还在的项目跳过不删；删除只命中精确同名目录，
    /// 相似名字的兄弟目录分毫无损
    #[test]
    fn purge_project_data_skips_alive_and_exact_only() {
        let root = temp_root("purge");
        let projects = root.join("projects");
        let alive = root.join("alive");
        let dead = root.join("dead");
        fs::create_dir_all(&alive).unwrap();
        let data_alive = claude_data_dir_for(&projects, alive.to_str().unwrap()).unwrap();
        let data_dead = claude_data_dir_for(&projects, dead.to_str().unwrap()).unwrap();
        fs::create_dir_all(&data_alive).unwrap();
        fs::create_dir_all(&data_dead).unwrap();

        // 真实路径仍存在 → 不是死数据，跳过
        assert!(!purge_one_project_data(&projects, alive.to_str().unwrap()).unwrap());
        assert!(data_alive.is_dir());

        // 真实路径已消失 → 只删精确同名的那一个，兄弟目录不动
        assert!(purge_one_project_data(&projects, dead.to_str().unwrap()).unwrap());
        assert!(!data_dead.exists());
        assert!(data_alive.is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    /// purge 的安全性前提：mangle 后的目录名不含路径分隔符、不是 ./.，
    /// 永远是 projects 目录的直接子目录（删除不会越出数据目录）
    #[test]
    fn claude_data_dir_is_direct_child() {
        let base = Path::new("X:\\base\\.claude\\projects");
        for p in [
            r"C:\Users\laphe\AppData\Local\Temp\claude\fast\probe\1\proj",
            r"D:\MyWorkspaces\jike_hongbao.v2",
            "/Users/me/my proj",
            r"..\..\..\Windows",
            "....//\\\\",
            "。",
        ] {
            let dir = claude_data_dir_for(base, p).expect("非空路径必有数据目录");
            assert_eq!(dir.parent(), Some(base), "必须是 projects 的直接子目录");
            let name = dir.file_name().unwrap().to_string_lossy();
            assert!(!name.contains('/') && !name.contains('\\') && !name.contains(':'));
            assert_ne!(name, ".");
            assert_ne!(name, "..");
        }
        assert!(claude_data_dir_for(base, "").is_none());
        assert!(claude_data_dir_for(base, "   ").is_none());
    }

    fn temp_root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "claude-fast-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    const TEST_UUID: &str = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";

    #[test]
    fn validate_session_file_rejects_traversal_and_missing() {
        let root = temp_root("validate-sess");
        let projects = root.join("projects");
        let mangled = projects.join("-Users-foo-bar");
        fs::create_dir_all(&mangled).unwrap();
        let real = mangled.join(format!("{TEST_UUID}.jsonl"));
        fs::write(&real, "{\"type\":\"user\"}").unwrap();
        // 越界目录里放同名文件，构造 `projects/../evil/<uuid>.jsonl` 词法穿越
        let evil = root.join("evil");
        fs::create_dir_all(&evil).unwrap();
        let evil_file = evil.join(format!("{TEST_UUID}.jsonl"));
        fs::write(&evil_file, "{}").unwrap();

        // 合法：真实位于 projects 下的 <uuid>.jsonl
        let (path, sid) =
            validate_session_file_in(real.to_str().unwrap(), &projects).unwrap();
        assert_eq!(sid, TEST_UUID);
        assert_eq!(path, real);
        // 穿越：`..` 拼接的路径即便词法前缀是 projects 也必须拒绝
        let traversal = projects
            .join("..")
            .join("evil")
            .join(format!("{TEST_UUID}.jsonl"));
        assert!(validate_session_file_in(traversal.to_str().unwrap(), &projects).is_err());
        // 文件不存在：canonicalize 失败必须拒绝（旧逻辑 starts_with 不要求存在）
        assert!(validate_session_file_in(
            mangled.join("ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl").to_str().unwrap(),
            &projects,
        )
        .is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn validate_trash_file_rejects_traversal() {
        let root = temp_root("validate-trash");
        let trash = root.join("trash").join("sessions");
        let backup = trash.join("20260913_120000").join("-Users-foo-bar");
        fs::create_dir_all(&backup).unwrap();
        let real = backup.join(format!("{TEST_UUID}.jsonl"));
        fs::write(&real, "{}").unwrap();
        assert!(validate_trash_file_in(real.to_str().unwrap(), &trash).is_ok());
        let traversal = trash
            .join("..")
            .join("..")
            .join("evil")
            .join(format!("{TEST_UUID}.jsonl"));
        fs::create_dir_all(root.join("evil")).unwrap();
        fs::write(root.join("evil").join(format!("{TEST_UUID}.jsonl")), "{}").unwrap();
        assert!(validate_trash_file_in(traversal.to_str().unwrap(), &trash).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn config_missing_dark_field_still_parses() {
        let root = temp_root("config-dark");
        // 旧版/外部工具生成的 config 没有 dark 字段：不能整份解析失败
        let json = format!(
            r#"{{"order":["a"],"projects":["a"],"excluded":[],"pinnedSessions":[],"providers":[],"currentProvider":null,"closeAction":null}}"#
        );
        fs::write(root.join("config.json"), json).unwrap();
        let cfg = load_config_from(&root);
        assert!(!cfg.dark);
        assert_eq!(cfg.projects, vec!["a".to_string()]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ledger_missing_tz_or_files_field_still_parses() {
        // 缺 tz/files 的旧 JSON 必须字段级兜底，而不是整本清零
        let ledger: StatsLedger =
            serde_json::from_str(r#"{"version":2}"#).unwrap();
        assert_eq!(ledger.tz_offset_minutes, 0);
        assert!(ledger.files.is_empty());
        let ledger: StatsLedger =
            serde_json::from_str(r#"{"tz_offset_minutes":480}"#).unwrap();
        assert!(ledger.files.is_empty());
    }

    #[test]
    fn parse_cd_quoted() {
        assert_eq!(
            parse_cd_path("@echo off\r\nchcp 65001 >nul\r\ncd /d \"D:\\MyWorkspaces\\yaotu\\tdc\""),
            Some("D:\\MyWorkspaces\\yaotu\\tdc".to_string())
        );
    }

    #[test]
    fn parse_cd_unquoted() {
        assert_eq!(
            parse_cd_path("cd /d C:\\proj"),
            Some("C:\\proj".to_string())
        );
    }

    #[test]
    fn parse_cd_missing() {
        assert_eq!(parse_cd_path("@echo off\r\necho hi"), None);
    }

    #[test]
    fn parse_cd_case_insensitive() {
        assert_eq!(
            parse_cd_path("CD /D \"X:\\y z\""),
            Some("X:\\y z".to_string())
        );
    }

    #[test]
    fn parse_cd_sh_quoted() {
        // macOS 脚本：cd "/path"（含 || exit 1 后缀）
        assert_eq!(
            parse_cd_path("#!/bin/bash\ncd \"/Users/me/My Workspaces/proj\" || exit 1\nexec claude"),
            Some("/Users/me/My Workspaces/proj".to_string())
        );
    }

    #[test]
    fn parse_cd_sh_unquoted() {
        assert_eq!(
            parse_cd_path("cd /Users/me/proj"),
            Some("/Users/me/proj".to_string())
        );
    }

    #[test]
    fn strip_bom_works() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"{\"a\":1}");
        let c: serde_json::Value = serde_json::from_slice(strip_bom(&b)).unwrap();
        assert_eq!(c["a"], 1);
    }

    #[test]
    fn sh_quote_escapes_shell_metachars() {
        // 双引号内转义：\ " $ ` 前加反斜杠，其余原样
        assert_eq!(sh_quote(r#"a"b$c`d\e"#), r#"a\"b\$c\`d\\e"#);
        assert_eq!(sh_quote("/Users/me/proj"), "/Users/me/proj");
        assert_eq!(sh_quote("普通 中文 路径"), "普通 中文 路径");
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_drive_root() {
        assert_eq!(unmangle_candidates("D--baitai"), vec!["D:\\baitai"]);
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_plain_path() {
        let c = unmangle_candidates("D--MyWorkspaces-jikehongbao");
        assert_eq!(c[0], "D:\\MyWorkspaces\\jikehongbao");
        // 歧义候选也保留（'-' 可能是 _ . - 或 \ 分隔）
        assert_eq!(c.len(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_underscore_and_dash_candidates() {
        let c = unmangle_candidates("D--WeChatProjects-tms-app");
        // 优先级：全分隔 > 单间隙合并 > 双间隙合并（- _ . 顺序）
        assert_eq!(c[0], "D:\\WeChatProjects\\tms\\app");
        assert!(c.contains(&"D:\\WeChatProjects\\tms_app".to_string()));
        assert!(c.contains(&"D:\\WeChatProjects\\tms-app".to_string()));
        assert!(c.contains(&"D:\\WeChatProjects-tms_app".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_dot_and_dash_candidates() {
        let c = unmangle_candidates("D--MyWorkspaces-cms-DoraCMS-3-1");
        assert_eq!(c[0], "D:\\MyWorkspaces\\cms\\DoraCMS\\3\\1");
        // 实测：DoraCMS-3.1 被 mangle 成 DoraCMS-3-1（'.' → '-'）
        assert!(c.contains(&"D:\\MyWorkspaces\\cms\\DoraCMS-3.1".to_string()));
        assert!(c.contains(&"D:\\MyWorkspaces\\cms\\DoraCMS-3-1".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_rejects_bad_names() {
        assert!(unmangle_candidates("").is_empty());
        assert!(unmangle_candidates("no-dashes").is_empty());
        assert!(unmangle_candidates("-X--abc").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_long_path_limits_candidates() {
        // 段过多时降级为有限候选（不爆炸）
        let c = unmangle_candidates("D--a-b-c-d-e-f-g-h");
        assert!(!c.is_empty());
        assert!(c.len() <= 1 + 7 * 3);
        assert_eq!(c[0], "D:\\a\\b\\c\\d\\e\\f\\g\\h");
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_root_path() {
        // /Users/foo/bar → mangle → -Users-foo-bar；反向首候选为全 '/' 分隔（层级最多）
        let c = unmangle_candidates("-Users-foo-bar");
        assert_eq!(c[0], "/Users/foo/bar");
        assert!(c.contains(&"/Users-foo/bar".to_string())); // 间隙合并候选之一
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_underscore_and_dash_candidates() {
        let c = unmangle_candidates("-Users-me-tms-app");
        // 优先级：全分隔 > 单间隙合并（- _ . 顺序）
        assert_eq!(c[0], "/Users/me/tms/app");
        assert!(c.contains(&"/Users/me/tms_app".to_string()));
        assert!(c.contains(&"/Users/me/tms-app".to_string()));
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_rejects_bad_names() {
        // mac 的 mangled 名必以 '-' 开头（根 / 占开头一个 '-'）
        assert!(unmangle_candidates("").is_empty());
        assert!(unmangle_candidates("no-leading-dash").is_empty());
        assert!(unmangle_candidates("D--baitai").is_empty()); // Windows 格式，mac 不认
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_long_path_limits_candidates() {
        // 段过多时降级为有限候选（不爆炸）
        let c = unmangle_candidates("-a-b-c-d-e-f-g-h");
        assert!(!c.is_empty());
        assert!(c.len() <= 1 + 7 * 3);
        assert_eq!(c[0], "/a/b/c/d/e/f/g/h");
    }

    #[test]
    fn enum_segment_paths_macos_style() {
        // macOS 风格枚举（主分隔符 /，合并候选 - _ .）：
        // -Users-me-proj → 层级最多候选 /Users/me/proj 排最前
        let segments: Vec<&str> = "Users-me-proj".split('-').collect();
        let build = |seps: &[char]| -> String {
            let mut s = format!("/{}", segments[0]);
            for (i, sep) in seps.iter().enumerate() {
                s.push(*sep);
                s.push_str(segments[i + 1]);
            }
            s
        };
        let c = enum_segment_paths(&segments, &['/', '-', '_', '.'], build);
        assert_eq!(c[0], "/Users/me/proj");
        // 歧义候选也在（'-' 可能是 _ . -）
        assert!(c.contains(&"/Users/me-proj".to_string()));
        assert!(c.contains(&"/Users_me/proj".to_string()));
        assert!(c.contains(&"/Users-me/proj".to_string()));

        // 单段：无歧义
        let seg1: Vec<&str> = vec!["baitai"];
        let c1 = enum_segment_paths(&seg1, &['/', '-', '_', '.'], |_| {
            format!("/{}", seg1[0])
        });
        assert_eq!(c1, vec!["/baitai"]);
    }

    #[test]
    fn resolve_root_with_mode_matches_ancestor_scan() {
        // 独立复算一遍「exe 向上 6 级的首个便携标记」，与 resolve 的结果对照。
        // 旧版这里只断言 root.is_dir()——本机恒真，等于没测；现在两个分支的
        // 期望值都由扫描推出，搜索深度写错或谓词漏判都会让它失败
        let (root, install) = resolve_root_with_mode();
        let exe = std::env::current_exe().unwrap_or_default();
        let mut dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
        let mut portable: Option<PathBuf> = None;
        for _ in 0..6 {
            if is_root_dir(&dir) {
                portable = Some(dir.clone());
                break;
            }
            match dir.parent() {
                Some(p) => dir = p.to_path_buf(),
                None => break,
            }
        }
        match portable {
            Some(expect) => {
                assert!(!install, "祖先存在便携根 {} 却判为安装模式", expect.display());
                assert_eq!(root, expect);
            }
            None => {
                assert!(install, "无便携标记却判为便携模式（根 {}）", root.display());
                assert_eq!(root, app_data_root());
                assert!(root.is_dir(), "安装模式根应由 resolve 现场创建");
            }
        }
    }

    #[test]
    fn resolve_root_from_walks_up_and_prefers_nearest() {
        // 外层与内层都有标记 → 取最近的（首个命中即返回）
        let outer = temp_root("walk-outer");
        fs::write(outer.join("config.json"), "{}").unwrap();
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("config.json"), "{}").unwrap();
        assert_eq!(resolve_root_from(&inner).as_deref(), Some(inner.as_path()));
        // 从更深子目录出发找到祖先根（绿色版 exe 放在子目录里的情形），
        // 同时覆盖「层级深度」：deep → a → inner → outer 共 4 级
        let deep = inner.join("a").join("b");
        fs::create_dir_all(&deep).unwrap();
        fs::remove_file(inner.join("config.json")).unwrap();
        assert_eq!(resolve_root_from(&deep).as_deref(), Some(outer.as_path()));
        // 起点自身即根
        assert_eq!(resolve_root_from(&outer).as_deref(), Some(outer.as_path()));
        fs::remove_dir_all(&outer).unwrap();
    }

    #[test]
    fn resolve_root_from_returns_none_without_marker() {
        // 无任何标记 → None，调用方据此回退安装模式。
        // 仅在「6 级祖先里确实没有标记」时才断言：系统 temp 位于
        // <home>/AppData/Local 之下，向上第 5~6 级会扫到用户主目录，
        // 若某人主目录恰好有合规 config.json，本测试不该为此背锅
        let bare = temp_root("walk-bare");
        let deep = bare.join("x").join("y");
        fs::create_dir_all(&deep).unwrap();
        let mut dir = deep.clone();
        let mut ancestor_has_marker = false;
        for _ in 0..6 {
            if is_root_dir(&dir) {
                ancestor_has_marker = true;
                break;
            }
            match dir.parent() {
                Some(p) => dir = p.to_path_buf(),
                None => break,
            }
        }
        if !ancestor_has_marker {
            assert!(resolve_root_from(&deep).is_none());
        }
        fs::remove_dir_all(&bare).unwrap();
    }

    #[test]
    fn is_root_dir_detects_layouts() {
        let root = temp_root("root");
        // 空目录：非根
        assert!(!is_root_dir(&root));
        // 去脚本化布局：空对象 config.json 即认（用户显式引导便携模式的正规姿势）
        fs::write(root.join("config.json"), "{}").unwrap();
        assert!(is_root_dir(&root));
        // 含 ≥2 个本项目已知字段（从旧数据目录/旧机器拷来的 config）：认定
        fs::write(root.join("config.json"), r#"{"projects":["D:\\foo"],"order":[]}"#).unwrap();
        assert!(is_root_dir(&root));
        // 只撞上 1 个通用键：**不认**——便携判定向上扫 6 级祖先，安装模式会扫到
        // 用户主目录与 C:\Users，`{"dark":true}` 这类别的工具的配置若被认领，
        // setup 的 ensure_projects_migrated 会在首次启动把它整份覆写
        fs::write(root.join("config.json"), r#"{"dark":true}"#).unwrap();
        assert!(!is_root_dir(&root));
        // 键完全对不上的外来 config.json：不认
        fs::write(root.join("config.json"), r#"{"apiKey":"xxx","port":8080}"#).unwrap();
        assert!(!is_root_dir(&root));
        // 非 JSON（坏文件）：不认
        fs::write(root.join("config.json"), "not json at all").unwrap();
        assert!(!is_root_dir(&root));
        // 非对象 JSON（数组 / 字符串 / 数字）：不认
        fs::write(root.join("config.json"), "[1,2,3]").unwrap();
        assert!(!is_root_dir(&root));
        // 0 字节（云同步半写、杀软隔离的典型形态）：不认
        fs::write(root.join("config.json"), "").unwrap();
        assert!(!is_root_dir(&root));
        // 但 .bak 是好的 → **仍认**：.bak 兜底正是为这种场景存在的，根判定若
        // 先一步放弃该目录，用户会看到空清单，而数据与 .bak 其实都在原地
        fs::write(root.join("config.json.bak"), r#"{"projects":[],"order":[]}"#).unwrap();
        assert!(is_root_dir(&root));
        // 只有 .bak、config.json 被删：同样认
        fs::remove_file(root.join("config.json")).unwrap();
        assert!(is_root_dir(&root));
        fs::remove_file(root.join("config.json.bak")).unwrap();
        // 脚本时代布局（config.json + scripts/）：存量目录**免内容校验**直接认定
        // ——给存量便携用户的 config 也加校验会让「原本能用」变「config 一坏就
        // 找不到数据根」，那是实打实的回归
        fs::write(root.join("config.json"), r#"{"apiKey":"xxx"}"#).unwrap();
        fs::create_dir_all(root.join(SCRIPTS_DIR)).unwrap();
        assert!(is_root_dir(&root));
        // 旧布局：claude-claude-fast.<ext>（标记名随平台 bat/sh），无 config.json 也认
        fs::remove_dir_all(root.join(SCRIPTS_DIR)).unwrap();
        fs::remove_file(root.join("config.json")).unwrap();
        fs::write(root.join(legacy_marker()), "").unwrap();
        assert!(is_root_dir(&root));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn app_data_root_points_to_claude_fast() {
        let p = app_data_root();
        assert!(!p.as_os_str().is_empty());
        let s = p.to_string_lossy().to_lowercase();
        assert!(s.contains("claude-fast"));
    }

    #[test]
    fn claude_projects_dir_honors_config_env() {
        // CLAUDE_CONFIG_DIR（官方支持的自定义数据目录）优先于平台默认
        let fake = temp_root("cc-config-dir");
        std::env::set_var("CLAUDE_CONFIG_DIR", &fake);
        let p = claude_projects_dir();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(p, fake.join("projects"));
        fs::remove_dir_all(&fake).unwrap();
    }

    // ---------------- 会话管理（v2.0.0 阶段一） ----------------

    #[test]
    fn mangle_project_path_works() {
        assert_eq!(
            mangle_project_path("D:\\MyWorkspaces\\jikehongbao"),
            "D--MyWorkspaces-jikehongbao"
        );
        assert_eq!(
            mangle_project_path("D:\\WeChatProjects\\tms_app"),
            "D--WeChatProjects-tms-app"
        );
        assert_eq!(
            mangle_project_path("D:\\MyWorkspaces\\cms\\DoraCMS-3.1"),
            "D--MyWorkspaces-cms-DoraCMS-3-1"
        );
        // 冒号与根斜杠各占一个 `-`
        assert_eq!(mangle_project_path("D:\\baitai"), "D--baitai");
        // macOS 路径：/ 也替换为 -，根 / 占开头一个 -
        assert_eq!(
            mangle_project_path("/Users/me/proj"),
            "-Users-me-proj"
        );
        assert_eq!(
            mangle_project_path("/Users/me/My Workspaces/my_app"),
            "-Users-me-My Workspaces-my-app"
        );
    }

    #[test]
    fn is_valid_uuid_checks_format() {
        assert!(is_valid_uuid("5426d6d0-c08f-43bd-94df-4d6d99e5c699"));
        assert!(!is_valid_uuid("5426d6d0-c08f-43bd-94df"));
        assert!(!is_valid_uuid("not-a-uuid"));
        assert!(!is_valid_uuid("5426d6d0c08f43bd94df4d6d99e5c699"));
    }

    #[test]
    fn strip_xml_blocks_removes_command_wrappers() {
        // command-name / command-args 内容保留为标题（官方 /resume 列表同款语义）
        assert_eq!(
            strip_xml_blocks("<command-name>/flow</command-name>"),
            "/flow "
        );
        assert_eq!(
            strip_xml_blocks(
                "<command-name>/init</command-name><command-args>测试</command-args>"
            ),
            "/init 测试 "
        );
        // 无闭合标签的孤立尖括号保留
        assert_eq!(strip_xml_blocks("a < b > c"), "a < b > c");
    }

    #[test]
    fn clean_summary_folds_whitespace() {
        assert_eq!(clean_summary("  多行\n文本\t折叠  "), "多行 文本 折叠");
        let long = "x".repeat(300);
        assert_eq!(clean_summary(&long).chars().count(), 150);
    }

    /// 构造一段含标题/消息的 jsonl head 文本
    fn sample_head() -> String {
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#,
            r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"修复登录页面的 bug"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"ai-title","aiTitle":"修复登录页面","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#,
        )
    }

    #[test]
    fn session_meta_uses_custom_title_first() {
        let tail = r#"{"type":"custom-title","customTitle":"手动改的名字","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#;
        let info = session_meta_from_lite(
            &sample_head(),
            tail,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            1000,
        )
        .unwrap();
        assert_eq!(info.title, "手动改的名字");
        assert_eq!(info.summary, "手动改的名字");
        assert_eq!(info.last_modified, 1000);
    }

    #[test]
    fn session_meta_falls_back_to_ai_title() {
        let info = session_meta_from_lite(
            &sample_head(),
            "",
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            1000,
        )
        .unwrap();
        assert_eq!(info.title, "修复登录页面");
        assert_eq!(info.summary, "修复登录页面的 bug");
    }

    #[test]
    fn session_meta_falls_back_to_first_prompt() {
        // 命令后跟了普通对话的会话：标题用第一条普通消息（命令消息被跳过）
        let head = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name><command-args>新建项目</command-args>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":"帮我看一下这个项目的结构"},"timestamp":"2026-08-12T06:48:00.000Z"}"#,
        );
        let info = session_meta_from_lite(&head, "", "x", 0).unwrap();
        assert_eq!(info.title, "帮我看一下这个项目的结构");
        assert_eq!(info.summary, "帮我看一下这个项目的结构");
    }

    #[test]
    fn session_meta_only_init_command_is_hidden() {
        // 只执行了 /init 的会话：无任何实质对话内容 → 不进入列表
        let head = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-message>init</command-message>\n<command-name>/init</command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        assert!(session_meta_from_lite(&head, "", "x", 0).is_none());
        // 即使命令带参数也一样隐藏
        let head2 = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        assert!(session_meta_from_lite(&head2, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_blank_command_content_is_untitled() {
        // 命令内容清洗后为空的极端情况：无任何可显示内容 → 会话被过滤（不进列表）
        let head = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name></command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        assert!(session_meta_from_lite(&head, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_extracts_text_blocks_from_array_content() {
        let head = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"第一段"},{"type":"tool_use","name":"x"}]},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        let info = session_meta_from_lite(&head, "", "x", 0).unwrap();
        assert_eq!(info.title, "第一段");
    }

    #[test]
    fn session_meta_skips_sidechain() {
        let head = r#"{"parentUuid":null,"isSidechain":true,"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-08-12T06:47:46.519Z"}"#;
        assert!(session_meta_from_lite(head, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_skips_metadata_only() {
        let head = r#"{"type":"mode","mode":"normal","sessionId":"x"}"#;
        assert!(session_meta_from_lite(head, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_tail_wins_over_head() {
        // 同一个字段 head 与 tail 都有时，取 tail 的最后一条
        let head = sample_head();
        let tail = r#"{"type":"ai-title","aiTitle":"tail 里的新标题","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#;
        let info = session_meta_from_lite(
            &head,
            tail,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            0,
        )
        .unwrap();
        assert_eq!(info.title, "tail 里的新标题");
    }

    #[test]
    fn read_head_tail_handles_large_and_small_files() {
        let dir = temp_root("sess-headtail");
        // 小文件：head == tail
        let small = dir.join("a.jsonl");
        fs::write(&small, sample_head()).unwrap();
        let (head, tail, mtime) = read_head_tail(&small).unwrap();
        assert_eq!(head, tail);
        assert!(mtime > 0);
        // 大文件：tail 是文件末尾 64KB
        let big = dir.join("b.jsonl");
        let mut content = sample_head();
        let filler = "x".repeat(200_000);
        content.push_str(&filler);
        content.push_str(&sample_head());
        fs::write(&big, content).unwrap();
        let (head, tail, _) = read_head_tail(&big).unwrap();
        assert!(head.len() <= 64 * 1024);
        assert!(tail.len() <= 64 * 1024);
        // 大文件的 tail 应从末尾取（能解析出末尾的 ai-title）
        assert!(tail.contains("修复登录页面"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn append_custom_title_writes_json_line() {
        let dir = temp_root("sess-rename");
        let file = dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        append_custom_title(&file, "5426d6d0-c08f-43bd-94df-4d6d99e5c699", "新名字")
            .unwrap();
        let content = fs::read_to_string(&file).unwrap();
        // 原内容保留，末尾追加一行
        assert!(content.starts_with(r#"{"type":"mode""#));
        let last = content.lines().last().unwrap();
        let v: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(v["type"], "custom-title");
        assert_eq!(v["customTitle"], "新名字");
        assert_eq!(v["sessionId"], "5426d6d0-c08f-43bd-94df-4d6d99e5c699");
        // 追加后再次提取应识别新标题
        let (head, tail, _) = read_head_tail(&file).unwrap();
        let info = session_meta_from_lite(
            &head,
            &tail,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            0,
        )
        .unwrap();
        assert_eq!(info.title, "新名字");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn append_custom_title_escapes_special_chars() {
        let dir = temp_root("sess-rename-esc");
        let file = dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        append_custom_title(
            &file,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            r#"含"引号"和\反斜杠"#,
        )
        .unwrap();
        let content = fs::read_to_string(&file).unwrap();
        let last = content.lines().last().unwrap();
        let v: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(v["customTitle"], r#"含"引号"和\反斜杠"#);
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---------------- 回收站（v2.0.0 阶段一：删除会话 = 移入回收站） ----------------

    #[test]
    fn utc_timestamp_matches_format() {
        let ts = utc_timestamp();
        assert_eq!(ts.len(), 15);
        assert!(ts.as_bytes().iter().all(|b| b.is_ascii_digit() || *b == b'_'));
        // 年份合理范围（2025-2035）
        let year: i64 = ts[..4].parse().unwrap();
        assert!((2025..=2035).contains(&year));
    }

    #[test]
    fn civil_from_days_is_accurate() {
        // 已知日期：2000-01-01（UTC epoch 946684800 = 10957 天）
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        // 2026-08-12（epoch 秒 1786492800 / 86400 = 20676.99...，取整）
        assert_eq!(civil_from_days(20_676), (2026, 8, 11)); // 边界 ±1 天可接受
    }

    #[test]
    fn delete_session_moves_to_trash_with_project_dir() {
        let root = temp_root("trash-del");
        let projects = root.join("projects");
        let trash = root.join("trash").join("sessions");
        let mangled = "D--MyWorkspaces-myProject-claude-fast";
        let proj_dir = projects.join(mangled);
        fs::create_dir_all(&proj_dir).unwrap();
        let file = proj_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        let content_before = fs::read_to_string(&file).unwrap();

        let backup = delete_session_file(&file, &trash).unwrap();
        // 原文件已删除
        assert!(!file.exists());
        // 备份在 trash/<ts>/<mangled>/<uuid>.jsonl
        assert!(backup.starts_with(&trash));
        assert!(backup.ends_with("D--MyWorkspaces-myProject-claude-fast/5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), content_before);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_trashed_sessions_parses_and_sorts() {
        let root = temp_root("trash-list");
        let trash = root.join("trash").join("sessions");
        // 两个时间批次（倒序：20260812 在前）
        let older = trash.join("20260811_100000").join("D--baitai");
        let newer = trash.join("20260812_090000").join("D--MyWorkspaces-myProject-claude-fast");
        fs::create_dir_all(&older).unwrap();
        fs::create_dir_all(&newer).unwrap();
        fs::write(
            older.join("11111111-1111-4111-8111-111111111111.jsonl"),
            sample_head(),
        )
        .unwrap();
        fs::write(
            newer.join("22222222-2222-4222-8222-222222222222.jsonl"),
            sample_head(),
        )
        .unwrap();

        let list = list_trashed_sessions_in(&trash);
        assert_eq!(list.len(), 2);
        // 倒序：新的在前
        assert_eq!(list[0].deleted_at, "20260812_090000");
        assert_eq!(list[1].deleted_at, "20260811_100000");
        // 标题从 jsonl 解析（sample_head 有 ai-title「修复登录页面」）
        assert_eq!(list[0].title, "修复登录页面");
        assert_eq!(list[0].session_id, "22222222-2222-4222-8222-222222222222");
        assert_eq!(list[0].project_dir, "D--MyWorkspaces-myProject-claude-fast");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_trashed_file_roundtrip() {
        let root = temp_root("trash-restore");
        let projects = root.join("projects");
        let trash = root.join("trash").join("sessions");
        let mangled = "D--MyWorkspaces-myProject-claude-fast";
        let proj_dir = projects.join(mangled);
        fs::create_dir_all(&proj_dir).unwrap();
        let file = proj_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        let content_before = fs::read_to_string(&file).unwrap();

        // 删除 → 回收站
        let backup = delete_session_file(&file, &trash).unwrap();
        assert!(!file.exists());

        // 恢复 → 回到原项目目录
        let restored = restore_trashed_file(&backup, &projects).unwrap();
        assert_eq!(restored, file);
        assert!(file.exists());
        assert_eq!(fs::read_to_string(&file).unwrap(), content_before);
        assert!(!backup.exists());

        // 重复恢复（目标已存在）→ 报错
        let err = restore_trashed_file(&backup, &projects).unwrap_err();
        assert!(err.contains("已存在"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_trashed_file_rejects_duplicate_target() {
        let root = temp_root("trash-restore-dup");
        let projects = root.join("projects");
        let trash = root.join("trash").join("sessions");
        let mangled = "D--baitai";
        let proj_dir = projects.join(mangled);
        fs::create_dir_all(&proj_dir).unwrap();
        // 目标已存在同名文件
        let existing = proj_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&existing, "existing").unwrap();
        // 回收站里也有一个同名备份
        let backup_dir = trash.join("20260812_090000").join(mangled);
        fs::create_dir_all(&backup_dir).unwrap();
        let backup = backup_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&backup, "backup").unwrap();

        let err = restore_trashed_file(&backup, &projects).unwrap_err();
        assert!(err.contains("已存在"));
        // 原备份未被破坏
        assert!(backup.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn purge_trash_physically_deletes() {
        let root = temp_root("trash-purge");
        let trash = root.join("trash").join("sessions");
        // 两个时间批次，共 3 个会话
        let batch1 = trash.join("20260811_100000").join("D--baitai");
        let batch2 = trash.join("20260812_090000").join("D--MyWorkspaces-myProject-claude-fast");
        fs::create_dir_all(&batch1).unwrap();
        fs::create_dir_all(&batch2).unwrap();
        fs::write(batch1.join("11111111-1111-4111-8111-111111111111.jsonl"), sample_head()).unwrap();
        fs::write(batch2.join("22222222-2222-4222-8222-222222222222.jsonl"), sample_head()).unwrap();
        fs::write(batch2.join("33333333-3333-4333-8333-333333333333.jsonl"), sample_head()).unwrap();

        let count = purge_trash_in(&trash).unwrap();
        assert_eq!(count, 3);
        // 回收站已空（根目录保留，供后续继续接收删除的会话）
        assert!(trash.exists());
        assert!(list_trashed_sessions_in(&trash).is_empty());
        // 磁盘上没有任何残留备份（trash/ 下只剩空的 sessions/）
        assert_eq!(
            fs::read_dir(root.join("trash")).unwrap().flatten().count(),
            1
        );

        // 空回收站再次清空 → 0
        let count2 = purge_trash_in(&trash).unwrap();
        assert_eq!(count2, 0);
        fs::remove_dir_all(&root).unwrap();
    }

    // ---------------- 会话内容读取（v2.0.0 阶段二：方向 A） ----------------

    #[test]
    fn parse_session_messages_extracts_blocks() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"你好，帮我看看"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"好的，我来看看"},{"type":"thinking","thinking":"先分析一下"},{"type":"tool_use","id":"toolu_abc","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-08-12T06:47:47.000Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file1.txt"}]},"timestamp":"2026-08-12T06:47:47.500Z"}"#,
            r#"{"type":"ai-title","aiTitle":"标题","sessionId":"x"}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 3);
        // 元数据行（mode/ai-title）被过滤
        // 消息 1：user 文本
        assert_eq!(r[0].kind, "user");
        assert_eq!(r[0].blocks.len(), 1);
        assert_eq!(r[0].blocks[0].kind, "text");
        assert_eq!(r[0].blocks[0].text.as_deref(), Some("你好，帮我看看"));
        assert_eq!(r[0].timestamp.as_deref(), Some("2026-08-12T06:47:46.519Z"));
        // 消息 2：assistant text + thinking + tool_use
        let m2 = &r[1];
        assert_eq!(m2.kind, "assistant");
        assert_eq!(m2.model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(m2.blocks.len(), 3);
        assert_eq!(m2.blocks[0].kind, "text");
        assert_eq!(m2.blocks[1].kind, "thinking");
        assert_eq!(m2.blocks[2].kind, "tool_use");
        assert_eq!(m2.blocks[2].name.as_deref(), Some("Bash"));
        assert_eq!(m2.blocks[2].tool_use_id.as_deref(), Some("toolu_abc"));
        assert_eq!(
            m2.blocks[2].input.as_ref().and_then(|v| v.get("command")).and_then(|v| v.as_str()),
            Some("ls")
        );
        // 消息 3：user tool_result
        let m3 = &r[2];
        assert_eq!(m3.blocks[0].kind, "tool_result");
        assert_eq!(m3.blocks[0].text.as_deref(), Some("file1.txt"));
        assert_eq!(m3.blocks[0].tool_use_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn parse_session_messages_skips_meta_sidechain_commands() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n",
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"系统注入"}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"子会话"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"正常的对话"}}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].blocks[0].text.as_deref(), Some("正常的对话"));
    }

    #[test]
    fn parse_session_messages_treats_task_notification_as_tool_result() {
        // 后台任务完成通知（user 字符串消息）不应显示成用户输入，而是工具结果
        let jsonl = format!(
            "{}\n",
            r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a35ea541f842e114e</task-id>\n<tool-use-id>call_ffd1d8c7a52341febe1c28d0</tool-use-id>\n<output-file>C:\\temp\\x.output</output-file>\n<status>completed</status>\n<summary>Agent 任务完成</summary>\n<result>任务完成，共处理 5 个文件\n- a.ts 已更新</result>\n</task-notification>"}}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, "user");
        let b = &r[0].blocks[0];
        assert_eq!(b.kind, "tool_result");
        assert_eq!(b.tool_use_id.as_deref(), Some("call_ffd1d8c7a52341febe1c28d0"));
        let text = b.text.as_deref().unwrap();
        // 提取的是 <result> 内容
        assert!(text.contains("任务完成，共处理 5 个文件"));
        assert!(text.contains("a.ts 已更新"));
        // 不应包含 XML 标签本身
        assert!(!text.contains("<task-notification>"));
        assert!(!text.contains("<summary>"));

        // 无 <result> 时回退 <summary>
        let jsonl2 = format!(
            "{}\n",
            r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<summary>只有摘要</summary>\n</task-notification>"}}"#,
        );
        let r2 = parse_session_messages(&jsonl2);
        assert_eq!(r2[0].blocks[0].text.as_deref(), Some("只有摘要"));
    }

    #[test]
    fn parse_session_messages_truncates_at_limit() {
        // 901 条消息 → 默认取最后 500 条，has_more=true，offset=401
        let mut jsonl = String::new();
        for i in 0..(MAX_SESSION_MESSAGES + 401) {
            jsonl.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"消息 {i}\"}}}}\n"
            ));
        }
        let all = parse_session_messages(&jsonl);
        assert_eq!(all.len(), MAX_SESSION_MESSAGES + 401);

        // 默认（不带 offset）：最后 500 条
        let r = slice_messages(all.clone(), None, None);
        assert!(r.has_more);
        assert_eq!(r.total, MAX_SESSION_MESSAGES + 401);
        assert_eq!(r.offset, 401);
        assert_eq!(r.messages.len(), MAX_SESSION_MESSAGES);
        assert!(r.messages[0].blocks[0].text.as_deref().unwrap().contains("消息 401"));

        // 加载更早：offset=0（第一页）
        let r0 = slice_messages(all.clone(), Some(0), None);
        assert!(!r0.has_more);
        assert_eq!(r0.offset, 0);
        assert_eq!(r0.messages.len(), MAX_SESSION_MESSAGES);
        assert!(r0.messages[0].blocks[0].text.as_deref().unwrap().contains("消息 0"));

        // 小会话：不足 500 条 → 全部返回，has_more=false
        let small = slice_messages(all[..100].to_vec(), None, None);
        assert!(!small.has_more);
        assert_eq!(small.offset, 0);
        assert_eq!(small.messages.len(), 100);

        // 自定义 limit
        let rl = slice_messages(all, Some(100), Some(50));
        assert_eq!(rl.offset, 100);
        assert_eq!(rl.messages.len(), 50);
        assert!(rl.messages[0].blocks[0].text.as_deref().unwrap().contains("消息 100"));
    }

    #[test]
    fn parse_session_messages_ignores_bad_lines() {
        let jsonl = "这不是 json\n{\"type\":\"user\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ok\"}}\n";
        let r = parse_session_messages(jsonl);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].blocks[0].text.as_deref(), Some("ok"));
    }

    #[test]
    fn parse_session_messages_handles_array_text_and_errors() {
        let jsonl = format!(
            "{}\n{}\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"多块"},{"type":"text","text":"拼接"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"出错了"}]}]}}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].blocks.len(), 2);
        assert_eq!(r[1].blocks[0].is_error, Some(true));
        assert_eq!(r[1].blocks[0].text.as_deref(), Some("出错了"));
    }

    // ---------------- 会话继续对话（v2.0.0 阶段二：方向 B resume） ----------------

    #[cfg(windows)]
    #[test]
    fn build_resume_cmdline_ok() {
        let dir = temp_root("resume-cmd");
        let cmd = build_resume_cmdline(
            dir.to_str().unwrap(),
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
        )
        .unwrap();
        assert!(cmd.starts_with("/k cd /d \""));
        assert!(cmd.contains("&& claude --resume 5426d6d0-c08f-43bd-94df-4d6d99e5c699"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn build_resume_cmdline_rejects_bad_paths() {
        // 空路径
        assert!(build_resume_cmdline("", "x").is_err());
        // 引号（截断 cd 的引号边界）
        assert!(build_resume_cmdline("D:\\My\\\"Workspaces", "x").is_err());
        // %VAR% 引号内仍会展开；! 防延迟展开
        assert!(build_resume_cmdline("D:\\a%b", "x").is_err());
        assert!(build_resume_cmdline("D:\\a!b", "x").is_err());
        // 不存在的目录
        let nonexist = std::env::temp_dir().join(format!("cf-no-such-{}", std::process::id()));
        assert!(build_resume_cmdline(nonexist.to_str().unwrap(), "x").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn build_resume_cmdline_allows_quoted_literals() {
        // 双引号内 & | < > ^ ( ) 均为字面量：含空格与括号的合法路径不得误拒
        let dir = temp_root("resume (x86) & test");
        let cmd = build_resume_cmdline(
            dir.to_str().unwrap(),
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
        )
        .unwrap();
        assert!(cmd.contains("resume (x86) & test"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn validate_resume_path_checks() {
        // 空路径
        assert!(validate_resume_path("").is_err());
        // 不存在的目录
        let nonexist = std::env::temp_dir().join(format!("cf-no-such-{}", std::process::id()));
        assert!(validate_resume_path(nonexist.to_str().unwrap()).is_err());
        // 存在的目录通过
        let dir = temp_root("resume-valid");
        assert!(validate_resume_path(dir.to_str().unwrap()).is_ok());
        // 平台元字符：Windows 拒 cmd 特殊字符，macOS 拒 bash 特殊字符
        #[cfg(windows)]
        {
            assert!(validate_resume_path("D:\\a&b").is_err());
            assert!(validate_resume_path("D:\\a|b").is_err());
            assert!(validate_resume_path("D:\\a^b").is_err());
        }
        #[cfg(not(windows))]
        {
            // macOS：路径放进 cd "..." 经 sh_quote 转义，双引号内这些字符均为字面量，
            // 不再额外拒绝（避免误伤含 ( ) ' \ 等的合法 mac 路径）。用真实目录验证通过。
            let d = temp_root("resume-tricky");
            let tricky = d.join("my'app (v2)\\3"); // 含 ' ( ) 空格 \ ——合法 mac 文件名字符
            fs::create_dir_all(&tricky).unwrap();
            assert!(validate_resume_path(tricky.to_str().unwrap()).is_ok());
            // 控制字符仍拒绝
            assert!(validate_resume_path(&format!("{}\u{1}", d.to_str().unwrap())).is_err());
            fs::remove_dir_all(&d).unwrap();
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// macOS resume 临时脚本内容（Windows 上不编译，随 mac 构建跑）
    #[cfg(not(windows))]
    #[test]
    fn build_resume_script_ok() {
        let dir = temp_root("resume-sh");
        let script = build_resume_script(
            dir.to_str().unwrap(),
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
        )
        .unwrap();
        assert!(script.starts_with("#!/bin/bash\n"));
        assert!(script.contains(&format!("cd \"{}\" || exit 1", dir.to_str().unwrap())));
        assert!(script.contains("exec claude --resume 5426d6d0-c08f-43bd-94df-4d6d99e5c699"));
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---------------- 去脚本化：项目清单与迁移 ----------------

    #[test]
    fn list_projects_impl_merges_scan_and_manual() {
        let root = temp_root("proj-list");
        let projects = root.join("projects");
        // 手动添加但磁盘上存在的路径 → 非 missing；手动添加但不存在的 → missing
        let real = Path::new(&root).join("real_proj");
        fs::create_dir_all(&real).unwrap();

        // 不存在的路径按平台取样式（叶子名提取随平台分隔符）
        let ghost = if cfg!(windows) { "D:\\ghost\\path" } else { "/ghost/path" };
        let list = list_projects_impl(
            &projects,
            &[real.to_str().unwrap().to_string(), ghost.to_string()],
            &[],
        );
        // 会话目录为空 → 只有手动项；大小写不敏感去重后 2 条
        assert_eq!(list.len(), 2);
        let delta = list.iter().find(|x| x.path == ghost).unwrap();
        assert!(delta.missing);
        assert_eq!(delta.name, "path");
        let real_item = list.iter().find(|x| x.path == real.to_str().unwrap()).unwrap();
        assert!(!real_item.missing);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn legacy_config_migrates_to_projects() {
        let root = temp_root("proj-migrate");
        // 旧脚本指向的项目路径（脚本格式随平台：bat 用 cd /d，sh 用 cd "..."）
        let (proj, dead) = if cfg!(windows) {
            ("D:\\legacy\\proj", "D:\\legacy\\dead")
        } else {
            ("/legacy-migrate-test/proj", "/legacy-migrate-test/dead")
        };
        let mk_script = |p: &str| {
            if cfg!(windows) {
                format!("@echo off\r\ncd /d \"{p}\"")
            } else {
                format!("cd \"{p}\"")
            }
        };
        // 旧脚本：claude-oldproj 指向 proj；claude-dead 指向不存在目录
        let scripts = root.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(
            scripts.join(format!("claude-oldproj.{}", script_ext())),
            mk_script(proj),
        )
        .unwrap();
        fs::write(
            scripts.join(format!("claude-dead.{}", script_ext())),
            mk_script(dead),
        )
        .unwrap();
        // 旧版 config：favorites 存脚本 key、无 projects 字段
        fs::write(
            root.join("config.json"),
            r#"{"favorites": ["claude-oldproj", "claude-unknown"], "dark": false}"#,
        )
        .unwrap();

        ensure_projects_migrated_in(&root);

        let migrated = load_config_from(&root);
        // projects = 全部脚本路径（顺序按解析序，包含已失效的）
        assert!(migrated.projects.iter().any(|p| p.eq_ignore_ascii_case(proj)));
        assert!(migrated.projects.iter().any(|p| p.eq_ignore_ascii_case(dead)));
        // order = 旧收藏 key 映射后的路径（旧「收藏」即置顶语义，承接为排序最前几项）；
        // unknown 找不到被丢弃
        assert_eq!(migrated.order, vec![proj.to_string()]);
        // 幂等：二次调用不再变化
        ensure_projects_migrated_in(&root);
        let again = load_config_from(&root);
        assert_eq!(again.projects, migrated.projects);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 旧版 favorites 键（路径语义）经 serde alias 无缝承接为 order 初始排序，
    /// 写回后键名变为 order、favorites 不再出现
    #[test]
    fn config_order_aliases_legacy_favorites() {
        let root = temp_root("cfg-order-alias");
        fs::write(
            root.join("config.json"),
            r#"{"favorites":["D:\\a","D:\\b"],"projects":[],"dark":false}"#,
        )
        .unwrap();
        let mut cfg = load_config_from(&root);
        assert_eq!(cfg.order, vec!["D:\\a".to_string(), "D:\\b".to_string()]);
        cfg.order.push("D:\\c".to_string());
        save_config_file(&root, &cfg).unwrap();
        let json = fs::read_to_string(root.join("config.json")).unwrap();
        assert!(json.contains("\"order\""));
        assert!(!json.contains("\"favorites\""));
        fs::remove_dir_all(&root).unwrap();
    }

    /// 置顶区元数据：按清单顺序返回，文件不存在 / 不在 Claude 目录下的条目跳过且不报错
    #[test]
    fn pinned_meta_lists_existing_skips_missing() {
        let root = temp_root("pinned-meta");
        let projects = root.join("projects");
        let proj_dir = projects.join("D--baitai");
        fs::create_dir_all(&proj_dir).unwrap();
        let uuid = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";
        let live = proj_dir.join(format!("{uuid}.jsonl"));
        fs::write(&live, sample_head()).unwrap();

        let pins = vec![
            PinnedSession {
                file: live.to_string_lossy().to_string(),
                project_path: "D:\\baitai".to_string(),
            },
            // 文件不存在（已彻底删除 / 换机器后的悬空路径）→ 跳过
            PinnedSession {
                file: proj_dir
                    .join("aaaaaaaa-0000-0000-0000-000000000000.jsonl")
                    .to_string_lossy()
                    .to_string(),
                project_path: "D:\\baitai".to_string(),
            },
            // 不在 Claude projects 目录下 → 跳过
            PinnedSession {
                file: root.join("evil.jsonl").to_string_lossy().to_string(),
                project_path: "D:\\baitai".to_string(),
            },
        ];
        let out = pinned_meta_in(&pins, &projects);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, uuid);
        assert_eq!(out[0].title, "修复登录页面");
        assert_eq!(out[0].project_path, "D:\\baitai");
        assert!(out[0].last_modified > 0);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 彻底删除后清掉失效置顶条目，存活的条目保留
    #[test]
    fn prune_dead_pins_drops_missing_files() {
        let root = temp_root("pinned-prune");
        let live = root.join("a.jsonl");
        fs::write(&live, "x").unwrap();
        let mut cfg = Config {
            pinned_sessions: vec![
                PinnedSession {
                    file: live.to_string_lossy().to_string(),
                    project_path: "D:\\a".to_string(),
                },
                PinnedSession {
                    file: root.join("gone.jsonl").to_string_lossy().to_string(),
                    project_path: "D:\\a".to_string(),
                },
            ],
            ..Config::default()
        };
        prune_dead_pins(&mut cfg);
        assert_eq!(cfg.pinned_sessions.len(), 1);
        assert_eq!(cfg.pinned_sessions[0].file, live.to_string_lossy());
        fs::remove_dir_all(&root).unwrap();
    }

    /// 项目移除 / 会话数据清除：该项目下的置顶条目一并撤掉（路径大小写不敏感）
    #[test]
    fn drop_pins_for_projects_is_case_insensitive() {
        let mut cfg = Config {
            pinned_sessions: vec![
                PinnedSession {
                    file: "f1".to_string(),
                    project_path: "D:\\baitai".to_string(),
                },
                PinnedSession {
                    file: "f2".to_string(),
                    project_path: "D:\\other".to_string(),
                },
            ],
            ..Config::default()
        };
        drop_pins_for_projects(&mut cfg, &["d:\\BAITAI".to_string()]);
        assert_eq!(cfg.pinned_sessions.len(), 1);
        assert_eq!(cfg.pinned_sessions[0].project_path, "D:\\other");
    }

    #[test]
    fn add_remove_project_updates_lists() {
        // add_project_to 要求路径真实存在（不存在的路径被静默忽略）
        let dir = temp_root("add-rm");
        let alpha = dir.join("alpha");
        let beta = dir.join("beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        let mut manual: Vec<String> = Vec::new();
        add_project_to(&mut manual, alpha.to_str().unwrap());
        // 大小写不敏感去重
        add_project_to(&mut manual, &alpha.to_str().unwrap().to_uppercase());
        assert_eq!(manual.len(), 1);
        add_project_to(&mut manual, beta.to_str().unwrap());
        assert_eq!(manual.len(), 2);
        remove_project_from(&mut manual, &beta.to_str().unwrap().to_uppercase());
        assert_eq!(manual, vec![alpha.to_str().unwrap().to_string()]);
        // 不存在的路径被静默忽略（按平台取不存在的路径样式）
        let ghost_never = if cfg!(windows) { "D:\\ghost\\never" } else { "/ghost/never" };
        add_project_to(&mut manual, ghost_never);
        assert_eq!(manual.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---------------- 会话统计 / 搜索 / 导出（会话域增强包） ----------------

    #[test]
    fn usage_parses_old_and_new_formats() {
        // 旧格式：usage 各字段直接是数字
        let old: serde_json::Value =
            serde_json::from_str(r#"{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}"#)
                .unwrap();
        let u = parse_usage(Some(&old)).unwrap();
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 20);
        assert_eq!(u.cache_read_input_tokens, 5);
        assert_eq!(u.cache_creation_input_tokens, 3);
        // 新格式：input_tokens 是嵌套对象
        let new: serde_json::Value = serde_json::from_str(
            r#"{"input_tokens":{"cache_read":7,"cache_creation":2,"input":300},"output_tokens":40}"#,
        )
        .unwrap();
        let u = parse_usage(Some(&new)).unwrap();
        assert_eq!(u.input_tokens, 300);
        assert_eq!(u.cache_read_input_tokens, 7);
        assert_eq!(u.cache_creation_input_tokens, 2);
        assert_eq!(u.output_tokens, 40);
        // 无 usage → None
        assert!(parse_usage(None).is_none());
        // 用法字段缺失 → 默认 0
        let empty: serde_json::Value = serde_json::from_str("{}").unwrap();
        let u = parse_usage(Some(&empty)).unwrap();
        assert_eq!(u.input_tokens, 0);
        assert_eq!(u.output_tokens, 0);
    }

    #[test]
    fn parse_session_messages_aggregates_usage() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"你好"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好！"}],"model":"claude-sonnet-4","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}},"timestamp":"2026-08-12T06:47:47.000Z","costUSD":0.0012}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"继续"}],"model":"claude-sonnet-4","usage":{"input_tokens":{"cache_read":7,"cache_creation":2,"input":300},"output_tokens":40}},"timestamp":"2026-08-12T06:47:48.000Z","costUSD":0.0035}"#,
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
        );
        let messages = parse_session_messages(&jsonl);
        assert_eq!(messages.len(), 3);
        // user 消息无 usage；assistant 有
        assert!(messages[0].usage.is_none());
        assert!(messages[2].usage.is_some());
        let stats = aggregate_usage(&messages);
        assert_eq!(stats.message_count, 3);
        assert_eq!(stats.input_tokens, 400);
        assert_eq!(stats.output_tokens, 60);
        assert_eq!(stats.cache_read_tokens, 12);
        assert_eq!(stats.cache_creation_tokens, 5);
        assert_eq!(stats.total_tokens, 477); // 400 + 60 + 12 + 5
        // 分页统计不受切片影响
        let paged = slice_messages(messages, None, Some(2));
        assert_eq!(paged.messages.len(), 2);
        assert_eq!(paged.stats.input_tokens, 400);
        assert_eq!(paged.stats.message_count, 3);
    }

    #[test]
    fn search_session_hits_text_and_tool_input() {
        let jsonl = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"帮我检查 AuthService 的登录逻辑"},"timestamp":"t1"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"我来看看 AuthService"},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"src/AuthService.ts"}},{"type":"thinking","thinking":"lorem ipsum"}],"model":"m"},"timestamp":"t2"}"#,
            r#"{"type":"user","message":{"role":"user","content":"检查一下地址校验吧"},"timestamp":"t3"}"#,
        );
        let hits = search_session_messages_impl(&jsonl, "authservice");
        // 用户消息 1 处 + assistant text 1 处 + tool_use 输入 1 处（大小写不敏感）
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].index, 0);
        assert_eq!(hits[0].kind, "user");
        assert_eq!(hits[1].index, 1);
        assert_eq!(hits[1].block_index, 0);
        assert_eq!(hits[2].block_index, 1); // tool_use 块
        assert!(hits[2].snippet.to_lowercase().contains("authservice"));
        // thinking 不参与搜索
        assert!(search_session_messages_impl(&jsonl, "lorem").is_empty());
        // 无结果 / 空白关键词
        assert!(search_session_messages_impl(&jsonl, "不存在的词 XYZ").is_empty());
        assert!(search_session_messages_impl(&jsonl, "  ").is_empty());
    }

    #[test]
    fn user_prompts_skip_commands_tool_results_and_interruptions() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n",
            // 命令消息：不算发言
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name><command-message>clear</command-message>"},"timestamp":"t1"}"#,
            // 真实发言 1
            r#"{"type":"user","message":{"role":"user","content":"修复登录页面的 bug"},"timestamp":"t2"}"#,
            // assistant 回复
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的"}],"model":"m"},"timestamp":"t3"}"#,
            // 工具结果消息：不算发言
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]},"timestamp":"t4"}"#,
            // 中断提示：不算发言
            r#"{"type":"user","message":{"role":"user","content":"[Request interrupted by user for tool use]"},"timestamp":"t5"}"#,
            // system-reminder 包裹的上下文被剥离，只留真实发言
            r#"{"type":"user","message":{"role":"user","content":"<system-reminder>background context</system-reminder>再看一下测试"},"timestamp":"t6"}"#,
        );
        let prompts = user_prompts_impl(&jsonl);
        assert_eq!(prompts.len(), 2);
        // index 是 parse_session_messages 的全局序号；命令消息在解析层就被丢弃不占位
        assert_eq!(prompts[0].index, 0);
        assert_eq!(prompts[0].text, "修复登录页面的 bug");
        assert_eq!(prompts[1].index, 4);
        assert_eq!(prompts[1].text, "再看一下测试");
    }

    #[test]
    fn make_snippet_never_panics_on_boundaries() {
        let text = "你好，这是一段中文测试文本，用于验证搜索片段是否安全。";
        // 命中 0 字节处（关键词恰好从开头）→ 片段以关键词开头且不超原文
        let s = make_snippet(text, 0, "你好".len(), 40);
        assert!(s.starts_with("你好"));
        assert!(s.len() <= text.len());
        // 命中在末尾（超出范围自动收敛，不 panic）
        let s = make_snippet(text, text.len(), 1, 40);
        assert!(s.len() <= text.len());
        // 命中在文本中间（字节位置落在 UTF-8 边界内，floor/ceil 收敛）
        let s = make_snippet(text, 9, 3, 4);
        assert!(!s.is_empty());
        assert!(s.len() <= text.len());
        // 命中位置大于文本长度（lowercase 字节漂移的极端情况）：收敛为合法片段，不 panic
        let s = make_snippet(text, text.len() + 10, 2, 3);
        assert!(s.is_empty() || s.len() <= text.len());
    }

    #[test]
    fn render_session_markdown_outputs_expected_sections() {
        let jsonl = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"你好"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好！有什么可以帮你？"},{"type":"thinking","thinking":"考虑中"},{"type":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"src/a.ts","old_string":"x","new_string":"y"}}],"model":"claude-sonnet-4"},"timestamp":"2026-08-12T06:47:47.000Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"编辑成功","is_error":false}]},"timestamp":"2026-08-12T06:47:48.000Z"}"#,
        );
        let messages = parse_session_messages(&jsonl);
        let md = render_session_markdown(&messages, "测试会话");
        assert!(md.starts_with("# 测试会话"), "{md}");
        assert!(md.contains("## 用户 · 2026-08-12 06:47"), "{md}");
        assert!(md.contains("## Claude（claude-sonnet-4） · 2026-08-12 06:47"), "{md}");
        assert!(md.contains("你好！有什么可以帮你？"));
        assert!(md.contains("> 💭 思考过程（省略）"));
        // Edit 工具：leaf 文件名摘要
        assert!(md.contains("🔧 Edit · a.ts"), "{md}");
        // tool_result 关联到 tool_use 名
        assert!(md.contains("📄 Edit 结果：编辑成功"), "{md}");
        // 长文本截断
        let long = format!(
            "{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"开始"},"timestamp":"t1"}"#,
            format!(
                r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"tu1","content":"{}","is_error":false}}]}},"timestamp":"t2"}}"#,
                "x".repeat(500)
            ),
        );
        let md2 = render_session_markdown(&parse_session_messages(&long), "t");
        assert!(md2.contains("…"));
    }

    #[test]
    fn export_bytes_markdown_and_jsonl() {
        let jsonl = format!(
            "{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"你好"},"timestamp":"t1"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好！"}],"model":"m"},"timestamp":"t2"}"#,
        );
        // markdown：渲染为文档
        let md = String::from_utf8(build_export_bytes(&jsonl, "markdown", "导出标题").unwrap())
            .unwrap();
        assert!(md.contains("# 导出标题"));
        assert!(md.contains("## 用户"));
        assert!(md.contains("## Claude"));
        // jsonl：原样复制（保真）
        assert_eq!(
            build_export_bytes(&jsonl, "jsonl", "t").unwrap(),
            jsonl.as_bytes()
        );
        // 未知格式报错
        assert!(build_export_bytes(&jsonl, "pdf", "t").is_err());
    }

    // ---------------- 使用统计仪表盘 ----------------

    #[test]
    fn scan_file_usage_aggregates_by_day_and_model() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}},"timestamp":"2026-08-12T06:47:47.000Z","costUSD":0.0012}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"b"}],"model":"claude-opus-4-1","usage":{"input_tokens":{"cache_read":7,"cache_creation":2,"input":300},"output_tokens":40}},"timestamp":"2026-08-13T07:00:00.000Z"}"#,
            // sidechain 子代理消息同样计入（真实 token 消耗）
            r#"{"isSidechain":true,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"c"}],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":2}},"timestamp":"2026-08-12T08:00:00.000Z"}"#,
            // user 行不计
            r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        let u = scan_file_usage(&jsonl, 0);
        assert_eq!(u.messages, 3);
        // 100+20+5+3 + 300+40+7+2 + 10+2 = 489
        assert_eq!(u.tokens, 489);
        assert_eq!(u.input_tokens, 410);
        assert_eq!(u.output_tokens, 62);
        assert_eq!(u.cache_read_tokens, 12);
        assert_eq!(u.cache_creation_tokens, 5);
        assert_eq!(u.per_day.len(), 2);
        assert_eq!(u.per_day["2026-08-12"].1, 2); // 当天 2 条
        assert_eq!(u.per_day["2026-08-12"].0, 128 + 12);
        assert_eq!(u.per_model.len(), 2);
        assert_eq!(u.per_model["claude-sonnet-4-20250514"].1, 2);
        assert_eq!(u.per_model["claude-opus-4-1"].0, 349);
    }

    #[test]
    fn scan_file_usage_skips_non_assistant_and_bad_lines() {
        let jsonl = "\nnot json\n{\"type\":\"mode\"}\n{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"无usage\"}}\n";
        let u = scan_file_usage(jsonl, 0);
        assert_eq!(u.messages, 0);
        assert!(u.per_day.is_empty());
    }

    #[test]
    fn scan_file_usage_skips_synthetic_placeholder() {
        // <synthetic> 是打断应答/API 报错的本地占位消息（usage 恒 0），
        // 不进模型分布，也不把消息计数 +1
        let jsonl = format!(
            "{}\n{}\n",
            r#"{"type":"assistant","message":{"id":"msg_s","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-08-12T06:47:47.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_r","role":"assistant","model":"glm-5.3","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}},"timestamp":"2026-08-12T07:00:00.000Z"}"#,
        );
        let u = scan_file_usage(&jsonl, 0);
        assert_eq!(u.messages, 1);
        assert_eq!(u.tokens, 15);
        assert!(u.per_model.get("<synthetic>").is_none());
        assert_eq!(u.per_model["glm-5.3"], (15, 1));
        assert!(u.per_day_model["2026-08-12"].get("<synthetic>").is_none());
    }

    #[test]
    fn scan_file_usage_dedups_same_msg_id() {
        // 流式写入：一次响应拆多行，message.id 与 usage 相同 → 只统计一次
        let jsonl = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"1"}],"usage":{"input_tokens":100,"output_tokens":20}},"timestamp":"2026-08-17T01:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"usage":{"input_tokens":100,"output_tokens":20}},"timestamp":"2026-08-17T01:00:01.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_b","role":"assistant","content":[{"type":"text","text":"2"}],"usage":{"input_tokens":50,"output_tokens":10}},"timestamp":"2026-08-17T02:00:00.000Z"}"#,
        );
        let u = scan_file_usage(&jsonl, 0);
        assert_eq!(u.messages, 2); // msg_a 去重后只 1 条 + msg_b
        assert_eq!(u.tokens, 120 + 60);
        assert_eq!(u.per_day["2026-08-17"].1, 2); // 当天消息数也是去重口径
    }

    #[test]
    fn scan_file_usage_takes_final_snapshot_over_zero_placeholder() {
        // 真实写入次序：先落 thinking/text 的占位行（usage 全 0、无 stop_reason），
        // 真实用量在收尾行。取首行会把整条消息记成 0（实测有会话因此只剩 1.3%）
        let jsonl = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"assistant","message":{"id":"msg_p","role":"assistant","content":[{"type":"thinking","thinking":"..."}],"model":"deepseek-v4-flash","usage":{"input_tokens":0,"output_tokens":0}},"timestamp":"2026-08-17T01:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_p","role":"assistant","content":[{"type":"text","text":"hi"}],"model":"deepseek-v4-flash","usage":{"input_tokens":0,"output_tokens":0}},"timestamp":"2026-08-17T01:00:01.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_p","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"model":"deepseek-v4-flash","usage":{"input_tokens":30754,"output_tokens":1092,"cache_read_input_tokens":640},"stop_reason":"tool_use"},"timestamp":"2026-08-17T01:00:02.000Z"}"#,
        );
        let u = scan_file_usage(&jsonl, 0);
        assert_eq!(u.messages, 1);
        assert_eq!(u.tokens, 30754 + 1092 + 640);
        assert_eq!(u.per_model["deepseek-v4-flash"], (32486, 1));
    }

    #[test]
    fn scan_file_usage_prefers_final_row_even_if_intermediate_is_bigger() {
        // 收尾行（stop_reason）优先于 token 更大的中间行：中间行是同一响应的
        // 快照，只有收尾行是最终值
        let jsonl = format!(
            "{}\n{}\n",
            r#"{"type":"assistant","message":{"id":"msg_q","role":"assistant","content":[{"type":"text","text":"x"}],"model":"glm-5.3","usage":{"input_tokens":900,"output_tokens":300}},"timestamp":"2026-08-17T01:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_q","role":"assistant","content":[{"type":"text","text":"x"}],"model":"glm-5.3","usage":{"input_tokens":100,"output_tokens":20},"stop_reason":"end_turn"},"timestamp":"2026-08-17T01:00:01.000Z"}"#,
        );
        let u = scan_file_usage(&jsonl, 0);
        assert_eq!(u.tokens, 120);
    }

    #[test]
    fn usage_jsonl_files_covers_subagents_and_workflows() {
        // 固定深度枚举：主会话 + subagents + workflows/wf_*；无关目录/非会话文件不计
        let root = temp_root("usage-files");
        let proj = root.join("D--work-alpha");
        let sid = "aaaaaaaa-1111-4111-8111-111111111111";
        fs::create_dir_all(proj.join(sid).join("subagents").join("workflows").join("wf_1")).unwrap();
        fs::create_dir_all(proj.join("memory")).unwrap();
        fs::create_dir_all(proj.join(sid).join("tool-results")).unwrap();
        fs::write(proj.join(format!("{sid}.jsonl")), "").unwrap();
        fs::write(proj.join("journal.jsonl"), "").unwrap(); // 非 uuid：不计
        fs::write(proj.join(sid).join("subagents").join("agent-a1.jsonl"), "").unwrap();
        fs::write(proj.join(sid).join("subagents").join("journal.jsonl"), "").unwrap();
        fs::write(
            proj.join(sid).join("subagents").join("workflows").join("wf_1").join("agent-b2.jsonl"),
            "",
        )
        .unwrap();
        fs::write(proj.join(sid).join("tool-results").join("r1.jsonl"), "").unwrap();
        fs::write(proj.join("memory").join("m.jsonl"), "").unwrap();

        let mut got: Vec<(String, String)> = usage_jsonl_files(&proj)
            .into_iter()
            .map(|(p, s)| {
                (
                    p.file_name().unwrap().to_string_lossy().to_string(),
                    s.clone(),
                )
            })
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                (format!("{sid}.jsonl"), sid.to_string()),
                ("agent-a1.jsonl".to_string(), sid.to_string()),
                ("agent-b2.jsonl".to_string(), sid.to_string()),
                ("journal.jsonl".to_string(), sid.to_string()),
            ]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    /// 子代理文件计入 token，但**不新增会话**（归属父会话）；顶层非 uuid 文件不计
    #[test]
    fn stats_ledger_counts_subagent_files_under_parent_session() {
        let root = temp_root("ledger-subagent");
        let pa = root.join("projects").join("D--work-alpha");
        let sid = "aaaaaaaa-1111-4111-8111-111111111111";
        let sub = pa.join(sid).join("subagents");
        let wf = sub.join("workflows").join("wf_1");
        fs::create_dir_all(&wf).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"id":"m{tokens}","role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"deepseek-v4.1-flash","usage":{{"input_tokens":{tokens},"output_tokens":1,"cache_read_input_tokens":0}},"stop_reason":"end_turn"}},"timestamp":"{ts}"}}"#,
            )
        };
        fs::write(pa.join(format!("{sid}.jsonl")), line("2026-08-12T01:00:00.000Z", 100)).unwrap();
        fs::write(
            pa.join("journal.jsonl"), // 顶层非 uuid：不是会话文件
            line("2026-08-12T01:00:00.000Z", 7),
        )
        .unwrap();
        fs::write(sub.join("agent-a1.jsonl"), line("2026-08-12T02:00:00.000Z", 50)).unwrap();
        fs::write(wf.join("agent-b2.jsonl"), line("2026-08-12T03:00:00.000Z", 25)).unwrap();

        let projects = vec![("alpha".to_string(), "D:\\work\\alpha".to_string(), pa.clone())];
        let mut ledger = StatsLedger::default();
        let s = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!(s.tokens, 101 + 51 + 26); // 子代理与 workflow 都计入，journal 不计
        assert_eq!(s.messages, 3);
        assert_eq!(s.sessions, 1); // 子代理不新增会话
        assert_eq!(s.per_project[0].sessions, 1);
        // 全部归属父会话的活跃日，会话数不随子代理文件重复累加
        assert_eq!(s.per_day.iter().map(|d| d.sessions).sum::<usize>(), 1);
        assert_eq!(ledger.files[&sub.join("agent-a1.jsonl").to_string_lossy().to_string()].session_id, sid);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn parse_session_messages_merges_same_msg_id() {        let jsonl = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"你好"},"timestamp":"t1"}"#,
            // 同一响应的三行（text / tool_use / text）→ 合并为一条消息
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"第一段"}],"usage":{"input_tokens":100,"output_tokens":20}},"timestamp":"t2"}"#,
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]},"timestamp":"t3"}"#,
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"第二段"}]},"timestamp":"t4"}"#,
            // 新响应（不同 id）→ 独立成条
            r#"{"type":"assistant","message":{"id":"msg_b","role":"assistant","content":[{"type":"text","text":"新响应"}],"usage":{"input_tokens":50,"output_tokens":10}},"timestamp":"t5"}"#,
        );
        let messages = parse_session_messages(&jsonl);
        assert_eq!(messages.len(), 3); // user + msg_a(合并) + msg_b
        assert_eq!(messages[1].blocks.len(), 3); // text + tool_use + text
        assert_eq!(messages[1].blocks[0].kind, "text");
        assert_eq!(messages[1].blocks[1].kind, "tool_use");
        assert_eq!(messages[1].blocks[2].kind, "text");
        // usage 取首行，不重复
        let stats = aggregate_usage(&messages);
        assert_eq!(stats.input_tokens, 150);
        assert_eq!(stats.output_tokens, 30);
        assert_eq!(stats.message_count, 3);
    }

    /// 非相邻同 message.id（同 id 的段被 user/tool_result 行隔开，如代理的
    /// 多段迭代响应）：显示上各自成条，但 usage 只计一次——否则查看器
    /// token 统计按段重复累加（实测同一会话 21.3M 被显示成 32.8M）
    #[test]
    fn session_usage_counts_split_msg_id_once() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            // msg_a 第一段（带 usage）
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"段1"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5}},"timestamp":"t1"}"#,
            // user 行（tool_result）打断相邻合并链
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"timestamp":"t2"}"#,
            // msg_a 第二段：同 id、usage 相同 → 显示成新条目，但 usage 不再计入
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"段2"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5}},"timestamp":"t3"}"#,
            r#"{"type":"user","message":{"role":"user","content":"继续"},"timestamp":"t4"}"#,
            // 新响应（不同 id）→ 正常计入
            r#"{"type":"assistant","message":{"id":"msg_b","role":"assistant","content":[{"type":"text","text":"新响应"}],"usage":{"input_tokens":50,"output_tokens":10}},"timestamp":"t5"}"#,
        );
        let messages = parse_session_messages(&jsonl);
        assert_eq!(messages.len(), 5); // 段1 / user / 段2 / user / 新响应 各自成条
        let stats = aggregate_usage(&messages);
        assert_eq!(stats.input_tokens, 150); // msg_a 只计一次（100+50）
        assert_eq!(stats.output_tokens, 30);
        assert_eq!(stats.cache_read_tokens, 5);
        assert_eq!(stats.total_tokens, 185);
    }

    /// 跨天会话的每日会话数只归属最后活跃日：任意窗口内每日累加 = 去重会话数，
    /// 不会出现「全部比近 30 天还少」（跨天重复计入）的回归
    #[test]
    fn per_day_sessions_attributed_to_last_active_day() {
        let root = temp_root("stats-lastday");
        let pa = root.join("projects").join("D--work-alpha");
        fs::create_dir_all(&pa).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"claude-sonnet-4","usage":{{"input_tokens":{tokens},"output_tokens":1}}}},"timestamp":"{ts}"}}"#,
            )
        };
        // 会话 A 跨两天（08-12 与 08-13 各有消息）；会话 B 只在 08-12
        fs::write(
            pa.join("aaaaaaaa-1111-4111-8111-111111111111.jsonl"),
            line("2026-08-12T01:00:00.000Z", 100)
                + "\n"
                + &line("2026-08-13T01:00:00.000Z", 50),
        )
        .unwrap();
        fs::write(
            pa.join("bbbbbbbb-2222-4222-8222-222222222222.jsonl"),
            line("2026-08-12T02:00:00.000Z", 200),
        )
        .unwrap();

        let projects = vec![("alpha".to_string(), "D:\\work\\alpha".to_string(), pa.clone())];
        let s = aggregate_stats_in(&projects, 0);
        assert_eq!(s.sessions, 2);
        // 08-12 只有会话 B（A 归属其最后活跃日 08-13）；token/消息仍按实际发生日累加
        assert_eq!(s.per_day[0].date, "2026-08-12");
        assert_eq!(s.per_day[0].sessions, 1);
        assert_eq!(s.per_day[0].tokens, 302);
        assert_eq!(s.per_day[0].messages, 2);
        assert_eq!(s.per_day[1].date, "2026-08-13");
        assert_eq!(s.per_day[1].sessions, 1);
        assert_eq!(s.per_day[1].tokens, 51);
        // 当日活跃口径：08-12 上 A、B 都有消息（A 的归属日是 08-13 也不影响）
        assert_eq!(s.per_day[0].active_sessions, 2);
        assert_eq!(s.per_day[1].active_sessions, 1);
        // 项目/模型排行的按天明细（前端按范围过滤用）
        assert_eq!(s.per_project[0].per_day.len(), 2);
        assert_eq!(s.per_project[0].per_day[0].date, "2026-08-12");
        assert_eq!(s.per_project[0].per_day[0].tokens, 302);
        assert_eq!(s.per_project[0].per_day[0].sessions, 1); // A 归属 08-13，当天只有 B
        assert_eq!(s.per_project[0].per_day[1].date, "2026-08-13");
        assert_eq!(s.per_project[0].per_day[1].tokens, 51);
        assert_eq!(s.per_project[0].per_day[1].sessions, 1); // A 的最后活跃日
        assert_eq!(s.per_model[0].per_day.len(), 2);
        assert_eq!(s.per_model[0].per_day[0].date, "2026-08-12");
        assert_eq!(s.per_model[0].per_day[0].tokens, 302);
        assert_eq!(s.per_model[0].per_day[0].messages, 2);
        assert_eq!(s.per_model[0].per_day[1].tokens, 51);
        assert_eq!(s.per_model[0].per_day[1].messages, 1);
        // 排行全时段总量不受按天明细影响
        assert_eq!(s.per_project[0].sessions, 2);
        assert_eq!(s.per_project[0].tokens, 302 + 51);
        // 全时段每日累加 == 去重会话数（与「全部」口径一致）
        assert_eq!(s.per_day.iter().map(|d| d.sessions).sum::<usize>(), s.sessions);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 旧版本台账（缺 per_day_model，version 缺省为 0）：mtime/size 虽未变，
    /// 版本号不一致仍触发现存文件全量重扫补齐明细
    #[test]
    fn stats_ledger_version_bump_forces_rescan() {
        let root = temp_root("ledger-ver");
        let pa = root.join("projects").join("D--work-alpha");
        fs::create_dir_all(&pa).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"claude-sonnet-4","usage":{{"input_tokens":{tokens},"output_tokens":1}}}},"timestamp":"{ts}"}}"#,
            )
        };
        let fa = pa.join("aaaaaaaa-1111-4111-8111-111111111111.jsonl");
        fs::write(&fa, line("2026-08-12T01:00:00.000Z", 100)).unwrap();
        let meta = fs::metadata(&fa).unwrap();
        let mtime = meta
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // 伪造旧版台账条目：mtime/size 与现存文件一致（本可命中免扫捷径），但无 per_day_model
        let mut ledger = StatsLedger {
            tz_offset_minutes: 0,
            ..Default::default() // version = 0 ≠ LEDGER_VERSION
        };
        ledger.files.insert(
            fa.to_string_lossy().to_string(),
            LedgerEntry {
                mtime,
                size: meta.len(),
                session_id: "aaaaaaaa-1111-4111-8111-111111111111".to_string(),
                project_dir: "D--work-alpha".to_string(),
                project_name: "alpha".to_string(),
                project_path: "D:\\work\\alpha".to_string(),
                messages: 1,
                tokens: 101,
                ..Default::default()
            },
        );
        let projects = vec![("alpha".to_string(), "D:\\work\\alpha".to_string(), pa.clone())];
        let s = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!(ledger.version, LEDGER_VERSION);
        let e = &ledger.files[&fa.to_string_lossy().to_string()];
        assert_eq!(e.per_day_model["2026-08-12"]["claude-sonnet-4"], (101, 1));
        assert_eq!(s.per_project[0].per_day[0].tokens, 101);
        assert_eq!(s.per_model[0].per_day[0].tokens, 101);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 台账核心：会话文件删除后历史用量保留，统计 = 历史累计消耗
    #[test]
    fn stats_ledger_keeps_deleted_session_history() {
        let root = temp_root("ledger-del");
        let pa = root.join("projects").join("D--work-alpha");
        fs::create_dir_all(&pa).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"claude-sonnet-4","usage":{{"input_tokens":{tokens},"output_tokens":1}}}},"timestamp":"{ts}"}}"#,
            )
        };
        let fa = pa.join("aaaaaaaa-1111-4111-8111-111111111111.jsonl");
        let fb = pa.join("bbbbbbbb-2222-4222-8222-222222222222.jsonl");
        fs::write(&fa, line("2026-08-12T01:00:00.000Z", 100)).unwrap();
        fs::write(&fb, line("2026-08-13T01:00:00.000Z", 200)).unwrap();

        let projects = vec![("alpha".to_string(), "D:\\work\\alpha".to_string(), pa.clone())];
        let mut ledger = StatsLedger::default();
        let s1 = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!(s1.sessions, 2);
        assert_eq!(s1.tokens, 101 + 201);

        // 删除会话 B 后再统计：历史保留，总量不变
        fs::remove_file(&fb).unwrap();
        let s2 = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!(s2.sessions, 2);
        assert_eq!(s2.tokens, 101 + 201);
        assert_eq!(s2.per_project[0].sessions, 2); // 项目行也保留已删会话
        assert_eq!(s2.latest.as_deref(), Some("2026-08-13")); // 已删会话的活跃日仍在趋势里
        fs::remove_dir_all(&root).unwrap();
    }

    /// 台账对变更文件重扫覆盖（resume 追加新消息后总量随之增长）
    #[test]
    fn stats_ledger_updates_changed_session() {
        let root = temp_root("ledger-chg");
        let pa = root.join("projects").join("D--work-alpha");
        fs::create_dir_all(&pa).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"claude-sonnet-4","usage":{{"input_tokens":{tokens},"output_tokens":1}}}},"timestamp":"{ts}"}}"#,
            )
        };
        let fa = pa.join("aaaaaaaa-1111-4111-8111-111111111111.jsonl");
        fs::write(&fa, line("2026-08-12T01:00:00.000Z", 100)).unwrap();
        let projects = vec![("alpha".to_string(), "D:\\work\\alpha".to_string(), pa.clone())];
        let mut ledger = StatsLedger::default();
        let s1 = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!((s1.sessions, s1.messages, s1.tokens), (1, 1, 101));

        // 追加一条（mtime/size 变化 → 重扫覆盖，不是叠加）
        let mut content = fs::read_to_string(&fa).unwrap();
        content.push('\n');
        content.push_str(&line("2026-08-12T02:00:00.000Z", 50));
        fs::write(&fa, content).unwrap();
        let s2 = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!((s2.sessions, s2.messages, s2.tokens), (1, 2, 152));
        fs::remove_dir_all(&root).unwrap();
    }

    /// 排除项目时其台账历史一并移除（与现存口径一致：排除即整体不计）
    #[test]
    fn stats_ledger_drops_excluded_project_history() {
        let root = temp_root("ledger-excl");
        // mangled 目录名与真实路径按平台取（unmangle 随平台：Windows 盘符 X--、macOS 根 -）
        let (mangled, real_path) = if cfg!(windows) {
            ("D--work-alpha", "D:\\work\\alpha")
        } else {
            ("-work-alpha", "/work/alpha")
        };
        let pa = root.join("projects").join(mangled);
        fs::create_dir_all(&pa).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"claude-sonnet-4","usage":{{"input_tokens":{tokens},"output_tokens":1}}}},"timestamp":"{ts}"}}"#,
            )
        };
        fs::write(
            pa.join("aaaaaaaa-1111-4111-8111-111111111111.jsonl"),
            line("2026-08-12T01:00:00.000Z", 100),
        )
        .unwrap();
        let projects = vec![("alpha".to_string(), real_path.to_string(), pa.clone())];
        let mut ledger = StatsLedger::default();
        let s1 = aggregate_stats_ledger(&projects, &[], 0, &mut ledger);
        assert_eq!(s1.sessions, 1);

        // 项目被排除（含文件已删除的历史条目）
        fs::remove_file(pa.join("aaaaaaaa-1111-4111-8111-111111111111.jsonl")).unwrap();
        let excluded = vec![real_path.to_string()];
        let s2 = aggregate_stats_ledger(&projects, &excluded, 0, &mut ledger);
        assert_eq!(s2.sessions, 0);
        assert!(s2.per_project.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    /// 台账落盘/回读往返
    #[test]
    fn stats_ledger_roundtrip_persistence() {
        let root = temp_root("ledger-io");
        let mut ledger = StatsLedger {
            tz_offset_minutes: 480,
            ..Default::default()
        };
        ledger.files.insert(
            "D:\\x\\a.jsonl".to_string(),
            LedgerEntry {
                mtime: 42,
                size: 7,
                session_id: "aaaaaaaa-1111-4111-8111-111111111111".to_string(),
                project_dir: "D--x".to_string(),
                project_name: "x".to_string(),
                project_path: "D:\\x".to_string(),
                messages: 3,
                tokens: 99,
                ..Default::default()
            },
        );
        save_ledger_to(&root, &ledger);
        let back = load_ledger_from(&root);
        assert_eq!(back.tz_offset_minutes, 480);
        assert_eq!(back.files.len(), 1);
        let e = back.files.get("D:\\x\\a.jsonl").unwrap();
        assert_eq!((e.mtime, e.size, e.tokens, e.messages), (42, 7, 99, 3));
        // 损坏的台账 → 空台账（不 panic）
        fs::write(ledger_path_in(&root), "{not-json").unwrap();
        assert_eq!(load_ledger_from(&root).files.len(), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn aggregate_stats_merges_projects_and_day_sessions() {
        let root = temp_root("stats-agg");
        let projects_dir = root.join("projects");
        let pa = projects_dir.join("D--work-alpha");
        let pb = projects_dir.join("D--work-beta");
        fs::create_dir_all(&pa).unwrap();
        fs::create_dir_all(&pb).unwrap();
        let line = |ts: &str, tokens: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"x"}}],"model":"claude-sonnet-4","usage":{{"input_tokens":{tokens},"output_tokens":1}}}},"timestamp":"{ts}","costUSD":0.001}}"#,
            )
        };
        // 项目 A 两个会话，同一天 → 当天活跃会话数 2
        fs::write(pa.join("11111111-1111-4111-8111-111111111111.jsonl"), line("2026-08-12T01:00:00.000Z", 100)).unwrap();
        fs::write(pa.join("22222222-2222-4222-8222-222222222222.jsonl"), line("2026-08-12T02:00:00.000Z", 200)).unwrap();
        // 项目 B 一个会话，另一天；外加一个非法文件名（应忽略）
        fs::write(pb.join("33333333-3333-4333-8333-333333333333.jsonl"), line("2026-08-13T01:00:00.000Z", 50)).unwrap();
        fs::write(pb.join("not-uuid.jsonl"), line("2026-08-13T01:00:00.000Z", 999)).unwrap();

        let projects = vec![
            ("alpha".to_string(), "D:\\work\\alpha".to_string(), pa.clone()),
            ("beta".to_string(), "D:\\work\\beta".to_string(), pb.clone()),
        ];
        let s = aggregate_stats_in(&projects, 0);
        assert_eq!(s.sessions, 3);
        assert_eq!(s.messages, 3);
        assert_eq!(s.tokens, 101 + 201 + 51); // (100+1) + (200+1) + (50+1)
        assert_eq!(s.earliest.as_deref(), Some("2026-08-12"));
        assert_eq!(s.latest.as_deref(), Some("2026-08-13"));
        // 当天活跃会话去重：08-12 = 2 个会话
        assert_eq!(s.per_day[0].date, "2026-08-12");
        assert_eq!(s.per_day[0].sessions, 2);
        assert_eq!(s.per_day[1].sessions, 1);
        // 项目排行按 token 倒序：alpha(202) 在 beta(51) 前
        assert_eq!(s.per_project.len(), 2);
        assert_eq!(s.per_project[0].name, "alpha");
        assert_eq!(s.per_project[0].sessions, 2);
        // 模型聚合跨项目
        assert_eq!(s.per_model.len(), 1);
        assert_eq!(s.per_model[0].model, "claude-sonnet-4");
        assert_eq!(s.per_model[0].messages, 3);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn iso_to_epoch_and_local_date_conversion() {
        // ISO → epoch：2026-08-17T00:00:00.000Z 是确定值（与 days_from_civil 对拍）
        let ms = iso_to_epoch_ms("2026-08-17T00:00:00.000Z").unwrap();
        assert_eq!(local_date_of(ms, 0), "2026-08-17");
        // UTC 0 点 +8h → 本地 8 点，同日
        assert_eq!(local_date_of(ms, 480), "2026-08-17");
        // UTC 16:30 +8h → 本地次日 00:30（跨天归属）
        let ms2 = iso_to_epoch_ms("2026-08-17T16:30:00.000Z").unwrap();
        assert_eq!(local_date_of(ms2, 0), "2026-08-17");
        assert_eq!(local_date_of(ms2, 480), "2026-08-18");
        // UTC 15:59 +8h → 本地 23:59，仍同日（边界）
        let ms3 = iso_to_epoch_ms("2026-08-17T15:59:59.999Z").unwrap();
        assert_eq!(local_date_of(ms3, 480), "2026-08-17");
        // 毫秒精度保留
        assert_eq!(ms3 % 1000, 999);
        // 非法输入
        assert!(iso_to_epoch_ms("not-a-timestamp").is_none());
        assert!(iso_to_epoch_ms("").is_none());
        // days_from_civil 与 civil_from_days 互逆（20_676 = 2026-08-11，见 civil_from_days_is_accurate）
        assert_eq!(days_from_civil(2026, 8, 17), 20_682);
        assert_eq!(civil_from_days(days_from_civil(2026, 8, 17)), (2026, 8, 17));
    }

    #[test]
    fn scan_file_usage_attributes_days_in_local_timezone() {
        // UTC 8/17 16:00 的消息：UTC 口径归 8/17，东八区口径归 8/18
        let jsonl = format!(
            "{}\n{}\n",
            r#"{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":100,"output_tokens":1}},"timestamp":"2026-08-17T16:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"msg_b","role":"assistant","content":[{"type":"text","text":"y"}],"usage":{"input_tokens":200,"output_tokens":2}},"timestamp":"2026-08-17T02:00:00.000Z"}"#,
        );
        let utc = scan_file_usage(&jsonl, 0);
        assert_eq!(utc.per_day.len(), 1);
        assert!(utc.per_day.contains_key("2026-08-17"));
        let cst = scan_file_usage(&jsonl, 480);
        assert_eq!(cst.per_day.len(), 2); // 02:00+8h=10:00 归 17 日；16:00+8h=次日 00:00 归 18 日
        assert!(cst.per_day.contains_key("2026-08-17"));
        assert!(cst.per_day.contains_key("2026-08-18"));
        assert_eq!(cst.per_day["2026-08-18"].0, 101); // 16:00 那条
        assert_eq!(cst.per_day["2026-08-17"].0, 202);
    }

    /// 拖拽排序持久化：按 ids 稳定重排、未提及 id 沉底、落盘对 load 可见
    #[test]
    fn provider_reorder_persists_order() {
        let root = temp_root("provider-reorder");
        fs::write(
            root.join("config.json"),
            r#"{"order":[],"dark":false,"providers":[
                {"id":"a","name":"A","settingsConfig":{}},
                {"id":"b","name":"B","settingsConfig":{}},
                {"id":"c","name":"C","settingsConfig":{}}],
                "currentProvider":"a"}"#,
        )
        .unwrap();

        // 整表重排 c→a→b，current 不受影响
        let ids = vec!["c".to_string(), "a".to_string(), "b".to_string()];
        let out = provider_reorder_from(&root, &root, &ids).unwrap();
        let order: Vec<String> = out.providers.iter().map(|p| p.id.clone()).collect();
        assert_eq!(order, vec!["c", "a", "b"]);
        assert_eq!(out.current_id.as_deref(), Some("a"));

        // 只提及 b：c/a 未提及 → 按当前相对顺序沉底；再读盘验证已持久化
        let ids2 = vec!["b".to_string()];
        let out2 = provider_reorder_from(&root, &root, &ids2).unwrap();
        let order2: Vec<String> = out2.providers.iter().map(|p| p.id.clone()).collect();
        assert_eq!(order2, vec!["b", "c", "a"]);
        let reread = provider_list_from(&root, &root);
        let order3: Vec<String> = reread.providers.iter().map(|p| p.id.clone()).collect();
        assert_eq!(order3, vec!["b", "c", "a"]);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 保存「当前供应商」必须同步写 live：否则磁盘 settings.json 仍是旧内容，
    /// 下次切换的回填（指纹一致即整文件吸收）会把旧 live 灌回清单，刚保存的
    /// 修改被静默回滚——Haiku 模型映射反复「自己变回去」的根源
    #[test]
    fn provider_save_current_syncs_live_settings() {
        let root = temp_root("provider-save-current");
        fs::write(
            root.join("config.json"),
            r#"{"order":[],"dark":false,"providers":[
                {"id":"a","name":"A","settingsConfig":{"env":{"ANTHROPIC_BASE_URL":"https://a.example","ANTHROPIC_AUTH_TOKEN":"sk-1","ANTHROPIC_DEFAULT_HAIKU_MODEL":"old-model"}}},
                {"id":"b","name":"B","settingsConfig":{}}],
                "currentProvider":"a"}"#,
        )
        .unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://a.example","ANTHROPIC_AUTH_TOKEN":"sk-1","ANTHROPIC_DEFAULT_HAIKU_MODEL":"old-model"}}"#,
        )
        .unwrap();

        let updated = serde_json::json!({
            "id": "a",
            "name": "A",
            "settingsConfig": { "env": {
                "ANTHROPIC_BASE_URL": "https://a.example",
                "ANTHROPIC_AUTH_TOKEN": "sk-1",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "new-model",
            }},
            "websiteUrl": null,
            "category": null,
        });
        let info: provider::ProviderInfo = serde_json::from_value(updated).unwrap();
        provider_save_from(&root, &root, info).unwrap();

        // live 已被同步为新配置；清单同样落盘
        let live: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            live["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            serde_json::json!("new-model")
        );
        let reread = provider_list_from(&root, &root);
        let a = reread.providers.iter().find(|p| p.id == "a").unwrap();
        assert_eq!(
            a.settings_config["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            serde_json::json!("new-model")
        );
        fs::remove_dir_all(&root).unwrap();
    }

    /// 保存非当前供应商不碰 live（它本就不在盘上），仅清单落盘
    #[test]
    fn provider_save_non_current_leaves_live_untouched() {
        let root = temp_root("provider-save-other");
        fs::write(
            root.join("config.json"),
            r#"{"order":[],"dark":false,"providers":[
                {"id":"a","name":"A","settingsConfig":{"env":{"ANTHROPIC_BASE_URL":"https://a.example"}}},
                {"id":"b","name":"B","settingsConfig":{}}],
                "currentProvider":"a"}"#,
        )
        .unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://a.example","TWEAKED":true}}"#,
        )
        .unwrap();

        provider_save_from(&root, &root, provider::ProviderInfo {
            id: "b".to_string(),
            name: "B".to_string(),
            settings_config: serde_json::json!({"env":{"ANTHROPIC_BASE_URL":"https://b.example"}}),
            website_url: None,
            category: None,
        })
        .unwrap();

        let live: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("settings.json")).unwrap()).unwrap();
        assert_eq!(live["env"]["TWEAKED"], serde_json::json!(true));
        assert_eq!(
            live["env"]["ANTHROPIC_BASE_URL"],
            serde_json::json!("https://a.example")
        );
        fs::remove_dir_all(&root).unwrap();
    }
}

/// 退出程序（托盘菜单/前端调用；绕过关闭拦截直接退出）
/// 当前平台是否支持开机自启动（官方 tauri-plugin-autostart 支持 Windows / macOS / Linux，
/// 前端据此决定是否显示「开机自启动」设置项；未来某平台不支持时只需改这一处）。
#[tauri::command]
fn autostart_supported() -> bool {
    cfg!(any(windows, target_os = "macos", target_os = "linux"))
}

/// 把主窗口显示到最前台（托盘「显示窗口」菜单 / 托盘左键点击 / 单实例回调共用）。
/// Windows 前台锁定：进程不占前台时 SetFocus 可能被忽略；先强制置顶再取消，
/// 确保窗口真正浮到最前（隐藏到托盘后点托盘图标恢复时必经此路径）。
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();        // 隐藏状态 → 显示
        let _ = w.unminimize();  // 最小化状态 → 恢复
        let _ = w.set_focus();
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 开机自启动：Windows 写注册表 Run 项 / macOS 用 LaunchAgent（两端均支持）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // 单实例：再次启动时不再新建进程，而是把已有主窗口调到前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            // 旧脚本清单一次性迁移（去脚本化）：解析 scripts/ 旧脚本生成
            // config.projects / config.order（路径），幂等
            ensure_projects_migrated();

            let show_i = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude助手")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            check_projects,
            load_config,
            save_config,
            add_project,
            remove_project,
            launch_project,
            open_folder,
            check_claude,
            claude_update_status,
            claude_run_upgrade,
            scan_claude_projects,
            get_claude_projects_dir,
            purge_claude_project_data,
            provider_list,
            provider_save,
            provider_delete,
            provider_reorder,
            provider_switch,
            provider_import_ccswitch,
            provider_read_live,
            fetch_models_for_config,
            provider_query_usage,
            open_url,
            list_sessions,
            list_pinned_sessions,
            rename_session,
            delete_session,
            list_trashed_sessions,
            restore_session,
            purge_session,
            purge_trash,
            get_session_messages,
            get_session_user_prompts,
            search_session_messages,
            export_session,
            get_usage_stats,
            resume_session,
            get_data_root,
            autostart_supported,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
