/**
 * 代码块的一键复制：给每个围栏代码块（<pre>）右上角加「复制」按钮，点击把代码
 * 原文写入剪贴板——长交接提示词/命令块不再需要手动拖选 + Ctrl+C。
 *
 * 拆两件事（与 lib/links.ts 的 linkifyHtml + installCtrlLinkOpen 同构）：
 *
 * 1) decorateCodeBlocks —— MarkdownText 管线里消毒**之后**的 DOM walk：把每个
 *    <pre> 包进 div.md-code 并前置按钮。放在消毒之后自己建节点，而不是在
 *    highlight.ts 的 renderCode 里拼 HTML 字符串：那条路要再过一遍消毒白名单，
 *    svg 图标能不能活下来是个不必要的赌注；DOM 层面建好的节点随 innerHTML
 *    序列化就是最终 HTML，之后没人再动它。
 *
 * 2) installCodeCopy —— 全局装一次的点击委托（捕获阶段，同 installCtrlLinkOpen）：
 *    dangerouslySetInnerHTML 注入的 DOM 上没有 React 事件可挂，只能委托；
 *    点击命中按钮时取同块 <pre><code> 的 textContent 写剪贴板
 *    （navigator.clipboard——App 的「复制路径」同一条通道），成功后按钮短暂
 *    翻成「已复制」。
 *
 * 与 highlight.ts / links.ts 同款「模块顶层装一次」模式（由 MessageParts.tsx 调用）。
 */

/** 按钮提示文案 */
const COPY_TITLE = "复制代码";

/** Lucide 风格线性图标（copy / check，与 Icons.tsx 同一套形；stroke-width 2）。
 *  这里是字符串不是 React 组件——按钮建在 DOM walk 里，挂不了 JSX。 */
const ICON_COPY =
  '<svg class="ic-copy" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_CHECK =
  '<svg class="ic-check" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** 建一颗复制按钮（建在 DOMParser 的 doc 里，随后随 body.innerHTML 序列化）。
 *  两套图标/文案都进标记，复制成功态只靠 .copied 一颗 class 切换（styles.css）。 */
function buildButton(doc: Document): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "md-code-copy";
  btn.setAttribute("title", COPY_TITLE);
  btn.setAttribute("aria-label", COPY_TITLE);
  btn.innerHTML =
    ICON_COPY +
    ICON_CHECK +
    '<span class="t-idle">复制</span><span class="t-done">已复制</span>';
  return btn;
}

/**
 * 给消毒后的 HTML 包代码块 + 复制按钮（MarkdownText 在 DOMPurify 之后调用）。
 * HTML 里没有 <pre> 时原样返回——大多数消息没有代码块，免付 DOMParser 开销
 * （同 linkifyHtml / materializeListMarkers 的快速门）。
 */
export function decorateCodeBlocks(html: string): string {
  if (!html.includes("<pre")) return html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html; // text/html 解析按规格不抛；防御性兜底
  }
  const pres = Array.from(doc.body.querySelectorAll("pre"));
  if (pres.length === 0) return html;
  for (const pre of pres) {
    // 防御：已在 .md-code 里的不重复包（正常管线只走一遍，防调用方叠加）
    if (pre.parentElement?.classList.contains("md-code")) continue;
    const wrap = doc.createElement("div");
    wrap.className = "md-code";
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(buildButton(doc));
    wrap.appendChild(pre);
  }
  return doc.body.innerHTML;
}

let installed = false;
/** 每颗按钮的在飞定时器：成功反馈期间再点，重置计时而不是让上一轮提前清掉状态 */
const copiedTimers = new WeakMap<Element, number>();

/**
 * 装全局点击委托（幂等；MessageParts.tsx 模块顶层调用，见文件头注释）。
 * 捕获阶段挂 document：innerHTML 注入的 DOM 没有 React 事件，与
 * installCtrlLinkOpen 同一套委托位。不 preventDefault——按钮的默认激活
 * （键盘 Enter/Space 也会合成 click）就是要走的路。
 */
export function installCodeCopy(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "click",
    (e) => {
      if (!(e instanceof MouseEvent)) return;
      const target = e.target instanceof Element ? e.target : null;
      const btn = target?.closest("button.md-code-copy");
      if (!btn) return;
      const code = btn.closest(".md-code")?.querySelector("pre code");
      // 围栏正文按 CommonMark 带一个行尾换行（"code\n"）——那是围栏语法自带的
      // 不是代码内容，剥掉一层，粘进终端不会凭空多执行一次回车
      const text = (code?.textContent ?? "").replace(/\n$/, "");
      if (text === "") return;
      navigator.clipboard.writeText(text).then(
        () => {
          btn.classList.add("copied");
          const prev = copiedTimers.get(btn);
          if (prev !== undefined) window.clearTimeout(prev);
          copiedTimers.set(
            btn,
            window.setTimeout(() => btn.classList.remove("copied"), 1600),
          );
        },
        (err) => console.warn("复制代码块失败：", err),
      );
    },
    true,
  );
}
