import { useMemo, useRef, useState } from "react";
import {
  providerPresets,
  type ProviderCategory,
} from "../config/claudeProviderPresets";

interface Props {
  /** 当前选中的预设名（"" = 自定义/空白） */
  value: string;
  onChange: (name: string) => void;
}

export const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  official: "官方",
  cn_official: "国产官方",
  cloud_provider: "云服务商",
  aggregator: "聚合",
  third_party: "第三方",
  custom: "自定义",
};

/** 预设按名称排序（默认 collation：拉丁字母在前、中文按拼音殿后），只排一次 */
const SORTED_PRESETS = [...providerPresets].sort((a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
);

/**
 * 大小写不敏感的子序列模糊匹配：query 的字符按顺序出现在 text 中即命中。
 * "kfc" → Kimi For Coding，"glm" → Zhipu GLM，"zs" → 智谱/火山等中文名。
 */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  let i = 0;
  const lower = text.toLowerCase();
  for (const ch of query.toLowerCase()) {
    i = lower.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

/** 带搜索的预设选择器：按钮式触发 + 弹出面板（搜索框 + 字母序滚动列表） */
export default function PresetPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => SORTED_PRESETS.filter((p) => fuzzyMatch(query.trim(), p.name)),
    [query],
  );

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="preset-picker">
      <button
        type="button"
        className="preset-trigger"
        onClick={() => {
          setOpen((o) => !o);
          // 展开后下一帧聚焦搜索框
          if (!open) window.setTimeout(() => searchRef.current?.focus(), 0);
        }}
      >
        <span className={value ? "" : "preset-placeholder"}>
          {value || "选择预设模板（可搜索）"}
        </span>
        <span className="preset-arrow">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="preset-panel">
          <input
            ref={searchRef}
            className="preset-search"
            placeholder="搜索：支持模糊匹配，如 kfc → Kimi For Coding"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="preset-list">
            {!query && (
              <button
                type="button"
                className={`preset-item ${value === "" ? "active" : ""}`}
                onClick={() => pick("")}
              >
                <span>自定义（空白 / 当前内容）</span>
              </button>
            )}
            {filtered.map((p) => (
              <button
                key={p.name}
                type="button"
                className={`preset-item ${value === p.name ? "active" : ""}`}
                onClick={() => pick(p.name)}
              >
                <span>{p.name}</span>
                {p.category && CATEGORY_LABEL[p.category] && (
                  <span className="preset-cat">{CATEGORY_LABEL[p.category]}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="preset-empty">没有匹配「{query}」的预设</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
