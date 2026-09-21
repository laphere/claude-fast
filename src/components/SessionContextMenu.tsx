import { useEffect, useRef } from "react";
import type { SessionInfo } from "../types";

interface Props {
  x: number;
  y: number;
  session: SessionInfo;
  /** 该会话当前是否已置顶（决定置顶项文案） */
  sessionPinned: boolean;
  onClose: () => void;
  /** 在系统终端窗口里继续该会话（resume） */
  onResumeSystem: () => void;
  onRename: () => void;
  /** 置顶 / 取消置顶（顶部聚合区常驻显示） */
  onTogglePin: () => void;
  /** 删除会话（移入回收站，可恢复） */
  onDelete: () => void;
}

/** 会话行右键菜单：点行 = 只读查看（不起进程），起会话的两条路收在这里
 *  （内嵌终端 / 系统终端），另有重命名 / 置顶 / 删除 */
export default function SessionContextMenu({
  x,
  y,
  session,
  sessionPinned,
  onClose,
  onResumeSystem,
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
      {/* 起会话只留系统终端一条：app 内的两条路由点击（只读查看）与只读页上的
          「继续对话」承担，不进菜单 */}
      <button
        className="context-item"
        onClick={() => {
          onResumeSystem();
          onClose();
        }}
      >
        在系统终端中继续对话
      </button>
      <div className="context-sep" />
      {/* ⚠️ 别在菜单项里加 ✎ / 📌 / 🗑 这类字符当图标：它们与 Icons.tsx 的线性
          SVG 图标不是一套（字重、基线、配色都对不上，深浅主题下更是），
          本仓铁律「禁止用字符/emoji 当按钮图标」。要加图标就从 Icons.tsx 取
          （PencilIcon / PinIcon / TrashIcon）；删除项的危险语义由 .context-danger 承担 */}
      <button
        className="context-item"
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        重命名
      </button>
      <button
        className="context-item"
        onClick={() => {
          onTogglePin();
          onClose();
        }}
      >
        {sessionPinned ? "取消置顶" : "置顶（顶部聚合区常驻）"}
      </button>
      <div className="context-sep" />
      <button
        className="context-item context-danger"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        删除（移入回收站）
      </button>
    </div>
  );
}
