import Modal from "./Modal";

interface Props {
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
  onCancel: () => void;
  onOk: () => void;
}

export default function ConfirmDialog({ title, message, okText = "确定", danger, onCancel, onOk }: Props) {
  return (
    <Modal title={title} width={460} onClose={onCancel}>
      <div className="confirm">
        <div className="confirm-message">{message}</div>
        <div className="form-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onOk}
            autoFocus
          >
            {okText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
