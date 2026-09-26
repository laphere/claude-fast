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
    // Esc / 遮罩关闭同样受 busy 拦截：操作进行中关掉确认框，
    // 用户会误以为已取消而操作仍在后台完成。
    // canClose 在**出场动画起播前**判定（onClose 里再拦就晚了——界面已淡走）
    <Modal title={title} width={460} onClose={onCancel} canClose={() => !busy}>
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
