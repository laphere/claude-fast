/**
 * 提问卡（AskUserQuestion）：复刻 claude CLI 2.1.278 的 TUI 交互
 * （二进制里 `ui.render (AskUserQuestion)` 的那套状态机与文案）。
 *
 * 复刻到的行为：
 * - **一次只显示一题**，顶部 tab 条每题一格（未答 = 空心圈、已答 = 勾，都是 `Icons.tsx`
 *   的线性图标）+ 末格「勾 + 提交」；
 *   Tab/Shift+Tab 或 ←/→ 切题，当前格高亮（TUI 的 currentQuestionIndex）
 * - **单选选中即记答案并跳到下一题，多选只勾选不跳**（TUI 的 shouldAdvance 不对称：
 *   单选默认真、多选传假）
 * - 每题末尾两个内建行：「其他」（展开输入框，输入文本即答案）与「先在对话里说」
 *   （TUI 的 `__chat__` / "Chat about this"，只加在单选题上）
 * - 选项列表末尾一行 `下一题`／`提交`（TUI 的 submitButtonText：末题是 Submit）
 * - 提交格是**复核页**：列出已答项 + 缺答黄字警告 + 再确认一次；缺答允许提交
 *   （TUI：warning "You have not answered all questions"，未答的题不进 answers）
 * - **只有一题且是单选时没有提交格**，选中即提交（TUI 的 hideSubmitTab）
 * - Esc = 取消（host 侧 deny）
 *
 * 刻意没复刻（都在 docs/agent-sdk-interactive-tools.md 的「未验证」清单里，
 * 或需要额外契约面）：选项 `preview` 分栏渲染、`n` 加 notes、
 * `annotations`/`followUp` 回传、AFK 倒计时自动提交、Ctrl+G 外部编辑器。
 *
 * ⚠️ 答案必须经 `updatedInput.answers` 回传（key = 题目完整文本，多选逗号分隔）；
 * 只回 allow 不带 answers 等于「用户没选」——不报错但静默失效。这里只在
 * 确实有答案时给对应 key（不补空串），与 CLI 侧「未答的题不进 answers」一致。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, CircleIcon } from "./Icons";

/** AskUserQuestion 的一道题（字段来自 sdk-tools.d.ts 的 AskUserQuestionInput） */
export interface AskQuestionItem {
  /** 题目完整文本——回传 answers 的 key 就是它（不是 header） */
  question: string;
  /** 短标签（tab 条上的小标题；模型侧约定 ≤12 字） */
  header?: string;
  /** 2–4 个选项；系统会自动补「其他」，不用我们自己加 */
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** 从 canUseTool 的 input 里解析提问（形状防御式：模型/CLI 侧字段缺失时不炸） */
export function parseAskQuestions(input: unknown): AskQuestionItem[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const o = q as Record<string, unknown>;
    const question = typeof o.question === "string" ? o.question : "";
    if (!question) continue;
    const opts = Array.isArray(o.options) ? o.options : [];
    out.push({
      question,
      header: typeof o.header === "string" ? o.header : undefined,
      multiSelect: o.multiSelect === true,
      options: opts
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          label: typeof x.label === "string" ? x.label : "",
          description: typeof x.description === "string" ? x.description : undefined,
        }))
        .filter((x) => x.label !== ""),
    });
  }
  return out;
}

/** 「其他」内建项的哨兵值（TUI 同款命名；回传时替换成用户输入的文本） */
const OTHER = "__other__";

/** 一行可聚焦项：选项 / 其他 / 先在对话里说（TUI 的 __chat__）/ 下一题（末题是提交） */
type Row =
  | { kind: "option"; label: string }
  | { kind: "other" }
  | { kind: "chat" }
  | { kind: "next" };

interface Props {
  items: AskQuestionItem[];
  /** 应答进行中：全部交互禁用（避免重复回传） */
  busy: boolean;
  /** 提交：answers 的 key 是题目完整文本，未答的题不出现（与 CLI 一致） */
  onSubmit: (answers: Record<string, string>) => void;
  /** Esc / 取消 → host 侧 deny */
  onCancel: () => void;
  /** 「先在对话里说」→ host 侧 allow + response（TUI 的 Chat about this） */
  onDiscuss: () => void;
}

export default function AskQuestionCard({ items, busy, onSubmit, onCancel, onDiscuss }: Props) {
  /** 当前格：`0..items.length-1` 是题目，`items.length` 是「提交」格（TUI 的
   *  currentQuestionIndex 可以等于题数，tab 条的末格就是它） */
  const [idx, setIdx] = useState(0);
  /** 每题的选择：picked 存选项 label（多选为多个），text 存「其他」输入的文本 */
  const [picks, setPicks] = useState<Record<string, { picked: string[]; text: string }>>({});
  /** 键盘在选项列表里的焦点行（TUI 的 cursor） */
  const [focus, setFocus] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  /** 只有一题且单选：没有提交格，选中即提交（TUI 的 hideSubmitTab） */
  const shortCircuit = items.length === 1 && items[0].multiSelect !== true;
  /** tab 条格数：题目格 + 提交格（短路时没有提交格） */
  const tabCount = shortCircuit ? items.length : items.length + 1;
  const onReview = !shortCircuit && idx >= items.length;
  const cur = idx < items.length ? items[idx] : null;
  const isLastQ = idx === items.length - 1;

  /** 单题的答案文本：多选拼 `", "`（CLI 侧就这么解析），「其他」用输入文本顶掉哨兵值 */
  const answerOf = (it: AskQuestionItem): string => {
    const st = picks[it.question];
    if (!st) return "";
    const labels = st.picked.filter((l) => l !== OTHER);
    const parts = it.multiSelect ? [...labels] : labels.slice(0, 1);
    const text = st.text.trim();
    if (st.picked.includes(OTHER) && text) parts.push(text);
    return parts.join(", ");
  };

  /** 收集答案；`override` 用于「刚点下就提交」那条路径——此时 state 还没落到 picks 里 */
  const collected = (override?: { question: string; answer: string }): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const it of items) {
      const a = override && override.question === it.question ? override.answer : answerOf(it);
      if (a !== "") out[it.question] = a;
    }
    return out;
  };

  const missing = items.filter((it) => answerOf(it) === "").length;

  const rows: Row[] = useMemo(() => {
    if (!cur) return [];
    const r: Row[] = cur.options.map((o) => ({ kind: "option", label: o.label }));
    r.push({ kind: "other" });
    if (!cur.multiSelect) r.push({ kind: "chat" }); // TUI：__chat__ 只加在单选题上
    if (!shortCircuit) r.push({ kind: "next" });
    return r;
  }, [cur, shortCircuit]);

  // 切题时把焦点落到已选项上（没有则第 0 行）——TUI 同款
  useEffect(() => {
    const st = cur ? picks[cur.question] : undefined;
    const sel = st?.picked.find((l) => l !== OTHER);
    const i = cur && sel ? cur.options.findIndex((o) => o.label === sel) : -1;
    setFocus(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  /** 点完一行把焦点还给卡片：不然 DOM 焦点留在按钮上，下一次 Enter 会走浏览器默认动作 */
  const keepCardFocus = () => cardRef.current?.focus({ preventScroll: true });

  const setPick = (q: string, patch: Partial<{ picked: string[]; text: string }>) =>
    setPicks((prev) => ({
      ...prev,
      [q]: { picked: prev[q]?.picked ?? [], text: prev[q]?.text ?? "", ...patch },
    }));

  const goTab = (i: number) => setIdx(Math.max(0, Math.min(tabCount - 1, i)));
  const advance = () => setIdx((i) => Math.min(tabCount - 1, i + 1));

  const chooseOption = (label: string) => {
    if (busy || !cur) return;
    if (cur.multiSelect) {
      const curPicked = picks[cur.question]?.picked ?? [];
      setPick(cur.question, {
        picked: curPicked.includes(label)
          ? curPicked.filter((l) => l !== label)
          : [...curPicked, label],
      });
      keepCardFocus();
      return;
    }
    setPick(cur.question, { picked: [label], text: "" });
    if (shortCircuit) onSubmit(collected({ question: cur.question, answer: label }));
    else {
      advance();
      keepCardFocus();
    }
  };

  /** 「其他」：单选直接切到它，多选当复选框；随后把光标送进输入框 */
  const chooseOther = () => {
    if (busy || !cur) return;
    const curPicked = picks[cur.question]?.picked ?? [];
    if (cur.multiSelect) {
      setPick(cur.question, {
        picked: curPicked.includes(OTHER)
          ? curPicked.filter((l) => l !== OTHER)
          : [...curPicked, OTHER],
      });
    } else {
      setPick(cur.question, { picked: [OTHER] });
    }
    setTimeout(() => otherRef.current?.focus(), 0);
  };

  /** 「其他」输入框里回车：文本收作答案（单选单题时直接提交，否则进下一题） */
  const commitOther = () => {
    if (busy || !cur) return;
    const text = picks[cur.question]?.text.trim() ?? "";
    if (shortCircuit) {
      if (text) onSubmit(collected({ question: cur.question, answer: text }));
      return;
    }
    advance();
    keepCardFocus();
  };

  const activate = (row: Row | undefined) => {
    if (!row || busy) return;
    if (row.kind === "option") chooseOption(row.label);
    else if (row.kind === "other") chooseOther();
    else if (row.kind === "chat") onDiscuss();
    else if (isLastQ) {
      goTab(items.length);
      keepCardFocus();
    } else {
      advance();
      keepCardFocus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    // 输入框里只接管回车（收答案），其余（含 Tab 走焦点）交给浏览器
    if (inField) {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        commitOther();
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      goTab(idx + (e.shiftKey ? -1 : 1));
      return;
    }
    if (onReview) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!busy) onSubmit(collected());
      }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      goTab(idx + (e.key === "ArrowRight" ? 1 : -1));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus((f) => Math.min(rows.length - 1, f + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus((f) => Math.max(0, f - 1));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      // preventDefault 是关键：否则聚焦中的按钮会再走一次原生 click，同一行被触发两遍
      e.preventDefault();
      activate(rows[focus]);
    }
  };

  const rowClass = (i: number, extra = "") =>
    `ask-option ${extra} ${focus === i ? "ask-option-focus" : ""}`.trim();

  const curPick = cur ? (picks[cur.question]?.picked ?? []) : [];
  const otherOpen = curPick.includes(OTHER);

  return (
    <div
      className="plan-approve ask-card"
      ref={cardRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      autoFocus
    >
      <div className="plan-approve-title">模型想先确认几件事</div>

      <div className="ask-tabs">
        {items.map((it, i) => {
          const answered = answerOf(it) !== "";
          return (
            <button
              key={it.question}
              type="button"
              className={`ask-tab ${i === idx ? "ask-tab-on" : ""} ${answered ? "ask-tab-done" : ""}`}
              disabled={busy}
              title={it.question}
              onClick={() => {
                goTab(i);
                keepCardFocus();
              }}
            >
              {/* 已答 = 勾、未答 = 空心圈（都是 Icons.tsx 的线性图标）。
                  ⚠️ 别退回 Unicode 的 ☐/☒/☑：方框套勾的笔画与相邻文字不是一套，
                  用户直接反馈过「决策点选中状态不好看」（2026-09-22） */}
              <span className="ask-tab-mark">
                {answered ? <CheckIcon size={13} /> : <CircleIcon size={11} />}
              </span>
              {it.header ?? `第 ${i + 1} 题`}
            </button>
          );
        })}
        {!shortCircuit && (
          <button
            type="button"
            className={`ask-tab ask-tab-submit ${onReview ? "ask-tab-on" : ""}`}
            disabled={busy}
            onClick={() => {
              goTab(items.length);
              keepCardFocus();
            }}
          >
            <span className="ask-tab-mark">
              <CheckIcon size={13} />
            </span>
            提交
          </button>
        )}
      </div>

      <div className="ask-body">
        {onReview ? (
          <div className="ask-review">
            <div className="ask-review-title">复核答案</div>
            {missing > 0 && (
              <div className="ask-warn">
                还有 {missing} 题没答——未答的题模型会收到「没有选项被选中」，也可以就这样提交。
              </div>
            )}
            {items.map((it) => {
              const a = answerOf(it);
              return (
                <div key={it.question} className="ask-review-row">
                  <div className="ask-review-q">
                    {it.header ? <span className="ask-question-tag">{it.header}</span> : null}
                    {it.question}
                  </div>
                  <div className={a === "" ? "ask-review-a ask-review-missing" : "ask-review-a"}>
                    {a === "" ? "（未答）" : a}
                  </div>
                </div>
              );
            })}
          </div>
        ) : cur ? (
          <>
            <div className="ask-question-head">
              {cur.header ? <span className="ask-question-tag">{cur.header}</span> : null}
              <span>{cur.question}</span>
              {cur.multiSelect ? <span className="ask-question-multi">可多选</span> : null}
            </div>
            <div className="ask-options">
              {cur.options.map((opt, i) => {
                const on = curPick.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    className={rowClass(i, on ? "ask-option-on" : "")}
                    disabled={busy}
                    onClick={() => {
                      setFocus(i);
                      chooseOption(opt.label);
                    }}
                  >
                    <span className="ask-option-label">{opt.label}</span>
                    {opt.description ? (
                      <span className="ask-option-desc">{opt.description}</span>
                    ) : null}
                  </button>
                );
              })}

              <button
                type="button"
                className={rowClass(cur.options.length, otherOpen ? "ask-option-on" : "")}
                disabled={busy}
                onClick={() => {
                  setFocus(cur.options.length);
                  chooseOther();
                }}
              >
                <span className="ask-option-label">其他</span>
                <span className="ask-option-desc">自己写一个答案</span>
              </button>
              {otherOpen && (
                <input
                  ref={otherRef}
                  className="ask-freeinput"
                  placeholder={cur.multiSelect ? "输入你的答案" : "输入你的答案，回车确认"}
                  value={picks[cur.question]?.text ?? ""}
                  disabled={busy}
                  onChange={(e) => setPick(cur.question, { text: e.target.value })}
                />
              )}

              {!cur.multiSelect && (
                <button
                  type="button"
                  className={rowClass(cur.options.length + 1, "ask-option-alt")}
                  disabled={busy}
                  onClick={() => {
                    setFocus(cur.options.length + 1);
                    onDiscuss();
                  }}
                >
                  <span className="ask-option-label">先在对话里说</span>
                  <span className="ask-option-desc">不选，回聊天里告诉模型你的想法</span>
                </button>
              )}

              {!shortCircuit && (
                <button
                  type="button"
                  className={rowClass(rows.length - 1, "ask-option-next")}
                  disabled={busy}
                  onClick={() => {
                    setFocus(rows.length - 1);
                    activate({ kind: "next" });
                  }}
                >
                  {isLastQ ? "提交" : "下一题"}
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="plan-approve-actions">
        {onReview ? (
          <>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => onSubmit(collected())}
            >
              提交回答
            </button>
            <button className="btn" disabled={busy} onClick={() => goTab(0)}>
              返回修改
            </button>
          </>
        ) : (
          <button className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        <span className="plan-approve-hint">
          {onReview
            ? "Enter 提交 · Esc 取消"
            : shortCircuit
              ? "Enter 选中即提交 · ↑↓ 选择 · Esc 取消"
              : "Enter 选中 · ↑↓ 选择 · Tab/←→ 切题 · Esc 取消"}
        </span>
      </div>
    </div>
  );
}
