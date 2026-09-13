import { useState } from "react";
import Modal from "./Modal";

interface Props {
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
  onCancel: () => void;
  onOk: () => void | Promise<void>;
}

export default function ConfirmDialog({ title, message, okText = "确定", danger, onCancel, onOk }: Props) {
  // onOk 常为异步操作（移除/清除等），执行期间必须禁用按钮：
  // 双击会把删除循环跑两遍，或对已移除的项目再次操作弹出误导性报错
  const [busy, setBusy] = useState(false);
  const handleOk = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onOk();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} width={460} onClose={onCancel}>
      <div className="confirm">
        <div className="confirm-message">{message}</div>
        <div className="form-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={handleOk}
            disabled={busy}
            autoFocus
          >
            {okText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
