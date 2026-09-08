//! Claude Code 供应商配置切换——移植自 cc-switch v3.20.1 的最小核心语义：
//! 切换 = 回填离任供应商（吸收 live 手工修改）→ 记 current → sanitize 后整文件
//! 原子替换 ~/.claude/settings.json。不含代理接管 / 多 App / Profile / MCP 同步。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------- 数据模型 ----------------

/// 供应商条目。settingsConfig 即切换时整文件写入 settings.json 的内容
/// （核心是 env.ANTHROPIC_BASE_URL / env.ANTHROPIC_AUTH_TOKEN）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub settings_config: Value,
    #[serde(default)]
    pub website_url: Option<String>,
    /// official / cn_official / third_party / aggregator / custom
    #[serde(default)]
    pub category: Option<String>,
}

// ---------------- 路径解析 ----------------

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
}

/// 用户级 Claude 配置目录：CLAUDE_CONFIG_DIR 优先，否则 ~/.claude
pub fn claude_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = dir.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    home_dir().join(".claude")
}

/// live settings 文件路径：settings.json 优先，遗留 claude.json 存在时回退，
/// 都不存在时默认 settings.json（切换时创建）——cc-switch config.rs 同款语义
pub fn claude_settings_path_from(config_dir: &Path) -> PathBuf {
    let settings = config_dir.join("settings.json");
    if settings.exists() {
        return settings;
    }
    let legacy = config_dir.join("claude.json");
    if legacy.exists() {
        return legacy;
    }
    settings
}

// ---------------- 读写 ----------------

fn read_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(crate::strip_bom(&raw)).ok()
}

/// 净化：仅移除 cc-switch 存储层的内部顶层键（sanitize_claude_settings_for_live 同款）
pub fn sanitize_claude_settings(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(obj) = value.as_object_mut() {
        for key in [
            "apiFormat",
            "api_format",
            "openrouterCompatMode",
            "openrouter_compat_mode",
        ] {
            obj.remove(key);
        }
    }
    value
}

/// 原子写 JSON：写 .tmp → 旧文件备份 .bak → rename（与 save_config_to 同款三步保护，
/// 切换前的 settings.json 因此总有一份 .bak 可手工恢复）
pub fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let mut tmp_name = path
        .file_name()
        .map(|n| n.to_os_string())
        .ok_or_else(|| "无效路径".to_string())?;
    tmp_name.push(".tmp");
    let tmp_path = path.with_file_name(&tmp_name);
    let mut bak_name = path
        .file_name()
        .map(|n| n.to_os_string())
        .ok_or_else(|| "无效路径".to_string())?;
    bak_name.push(".bak");
    let bak_path = path.with_file_name(&bak_name);
    fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::copy(path, &bak_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, path).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------- 首启导入 / live 读取 ----------------

/// 首启导入：providers 为空时把 live 配置整文件收编为 default 供应商
/// （cc-switch import_default_config 的 Claude 分支：不拆 env，整份保留）
pub fn import_default_from(config_dir: &Path) -> Option<ProviderInfo> {
    let value = read_json_file(&claude_settings_path_from(config_dir))?;
    Some(ProviderInfo {
        id: "default".to_string(),
        name: "default".to_string(),
        settings_config: value,
        website_url: None,
        category: Some("custom".to_string()),
    })
}

/// 读取 live 配置（供表单「从当前配置导入」）
pub fn read_live_settings(config_dir: &Path) -> Option<Value> {
    read_json_file(&claude_settings_path_from(config_dir))
}

// ---------------- 切换 ----------------

/// 供应商身份指纹：env 里的 baseURL + 凭证（AUTH_TOKEN 优先，回退 API_KEY）。
/// 回填守卫的判定依据——live 只有仍属于离任供应商（指纹一致）才允许吸收，
/// None = 无 env/baseURL 等无法判定的情况（维持原语义）
fn env_fingerprint(value: &Value) -> Option<(String, Option<String>)> {
    let env = value.get("env")?;
    let base = env.get("ANTHROPIC_BASE_URL")?.as_str()?;
    let cred = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .or_else(|| env.get("ANTHROPIC_API_KEY"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((base.to_string(), cred))
}

/// 切换核心（cc-switch ProviderService::switch_normal 的 Claude 最小语义，顺序一致）：
/// 1) 回填：live 整文件写回离任供应商（用户在 Claude Code 里的手工修改不丢失；
///    live 缺失/损坏仅告警不阻塞）；切给自己时不回填（与上游一致）；
///    live 指纹与离任条目不符时跳过回填仅告警——current 标记可能与磁盘脱节
///    （外部工具改写 settings.json、导入采纳 is_current 不写盘等），照常吸收会
///    把别家配置静默灌进离任条目
/// 2) current 指向目标（先记后写，写失败时 current 已指向新供应商，与上游一致）
/// 3) sanitize 后整文件原子替换 live
pub fn switch_provider_from(
    config_dir: &Path,
    providers: &mut Vec<ProviderInfo>,
    current_id: &mut Option<String>,
    target_id: &str,
) -> Result<Vec<String>, String> {
    let target = providers
        .iter()
        .find(|p| p.id == target_id)
        .ok_or_else(|| format!("供应商 {target_id} 不存在"))?
        .clone();
    let mut warnings = Vec::new();
    let path = claude_settings_path_from(config_dir);

    if current_id.as_deref() != Some(target_id) {
        if let Some(cur) = current_id.clone() {
            if let Some(slot) = providers.iter_mut().find(|p| p.id == cur) {
                match read_json_file(&path) {
                    Some(live) => {
                        match (
                            env_fingerprint(&live),
                            env_fingerprint(&slot.settings_config),
                        ) {
                            // 两侧指纹可判定且不一致 = live 已不属于离任供应商
                            (Some(live_fp), Some(slot_fp)) if live_fp != slot_fp => {
                                warnings.push(format!("backfill_skipped:{cur}"));
                            }
                            // 指纹一致（吸收手工修改）或无法判定（无 env 等退化情况），
                            // 维持上游原语义
                            _ => slot.settings_config = live,
                        }
                    }
                    None => warnings.push(format!("backfill_failed:{cur}")),
                }
            }
        }
    }

    *current_id = Some(target_id.to_string());
    write_json_atomic(&path, &sanitize_claude_settings(&target.settings_config))?;
    Ok(warnings)
}

/// 标记重锚定：live 与唯一条目 sanitize 后完全一致而 current 指向别人时，
/// 以磁盘为准修正 current——外部工具改写 settings.json 的自愈，保证「当前」
/// 徽标不失真、下次切换的回填对象正确。0 个匹配（live 有手工改动）或多个匹配
/// （重复条目）时保持原状。返回是否修正（由调用方决定落盘）。
pub fn reanchor_current_from(
    config_dir: &Path,
    providers: &[ProviderInfo],
    current_id: &mut Option<String>,
) -> bool {
    let live = match read_json_file(&claude_settings_path_from(config_dir)) {
        Some(v) => v,
        None => return false,
    };
    // 与 live 写盘路径对称：条目侧也过 sanitize，避免内部键差异造成漏配
    let mut matched = providers
        .iter()
        .filter(|p| sanitize_claude_settings(&p.settings_config) == live);
    match (matched.next(), matched.next()) {
        (Some(only), None) => {
            if current_id.as_deref() == Some(only.id.as_str()) {
                return false;
            }
            *current_id = Some(only.id.clone());
            true
        }
        _ => false,
    }
}

// ---------------- CC Switch SQL 备份导入 ----------------
//
// CC Switch「导出配置」生成 SQLite 通用 SQL 文本（其 database/backup.rs）：
// `INSERT INTO "providers" ("id", "app_type", ...) VALUES (...), (...);` 多行批量；
// 字符串单引号包裹、内部 ' 翻倍转义；无法安全入文的 TEXT 用 CAST(x'..' AS TEXT)。
// 定向解析：按列名取值（不怕列序/列数变化），仅取 app_type='claude' 的行。

#[derive(Debug, Clone, PartialEq)]
enum SqlVal {
    Str(String),
    Int(i64),
    Null,
    /// CAST(x'..' AS TEXT)：文本含 NUL 等不可入文字符，JSON 场景不会出现，跳过该行
    Opaque,
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] as char).is_whitespace() {
        i += 1;
    }
    i
}

fn find_sub(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// 解析单引号 SQL 字符串（'' 转义），返回 (内容, 结束位置)
fn parse_sql_string(b: &[u8], start: usize) -> Option<(String, usize)> {
    if b.get(start) != Some(&b'\'') {
        return None;
    }
    let mut out = String::new();
    let mut j = start + 1;
    let mut seg = j;
    loop {
        match b.get(j) {
            Some(b'\'') => {
                if b.get(j + 1) == Some(&b'\'') {
                    out.push_str(&String::from_utf8_lossy(&b[seg..j]));
                    out.push('\'');
                    j += 2;
                    seg = j;
                } else {
                    out.push_str(&String::from_utf8_lossy(&b[seg..j]));
                    return Some((out, j + 1));
                }
            }
            Some(_) => j += 1,
            None => return None,
        }
    }
}

/// 解析 CAST(x'..' AS TEXT)，返回结束位置
fn parse_sql_cast(b: &[u8], start: usize) -> Option<usize> {
    const HEAD: &[u8] = b"CAST(";
    if !b
        .get(start..start + HEAD.len())?
        .eq_ignore_ascii_case(HEAD)
    {
        return None;
    }
    let mut j = start + HEAD.len();
    j = skip_ws(b, j);
    // x'..' 十六进制字面量
    match b.get(j) {
        Some(c) if *c == b'x' || *c == b'X' => j += 1,
        _ => return None,
    }
    let (_, after) = parse_sql_string(b, j)?;
    j = skip_ws(b, after);
    const TAIL: &[u8] = b"AS TEXT)";
    if !b.get(j..j + TAIL.len())?.eq_ignore_ascii_case(TAIL) {
        return None;
    }
    Some(j + TAIL.len())
}

/// 解析单个 SQL 值，返回 (值, 结束位置)
fn parse_sql_value(b: &[u8], start: usize) -> Option<(SqlVal, usize)> {
    let i = skip_ws(b, start);
    match b.get(i)? {
        b'\'' => {
            let (s, j) = parse_sql_string(b, i)?;
            Some((SqlVal::Str(s), j))
        }
        b'C' | b'c' => {
            let j = parse_sql_cast(b, i)?;
            Some((SqlVal::Opaque, j))
        }
        _ => {
            if b.len() - i >= 4 && b[i..i + 4].eq_ignore_ascii_case(b"NULL") {
                return Some((SqlVal::Null, i + 4));
            }
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_digit() || matches!(b[j], b'-' | b'.')) {
                j += 1;
            }
            if j == i {
                return None;
            }
            let s = std::str::from_utf8(&b[i..j]).ok()?;
            Some((SqlVal::Int(s.parse().ok()?), j))
        }
    }
}

/// 解析双引号/裸标识符，返回 (标识符, 结束位置)
fn parse_sql_ident(b: &[u8], start: usize) -> Option<(String, usize)> {
    let i = skip_ws(b, start);
    if b.get(i) == Some(&b'"') {
        let end = b[i + 1..].iter().position(|&c| c == b'"')? + i + 1;
        return Some((String::from_utf8_lossy(&b[i + 1..end]).into_owned(), end + 1));
    }
    let mut j = i;
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
        j += 1;
    }
    if j == i {
        return None;
    }
    Some((String::from_utf8_lossy(&b[i..j]).into_owned(), j))
}

/// 解析结果：(claude 供应商列表（同 id 去重）, 备份标记 is_current 的 id, 告警)
pub fn parse_ccswitch_sql(text: &str) -> (Vec<ProviderInfo>, Option<String>, Vec<String>) {
    let b = text.as_bytes();
    let mut providers = Vec::new();
    let mut current_id: Option<String> = None;
    let mut warnings: Vec<String> = Vec::new();
    let mut i = 0usize;

    'stmts: while let Some(off) = find_sub(b, i, b"INSERT INTO") {
        i = off + b"INSERT INTO".len();
        let (table, j) = match parse_sql_ident(b, i) {
            Some(v) => v,
            None => break,
        };
        i = j;
        if table != "providers" {
            continue; // 非 providers 表不消费语句体，靠下一个 INSERT 定位
        }
        // 列清单 (a, b, ...)
        i = skip_ws(b, i);
        if b.get(i) != Some(&b'(') {
            continue;
        }
        i += 1;
        let mut columns: Vec<String> = Vec::new();
        loop {
            match parse_sql_ident(b, i) {
                Some((col, j)) => {
                    columns.push(col);
                    i = j;
                }
                None => continue 'stmts,
            }
            i = skip_ws(b, i);
            match b.get(i) {
                Some(b',') => i += 1,
                Some(b')') => {
                    i += 1;
                    break;
                }
                _ => continue 'stmts,
            }
        }
        // VALUES 关键字
        i = skip_ws(b, i);
        if !b.get(i..).map_or(false, |rest| {
            rest.len() >= 6 && rest[..6].eq_ignore_ascii_case(b"VALUES")
        }) {
            continue;
        }
        i += 6;
        // 元组序列 (...), (...);
        loop {
            i = skip_ws(b, i);
            if b.get(i) != Some(&b'(') {
                break;
            }
            i += 1;
            let mut values: Vec<SqlVal> = Vec::new();
            loop {
                match parse_sql_value(b, i) {
                    Some((v, j)) => {
                        values.push(v);
                        i = j;
                    }
                    None => continue 'stmts,
                }
                i = skip_ws(b, i);
                match b.get(i) {
                    Some(b',') => i += 1,
                    Some(b')') => {
                        i += 1;
                        break;
                    }
                    _ => continue 'stmts,
                }
            }
            handle_sql_row(&columns, &values, &mut providers, &mut current_id, &mut warnings);
            i = skip_ws(b, i);
            match b.get(i) {
                Some(b',') => i += 1,
                Some(b';') => {
                    i += 1;
                    break;
                }
                _ => break,
            }
        }
    }
    (providers, current_id, warnings)
}

fn handle_sql_row(
    columns: &[String],
    values: &[SqlVal],
    providers: &mut Vec<ProviderInfo>,
    current_id: &mut Option<String>,
    warnings: &mut Vec<String>,
) {
    let get = |name: &str| {
        columns
            .iter()
            .position(|c| c == name)
            .and_then(|idx| values.get(idx))
    };
    match get("app_type") {
        Some(SqlVal::Str(s)) if s == "claude" => {}
        _ => return, // Codex / Gemini 等其它 App 的行不导入
    }
    let (id, name) = match (get("id"), get("name")) {
        (Some(SqlVal::Str(id)), Some(SqlVal::Str(name))) if !id.is_empty() => {
            (id.clone(), name.clone())
        }
        _ => {
            warnings.push("跳过 1 行：id/name 缺失".to_string());
            return;
        }
    };
    let settings = match get("settings_config") {
        Some(SqlVal::Str(s)) => match serde_json::from_str::<Value>(s) {
            Ok(v) => v,
            Err(_) => {
                warnings.push(format!("跳过「{name}」：settings_config 不是合法 JSON"));
                return;
            }
        },
        _ => {
            warnings.push(format!(
                "跳过「{name}」：settings_config 含无法入文的二进制值"
            ));
            return;
        }
    };
    if providers.iter().any(|p| p.id == id) {
        return; // 同一批次内按 id 去重
    }
    let website_url = match get("website_url") {
        Some(SqlVal::Str(s)) => Some(s.clone()),
        _ => None,
    };
    let category = match get("category") {
        Some(SqlVal::Str(s)) => Some(s.clone()),
        _ => None,
    };
    if matches!(get("is_current"), Some(SqlVal::Int(1))) {
        *current_id = Some(id.clone());
    }
    providers.push(ProviderInfo {
        id,
        name,
        settings_config: settings,
        website_url,
        category,
    });
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!(
            "claude-fast-provider-{}-{}-{n}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn provider(id: &str, base_url: &str) -> ProviderInfo {
        ProviderInfo {
            id: id.to_string(),
            name: id.to_string(),
            settings_config: json!({ "env": { "ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": "sk-1" } }),
            website_url: None,
            category: None,
        }
    }

    // ---------------- 路径解析 ----------------

    #[test]
    fn settings_path_prefers_settings_json() {
        let dir = temp_dir("path-pref");
        fs::write(dir.join("settings.json"), "{}").unwrap();
        fs::write(dir.join("claude.json"), "{}").unwrap();
        assert_eq!(
            claude_settings_path_from(&dir),
            dir.join("settings.json")
        );
    }

    #[test]
    fn settings_path_falls_back_to_legacy_claude_json() {
        let dir = temp_dir("path-legacy");
        fs::write(dir.join("claude.json"), "{}").unwrap();
        assert_eq!(claude_settings_path_from(&dir), dir.join("claude.json"));
    }

    #[test]
    fn settings_path_defaults_to_settings_json_when_missing() {
        let dir = temp_dir("path-missing");
        assert_eq!(
            claude_settings_path_from(&dir),
            dir.join("settings.json")
        );
    }

    // ---------------- sanitize ----------------

    #[test]
    fn sanitize_removes_only_internal_keys() {
        let v = json!({
            "apiFormat": "openai_chat",
            "api_format": "x",
            "openrouterCompatMode": true,
            "openrouter_compat_mode": true,
            "env": { "ANTHROPIC_BASE_URL": "https://x" },
            "permissions": { "defaultMode": "acceptEdits" }
        });
        let out = sanitize_claude_settings(&v);
        let obj = out.as_object().unwrap();
        assert!(!obj.contains_key("apiFormat"));
        assert!(!obj.contains_key("api_format"));
        assert!(!obj.contains_key("openrouterCompatMode"));
        assert!(!obj.contains_key("openrouter_compat_mode"));
        assert!(obj.contains_key("env"));
        assert!(obj.contains_key("permissions"));
    }

    // ---------------- 首启导入 ----------------

    #[test]
    fn import_default_absorbs_whole_live_file() {
        let dir = temp_dir("import");
        fs::write(
            dir.join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://relay.example"},"permissions":{"allow":["Bash"]}}"#,
        )
        .unwrap();
        let p = import_default_from(&dir).expect("应导入 default");
        assert_eq!(p.id, "default");
        assert_eq!(p.category.as_deref(), Some("custom"));
        assert_eq!(
            p.settings_config["permissions"]["allow"][0],
            json!("Bash")
        );
    }

    #[test]
    fn import_default_returns_none_when_live_missing() {
        let dir = temp_dir("import-missing");
        assert!(import_default_from(&dir).is_none());
    }

    // ---------------- 切换 ----------------

    #[test]
    fn switch_writes_target_and_backfills_outgoing() {
        let dir = temp_dir("switch");
        let path = dir.join("settings.json");
        // live 当前是 old 的配置（指纹一致），且用户在 Claude Code 里手工加过 permissions
        fs::write(
            &path,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://old.example","ANTHROPIC_AUTH_TOKEN":"sk-1"},"permissions":{"defaultMode":"acceptEdits"}}"#,
        )
        .unwrap();
        let old = provider("old", "https://old.example");
        let new = provider("new", "https://new.example");
        let mut providers = vec![old, new];
        let mut current = Some("old".to_string());

        let warnings =
            switch_provider_from(&dir, &mut providers, &mut current, "new").unwrap();
        assert!(warnings.is_empty());
        assert_eq!(current.as_deref(), Some("new"));

        // live 整文件 = 目标供应商配置
        let live: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(live["env"]["ANTHROPIC_BASE_URL"], json!("https://new.example"));

        // 离任供应商吸收了 live 里的手工修改（permissions 被回填）
        let old_slot = providers.iter().find(|p| p.id == "old").unwrap();
        assert_eq!(
            old_slot.settings_config["permissions"]["defaultMode"],
            json!("acceptEdits")
        );
    }

    #[test]
    fn switch_preserves_non_env_keys_from_target_config() {
        let dir = temp_dir("switch-keep");
        let mut new = provider("new", "https://new.example");
        new.settings_config["model"] = json!("claude-opus-4-6");
        new.settings_config["permissions"] = json!({ "allow": ["Bash(npm:*)" ] });
        let mut providers = vec![provider("old", "https://old.example"), new];
        let mut current = Some("old".to_string());
        switch_provider_from(&dir, &mut providers, &mut current, "new").unwrap();

        let live: Value =
            serde_json::from_slice(&fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(live["model"], json!("claude-opus-4-6"));
        assert_eq!(live["permissions"]["allow"][0], json!("Bash(npm:*)"));
    }

    #[test]
    fn switch_missing_target_errors() {
        let dir = temp_dir("switch-missing");
        let mut providers = vec![provider("old", "https://old.example")];
        let mut current = Some("old".to_string());
        let err = switch_provider_from(&dir, &mut providers, &mut current, "ghost");
        assert!(err.is_err());
        assert!(!dir.join("settings.json").exists());
    }

    #[test]
    fn switch_backfill_warning_when_live_missing() {
        let dir = temp_dir("switch-nolive");
        let mut providers = vec![provider("old", "https://old.example"), provider("new", "u")];
        let mut current = Some("old".to_string());
        let warnings =
            switch_provider_from(&dir, &mut providers, &mut current, "new").unwrap();
        assert_eq!(warnings, vec!["backfill_failed:old".to_string()]);
        // 告警不阻塞：live 仍写入、current 仍指向新供应商
        assert_eq!(current.as_deref(), Some("new"));
        assert!(dir.join("settings.json").exists());
    }

    #[test]
    fn switch_to_self_rewrites_stored_config_without_backfill() {
        let dir = temp_dir("switch-self");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"env":{"ANTHROPIC_BASE_URL":"https://old.example"},"hacked":true}"#)
            .unwrap();
        let old = provider("old", "https://old.example");
        let stored = old.settings_config.clone();
        let mut providers = vec![old];
        let mut current = Some("old".to_string());
        let warnings =
            switch_provider_from(&dir, &mut providers, &mut current, "old").unwrap();
        assert!(warnings.is_empty());
        // 与上游一致：切给自己不回填，live 被存储配置整文件覆盖
        let live: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(live, stored);
        assert!(live.get("hacked").is_none());
    }

    #[test]
    fn switch_creates_bak_of_previous_live() {
        let dir = temp_dir("switch-bak");
        fs::write(dir.join("settings.json"), r#"{"env":{}}"#).unwrap();
        let mut providers = vec![provider("old", "u1"), provider("new", "u2")];
        let mut current = Some("old".to_string());
        switch_provider_from(&dir, &mut providers, &mut current, "new").unwrap();
        let bak: Value =
            serde_json::from_slice(&fs::read(dir.join("settings.json.bak")).unwrap()).unwrap();
        assert_eq!(bak["env"], json!({}));
    }

    #[test]
    fn switch_skips_backfill_when_live_belongs_elsewhere() {
        // 标记脱节：current 指向 old，但 live 已被外部工具（CC Switch 等）写成别家配置
        let dir = temp_dir("switch-stale");
        let path = dir.join("settings.json");
        fs::write(
            &path,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://other.example","ANTHROPIC_AUTH_TOKEN":"sk-other"},"permissions":{"defaultMode":"acceptEdits"}}"#,
        )
        .unwrap();
        let old = provider("old", "https://old.example");
        let old_stored = old.settings_config.clone();
        let mut providers = vec![old, provider("new", "https://new.example")];
        let mut current = Some("old".to_string());

        let warnings =
            switch_provider_from(&dir, &mut providers, &mut current, "new").unwrap();
        assert_eq!(warnings, vec!["backfill_skipped:old".to_string()]);

        // 离任条目保持原配置不被别家内容覆盖
        let old_slot = providers.iter().find(|p| p.id == "old").unwrap();
        assert_eq!(old_slot.settings_config, old_stored);
        // 切换本身照常完成
        assert_eq!(current.as_deref(), Some("new"));
        let live: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            live["env"]["ANTHROPIC_BASE_URL"],
            json!("https://new.example")
        );
    }

    #[test]
    fn switch_backfill_accepts_api_key_fingerprint() {
        // OpenCode Go 类条目用 ANTHROPIC_API_KEY：指纹回退到 API_KEY，一致时照常吸收
        let dir = temp_dir("switch-apikey");
        let path = dir.join("settings.json");
        fs::write(
            &path,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://old.example","ANTHROPIC_API_KEY":"sk-1"},"permissions":{"allow":["Bash"]}}"#,
        )
        .unwrap();
        let mut old = provider("old", "https://old.example");
        let env = old.settings_config["env"].as_object_mut().unwrap();
        env.remove("ANTHROPIC_AUTH_TOKEN");
        env.insert("ANTHROPIC_API_KEY".to_string(), json!("sk-1"));
        let mut providers = vec![old, provider("new", "https://new.example")];
        let mut current = Some("old".to_string());

        let warnings =
            switch_provider_from(&dir, &mut providers, &mut current, "new").unwrap();
        assert!(warnings.is_empty());
        let old_slot = providers.iter().find(|p| p.id == "old").unwrap();
        assert_eq!(
            old_slot.settings_config["permissions"]["allow"][0],
            json!("Bash")
        );
    }

    // ---------------- 标记重锚定 ----------------

    #[test]
    fn reanchor_updates_current_when_live_matches_other_entry() {
        let dir = temp_dir("reanchor");
        let mut b = provider("b", "https://b.example");
        // 条目带内部键：live 落盘时被 sanitize 剥掉，重锚定按 sanitize 后比对仍应命中
        b.settings_config["apiFormat"] = json!("openai_chat");
        b.settings_config["permissions"] = json!({ "defaultMode": "bypassPermissions" });
        let providers = vec![provider("a", "https://a.example"), b];
        // 外部工具把 live 写成了 b 的内容（sanitize 后）
        write_json_atomic(
            &dir.join("settings.json"),
            &sanitize_claude_settings(&providers[1].settings_config),
        )
        .unwrap();
        let mut current = Some("a".to_string());

        assert!(reanchor_current_from(&dir, &providers, &mut current));
        assert_eq!(current.as_deref(), Some("b"));
    }

    #[test]
    fn reanchor_keeps_current_when_live_unmatched_or_ambiguous() {
        let dir = temp_dir("reanchor-skip");
        let providers = vec![
            provider("a", "https://a.example"),
            provider("b", "https://b.example"),
        ];
        // live 有手工改动，不与任何条目一致 → 保持原状
        fs::write(
            dir.join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://a.example","ANTHROPIC_AUTH_TOKEN":"sk-1"},"tweaked":true}"#,
        )
        .unwrap();
        let mut current = Some("a".to_string());
        assert!(!reanchor_current_from(&dir, &providers, &mut current));
        assert_eq!(current.as_deref(), Some("a"));

        // live 已是当前条目内容 → 无需修正
        write_json_atomic(
            &dir.join("settings.json"),
            &sanitize_claude_settings(&providers[0].settings_config),
        )
        .unwrap();
        assert!(!reanchor_current_from(&dir, &providers, &mut current));
        assert_eq!(current.as_deref(), Some("a"));
    }

    #[test]
    fn reanchor_ignores_missing_live() {
        let dir = temp_dir("reanchor-nolive");
        let providers = vec![provider("a", "https://a.example")];
        let mut current = Some("a".to_string());
        assert!(!reanchor_current_from(&dir, &providers, &mut current));
        assert_eq!(current.as_deref(), Some("a"));
    }

    // ---------------- SQL 备份解析 ----------------

    #[test]
    fn parse_sql_basic_batch_with_escape_and_filter() {
        // 多行 VALUES + '' 转义 + app_type 过滤 + NULL 列
        let sql = r#"BEGIN TRANSACTION;
INSERT INTO "providers" ("id", "app_type", "name", "settings_config", "website_url", "category", "is_current") VALUES
('p1', 'claude', 'Kimi 中转', '{"env":{"ANTHROPIC_BASE_URL":"https://api.moonshot.cn/anthropic"}}', 'https://kimi.com', 'cn_official', 1),
('p2', 'codex', '不该出现', '{}', NULL, NULL, 0),
('p3', 'claude', 'It''s 官方', '{"env":{}}', NULL, 'official', 0);
COMMIT;"#;
        let (providers, current, warnings) = parse_ccswitch_sql(sql);
        assert_eq!(providers.len(), 2, "codex 行应被过滤");
        assert_eq!(providers[0].id, "p1");
        assert_eq!(providers[0].name, "Kimi 中转");
        assert_eq!(
            providers[0].settings_config["env"]["ANTHROPIC_BASE_URL"],
            json!("https://api.moonshot.cn/anthropic")
        );
        assert_eq!(providers[0].website_url.as_deref(), Some("https://kimi.com"));
        assert_eq!(providers[1].name, "It's 官方");
        assert_eq!(current.as_deref(), Some("p1"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_sql_handles_column_order_and_extra_columns() {
        let sql = r#"INSERT INTO "providers" ("meta", "sort_index", "name", "app_type", "settings_config", "id") VALUES ('{}', 3, 'B', 'claude', '{"env":{}}', 'pb'), ('{}', 1, 'A', 'claude', '{"env":{}}', 'pa');"#;
        let (providers, current, _) = parse_ccswitch_sql(sql);
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "pb"); // 按列名取值，与列序无关
        assert_eq!(current, None);
    }

    #[test]
    fn parse_sql_skips_cast_blob_rows_with_warning() {
        let sql = "INSERT INTO \"providers\" (\"id\", \"app_type\", \"name\", \"settings_config\") VALUES ('bad', 'claude', '二进制', CAST(x'7B00FF' AS TEXT)), ('ok', 'claude', '正常', '{}');";
        let (providers, _, warnings) = parse_ccswitch_sql(sql);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "ok");
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn parse_sql_ignores_other_tables_and_keeps_scanning() {
        let sql = r#"INSERT INTO "mcp_servers" ("id", "name", "server_config") VALUES ('m1', 'x', '{}');
INSERT INTO "providers" ("id", "app_type", "name", "settings_config") VALUES ('only', 'claude', '唯一', '{"env":{}}');"#;
        let (providers, _, warnings) = parse_ccswitch_sql(sql);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "only");
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_sql_dedupes_same_id_and_values_parens_in_strings() {
        // 字符串值里含 ')' 与 'INSERT INTO' 文本，不得干扰解析
        let sql = "INSERT INTO \"providers\" (\"id\", \"app_type\", \"name\", \"settings_config\") VALUES ('dup', 'claude', '名字 (v2) INSERT INTO 伪造', '{}'), ('dup', 'claude', '重复', '{}');";
        let (providers, _, warnings) = parse_ccswitch_sql(sql);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name, "名字 (v2) INSERT INTO 伪造");
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_sql_garbage_returns_empty() {
        let (providers, current, _) = parse_ccswitch_sql("这不是 SQL 备份 {随机文本}");
        assert!(providers.is_empty());
        assert_eq!(current, None);
    }
}
