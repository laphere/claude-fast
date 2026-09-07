//! 方案结构化（侧信道 AskUserQuestion）：
//! 嵌入式 headless CLI 拿不到 AskUserQuestion 工具，模型只会把「决策点/选项」写进
//! 方案正文（形态飘忽，启发式解析不稳定）。此模块在方案轮结束后**不经过 CLI 会话**，
//! 直连当前供应商 API，让模型按固定 JSON 契约把方案整理成 决策点/选项 结构，
//! 供前端渲染可点选卡片。
//!
//! 接入配置复用 ~/.claude/settings.json 的 env（与 CLI 同源：供应商切换写的也是它）。
//! 失败返回 Err，前端回退到启发式解析或普通「批准/继续修改」。

use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

const STRUCTURE_TIMEOUT_SECS: u64 = 30;
const RESP_BODY_MAX: u64 = 10 * 1024 * 1024;
const PLAN_TEXT_MAX_CHARS: usize = 6000;
const ERROR_BODY_MAX_CHARS: usize = 300;
const MAX_POINTS: usize = 6;
const MAX_OPTIONS: usize = 6;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanChoiceOption {
    pub key: String,
    pub text: String,
    pub recommended: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanDecisionPoint {
    pub title: String,
    pub options: Vec<PlanChoiceOption>,
}

/// 读取当前 live 接入配置（用户级 settings.json；供应商切换写的就是它）
fn current_env() -> Result<serde_json::Map<String, Value>, String> {
    let dir = crate::provider::claude_config_dir();
    let Some(settings) = crate::provider::read_live_settings(&dir) else {
        return Err("未找到 ~/.claude/settings.json".to_string());
    };
    let env = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if env
        .get("ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err("未配置 ANTHROPIC_BASE_URL".to_string());
    }
    Ok(env)
}

/// 把方案文本交给供应商 API，换回 决策点/选项 结构（<=0 个决策点 = 未识别）
pub fn structure_plan(plan_text: &str) -> Result<Vec<PlanDecisionPoint>, String> {
    let env = current_env()?;
    let base = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let token = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .and_then(Value::as_str)
        .or_else(|| env.get("ANTHROPIC_API_KEY").and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let model = env
        .get("ANTHROPIC_MODEL")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if token.is_empty() {
        return Err("未配置 API Token（ANTHROPIC_AUTH_TOKEN）".to_string());
    }
    if model.is_empty() {
        return Err("未配置模型（ANTHROPIC_MODEL）".to_string());
    }

    let plan = truncate_chars(plan_text, PLAN_TEXT_MAX_CHARS);
    let prompt = format!(
        "请把下面这段「方案」整理成决策点结构。要求：\n\
         1. 识别方案里的决策点（如“决策点一 / 决策点 1 / 需要用户选择的事项”），每个决策点列出其选项；\n\
         2. 选项 key 用单个小写字母 a/b/c…；选项文字尽量短，保留关键信息；\n\
         3. 若某选项是推荐项（原文含 推荐/★/⭐/✅），recommended 为 true，否则 false；\n\
         4. 严格只输出如下 JSON，不要输出任何其他文字、不要用代码围栏、不要 markdown：\n\
         {{\"decision_points\":[{{\"title\":\"决策点标题\",\"options\":[{{\"key\":\"a\",\"text\":\"选项文字\",\"recommended\":true}}]}}]}}\n\
         方案文本：\n{}",
        plan
    );
    // 模型名候选：env 原样 → 去掉 [1M] 上下文后缀 → 小写
    // （智谱等 Anthropic 兼容端点不认 "[1M]" 后缀，CLI 内部也会剥掉再发）
    let mut models: Vec<String> = vec![model];
    if let Some(pos) = models[0].find('[') {
        if pos > 0 && models[0].ends_with(']') {
            let stripped = models[0][..pos].trim().to_string();
            if !models.contains(&stripped) {
                models.push(stripped.clone());
            }
            let lower = stripped.to_lowercase();
            if !models.contains(&lower) {
                models.push(lower);
            }
        }
    }

    let url = format!("{base}/v1/messages");
    // 认证头：raw key 走 x-api-key（默认）；Bearer 前缀走 Authorization；
    // 401/403 时换另一套重试一次（兼容各家 Anthropic 兼容口的认证差异）
    let bearer_token = token
        .strip_prefix("Bearer ")
        .or_else(|| token.strip_prefix("bearer "));
    let mut header_name = match bearer_token {
        Some(_) => "Authorization".to_string(),
        None => "x-api-key".to_string(),
    };
    let mut header_value = match bearer_token {
        Some(rest) => format!("Bearer {rest}"),
        None => token.clone(),
    };

    let mut last_error = "未匹配到可用模型名".to_string();
    for model_name in &models {
        let payload = json!({
            "model": model_name,
            "max_tokens": 1024,
            "temperature": 0,
            "system": "你是一个结构提取器。只输出指定 JSON，不输出任何解释。",
            "messages": [{ "role": "user", "content": prompt }],
        })
        .to_string();

        for attempt in 0..2 {
            let agent = ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(STRUCTURE_TIMEOUT_SECS))
                .build();
            let resp = agent
                .post(&url)
                .set("content-type", "application/json")
                .set("anthropic-version", "2023-06-01")
                .set(&header_name, &header_value)
                .send_string(&payload);
            match resp {
                Ok(r) => {
                    let mut text = String::new();
                    r.into_reader()
                        .take(RESP_BODY_MAX)
                        .read_to_string(&mut text)
                        .map_err(|e| format!("读取响应失败：{e}"))?;
                    let answer = parse_messages_text(&text).unwrap_or_default();
                    return Ok(parse_decision_points(&answer));
                }
                Err(ureq::Error::Status(code, r)) => {
                    let body = r.into_string().unwrap_or_default();
                    last_error = format!("HTTP {code}: {}", truncate_error(&body));
                    if code == 401 || code == 403 {
                        if attempt == 0 {
                            header_name = "Authorization".to_string();
                            header_value = format!("Bearer {token}");
                            continue; // 认证方式换一套重试
                        }
                        break; // 认证确有问题，换模型名无益
                    }
                    if code == 400 {
                        break; // 通常为模型名/请求不合法 → 换下一个候选
                    }
                    return Err(last_error.clone());
                }
                Err(e) => return Err(format!("网络错误：{e}")),
            }
        }
    }
    Err(last_error)
}

/// Anthropic Messages 响应 → 拼接文本
fn parse_messages_text(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let blocks = v.get("content")?.as_array()?;
    let mut out = String::new();
    for b in blocks {
        if b.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = b.get("text").and_then(Value::as_str) {
                out.push_str(t);
            }
        }
    }
    Some(out)
}

/// 从模型回复里提取 JSON：取第一个 '{' 到最后一个 '}'（容忍代码围栏/前后废话）
fn extract_json(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&text[start..=end])
}

/// 解析决策点 JSON（宽松：缺字段/空选项跳过；>=1 个决策点才算可用）
pub fn parse_decision_points(json_text: &str) -> Vec<PlanDecisionPoint> {
    let body = extract_json(json_text).unwrap_or(json_text);
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(arr) = v.get("decision_points").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut points: Vec<PlanDecisionPoint> = Vec::new();
    for item in arr.iter().take(MAX_POINTS) {
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(opts) = item.get("options").and_then(Value::as_array) else {
            continue;
        };
        let mut options: Vec<PlanChoiceOption> = Vec::new();
        for o in opts.iter().take(MAX_OPTIONS) {
            let key = o.get("key").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let text = o.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if key.is_empty() || text.is_empty() {
                continue;
            }
            options.push(PlanChoiceOption {
                key,
                text,
                recommended: o
                    .get("recommended")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
        if !options.is_empty() {
            points.push(PlanDecisionPoint { title, options });
        }
    }
    points
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

fn truncate_error(body: &str) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        return body.to_string();
    }
    format!("{}…", body.chars().take(ERROR_BODY_MAX_CHARS).collect::<String>())
}

// ---------------- 单元测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_handles_fences_and_prose() {
        let s = "\n```json\n{\"decision_points\":[]}\n```\n说明文字";
        assert_eq!(
            extract_json(s),
            Some("{\"decision_points\":[]}")
        );
        assert_eq!(extract_json("没有大括号"), None);
    }

    #[test]
    fn parse_decision_points_lenient() {
        let json = r#"{
            "decision_points": [
                {"title":"决策点 1","options":[
                    {"key":"a","text":"前端计算","recommended":true},
                    {"key":"b","text":"定时任务","recommended":false},
                    {"key":"","text":"空key跳过"}
                ]},
                {"title":"无选项"},
                {"title":"决策点 2","options":[{"key":"A","text":"固定天数","recommended":false}]}
            ]
        }"#;
        let pts = parse_decision_points(json);
        assert_eq!(pts.len(), 2);
        assert_eq!(pts[0].title, "决策点 1");
        assert_eq!(pts[0].options.len(), 2);
        assert!(pts[0].options[0].recommended);
        assert!(!pts[0].options[0].text.contains("推荐"));
        assert_eq!(pts[1].options[0].key, "A");
    }

    #[test]
    fn parse_decision_points_rejects_garbage() {
        assert!(parse_decision_points("完全不是 JSON").is_empty());
        assert!(parse_decision_points("{\"foo\":1}").is_empty());
    }

    #[test]
    fn messages_text_extracts_text_blocks() {
        let body = r#"{"content":[{"type":"text","text":"{\"decision_points\":[]}"},{"type":"thinking","thinking":"x"}]}"#;
        let text = parse_messages_text(body).unwrap();
        assert!(text.contains("decision_points"));
    }
}