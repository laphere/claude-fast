import { useEffect, useRef } from "react";
import type { Project } from "../types";

interface Props {
  x: number;
  y: number;
  project: Project | null;
  favorites: string[];
  onClose: () => void;
  onToggleFav: (key: string) => void;
  /** 在终端中启动 Claude Code（原项目行「+」按钮收进菜单） */
  onLaunch: (l: Project) => void;
  onOpenFolder: (l: Project) => void;
  onCopyPath: (l: Project) => void;
  onRemove: (l: Project) => void;
  onHealth: () => void;
}

export default function ContextMenu({
  x,
  y,
  project,
  favorites,
  onClose,
  onToggleFav,
  onLaunch,
  onOpenFolder,
  onCopyPath,
  onRemove,
  onHealth,
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
    top: Math.min(y, window.innerHeight - 260),
  };

  const isFav = project ? favorites.includes(project.key) : false;

  return (
    <div className="context-menu" ref={ref} style={style}>
      {project && (
        <>
          <div className="context-title">
            {project.name}
            {project.healthy === false && <span className="tag tag-danger">失效</span>}
          </div>
          <div className="context-sep" />
          <button className="context-item" onClick={() => { onToggleFav(project.key); onClose(); }}>
            {isFav ? "☆ 取消收藏" : "★ 收藏（置顶）"}
          </button>
          {project.healthy !== false && (
            <button
              className="context-item"
              onClick={() => {
                onLaunch(project);
                onClose();
              }}
            >
              ▶ 在终端中启动 Claude Code
            </button>
          )}
          <button className="context-item" onClick={() => { onOpenFolder(project); onClose(); }}>
            打开所在文件夹
          </button>
          <button className="context-item" onClick={() => { onCopyPath(project); onClose(); }}>
            复制路径
          </button>
          <div className="context-sep" />
          <button className="context-item context-danger" onClick={() => { onRemove(project); onClose(); }}>
                        {project.healthy === false ? "✗ 移除（目录已失效）" : "从列表移除"}
          </button>
          <div className="context-sep" />
        </>
      )}
      <button className="context-item" onClick={() => { onHealth(); onClose(); }}>
        健康检查
      </button>
    </div>
  );
}
