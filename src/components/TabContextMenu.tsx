/**
 * 内容区 tab 右键菜单（置顶 / 取消置顶 + 关闭其他/所有会话）。移植自 Tauri 线 App 的 tabMenuView。
 *
 * ⚠️ **纯渲染，不含任何可关性判断**：能关哪些、跳过几个、为什么跳过，全部由 App
 * 在打开菜单那一刻按同一份快照算好传进来（策略只有 App 一处，见其 openTabMenu）。
 * 本组件曾经自己重写一遍「对话非 thinking/starting + 终端已退出或判空闲」，
 * 与 App 各判各的——阈值或状态集一改就漂移成「这菜单敢关的，App 那边不肯关」。
 * 「置顶」这一项也一样：能不能置顶（对话 tab 有没有 session）与当前置没置顶，
 * 都是 App 冻结在快照里的（`pinned === null` = 不渲染该项）。
 */
import { useEffect, useRef } from "react";

interface Props {
  /** 菜单是否打开（组件常驻挂载，data-open 驱动 CSS 进出场，见 ContextMenu 注释） */
  open: boolean;
  x: number;
  y: number;
  /** 右键命中的 tab（null = 点在 tab 栏背景上，「关闭其他会话」只是不渲染）；
   *  仅用于「关闭其他」这个**动作**，显示用的标题见 title */
  tabId: string | null;
  /** 右键命中的 tab 标题（快照里的值，不跟着实时清单变） */
  title: string | null;
  /** 「置顶」项的当前状态：true 已置顶（显示「取消置顶」）/ false 未置顶；
   *  null = 这个 tab 不能置顶（点在栏背景上、或新对话还没收编出 session）→ 不渲染该项 */
  pinned: boolean | null;
  /** 「关闭其他会话」会关掉几个（tabId 非空时必然有值） */
  otherCount: number | null;
  /** 「关闭所有会话」会关掉几个（0 = 禁用） */
  allCount: number;
  /** 会被跳过（在跑/未识别）的会话数 */
  skippedCount: number;
  /** 跳过原因分项，如「2 个干活中」（空数组 = 不显示提示行） */
  why: string[];
  onClose: () => void;
  /** 置顶 / 取消置顶该 tab 的会话（顶部聚合区常驻显示） */
  onTogglePin: () => void;
  /** 关闭除指定 tab 外的其他会话（在跑的不在关闭范围） */
  onCloseOthers: (id: string) => void;
  /** 关闭全部会话（在跑的不在关闭范围） */
  onCloseAll: () => void;
}

export default function TabContextMenu({
  open,
  x,
  y,
  tabId,
  title,
  pinned,
  otherCount,
  allCount,
  skippedCount,
  why,
  onClose,
  onTogglePin,
  onCloseOthers,
  onCloseAll,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose 走 ref（宿主传内联箭头）：监听只随 open 挂卸，不随渲染重挂
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const skipTip = skippedCount > 0 ? "进行中的会话不会关闭" : undefined;

  return (
    <div
      className="context-menu"
      data-open={open}
      ref={ref}
      style={{
        left: Math.min(x, window.innerWidth - 230),
        // 预留高度要盖住最高的那种组合：标题 + 置顶项 + 两条分隔 + 两个关闭项
        // + 跳过提示行（没有置顶项时留白一点，菜单永远贴在鼠标处更不值得）
        top: Math.min(y, window.innerHeight - 210),
      }}
    >
      {tabId !== null && title !== null && (
        <>
          <div className="context-title">
            <span className="context-title-text">{title}</span>
          </div>
          <div className="context-sep" />
        </>
      )}
      {tabId !== null && pinned !== null && (
        <>
          <button
            className="context-item"
            onClick={() => {
              onTogglePin();
              onClose();
            }}
          >
            {pinned ? "取消置顶" : "置顶（顶部聚合区常驻）"}
          </button>
          <div className="context-sep" />
        </>
      )}
      {tabId !== null && (
        <button
          className="context-item"
          disabled={otherCount === 0}
          title={skipTip}
          onClick={() => {
            onCloseOthers(tabId);
            onClose();
          }}
        >
          关闭其他会话{otherCount !== null && otherCount > 0 ? `（${otherCount}）` : ""}
        </button>
      )}
      <button
        className="context-item"
        disabled={allCount === 0}
        title={skipTip}
        onClick={() => {
          onCloseAll();
          onClose();
        }}
      >
        关闭所有会话{allCount > 0 ? `（${allCount}）` : ""}
      </button>
      {why.length > 0 && (
        <>
          <div className="context-sep" />
          <div className="context-note">跳过 {skippedCount} 个：{why.join(" · ")}</div>
        </>
      )}
    </div>
  );
}
