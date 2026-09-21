import {
  BarChartIcon,
  FolderPlusIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  TrashIcon,
} from "./Icons";

interface Props {
  dark: boolean;
  claudeOk: boolean | null;
  missingCount: number;
  /** 当前供应商显示名（null = 未配置，显示「默认配置」） */
  providerName: string | null;
  /** 搜索面板是否展开（搜索按钮高亮） */
  searchOpen: boolean;
  /** 左栏项目列表是否已收起（按钮高亮） */
  sidebarCollapsed: boolean;
  onToggleTheme: () => void;
  onHealth: () => void;
  onProviders: () => void;
  onSettings: () => void;
  /** 展开/收起左栏搜索框（收起时清空关键词） */
  onToggleSearch: () => void;
  /** 收起/展开左栏项目列表（收起后内容区占满全宽） */
  onToggleSidebar: () => void;
  onNew: () => void;
  onBatch: () => void;
  onTrash: () => void;
  onStats: () => void;
}

export default function Header({
  dark,
  claudeOk,
  missingCount,
  providerName,
  searchOpen,
  sidebarCollapsed,
  onToggleTheme,
  onHealth,
  onProviders,
  onSettings,
  onToggleSearch,
  onToggleSidebar,
  onNew,
  onBatch,
  onTrash,
  onStats,
}: Props) {
  return (
    <header className="header">
      {/* 左侧仅侧栏开关：品牌区已按用户要求移除（窗口/任务栏标题仍有应用名） */}
      <div className="header-left">
        <button
          className={`icon-btn ${sidebarCollapsed ? "icon-btn-on" : ""}`}
          title={sidebarCollapsed ? "展开项目列表" : "收起项目列表"}
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon size={15} />
        </button>
      </div>
      <div className="header-actions">
        <button className="pill pill-provider" title="供应商切换" onClick={onProviders}>
          <span className={`dot ${providerName ? "dot-ok" : ""}`} />
          <span className="pill-text">{providerName ?? "默认配置"}</span>
        </button>
        <button
          className={`pill ${missingCount > 0 ? "pill-danger" : ""}`}
          title="健康检查"
          onClick={onHealth}
        >
          <span className={`dot ${claudeOk ? "dot-ok" : "dot-bad"}`} />
          <span className="pill-text">
            {claudeOk === null
              ? "检查中…"
              : claudeOk
                ? "claude 可用"
                : "claude 未找到"}
          </span>
          {missingCount > 0 && <span className="badge">{missingCount} 失效</span>}
        </button>
        {/* 原工具栏按钮上移至此（整行工具栏已撤，给内容区腾纵向空间），
            纯图标 + title（与设置/主题按钮同款 .icon-btn），在设置按钮之前 */}
        <div className="header-tools">
          <button
            className={`icon-btn ${searchOpen ? "icon-btn-on" : ""}`}
            onClick={onToggleSearch}
            title="搜索项目名或路径"
          >
            <SearchIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onNew} title="添加项目">
            <PlusIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onBatch} title="扫描 Claude Code 项目目录批量添加">
            <FolderPlusIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onTrash} title="回收站（删除的会话在这里，可恢复）">
            <TrashIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onStats} title="统计（token 用量 / 模型分布）">
            <BarChartIcon size={15} />
          </button>
        </div>
        <button className="icon-btn" title="设置" onClick={onSettings}>
          <SettingsIcon size={15} />
        </button>
        <button className="icon-btn" title={dark ? "切换到浅色" : "切换到深色"} onClick={onToggleTheme}>
          {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
        </button>
      </div>
    </header>
  );
}
