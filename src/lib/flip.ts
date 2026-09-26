import { useLayoutEffect, useRef, type RefObject } from "react";

/** 让位动画时长（WAAPI 的 duration 是 JS 数值取不了 CSS token；与 --dur-slow 同量级略短） */
const FLIP_MS = 200;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * FLIP（First-Last-Invert-Play）让位动画：React 重排是瞬时的，这里在**每次提交后**
 * 量一遍子元素相对容器的位置，与上一轮的差值 = 本轮位移 → 用 Web Animations API
 * 从「反向偏移」归零播放，用户看到的就是「从旧位置滑到新位置」。用于两处拖拽面：
 * 项目列表（`.row-wrap`）与 tab 栏（`.chat-tab`）。
 *
 * 设计要点（改前先读，都是踩过才会写下来的）：
 * - **effect 不带依赖数组**（每次提交都跑）：基线必须是「上一轮提交后的位置」——
 *   tab 标题变宽这类**不经签名**的位置变化也要刷新基线，否则下一次重排会拿陈旧坐标
 *   算 delta，让位动画从错误的位置起飞。
 * - **只在签名变化的那一轮播**：签名只认「顺序/成员」（id 列表 join）；认内容会误播。
 *   挂 enabled 把「展开/收起改变行高 → 下方行位移」也纳入签名（ProjectList）。
 * - 坐标取**相对容器**：列表滚动 / 容器自身被移动（左栏抽屉动画）时容器与子元素
 *   同步抖动，相减即免疫。
 * - 新挂载的元素不在上一轮基线里 → 跳过：进场交给 CSS 的 mount 动画（row-in/tab-in），
 *   两种机制各管一半，别重叠。
 * - 播放前先 cancel 尚在飞的 FLIP（getBoundingClientRect **含 transform**，不取消
 *   会把「飞行中」的偏移量进基线）；快速连续拖拽时这一下会瞬时落位再起新动画，可接受。
 * - prefers-reduced-motion 的 CSS 全局一刀切管不到 WAAPI，这里自己查。
 *
 * @param selector 参与让位的子元素选择器（容器内按类挑，避免把插入指示等杂项量进去）
 * @param signature 顺序签名；与上一轮不同 = 本轮播；首次（null）只建基线不播
 * @param enabled false = 只记基线不播（项目列表搜索过滤期间：逐键重排，播了反而抖）
 */
export function useFlip(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  signature: string,
  enabled: boolean,
): void {
  /** 上一轮提交后各子元素相对容器的位置（= 用户看到的「旧位置」） */
  const posRef = useRef(new Map<Element, { top: number; left: number }>());
  const sigRef = useRef<string | null>(null);
  /** 在飞的 FLIP 动画（cancel 用；CSS 的 mount 动画不进这里，进场不受影响） */
  const animsRef = useRef(new Set<Animation>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 先取消在飞的 FLIP：cancel = 元素瞬间落到真实布局位，后续量测才干净
    for (const a of animsRef.current) a.cancel();
    animsRef.current.clear();

    const els = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const prev = posRef.current;
    const animate = enabled && sigRef.current !== null && sigRef.current !== signature;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const base = container.getBoundingClientRect();
    const next = new Map<Element, { top: number; left: number }>();
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const pos = { top: r.top - base.top, left: r.left - base.left };
      next.set(el, pos);
      if (!animate || reduce) continue;
      const before = prev.get(el);
      if (!before) continue; // 新挂载：进场归 CSS mount 动画管
      const dx = before.left - pos.left;
      const dy = before.top - pos.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const anim = el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ],
        { duration: FLIP_MS, easing: FLIP_EASING },
      );
      animsRef.current.add(anim);
      // cancel() 会让 finished reject，两种收场都出队
      anim.finished.then(
        () => animsRef.current.delete(anim),
        () => animsRef.current.delete(anim),
      );
    }
    posRef.current = next;
    sigRef.current = signature;
  });
}
