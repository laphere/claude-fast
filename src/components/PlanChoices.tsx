import { useMemo, useState } from "react";

/**
 * 把模型写在方案正文里的「决策点 + 选项」启发式解析成可点选结构。
 *
 * 背景：嵌入式会话是 headless CLI，模型拿不到 AskUserQuestion 工具，所以不会
 * 发出结构化选项，只会把「决策点/选项」写进方案文本（常见形态包括：
 *   决策点一：提醒实现方式
 *   a.（推荐）前端实时计算
 *   b. 定时任务
 *   c. WebSocket
 * 或带推荐标记/制表符/表格框线：
 *   a ⭐推荐	前端拉取 + 首页横幅，复用现有 expiring 统计	零新增
 *   │ a ✅推荐 │ 查询时实时计算 │ 库表只存 expiry_date │
 * ）。这里尽力从文本里识别这些结构；识别不出时上层回退为普通
 * 「批准并执行 / 继续修改」。
 *
 * 注意：这是对自由文本的启发式匹配，依赖模型的排版格式，非官方结构化来源；
 * 识别失败不影响审批主流程。
 */

export type PlanOption = {
  /** 选项字母（a/b/c / A/B/C，保留原文大小写） */
  key: string;
  text: string;
  recommended: boolean;
};

export type PlanDecisionPoint = {
  title: string;
  options: PlanOption[];
};

const DECISION_POINT_RE =
  /^(决策点\s*[一二三四五六七八九十0-9]+|decision\s+point\s*[0-9一二三四五六七八九十]+)\s*[:：]?\s*.*$/i;
/** 表格框线/分割线行：不当作选项也不并入续行 */
const BOX_BORDER_RE = /^[│├└┌─┼┤┬┴┐┘╎╌|=|~\s*\-•·]*$/;
/** 选项行：单个拉丁字母开头，标点可有可无（兼容 "a ⭐推荐 方案" 与制表符分隔） */
const OPTION_LINE_RE = /^([A-Za-z])\s*[\.\)、:：]?\s*(.+)$/;
/** 表格行首格里紧跟选项字母的推荐标记 */
const CELL_OPTION_RE = /^([A-Za-z])\s*[\.\)、:：]?\s*(推荐|⭐|✅|★|✔)?/i;
const RECOMMENDED_RE = /推荐|recommended|⭐|✅|★|✔/;
/** 非选项行并入上一选项作为续行前的过滤：指令性/总结性行不并入 */
const CONTINUATION_STOP_RE =
  /^(请|收到|综上|因此|按|实施|建议|小结|总结|——|[-—_=]{2,})/;
/** 英文表头（Option/Plan/…）误判为选项的兜底：选项文字不会只有 "ption" 这种残词 */
const HEADER_REST_RE = /^(ption|pt|verview|cheme|trategy|ost|escription|eference)\b/i;

function pushOption(
  current: PlanDecisionPoint | null,
  key: string,
  rawText: string,
  recommended?: boolean,
) {
  if (!current) return;
  // 去掉推荐标记残留（徽标已单独展示），制表符分隔转成「 — 」
  const text = rawText
    .replace(/\t+/g, " — ")
    .replace(/^[⭐✅★✔]?\s*((?:（推荐）)|(?:推荐|recommended))[:：]?\s*/i, "")
    .replace(/^[—\-:：]\s*/, "")
    .trim();
  if (text) {
    current.options.push({
      key,
      text,
      recommended:
        recommended !== undefined ? recommended : RECOMMENDED_RE.test(rawText),
    });
  }
}

export function parsePlanChoices(text: string): PlanDecisionPoint[] {
  const points: PlanDecisionPoint[] = [];
  let current: PlanDecisionPoint | null = null;
  const close = () => {
    if (current && current.options.length > 0) points.push(current);
    current = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (DECISION_POINT_RE.test(line)) {
      close();
      current = { title: line, options: [] };
      continue;
    }
    if (!current) continue;
    if (BOX_BORDER_RE.test(line)) continue;

    // 表格行（│ 选项 │ 方案 │ 说明 │ 或 | 选项 | 方案 | 说明 |）：
    // 首格是选项字母则取剩余格做选项文字；纯分隔行（|---|:---|）跳过
    const cells = line
      .split(/[│|]/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length >= 2) {
      if (cells.every((c) => /^[-:]+$/.test(c))) continue; // markdown 分隔行
      const m = cells[0].match(CELL_OPTION_RE);
      if (m && cells[0].length <= 12) {
        // 推荐标记可能在首格（a ✅推荐），不能只看并列文字
        pushOption(
          current,
          m[1],
          cells.slice(1).join(" — "),
          RECOMMENDED_RE.test(cells[0]),
        );
        continue;
      }
    }

    // 普通/制表符分隔的选项行
    const m = line.match(OPTION_LINE_RE);
    if (m && !HEADER_REST_RE.test(m[2])) {
      pushOption(current, m[1], m[2]);
      continue;
    }

    // 其余行：并入上一选项作为续行（描述换行），指令性/框线行除外
    if (
      current.options.length > 0 &&
      !CONTINUATION_STOP_RE.test(line)
    ) {
      const last = current.options[current.options.length - 1];
      last.text += `\n${line}`;
    }
  }
  close();
  return points;
}

/**
 * 决策点/选项选择器：直接渲染结构化数据为可点选选项组
 * （供应商侧信道 plan_structure 与文本启发式共用同一套 UI）。
 * onChange 每次选择变化都会上报 { 决策点标题: "字母. 选项文字" }。
 */
export function PlanOptionList({
  points,
  onChange,
}: {
  points: PlanDecisionPoint[];
  onChange?: (answers: Record<string, string>) => void;
}) {
  const [selected, setSelected] = useState<Record<number, number>>({});

  if (points.length === 0) return null;

  const report = (next: Record<number, number>) => {
    const answers: Record<string, string> = {};
    for (const [i, optIdxStr] of Object.entries(next)) {
      const p = points[Number(i)];
      if (!p) continue;
      const o = p.options[Number(optIdxStr)];
      if (o) answers[p.title] = `${o.key}. ${o.text}`;
    }
    onChange?.(answers);
  };

  const toggle = (pi: number, oi: number) => {
    const next = { ...selected };
    if (next[pi] === oi) {
      delete next[pi];
    } else {
      next[pi] = oi;
    }
    setSelected(next);
    report(next);
  };

  return (
    <div className="plan-choices">
      {points.map((p, pi) => (
        <div key={pi} className="plan-choice">
          <div className="plan-choice-title">{p.title}</div>
          <div className="plan-choice-options">
            {p.options.map((o, oi) => {
              const active = selected[pi] === oi;
              return (
                <button
                  key={oi}
                  type="button"
                  className={`plan-choice-opt ${active ? "selected" : ""}`}
                  onClick={() => toggle(pi, oi)}
                >
                  <span className="plan-choice-key">{o.key}</span>
                  <span className="plan-choice-text">
                    {o.text}
                    {o.recommended && <em className="plan-choice-rec">★ 推荐</em>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 方案选择卡（文本启发式）：从方案文本里解析「决策点/选项」结构后渲染成
 * 可点选选项组；解析不出返回 null（由上层回退为纯文本预览 + 审批）。
 */
export function PlanChoices({
  text,
  onChange,
}: {
  text: string;
  onChange?: (answers: Record<string, string>) => void;
}) {
  const points = useMemo(() => parsePlanChoices(text), [text]);
  if (points.length === 0) return null;
  return <PlanOptionList points={points} onChange={onChange} />;
}