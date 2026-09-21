/** 终端宽度表：官方 Unicode 11 + 「变体选择符」补丁 + V11 与 claude 的差集表。
 *
 *  交付的宽度 = V11 表（兜底）→ 差集表（V11 之后的新 emoji / 改判符号，见 WIDTH_DELTA）
 *  → VS16 补丁（`⚠️` 这类序列）。
 *
 *  ### 为什么要换掉 xterm 默认的宽度表
 *  xterm 自带的是 Unicode 6.3 的表，把 ✅ ❌ 这类 emoji 记 **1 格**；而 claude 的
 *  TUI（与 cmd/WT 一致）按显示宽度排版，emoji 记 **2 格**。claude 的表格是按显示宽度
 *  补空格的，于是每个 emoji 都让该行少 1 格，行尾的 `│` 与边框（`─` 横线）错开、
 *  逐行左移。细节与实测数据见 docs/embedded-terminal-plan.md 6.3 与 6.4。
 *
 *  ### 为什么还要在 Unicode 11 上再补两条
 *  ① **差集表**（`WIDTH_DELTA`）：Unicode 11 的表只到 Unicode 11——之后新增的 emoji
 *  （🥲 U+1F972、🪄 U+1FA84、🩷 U+1FA77、🫠 U+1FAE0…）它记 1 格，claude 记 2 格；
 *  新版 EAW 把八卦 ☰-☷、六十四卦 ䷀-䷿ 之类由 N 改判成 W，它也不知道。模型随手写个
 *  新 emoji 就会错列，所以这批码位单独列一张表。
 *  ② **变体选择符**：Unicode 11 表只认 EAW 的 W 区间，管不到「默认文本呈现、加 U+FE0F
 *  才变 emoji」的那批码位——`⚠`(U+26A0)、`▶`(U+25B6)、`✳`(U+2733)… 它算 **1 格**，
 *  而 U+FE0F 算 0 格并入前一格，于是一整个 `⚠️` 被算成 1 格。claude 那边（string-width
 *  一线，逐码位对过）把 `⚠️`（基字 + VS16）整体记 **2 格**、裸 `⚠` 仍记 1 格——
 *  实测漏网的正是这种：一条 `⚠️ …` 的行仍比右边框短 1 格（用户截图 1965×561 逐像素量：
 *  该行右边框 1904，其余 1918，差 1 格 = 14 设备px）。
 *
 *  ### 补丁怎么做
 *  注册自己的 provider，V11 的结论原样透传，只改写两类：差集表里的码位按表给宽度
 *  （0 宽的当组合符并入前一格）；U+FE0F 在**前一个字符是 emoji 基字**时返回「宽度 2 +
 *  shouldJoin」——xterm 的合并分支（InputHandler.print 里那条 "Combining character
 *  widens 1 column to 2"）会把前一格撑成 2 格、再补一个零宽占位，合计正好 2 格；
 *  不是 emoji 基字（`A` `☐` `①` `✻`）时保持 V11 语义（0 宽并入前格）。
 *
 *  「是不是 emoji 基字」用 `\p{Emoji}` 判（与 string-width 同源），并把 `#` `*` `0-9`
 *  排除掉：它们 Emoji 属性为真，但只有后跟 U+20E3 才凑成键帽序列，单独的 `#️` 在
 *  string-width 那边仍算 1 格（逐码位比对过 33 个字符，除这三个键帽基字外全部一致）。
 *
 *  ### 还剩什么没覆盖
 *  只有**谚文字母**（U+1161-11FF，160 个码位）：xterm 刻意把它们当组合符（NFD 韩文要靠
 *  这个才拼得对），claude 那边算 1 格——只有「分解形式（NFD）的韩文」才会碰到，模型
 *  输出的韩文都是预组合形式（NFC），实测的两次表格故障也都不涉及。其余差集已全部覆盖
 *  （全码位扫描的残差就只有这一块，见 .workbuddy/tmp/stringwidth-check.mjs）。
 *
 *  ### 与 xterm 的接口约定
 *  属性值布局（见 @xterm/xterm 的 common/services/Services.ts）：bit0 = shouldJoin、
 *  bit1-2 = 宽度、bit3+ = 字符类别（V6/V11 provider 恒填 0，xterm 自己也没读过
 *  extractCharKind）。这里借 bit3 记「前一个是 emoji 基字」——VS16 要看**前一个**字符的
 * 类别，而 API 只把前一个的属性值传进来（没有码位），只能这么带。 */
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";

/** U+FE0F VARIATION SELECTOR-16：把前一个字符升格成 emoji 呈现 */
const VS16 = 0xfe0f;
/** 属性值里的「前一个是 emoji 基字」标记（= 状态位 bit0，落在值的 bit3） */
const EMOJI_BASE = 1 << 3;

const EMOJI_RE = /\p{Emoji}/u;

/** 该码位是不是一个「能带 VS16 变 emoji」的基字。两类排除（都逐码位与 string-width 对过）：
 *  - 键帽基字 `#` `*` `0-9`：Emoji 属性为真，但要后跟 U+20E3 才凑成序列，单独的 `#️` 仍算 1 格；
 *  - 区域指示符 U+1F1E6-1F1FF（国旗的两半）：成对（🇨🇳）才是 2 格 emoji，单独一个加 VS16 仍是 1 格。 */
function isEmojiBase(cp: number): boolean {
  if (cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39)) return false;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return false;
  // 快路径：Emoji 属性最低是 ©(U+00A9)，最高在本机 Unicode 版本里是 U+1FAFF
  if (cp < 0xa9 || cp > 0x1faff) return false;
  return EMOJI_RE.test(String.fromCodePoint(cp));
}

/** 按 xterm 的布局打包属性值（与 UnicodeService.createPropertyValue 同构） */
function prop(width: number, shouldJoin: boolean, emojiBase = false): number {
  return (emojiBase ? EMOJI_BASE : 0) | ((width & 0x3) << 1) | (shouldJoin ? 1 : 0);
}
const widthOf = (v: number): number => (v >> 1) & 0x3;
const isEmojiBaseProp = (v: number): boolean => ((v >> 3) & 1) !== 0;

/** V11 表与 claude 的**全部**差集（[起, 止, 宽度]，闭区间；只排除谚文字母，见文件头）。
 *  三类内容：
 *   - Unicode 11 之后新增/改判为宽的 emoji（🥲 U+1F972、🪄 U+1FA84、🩷 U+1FA77、🫠 U+1FAE0…），
 *     这条最要紧——模型随手写个新 emoji 就会错列；
 *   - 新版 EAW 由 N 改判为 W 的符号：八卦 ☰-☷、六十四卦 ䷀-䷿、笔画 ⿼-⿿、ㆻ 等；
 *   - 反向的少数（claude 记 0/1 而我们记 1/2）：不可见填充符 ㅤﾠ、软连字符、未分配码位等。
 *  生成方式：`.workbuddy/tmp/stringwidth-check.mjs`（`--gen` 段）拿 string-width（claude 同款
 *  算法）与 V11 表逐码位比差集、压成区间——换 claude 或 Unicode 版本后重跑那个脚本即可更新。 */
const WIDTH_DELTA: ReadonlyArray<readonly [number, number, number]> = [
  [0xad, 0xad, 0],
  [0x890, 0x891, 0],
  [0x897, 0x89f, 0],
  [0x8ca, 0x8d2, 0],
  [0xb55, 0xb55, 0],
  [0xc3c, 0xc3c, 0],
  [0xd81, 0xd81, 0],
  [0xece, 0xece, 0],
  [0x115f, 0x115f, 0],
  [0x1734, 0x1734, 1],
  [0x180f, 0x180f, 0],
  [0x1abf, 0x1ace, 0],
  [0x1dfa, 0x1dfa, 0],
  [0x2065, 0x2065, 0],
  [0x2630, 0x2637, 2],
  [0x268a, 0x268f, 2],
  [0x2ffc, 0x2fff, 2],
  [0x3164, 0x3164, 0],
  [0x31bb, 0x31bf, 2],
  [0x31e4, 0x31e5, 2],
  [0x31ef, 0x31ef, 2],
  [0x4dc0, 0x4dff, 2],
  [0xa82c, 0xa82c, 0],
  [0xffa0, 0xffa0, 0],
  [0xfff0, 0xfff8, 0],
  [0x1f1ae, 0x1f1ae, 2],
  [0x1f6d6, 0x1f6d9, 2],
  [0x1f6dc, 0x1f6df, 2],
  [0x1f6fb, 0x1f6fc, 2],
  [0x1f7da, 0x1f7da, 2],
  [0x1f7f0, 0x1f7f0, 2],
  [0x1f90c, 0x1f90c, 2],
  [0x1f93b, 0x1f93b, 1],
  [0x1f946, 0x1f946, 1],
  [0x1f972, 0x1f972, 2],
  [0x1f977, 0x1f979, 2],
  [0x1f9a3, 0x1f9a4, 2],
  [0x1f9ab, 0x1f9ad, 2],
  [0x1f9cb, 0x1f9cc, 2],
  [0x1fa74, 0x1fa77, 2],
  [0x1fa7b, 0x1fa7c, 2],
  [0x1fa83, 0x1fa8f, 2],
  [0x1fa96, 0x1fac6, 2],
  [0x1fac8, 0x1fac8, 2],
  [0x1facc, 0x1fadd, 2],
  [0x1fadf, 0x1faeb, 2],
  [0x1faef, 0x1fafa, 2],
];

/** 查差集表（二分；命中返回该码位应有的宽度，未命中 undefined）。
 *  表里最小码位是 U+00AD，ASCII 与常用拉丁在快路径里直接跳过。 */
function deltaWidth(cp: number): number | undefined {
  if (cp < 0xad || cp > 0x1fafa) return undefined;
  let lo = 0;
  let hi = WIDTH_DELTA.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, w] = WIDTH_DELTA[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return w;
  }
  return undefined;
}

class ClaudeWidthProvider implements IUnicodeVersionProvider {
  /** 注册到 `term.unicode` 里的 key（`activeVersion` 要用同一个字符串） */
  public readonly version = "11+claude";

  constructor(private readonly base: IUnicodeVersionProvider) {}

  public wcwidth(codepoint: number): 0 | 1 | 2 {
    return this.base.wcwidth(codepoint);
  }

  public charProperties(codepoint: number, preceding: number): number {
    if (codepoint === VS16) {
      // 前一格有多宽（0 = 行首/独立 VS16，就没有可撑开的格子）
      const prevWidth = widthOf(preceding);
      const join = prevWidth > 0;
      return prop(isEmojiBaseProp(preceding) ? 2 : 0, join);
    }
    const delta = deltaWidth(codepoint);
    if (delta !== undefined) {
      // 差集里的码位按 claude 的宽度给：0 宽的当组合符并入前一格（不占位），1/2 宽的正常占格
      return prop(delta, delta === 0 && preceding !== 0, isEmojiBase(codepoint));
    }
    const info = this.base.charProperties(codepoint, preceding);
    return prop(widthOf(info), (info & 1) !== 0, isEmojiBase(codepoint));
  }
}

/** 把宽度表装进终端。**必须在写入任何数据之前调用**——xterm 是在解析那一刻把宽度
 *  算进单元格的，之后再换只影响新写入的行。
 *
 *  Unicode11Addon 只导出 addon 类、没导出宽度表本身，而它的 `activate()` 就是往终端
 *  `register` 一个 provider——用一个最小替身接出来，再裹上 VS16 补丁注册回去。
 *  接不出来（addon 改了实现）就退回官方 addon：丢的是差集表与 VS16 补丁，V11 那层照旧。 */
export function installTerminalWidthTable(term: Terminal): void {
  let v11: IUnicodeVersionProvider | undefined;
  const stub = {
    unicode: {
      register: (p: IUnicodeVersionProvider) => {
        v11 = p;
      },
    },
  } as unknown as Terminal;
  try {
    new Unicode11Addon().activate(stub);
  } catch {
    v11 = undefined;
  }
  if (!v11) {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    return;
  }
  const provider = new ClaudeWidthProvider(v11);
  term.unicode.register(provider);
  term.unicode.activeVersion = provider.version;
}
