import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { UsageStats } from "../types";
import Modal from "./Modal";

interface Props {
  onClose: () => void;
}

type Range = "7d" | "30d" | "all";
type SortKey = "tokens" | "sessions";

/** 趋势柱：日窗口每柱一天，全部每柱一月；label 供 tooltip 与横轴 */
type TrendBar = {
  key: string;
  label: string;
  tokens: number;
  sessions: number;
  activeSessions: number;
  messages: number;
};

const RANGE_LABELS: Array<[Range, string]> = [
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["all", "全部"],
];

/** token 缩写（与查看器 fmtTokens 同源）：1234 → 1.2K，3456789 → 3.5M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 模型名简化：去掉 -20250514 日期后缀（hover 看全名） */
function shortModel(m: string): string {
  return m.replace(/-20\d{6,8}.*$/, "");
}

/** 本地日期 YYYY-MM-DD（后端 perDay 按前端传的时区偏移归属，与本函数同钟同区） */
function localDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 严格日历窗口起始日：含今天往前推 nDays 个自然日（近 7 天 → 今天-6） */
function windowStart(nDays: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // 正午锚定，规避夏令时切换日的日期偏移
  d.setDate(d.getDate() - (nDays - 1));
  return localDateStr(d);
}

/** 日期字符串 +k 天（YYYY-MM-DD，按本地日历，自动进位月/年） */
function addDaysStr(date: string, k: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDateStr(new Date(y, m - 1, d + k));
}

/** 月序号（YYYY-MM → 数字，便于区间枚举与比较） */
function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

/** 月序号 → YYYY-MM */
function monthFromIndex(i: number): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** 汇总卡 */
function StatCard({ num, label, sub }: { num: string; label: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card-num">{num}</div>
      <div className="stat-card-label">{label}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}

/** 使用统计仪表盘：汇总卡 / 每日趋势 / 项目排行 / 模型分布。
 *  时间范围切换作用于汇总卡、趋势图、项目排行与模型分布。
 *  近 N 天 = 严格日历窗口：含今天往前 N 个自然日，无用量日计 0 占位
 *  （趋势图柱距与日历时间成正比）；全部 = 按月聚合（每柱一个自然月，
 *  首个有数据的月零填充到当前月，不截断，与汇总卡全期口径一致）。
 *  会话数口径：汇总卡用每日 sessions（最后活跃日归属，跨天会话只计一次），
 *  窗口内累加 = 去重会话数，不会出现「全部 < 近30天」；趋势图 tooltip 用
 *  activeSessions（当日活跃，跨天会话每天都计）——否则跨天会话的前几天
 *  会显示「有 token 却 0 个会话」。 */
export default function StatsDialog({ onClose }: Props) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [range, setRange] = useState<Range>("7d");
  const [projSort, setProjSort] = useState<SortKey>("tokens");
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getUsageStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 趋势窗口（范围切换只影响汇总与趋势）：近 N 天 = 日历窗口零填充
  // （每柱一天，空缺日为全 0 的一条，让柱距与日历成正比）；全部 = 按月聚合
  // （每柱一个自然月，首个有数据的月零填充到当前月）——全期按日画会有
  // 上百根细柱没法看，月粒度才可读，且不截断、与汇总卡的全期口径一致
  const bars = useMemo<TrendBar[]>(() => {
    if (!stats) return [];
    if (range === "all") {
      if (!stats.perDay.length) return [];
      const byMonth = new Map<string, TrendBar>();
      for (const d of stats.perDay) {
        const ym = d.date.slice(0, 7);
        const cur = byMonth.get(ym);
        if (cur) {
          cur.tokens += d.tokens;
          cur.sessions += d.sessions;
          cur.activeSessions += d.activeSessions;
          cur.messages += d.messages;
        } else {
          byMonth.set(ym, {
            key: ym, label: ym, tokens: d.tokens, sessions: d.sessions,
            activeSessions: d.activeSessions, messages: d.messages,
          });
        }
      }
      const first = monthIndex(stats.perDay[0].date.slice(0, 7));
      // 右端锚定当前月（本月还没用时也占一根 0 柱，与近 N 天窗口含今天一致）
      const last = Math.max(first, monthIndex(localDateStr(new Date()).slice(0, 7)));
      return Array.from({ length: last - first + 1 }, (_, i) => {
        const ym = monthFromIndex(first + i);
        return byMonth.get(ym) ?? { key: ym, label: ym, tokens: 0, sessions: 0, activeSessions: 0, messages: 0 };
      });
    }
    const n = range === "7d" ? 7 : 30;
    const start = windowStart(n);
    const byDate = new Map(
      stats.perDay.filter((d) => d.date >= start).map((d) => [d.date, d]),
    );
    return Array.from({ length: n }, (_, i) => {
      const date = addDaysStr(start, i);
      const d = byDate.get(date);
      return d
        ? { key: date, label: date, tokens: d.tokens, sessions: d.sessions, activeSessions: d.activeSessions, messages: d.messages }
        : { key: date, label: date, tokens: 0, sessions: 0, activeSessions: 0, messages: 0 };
    });
  }, [stats, range]);

  // 窗口内汇总（「全部」直接取后端全期总量，含输入/输出/缓存拆分的同源数据）
  const summary = useMemo(() => {
    if (!stats) return null;
    if (range === "all") {
      return {
        tokens: stats.tokens,
        sessions: stats.sessions,
        messages: stats.messages,
      };
    }
    return bars.reduce(
      (acc, d) => ({
        tokens: acc.tokens + d.tokens,
        sessions: acc.sessions + d.sessions,
        messages: acc.messages + d.messages,
      }),
      { tokens: 0, sessions: 0, messages: 0 },
    );
  }, [stats, bars, range]);

  const maxBarTokens = useMemo(
    () => Math.max(...bars.map((d) => d.tokens), 1),
    [bars],
  );

  // 零填充后窗口长度恒为 N（月粒度同理），空窗判断看是否全 0（perDay 可能为空数组）
  const windowHasData = bars.some((d) => d.tokens > 0 || d.messages > 0);

  // 排行（项目/模型）与汇总同范围：全部 = 原样（后端已按 token 倒序）；
  // 近 N 天 = 各条目 perDay 按窗口起点过滤累加（sessions 为最后活跃日归属，
  // 窗口内累加 = 窗口内去重会话数，与汇总卡口径一致）
  const rangeStart = range === "all" ? null : windowStart(range === "7d" ? 7 : 30);

  // 窗口内 0 token 且 0 会话的项目不进排行（近 N 天窗口没用过的项目会映射成
  // 全 0 行；「全部」范围后端只为有会话记录的项目建条目，天然无此问题）
  const projectRows = useMemo(() => {
    if (!stats) return [];
    return stats.perProject
      .map((p) => {
        if (rangeStart === null) return p;
        let tokens = 0,
          messages = 0,
          sessions = 0;
        for (const d of p.perDay) {
          if (d.date >= rangeStart) {
            tokens += d.tokens;
            messages += d.messages;
            sessions += d.sessions;
          }
        }
        return { ...p, tokens, messages, sessions };
      })
      .filter((p) => p.tokens > 0 || p.sessions > 0)
      .sort((a, b) => b[projSort] - a[projSort]);
  }, [stats, rangeStart, projSort]);

  // 窗口内 0 token 的模型不进分布（含 <synthetic> 这类零 token 系统消息模型，
  // 以及窗口切换后无用量的模型），空列表态由下方 maxModelTokens 兜底
  const modelRows = useMemo(() => {
    if (!stats) return [];
    return stats.perModel
      .map((m) => {
        if (rangeStart === null) return m;
        let tokens = 0,
          messages = 0;
        for (const d of m.perDay) {
          if (d.date >= rangeStart) {
            tokens += d.tokens;
            messages += d.messages;
          }
        }
        return { ...m, tokens, messages };
      })
      .filter((m) => m.tokens > 0 || m.messages > 0)
      .sort((a, b) => b.tokens - a.tokens);
  }, [stats, rangeStart]);

  // `|| 1` 兜底：所选窗口内全为 0 用量时首行值是 0（不是 undefined），
  // `?? 1` 接不住，0 作分母会算出 width: NaN%
  const maxProjectVal = projectRows[0]?.[projSort] || 1;
  const maxModelTokens = modelRows[0]?.tokens || 1;

  return (
    <Modal title="使用统计" width={660} onClose={onClose}>
      <div className="stats-toolbar">
        <div className="stats-range">
          {RANGE_LABELS.map(([r, label]) => (
            <button
              key={r}
              className={range === r ? "on" : ""}
              onClick={() => setRange(r)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="stats-range-note">汇总、趋势、排行与模型均按所选范围；已删会话仍计入</span>
        <button
          className="btn"
          style={{ marginLeft: "auto" }}
          onClick={() => setReloadKey((k) => k + 1)}
          title="重新统计（仅重扫有变更的会话文件）"
        >
          刷新
        </button>
      </div>

      {loading ? (
        <div className="stats-empty">统计中…（首次需扫描所有会话文件）</div>
      ) : loadError ? (
        <div className="stats-empty">加载失败：{loadError}</div>
      ) : !stats || stats.sessions === 0 ? (
        <div className="stats-empty">暂无可统计的会话数据</div>
      ) : (
        <>
          {/* ---- 汇总卡 ---- */}
          <div className="stat-cards">
            <StatCard
              num={String(summary!.sessions)}
              label="会话数"
              sub={range === "all" && stats.earliest ? `${stats.earliest} ~ ${stats.latest}` : undefined}
            />
            <StatCard num={String(summary!.messages)} label="消息数" />
            <StatCard
              num={fmtTokens(summary!.tokens)}
              label="总 token"
              sub={
                range === "all"
                  ? `输入 ${fmtTokens(stats.inputTokens)} / 输出 ${fmtTokens(stats.outputTokens)} / 缓存 ${fmtTokens(stats.cacheReadTokens + stats.cacheCreationTokens)}`
                  : undefined
              }
            />
          </div>

          {/* ---- 趋势（日窗口按日 / 全部按月） ---- */}
          <div className="stat-sec-title">{range === "all" ? "每月 token 用量" : "每日 token 用量"}</div>
          {bars.length === 0 || !windowHasData ? (
            <div className="stats-empty">范围内无数据</div>
          ) : (
            <>
              {/* 整列热区：悬停目标是占满全高的列而非柱子本身，低用量（细线）也能命中 */}
              <div
                className="stat-chart"
                onMouseLeave={() => setHoverDay(null)}
              >
                {bars.map((d, i) => (
                  <div
                    key={d.key}
                    className="stat-col"
                    onMouseEnter={() => setHoverDay(i)}
                  >
                    <div
                      className="stat-bar"
                      style={{ height: `${Math.max((d.tokens / maxBarTokens) * 100, 2)}%` }}
                    />
                  </div>
                ))}
                {hoverDay !== null && bars[hoverDay] && (
                  <div
                    className="stat-tip"
                    style={{
                      left: `clamp(130px, ${((hoverDay + 0.5) / bars.length) * 100}%, calc(100% - 130px))`,
                    }}
                  >
                    {bars[hoverDay].label} · {fmtTokens(bars[hoverDay].tokens)} token ·{" "}
                    {/* 月柱取 sessions（最后活跃日归属，各月相加 = 去重会话总数）；
                        activeSessions 逐日相加是「会话·天」，跨天会话重复计，虚高 */}
                    {(range === "all" ? bars[hoverDay].sessions : bars[hoverDay].activeSessions)} 个会话
                  </div>
                )}
              </div>
              <div className="stat-chart-labels">
                <span>{bars[0]?.label}</span>
                <span>{bars[Math.floor(bars.length / 2)]?.label}</span>
                <span>{bars[bars.length - 1]?.label}</span>
              </div>
            </>
          )}

          {/* ---- 项目排行 ---- */}
          <div className="stat-sec-title">
            项目排行
            <span className="stat-sort">
              {(
                [
                  ["tokens", "token"],
                  ["sessions", "会话数"],
                ] as Array<[SortKey, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={projSort === k ? "on" : ""}
                  onClick={() => setProjSort(k)}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          {projectRows.map((p) => (
            <div key={p.path} className="stat-row" title={p.path}>
              <div
                className="stat-row-bar"
                style={{ width: `${Math.max((p[projSort] / maxProjectVal) * 100, 1)}%` }}
              />
              <span className="stat-row-name">{p.name}</span>
              <span className="stat-row-val">{fmtTokens(p.tokens)}</span>
              <span className="stat-row-val">{p.sessions} 会话</span>
            </div>
          ))}

          {/* ---- 模型分布 ---- */}
          <div className="stat-sec-title">模型分布（按 token）</div>
          {modelRows.map((m) => (
            <div key={m.model} className="stat-row" title={m.model}>
              <div
                className="stat-row-bar"
                style={{ width: `${Math.max((m.tokens / maxModelTokens) * 100, 1)}%` }}
              />
              <span className="stat-row-name">{shortModel(m.model)}</span>
              <span className="stat-row-val">{fmtTokens(m.tokens)}</span>
              <span className="stat-row-val">{m.messages} 条</span>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
