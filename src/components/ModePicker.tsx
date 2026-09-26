import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./Icons";

/** 权限档位选项（与 ChatView 的 MODE_OPTIONS 同形） */
export interface ModeOption {
  value: string;
  label: string;
  title: string;
}

interface Props {
  /** 当前档位；null = 还在读配置 */
  value: string | null;
  options: ModeOption[];
  /** 配置里写了下拉之外的值（如 dontAsk）→ 以原始名补进列表末尾 */
  extra?: string | null;
  onChange: (mode: string) => void;
}

/**
 * 权限档位下拉：自绘列表，**不用原生 `<select>`**。
 *
 * ⚠️ 换掉它的唯一原因就是圆角：原生 select 展开后的那份列表是**系统绘制**的
 * （方角 + 系统高亮蓝），`border-radius` 只作用于收起时的那个控件，碰不到列表。
 * 全 app 别处都是圆角，唯独这里突兀（2026-09-22 用户指出）。
 * 路子照 PresetPicker：按钮式触发 + 自绘面板。
 */
/** 「一切都不问」的危险档 → 触发器用 app 主橙标出来（参考实现里「完全访问」就是这么处理的）。
 *  ⚠️ 只列完全权限：dontAsk 语义上同属此列，但用户 2026-09-22 只点名了完全权限，
 *  要一起标就把它加进来。 */
const DANGER_MODES = new Set(["bypassPermissions"]);

export default function ModePicker({ value, options, extra, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外面 / Esc 关掉。
  // ⚠️ Esc 这条 ChatView 里也有一份（管「打断本轮」），所以那边的守卫要多认一个
  // .mode-panel —— 两份都挂在 window 上，不认就会一次 Esc 既关列表又打断本轮。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 配置里的值不在下拉里 → 补进末尾（与原先 <select> 动态加 option 同语义）
  const items: ModeOption[] =
    extra && !options.some((o) => o.value === extra)
      ? [...options, { value: extra, label: extra, title: "当前生效模式（来自 settings.json 配置）" }]
      : options;
  const label = items.find((o) => o.value === value)?.label ?? value ?? "";

  return (
    <div className="mode-picker" ref={wrapRef}>
      <button
        type="button"
        className={`chat-mode${value && DANGER_MODES.has(value) ? " danger" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="权限模式（等价终端里的 Shift+Tab 切换）"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mode-label">{value === null ? "读取配置…" : label}</span>
        <span className="mode-arrow">
          <ChevronDownIcon size={12} />
        </span>
      </button>

      {/* 常驻挂载 + data-open 开合（CSS 播进出场）：关掉那 100ms 里仍渲染旧内容淡出 */}
      <div className="mode-panel" data-open={open} role="listbox">
        {items.map((o) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            className={`mode-item${o.value === value ? " active" : ""}`}
            title={o.title}
            disabled={value === null}
            onClick={() => {
              setOpen(false);
              if (o.value !== value) onChange(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
