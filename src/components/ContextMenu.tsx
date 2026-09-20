import { useEffect, useRef } from "react";
import type { Project, SessionInfo } from "../types";

/** 通用菜单项：tab 右键菜单用它（与项目/会话两组并列，传了 items 就只渲染这组） */
export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  /** 非空时优先渲染这组（内容区 tab 的右键菜单） */
  items?: MenuItem[] | null;
  /** 标题行（tab 标题等） */
  title?: string | null;
  /** 标题下方的说明行（如"进行中的会话不会被关闭"） */
  note?: string | null;
  project?: Project | null;
  /** 非空时渲染会话菜单组（继续/重命名/置顶/删除），此时不渲染项目组 */
  session?: SessionInfo | null;
  /** 该会话当前是否已置顶（决定置顶项文案） */
  sessionPinned?: boolean;
  onClose: () => void;
  /** 把项目移到列表最前 */
  onMoveTop?: (l: Project) => void;
  /** 在系统终端（cmd / Terminal.app）新开 claude 会话——非 app 内嵌终端 */
  onLaunchSystemTerminal?: (l: Project) => void;
  onOpenFolder?: (l: Project) => void;
  onCopyPath?: (l: Project) => void;
  onRemove?: (l: Project) => void;
  onResumeSession?: (s: SessionInfo) => void;
  /** 在系统终端继续对话（claude --resume）——非 app 内嵌终端 */
  onResumeSystemTerminal?: (s: SessionInfo) => void;
  onRenameSession?: (s: SessionInfo) => void;
  onTogglePinSession?: (s: SessionInfo) => void;
  onDeleteSession?: (s: SessionInfo) => void;
}

export default function ContextMenu({
  x, y,
  items, title, note,
  project, session, sessionPinned,
  onClose,
  onMoveTop,
  onLaunchSystemTerminal,
  onOpenFolder,
  onCopyPath,
  onRemove,
  onResumeSession,
  onResumeSystemTerminal,
  onRenameSession,
  onTogglePinSession,
  onDeleteSession,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose 走 ref：宿主传的是内联箭头函数，放进 deps 会让全局监听每次渲染重挂
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // 防止菜单超出窗口右/下边缘
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 210),
    top: Math.min(y, window.innerHeight - 260),
  };

  return (
    <div className="context-menu" ref={ref} style={style}>
      {items ? (
        <>
          {title && (
            <>
              <div className="context-title">
                <span className="context-title-text">{title}</span>
              </div>
              <div className="context-sep" />
            </>
          )}
          {items.map((it, i) => (
            <button
              key={i}
              className={`context-item ${it.danger ? "context-danger" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                it.onSelect();
                onClose();
              }}
            >
              {it.label}
            </button>
          ))}
          {note && <div className="context-note">{note}</div>}
        </>
      ) : session ? (
        <>
          <div className="context-title">
            <span className="context-title-text">{session.title}</span>
          </div>
          <div className="context-sep" />
          <button className="context-item" onClick={() => { onResumeSession?.(session); onClose(); }}>
            继续对话（内嵌终端）
          </button>
          <button className="context-item" onClick={() => { onResumeSystemTerminal?.(session); onClose(); }}>
            在系统终端继续对话
          </button>
          <button className="context-item" onClick={() => { onRenameSession?.(session); onClose(); }}>
            重命名
          </button>
          <button className="context-item" onClick={() => { onTogglePinSession?.(session); onClose(); }}>
            {sessionPinned ? "取消置顶" : "置顶（顶部聚合区常驻）"}
          </button>
          <div className="context-sep" />
          <button className="context-item context-danger" onClick={() => { onDeleteSession?.(session); onClose(); }}>
            删除（移入回收站）
          </button>
        </>
      ) : (
        <>
          {project && (
            <>
              <div className="context-title">
                {project.name}
                {project.healthy === false && <span className="tag tag-danger">失效</span>}
              </div>
              <div className="context-sep" />
              <button className="context-item" onClick={() => { onMoveTop?.(project); onClose(); }}>
                移到最前
              </button>
              <button className="context-item" onClick={() => { onLaunchSystemTerminal?.(project); onClose(); }}>
                在系统终端打开新会话
              </button>
              <button className="context-item" onClick={() => { onOpenFolder?.(project); onClose(); }}>
                打开所在文件夹
              </button>
              <button className="context-item" onClick={() => { onCopyPath?.(project); onClose(); }}>
                复制路径
              </button>
              <div className="context-sep" />
              <button className="context-item context-danger" onClick={() => { onRemove?.(project); onClose(); }}>
                            {project.healthy === false ? "移除（目录已失效）" : "从列表移除"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
