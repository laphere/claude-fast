import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  /** 可选底部操作条：渲染在滚动区外、固定于弹窗底部（内容超长时按钮也始终可见） */
  footer?: ReactNode;
}

/** 通用模态框外壳：遮罩 + 居中面板 + Esc 关闭 */
export default function Modal({ title, width = 520, onClose, children, footer }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="modal"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{title}</span>
          <button className="modal-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
