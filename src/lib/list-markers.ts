/**
 * 列表标记物化：把 marked 输出的 `<ol>` 编号、`<ul>` 圆点从原生 marker 换成
 * 真实文本节点。
 *
 * 为什么：Chromium 里原生列表标记（`<ol>` 的编号、`<ul>` 的圆点）画在 marker
 * box——既不进选区高亮（拖选时标记永远选不中），也不进纯文本剪贴板（Ctrl+C
 * 复制出去编号/圆点全丢）。与 linkifyHtml 同一条「消毒之后、DOM walk」的后处理
 * 链：对 HTML 字符串做正则替换会撞进标签/属性，DOM 层面插节点才安全。视觉由
 * styles.css 的 `ol.md-ol-numbered` / `ul.md-ul-bulleted` 一组规则接管（关原生
 * marker + 负 text-indent 复刻悬挂缩进），标记 span 用 inline-block 定宽占位、
 * 对拍原生 marker 列。
 *
 * 语义对齐原生：`ol` 从 `start` 起算（CommonMark：`5. x` → `<ol start="5">`）、
 * 逐项递增、与源文里的实际数字无关；`ul` 的圆点按嵌套层级取 disc/circle/square
 * （同原生的三级循环）；ol/ul 各自只处理自己的直接 li 子项，嵌套互不影响。
 */
/** 快速探针：没有 `<ol`/`<ul` 标签就不付 DOMParser 的开销（同 linkifyHtml 的 URL_PROBE 门） */
const LIST_PROBE = /<[ou]l[\s>]/i;

/** ul 圆点：同原生 disc / circle / square 的三级循环（更深层沿用 square） */
const UL_BULLETS = ["•", "◦", "▪"];

/** li 的标记宿主：疏列表（li 首子元素是 `<p>`）要把标记插进 p 里才能跟正文同 line box */
function markerHost(li: Element): Element {
  const first = li.firstElementChild;
  return first?.tagName === "P" ? first : li;
}

/** 列表的嵌套深度（含自身）：ul 圆点按层级换字形，与原生一致 */
function listDepth(list: Element): number {
  let d = 0;
  for (let p: Element | null = list; p; p = p.parentElement) {
    if (p.tagName === "UL" || p.tagName === "OL") d++;
  }
  return d;
}

/** 把标记文本 + 一个真实空格插到 li 开头（空格用文本节点，复制出去才是「标记 文本」） */
function insertMarker(doc: Document, li: Element, text: string, className: string): void {
  const marker = doc.createElement("span");
  marker.className = className;
  marker.textContent = text;
  const host = markerHost(li);
  host.insertBefore(marker, host.firstChild);
  host.insertBefore(doc.createTextNode(" "), marker.nextSibling);
}

/**
 * 给消毒后的 HTML 里的有序/无序列表插入可选中/可复制的标记文本
 * （MarkdownText 在 DOMPurify 之后调用）。没有 `<ol>`/`<ul>` 时原样返回。
 */
export function materializeListMarkers(html: string): string {
  if (!LIST_PROBE.test(html)) return html;
  // 防御性兜底：非渲染环境（单测的 node）没有 DOMParser，原样返回
  if (typeof DOMParser === "undefined") return html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html; // text/html 解析按规格不抛；防御性兜底
  }
  const body = doc.body;

  // querySelectorAll 按文档序返回（含嵌套）；class 由本函数自己加的，不会与消息
  // 原文冲突（消毒输出里的 class 是作者写的，重名也只是多条标记规则）
  for (const ol of Array.from(body.querySelectorAll("ol"))) {
    const startAttr = Number(ol.getAttribute("start"));
    let n = Number.isFinite(startAttr) && startAttr > 0 ? Math.trunc(startAttr) : 1;
    ol.classList.add("md-ol-numbered");
    for (const li of Array.from(ol.children)) {
      if (li.tagName !== "LI") continue;
      insertMarker(doc, li, `${n}.`, "md-ol-marker");
      n++;
    }
  }
  for (const ul of Array.from(body.querySelectorAll("ul"))) {
    ul.classList.add("md-ul-bulleted");
    const bullet = UL_BULLETS[Math.min(listDepth(ul) - 1, UL_BULLETS.length - 1)];
    for (const li of Array.from(ul.children)) {
      if (li.tagName !== "LI") continue;
      insertMarker(doc, li, bullet, "md-ul-marker");
    }
  }

  return body.innerHTML;
}
