import type { Launcher } from "../types";

interface Props {
  items: Launcher[];
  favorites: string[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onLaunch: (key: string) => void;
  onOpenFolder: (key: string) => void;
  onToggleFav: (key: string) => void;
  onContextMenu: (x: number, y: number, key: string) => void;
}

export default function ProjectList({
  items,
  favorites,
  selectedKey,
  onSelect,
  onLaunch,
  onOpenFolder,
  onToggleFav,
  onContextMenu,
}: Props) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">🗂</div>
        <div>没有找到匹配的项目</div>
        <div className="empty-sub">点击「批量添加」扫描工作区，或「新建」手动添加</div>
      </div>
    );
  }

  return (
    <div className="list">
      {items.map((l) => {
        const isFav = favorites.includes(l.key);
        const isSelected = l.key === selectedKey;
        return (
          <div
            key={l.key}
            className={`row ${isSelected ? "selected" : ""} ${l.healthy === false ? "broken" : ""}`}
            onClick={() => onSelect(l.key)}
            onDoubleClick={() => onLaunch(l.key)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSelect(l.key);
              onContextMenu(e.clientX, e.clientY, l.key);
            }}
          >
            <button
              className={`star ${isFav ? "star-on" : ""}`}
              title={isFav ? "取消收藏" : "收藏（置顶）"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFav(l.key);
              }}
            >
              ★
            </button>
            <div className="row-body">
              <div className="row-label">
                {l.label}
                {l.healthy === false && <span className="tag tag-danger">失效</span>}
              </div>
              <div className="row-path">{l.path ?? "（未解析到路径）"}</div>
            </div>
            {l.healthy !== false && (
              <div className="row-actions">
                <button
                  className="row-open"
                  title="打开项目文件夹"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenFolder(l.key);
                  }}
                >
                  📂
                </button>
                <button
                  className="row-launch"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLaunch(l.key);
                  }}
                >
                  启动
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
