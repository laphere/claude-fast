/**
 * 内容区 tab 右键菜单（关闭其他/所有会话）。移植自 Tauri 线 App 的 tabMenuView：
 * 可关闭项 = 对话不在 thinking/starting + 终端已退出或探针判空闲；忙碌/未识别的
 * 只报数、不列进菜单（关 tab = 结束其进程）。全部基于**打开菜单那一刻**的快照
 * （activity 由 App 现算传入——终端探针不轮询、不缓存）。
 */
import { useEffect, useRef } from "react";
import type { ContentTab } from "../App";
import type { TabActivity } from "../types";

interface Props {
  x: number;
  y: number;
  /** 右键命中的 tab（null = 点在 tab 栏背景上） */
  tabId: string | null;
  tabs: ContentTab[];
  /** 打开菜单时刻的终端忙/闲快照（对话 tab 不在其中，按 phase 判断） */
  activity: Record<string, TabActivity>;
  onClose: () => void;
  /** 关闭除指定 tab 外的其他会话（在跑的不在关闭范围） */
  onCloseOthers: (id: string) => void;
  /** 关闭全部会话（在跑的不在关闭范围） */
  onCloseAll: () => void;
}

/** 进行中 = 正在启动/思考中（与 ChatTabs 同一口径） */
function isBusyPhase(phase: string | undefined): boolean {
  return phase === "thinking" || phase === "starting";
}

/** 终端 tab 能否安全关闭（与 App 的 termTabClosable 同口径：已退出或判空闲） */
function termClosable(t: Extract<ContentTab, { kind: "term" }>, activity: Record<string, TabActivity>) {
  return t.status === "exited" || activity[t.id] === "idle";
}

export default function TabContextMenu({
  x,
  y,
  tabId,
  tabs,
  activity,
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

  const closable = (t: ContentTab): boolean =>
    t.kind === "chat" ? !isBusyPhase(t.phase) : termClosable(t, activity);

  const otherTabs = tabId ? tabs.filter((t) => t.id !== tabId) : tabs;
  const otherClosable = otherTabs.filter(closable);
  const allClosable = tabs.filter(closable);

  // 分开写清楚"为什么没关"，否则只看得到 0、没法判断是探测问题还是真有在跑的
  const kept = otherTabs.filter((t) => !closable(t));
  const keptBusyChat = kept.filter((t) => t.kind === "chat").length;
  const keptTerm = kept.filter((t): t is Extract<ContentTab, { kind: "term" }> => t.kind === "term");
  const keptBusyTerm = keptTerm.filter((t) => activity[t.id] === "busy").length;
  const keptSilent = keptTerm.filter((t) => activity[t.id] === undefined).length;
  const keptUnknown = keptTerm.length - keptBusyTerm - keptSilent;
  const why: string[] = [];
  if (keptBusyChat + keptBusyTerm > 0) why.push(`${keptBusyChat + keptBusyTerm} 个干活中`);
  if (keptUnknown > 0) why.push(`${keptUnknown} 个没识别出空闲态`);
  if (keptSilent > 0) why.push(`${keptSilent} 个还没探测到`);

  const rightTab = tabId ? tabs.find((t) => t.id === tabId) : null;

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{
        left: Math.min(x, window.innerWidth - 230),
        top: Math.min(y, window.innerHeight - 150),
      }}
    >
      {rightTab && (
        <>
          <div className="context-title">
            <span className="context-title-text">{rightTab.title}</span>
          </div>
          <div className="context-sep" />
        </>
      )}
      {tabId && (
        <button
          className="context-item"
          disabled={otherClosable.length === 0}
          title={kept.length > 0 ? "进行中的会话不会关闭" : undefined}
          onClick={() => {
            onCloseOthers(tabId);
            onClose();
          }}
        >
          关闭其他会话{otherClosable.length > 0 ? `（${otherClosable.length}）` : ""}
        </button>
      )}
      <button
        className="context-item"
        disabled={allClosable.length === 0}
        title={kept.length > 0 ? "进行中的会话不会关闭" : undefined}
        onClick={() => {
          onCloseAll();
          onClose();
        }}
      >
        关闭所有会话{allClosable.length > 0 ? `（${allClosable.length}）` : ""}
      </button>
      {why.length > 0 && (
        <>
          <div className="context-sep" />
          <div className="context-note">跳过 {kept.length} 个：{why.join(" · ")}</div>
        </>
      )}
    </div>
  );
}
