/** 内嵌终端面板：xterm.js 渲染 + 后端 PTY（真 claude CLI）。
 *
 *  生命周期 = 所属 tab 的生命周期：挂载即 spawn（尺寸由 FitAddon 先量好），
 *  卸载即 kill + dispose。tab 切换靠外层容器 display:none 隐藏（组件不卸载，
 *  PTY 进程与终端缓冲都保留——多会话并行是目标形态）。进程退出后终端缓冲
 *  保留可回看，tab 仍可关闭。 */
import { useEffect, useRef, type MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { ptySpawnClaude, ptyWrite, ptyResize, ptyKill, clipboardImagePath } from "../lib/pty";
import { createBoldBrightFilter } from "../lib/bold-bright";
import { installTerminalWidthTable } from "../lib/term-unicode";
import { installImeCaretAnchor } from "../lib/ime-anchor";
import { sessionTitleFromOsc } from "../lib/term-title";
import type { TabActivity, TerminalTab } from "../types";

interface Props {
  tab: TerminalTab;
  /** 状态回传（starting → running / exited） */
  onStatus: (id: string, status: TerminalTab["status"], exitCode: number | null) => void;
  /** 会话名回传：claude 把会话名写进终端标题（OSC 0），tab 标题跟着它走——
   *  新会话从「项目名」变成真会话名、以及 `/rename` 都靠这条链路（见 term-title.ts） */
  onTitle?: (id: string, title: string) => void;
  /** 忙/闲探针注册表：右键 tab 时由宿主**现算**，不轮询——轮询+只在变化时上报会留下
   *  陈旧快照（挂载后 1s 那次探测看到的是还没画完的空屏）。挂载时注册、卸载时删除。 */
  probes?: MutableRefObject<Map<string, () => TabActivity>>;
  /** 就地击杀注册表：宿主「删除会话」时要把这个 tab 的 claude 先结束掉再删文件。
   *  为什么不靠卸载路径：清理函数里的 ptyKill 是 fire-and-forget（发起完就返回），
   *  宿主拿不到「进程确实已退出」的时刻，删除与写入就会挤在一起。挂载时注册、
   *  卸载时删除，与 probes 同一套模式。 */
  killers?: MutableRefObject<Map<string, () => Promise<void>>>;
}

/** 从可视区最后几行 + 输出量判断 claude 在干什么（三条判据，忙的判定优先）：
 *  1. 底部出现 "ctrl+x to stop" → 有任务在跑（这是 claude 空闲/忙碌同一行提示位里的
 *     忙碌态文案；在 cli 二进制里核对过它确实存在）——比 "esc to interrupt" 更常用，
 *     后者只在 low_priority_waiting（重试等待）时出现，也一并认；
 *  2. 这一秒内 PTY 输出 ≥8 个 chunk → 正在流式输出/重绘，同样按忙处理。
 *     空闲时只有输入框光标闪烁（约 2 chunk/s），不会误触；万一误触也只是"暂时不关"，安全；
 *  3. 底部出现空闲标记（"? for shortcuts" / 权限行的 "shift+tab to cycle"）→ 空闲。
 *     这两个文案在源码里是拼出来的（中间夹色码），所以只能用"渲染后"的文本去匹配。
 *  其余 → unknown，调用方按忙处理（宁可漏关，不可误杀）。
 *  注意：**不要**用"多久没输出了"当判据——实测 claude 空闲时光标闪烁 + 状态行也在刷新，
 *  输出从不断 3 秒，那样会把所有空闲会话判成 unknown（第一版就是这么翻车的）。 */
function detectActivity(term: Terminal, outChunks: number): TabActivity {
  const buf = term.buffer.active;
  const rows = term.rows;
  // 扫**整个可视区**（不猜"标记在第几行"）：marker 落在哪行是 claude 的自由，扫全屏不会漏。
  // 成本可忽略——探针只在右键那一刻跑一次。
  // getLine 的入参是**绝对行号**（xterm 实现就是 lines.get(y)，不加 ydisp），
  // 所以要读可视区必须自己加 viewportY。
  let all = "";
  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(buf.viewportY + r);
    if (line) all += line.translateToString(true) + "\n";
  }
  if (/ctrl\+x to stop|esc to interrupt/i.test(all)) return "busy";
  if (outChunks >= 8) return "busy";
  if (/shift\+tab to cycle|\? for shortcuts/i.test(all)) return "idle";
  return "unknown";
}

/** 终端配色**固定深色**，不随 app 主题切换（可读性优先，用户明确要求）。
 *  另一层原因：claude 启动时会探测终端背景色（OSC 11 查询）自适应 TUI 明暗，
 *  背景必须答"深色"——app 浅色主题下答浅色会把整个 claude TUI 渲染成浅色。
 *  背景取 #0C0C0C（Windows Terminal Campbell 同款）：纯黑 #000000 实测刺眼，
 *  原 #1f1e1b 暖灰黑又偏洗、彩色文字对比度弱一档。 */
function termTheme() {
  return {
    background: "#0c0c0c",
    // 前景与 ANSI 16 色取 Windows Terminal Campbell 方案并整体压暗一档：
    // xterm 默认调色板的白/亮白接近纯白（brightWhite=#FFFFFF），claude TUI
    // 的大量亮色文字落在这些档位上，实测"重、亮、刺眼"；Campbell 是微软
    // 调好的舒适档，brightWhite 再从 #F2F2F2 压到 #E0E0E0
    foreground: "#cccccc",
    cursor: "#d97757",
    cursorAccent: "#0c0c0c",
    selectionBackground: "rgba(217, 119, 87, 0.30)",
    black: "#0c0c0c",
    red: "#c50f1f",
    green: "#13a10e",
    yellow: "#c19c00",
    blue: "#0037da",
    magenta: "#881798",
    cyan: "#3a96dd",
    white: "#cccccc",
    brightBlack: "#767676",
    brightRed: "#e74856",
    brightGreen: "#16c60c",
    brightYellow: "#f9f1a5",
    brightBlue: "#3b78ff",
    brightMagenta: "#b4009e",
    brightCyan: "#61d6d6",
    brightWhite: "#e0e0e0",
  };
}

/** 找一个「字符步进 × dpr 落在整数上」的字号（而不是硬写 16）。
 *
 *  为什么必须这样做：xterm 的字符格宽 = 字体步进 × dpr。Cascadia Mono 在 16px 时
 *  步进 9.375 CSS px（= 1200/2048em），dpr 1.5 下 = **14.0625 设备px，不是整数**。
 *  于是每一格都落在小数像素上，块状字符（█ ▌ ▀ 这些——claude 的机器人 logo、
 *  markdown 表格的横竖线全是它们画的）左右边缘各被反锯齿一次，两次叠加不等于
 *  100% 覆盖，每格交界处就留下一条暗缝。实测 app 截图：每 14px 一条、暗约 9%
 *  （个别位置 45%）；同机器上 Windows Terminal 同字体同字号则完全平整——因为它的
 *  格宽是整数设备px。
 *
 *  取 15.93px 时步进 9.3333 → 设备 14.0 整数，缝消失；附带好处是行盒从 29 设备px
 *  变成 28 设备px，与 cmd 的 28 完全一致（原先差 1px 的残差也一并消掉）。
 *
 *  用 canvas 实测步进、而不是算 em 比例：浏览器可能有 hinting，实测值才与实际排版
 *  一致。搜索限制在目标字号 ±0.5px 内，字号几乎不变（16 → 15.93，视觉无差）。 */
const advanceSizeCache = new Map<string, number>();

/** 结果缓存（key = `字体栈@dpr@字号`）：与 alignRowHeight 同理——开每个 tab 都重跑
 *  一遍上面那 101 次 measureText 扫（每轮还要重新解析一次字体串）纯属浪费，
 *  输入相同则结果必相同。 */
function integralAdvanceFontSize(fontFamily: string, dpr: number, want: number): number {
  const key = `${fontFamily}@${dpr}@${want}`;
  const hit = advanceSizeCache.get(key);
  if (hit !== undefined) return hit;
  const result = computeAdvanceFontSize(fontFamily, dpr, want);
  advanceSizeCache.set(key, result);
  return result;
}

function computeAdvanceFontSize(fontFamily: string, dpr: number, want: number): number {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return want;
    // 字体串若解析失败，ctx.font 会静默保留旧值，后面量到的就是浏览器默认字体。
    // 用 100px 的步进比例做一次合理性校验（等宽字体应在 0.4~0.9em 之间）
    ctx.font = `100px ${fontFamily}`;
    const perEm = ctx.measureText("W").width / 100;
    if (!(perEm > 0.4 && perEm < 0.9)) return want;
    let best = want;
    let bestErr = Infinity;
    for (let size = want - 0.5; size <= want + 0.5 + 1e-9; size += 0.01) {
      ctx.font = `${size}px ${fontFamily}`;
      const dev = ctx.measureText("W").width * dpr;
      const err = Math.abs(dev - Math.round(dev));
      if (err < bestErr - 1e-9) {
        bestErr = err;
        best = Math.round(size * 100) / 100;
        // 已经贴合到亚像素级就不用再找了
        if (bestErr < 0.002) break;
      }
    }
    return best;
  } catch {
    return want;
  }
}

/** 终端字体栈：Windows 命中 Cascadia Mono + TermCJK(=SimHei 放大 6%，见 styles.css)，
 *  macOS 命中 Menlo + PingFang SC。
 *  顺序 = 各平台各自第一个命中的那项，改动请保持这个性质（详见下方 fontFamily 处注释）。
 *  TermWide 只圈了圈号一类"歧义宽度"码位（见 styles.css 的 unicode-range），
 *  拉丁与中文仍分别落到 Cascadia / TermCJK，不改变上面这条性质。 */
const TERM_FONT_FAMILY =
  '"Cascadia Mono", TermWide, TermWide2, Menlo, Consolas, "PingFang SC", TermCJK, "Microsoft YaHei", monospace';

/** alignRowHeight 的结果缓存（key = `dpr@size`）：结果只由这两个输入决定，
 *  而 TerminalPane 每次挂载都会调它——不缓存的话同一个 @font-face 会随开关
 *  tab 无限往 <head> 里堆字节级相同的 <style>。缓存的样式节点随 app 存活、
 *  全部终端共享（实际上界 = 出现过的 (dpr, 字号) 组合数）。 */
const rowHeightCache = new Map<string, [string, number]>();

/** 让终端格高与 cmd 相同：xterm 的格高是 floor(ceil(字行盒 × dpr) × lineHeight)，
 *  cmd 那边把同一个值**截断**——dpr 1.5 下两边都是 28.5 设备px，Chromium 得 29、
 *  cmd 得 28，于是每行差 1px。lineHeight 不能 < 1（xterm 直接抛错）、字号也不能动
 *  （步进一旦离开 14.0 设备px 的整数点，块状字符的缝会回来），所以只能先把字行盒
 *  压掉 1 CSS px（@font-face 的 ascent-override，按当前 fontSize 与实测度量现算），
 *  再用 lineHeight 补回 cmd 的高度。两边取值都按 dpr 现算，换 dpr 不会跑偏。
 *  返回 [字体栈, lineHeight]；压不动或压了没生效就原样返回（宁差 1px，不乱补）。 */
function alignRowHeight(size: number, dpr: number): [string, number] {
  const key = `${dpr}@${size}`;
  const hit = rowHeightCache.get(key);
  if (hit) return hit;
  const result = computeRowHeight(size, dpr);
  rowHeightCache.set(key, result);
  return result;
}

function computeRowHeight(size: number, dpr: number): [string, number] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [TERM_FONT_FAMILY, 1];
  const boxOf = (font: string) => {
    ctx.font = font;
    const m = ctx.measureText("W");
    return [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent] as const;
  };
  const [asc, desc] = boxOf(`${size}px ${TERM_FONT_FAMILY}`);
  const shrunk = asc - 1; // 字体度量是整数像素，只能整 px 压
  if (!asc || shrunk < 1) return [TERM_FONT_FAMILY, 1];
  // 运行时生成（百分比要跟着 fontSize 走）：local() 源没有网络加载，注入即可用
  const style = document.createElement("style");
  style.textContent =
    '@font-face{font-family:"TermLatin";' +
    'src:local("Cascadia Mono"),local("Menlo"),local("Consolas");' +
    `ascent-override:${(shrunk / size) * 100}%;descent-override:${(desc / size) * 100}%;}`;
  document.head.appendChild(style);
  const family = `"TermLatin", ${TERM_FONT_FAMILY}`;
  const [asc2, desc2] = boxOf(`${size}px ${family}`);
  const cellH = Math.ceil((asc2 + desc2) * dpr); // = xterm 的 device.char.height
  const want = Math.floor((asc + desc) * dpr); // = cmd 的格高（截断同一个值）
  return [family, want > cellH ? (want + 0.15) / cellH : 1]; // +0.15 抵浮点误差
}

export default function TerminalPane({ tab, onStatus, onTitle, probes, killers }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  // onStatus 走 ref：宿主传内联回调时避免 spawn effect 重跑（那是杀进程重建）
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // onTitle 同理走 ref（同样是为了不把回调放进 spawn effect 的依赖）
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  /** 最近若干次输出的时刻（有界，最多留 16 条）：探针用它算"这一秒的 chunk 数" */
  const chunkTimesRef = useRef<number[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    /* 卸载标志 / 退出标志：**必须声明在本 effect 最前面**。下面 WebGL 那段在挂载时
     *  就会同步调 attachWebgl()，而它第一句就读 disposed——写在后面会踩 `let` 的 TDZ
     *  （ReferenceError 直接炸掉整个 effect：终端不 spawn、监听不注册、cleanup 也不
     *  返回）。凡是「被同步调用的闭包在读」的 effect 级变量，都放这一块里。 */
    let disposed = false;
    /** 进程是否已退出。包含「spawn 应答前就秒退、退出事件由 lib/pty 的 earlyExits
     *  补发」这一路——补发发生在 .then 之前，而 .then 里那句 running 会把刚写好的
     *  exited 覆盖回去（tab 于是永远显示运行中），故用它把状态钉住。 */
    let exited = false;
    const dpr = window.devicePixelRatio || 1;
    // 16px 对齐 cmd 窗口的可读性（首版 13px 实测明显偏小）；实际用 15.93——
    // 见 integralAdvanceFontSize：只有让「步进×dpr」落在整数上（14.0 设备px，
    // 与 cmd 同格），块状字符（机器人 logo / 表格线）才不会每格留一条暗缝。
    // 这个字号定的是拉丁；中文另由 TermCJK 放大（见 fontFamily 与 styles.css）
    const fontSize = integralAdvanceFontSize(TERM_FONT_FAMILY, dpr, 16);
    const [fontFamily, lineHeight] = alignRowHeight(fontSize, dpr);
    const term = new Terminal({
      cursorBlink: true,
      // `term.unicode`（换宽度表用）在 xterm 6 里被划进 proposed API，不打开这个开关
      // 一碰就抛「You must set the allowProposedApi option to true」——实测：
      // Unicode11Addon.activate() 里的 terminal.unicode.register() 也会一起挂掉，
      // 终端直接空白。开关本身只是去掉这道守卫，不改任何默认行为（我们只用 unicode 这一项）。
      allowProposedApi: true,
      fontSize,
      fontFamily,
      // ASCII 用 Cascadia Mono（Windows Terminal 同款，Win11 自带）；
      // 中文回退中易黑体（SimHei，经 TermCJK 放大 6%，理由见 styles.css）——实拍
      // cmd 样本鉴别：cmd 中文是点阵风格
      // 黑体（笔画细硬、转角方正、位图锐利边缘），非宋体也非雅黑；雅黑笔画
      // 粗字面圆润（用户嫌"过量"），SimHei 笔画硬朗方正最接近 cmd 观感。
      //
      // Menlo / PingFang SC 是给 macOS 的：这四个 Windows 字体在 mac 上一个都
      // 不存在，不加就只剩泛型 monospace（WebKit 默认落到 Menlo，但中文回退
      // 由系统决定，可能变宋体）。顺序 = 各平台各自第一个命中的那项：
      //   Windows：Cascadia Mono + TermCJK（拉丁与改动前逐字节一致，只中文放大）
      //   macOS  ：Menlo + PingFang SC
      // Menlo 排在 Consolas 前是有意的：mac 上装了 Office 就会带 Consolas，
      // 放后面会让"装没装 Office"决定字的观感，Menlo 才是 mac 原生保底。
      // 注意：换字体 = 换步进与行盒。Menlo 步进 0.602em（比 Cascadia 的
      // 0.5859em 宽 2.8%）→ 同宽窗口下少 2~3 列，claude 表格换行点会变；
      // 行盒两者几乎相同（1.164 vs 1.162em），所以行高/密度不受影响。
      // 粗体不加粗字重（= 正文同款 400）：Cascadia 的真 Bold 在黑底上笔画
      // 极厚、亮色粗体成块刺眼（用户实测）；cmd 的粗体本就不体现在笔画上，
      // 只靠颜色区分层级
      fontWeight: 400,
      fontWeightBold: 400,
      // 粗体的"变亮"分两路补齐（cmd/WT 的 intense 语义）：
      //  - 带索引色(0-7)的粗体 → 这个开关升格到 bright 色（xterm 原生行为）；
      //  - claude 实际在用的「裸 ESC[1m + 默认前景色」它管不到（CM_DEFAULT 直接返回
      //    colors.foreground，源码 TextureAtlas._getForegroundColor），由 bold-bright.ts
      //    在写进终端前补 ESC[97m——详见那个模块的注释
      drawBoldTextInBrightColors: true,
      // 宽字形**溢出格子、不压缩**：④ 这类"歧义宽度"字符 xterm 按单格算
      //  （claude 发的是 `**④ 回包后…**`，④ 后面跟一个空格），而中易黑体给的是
      //  满宽字形（25.5 设备px vs 格子 14）——开着这个开关会被**横向压成 13px 的
      //  细条**（实拍：12×24 的瘦圈），系统终端那边是原样溢出（24×23）。
      //  关掉即与 cmd/WT 一致（实测开关只在"字形宽 > 1.5 格 = 21px"时才动手，
      //  块状字符 █ 只有 16.5px，本来就走不到这条分支——开关开/关块状字符的列
      //  剖面都是 0 处暗缝，消缝靠的是整数字格宽 + WebGL 那套，不是它）
      rescaleOverlappingGlyphs: false,
      // 行高对齐 cmd：见 alignRowHeight（xterm 的格高公式是
      //   floor(ceil(字行盒 × dpr) × lineHeight)，cmd 那边是同一个值截断，
      //   dpr 1.5 下差 1px/行；靠"压 1px 行盒 + 按 dpr 补 lineHeight"抹平）。
      // 实测基线（dpr 1.5，同一张 claude TUI 表格）：cmd 28 设备px/行（量高亮输入条
      // 的高度），列宽两边一致 14.0 设备px/列。
      lineHeight,
      scrollback: 5000,
      theme: termTheme(),
    });
    termRef.current = term;
    // 粗体补色的流式改写器：每个终端一份（内部记着粗体/前景色状态与半条转义序列）
    const boldBright = createBoldBrightFilter();
    /* 宽度表：Unicode 11 + VS16 补丁（emoji 记 2 格、`⚠️` 这类变体选择符序列也记 2 格），
     *  否则 claude 的表格会逐行左移一两格。必须在**任何数据写进来之前**装好——xterm 是在
     *  解析那一刻把宽度算进单元格的。为什么、怎么量出来的、以及 xterm 6 的
     *  allowProposedApi 坑，都写在 src/lib/term-unicode.ts 头部与
     *  docs/embedded-terminal-plan.md 6.3 / 6.4。 */
    installTerminalWidthTable(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    /* IME 候选窗锚点：claude 不用真光标画输入光标（`?25l` 藏起来 + 自画一格反显空格），
     *  而 IME 只认真实光标 → 候选窗停在别处、流式输出时还跟着每帧重绘乱飘。这里把
     *  xterm 摆 textarea 的两处（`_syncTextArea` / `updateCompositionElements`）接管成
     *  「锚到 claude 画的那一格」。为什么、怎么量出来的、失败时怎么退回，全在
     *  src/lib/ime-anchor.ts 头部。必须在 open() 之后装——那几个 DOM 与内部服务
     *  都是 open 时才建出来的。 */
    const disposeImeAnchor = installImeCaretAnchor(term);

    /* 会话名链路：claude 把会话名写进终端标题（OSC 0），xterm 解析后在这里回传宿主，
     *  宿主把 tab 标题换成它——系统终端里 tab 名跟着会话名走，靠的也是这条。
     *  「哪些标题要丢弃、前缀字形怎么剥」全在 term-title.ts。订阅随 term.dispose() 一起
     *  回收（xterm 的 onTitleChange 返回的 disposable 归 term 管），不需要单独记住。 */
    term.onTitleChange((raw) => {
      const title = sessionTitleFromOsc(raw);
      if (title !== null) onTitleRef.current?.(tab.id, title);
    });

    /* 渲染器必须换成 WebGL —— DOM 渲染器在原理上消不掉块状字符的缝：
     *   _setDefaultSpacing() 用 letterSpacing 把"每格宽"补成 css.cell.width，而
     *   css.cell.width 来自 Math.round(device.canvas.width / dpr) / cols —— 先把
     *   画布宽取整到整数 CSS px。100 列 × 14 设备px ÷ 1.5 = 933.33 → 舍成 933，
     *   每格变成 13.995 而不是 14 设备px，100 列累积漂移 0.5px；竖轴同理（rows 不是
     *   3 的倍数时每行 27.99）。边缘落在小数像素上、覆盖被反锯齿吃掉一点，机器人
     *   logo 就出现横竖都有的暗线（实测每 14px 一条、暗 8~19%）。
     * WebGL 渲染器按整数设备像素栅格化并画四边形，配合上面的 fontSize（让格宽/行高
     * 恰好 14×28 设备px，与 cmd 同格）缝就消失。
     * 失败/上下文丢失时丢弃插件，xterm 自动回落内置 DOM 渲染器（只是缝回来，功能不受影响）。
     *
     * **每个 tab 都挂**（不是只挂激活的那个）：原计划为了躲 Chromium 每页 ~16 个
     *  WebGL 上下文的上限而「仅对激活 tab 挂载」，但那个上限实际到不了——终端 tab
     * 撑死 5 个（多会话并行的目标形态也没到 16），而为省上下文去「只挂激活 tab」要拿
     * 「每次切 tab 重建上下文 + 字形纹理图集」来换，对一个就是用来切来切去的 tab 条
     * 不划算。所以维持全挂。
     *
     * **会丢，所以要能重挂**：上下文丢失不止「超限」一种原因——GPU 进程崩溃、显卡
     * 驱动更新、休眠唤醒、远程桌面/切独显都会（这些才是实际会遇到的），而原来一丢就
     * dispose 掉、**永久**回落 DOM 渲染器（块状字符每 14px 一条暗缝），只能关掉 tab
     * 重开才能恢复。现在按退避重挂：GPU 回来就自己恢复，回不来就老实待在 DOM 上。 */
    let webgl: WebglAddon | undefined;
    let webglTimer: number | undefined;
    /** 重挂预算：1s / 5s / 30s 三次，用完即止。
     *  为什么「用完即止」而不是每次挂成功就重置：GPU 反复抽风时会变成无休止的
     *  「建-丢」循环。但**不能一刀切不重置**——真正会丢上下文的恰是休眠唤醒、切独显、
     *  远程桌面、驱动更新这类**低频**事件，一个开一整天的 tab 丢三次之后就永久停在
     *  DOM 渲染器上（块状字符每 14px 一条暗缝），与「GPU 回来就恢复」自相矛盾。
     *  所以用「活够久」当判据：挂上后撑过 WEBGL_HEALTHY_MS 再丢的，视为一次新的
     *  低频事件，预算还回去；只有「建完立刻又丢」那种抽风才会连续耗尽预算。 */
    const WEBGL_HEALTHY_MS = 60_000;
    let webglRetries = 0;
    let webglAttachedAt = 0;
    const scheduleWebglRetry = () => {
      if (disposed) return;
      const ms = [1000, 5000, 30000][webglRetries++];
      if (ms === undefined) return;
      webglTimer = window.setTimeout(attachWebgl, ms);
    };
    function attachWebgl() {
      if (disposed || webgl) return;
      try {
        const w = new WebglAddon();
        w.onContextLoss(() => {
          w.dispose();
          webgl = undefined;
          if (Date.now() - webglAttachedAt > WEBGL_HEALTHY_MS) webglRetries = 0; // 活够久 = 真恢复过，预算还回去
          scheduleWebglRetry();
        });
        term.loadAddon(w);
        webgl = w;
        webglAttachedAt = Date.now();
      } catch {
        // WebGL2 不可用（软件渲染 / 远程桌面）：先待在 DOM 渲染器上，稍后按退避再试
        scheduleWebglRetry();
      }
    }
    attachWebgl();

    /* 注册忙/闲探针：宿主右键 tab 时**现算**（不轮询）。最近 1 秒的输出 chunk 数
     * 由 chunkTimesRef 现算，≥8 判忙（见 detectActivity 的判据）。 */
    if (probes) {
      probes.current.set(tab.id, () => {
        const cutoff = Date.now() - 1000;
        const recent = chunkTimesRef.current.filter((t0) => t0 >= cutoff).length;
        return detectActivity(term, recent);
      });
    }

    /* 注册"就地击杀"：宿主删会话前先 await 它，拿到的是「进程树已杀完」的时刻
     *（pty_kill 返回 = 后端 taskkill /T /F 跑完），随后才动会话文件。
     * pty id 还没回来（spawn 在途）时是空操作：那种 tab 由卸载路径的 onSpawned
     * 分支补杀，宿主也不需要等——此时 claude 还没开始写这个会话文件。 */
    if (killers) {
      killers.current.set(tab.id, async () => {
        const id = ptyIdRef.current;
        if (id === null) return;
        // 杀完即摘掉 id：随后的卸载路径（removeTabs → cleanup）按 ptyIdRef 判空跳过，
        // 不再对同一个（可能已被回收线程 wait 掉的）pid 二次 taskkill；顺带让这之后
        // 的键盘输入直接排队而不是写向已死的 pty
        ptyIdRef.current = null;
        await ptyKill(id);
      });
    }

    /** fit + 把新尺寸同步给 PTY（尺寸不变时 pty_resize 是无害的幂等操作） */
    const refit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = ptyIdRef.current;
      if (id !== null && term.cols >= 2 && term.rows >= 1) {
        void ptyResize(id, term.cols, term.rows);
      }
    };

    /* 还没拿到 pty id 期间的终端输入：**排队，拿到 id 后按序补发，绝不能丢**。
     *
     *  这条队列是「偶发黑屏零输出」的修复（2026-09-20 探针实测）：
     *  PTY 里起的是 `cmd /D /S /C call claude.cmd`，cmd.exe 启动约 **20~30ms**
     *  就会往终端写 `ESC[6n`（DSR，问光标位置）并**等应答才继续**——实测不应答则
     *  整条链到此为止：总共只吐这 4 字节，cmd 标题都不设，claude 的 TUI 永远起不来，
     *  即「终端一片黑、什么输出都没有」。应答由 xterm.js 生成（`deviceStatus` →
     *  triggerDataEvent → term.onData），回灌 PTY 必须经过 ptyIdRef；而 ptyIdRef 要等
     *  spawn 命令的 IPC 应答（外加一次退出监听的往返）才就位——与那 21ms 撞在同一
     *  量级上，谁先谁后看当时主线程/IPC 队列忙不忙，于是表现为**偶发**。
     *  丢一次即该 tab 永久卡死，无法自愈（claude 不会重发）；但**晚答无妨**：
     *  实测延迟 500ms 才应答仍能完整恢复（握手没有超时），所以这里只排队、不丢弃。 */
    const pendingInput: string[] = [];

    /** 向 PTY 送输入；pty id 还没就位时先排队（见上） */
    const sendInput = (data: string) => {
      const id = ptyIdRef.current;
      if (id === null) {
        pendingInput.push(data);
        return;
      }
      void ptyWrite(id, data);
    };

    let resizeTimer: number | undefined;
    // 布局晚于挂载稳定（字体度量、tab 条撑开等）时补 fit：ResizeObserver 只在
    // 容器尺寸变化时触发，晚到的布局修正不一定伴随尺寸事件，曾致底部行被裁
    const settles = [120, 450].map((ms) => window.setTimeout(refit, ms));

    /* spawn 推迟一个宏任务再发——**dev 下不再双起 claude 的关键**。
     *  React 18 的 StrictMode 会把挂载 effect 跑两遍：setup → cleanup → setup，且三步
     *  在同一个 commit 里**同步**走完。若在 setup 里同步就发 spawn，第一遍那个 claude
     *  已经在飞了：cleanup 取消不掉（invoke 已发出），只能等它回来补杀（见 .then 的
     *  disposed 分支），于是 dev 下每开一个 tab 白起一个 claude/node（外加一次
     *  locate_claude 的子进程探测）。推到宏任务后再发：第一遍的定时器已被 cleanup
     *  清掉，双起消失。生产环境只晚 ~1ms，无感；万一将来 StrictMode 不再同步双跑，
     *  也只是退回今天的行为（起了再杀），不会更糟。
     *
     *  **别改成「用 ref / 模块级 Set 把第二遍的 spawn 挡掉」那种守卫**：StrictMode 的
     *  第二遍 setup 是**必须**重新 spawn 的——第一遍那个进程已经被 cleanup 判死（id
     *  还没回来就由 .then 的 disposed 分支补杀，回来了就由 cleanup 直接杀）。挡住第二
     *  遍 = 这个 tab 在 dev 下彻底没有终端。要真做到「重启挂载不重启进程」，得把 PTY
     *  会话的所有权从本组件的 effect 提到外面（App 层或模块级注册表，输出通道也要能
     *  跨挂载重绑），那是另一件事，别顺手改。 */
    const spawnTimer = window.setTimeout(() => {
      if (disposed) return;
      startClaude();
    }, 0);

    function startClaude() {
      ptySpawnClaude({
        cwd: tab.projectPath,
        resumeSessionId: tab.resumeSessionId,
        newSessionId: tab.newSessionId,
        cols: Math.max(term.cols, 2),
        rows: Math.max(term.rows, 1),
        onData: (chunk) => {
          if (disposed) return; // 关 tab 卸载后迟到的输出：term 已 dispose，不能再写
          const now = Date.now();
          const arr = chunkTimesRef.current;
          arr.push(now);
          if (arr.length > 16) arr.splice(0, arr.length - 16);
          // 粗体补色（见 bold-bright.ts）：claude 的裸 ESC[1m 在 cmd/WT 里是"加亮白"，
          // xterm 这边不补就与正文同色
          term.write(boldBright.push(chunk));
        },
        onExit: (code) => {
          // 迟到的退出事件（卸载触发的 kill → EOF → pty-exit）随卸载丢弃：term 已
          // dispose 不能再写，tab 也已从清单移除，状态更新是空转
          if (disposed) return;
          exited = true;
          term.write(`\r\n\x1b[2m── 进程已退出${code !== null ? `（code ${code}）` : ""} ──\x1b[0m\r\n`);
          onStatusRef.current(tab.id, "exited", code);
        },
        // id 一到就接通输入通道并把排队中的输入（多半就是那条 DSR 应答）补发出去
        // （退出监听此刻已注册好——它先于 invoke 注册，这里只抢「id 就位」这一步）
        onSpawned: (id) => {
          if (disposed) return; // 卸载时 cleanup 已经/即将按 ptyIdRef 杀，这里不再接管
          ptyIdRef.current = id;
          for (const d of pendingInput) void ptyWrite(id, d);
          pendingInput.length = 0;
        },
      })
        .then((id) => {
          if (disposed) {
            // 挂载后立即被卸载（用户秒关 tab）：进程刚起就杀掉
            void ptyKill(id);
            return;
          }
          // 已经在 spawn 应答前就退出了（退出事件由 lib/pty 补发、这里已收到）：
          // 状态必须是 exited，不能被下面那句 running 覆盖
          if (exited) return;
          onStatusRef.current(tab.id, "running", null);
          refit(); // spawn 期间布局可能已稳定出不同尺寸，补一次对齐
        })
        .catch((e) => {
          // 与 onData/onExit 同一条规矩：卸载后到达的回调一律丢弃（term 已 dispose，
          // 写进去会抛；异常还会逃出这个 catch 变成 unhandled rejection）
          if (disposed) return;
          term.write(`\r\n\x1b[31m终端启动失败：${String(e)}\x1b[0m\r\n`);
          onStatusRef.current(tab.id, "exited", null);
        });
    }

    term.onData(sendInput);

    /* 粘贴（贴图+文本）必须拦 keydown 转发给 claude，不能走浏览器 paste：
     *  - xterm.js 里 Ctrl+V 是 WebView 的 paste 事件、只会把**文本**写进终端，
     *    剪贴板是纯图片（截图/右键复制图像）时一个字节都不发，claude 什么都收不到；
     *  - Claude Code 的剪贴板粘贴绑定在 **Alt+V（\x1bv，ESC 紧跟 v，中间无空格——
     *    多打一个空格就会变成「敲入空格+v」）**：收到后自己去读系统剪
     *    贴板，图片贴成 [Image #1]、文本照常粘贴（claude 是真实进程，读得到用户
     *    复制的那块剪贴板，也无 WebView 剪贴板权限问题）。Ctrl+V 的原始键码
     *    \x16 在 Windows 实测（2.1.278，PTY 探针逐键码验证）完全无反应——社区
     *    「让 Ctrl+V 穿透」方案在 Windows 版不成立，Windows Terminal 用户用的
     *    就是 Alt+V；
     *  所以在捕获阶段（host 上，先于 xterm 挂在内部 textarea 的 keydown）拦下
     *  Ctrl+V / Cmd+V / Shift+Insert / Alt+V，preventDefault 掉浏览器粘贴，统一向
     *  PTY 写 \x1bv。macOS 的 claude 文档口径是 Ctrl+V（\x16），按键序列按平台分。
     * 按住不放的自动重复只拦不转（防连环触发粘贴）。
     *
     *  发送前先问一次「剪贴板里是不是图片文件」：是的话按 conhost 的做法把**文件路径
     *  当粘贴文本**送进终端（claude 见到图片路径会转成 [Image #1]），而不是发粘贴键
     *  ——claude 自己读剪贴板读不到文件列表。机制详见后端 clipboard_image.rs。 */
    const isMac = /mac/i.test(navigator.platform);
    const PASTE_SEQ = isMac ? "\x16" : "\x1bv";
    const onKeyDown = (ev: KeyboardEvent) => {
      const vKey = ev.code === "KeyV" || ev.key === "v" || ev.key === "V";
      const isPasteKey =
        // AltGr 在 Windows 上会同时带 ctrlKey+altKey，须排除，否则会吃掉用 AltGr 打出的字符
        (vKey && (ev.ctrlKey || ev.metaKey) && !ev.altKey) ||
        (ev.key === "Insert" && ev.shiftKey) ||
        // Alt+V 是 claude 自己的贴图键，一并收编：xterm 的原始编码不可靠，且只有
        // 走这里才能享受「图片文件 → 路径文本」的归一化（报错文案也引导用户按它）
        (!isMac && vKey && ev.altKey && !ev.ctrlKey && !ev.metaKey);
      if (!isPasteKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.repeat) return;
      void (async () => {
        // 复制的若是图片**文件**，claude 自己读剪贴板读不到（见 clipboardImagePath
        // 注释）——补上 conhost 的那一步：把路径当粘贴文本送进终端，claude 会把它
        // 转成 [Image #1]。term.paste() 会按 bracketed paste 模式自动包裹。
        // macOS 不走这条：Finder 复制文件放的是 furl，claude 的 osascript 路径路
        // 本就能读到，故直接发粘贴键（顺带省掉一次 IPC）。
        const path = isMac ? null : await clipboardImagePath();
        // 这一趟 IPC 期间 tab 可能已被关掉（term 已 dispose）：与 onData/onExit 同一条
        // 规矩，迟到的回调一律丢弃——term.paste() 打在已 dispose 的终端上会抛，而这个
        // IIFE 是 void 掉的，异常会变成 unhandled rejection
        if (disposed) return;
        if (path !== null) {
          // term.paste() 走 term.onData，pty id 未就位时同样会被 sendInput 排队
          term.paste(path);
          return;
        }
        sendInput(PASTE_SEQ);
      })();
    };
    host.addEventListener("keydown", onKeyDown, true);

    // 容器尺寸变化 → 防抖 fit + 通知 PTY resize（隐藏时尺寸为 0，跳过）
    const observer = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(refit, 150);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      disposeImeAnchor(); // 先还原 xterm 的两个定位函数，再 dispose 终端
      host.removeEventListener("keydown", onKeyDown, true);
      probes?.current.delete(tab.id);
      killers?.current.delete(tab.id);
      settles.forEach((t) => window.clearTimeout(t));
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      if (webglTimer !== undefined) window.clearTimeout(webglTimer); // 排着的重挂别再跑（term 即将 dispose）
      window.clearTimeout(spawnTimer); // 还没发出去的 spawn 直接掐掉（StrictMode 双跑 / 秒关 tab）
      const id = ptyIdRef.current;
      if (id !== null) void ptyKill(id);
      term.dispose();
      termRef.current = null;
    };
    // tab 生命周期 = 组件生命周期：projectPath/resumeSessionId 在 tab 内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  return <div ref={hostRef} className="terminal-pane" />;
}
