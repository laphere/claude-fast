interface Props {
  search: string;
  onSearch: (v: string) => void;
  canLaunch: boolean;
  onLaunch: () => void;
  onNew: () => void;
  onBatch: () => void;
  onHealth: () => void;
  onOpenFolder: () => void;
}

export default function Toolbar(props: Props) {
  const { search, onSearch, canLaunch, onLaunch, onNew, onBatch, onHealth, onOpenFolder } = props;
  return (
    <div className="toolbar">
      <div className="search-box">
        <span className="search-icon">⌕</span>
        <input
          className="search-input"
          placeholder="搜索项目名或路径…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          spellCheck={false}
        />
        {search && (
          <button className="search-clear" onClick={() => onSearch("")} title="清除">
            ×
          </button>
        )}
      </div>
      <div className="toolbar-actions">
        <button className="btn btn-primary" onClick={onLaunch} disabled={!canLaunch} title="双击项目也可启动">
          启 动
        </button>
        <button className="btn" onClick={onNew}>
          新 建
        </button>
        <button className="btn" onClick={onBatch}>
          批量添加
        </button>
        <button className="btn" onClick={onHealth}>
          健康检查
        </button>
        <button className="btn" onClick={onOpenFolder}>
          打开文件夹
        </button>
      </div>
    </div>
  );
}
