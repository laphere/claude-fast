import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./Icons";
import { api } from "../lib/api";
import type { ChatModelInfo } from "../types";

interface Props {
  /** 后端会话 id（进程没起时后端返回 null，面板里给提示） */
  sessionId: string;
  /** 当前模型名（session_ready / context_usage 送来的 resolved id；未起进程为 null） */
  modelName: string | null;
}

/**
 * 模型热切选择器（`Query.supportedModels()` + `setModel()`，2026-09-24 探针实测，
 * 结论记在 docs/agent-sdk-capabilities.md §6.13）。结构与 ModePicker 同款：
 * 自绘列表（原生 select 展开列表是系统绘制的，圆角碰不到），复用 .mode-picker 那套 class。
 *
 * 三条口径：
 * - 切换成功后 CLI **立即**补发一帧 init（不等下一轮），经既有 session_ready 事件把新
 *   模型名送回来——本组件切完不改自己的显示，等 modelName prop 变即可，不乐观更新。
 * - 条目是**供应商映射后的槽位**：第三方供应商下 opus/fable/sonnet/haiku 各自解析到
 *   供应商的模型变体，每行把 resolvedModel 亮出来（大小写原样，[1m]/[1M] 是两回事）。
 * - 非法名被供应商 400 拒掉（reject），面板内联显示错误、不弹 toast。
 */
export default function ModelPicker({ sessionId, modelName }: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ChatModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 用户点过的**槽位**（value）。⚠️ 选中态不能只按 resolvedModel 判：第三方供应商下
   *  多个槽位解析到同一个模型（实测 GLM 下 opus/fable/sonnet **三个**都是 `glm-5.3[1M]`），
   *  那样会三行同时高亮、且点另一个槽位被「同一个模型就不发」的早退挡成静默无操作——
   *  用户没法从 default 切到显式槽位（2026-09-24 code review 发现） */
  const [picked, setPicked] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外面 / Esc 关掉（Esc 那条与 ChatView 的「打断本轮」共用 window，靠 .mode-panel 让路）
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

  // 打开时现拉（实测往返 <1ms）：模型表随供应商配置变化，不做长缓存。
  // 进程没起时后端返回 null → 面板给「发送首条消息后可选」的提示
  const openPanel = () => {
    setOpen(true);
    if (models === null && !loading) {
      setLoading(true);
      setError(null);
      api
        .chatModels(sessionId)
        .then((list) => setModels(list))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    }
  };

  const pick = (m: ChatModelInfo) => {
    setOpen(false);
    setError(null);
    setPicked(m.value); // 记住槽位身份（同解析值的兄弟槽位因此不再互相冒充）
    // 不做「同一个 resolvedModel 就不发」的早退：不同槽位可能解析到同一个模型，
    // 用户就是要把 default 换成显式槽位，那种早退会变成静默无操作
    api.chatSetModel(sessionId, m.value).catch((e) => setError(String(e)));
    // 失败只能在下一次打开面板时看到（错误收在面板里）；成功则 modelName 几乎立即更新
  };

  /** 当前选中的槽位：优先用「用户点过的」，否则退回**第一个**解析值匹配的行。
   *  （后端只回模型名、不回槽位，所以 resume 进来的会话只能这样猜；取第一个是为了
   *  避免多行同时高亮——别名槽的顺序里 default 在最前，猜它最合理） */
  const activeValue =
    picked ??
    models?.find((m) => m.resolvedModel != null && m.resolvedModel === modelName)?.value ??
    null;
  const active = (m: ChatModelInfo) => m.value === activeValue;

  return (
    <div className="mode-picker model-picker" ref={wrapRef}>
      <button
        type="button"
        className="chat-mode"
        onClick={() => (open ? setOpen(false) : openPanel())}
        title={modelName ? `模型 ${modelName}，点击切换` : "模型（发送首条消息后可选）"}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mode-label">{modelName ?? "模型"}</span>
        <span className="mode-arrow">
          <ChevronDownIcon size={12} />
        </span>
      </button>

      {open && (
        <div className="mode-panel" role="listbox">
          {loading && <div className="mode-hint">拉取模型表…</div>}
          {!loading && error && <div className="mode-hint mode-hint-error">切换失败：{error}</div>}
          {!loading && !error && models === null && (
            <div className="mode-hint">发送首条消息后可选模型</div>
          )}
          {!loading && models !== null && models.length === 0 && (
            <div className="mode-hint">CLI 未返回可选模型</div>
          )}
          {models?.map((m) => (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={active(m)}
              className={`mode-item${active(m) ? " active" : ""}`}
              title={m.description || m.value}
              onClick={() => pick(m)}
            >
              <span className="mode-item-main">
                {m.displayName}
                {m.resolvedModel != null && m.resolvedModel !== m.displayName && (
                  <span className="model-resolved">{m.resolvedModel}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
