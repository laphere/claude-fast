import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "./Icons";

interface Props {
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  /** 可选底部操作条：渲染在滚动区外、固定于弹窗底部（内容超长时按钮也始终可见） */
  footer?: ReactNode;
  /** 附加在 `.modal` 上的类名：给单个弹窗定制尺寸（如使用统计的定高面板） */
  className?: string;
}

/** 已挂载 Modal 的关闭栈：叠加弹窗（如 ConfirmDialog 盖在 HealthDialog 上）各自
 *  在 window 上监听 keydown 时，一次 Esc 会把所有层全部关掉（未保存的表单状态
 *  随之丢失）。Esc 只派发给栈顶（最后挂载）的那一层。 */
const modalStack: (() => void)[] = [];

/** 当前是否有弹层正开着。
 *  Esc 的**全局**快捷键（目前是会话页的「打断本轮」）必须据此让路：Modal 的 Esc 语义是
 *  关弹层，两者都挂在 window 上，不让路就会一次 Esc 既关弹层又把本轮打断。 */
export function isModalOpen(): boolean {
  return modalStack.length > 0;
}

/** 把一个「关掉这一层」的处理器压进弹层栈（挂载时入栈、卸载时出栈）：Esc 只派发给
 *  栈顶那一层。Modal 与自绘弹层（图片预览）共用——自绘弹层也必须走这里，否则
 *  isModalOpen() 对它不成立，会话页里按 Esc 会既关预览又打断本轮。
 *
 *  可选 `onKey`：本层在栈顶时收到**除 Esc 以外**的按键（图片预览的左右方向键）。
 *  走这个口子而不是自己再挂一个 window 监听，键盘行为就统一归栈顶那一层管。 */
export function useModalLayer(onClose: () => void, onKey?: (e: KeyboardEvent) => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  useEffect(() => {
    const close = () => onCloseRef.current();
    const handler = (e: KeyboardEvent) => {
      // 只有关闭处理器在栈顶的实例才响应；弹层内部自行处理 Esc 的不受影响
      if (modalStack[modalStack.length - 1] !== close) return;
      if (e.key === "Escape") {
        close();
        return;
      }
      onKeyRef.current?.(e);
    };
    modalStack.push(close);
    window.addEventListener("keydown", handler);
    return () => {
      const i = modalStack.indexOf(close);
      if (i >= 0) modalStack.splice(i, 1);
      window.removeEventListener("keydown", handler);
    };
  }, []);
}

/** 通用模态框外壳：遮罩 + 居中面板 + Esc 关闭 */
export default function Modal({ title, width = 520, onClose, children, footer, className }: Props) {
  useModalLayer(onClose);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className={className ? `modal ${className}` : "modal"}
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
