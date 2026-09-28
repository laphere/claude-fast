/**
 * 会话正文里的 URL 可点开：补链 + Ctrl 按住点亮 + Ctrl+点击用系统默认浏览器打开。
 * （手势 2026-09-28 订正：最初按用户口述做成 Alt，后澄清是 Ctrl——VS Code 编辑器/
 *  终端同款；macOS 惯例是 Cmd，要支持时再加平台分支，别一刀切换。）
 *
 * 分两件事：
 *
 * 1) linkifyHtml —— 给 marked+DOMPurify 渲染出来的 HTML「补链」。marked 只会把
 *    **纯文本**里的裸 URL 自动链接（GFM），行内代码/代码块里的一律是纯文本——
 *    而模型恰恰爱把地址塞进反引号（「服务已起：`http://127.0.0.1:17642`」）。
 *    补链做在消毒**之后**、以 DOM walk 的方式包 `<a>`：对 HTML 字符串做正则替换
 *    会撞进标签/属性把标记改坏，DOM 层面则碰不到它们。顺手修 marked 自动链接
 *    的一个坑：URL 后紧跟中文全角标点时它会把标点连同后文一起吞进 href
 *    （实测 `（https://example.com/x）里也有` → href="…x%EF%BC%89%E9%87%8C…"），
 *    以前点不开无所谓，可点开后这就是「点了打开坏网址」，见 repairAutoLink。
 *
 * 2) installCtrlLinkOpen —— 全局装一次的监听：Ctrl 按下把 class 挂到 <html> 上
 *    （styles.css 的 `html.ctrl-links .md-body a` 据此点亮），Ctrl+点击则把 href
 *    交给 open_url（后端只放行 http/https，系统默认浏览器打开——与供应商弹窗
 *    外链同一条通道）。
 *    ⚠️ 按住态**不走 React state**：保活的非激活 tab（display:none）会跟着
 *    state 整棵消息树重渲染，长会话下按一次 Ctrl 白渲染两回；class + CSS 零渲染。
 *    与 lib/highlight.ts 的 installMarkdownHighlighting 同款「模块顶层装一次」
 *    模式（由 MessageParts.tsx 顶层调用）。
 */
import { api } from "./api";

/** <html> 上的 Ctrl 按住态标记（styles.css 的点亮规则用它） */
const CTRL_CLASS = "ctrl-links";

/** URL 匹配：scheme 起头 + 连续可打印 ASCII（0x21–0x7E，不含空格）。
 *  ⚠️ 刻意**不含** CJK/全角字符：`（https://x）` 的 `）`、`详见https://x即可`
 *  的中文一进匹配就会跟着进 href。真实 URL 里的非 ASCII 都是百分号编码形态
 *  （%E4%BD%A0…，本身是 ASCII）；裸中文只可能出现在「URL 后面紧接句子的下文」。 */
const URL_MATCH = /https?:\/\/[!-~]+/;
/** 同款的全局版（matchAll 用；matchAll 内部克隆 RegExp，不动这里的 lastIndex） */
const URL_RE_G = /https?:\/\/[!-~]+/g;
/** 文本里有没有 URL（探针，无状态） */
const URL_PROBE = /https?:\/\//i;
/** scheme 后至少还有一个字符（`https://` + 纯标点、剥完不剩东西的不当 URL） */
const URL_MIN = /^https?:\/\/./;
/** href 的 scheme 校验。^ 锚定：`javascript:` 串着 https:// 的不能只靠 includes 放行 */
const HREF_OK = /^https?:\/\//i;
/** URL 尾部要剥掉的标点（全角标点进不了匹配——见 URL_MATCH 注释，这里只有 ASCII） */
const URL_TAIL_PUNCT = ".,;:!?<>)]}'\"`";
/** 悬停提示：普通点击没有动作，把正确手势告诉用户 */
const LINK_TITLE = "按住 Ctrl 点击，用系统默认浏览器打开";

/**
 * 剥掉 URL 尾部不该进 href 的标点：
 * - 中英标点一路剥到非标点为止（`https://x.com/a。` 的 `。`、`…）` 的尾巴）；
 * - 右括号只在**未配平**时剥——wiki 风格 `https://x/Foo_(bar)` 的 `)` 要保留，
 *   这是 GFM 自动链接的同款规则。
 * 导出只为单测：本文件其余部分依赖 DOM，按项目惯例（vitest node 环境）不进单测。
 */
export function trimUrlTail(url: string): string {
  let s = url;
  for (;;) {
    const last = s[s.length - 1];
    if (last === undefined) return s;
    if (last === ")") {
      const opens = (s.match(/\(/g) ?? []).length;
      const closes = (s.match(/\)/g) ?? []).length;
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
      return s;
    }
    if (URL_TAIL_PUNCT.includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

/** 节点是否已在 <a> 里（marked 自动链接 / 正文 md 链接——包过的不重复包） */
function insideAnchor(node: Node): boolean {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (p.tagName === "A") return true;
  }
  return false;
}

/** 把一个文本节点里的 URL 包成 <a>（可能一段文本里有多个） */
function wrapTextNode(doc: Document, node: Text): void {
  const text = node.nodeValue ?? "";
  const matches = Array.from(text.matchAll(URL_RE_G));
  if (matches.length === 0) return;
  const frag = doc.createDocumentFragment();
  let last = 0;
  for (const m of matches) {
    const url = trimUrlTail(m[0]);
    const start = m.index ?? 0;
    // 剥完只剩 scheme（`https://…` 全是标点）的不当 URL：原样留在文本里
    if (!URL_MIN.test(url)) continue;
    if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
    const a = doc.createElement("a");
    a.setAttribute("href", url);
    a.setAttribute("title", LINK_TITLE);
    a.textContent = url;
    frag.appendChild(a);
    // 被剥掉的尾部标点（url 比 m[0] 短的那截）归后段文本，不丢
    last = start + url.length;
  }
  if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
  node.parentNode?.replaceChild(frag, node);
}

/**
 * marked 自动链接修复：可见文本本身就是 URL、但尾部混进了 URL 之外的字符
 * （`）里也有` 这类）时，把干净部分留下、垃圾挪出链接。只认「URL 从文本第
 * 0 位开始」的自动链接形态；标题式 md 链接 `[文档](url)` 的文本不含 scheme
 * 或不以 scheme 开头，天然不命中。
 */
function repairAutoLink(a: Element, doc: Document): void {
  const text = a.textContent ?? "";
  if (!URL_PROBE.test(text)) return;
  const m = URL_MATCH.exec(text);
  if (!m || m.index !== 0) return;
  const url = trimUrlTail(m[0]);
  if (url === text || !URL_MIN.test(url)) return;
  a.setAttribute("href", url);
  a.textContent = url;
  const rest = text.slice(url.length);
  if (rest) a.parentNode?.insertBefore(doc.createTextNode(rest), a.nextSibling);
}

/**
 * 给消毒后的 HTML 补链/修链（MarkdownText 在 DOMPurify 之后调用）。
 * 文本里没有 http(s) 时原样返回——绝大多数消息不含链接，免付 DOMParser 的
 * 开销（长会话历史一次性渲染几百条，别每条都白解析一遍）。
 */
export function linkifyHtml(html: string): string {
  if (!URL_PROBE.test(html)) return html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html; // text/html 解析按规格不抛；防御性兜底
  }
  const body = doc.body;

  // ① 包：不在 <a> 里的文本节点（含行内代码/代码块——marked 不解析 code 内联）。
  //    先收集再改树：TreeWalker 边走边改节点会乱
  const pending: Text[] = [];
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const tag = node.parentElement?.tagName;
    if (tag === "STYLE" || tag === "SCRIPT") continue;
    if (!URL_PROBE.test(node.nodeValue ?? "")) continue;
    if (insideAnchor(node)) continue;
    pending.push(node);
  }
  for (const node of pending) wrapTextNode(doc, node);

  // ② 修 + 补 title：marked 自己的链接没有提示文案，统一给（缺了才给，
  //    不覆盖作者手写的 title）
  for (const a of Array.from(body.querySelectorAll("a"))) {
    if (!a.getAttribute("title")) a.setAttribute("title", LINK_TITLE);
    repairAutoLink(a, doc);
  }

  return body.innerHTML;
}

let installed = false;

/**
 * 装全局监听（幂等；MessageParts.tsx 模块顶层调用，见文件头注释）：
 * - Ctrl 按下/抬起 → <html> 上的 class（CSS 点亮，零 React 渲染）；
 * - Ctrl+点击 .md-body 里的链接 → open_url（系统默认浏览器）。
 */
export function installCtrlLinkOpen(): void {
  if (installed) return;
  installed = true;

  const setCtrl = (down: boolean) =>
    document.documentElement.classList.toggle(CTRL_CLASS, down);
  // keydown/keyup 都读 e.ctrlKey（而不是认 e.key === "Control"）：任意键的
  // keyup 都携带当时的 Ctrl 状态，组合键（Ctrl+C/V 等）过后不会卡在按下态。
  // 捕获阶段挂 window，焦点在输入框/终端 textarea 里也能收到
  window.addEventListener("keydown", (e) => setCtrl(e.ctrlKey), true);
  window.addEventListener("keyup", (e) => setCtrl(e.ctrlKey), true);
  // 修饰键+Tab 切走窗口后 keyup 不会再送来：失焦一律视为抬起，别让点亮态卡死
  window.addEventListener("blur", () => setCtrl(false));

  // 捕获阶段挂在 document：先于 React 在 root 上的合成事件，任何上层
  // stopPropagation 都拦不住。只认 .md-body 里的 <a>——会话正文的链接；
  // 供应商弹窗等处的 React 外链按钮不经这里（它们有自己的 onClick）
  document.addEventListener(
    "click",
    (e) => {
      if (!(e instanceof MouseEvent) || !e.ctrlKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest("a");
      if (!a || !a.closest(".md-body")) return;
      const href = a.getAttribute("href") ?? "";
      // 双保险：后端 open_url 同样只放行 http/https，这里先挡掉 md 的 #锚点等
      if (!HREF_OK.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      api.openUrl(href).catch((err) => console.warn("open_url 失败：", err));
    },
    true,
  );
}
