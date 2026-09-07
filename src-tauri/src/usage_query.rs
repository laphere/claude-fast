//! Coding Plan 套餐用量查询——移植自 cc-switch services/coding_plan.rs 的
//! 五个厂商适配器（Kimi / 智谱 GLM / MiniMax / ZenMux / OpenCode Go）。
//! 凭据从供应商配置的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 现场取，
//! base_url 命中即查，无需 per-provider 配置。解析函数为纯函数、fixture 可测。

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

const QUERY_TIMEOUT_SECS: u64 = 15;

/// 单个用量窗口（如 5 小时 / 每周）。utilization 为 0-100 的已用百分比。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageTier {
    /// five_hour / weekly_limit / monthly
    pub name: String,
    pub utilization: f64,
    /// ISO 8601；None = 不展示倒计时
    pub resets_at: Option<String>,
    pub used_value_usd: Option<f64>,
    pub max_value_usd: Option<f64>,
}

/// 查询结果。supported=false 表示该供应商不在已知厂商列表（前端静默不显示）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageResult {
    pub success: bool,
    pub supported: bool,
    pub vendor: Option<String>,
    pub data: Vec<UsageTier>,
    pub error: Option<String>,
}

impl UsageResult {
    pub fn unsupported() -> Self {
        Self {
            success: false,
            supported: false,
            vendor: None,
            data: vec![],
            error: None,
        }
    }

    fn ok(vendor: &str, tiers: Vec<UsageTier>) -> Self {
        Self {
            success: true,
            supported: true,
            vendor: Some(vendor.to_string()),
            data: tiers,
            error: None,
        }
    }

    fn err(vendor: &str, msg: String) -> Self {
        Self {
            success: false,
            supported: true,
            vendor: Some(vendor.to_string()),
            data: vec![],
            error: Some(msg),
        }
    }
}

/// 探测 base_url 属于哪家 Coding Plan 厂商（与 cc-switch detect_provider 同款规则）
pub fn detect_vendor(base_url: &str) -> Option<&'static str> {
    let url = base_url.to_lowercase();
    if url.contains("api.kimi.com/coding") {
        Some("kimi")
    } else if url.contains("bigmodel.cn") || url.contains("api.z.ai") {
        Some("zhipu")
    } else if url.contains("api.minimaxi.com") || url.contains("api.minimax.io") {
        Some("minimax")
    } else if url.contains("zenmux") {
        Some("zenmux")
    } else if url.contains("opencode.ai/zen/go") {
        Some("opencode_go")
    } else {
        None
    }
}

/// 查询入口：探测厂商 → 走对应适配器
pub fn query_usage(base_url: &str, api_key: &str) -> UsageResult {
    let Some(vendor) = detect_vendor(base_url) else {
        return UsageResult::unsupported();
    };
    let result = match vendor {
        "kimi" => query_kimi(api_key),
        "zhipu" => query_zhipu(base_url, api_key),
        "minimax" => query_minimax(api_key, base_url.to_lowercase().contains("minimaxi.com")),
        "zenmux" => query_zenmux(base_url, api_key),
        "opencode_go" => query_opencode_go(api_key),
        _ => unreachable!(),
    };
    match result {
        Ok(tiers) if tiers.is_empty() => UsageResult::err(vendor, "响应形态不认识".to_string()),
        Ok(tiers) => UsageResult::ok(vendor, tiers),
        Err(e) => UsageResult::err(vendor, e),
    }
}

// ---------------- HTTP ----------------

/// GET JSON：401/403 单独报认证失败；其余状态码/网络错误原样带回。
fn http_get_json(url: &str, headers: &[(&str, &str)]) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(QUERY_TIMEOUT_SECS))
        .build();
    let mut req = agent.get(url).set("Accept", "application/json");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    let resp = req.call().map_err(|e| match e {
        ureq::Error::Status(code, r) => {
            if code == 401 || code == 403 {
                format!("认证失败 (HTTP {code})：API Key 无效或无权限")
            } else {
                let body = r.into_string().unwrap_or_default();
                format!("接口错误 (HTTP {code}): {}", truncate_body(&body))
            }
        }
        e => format!("网络错误: {e}"),
    })?;
    let mut body = String::new();
    resp.into_reader()
        .take(10 * 1024 * 1024)
        .read_to_string(&mut body)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("响应解析失败: {e}"))
}

fn truncate_body(body: &str) -> String {
    if body.len() <= 300 {
        return body.to_string();
    }
    let truncated: String = body.chars().take(300).collect();
    format!("{truncated}…")
}

// ---------------- Kimi For Coding ----------------

/// GET https://api.kimi.com/coding/v1/usages，Bearer。
/// limits[].detail{limit,remaining,resetTime} → 5 小时窗口；usage{...} → 周窗口。
fn query_kimi(api_key: &str) -> Result<Vec<UsageTier>, String> {
    let body = http_get_json(
        "https://api.kimi.com/coding/v1/usages",
        &[("Authorization", &format!("Bearer {api_key}"))],
    )?;
    Ok(parse_kimi_tiers(&body))
}

fn parse_kimi_tiers(body: &Value) -> Vec<UsageTier> {
    let mut tiers = Vec::new();
    // 5 小时窗口限额（优先显示）
    if let Some(limits) = body.get("limits").and_then(|v| v.as_array()) {
        for limit_item in limits {
            if let Some(detail) = limit_item.get("detail") {
                let limit = detail.get("limit").and_then(parse_f64).unwrap_or(1.0);
                let remaining = detail.get("remaining").and_then(parse_f64).unwrap_or(0.0);
                let resets_at = detail.get("resetTime").and_then(extract_reset_time);
                tiers.push(used_ratio_tier("five_hour", limit, remaining, resets_at));
            }
        }
    }
    // 总体用量（周限额）
    if let Some(usage) = body.get("usage") {
        let limit = usage.get("limit").and_then(parse_f64).unwrap_or(1.0);
        let remaining = usage.get("remaining").and_then(parse_f64).unwrap_or(0.0);
        let resets_at = usage.get("resetTime").and_then(extract_reset_time);
        tiers.push(used_ratio_tier("weekly_limit", limit, remaining, resets_at));
    }
    tiers
}
// ---------------- 智谱 GLM ----------------

/// 智谱 TOKENS_LIMIT 条目按 `unit` 字段分类：unit:3 → 5 小时，unit:6 → 每周。
/// （实测形态：unit:3/number:5 为 5h 滚动窗；unit:6 的 number 有 7 和 1 两种，
/// 故只锚定 unit。）
enum ZhipuWindow {
    FiveHour,
    Weekly,
}

fn classify_zhipu_window(item: &Value) -> Option<ZhipuWindow> {
    match item.get("unit").and_then(|v| v.as_i64()) {
        Some(3) => Some(ZhipuWindow::FiveHour),
        Some(6) => Some(ZhipuWindow::Weekly),
        _ => None,
    }
}

/// 解析 data.limits[] 为 tier 列表。unit 缺失/不识别时走兜底启发式：
/// 无 nextResetTime 的条目优先归 five_hour（5h 桶在 0% 时可能无 reset），
/// 其余按 reset 升序依次填空槽。老套餐只回 1 条，自然降级为仅 5h。
fn parse_zhipu_token_tiers(data: &Value) -> Vec<UsageTier> {
    type Entry = (Option<i64>, f64, Option<String>);
    let mut five_hour: Option<Entry> = None;
    let mut weekly: Option<Entry> = None;
    let mut unclassified: Vec<Entry> = Vec::new();

    if let Some(limits) = data.get("limits").and_then(|v| v.as_array()) {
        for limit_item in limits {
            let limit_type = limit_item
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !(limit_type.eq_ignore_ascii_case("TOKENS_LIMIT")
                || limit_type.eq_ignore_ascii_case("CREDIT_LIMIT"))
            {
                continue;
            }
            let percentage = limit_item
                .get("percentage")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let reset_ms = limit_item.get("nextResetTime").and_then(|v| v.as_i64());
            let reset_iso = reset_ms.and_then(millis_to_iso8601);
            let entry = (reset_ms, percentage, reset_iso);
            match classify_zhipu_window(limit_item) {
                Some(ZhipuWindow::FiveHour) if five_hour.is_none() => five_hour = Some(entry),
                Some(ZhipuWindow::Weekly) if weekly.is_none() => weekly = Some(entry),
                _ => unclassified.push(entry),
            }
        }
    }

    unclassified.sort_by_key(|(reset, _, _)| (reset.is_some(), reset.unwrap_or(i64::MIN)));
    for entry in unclassified {
        if five_hour.is_none() {
            five_hour = Some(entry);
        } else if weekly.is_none() {
            weekly = Some(entry);
        }
    }

    let mut tiers = Vec::new();
    for (name, slot) in [("five_hour", five_hour), ("weekly_limit", weekly)] {
        if let Some((_, percentage, resets_at)) = slot {
            tiers.push(UsageTier {
                name: name.to_string(),
                utilization: percentage,
                resets_at,
                used_value_usd: None,
                max_value_usd: None,
            });
        }
    }
    tiers
}

/// 智谱配额端点与用户 coding 端点同 host：bigmodel.cn → open.bigmodel.cn，
/// 其余（api.z.ai）→ api.z.ai。无跨 host 回退。
fn zhipu_quota_base(base_url: &str) -> &'static str {
    if base_url.to_lowercase().contains("bigmodel.cn") {
        "https://open.bigmodel.cn"
    } else {
        "https://api.z.ai"
    }
}

/// GET {origin}/api/monitor/usage/quota/limit。
/// 注意：智谱的 Authorization **不加 Bearer 前缀**。
fn query_zhipu(base_url: &str, api_key: &str) -> Result<Vec<UsageTier>, String> {
    let url = format!(
        "{}/api/monitor/usage/quota/limit",
        zhipu_quota_base(base_url)
    );
    let body = http_get_json(
        &url,
        &[
            ("Authorization", api_key),
            ("Content-Type", "application/json"),
            ("Accept-Language", "en-US,en"),
        ],
    )?;
    Ok(match body.get("data") {
        Some(data) => parse_zhipu_token_tiers(data),
        None => Vec::new(),
    })
}

// ---------------- MiniMax ----------------

/// 解析 /coding_plan/remains 响应：model_remains[] 里只取 model_name == "general"
/// （跳过 video 等）。接口给的是"剩余百分比"，反转为已用；5h 桶始终存在，
/// 周桶仅 current_weekly_status == 1 时激活（无周限额套餐为 3，恒 100%，不展示）。
fn parse_minimax_tiers(body: &Value) -> Vec<UsageTier> {
    let mut tiers = Vec::new();
    let Some(model_remains) = body.get("model_remains").and_then(|v| v.as_array()) else {
        return tiers;
    };
    let Some(item) = model_remains.iter().find(|item| {
        item.get("model_name")
            .and_then(|v| v.as_str())
            .map(|s| s == "general")
            .unwrap_or(false)
    }) else {
        return tiers;
    };

    if let Some(remain_pct) = item
        .get("current_interval_remaining_percent")
        .and_then(|v| v.as_f64())
    {
        let resets_at = item
            .get("end_time")
            .and_then(|v| v.as_i64())
            .and_then(millis_to_iso8601);
        tiers.push(UsageTier {
            name: "five_hour".to_string(),
            utilization: 100.0 - remain_pct,
            resets_at,
            used_value_usd: None,
            max_value_usd: None,
        });
    }

    if item.get("current_weekly_status").and_then(|v| v.as_i64()) == Some(1) {
        if let Some(remain_pct) = item
            .get("current_weekly_remaining_percent")
            .and_then(|v| v.as_f64())
        {
            let resets_at = item
                .get("weekly_end_time")
                .and_then(|v| v.as_i64())
                .and_then(millis_to_iso8601);
            tiers.push(UsageTier {
                name: "weekly_limit".to_string(),
                utilization: 100.0 - remain_pct,
                resets_at,
                used_value_usd: None,
                max_value_usd: None,
            });
        }
    }
    tiers
}

/// GET https://api.minimax{i|io}/v1/api/openplatform/coding_plan/remains，Bearer。
/// base_resp.status_code != 0 为业务级错误。
fn query_minimax(api_key: &str, is_cn: bool) -> Result<Vec<UsageTier>, String> {
    let domain = if is_cn { "api.minimaxi.com" } else { "api.minimax.io" };
    let url = format!("https://{domain}/v1/api/openplatform/coding_plan/remains");
    let body = http_get_json(
        &url,
        &[
            ("Authorization", &format!("Bearer {api_key}")),
            ("Content-Type", "application/json"),
        ],
    )?;
    if let Some(base_resp) = body.get("base_resp") {
        let status_code = base_resp
            .get("status_code")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);
        if status_code != 0 {
            let msg = base_resp
                .get("status_msg")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("接口错误 (code {status_code}): {msg}"));
        }
    }
    Ok(parse_minimax_tiers(&body))
}
// ---------------- ZenMux ----------------

/// 解析 data.quota_5_hour / quota_7_day。usage_percentage 是 0-1 小数，×100 展示；
/// 附带美元金额。
fn parse_zenmux_tiers(data: &Value) -> Vec<UsageTier> {
    let mut tiers = Vec::new();
    for (key, name) in [("quota_5_hour", "five_hour"), ("quota_7_day", "weekly_limit")] {
        if let Some(q) = data.get(key) {
            let usage_pct = q.get("usage_percentage").and_then(parse_f64).unwrap_or(0.0);
            let resets_at = q.get("resets_at").and_then(|v| v.as_str()).map(String::from);
            tiers.push(UsageTier {
                name: name.to_string(),
                utilization: usage_pct * 100.0,
                resets_at,
                used_value_usd: q.get("used_value_usd").and_then(parse_f64),
                max_value_usd: q.get("max_value_usd").and_then(parse_f64),
            });
        }
    }
    tiers
}

/// GET <base_url>（ZenMux 的 base_url 本身就是用量端点），Bearer。
fn query_zenmux(base_url: &str, api_key: &str) -> Result<Vec<UsageTier>, String> {
    let body = http_get_json(
        base_url,
        &[
            ("Authorization", &format!("Bearer {api_key}")),
            ("Accept", "application/json"),
        ],
    )?;
    if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
        let msg = body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("接口错误: {msg}"));
    }
    let Some(data) = body.get("data") else {
        return Err("响应缺少 data 字段".to_string());
    };
    Ok(parse_zenmux_tiers(data))
}

// ---------------- OpenCode Go ----------------

/// 解析 usage.rolling|weekly|monthly{status,percent,resetsAt}（percent 为已用整数）。
/// percent=0 时上游 resetsAt 是"now+窗口时长"占位值，丢弃不展示倒计时。
fn parse_opencode_go_tiers(body: &Value) -> Vec<UsageTier> {
    const WINDOWS: [(&str, &str); 3] = [
        ("rolling", "five_hour"),
        ("weekly", "weekly_limit"),
        ("monthly", "monthly"),
    ];
    let Some(usage) = body.get("usage") else {
        return Vec::new();
    };
    let mut tiers = Vec::new();
    for (key, tier_name) in WINDOWS {
        let Some(window) = usage.get(key) else {
            continue;
        };
        let Some(percent) = window.get("percent").and_then(parse_f64) else {
            continue;
        };
        let resets_at = if percent > 0.0 {
            window.get("resetsAt").and_then(extract_reset_time)
        } else {
            None
        };
        tiers.push(UsageTier {
            name: tier_name.to_string(),
            utilization: percent,
            resets_at,
            used_value_usd: None,
            max_value_usd: None,
        });
    }
    tiers
}

/// GET https://opencode.ai/zen/go/v1/usage，Bearer（与推理侧 /messages 只认
/// x-api-key 相反）。403 = key 有效但无 Go 订阅。
fn query_opencode_go(api_key: &str) -> Result<Vec<UsageTier>, String> {
    let body = http_get_json(
        "https://opencode.ai/zen/go/v1/usage",
        &[("Authorization", &format!("Bearer {api_key}"))],
    )?;
    let tiers = parse_opencode_go_tiers(&body);
    if tiers.is_empty() {
        return Err("响应形态不认识（端点可能已变更）".to_string());
    }
    Ok(tiers)
}

// ---------------- 共用小工具 ----------------

/// limit/remaining 差值 → 已用百分比 tier
fn used_ratio_tier(name: &str, limit: f64, remaining: f64, resets_at: Option<String>) -> UsageTier {
    let used = (limit - remaining).max(0.0);
    let utilization = if limit > 0.0 { (used / limit) * 100.0 } else { 0.0 };
    UsageTier {
        name: name.to_string(),
        utilization,
        resets_at,
        used_value_usd: None,
        max_value_usd: None,
    }
}

/// 解析 JSON 值为 f64，兼容数字和字符串格式（如 `100` 和 `"100"`）
fn parse_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

/// 从 JSON 值提取重置时间：字符串直接返回（ISO 8601）；
/// 数字自动判断秒/毫秒（< 1e12 为秒）并转 ISO；0/负值（占位）返回 None。
fn extract_reset_time(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = value.as_i64() {
        if n <= 0 {
            return None;
        }
        let ms = if n < 1_000_000_000_000 { n * 1000 } else { n };
        return millis_to_iso8601(ms);
    }
    None
}

/// 毫秒时间戳 → UTC ISO 8601（YYYY-MM-DDTHH:MM:SS.mmmZ）。
/// 纯算法实现（Hinnant civil-from-days），不引入 chrono 依赖。
fn millis_to_iso8601(ms: i64) -> Option<String> {
    if ms <= 0 {
        return None;
    }
    let secs = ms / 1000;
    let millis_part = (ms % 1000) as u32;
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    Some(format!(
        "{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis_part:03}Z"
    ))
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detect_vendor_matches_known_hosts() {
        assert_eq!(detect_vendor("https://api.kimi.com/coding/"), Some("kimi"));
        assert_eq!(
            detect_vendor("https://open.bigmodel.cn/api/anthropic"),
            Some("zhipu")
        );
        assert_eq!(detect_vendor("https://api.z.ai/api/anthropic"), Some("zhipu"));
        assert_eq!(
            detect_vendor("https://api.minimaxi.com/anthropic"),
            Some("minimax")
        );
        assert_eq!(
            detect_vendor("https://api.minimax.io/anthropic"),
            Some("minimax")
        );
        assert_eq!(detect_vendor("https://zenmux.ai/api/xxx"), Some("zenmux"));
        assert_eq!(
            detect_vendor("https://opencode.ai/zen/go/v1"),
            Some("opencode_go")
        );
        // 普通中转（Kimi 官方 API 域名但不带 /coding）不命中
        assert_eq!(detect_vendor("https://api.moonshot.cn/anthropic"), None);
        assert_eq!(detect_vendor("https://api.anthropic.com"), None);
    }

    #[test]
    fn parse_kimi_limits_and_usage() {
        let body = json!({
            "limits": [{ "detail": { "limit": 100.0, "remaining": 62.5, "resetTime": "2026-09-07T12:00:00Z" } }],
            "usage": { "limit": "200", "remaining": 40.0, "resetTime": 1_790_000_000_000_i64 }
        });
        let tiers = parse_kimi_tiers(&body);
        assert_eq!(tiers.len(), 2);
        assert_eq!(tiers[0].name, "five_hour");
        assert!((tiers[0].utilization - 37.5).abs() < 1e-9);
        assert_eq!(tiers[0].resets_at.as_deref(), Some("2026-09-07T12:00:00Z"));
        assert_eq!(tiers[1].name, "weekly_limit");
        assert!((tiers[1].utilization - 80.0).abs() < 1e-9); // 字符串 "200" 也能解析
        assert!(tiers[1].resets_at.as_deref().unwrap_or("").ends_with('Z'));
    }

    #[test]
    fn parse_zhipu_uses_unit_field_over_time_order() {
        // 周窗口比 5h 窗口更早重置时（周期末尾），unit 字段必须赢过时间排序
        let data = json!({
            "limits": [
                { "type": "TOKENS_LIMIT", "unit": 6, "percentage": 40.0, "nextResetTime": 1000_i64 },
                { "type": "TOKENS_LIMIT", "unit": 3, "percentage": 70.0, "nextResetTime": 2000_i64 }
            ]
        });
        let tiers = parse_zhipu_token_tiers(&data);
        assert_eq!(tiers.len(), 2);
        assert_eq!(tiers[0].name, "five_hour");
        assert!((tiers[0].utilization - 70.0).abs() < 1e-9);
        assert_eq!(tiers[1].name, "weekly_limit");
        assert!((tiers[1].utilization - 40.0).abs() < 1e-9);
    }

    #[test]
    fn parse_zhipu_falls_back_without_unit() {
        // unit 缺失：无 reset 的条目优先归 five_hour，其余按 reset 升序
        let data = json!({
            "limits": [
                { "type": "TOKENS_LIMIT", "percentage": 10.0, "nextResetTime": 5000_i64 },
                { "type": "TOKENS_LIMIT", "percentage": 90.0 }
            ]
        });
        let tiers = parse_zhipu_token_tiers(&data);
        assert_eq!(tiers.len(), 2);
        assert_eq!(tiers[0].name, "five_hour");
        assert!((tiers[0].utilization - 90.0).abs() < 1e-9);
        assert!(tiers[0].resets_at.is_none());
        assert_eq!(tiers[1].name, "weekly_limit");
    }

    #[test]
    fn parse_zhipu_ignores_non_token_limits() {
        let data = json!({ "limits": [{ "type": "PROMPT_LIMIT", "unit": 3, "percentage": 50.0 }] });
        assert!(parse_zhipu_token_tiers(&data).is_empty());
    }

    #[test]
    fn parse_minimax_general_only_and_weekly_gate() {
        let body = json!({
            "base_resp": { "status_code": 0 },
            "model_remains": [
                { "model_name": "video", "current_interval_remaining_percent": 0.0 },
                { "model_name": "general",
                  "current_interval_remaining_percent": 62.5,
                  "end_time": 1_790_000_000_000_i64,
                  "current_weekly_status": 3,
                  "current_weekly_remaining_percent": 100.0 }
            ]
        });
        let tiers = parse_minimax_tiers(&body);
        assert_eq!(tiers.len(), 1, "status=3 的周桶不应展示");
        assert_eq!(tiers[0].name, "five_hour");
        assert!((tiers[0].utilization - 37.5).abs() < 1e-9);
    }

    #[test]
    fn parse_minimax_weekly_active() {
        let body = json!({
            "model_remains": [{ "model_name": "general",
                "current_interval_remaining_percent": 100.0,
                "current_weekly_status": 1,
                "current_weekly_remaining_percent": 30.0,
                "weekly_end_time": 1_795_000_000_000_i64 }]
        });
        let tiers = parse_minimax_tiers(&body);
        assert_eq!(tiers.len(), 2);
        assert_eq!(tiers[1].name, "weekly_limit");
        assert!((tiers[1].utilization - 70.0).abs() < 1e-9);
    }

    #[test]
    fn parse_zenmux_multiplies_fraction_and_keeps_usd() {
        let data = json!({
            "quota_5_hour": { "usage_percentage": 0.375, "resets_at": "2026-09-07T15:00:00Z", "used_value_usd": 4.5, "max_value_usd": 12.0 },
            "quota_7_day": { "usage_percentage": "0.8", "used_value_usd": 24.0, "max_value_usd": 30.0 }
        });
        let tiers = parse_zenmux_tiers(&data);
        assert_eq!(tiers.len(), 2);
        assert!((tiers[0].utilization - 37.5).abs() < 1e-9);
        assert_eq!(tiers[0].used_value_usd, Some(4.5));
        assert!((tiers[1].utilization - 80.0).abs() < 1e-9);
    }

    #[test]
    fn parse_opencode_go_windows_and_zero_percent_drops_reset() {
        let body = json!({
            "usage": {
                "rolling": { "status": "ok", "percent": 37, "resetsAt": "2026-09-07T13:00:00Z" },
                "weekly": { "status": "ok", "percent": 62, "resetsAt": "2026-09-10T13:00:00Z" },
                "monthly": { "status": "rate-limited", "percent": 0, "resetsAt": "2099-01-01T00:00:00Z" }
            }
        });
        let tiers = parse_opencode_go_tiers(&body);
        assert_eq!(tiers.len(), 3);
        assert_eq!(tiers[0].name, "five_hour");
        assert!((tiers[0].utilization - 37.0).abs() < 1e-9);
        assert_eq!(tiers[1].name, "weekly_limit");
        // percent=0：resetsAt 是占位值，丢弃
        assert!(tiers[2].resets_at.is_none());
    }

    #[test]
    fn millis_to_iso_converts_correctly() {
        assert_eq!(
            millis_to_iso8601(1_790_000_000_000).as_deref(),
            Some("2026-09-21T14:13:20.000Z")
        );
        assert_eq!(millis_to_iso8601(0), None);
        assert_eq!(millis_to_iso8601(-5), None);
        // 秒级时间戳自动升位
        assert_eq!(
            extract_reset_time(&json!(1_790_000_000_i64)).as_deref(),
            Some("2026-09-21T14:13:20.000Z")
        );
        // 字符串原样透传
        assert_eq!(
            extract_reset_time(&json!("2026-09-07T12:00:00Z")).as_deref(),
            Some("2026-09-07T12:00:00Z")
        );
    }
}
