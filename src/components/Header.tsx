import claudeLogo from "../assets/claude-logo.png";
import { MoonIcon, SettingsIcon, SunIcon } from "./Icons";

interface Props {
  dark: boolean;
  claudeOk: boolean | null;
  missingCount: number;
  /** 当前供应商显示名（null = 未配置，显示「默认配置」） */
  providerName: string | null;
  onToggleTheme: () => void;
  onHealth: () => void;
  onProviders: () => void;
  onSettings: () => void;
}

export default function Header({
  dark,
  claudeOk,
  missingCount,
  providerName,
  onToggleTheme,
  onHealth,
  onProviders,
  onSettings,
}: Props) {
  return (
    <header className="header">
      <div className="brand">
        <img src={claudeLogo} className="brand-logo" alt="Claude" />
        <div>
          <h1>CC Desktop</h1>
          <div className="brand-sub">一键在你的项目目录中启动 Claude Code</div>
        </div>
      </div>
      <div className="header-actions">
        <button className="pill" title="供应商切换" onClick={onProviders}>
          <span className={`dot ${providerName ? "dot-ok" : ""}`} />
          {providerName ?? "默认配置"}
        </button>
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
