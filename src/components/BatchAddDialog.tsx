import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { WorkspaceProject } from "../types";
import Modal from "./Modal";

interface Props {
  workspaceRoot: string;
  onClose: () => void;
  onDone: (createdCount: number) => void;
}

export default function BatchAddDialog({ workspaceRoot, onClose, onDone }: Props) {
  const [projects, setProjects] = useState<WorkspaceProject[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api
      .scanWorkspace()
      .then((list) => {
        setProjects(list);
        setChecked(new Set(list.map((p) => p.path)));
      })
      .catch((e) => setResult("扫描失败：" + String(e)));
  }, []);

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submit = async () => {
    const targets = (projects ?? []).filter((p) => checked.has(p.path));
    setBusy(true);
    setResult(null);
    let created = 0;
    const errors: string[] = [];
    for (const p of targets) {
      try {
        const r = await api.createLauncher(p.path);
        if (!r.existed) created++;
      } catch (e) {
        errors.push(`${p.name}: ${e}`);
      }
    }
    setBusy(false);
    setResult(
      `成功处理 ${targets.length} 个（新增 ${created} 个，其余已存在）。` +
        (errors.length ? `\n失败 ${errors.length} 个：\n${errors.join("\n")}` : ""),
    );
    if (!errors.length) {
      onDone(created);
    }
  };

  return (
    <Modal title="批量添加启动脚本" width={640} onClose={onClose}>
      <div className="batch">
        <div className="form-label">
          扫描到 {projects?.length ?? "…"} 个含 <code>CLAUDE.md</code> 或{" "}
          <code>.git</code> 的项目（{workspaceRoot} 下最多 3 层目录），勾选后一键生成：
        </div>
        <div className="batch-list">
          {!projects &&
            Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton" />)}
          {projects?.map((p) => (
            <label key={p.path} className="batch-item">
              <input
                type="checkbox"
                checked={checked.has(p.path)}
                onChange={() => toggle(p.path)}
              />
              <div className="batch-item-body">
                <div className="row-label">{p.name}</div>
                <div className="row-path">{p.path}</div>
              </div>
            </label>
          ))}
          {projects && projects.length === 0 && (
            <div className="empty">工作区中没有发现符合条件的项目</div>
          )}
        </div>
        {result && <div className="form-error">{result}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !projects || checked.size === 0}
          >
            {busy ? "生成中…" : `生成启动脚本（${checked.size}）`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
