import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { UsageStats } from "../types";
import Modal from "./Modal";

interface Props {
  onClose: () => void;
}

type Range = "7d" | "30d" | "all";
type SortKey = "tokens" | "sessions";

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
 *  时间范围切换只作用于汇总卡与趋势图；排行与模型分布始终为全部时间。
 *  近 N 天 = 严格日历窗口：含今天往前 N 个自然日，无用量日计 0 占位
 *  （趋势图柱距与日历时间成正比）；全部 = 所有有数据的日子。
 *  会话数口径：每日值 = 当日最后活跃的会话数（跨天会话只计一次），
 *  因此任一范围窗口内累加 = 窗口内去重会话数，不会出现「全部 < 近30天」。 */
export default function StatsDialog({ onClose }: Props) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [range, setRange] = useState<Range>("30d");
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

  // 趋势窗口（范围切换只影响汇总与趋势）：近 N 天 = 日历窗口零填充，
  // 空缺日为全 0 的一条，让柱距与日历成正比；全部 = 原样（只有有数据的日子）
  const days = useMemo(() => {
    if (!stats) return [];
    if (range === "all") return stats.perDay;
    const n = range === "7d" ? 7 : 30;
    const start = windowStart(n);
    const byDate = new Map(
      stats.perDay.filter((d) => d.date >= start).map((d) => [d.date, d]),
    );
    return Array.from({ length: n }, (_, i) => {
      const date = addDaysStr(start, i);
      return byDate.get(date) ?? { date, tokens: 0, sessions: 0, messages: 0 };
    });
  }, [stats, range]);

  // 窗口内汇总
  const summary = useMemo(() => {
    if (!stats) return null;
    if (range === "all") {
      return {
        tokens: stats.tokens,
        sessions: stats.sessions,
        messages: stats.messages,
      };
    }
    return days.reduce(
      (acc, d) => ({
        tokens: acc.tokens + d.tokens,
        sessions: acc.sessions + d.sessions,
        messages: acc.messages + d.messages,
      }),
      { tokens: 0, sessions: 0, messages: 0 },
    );
  }, [stats, days, range]);

  const maxDayTokens = useMemo(
    () => Math.max(...days.map((d) => d.tokens), 1),
    [days],
  );

  // 零填充后窗口长度恒为 N，空窗判断看是否全 0（「全部」范围 perDay 可能为空数组）
  const windowHasData = days.some((d) => d.tokens > 0 || d.messages > 0);

  const sortedProjects = useMemo(() => {
    if (!stats) return [];
    return [...stats.perProject].sort((a, b) => b[projSort] - a[projSort]);
  }, [stats, projSort]);

  const maxProjectVal = sortedProjects[0]?.[projSort] ?? 1;
  const maxModelTokens = stats?.perModel[0]?.tokens ?? 1;

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
        <span className="stats-range-note">汇总与趋势按范围；排行与模型为全部时间；已删会话仍计入</span>
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

          {/* ---- 每日趋势 ---- */}
          <div className="stat-sec-title">每日 token 用量</div>
          {days.length === 0 || !windowHasData ? (
            <div className="stats-empty">范围内无数据</div>
          ) : (
            <>
              {/* 整列热区：悬停目标是占满全高的列而非柱子本身，低用量（细线）也能命中 */}
              <div
                className="stat-chart"
                onMouseLeave={() => setHoverDay(null)}
              >
                {days.map((d, i) => (
                  <div
                    key={d.date}
                    className="stat-col"
                    onMouseEnter={() => setHoverDay(i)}
                  >
                    <div
                      className="stat-bar"
                      style={{ height: `${Math.max((d.tokens / maxDayTokens) * 100, 2)}%` }}
                    />
                  </div>
                ))}
                {hoverDay !== null && days[hoverDay] && (
                  <div
                    className="stat-tip"
                    style={{
                      left: `clamp(130px, ${((hoverDay + 0.5) / days.length) * 100}%, calc(100% - 130px))`,
                    }}
                  >
                    {days[hoverDay].date} · {fmtTokens(days[hoverDay].tokens)} token ·{" "}
                    {days[hoverDay].sessions} 个会话（最后活跃）
                  </div>
                )}
              </div>
              <div className="stat-chart-labels">
                <span>{days[0]?.date}</span>
                <span>{days[Math.floor(days.length / 2)]?.date}</span>
                <span>{days[days.length - 1]?.date}</span>
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
          {sortedProjects.map((p) => (
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
          {stats.perModel.map((m) => (
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
