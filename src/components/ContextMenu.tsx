import { useEffect, useRef } from "react";
import type { Launcher } from "../types";

interface Props {
  x: number;
  y: number;
  launcher: Launcher | null;
  favorites: string[];
  onClose: () => void;
  onToggleFav: (key: string) => void;
  onOpenFolder: (l: Launcher) => void;
  onCopyPath: (l: Launcher) => void;
  onRemove: (l: Launcher) => void;
  onHealth: () => void;
}

export default function ContextMenu({
  x,
  y,
  launcher,
  favorites,
  onClose,
  onToggleFav,
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

  const isFav = launcher ? favorites.includes(launcher.key) : false;

  return (
    <div className="context-menu" ref={ref} style={style}>
      {launcher && (
        <>
          <div className="context-title">
            {launcher.label}
            {launcher.healthy === false && <span className="tag tag-danger">失效</span>}
          </div>
          <div className="context-sep" />
          <button className="context-item" onClick={() => { onToggleFav(launcher.key); onClose(); }}>
            {isFav ? "☆ 取消收藏" : "★ 收藏（置顶）"}
          </button>
          <button className="context-item" onClick={() => { onOpenFolder(launcher); onClose(); }}>
            打开所在文件夹
          </button>
          <button className="context-item" onClick={() => { onCopyPath(launcher); onClose(); }}>
            复制路径
          </button>
          <div className="context-sep" />
          <button className="context-item context-danger" onClick={() => { onRemove(launcher); onClose(); }}>
                        {launcher.healthy === false ? "✗ 移除（目录已失效）" : "移除启动脚本"}
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
