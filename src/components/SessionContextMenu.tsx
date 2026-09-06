import { useEffect, useRef } from "react";
import type { SessionInfo } from "../types";

interface Props {
  x: number;
  y: number;
  session: SessionInfo;
  onClose: () => void;
  /** 在终端中继续对话（新开终端窗口 resume） */
  onResumeTerminal: () => void;
  onRename: () => void;
}

/** 会话行右键菜单：点击行 = app 内继续对话（内容查看已并入对话页）；终端继续/重命名收进这里 */
export default function SessionContextMenu({
  x,
  y,
  session,
  onClose,
  onResumeTerminal,
  onRename,
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
    top: Math.min(y, window.innerHeight - 140),
  };

  return (
    <div className="context-menu" ref={ref} style={style}>
      <div className="context-title">{session.title}</div>
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
    </div>
  );
}
