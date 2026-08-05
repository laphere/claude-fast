import { useEffect, useState } from "react";
import type { Launcher } from "../types";
import { api } from "../lib/api";
import Modal from "./Modal";

interface Props {
  launchers: Launcher[];
  claudeOk: boolean | null;
  onClose: () => void;
  onDelete: (items: Launcher[]) => void;
}

/** 手动健康检查：打开时现场重新检查所有目录（后台执行，不卡界面） */
export default function HealthDialog({ launchers, claudeOk, onClose, onDelete }: Props) {
  const [checked, setChecked] = useState<Launcher[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setChecked(null);
    try {
      const results = await api.checkLaunchers(launchers.map((l) => l.path ?? ""));
      setChecked(launchers.map((l, i) => ({ ...l, healthy: results[i] ?? false })));
    } catch {
      setChecked(launchers);
    }
  };

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const missing = (checked ?? []).filter((l) => l.healthy === false);
  const summary =
    checked === null
      ? "正在检查项目目录…"
      : missing.length === 0
        ? "✓ 全部项目目录均存在"
        : `✗ 以下 ${missing.length} 个项目目录已不存在`;

  return (
    <Modal title="健康检查" width={620} onClose={onClose}>
      <div className="health">
        <div className="health-summary">
          <div>
            claude 命令：{claudeOk === null ? "检查中…" : claudeOk ? "✓ 可用" : "✗ 未找到"}
          </div>
          <div className={missing.length ? "text-danger" : ""}>{summary}</div>
        </div>

        {checked !== null && missing.length > 0 && (
          <div className="batch-list">
            {missing.map((l) => (
              <div key={l.key} className="batch-item">
                <div className="batch-item-body">
                  <div className="row-label">
                    {l.label} <span className="tag tag-danger">失效</span>
                  </div>
                  <div className="row-path">{l.path}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="form-actions">
          <button className="btn" onClick={run} disabled={checked === null}>
            {checked === null ? "检查中…" : "重新检查"}
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          {checked !== null && missing.length > 0 && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onDelete([...missing]);
              }}
            >
              {busy ? "删除中…" : `全部删除启动脚本（${missing.length}）`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
