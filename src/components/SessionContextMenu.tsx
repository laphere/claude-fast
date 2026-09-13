import { useEffect, useRef } from "react";
import type { SessionInfo } from "../types";

interface Props {
  x: number;
  y: number;
  session: SessionInfo;
  /** 该会话当前是否已置顶（决定置顶项文案） */
  sessionPinned: boolean;
  onClose: () => void;
  /** 在终端中继续对话（新开终端窗口 resume） */
  onResumeTerminal: () => void;
  onRename: () => void;
  /** 置顶 / 取消置顶（顶部聚合区常驻显示） */
  onTogglePin: () => void;
  /** 删除会话（移入回收站，可恢复） */
  onDelete: () => void;
}

/** 会话行右键菜单：点击行 = app 内继续对话；终端继续/重命名/置顶/删除收进这里 */
export default function SessionContextMenu({
  x,
  y,
  session,
  sessionPinned,
  onClose,
  onResumeTerminal,
  onRename,
  onTogglePin,
  onDelete,
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

  // 防止菜单超出窗口右/下边缘
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 210),
    top: Math.min(y, window.innerHeight - 200),
  };

  return (
    <div className="context-menu" ref={ref} style={style}>
      <div className="context-title">
        <span className="context-title-text">{session.title}</span>
      </div>
      <div className="context-sep" />
      <button
        className="context-item"
        onClick={() => {
          onResumeTerminal();
          onClose();
        }}
      >
        ▶ 在终端中继续对话
      </button>
      <button
        className="context-item"
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        ✎ 重命名
      </button>
      <button
        className="context-item"
        onClick={() => {
          onTogglePin();
          onClose();
        }}
      >
        📌 {sessionPinned ? "取消置顶" : "置顶（顶部聚合区常驻）"}
      </button>
      <div className="context-sep" />
      <button
        className="context-item context-danger"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        🗑 删除（移入回收站）
      </button>
    </div>
  );
}
