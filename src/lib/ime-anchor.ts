/** 把输入法（IME）候选窗锚到 claude 自己画的输入光标上。
 *
 *  ## 症状
 *  在内嵌终端里用中文输入法：会话进行中打字，候选窗到处乱飘；一轮结束后打字，
 *  不飘了但也不贴着输入光标——输入的字在左边、候选框在右边。
 *
 *  ## 根因（2026-09-20 逐像素实测，用户截图 2016×1346 / DPR 1.5 / 格宽 14 格高 28 设备px）
 *  **claude 的 TUI 不用真实光标画输入光标**：它在 `> …` 之后写一格**反显空格**
 *  （实测 #cccccc 实心 14×28，正好一格），同时用 `?25l` 把真实终端光标藏起来、
 *  停在别处。而 Windows 的 IME 候选窗锚在**真实（逻辑）光标**那一格上：实测候选窗
 *  左上角落在第 18 列、输入行**下一行**，claude 画的光标在第 8 列、输入行——差
 *  整 10 格 + 1 行（139px ÷ 14 = 9.93）。
 *
 *  于是：
 *  - 空闲时 = 稳定的 10 格错位（claude 帧不动，逻辑光标也不动）；
 *  - 流式输出时 = 乱飘（Ink 每帧重绘都在挪那个逻辑光标，每挪一次锚点跟着跳一次）。
 *
 *  这一层是 xterm 干的：`CoreBrowserTerminal._syncTextArea()` 把 `.xterm-helper-textarea`
 *  （Chromium 向 IME 报 caret 的那个隐藏 textarea）摆在 `buffer.x/buffer.y`；
 *  `CompositionHelper.updateCompositionElements()`（挂在 `onRender` 上）在组合期间
 *  每渲染一帧就把它俩再挪到逻辑光标处——**且不考虑逻辑光标是不是真的在输入光标上**。
 *  上游同样有此问题（claude-code #29745 / #35307、xterm.js #5734：Windows Terminal、
 *  VS Code 集成终端都中招，因为它们的 IME 锚点同样取"终端光标"）。
 *
 *  ## 做法
 *  终端缓冲区在我们手里，claude 画的输入光标就是**最下面那一格「反显 + 空白」单元格**
 *  （见 `findInputCaret`）。install 之后：
 *  - `_syncTextArea` / `updateCompositionElements` 被接管——能确定光标格就摆到那一格，
 *    否则原样调用 xterm 的实现；
 *  - `onRender`（节流）/ `compositionstart` / install 时各重算一次，扫不到短期沿用
 *    最后确认的那一格（这样流式期间不会因为某一帧扫不到就跳回乱飘）。
 *
 *  **只改 DOM 的 left/top（textarea 另把宽度压到一格），不碰 xterm 任何解析/数据路径。**
 *  宽度压成一格是有意的：textarea 内部的 caret 会随组合串变长往右滚，压窄能把这点
 *  残余偏移限制在一格以内（否则长拼音会把候选窗又推走好几格）。
 *
 *  ## 边界（失败时退回今天的行为，不会更差）
 *  - **只在真实光标是「隐藏」状态时才接管**（`coreService.isCursorHidden`）：光标可见
 *    说明这个程序（shell / vim / nano / less…）用的是真光标，xterm 的锚点本来就是对的，
 *    此时一律不插手——vim 的状态行整行是反显空格，不设这道闸会被误判。
 *  - 读不到 xterm 内部结构（`_core._syncTextArea` / `_compositionHelper` 改名的未来版本）
 *    → install 直接返回空 dispose，行为与今天完全一致；只有 claude 换掉"反显空格画
 *    光标"的画法时才退化成错位（也就是回到今天的症状）。
 *  - 内部字段在 typings 里**没有声明**（xterm 只声明公开 API），故这里集中在一处
 *    `as` 转型 + 存在性检查，与 term-unicode.ts 的「说明依赖假设 + 失败回退」同一路数。 */
import type { IBuffer, IDisposable, Terminal } from "@xterm/xterm";

/** claude 输入光标所在的格子（行列都是**可视区**口径：行 0 = 视口顶行，与 xterm
 *  摆放 textarea 用的 `buffer.y` 同一坐标系） */
export interface CaretCell {
  col: number;
  row: number;
}

/** 同一次事件里的重复询问共用一次扫描（xterm 一次渲染可能连调好几个钩子） */
const MEMO_MS = 16;
/** 扫不到时沿用最后一格的时限。太短则流式期间会跳回乱飘，太长则换成别的程序后锚点滞后 */
const STALE_MS = 3000;
/** onRender 重算节流 */
const RENDER_THROTTLE_MS = 50;

/** 从可视区底部往上找 claude 画的输入光标格：**最下面那一行里、最靠左的一格
 *  「反显 + 空白」单元格**，且它左边必须还有非空白格（输入文字或 `>` 提示符）。
 *
 *  为什么要"左边有内容"：反显空格是 claude 画光标的手法，但它铺底/整行反显之类的
 *  装饰也可能是反显空格；要求左边有内容能把这些挡掉（真实光标永远跟在文字后面）。
 *  找不到返回 null（调用方退回 xterm 的定位）。
 *
 *  `maxRows` 默认 = 全部可视行（`rows`）。**别缩成"只扫底部几行"**：claude 的输入框
 *  跟着已输出的内容走，新会话里它就在 logo 正下方的屏幕**上方**（实测 21 行终端里
 *  输入行在第 6 行、状态行反而更低），只扫底部会整片漏掉、退回 xterm 的错位锚点。
 *  自底向上找 + 立即返回，开销由 memo 兜住（blank 判定走 getCode()，不分配字符串）。 */
export function findInputCaret(
  buffer: IBuffer,
  cols: number,
  rows: number,
  maxRows = rows,
): CaretCell | null {
  if (cols <= 0 || rows <= 0) return null;
  // 复用同一个 cell 对象：逐格 getCell 会海量分配，xterm 自己也建议复用（getNullCell）
  const cell = buffer.getNullCell();
  const firstRow = Math.max(0, rows - maxRows);
  for (let row = rows - 1; row >= firstRow; row--) {
    // getLine 收的是**绝对行号**，可视区行要自己加 viewportY（与 TerminalPane 的忙闲探针同一套）
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    let hit = -1;
    let content = false;
    for (let col = 0; col < cols; col++) {
      const c = line.getCell(col, cell);
      if (!c) break;
      // 空格用码位判（0 = 空单元格，32 = 空格）：getChars() 每格都要现拼字符串，
      // 整屏扫下来就是几千次分配，而这里每次渲染都可能跑一遍
      const code = c.getCode();
      if (code !== 0 && code !== 32) {
        content = true;
        continue;
      }
      // isInverse() 返回的是位标志（number），不是 boolean——按 truthy 判断
      if (hit < 0 && content && c.isInverse()) hit = col;
    }
    if (hit >= 0) return { col: hit, row };
  }
  return null;
}

/** xterm 6 的内部结构（typings 里没有声明）。全部按可选成员对待，读不到就不接管。 */
interface XtermInternals {
  _syncTextArea?: () => void;
  _compositionHelper?: {
    isComposing?: boolean;
    updateCompositionElements?: (dontRecurse?: boolean) => void;
  };
  _renderService?: {
    dimensions?: { css?: { cell?: { width?: number; height?: number } } };
  };
  coreService?: { isCursorHidden?: boolean };
}

/** 挂上「锚到 claude 输入光标」的行为，返回卸载函数（随终端 dispose 一起调用）。 */
export function installImeCaretAnchor(term: Terminal): () => void {
  const core = (term as unknown as { _core?: XtermInternals })._core;
  const helper = core?._compositionHelper;
  const textarea = term.textarea;
  // 内部结构对不上（xterm 大版本换了字段名）→ 不接管：行为与改动前完全一致
  if (!core || !helper || !textarea) return () => {};
  const origSync = core._syncTextArea;
  const origUpdate = helper.updateCompositionElements;
  if (typeof origSync !== "function" || typeof origUpdate !== "function") return () => {};

  const compositionView =
    term.element?.querySelector<HTMLElement>(".composition-view") ?? null;
  const disposables: IDisposable[] = [];
  let memo: { caret: CaretCell | null; at: number } | null = null;
  let lastHit: { caret: CaretCell; at: number } | null = null;

  /** 一格宽高（CSS px）。xterm 自己就是拿 dimensions.css.cell 摆 textarea 的；
   *  取不到就按屏幕元素尺寸 ÷ 行列数退算（字体/DPR 变了每次现算，不缓存）。 */
  const cellSize = (): { w: number; h: number } | null => {
    const c = core._renderService?.dimensions?.css?.cell;
    if (c && c.width && c.height) return { w: c.width, h: c.height };
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (screen && term.cols > 0 && term.rows > 0) {
      const w = screen.clientWidth / term.cols;
      const h = screen.clientHeight / term.rows;
      if (w > 0 && h > 0) return { w, h };
    }
    return null;
  };

  const resolveCaret = (): CaretCell | null => {
    const now = Date.now();
    if (memo && now - memo.at < MEMO_MS) return memo.caret;
    /* 真实光标可见 = 这个程序用真光标（shell/vim/nano…），xterm 的锚点本来就对：**完全不插手**。
     * 注意这条闸要先于"沿用上一格"生效——沿用是给"claude 那种藏光标、但这一帧没扫到"
     * 准备的，不能被它越过这道闸（否则光标一显示回来，锚点还赖在旧格子上不走）。
     * 读不到该状态（undefined）时同样不接管：宁可退回原行为，也不要在别的程序里添乱。 */
    if (core.coreService?.isCursorHidden !== true) {
      memo = { caret: null, at: now };
      return null;
    }
    let caret: CaretCell | null = findInputCaret(term.buffer.active, term.cols, term.rows);
    if (caret) lastHit = { caret, at: now };
    else if (lastHit && now - lastHit.at < STALE_MS) caret = lastHit.caret;
    memo = { caret, at: now };
    return caret;
  };

  const place = (caret: CaretCell, size: { w: number; h: number }, withCompositionView: boolean): void => {
    const left = `${caret.col * size.w}px`;
    const top = `${caret.row * size.h}px`;
    const height = `${size.h}px`;
    textarea.style.left = left;
    textarea.style.top = top;
    // 宽度压到一格（xterm 那边是"光标格的字符宽"，1~2 格）：见文件头——把 textarea
    // 内部 caret 随组合串右滚造成的残余偏移限制在一格内
    textarea.style.width = `${size.w}px`;
    textarea.style.height = height;
    textarea.style.lineHeight = height;
    textarea.style.zIndex = "-5";
    if (!withCompositionView || !compositionView) return;
    // 组合视图（xterm 自己在光标处画的 inline 拼音）跟 textarea 一起挪，两者必须同格，
    // 否则候选窗与拼音会分家。字体要跟着补——xterm 那边也是在这里现设的
    compositionView.style.left = left;
    compositionView.style.top = top;
    compositionView.style.height = height;
    compositionView.style.lineHeight = height;
    const opts = term.options;
    if (opts.fontFamily) compositionView.style.fontFamily = opts.fontFamily;
    if (opts.fontSize) compositionView.style.fontSize = `${opts.fontSize}px`;
  };

  /** 能确定光标格 → 摆过去并返回 true；否则 false（调用方交还 xterm 的定位） */
  const anchor = (withCompositionView: boolean): boolean => {
    const caret = resolveCaret();
    if (!caret) return false;
    const size = cellSize();
    if (!size) return false;
    place(caret, size, withCompositionView);
    return true;
  };

  // 接管两处定位（xterm 里就这两处会摆 textarea/composition-view）
  core._syncTextArea = function (this: unknown) {
    if (anchor(false)) return;
    return origSync.call(core);
  };
  helper.updateCompositionElements = function (this: unknown, dontRecurse?: boolean) {
    // 与 xterm 同语义：不在组合中就不动。isComposing 读不到（将来被改名）时按"不确定"
    // 处理、交还原实现，别把整条组合定位路径吞掉
    if (helper!.isComposing === false) return;
    if (anchor(true)) return; // 位置由我们定，不需要它那套 setTimeout 重排补偿
    return origUpdate.call(helper, dontRecurse);
  };

  /* 重算时机。
   * 关键是 onWriteParsed：**每次写入解析完**（每帧至多一次）清掉 memo 再锚一次。
   * 少了它有个实测过的坑：`?25l`（藏光标）往往出现在一段输出的**末尾**，而这一段输出里
   * 的光标移动发生在它被应用之前——那些时刻 `isCursorHidden` 还是 false，扫描被闸掉并
   * 把 null 记进 memo；若此后屏幕静止（不再有渲染），memo 会把最后一次渲染事件也一起
   * 挡掉，textarea 就停在 xterm 自己摆的位置上（Chromium 实测：偏移正好一格）。
   * 渲染那一路仍需节流：流式输出时 onRender 每帧都来。 */
  disposables.push(
    term.onWriteParsed(() => {
      memo = null;
      anchor(false);
    }),
  );
  let lastRender = 0;
  disposables.push(
    term.onRender(() => {
      const now = Date.now();
      if (now - lastRender < RENDER_THROTTLE_MS) return;
      lastRender = now;
      anchor(false);
    }),
  );
  const onCompositionStart = (): void => {
    memo = null; // 强制立刻重扫：IME 要的是此刻的光标位置
    anchor(true);
  };
  textarea.addEventListener("compositionstart", onCompositionStart, true);
  anchor(false);

  return () => {
    core._syncTextArea = origSync;
    helper.updateCompositionElements = origUpdate;
    textarea.removeEventListener("compositionstart", onCompositionStart, true);
    for (const d of disposables) d.dispose();
  };
}
