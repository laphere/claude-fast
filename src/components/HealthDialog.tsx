import { useEffect, useState } from "react";
import type { ClaudeUpdateStatus, Project } from "../types";
import { api } from "../lib/api";
import Modal from "./Modal";

interface Props {
  items: Project[];
  claudeOk: boolean | null;
  onClose: () => void;
  onDelete: (items: Project[]) => void;
}

/** Windows 上显示 Win 环境徽标（对齐 cc-switch 的本地环境检查卡片） */
const IS_WINDOWS = navigator.userAgent.includes("Windows");

type UpgradeTip = { kind: "ok" | "warn" | "error"; text: string; log?: string };

/** 手动健康检查：打开时现场重新检查所有目录（后台执行，不卡界面）。
 *  「清除」交给 App 弹确认框：从列表移除 + 删除 Claude Code 会话数据 */
export default function HealthDialog({ items, claudeOk, onClose, onDelete }: Props) {
  const [checked, setChecked] = useState<Project[] | null>(null);
  const [verStatus, setVerStatus] = useState<ClaudeUpdateStatus | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeTip, setUpgradeTip] = useState<UpgradeTip | null>(null);

  const run = async () => {
    setChecked(null);
    try {
      const results = await api.checkProjects(items.map((l) => l.path));
      setChecked(items.map((l, i) => ({ ...l, healthy: results[i] ?? false })));
    } catch {
      setChecked(items);
    }
  };

  /** 检查 Claude Code 本地版本 vs npm 最新版（null 表示检查失败/未完成） */
  const refreshVersion = async (): Promise<ClaudeUpdateStatus | null> => {
    try {
      const s = await api.claudeUpdateStatus();
      setVerStatus(s);
      return s;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    run();
    refreshVersion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rerunAll = () => {
    setUpgradeTip(null);
    run();
    refreshVersion();
  };

  /** 一键升级：完成后自动重查版本；版本没动（仍可升级）按 cc-switch 语义告警 */
  const handleUpgrade = async () => {
    if (upgrading) return;
    setUpgrading(true);
    setUpgradeTip(null);
    try {
      const msg = await api.claudeRunUpgrade();
      const next = await refreshVersion();
      if (next?.updateAvailable) {
        setUpgradeTip({ kind: "warn", text: "升级命令已执行，但版本未变化", log: msg });
      } else if (next?.currentVersion) {
        setUpgradeTip({ kind: "ok", text: `✓ 已升级到 ${next.currentVersion}` });
      } else {
        setUpgradeTip({ kind: "warn", text: "升级命令已执行，但重新检查失败", log: msg });
      }
    } catch (e) {
      const text = String(e);
      setUpgradeTip(
        text.length > 160
          ? { kind: "error", text: "升级命令执行失败", log: text }
          : { kind: "error", text },
      );
    } finally {
      setUpgrading(false);
    }
  };

  const missing = (checked ?? []).filter((l) => l.healthy === false);
  const summary =
    checked === null
      ? "正在检查项目目录…"
      : missing.length === 0
        ? "✓ 全部项目目录均存在"
        : `✗ 以下 ${missing.length} 个项目目录已不存在`;

  const badge = verStatus
    ? verStatus.updateAvailable
      ? <span className="tag tag-warn">可升级</span>
      : verStatus.currentVersion && verStatus.latestVersion
        ? <span className="tag tag-ok">已是最新</span>
        : null
    : null;

  return (
    <Modal title="健康检查" width={620} onClose={onClose}>
      <div className="health">
        <div className="health-summary">
          <div>
            claude 命令：{claudeOk === null ? "检查中…" : claudeOk ? "✓ 可用" : "✗ 未找到"}
          </div>
          <div className={missing.length ? "text-danger" : ""}>{summary}</div>
        </div>

        <div className="env-section">本地环境检查</div>
        <div className="env-check">
          <div className="env-check-head">
            <div className="env-check-title">
              Claude Code
              {IS_WINDOWS && <span className="env-badge">Win</span>}
            </div>
            {badge}
          </div>
          <div className="env-rows">
            <div className="env-row">
              <span className="env-label">当前版本</span>
              <span className="env-value">
                {verStatus ? (verStatus.currentVersion ?? "—") : "检查中…"}
              </span>
            </div>
            <div className="env-row">
              <span className="env-label">最新版本</span>
              <span className="env-value">
                {verStatus ? (verStatus.latestVersion ?? "—") : "检查中…"}
              </span>
            </div>
          </div>
          {verStatus?.currentError && (
            <div className="env-error">{verStatus.currentError}</div>
          )}
          {verStatus?.latestError && (
            <div className="env-error">{verStatus.latestError}</div>
          )}
          {upgradeTip && (
            <div className={`env-tip env-tip-${upgradeTip.kind}`}>
              {upgradeTip.text}
              {upgradeTip.log && <pre className="env-log">{upgradeTip.log}</pre>}
            </div>
          )}
        </div>

        {checked !== null && missing.length > 0 && (
          <div className="batch-list">
            {missing.map((l) => (
              <div key={l.key} className="batch-item">
                <div className="batch-item-body">
                  <div className="row-label">
                    {l.name} <span className="tag tag-danger">失效</span>
                  </div>
                  <div className="row-path">{l.path}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="form-actions">
          {verStatus?.updateAvailable && (
            <button
              className="btn btn-primary"
              onClick={handleUpgrade}
              disabled={upgrading}
            >
              {upgrading ? "升级中…" : "升级"}
            </button>
          )}
          <button className="btn" onClick={rerunAll} disabled={checked === null}>
            {checked === null ? "检查中…" : "重新检查"}
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          {checked !== null && missing.length > 0 && (
            <button className="btn btn-danger" onClick={() => onDelete([...missing])}>
              清除失效项目（{missing.length}）
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
