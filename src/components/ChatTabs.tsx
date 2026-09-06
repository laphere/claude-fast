/**
 * 对话 tab 栏：一个 tab = 一个打开的会话进程。切换只做显示/隐藏
 * （进程保持运行、后台继续流式），× 关闭对应 tab（优雅关闭进程）。
 * 思考中/启动中的 tab 显示状态点，多会话并行时一眼看出谁在干活。
 * tab 放不下时鼠标悬停直接滚轮横向滚动（VS Code 式，不显示滚动条）。
 */
import { useRef } from "react";
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
}

export default function ChatTabs({
  tabs,
  activeId,
  statusByTab,
  onSelect,
  onClose,
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

  return (
    <div className="chat-tabs" ref={barRef} onWheel={onWheel}>
      {tabs.map((t) => {
        const phase = statusByTab[t.id];
        const busy = phase === "thinking" || phase === "starting";
        return (
          <div
            key={t.id}
            className={`chat-tab ${t.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(t.id)}
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
    </div>
  );
}
