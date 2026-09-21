/**
 * 内容区 tab 右键菜单（关闭其他/所有会话）。移植自 Tauri 线 App 的 tabMenuView。
 *
 * ⚠️ **纯渲染，不含任何可关性判断**：能关哪些、跳过几个、为什么跳过，全部由 App
 * 在打开菜单那一刻按同一份快照算好传进来（策略只有 App 一处，见其 openTabMenu）。
 * 本组件曾经自己重写一遍「对话非 thinking/starting + 终端已退出或判空闲」，
 * 与 App 各判各的——阈值或状态集一改就漂移成「这菜单敢关的，App 那边不肯关」。
 */
import { useEffect, useRef } from "react";

interface Props {
  x: number;
  y: number;
  /** 右键命中的 tab（null = 点在 tab 栏背景上，「关闭其他会话」只是不渲染）；
   *  仅用于「关闭其他」这个**动作**，显示用的标题见 title */
  tabId: string | null;
  /** 右键命中的 tab 标题（快照里的值，不跟着实时清单变） */
  title: string | null;
  /** 「关闭其他会话」会关掉几个（tabId 非空时必然有值） */
  otherCount: number | null;
  /** 「关闭所有会话」会关掉几个（0 = 禁用） */
  allCount: number;
  /** 会被跳过（在跑/未识别）的会话数 */
  skippedCount: number;
  /** 跳过原因分项，如「2 个干活中」（空数组 = 不显示提示行） */
  why: string[];
  onClose: () => void;
  /** 关闭除指定 tab 外的其他会话（在跑的不在关闭范围） */
  onCloseOthers: (id: string) => void;
  /** 关闭全部会话（在跑的不在关闭范围） */
  onCloseAll: () => void;
}

export default function TabContextMenu({
  x,
  y,
  tabId,
  title,
  otherCount,
  allCount,
  skippedCount,
  why,
  onClose,
  onCloseOthers,
  onCloseAll,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const skipTip = skippedCount > 0 ? "进行中的会话不会关闭" : undefined;

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{
        left: Math.min(x, window.innerWidth - 230),
        top: Math.min(y, window.innerHeight - 150),
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
