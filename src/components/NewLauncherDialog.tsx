import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import Modal from "./Modal";

interface Props {
  workspaceRoot: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function NewLauncherDialog({ workspaceRoot, onClose, onCreated }: Props) {
  const [dir, setDir] = useState(workspaceRoot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择项目文件夹",
    });
    if (typeof picked === "string") setDir(picked);
  };

  const submit = async () => {
    const d = dir.trim().replace(/^"+|"+$/g, "");
    if (!d) {
      setError("请输入或选择项目文件夹路径。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createLauncher(d);
      onCreated();
      // 提示覆盖/新建结果
      const action = result.existed ? "已覆盖" : "已创建";
      alert(`已${action}启动脚本：\n${result.file}`); // eslint-disable-line no-alert
    } catch (e) {
      setError(String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <Modal title="新建 Claude 启动脚本" width={560} onClose={onClose}>
      <div className="form">
        <label className="form-label">项目文件夹路径（可手动输入，或点「浏览…」选择）</label>
        <div className="form-row">
          <input
            className="input grow"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="btn" onClick={browse}>
            浏览…
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "创建中…" : "确定"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
