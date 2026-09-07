import type { TemplateValueConfig } from "../config/claudeProviderPresets";

/**
 * 模板变量替换（移植自 cc-switch applyTemplateValues）：
 * 把配置里所有字符串中的 `${KEY}` 占位符替换为输入值（editorValue 优先，
 * 其次 defaultValue，最后空串），递归处理对象与数组。
 */
export function applyTemplateValues(
  config: unknown,
  templateValues: Record<string, TemplateValueConfig> | undefined,
): unknown {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(templateValues ?? {})) {
    resolved[key] =
      value.editorValue !== undefined
        ? value.editorValue
        : (value.defaultValue ?? "");
  }

  const replaceInString = (str: string): string => {
    let out = str;
    for (const [key, value] of Object.entries(resolved)) {
      const placeholder = `\${${key}}`;
      if (out.includes(placeholder)) {
        out = out.split(placeholder).join(value ?? "");
      }
    }
    return out;
  };

  const traverse = (obj: unknown): unknown => {
    if (typeof obj === "string") return replaceInString(obj);
    if (Array.isArray(obj)) return obj.map(traverse);
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        result[k] = traverse(v);
      }
      return result;
    }
    return obj;
  };

  return traverse(config);
}

/** 从任意配置对象里提取 env.ANTHROPIC_BASE_URL，用于卡片摘要展示 */
export function extractBaseUrl(config: unknown): string {
  if (config && typeof config === "object") {
    const env = (config as Record<string, unknown>).env;
    if (env && typeof env === "object") {
      const url = (env as Record<string, unknown>).ANTHROPIC_BASE_URL;
      if (typeof url === "string" && url) return url;
    }
  }
  return "";
}
