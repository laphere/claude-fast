import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "./Icons";

interface Props {
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  /** 可选底部操作条：渲染在滚动区外、固定于弹窗底部（内容超长时按钮也始终可见） */
  footer?: ReactNode;
}

/** 已挂载 Modal 的关闭栈：叠加弹窗（如 ConfirmDialog 盖在 HealthDialog 上）各自
 *  在 window 上监听 keydown 时，一次 Esc 会把所有层全部关掉（未保存的表单状态
 *  随之丢失）。Esc 只派发给栈顶（最后挂载）的那一层。 */
const modalStack: (() => void)[] = [];

/** 通用模态框外壳：遮罩 + 居中面板 + Esc 关闭 */
export default function Modal({ title, width = 520, onClose, children, footer }: Props) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 只有关闭处理器在栈顶的实例才响应；弹层内部自行处理 Esc 的不受影响
      if (modalStack[modalStack.length - 1] !== close) return;
      close();
    };
    modalStack.push(close);
    window.addEventListener("keydown", onKey);
    return () => {
      const i = modalStack.indexOf(close);
      if (i >= 0) modalStack.splice(i, 1);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

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
            <XIcon size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
