import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./Icons";
import { api } from "../lib/api";
import type { ChatModelInfo } from "../types";

/** CLI 的内置别名槽位（`supportedModels()` 里除 `default` 外就这 4 个别名。
 *  ⚠️ CLI 加了新别名时这里会把它误判成「自定义」——只影响标签、不影响功能，
 *  但要跟着 SDK/CLI 升级扫一眼 */
const ALIAS_SLOTS = new Set(["opus", "sonnet", "haiku", "fable"]);

/** 槽位的显示名。非别名的条目 = 供应商配置里那个**原始模型 id 被单列出来的**一条
 *  （CLI 给它标的 description 是英文 `Custom model`，直接显示会像 bug）。
 *  它是「钉住这个 id、不经别名解析」的入口，所以**保留**、只把标签改成人话。 */
function slotLabel(value: string): string {
  if (value === "default") return "默认";
  return ALIAS_SLOTS.has(value) ? value : "自定义";
}

/** 猜「当前是哪个槽位」——**没有权威字段可查**（2026-09-25 查过：`supportedModels()` 与
 *  `initializationResult().models` 的原始条目字段完全一致，都没有 selected/current 标记），
 *  后端只回模型名，所以 resume 进来的会话只能这样推。
 *
 *  规则：先按解析值筛出候选，**同值时优先「自定义」行**，否则取第一个。
 *  为什么优先自定义：它的存在 ⟺ `ANTHROPIC_MODEL` 已设，而那是显式指定、优先于内部默认
 *  （`Options.settings.env` 加法实验 + 用户 /model 截图双重实测）；而「默认」行的解析值
 *  在多数第三方配置下与它**逐字相同**，只取第一个就会猜成「默认」——CLI 自己的 ✓ 却在
 *  「自定义」上，两边对不上（2026-09-25 用户实测发现）。 */
function guessActive(models: ChatModelInfo[] | null, modelName: string | null): string | null {
  if (!models || !modelName) return null;
  const cands = models.filter((m) => m.resolvedModel != null && m.resolvedModel === modelName);
  if (cands.length === 0) return null; // 认不出来就不高亮（比高亮错行好）
  const custom = cands.find((m) => !ALIAS_SLOTS.has(m.value) && m.value !== "default");
  return (custom ?? cands[0]).value;
}

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
    // 不做「同一个 resolvedModel 就不发」的早退：不同槽位可能解析到同一个模型，
    // 用户就是要把 default 换成显式槽位，那种早退会变成静默无操作
    api
      .chatSetModel(sessionId, m.value)
      // 成功才记槽位：失败还改按钮标签就等于谎报切换成功
      .then(() => setPicked(m.value))
      .catch((e) => setError(String(e)));
    // 失败只能在下一次打开面板时看到（错误收在面板里）；成功则 modelName 几乎立即更新
  };

  /** 当前选中的槽位：优先用「用户点过的」，否则猜（见 guessActive 的注释）。 */
  const activeValue = picked ?? guessActive(models, modelName);
  const active = (m: ChatModelInfo) => m.value === activeValue;
  /** 触发按钮上要不要补一个槽位名。
   *  ⚠️ 必须有它：供应商把多个槽位映射到同一个模型时（本机实测 opus/fable/sonnet
   *  全指向 `deepseek-v4.1-flash[1M]`、`*_MODEL_NAME` 还都写成同一个名字），按钮上的
   *  模型名**点谁都不变**，用户完全看不到反馈（2026-09-24 用户实测反馈）。
   *  只在「用户真的点过、且不是 default 槽」时显示——没点过时不去猜（后端不回槽位，
   *  resume 进来的会话无从得知当前是哪个槽，猜一个写上去比不写更误导）。 */
  const pickedSlot = picked !== null && picked !== "default" ? slotLabel(picked) : null;

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
        {pickedSlot && <span className="model-picked">{pickedSlot}</span>}
        <span className="mode-arrow">
          <ChevronDownIcon size={12} />
        </span>
      </button>

      {/* 常驻挂载 + data-open 开合（CSS 播进出场）：关掉那 100ms 里仍渲染旧内容淡出 */}
      <div className="mode-panel" data-open={open} role="listbox">
        {loading && <div className="mode-hint">拉取模型表…</div>}
        {!loading && error && <div className="mode-hint mode-hint-error">切换失败：{error}</div>}
        {!loading && !error && models === null && (
          <div className="mode-hint">发送首条消息后可选模型</div>
        )}
        {!loading && models !== null && models.length === 0 && (
          <div className="mode-hint">CLI 未返回可选模型</div>
        )}
        {models?.map((m) => {
          const isCustom = !ALIAS_SLOTS.has(m.value) && m.value !== "default";
          return (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={active(m)}
              className={`mode-item${active(m) ? " active" : ""}`}
              title={isCustom ? `自定义模型：${m.value}` : m.description || m.value}
              onClick={() => pick(m)}
            >
              {/* 槽位名打头：供应商把多个槽位映射到同一模型时（本机 opus/fable/sonnet
                  都是 deepseek-v4.1-flash[1M]，`*_MODEL_NAME` 又写成同一个名字），
                  只按 displayName + resolvedModel 渲染会出现三行**逐字相同**、
                  根本分不清点的是哪个（2026-09-24 用户实测反馈） */}
              <span className="model-slot">{slotLabel(m.value)}</span>
              <span className="mode-item-main">
                {/* 自定义行：value 就是模型 id，拿它当主标签（CLI 给的 displayName 是
                    `deepseek-v4.1-flash`、description 是英文 Custom model，照原样显示
                    既有英文又和解析值重复 → 一行里三个近似串） */}
                <span className="model-name">{isCustom ? m.value : m.displayName}</span>
                {!isCustom && m.resolvedModel != null && m.resolvedModel !== m.displayName && (
                  <span className="model-resolved">{m.resolvedModel}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
