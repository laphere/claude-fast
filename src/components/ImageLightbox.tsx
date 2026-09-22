import { useState } from "react";
import { useModalLayer } from "./Modal";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "./Icons";
import type { ChatImage } from "../types";

/**
 * 图片大图预览（点会话里发出的图片 / 待发送附件打开）。
 *
 * - **可切换**：`images` 是**同一条消息**里的那几张（一次发 3 张就在这 3 张里翻），
 *   左右方向键或两侧箭头前后翻——不必「点开一张 → 关掉 → 再点下一张」。
 *   到两端即止、不循环，并显示 `n / 总数`。切换范围刻意不跨消息：跨消息翻会让
 *   「我现在看的是哪一条发的图」失去边界。
 * - 缩放：默认「适应窗口」（`max-width/height` 只缩不放，小图保持原尺寸）；
 *   截图类图片缩到窗口里往往看不清字，再点一下图片即切到**原始尺寸**，此时遮罩可
 *   滚动（`.lightbox-img` 用 `margin: auto` 居中——flex 容器里直接靠 align-items
 *   居中，内容一旦超出容器，顶部/左侧会被裁掉且滚不到）。
 * - 关闭：Esc / 点图片以外的遮罩 / 右上角按钮。
 * - 键盘（Esc 与左右方向键）走 `useModalLayer` 而不是自己监听：会话页有个全局
 *   Esc（打断本轮），不让它知道预览开着，一次 Esc 会既关预览又打断本轮。
 */
export default function ImageLightbox({
  images,
  startIndex = 0,
  onClose,
}: {
  images: ChatImage[];
  /** 从哪一张打开（= 点的那张在列表里的下标，默认第一张） */
  startIndex?: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIndex);
  const [actual, setActual] = useState(false);
  // 列表在预览期间可能被清空/换掉（实时区刷新 → 重新读盘），索引按当前长度夹一次
  const i = Math.min(idx, images.length - 1);
  const hasPrev = i > 0;
  const hasNext = i < images.length - 1;

  const go = (step: number) => {
    setIdx(i + step);
    setActual(false); // 换图回到「适应窗口」，别把上一张的缩放态带过来
  };

  useModalLayer(onClose, (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const step = e.key === "ArrowLeft" ? -1 : 1;
      if (step < 0 ? !hasPrev : !hasNext) return;
      // 箭头键默认会让可滚动遮罩滚动，不拦掉就会「翻一张 + 滚一段」
      e.preventDefault();
      go(step);
    }
  });

  if (images.length === 0) return null;
  const image = images[i];

  return (
    <div
      className="overlay lightbox"
      // 只在点遮罩本身时关（图片、按钮都不是遮罩）；用 target 判定而不是让子元素
      // 各自 stopPropagation —— 少一处忘了写就变成「点上一张/下一张顺手把预览关了」
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <img
        className={`lightbox-img${actual ? " is-actual" : ""}`}
        src={`data:${image.mediaType};base64,${image.data}`}
        alt="图片预览"
        title={actual ? "点击缩回适应窗口" : "点击查看原始尺寸"}
        onClick={() => setActual((v) => !v)}
      />
      {images.length > 1 && (
        <>
          <button
            className="lightbox-nav lightbox-prev"
            disabled={!hasPrev}
            onClick={() => go(-1)}
            title="上一张（←）"
            aria-label="上一张"
          >
            <ChevronLeftIcon size={20} />
          </button>
          <button
            className="lightbox-nav lightbox-next"
            disabled={!hasNext}
            onClick={() => go(1)}
            title="下一张（→）"
            aria-label="下一张"
          >
            <ChevronRightIcon size={20} />
          </button>
          <span className="lightbox-counter">
            {i + 1} / {images.length}
          </span>
        </>
      )}
      <button className="lightbox-close" title="关闭（Esc）" onClick={onClose}>
        <XIcon size={16} />
      </button>
    </div>
  );
}
