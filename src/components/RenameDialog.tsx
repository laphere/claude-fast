import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";

interface Props {
  sessionTitle: string;
  onClose: () => void;
  onRenamed: (newTitle: string) => void;
}

/** 会话重命名对话框：调用后端向 jsonl 追加 custom-title 行 */
export default function RenameDialog({ sessionTitle, onClose, onRenamed }: Props) {
  const [value, setValue] = useState(sessionTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (busy) return; // Enter 键直调 submit，不经按钮的 disabled
    const title = value.trim();
    if (!title) {
      setError("标题不能为空。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRenamed(title);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="重命名会话" width={460} onClose={onClose}>
      <div className="form">
        <label className="form-label">
          新名称（写入 jsonl 的 custom-title，Claude Code 官方 /rename 同机制）
        </label>
        <input
          ref={inputRef}
          className="input grow"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          maxLength={200}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "确定"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
