/**
 * 内容区 tab 栏：一个 tab = 一个打开的会话进程（页面对话或内嵌终端，两种共存）。
 * 切换只做显示/隐藏（进程保持运行、后台继续流式），× 关闭单个 tab
 * （对话优雅关闭进程；终端由 App 弹确认后 kill 进程树）。
 * 右键菜单（关闭其他/所有会话，在跑的跳过）由 App 渲染——忙/闲快照要在打开菜单的
 * 那一刻现算（终端探针），组件里算会拿到陈旧状态。
 * 可发言的对话 tab 常驻状态点（空闲淡而静、思考中/启动中点亮并闪烁；只读会话页
 * 无点，两类 chat tab 靠它区分）；已退出的终端 tab 整体弱化（缓冲仍可回看）；
 * tab 放不下时滚轮横向滚动（VS Code 式）。
 */
import { useRef } from "react";
import type { WheelEvent } from "react";
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
}

export default function ChatTabs({ tabs, activeId, onSelect, onClose, onTabContextMenu }: Props) {
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
    <div
      className="chat-tabs"
      ref={barRef}
      onWheel={onWheel}
      onContextMenu={(e) => onTabContextMenu(e, null)}
    >
      {tabs.map((t) => {
        const busy = t.kind === "chat" && isBusyPhase(t.phase);
        const exited = t.kind === "term" && t.status === "exited";
        return (
          <div
            key={t.id}
            className={`chat-tab ${t.kind === "term" ? "chat-tab-term" : ""} ${
              exited ? "chat-tab-exited" : ""
            } ${t.id === activeId ? "active" : ""}`}
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
