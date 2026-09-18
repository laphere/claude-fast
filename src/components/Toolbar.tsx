import { BarChartIcon, FolderPlusIcon, PlusIcon, SearchIcon, TrashIcon, XIcon } from "./Icons";

interface Props {
  search: string;
  onSearch: (v: string) => void;
  onNew: () => void;
  onBatch: () => void;
  onTrash: () => void;
  onStats: () => void;
}

export default function Toolbar(props: Props) {
  const { search, onSearch, onNew, onBatch, onTrash, onStats } = props;
  return (
    <div className="toolbar">
      <div className="search-box">
        <span className="search-icon">
          <SearchIcon size={15} />
        </span>
        <input
          className="search-input"
          placeholder="搜索项目名或路径…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          spellCheck={false}
        />
        {search && (
          <button className="search-clear" onClick={() => onSearch("")} title="清除">
            <XIcon size={12} />
          </button>
        )}
      </div>
      <div className="toolbar-actions">
        <button className="btn" onClick={onNew}>
          <PlusIcon />
          新建
        </button>
        <button className="btn" onClick={onBatch}>
          <FolderPlusIcon />
          批量添加
        </button>
        <button className="btn" onClick={onTrash} title="删除的会话在这里，可恢复">
          <TrashIcon />
          回收站
        </button>
        <button className="btn" onClick={onStats} title="token 用量 / 成本 / 模型分布统计">
          <BarChartIcon />
          统计
        </button>
      </div>
    </div>
  );
}
