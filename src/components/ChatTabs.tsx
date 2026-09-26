/**
 * 内容区 tab 栏：一个 tab = 一个打开的会话进程（页面对话或内嵌终端，两种共存）。
 * 切换只做显示/隐藏（进程保持运行、后台继续流式），× 关闭单个 tab
 * （对话优雅关闭进程；终端由 App 弹确认后 kill 进程树）。
 * 右键菜单（置顶 / 关闭其他/所有会话，在跑的跳过）由 App 渲染——忙/闲快照要在打开菜单的
 * 那一刻现算（终端探针），组件里算会拿到陈旧状态。
 * 可发言的对话 tab 常驻状态点（空闲淡而静、思考中/启动中点亮并闪烁；只读会话页
 * 无点，两类 chat tab 靠它区分）；已退出的终端 tab 整体弱化（缓冲仍可回看）；
 * tab 放不下时滚轮横向滚动（VS Code 式）。
 * tab 可拖拽调序（竖线指示落点）——顺序只存在内存里，见 App 的 reorderTabs。
 */
import { useCallback, useRef, useState } from "react";
import type { DragEvent, WheelEvent } from "react";
import { TerminalIcon, XIcon } from "./Icons";
import { isBusyPhase } from "../App";
import type { ContentTab } from "../App";
import { useFlip } from "../lib/flip";

interface Props {
  tabs: ContentTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** 打开 tab 右键菜单（App 现算忙/闲快照后渲染菜单；tabId null = 点在栏背景上） */
  onTabContextMenu: (e: React.MouseEvent, tabId: string | null) => void;
  /** 拖拽调序：把 draggedId 插到「原数组第 gap 个空隙」处（见 lib/tab-order 的语义） */
  onReorder: (draggedId: string, gap: number) => void;
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

  // FLIP 让位：拖拽调序落位 / 关 tab 后，其余 tab 平滑滑到新位。
  // 签名只认 id 顺序（phase/标题变宽不经签名，但基线每轮都刷新，见 lib/flip.ts）
  useFlip(barRef, ".chat-tab", tabs.map((t) => t.id).join("\u0000"), true);

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
  /** 落点：原数组坐标下的**空隙位**（0..tabs.length，tabs.length = 移到最后） */
  const [dropGap, setDropGap] = useState<number | null>(null);

  /** dragend 兜底清理：Esc 取消 / 拖到窗外释放都会触发（不清理会留下常驻的拖拽残影） */
  const clearDragState = useCallback(() => {
    setDragId(null);
    setDropGap(null);
  }, []);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.effectAllowed = "move";
    // ⚠️ WebKit 下不带 data 的拖拽根本不启动（与项目行拖拽同一条实测结论）
    e.dataTransfer.setData("text/plain", id);
    setDragId(id);
  };

  /** 由光标 X 算空隙位：取第一个「中点还在光标右边」的 tab 的下标。
   *
   *  ⚠️ **落点判据挂在栏容器上、不挂在各个 tab 上**（2026-09-25 实测踩坑）：
   *  原来每个 tab 各自当落点，于是**落在 tab 以外的任何位置都是无操作**——而这条栏
   *  只有 27px 高、上面还有 6px 内边距，最后一个 tab 右侧又是一大片空白，「拖到最右边
   *  想挪到最后」这个最自然的动作正好落在死区里，表现为「拖动不生效、位置没变」
   *  （探针复现：落在 tab 上能换位，落在空白/上内边距一律没反应）。改成整条栏都是
   *  落点后，光标在哪都能算出一个空隙位。
   *  用 `getBoundingClientRect` 而不是缓存宽度：tab 栏横向滚动时它自带你当前可视坐标。 */
  const gapAt = (clientX: number): number => {
    const els = barRef.current?.querySelectorAll<HTMLElement>(".chat-tab");
    if (!els || els.length === 0) return 0;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  };

  const handleBarDragOver = (e: DragEvent<HTMLDivElement>) => {
    // 只认本组件自己发起的拖拽：否则外部拖进来的文件也会被这条栏当成落点
    if (!dragId) return;
    e.preventDefault(); // 整条栏都是合法落点
    e.dataTransfer.dropEffect = "move";
    // dragover 高频触发：值没变时 React 按 Object.is 跳过重渲染，直接 set 即可
    setDropGap(gapAt(e.clientX));
  };

  const handleBarDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const rt = e.relatedTarget as Node | null;
    if (rt && e.currentTarget.contains(rt)) return; // 仍在栏内（子元素间移动）
    setDropGap(null);
  };

  const handleBarDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const gap = gapAt(e.clientX); // 从事件重算，不依赖 state
    const dragged = dragId;
    clearDragState();
    onReorder(dragged, gap);
  };

  return (
    <div
      className="chat-tabs"
      ref={barRef}
      onWheel={onWheel}
      onDragOver={handleBarDragOver}
      onDragLeave={handleBarDragLeave}
      onDrop={handleBarDrop}
      onContextMenu={(e) => onTabContextMenu(e, null)}
    >
      {tabs.map((t, i) => {
        const busy = t.kind === "chat" && isBusyPhase(t.phase);
        const exited = t.kind === "term" && t.status === "exited";
        // 指示条画在哪：空隙位落在某个 tab 上 = 它的左侧；落在末尾（= 数组长度）= 最后
        // 一个 tab 的右侧。拖拽中的那个 tab 不画（拖到自己身上本来就不会换位）。
        const showDrop =
          dropGap !== null &&
          (dropGap === i || (dropGap === tabs.length && i === tabs.length - 1));
        return (
          <div
            key={t.id}
            className={`chat-tab ${t.kind === "term" ? "chat-tab-term" : ""} ${
              exited ? "chat-tab-exited" : ""
            } ${t.id === activeId ? "active" : ""} ${
              t.id === dragId ? "dragging" : ""
            } ${showDrop ? (dropGap === i ? "drop-before" : "drop-after") : ""}`}
            draggable
            onDragStart={(e) => handleDragStart(e, t.id)}
            onDragEnd={clearDragState}
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
