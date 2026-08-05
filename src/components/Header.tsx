interface Props {
  dark: boolean;
  claudeOk: boolean | null;
  missingCount: number;
  onToggleTheme: () => void;
  onHealth: () => void;
}

export default function Header({ dark, claudeOk, missingCount, onToggleTheme, onHealth }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <div className="brand-logo">C</div>
        <div>
          <h1>Claude Code 快速启动</h1>
          <div className="brand-sub">一键在你的项目目录中启动 Claude Code</div>
        </div>
      </div>
      <div className="header-actions">
        <button
          className={`pill ${missingCount > 0 ? "pill-danger" : ""}`}
          title="健康检查"
          onClick={onHealth}
        >
          <span className={`dot ${claudeOk ? "dot-ok" : "dot-bad"}`} />
          {claudeOk === null
            ? "检查中…"
            : claudeOk
              ? "claude 可用"
              : "claude 未找到"}
          {missingCount > 0 && <span className="badge">{missingCount} 失效</span>}
        </button>
        <button className="icon-btn" title={dark ? "切换到浅色" : "切换到深色"} onClick={onToggleTheme}>
          {dark ? "☀" : "🌙"}
        </button>
      </div>
    </header>
  );
}
