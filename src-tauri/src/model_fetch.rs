//! 拉取供应商可用模型列表——移植自 cc-switch services/model_fetch.rs 的
//! URL 候选探测逻辑（OpenAI 兼容 GET /v1/models，按候选顺序尝试）。

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 15;
const ERROR_BODY_MAX_CHARS: usize = 300;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
/// baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 /v1/models / /models」的版本。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// 拉取到的单个模型（owned_by 用于前端下拉按厂商分组，缺失归 "Other"）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

/// 获取供应商可用模型列表：候选 URL 逐个尝试，404/405 换下一个，
/// 其余错误立即失败；2xx 解析 `{data:[{id,owned_by}]}` 按 id 排序去重。
pub fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<FetchedModel>, String> {
    let candidates = build_models_url_candidates(base_url)?;
    let mut last_error = String::new();
    for url in &candidates {
        match fetch_models_from_url(url, api_key) {
            Ok(models) => return Ok(models),
            Err((retryable, msg)) => {
                if !retryable {
                    return Err(msg);
                }
                last_error = msg;
            }
        }
    }
    Err(format!("所有候选地址均失败：{last_error}"))
}

/// (是否可换下一候选重试, 错误消息)
fn fetch_models_from_url(url: &str, api_key: &str) -> Result<Vec<FetchedModel>, (bool, String)> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build();
    let resp = agent
        .get(url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                let retryable = code == 404 || code == 405;
                (
                    retryable,
                    format!("HTTP {code}: {}", truncate_body(body)),
                )
            }
            e => (false, format!("网络错误: {e}")),
        })?;

    let mut body = String::new();
    resp.into_reader()
        .take(10 * 1024 * 1024) // 防御：响应体上限 10MB
        .read_to_string(&mut body)
        .map_err(|e| (false, format!("读取响应失败: {e}")))?;

    parse_models_response(&body).map_err(|e| (false, e))
}

/// 解析 OpenAI 兼容的模型列表响应 `{data: [{id, owned_by}]}`
fn parse_models_response(body: &str) -> Result<Vec<FetchedModel>, String> {
    let parsed: Value =
        serde_json::from_str(body).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    let data = parsed
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "响应缺少 data 数组".to_string())?;
    let mut models: Vec<FetchedModel> = data
        .iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|v| v.as_str()).map(String::from)?;
            let owned_by = m
                .get("owned_by")
                .and_then(|v| v.as_str())
                .map(String::from);
            Some(FetchedModel { id, owned_by })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        return body;
    }
    let truncated: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
    format!("{truncated}…")
}

/// 候选顺序（移植自 cc-switch build_models_url_candidates，无 override/full-url 分支）：
/// 1. baseURL 以版本段 `/v{N}` 结尾（`/v1`、智谱 `/api/coding/paas/v4` 等）→
///    版本号已在路径里，拼 `{base}/models`；非 `/v1` 时再追加 `/v1/models` 兜底
/// 2. 其余拼 `{base}/v1/models`
/// 3. baseURL 命中 KNOWN_COMPAT_SUFFIXES → 剥离后缀再拼 `{root}/v1/models`、`{root}/models`
/// 结果已去重且保持首次出现顺序。
pub fn build_models_url_candidates(base_url: &str) -> Result<Vec<String>, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("接入地址为空".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{trimmed}/models"));
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{trimmed}/v1/models"));
        }
    } else {
        candidates.push(format!("{trimmed}/v1/models"));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    let mut unique: Vec<String> = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|u| u == &url) {
            unique.push(url);
        }
    }
    Ok(unique)
}

fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

/// 判断 baseURL 是否以 OpenAI 风格版本段 `/v{N}` 结尾（如 `/v1`、`.../paas/v4`）。
/// 这类 URL 模型端点应为 `{base}/models`，不能再补 `/v1`。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_plain_base_appends_v1_models() {
        assert_eq!(
            build_models_url_candidates("https://api.example.com").unwrap(),
            vec!["https://api.example.com/v1/models"]
        );
        // 结尾斜杠被修剪
        assert_eq!(
            build_models_url_candidates("https://api.example.com/").unwrap(),
            vec!["https://api.example.com/v1/models"]
        );
    }

    #[test]
    fn candidates_version_segment_uses_plain_models() {
        // /v1 结尾：拼 /models（即 .../v1/models，版本号已在路径里）
        assert_eq!(
            build_models_url_candidates("https://api.example.com/v1").unwrap(),
            vec!["https://api.example.com/v1/models"]
        );
        // 智谱 /paas/v4：/models 优先，/v1/models 兜底
        assert_eq!(
            build_models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4").unwrap(),
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn candidates_compat_suffix_appends_stripped_root() {
        assert_eq!(
            build_models_url_candidates("https://api.moonshot.cn/anthropic").unwrap(),
            vec![
                "https://api.moonshot.cn/anthropic/v1/models",
                "https://api.moonshot.cn/v1/models",
                "https://api.moonshot.cn/models",
            ]
        );
        // 兼容后缀 + 版本段组合不常见，但去重必须生效
        let c = build_models_url_candidates("https://x.example.com/api/coding").unwrap();
        let unique_len = c.iter().collect::<std::collections::HashSet<_>>().len();
        assert_eq!(c.len(), unique_len);
    }

    #[test]
    fn candidates_empty_url_errors() {
        assert!(build_models_url_candidates("  ").is_err());
    }

    #[test]
    fn parse_models_extracts_sorted_unique_ids() {
        let body = r#"{"data":[{"id":"claude-b","owned_by":"zhipu"},{"id":"claude-a"},{"id":"claude-a","owned_by":"other"},{"object":"model"}]}"#;
        let models = parse_models_response(body).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-a");
        // 去重保留排序后的首个（重复项的 owned_by 丢弃）
        assert_eq!(models[0].owned_by, None);
        assert_eq!(models[1].id, "claude-b");
        assert_eq!(models[1].owned_by, Some("zhipu".to_string()));
    }

    #[test]
    fn parse_models_rejects_missing_data() {
        assert!(parse_models_response(r#"{"error":"nope"}"#).is_err());
        assert!(parse_models_response("not json").is_err());
    }
}
