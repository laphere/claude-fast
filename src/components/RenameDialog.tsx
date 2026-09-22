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
        <label className="form-label" htmlFor="rename-title">
          新名称
        </label>
        {/* ⚠️ 必须套一层 .form-row：`.grow`（flex:1）要有 flex 容器才生效，
            直接挂在 .form 下时它是个普通块，输入框会退回 <input> 的固有宽度
            （约 20 字，比弹窗窄一大截）。下面的「添加项目」同款用法 */}
        <div className="form-row">
          <input
            id="rename-title"
            ref={inputRef}
            className="input grow"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            maxLength={200}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        {/* 实现细节从 label 挪到输入框下面：label 要短到一眼扫完，
            「写到哪、跟谁同机制」是补充说明，不是字段名 */}
        <div className="form-hint">
          写入该会话 jsonl 的 custom-title 行，与 Claude Code 官方 /rename 同机制
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !value.trim()}>
            {busy ? "保存中…" : "确定"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
