/**
 * 对话 tab 栏：一个 tab = 一个打开的会话进程。切换只做显示/隐藏
 * （进程保持运行、后台继续流式），× 关闭单个 tab（优雅关闭进程）。
 * 右键菜单：关闭其他会话（保留当前 tab，进行中的会话不关）/ 关闭所有会话。
 * 思考中/启动中的 tab 显示状态点；tab 放不下时滚轮横向滚动（VS Code 式）。
 */
import { useEffect, useRef, useState } from "react";
import type { WheelEvent } from "react";

interface Tab {
  id: string;
  title: string;
}

interface Props {
  tabs: Tab[];
  activeId: string | null;
  /** tab id → 对话状态（starting/thinking 时显示进行中标记） */
  statusByTab: Record<string, string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** 关闭除指定 tab 外的其他会话（进行中的不在关闭范围） */
  onCloseOthers: (id: string) => void;
  /** 关闭全部会话 */
  onCloseAll: () => void;
}

/** 进行中 = 正在启动/思考中（这类会话在"关闭其他"时跳过） */
function isBusyPhase(phase: string | undefined): boolean {
  return phase === "thinking" || phase === "starting";
}

export default function ChatTabs({
  tabs,
  activeId,
  statusByTab,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(
    null,
  );

  // 点击菜单外 / Escape 关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /** 垂直滚轮转为 tab 栏横向滚动（VS Code 式；无需 preventDefault——
   *  容器 overflow-y hidden，原生竖向滚动本就无路可走） */
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta !== 0) bar.scrollLeft += delta;
  };

  return (
    <div className="chat-tabs" ref={barRef} onWheel={onWheel}>
      {tabs.map((t) => {
        const phase = statusByTab[t.id];
        const busy = isBusyPhase(phase);
        return (
          <div
            key={t.id}
            className={`chat-tab ${t.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
            }}
            title={t.title}
          >
            {busy && <span className="chat-tab-dot" />}
            <span className="chat-tab-title">{t.title}</span>
            <button
              className="chat-tab-close"
              title="关闭此对话"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}

      {menu && (
        <div
          className="context-menu"
          ref={menuRef}
          style={{
            left: Math.min(menu.x, window.innerWidth - 210),
            top: Math.min(menu.y, window.innerHeight - 120),
          }}
        >
          <button
            className="context-item"
            disabled={tabs.length <= 1}
            title={
              tabs.some((t) => t.id !== menu.tabId && isBusyPhase(statusByTab[t.id]))
                ? "进行中的会话不会关闭"
                : undefined
            }
            onClick={() => {
              onCloseOthers(menu.tabId);
              setMenu(null);
            }}
          >
            关闭其他会话
          </button>
          <button
            className="context-item"
            disabled={tabs.every((t) => isBusyPhase(statusByTab[t.id]))}
            title={
              tabs.some((t) => isBusyPhase(statusByTab[t.id]))
                ? "进行中的会话不会关闭"
                : undefined
            }
            onClick={() => {
              onCloseAll();
              setMenu(null);
            }}
          >
            关闭所有会话
          </button>
        </div>
      )}
    </div>
  );
}
