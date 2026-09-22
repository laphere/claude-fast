import { useEffect, useMemo, useRef, useState } from "react";
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

/** 堆叠序列：一个上色模型一条；被折叠的模型共用最后一条「其他」 */
type ModelSeries = {
  model: string;
  color: string;
  /** true = 「其他」汇总条，model 字段是展示名而非真实模型名 */
  isOther: boolean;
  /** 与 bars 等长：每个趋势桶内该序列的 token */
  buckets: number[];
};

const RANGE_LABELS: Array<[Range, string]> = [
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["all", "全部"],
];

/** 堆叠配色：引 styles.css 的 `--chart-1..9`（浅色/深色主题各一组，序号严格一一对应），
 *  按**当前窗口**的用量排名分配——用量最大的模型恒定拿第一色（陶土，与 accent 同源）；
 *  切范围会重排配色，但下方模型分布每行都带同色色块充当图例，不会读错。
 *
 *  **为什么走 var() 而不是写死色值**：图表段与行内色块都是内联 style，内联 style 完全
 *  可以用 var()；两套主题各给一组最优值（浅色 S45/L51、深色 S50/L62），写死单一组
 *  色值无法同时适配两套底色。 */
const MODEL_COLORS = [
  "var(--chart-1)", // 陶土（与 --accent 同源，最强模型专用）
  "var(--chart-2)", // 青
  "var(--chart-3)", // 金
  "var(--chart-4)", // 紫
  "var(--chart-5)", // 绿
  "var(--chart-6)", // 玫
  "var(--chart-7)", // 蓝
  "var(--chart-8)", // 棕
  "var(--chart-9)", // 松
];
/** 「其他」折叠项（模型数超上色上限时合并而成）的中性色 */
const OTHER_COLOR = "var(--chart-other)";
/** 「未归属」段的中性色：当日总量里没有模型明细的部分（见 series 内的说明）。
 *  取比 OTHER_COLOR 更浅的暖灰，读作「非模型归属」而非某个模型。 */
const UNATTRIBUTED_COLOR = "var(--chart-unattributed)";
/** 上色模型数上限：超出则只给前 N 名上色、其余并成一条「其他」。
 *  实测本机单日并发最多 4 个模型、窗口内最多 12 个，9 色足够；
 *  极端多模型中转场景由此优雅降级，不会出现同色相邻。 */
const MAX_COLORED = MODEL_COLORS.length;

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
 *  会显示「有 token 却 0 个会话」。
 *
 *  趋势图按模型堆叠：同一根柱按当日各模型用量分段，**柱高仍是当日总量**
 *  （所以不需要「总量 / 按模型」双视图——单色柱是它的严格子集：同样高度、更少信息）。
 *  逐日明细来自后端 perModel[].perDay（RankDayUsage）。 */
export default function StatsDialog({ onClose }: Props) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  /** 已有数据时的再统计（点「刷新」）：只禁用刷新按钮、保留旧数据渲染 */
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [range, setRange] = useState<Range>("7d");
  const [projSort, setProjSort] = useState<SortKey>("tokens");
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  /** 是否已成功拿到过一次数据：决定刷新是「整块占位」还是「原地刷新」。
   *  用 ref 而非 state——它只在 effect 里读一次，不该触发重渲染。 */
  const hasDataRef = useRef(false);

  /** 刷新**不能**退回整块 loading 占位态：占位态只有一行「统计中…」，
   *  而 modal 是 flex 垂直居中的定高内容盒，内容一塌，面板上下边界同时向中心收，
   *  刷新按钮就从鼠标脚下移走——连点的第二下落到遮罩上（`.overlay` 的
   *  onMouseDown = 关闭），整个统计面板被误关。故第二次起只标记 refreshing，
   *  旧数据继续渲染（高度不变），按钮原地禁用并显示「刷新中…」，
   *  连点期间鼠标始终落在面板内。 */
  useEffect(() => {
    let cancelled = false;
    if (hasDataRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLoadError(null);
    api
      .getUsageStats()
      .then((s) => {
        if (cancelled) return;
        hasDataRef.current = true;
        setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
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

  // 趋势桶映射：日视图桶键即 YYYY-MM-DD，全部视图是 YYYY-MM
  // （与 bars 的键一一对应，模型明细因此能直接落到同一根柱上）
  const bucketIndex = useMemo(() => {
    const bucketOf = (date: string) => (range === "all" ? date.slice(0, 7) : date);
    const index = new Map(bars.map((b, i) => [b.key, i]));
    return { bucketOf, index };
  }, [bars, range]);

  // 每个模型在窗口内的**逐桶**用量（与 bars 等长），供趋势图堆叠分段
  const modelBuckets = useMemo(() => {
    const map = new Map<string, number[]>();
    if (!stats) return map;
    const { bucketOf, index } = bucketIndex;
    for (const m of modelRows) {
      const arr = new Array<number>(bars.length).fill(0);
      for (const d of m.perDay) {
        if (rangeStart !== null && d.date < rangeStart) continue;
        const i = index.get(bucketOf(d.date));
        if (i === undefined) continue;
        arr[i] += d.tokens;
      }
      map.set(m.model, arr);
    }
    return map;
  }, [stats, bars, modelRows, bucketIndex, rangeStart]);

  // 配色与折叠：按窗口内用量排名分配色板；模型数超上限时只给前 MAX_COLORED 名
  // 上色，其余并成一条中性色「其他」——保证任何分布下都不出现同色相邻
  const modelRanking = useMemo(() => {
    const ranked = modelRows.map((m) => m.model);
    const coloredCount = Math.min(ranked.length, MAX_COLORED);
    const color = new Map<string, string>();
    const slot = new Map<string, number>();
    ranked.forEach((m, i) => {
      const isColored = i < coloredCount;
      color.set(m, isColored ? MODEL_COLORS[i] : OTHER_COLOR);
      slot.set(m, isColored ? i : coloredCount); // 折叠项全部落到「其他」槽
    });
    return {
      ranked,
      coloredCount,
      hasOther: ranked.length > MAX_COLORED,
      color,
      slot,
    };
  }, [modelRows]);

  // 堆叠序列：上色模型各一条（按用量倒序 → 堆叠顺序稳定，最强模型在最上方），
  // 折叠项合成末尾的「其他」
  const series = useMemo<ModelSeries[]>(() => {
    const { ranked, coloredCount, hasOther, color, slot } = modelRanking;
    const slots: ModelSeries[] = Array.from({ length: coloredCount }, (_, i) => ({
      model: ranked[i],
      color: color.get(ranked[i]) ?? OTHER_COLOR,
      isOther: false,
      buckets: new Array<number>(bars.length).fill(0),
    }));
    if (hasOther) {
      slots.push({
        model: "其他",
        color: OTHER_COLOR,
        isOther: true,
        buckets: new Array<number>(bars.length).fill(0),
      });
    }
    for (const m of modelRows) {
      const target = slots[slot.get(m.model) ?? 0];
      const arr = modelBuckets.get(m.model);
      if (!target || !arr) continue;
      for (let i = 0; i < arr.length; i++) target.buckets[i] += arr[i];
    }

    // 未归属段：当天总量里没有模型明细的差额。
    // 来源是历史台账条目——会话文件在 per_day_model 字段引入前就被删除，
    // 条目永久缺该字段（per_day 有量、per_day_model 为空；实测 53 天里 4 天、
    // 占总量 0.2%）。不补这段的话：堆叠段之和小于柱高，flex-grow 归一化会
    // 把各模型占比整体悄悄放大；极端情况下（某天只有这类条目）整根柱没有
    // 可渲染的段、直接从图上消失。柱高一律取当日总量，故各视图高度一致。
    // 图例里不出现（它不是模型），只在 tooltip 明细里说明。
    const attributed = new Array<number>(bars.length).fill(0);
    for (const s of slots) for (let i = 0; i < s.buckets.length; i++) attributed[i] += s.buckets[i];
    const rest = bars.map((b, i) => Math.max(b.tokens - attributed[i], 0));
    if (rest.some((v) => v > 0)) {
      slots.push({
        model: "未归属",
        color: UNATTRIBUTED_COLOR,
        isOther: true,
        buckets: rest,
      });
    }
    return slots;
  }, [bars, modelBuckets, modelRanking, modelRows]);

  // `|| 1` 兜底：所选窗口内全为 0 用量时首行值是 0（不是 undefined），
  // `?? 1` 接不住，0 作分母会算出 width: NaN%
  const maxProjectVal = projectRows[0]?.[projSort] || 1;
  const maxModelTokens = modelRows[0]?.tokens || 1;

  // 悬停柱的堆叠明细（只列当日真有量的序列，按用量倒序）。
  // ⚠️ **单条也照列**：当天只跑一个模型（或只有「未归属」）时，明细行是唯一能看出
  // 「这是哪个模型」的地方——按条数 ≥2 才显示的话，那天就只剩日期与总量，用户
  // 在图上无从得知模型 id（2026-09-22 用户实测反馈）。
  const hoverSegs = useMemo(() => {
    if (hoverDay === null) return [];
    return series
      .map((s) => ({ ...s, value: s.buckets[hoverDay] ?? 0 }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [hoverDay, series]);

  return (
    <Modal title="使用统计" width={660} onClose={onClose}>
      <div className="stats-toolbar">
        <div className="stats-range">
          {RANGE_LABELS.map(([r, label]) => (
            <button
              key={r}
              className={range === r ? "on" : ""}
              onClick={() => {
                setRange(r);
                setHoverDay(null); // 柱体随范围重建，旧悬停索引会指错柱
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="stats-range-note">
          汇总、趋势、排行与模型均按所选范围；已删会话仍计入
        </span>
        <button
          className="btn"
          style={{ marginLeft: "auto" }}
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={refreshing}
          title="重新统计（仅重扫有变更的会话文件）"
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {!stats && loading ? (
        <div className="stats-empty">统计中…（首次需扫描所有会话文件）</div>
      ) : !stats && loadError ? (
        <div className="stats-empty">加载失败：{loadError}</div>
      ) : !stats || stats.sessions === 0 ? (
        <div className="stats-empty">暂无可统计的会话数据</div>
      ) : (
        <>
          {/* 刷新失败：旧数据继续渲染（面板不塌缩），错误就近提示在内容顶部 */}
          {loadError && <div className="stats-error">刷新失败：{loadError}</div>}

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

          {/* ---- 趋势（日窗口按日 / 全部按月，柱高为总量、按模型堆叠分段） ---- */}
          <div className="stat-sec-title">
            {range === "all" ? "每月 token 用量" : "每日 token 用量"}
            <span className="stats-range-note">柱高 = 当日总量，分段 = 各模型</span>
          </div>
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
                    {/* 堆叠：column-reverse 让排名最高（数组首个）的模型贴底 */}
                    <div
                      className="stat-stack"
                      style={{ height: `${Math.max((d.tokens / maxBarTokens) * 100, 2)}%` }}
                    >
                      {series.map((s) => {
                        const v = s.buckets[i] ?? 0;
                        if (v <= 0) return null;
                        return (
                          <div
                            key={s.model}
                            className="stat-seg"
                            style={{ flexGrow: v, background: s.color }}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
                {hoverDay !== null && bars[hoverDay] && (
                  <div
                    className="stat-tip"
                    style={{
                      left: `clamp(130px, ${((hoverDay + 0.5) / bars.length) * 100}%, calc(100% - 130px))`,
                    }}
                  >
                    <div className="stat-tip-head">
                      {bars[hoverDay].label} · {fmtTokens(bars[hoverDay].tokens)} token ·{" "}
                      {/* 月柱取 sessions（最后活跃日归属，各月相加 = 去重会话总数）；
                          activeSessions 逐日相加是「会话·天」，跨天会话重复计，虚高 */}
                      {(range === "all" ? bars[hoverDay].sessions : bars[hoverDay].activeSessions)} 个会话
                    </div>
                    {hoverSegs.length > 0 && (
                      <div className="stat-tip-list">
                        {hoverSegs.map((s) => (
                          <div key={s.model} className="stat-tip-row">
                            <i style={{ background: s.color }} />
                            <span className="stat-tip-name">
                              {/* isOther 的序列名字已经是展示名（「其他」/「未归属」），
                                  真实模型才需要剥日期后缀 */}
                              {s.isOther ? s.model : shortModel(s.model)}
                            </span>
                            <span className="stat-tip-val">{fmtTokens(s.value)}</span>
                          </div>
                        ))}
                      </div>
                    )}
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
          {/* 色块 = 趋势图堆叠段的图例（不另设一块图例列表）；本区只给窗口合计，
              逐日粒度统一由上方趋势图承担，避免同一份数据在两处重复呈现 */}
          <div className="stat-sec-title">
            模型分布（按 token）
            <span className="stats-range-note">色块对应趋势图堆叠段</span>
          </div>
          {modelRows.map((m) => (
            <div key={m.model} className="stat-row" title={m.model}>
              <div
                className="stat-row-bar"
                style={{ width: `${Math.max((m.tokens / maxModelTokens) * 100, 1)}%` }}
              />
              <span
                className="stat-row-chip"
                style={{ background: modelRanking.color.get(m.model) ?? OTHER_COLOR }}
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
