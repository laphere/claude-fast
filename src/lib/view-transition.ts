import { flushSync } from "react-dom";

/**
 * 在一次 View Transition 里同步提交 React 状态变更：浏览器对「旧画面 → 新画面」
 * 做快照 crossfade，**不碰真实布局**——这正是「大块区域 display 翻转」（主题全页换色、
 * 方案卡阅读模式整窗重排）想要的过渡：若用 CSS 高度动画，几百条消息的会话区每帧
 * reflow，长会话必卡。
 *
 * - flushSync 让回调里的 setState 在快照**之前**同步落到 DOM——React 18 的批处理
 *   否则会把渲染推迟到快照之后，新旧画面就一模一样了；
 * - `startViewTransition` 的 lib.dom 类型随 TS 版本走，这里用交叉类型自带判空，
 *   老类型定义下也能编译；
 * - prefers-reduced-motion / 不支持时直接执行（跟 CSS 那套一刀切同口径）。
 *
 * ⚠️ 只包「会引起大范围重绘/重排的状态翻转」，别拿来做高频更新：过渡期间真 DOM
 * 冻结为快照（默认 ~250ms），流式输出会晚这 250ms 才上屏。
 */
export function viewTransition(apply: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => unknown;
  };
  if (
    !doc.startViewTransition ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    apply();
    return;
  }
  doc.startViewTransition(() => flushSync(apply));
}
