import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  /** 是否允许关闭（**出场动画起播前**检查）：ConfirmDialog 操作进行中（busy）时
   *  用它拦下 Esc/遮罩关闭——动画播完了才问就晚了，界面已经淡走又弹回来 */
  canClose?: () => boolean;
}

/** 出场动画时长（styles.css 里 .overlay.closing 的 --dur-fast=100ms + 一点余量）。
 *  Toast / ImageLightbox 的出场也用它，别各写一份漂移。 */
export const MODAL_EXIT_MS = 110;

/** 已挂载 Modal 的关闭栈：叠加弹窗（如 ConfirmDialog 盖在 HealthDialog 上）各自
 *  在 window 上监听 keydown 时，一次 Esc 会把所有层全部关掉（未保存的表单状态
 *  随之丢失）。Esc 只派发给栈顶（最后挂载）的那一层。 */
const modalStack: (() => void)[] = [];

/** 出场动画执行器栈（与 modalStack 平行，每个 Modal 挂载时注册一个）。
 *  用途：App 侧「对话框里的按钮」关闭路径不经过 Modal（按钮在 children 里、
 *  直接调 App 回调清 state → 硬卸载、没有出场帧），把那些回调包一层
 *  animateModalClose 就能统一先播动画再卸载。 */
const closeAnimators: ((done: () => void, force: boolean) => void)[] = [];

/** 请求**栈顶**弹窗播出场动画，播完执行 done（宿主在 done 里清 state 真卸载）。
 *  - 没有任何 Modal 挂着时立即执行 done（防御性，正常不会有这种调用）；
 *  - 重入安全：栈顶已在出场流程里（比如 Modal 自己的 Esc 先起了动画，宿主回包的
 *    onClose 里又包了一层本函数）时直接结算 done，不再起新一轮——否则会无限接力。
 *  - canClose 拒绝时既不动画也不结算（这次关闭请求被吞掉，弹窗保持原样）。
 *  - ⚠️ force（默认 false）给「对话框按钮 / 动作已成功完成」的关闭路径传 true：
 *    canClose 只该拦**环境关闭**（Esc/遮罩）——动作成功那一刻 busy 还是 true
 *    （handleOk 的 finally 没跑），不 force 会被拦成「确定按了不关、再按重跑一遍
 *    破坏性操作」（2026-09-26 code review 实锤的四条确认流程全中）。
 *  - ⚠️ 调用前提是「这个弹窗确实挂载着」——它按**栈顶**定标，若目标弹窗因渲染
 *    条件不满足而没挂载（如供应商弹窗 state 为空），会错打到当前开着的其他弹窗
 *    （把人家淡到透明还等不到 onClose）。这种场景直接清 state，别走本函数。 */
export function animateModalClose(done: () => void, force = false) {
  const top = closeAnimators[closeAnimators.length - 1];
  if (!top) {
    done();
    return;
  }
  top(done, force);
}

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

/** 通用模态框外壳：遮罩 + 居中面板 + Esc 关闭。
 *  出场动画：自身三条关闭路径（Esc / 遮罩 / 右上 X）先切 .closing 播 CSS 出场，
 *  MODAL_EXIT_MS 后才调 onClose 让宿主清 state 真卸载——React 条件渲染下没有
 *  「卸载后再播一段」的机会，动画必须在卸载前播。 */
export default function Modal({
  title,
  width = 520,
  onClose,
  children,
  footer,
  className,
  canClose,
}: Props) {
  const [closing, setClosing] = useState(false);
  // closing 的同步镜像：animator 里要在同一轮读它（setClosing 是异步的）
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const canCloseRef = useRef(canClose);
  canCloseRef.current = canClose;

  // 自己的关闭路径统一走模块级 animateModalClose（栈顶=自己，语义一致无特例）
  const close = useCallback(() => {
    animateModalClose(() => onCloseRef.current());
  }, []);

  useModalLayer(close);

  // 注册出场动画执行器：按钮路径（宿主包 animateModalClose）也落到这里
  useEffect(() => {
    const animator = (done: () => void, force: boolean) => {
      if (closingRef.current) {
        done();
        return;
      }
      // canClose 只拦环境关闭（Esc/遮罩）；按钮/动作成功路径 force=true 直通
      if (!force && canCloseRef.current && !canCloseRef.current()) return;
      closingRef.current = true;
      setClosing(true);
      window.setTimeout(done, MODAL_EXIT_MS);
    };
    closeAnimators.push(animator);
    return () => {
      const i = closeAnimators.indexOf(animator);
      if (i >= 0) closeAnimators.splice(i, 1);
    };
  }, []);

  // 已知边界：出场那 ~110ms 里宿主再次「打开同一个弹窗」（state 本就没清、set 同值
  // 不触发渲染）会被这次已排定的卸载吞掉，用户需再点一次。窗口极小且无害，不为此
  // 加「重开撤销出场」的复杂度。
  return (
    <div className={closing ? "overlay closing" : "overlay"} onMouseDown={close}>
      <div
        className={className ? `modal ${className}` : "modal"}
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{title}</span>
          <button className="modal-close" onClick={close} title="关闭">
            <XIcon size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
