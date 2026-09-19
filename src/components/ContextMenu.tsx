import { useEffect, useRef } from "react";
import type { Project, SessionInfo } from "../types";

interface Props {
  x: number;
  y: number;
  project: Project | null;
  /** 非空时渲染会话菜单组（继续/重命名/置顶/删除），此时不渲染项目组 */
  session: SessionInfo | null;
  /** 该会话当前是否已置顶（决定置顶项文案） */
  sessionPinned: boolean;
  onClose: () => void;
  /** 把项目移到列表最前 */
  onMoveTop: (l: Project) => void;
  onOpenFolder: (l: Project) => void;
  onCopyPath: (l: Project) => void;
  onRemove: (l: Project) => void;
  onResumeSession: (s: SessionInfo) => void;
  onRenameSession: (s: SessionInfo) => void;
  onTogglePinSession: (s: SessionInfo) => void;
  onDeleteSession: (s: SessionInfo) => void;
}

export default function ContextMenu({
  x, y, project, session, sessionPinned,
  onClose,
  onMoveTop,
  onOpenFolder,
  onCopyPath,
  onRemove,
  onResumeSession,
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
      {session ? (
        <>
          <div className="context-title">
            <span className="context-title-text">{session.title}</span>
          </div>
          <div className="context-sep" />
          <button className="context-item" onClick={() => { onResumeSession(session); onClose(); }}>
            继续对话（resume）
          </button>
          <button className="context-item" onClick={() => { onRenameSession(session); onClose(); }}>
            重命名
          </button>
          <button className="context-item" onClick={() => { onTogglePinSession(session); onClose(); }}>
            {sessionPinned ? "取消置顶" : "置顶（顶部聚合区常驻）"}
          </button>
          <div className="context-sep" />
          <button className="context-item context-danger" onClick={() => { onDeleteSession(session); onClose(); }}>
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
              <button className="context-item" onClick={() => { onMoveTop(project); onClose(); }}>
                移到最前
              </button>
              <button className="context-item" onClick={() => { onOpenFolder(project); onClose(); }}>
                打开所在文件夹
              </button>
              <button className="context-item" onClick={() => { onCopyPath(project); onClose(); }}>
                复制路径
              </button>
              <div className="context-sep" />
              <button className="context-item context-danger" onClick={() => { onRemove(project); onClose(); }}>
                            {project.healthy === false ? "移除（目录已失效）" : "从列表移除"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
