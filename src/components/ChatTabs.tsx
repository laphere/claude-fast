/**
 * 内容区 tab 栏：一个 tab = 一个打开的会话进程（页面对话或内嵌终端，两种共存）。
 * 切换只做显示/隐藏（进程保持运行、后台继续流式），× 关闭单个 tab
 * （对话优雅关闭进程；终端由 App 弹确认后 kill 进程树）。
 * 右键菜单（置顶 / 关闭其他/所有会话，在跑的跳过）由 App 渲染——忙/闲快照要在打开菜单的
 * 那一刻现算（终端探针），组件里算会拿到陈旧状态。
 * 可发言的对话 tab 常驻状态点（空闲淡而静、思考中/启动中点亮并闪烁；只读会话页
 * 无点，两类 chat tab 靠它区分）；已退出的终端 tab 整体弱化（缓冲仍可回看）；
 * tab 放不下时滚轮横向滚动（VS Code 式）。
 * tab 可拖拽调序（左侧竖线指示落点）——顺序只存在内存里，见 App 的 reorderTabs。
 */
import { useCallback, useRef, useState } from "react";
import type { DragEvent, WheelEvent } from "react";
import { TerminalIcon, XIcon } from "./Icons";
import { isBusyPhase } from "../App";
import type { ContentTab } from "../App";

interface Props {
  tabs: ContentTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** 打开 tab 右键菜单（App 现算忙/闲快照后渲染菜单；tabId null = 点在栏背景上） */
  onTabContextMenu: (e: React.MouseEvent, tabId: string | null) => void;
  /** 拖拽调序：把 draggedId 移到 targetId 的左侧/右侧（before = 插在它前） */
  onReorder: (draggedId: string, targetId: string, before: boolean) => void;
}

export default function ChatTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onTabContextMenu,
  onReorder,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  /** 垂直滚轮转为 tab 栏横向滚动（VS Code 式；无需 preventDefault——
   *  容器 overflow-y hidden，原生竖向滚动本就无路可走） */
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta !== 0) bar.scrollLeft += delta;
  };

  // ---------- 拖拽调序（视觉状态只在本组件；顺序真源是 App 的 tabs 数组） ----------

  /** 正在拖的 tab id */
  const [dragId, setDragId] = useState<string | null>(null);
  /** 悬停目标 tab id */
  const [overId, setOverId] = useState<string | null>(null);
  /** 悬停在目标的左半/右半（决定插到它前/后） */
  const [overPos, setOverPos] = useState<"left" | "right">("left");

  /** dragend 兜底清理：Esc 取消 / 拖到窗外释放都会触发（不清理会留下常驻的拖拽残影） */
  const clearDragState = useCallback(() => {
    setDragId(null);
    setOverId(null);
  }, []);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.effectAllowed = "move";
    // ⚠️ WebKit 下不带 data 的拖拽根本不启动（与项目行拖拽同一条实测结论）
    e.dataTransfer.setData("text/plain", id);
    setDragId(id);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault(); // 任意 tab 都是合法落点
    e.dataTransfer.dropEffect = "move";
    const r = e.currentTarget.getBoundingClientRect();
    // dragover 高频触发：值没变时 React 按 Object.is 跳过重渲染，直接 set 即可
    setOverId(id);
    setOverPos(e.clientX < r.left + r.width / 2 ? "left" : "right");
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (overId !== id) return;
    const rt = e.relatedTarget as Node | null;
    if (rt && e.currentTarget.contains(rt)) return; // 仍在 tab 内（子元素间移动）
    setOverId(null);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2; // 从事件重算，不依赖 state
    const dragged = dragId;
    clearDragState();
    onReorder(dragged, id, before);
  };

  return (
    <div
      className="chat-tabs"
      ref={barRef}
      onWheel={onWheel}
      onContextMenu={(e) => onTabContextMenu(e, null)}
    >
      {tabs.map((t) => {
        const busy = t.kind === "chat" && isBusyPhase(t.phase);
        const exited = t.kind === "term" && t.status === "exited";
        const showDrop = overId === t.id && t.id !== dragId;
        return (
          <div
            key={t.id}
            className={`chat-tab ${t.kind === "term" ? "chat-tab-term" : ""} ${
              exited ? "chat-tab-exited" : ""
            } ${t.id === activeId ? "active" : ""} ${
              t.id === dragId ? "dragging" : ""
            } ${showDrop ? (overPos === "left" ? "drop-before" : "drop-after") : ""}`}
            draggable
            onDragStart={(e) => handleDragStart(e, t.id)}
            onDragEnd={clearDragState}
            onDragOver={(e) => handleDragOver(e, t.id)}
            onDragLeave={(e) => handleDragLeave(e, t.id)}
            onDrop={(e) => handleDrop(e, t.id)}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => onTabContextMenu(e, t.id)}
            title={t.title}
          >
            {t.kind === "chat" && !t.readOnly && (
              <span className={`chat-tab-dot${busy ? " busy" : ""}`} />
            )}
            {t.kind === "term" && <TerminalIcon size={11} className="chat-tab-term-icon" />}
            <span className="chat-tab-title">{t.title}</span>
            <button
              className="chat-tab-close"
              title={
                t.kind === "term" && t.status !== "exited" ? "关闭（结束进程）" : "关闭"
              }
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <XIcon size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
