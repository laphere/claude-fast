/** 让"粗体"像系统终端那样变亮：给 claude 输出里「粗体 + 默认前景色」的文本补一条
 *  brightWhite（SGR 97）。
 *
 *  背景（实测，2026-09-20，claude 2.1.278）：claude TUI 的粗体是**裸 `ESC[1m`**，
 *  从不带颜色码（原始 PTY 流里 `ESC[1m` 出现 195 次、全部单独出现；颜色一律走
 *  真彩色 `ESC[38;2;r;g;bm`）。cmd / Windows Terminal 按 conhost 的 intense 语义
 *  把这种粗体渲染成"加亮白"——并排截图实测：同一行里 `**加粗**` 那段在系统终端
 *  是 #F2F2F2（= Campbell 的 brightWhite），内嵌终端里与正文同为 #CCCCCC。
 *
 *  为什么不能靠 xterm 的开关：`drawBoldTextInBrightColors` 只处理"带索引色(0-7)
 *  的粗体"（源码 TextureAtlas._getForegroundColor：`fgColorMode` 为 CM_P16/CM_P256
 *  且 `fgColor < 8` 才 +8），而 claude 用的是**默认色**与真彩色，正好落在它管不到
 *  的那两支（CM_DEFAULT 直接返回 colors.foreground）。字重那侧也没法用：本 app 把
 *  `fontWeightBold` 压成 400（见 TerminalPane 注释），粗体与正文完全同形同色。
 *  所以只能在写进终端之前自己补色——等价于 conhost 干的那一步。
 *
 *  规则（照 conhost / Windows Terminal 的语义）：
 *    - 粗体 + **默认前景色** ⇒ 补 `ESC[97m`（= 主题的 brightWhite）；
 *    - 粗体结束（`ESC[22m` / `ESC[0m`）或流自己指定了颜色 ⇒ 补 `ESC[39m` 还回默认色。
 *      "流自己指定颜色"这条必须还原：WT 对**真彩色**的粗体不加亮（RGB 没有 bright
 *      变体），claude 的 44 处「粗体 + 灰 #999999」就该保持灰——不还原的话补的 97
 *      会把它们冲成亮白，反而比系统终端更亮。
 *    - 「带索引色 0-7 的粗体」交给 xterm 的 `drawBoldTextInBrightColors`（已开），
 *      两边不重叠：这里只在"当前前景色是默认色"时才动手。
 *
 *  实现是**字节级**的：输出 chunk 是 Uint8Array（xterm 自己解码跨 chunk UTF-8），
 *  这里只认 ESC 开头的转义序列、其余字节原样透传，不碰多字节字符。转义序列可能
 *  被 chunk 边界切开（实测有），未结束的尾部字节留到下一个 chunk 前拼回来。 */
export interface BoldBrightFilter {
  /** 改写一段 PTY 输出；返回可直接交给 `term.write` 的字节 */
  push(chunk: Uint8Array): Uint8Array;
}

const ESC = 0x1b;
const CSI = 0x5b; // '['
const OSC = 0x5d; // ']'
const BEL = 0x07;
const ST = 0x5c; // '\'（OSC 的 ESC \ 收尾）

/** CSI 序列的结束下标（终止字节 0x40-0x7E）；未结束（chunk 被切开）返回 -1；
 *  首字节就不合法返回 -2（当普通字节跳过） */
function findCsiEnd(b: Uint8Array, start: number): number {
  for (let i = start + 2; i < b.length; i++) {
    if (b[i] >= 0x40 && b[i] <= 0x7e) return i;
    if (b[i] < 0x20 || b[i] > 0x3f) return -2;
  }
  return -1;
}

/** OSC 序列（`ESC ] ... BEL` 或 `ESC ] ... ESC \`）的结束下标；未结束返回 -1 */
function findOscEnd(b: Uint8Array, start: number): number {
  for (let i = start + 2; i < b.length; i++) {
    if (b[i] === BEL) return i + 1;
    if (b[i] === ESC && b[i + 1] === ST) return i + 2;
  }
  return -1;
}

/** 补色用的两条常量序列（push 里按引用共享，勿改动内容） */
const SGR_BRIGHT = new Uint8Array([ESC, CSI, 0x39, 0x37, 0x6d]); // ESC[97m
const SGR_DEFAULT = new Uint8Array([ESC, CSI, 0x33, 0x39, 0x6d]); // ESC[39m

export function createBoldBrightFilter(): BoldBrightFilter {
  // 终端侧状态（只能从看得见的流里推断）：粗体开着？前景色是默认色？补的 97 还生效？
  let bold = false;
  let fgDefault = true;
  let applied = false;
  /** 上一个 chunk 末尾没结束的转义序列（独立拷贝，不引用任何 chunk） */
  let carry = new Uint8Array(0);

  return { push };

  /** 段式改写：不逐字节装箱——只在「补色注入点」处把流切成几段 Uint8Array
   *  （透传段是 subarray 视图），最后一次性拼接。claude 输出几乎每段都带
   *  转义序列、快路径基本不触发，逐字节 push 到 number[] 再 from 回来的
   *  旧实现等于对每个 8KB chunk 做 ~8k 次装箱分配，流式输出期间 GC 压力
   *  持续不断；现在除最终拼接（有注入时）与残留拷贝外零分配。 */
  function push(chunk: Uint8Array): Uint8Array {
    // 快路径：没有转义序列、也没有半条残留 → 原样返回，不复制
    if (carry.length === 0 && !chunk.includes(ESC)) return chunk;

    // 有残留才拼一个新缓冲；否则直接在 chunk 上扫（透传段全是它的视图）
    let bytes: Uint8Array;
    if (carry.length > 0) {
      bytes = new Uint8Array(carry.length + chunk.length);
      bytes.set(carry);
      bytes.set(chunk, carry.length);
      carry = new Uint8Array(0);
    } else {
      bytes = chunk;
    }
    const parts: Uint8Array[] = [];
    let segStart = 0; // 当前透传段的起点
    let i = 0;
    let carryFrom = -1; // 从这里起是未结束的转义序列（转存进 carry）
    while (i < bytes.length) {
      if (bytes[i] !== ESC) { i++; continue; }
      if (i + 1 >= bytes.length) { carryFrom = i; break; }
      const kind = bytes[i + 1];
      if (kind === CSI) {
        const end = findCsiEnd(bytes, i);
        if (end === -1) { carryFrom = i; break; }
        if (end === -2) { i++; continue; } // 首字节不合法：当普通字节留在透传段
        if (bytes[end] === 0x6d) {
          const act = applySgr(bytes.subarray(i + 2, end));
          if (act !== 0) {
            emit(bytes.subarray(segStart, end + 1)); // 原序列透传
            emit(act === 1 ? SGR_BRIGHT : SGR_DEFAULT); // 再补色
            segStart = end + 1;
          }
        }
        i = end + 1;
        continue;
      }
      if (kind === OSC) {
        const end = findOscEnd(bytes, i);
        if (end === -1) { carryFrom = i; break; }
        i = end;
        continue;
      }
      // 其余 ESC 序列：ESC + 一字节；`ESC ( ) # % * +` 这类带中间字节的再吞一个
      const extra = kind >= 0x20 && kind <= 0x2f ? 2 : 1;
      if (i + extra >= bytes.length) { carryFrom = i; break; }
      i += extra + 1;
    }
    emit(bytes.subarray(segStart, carryFrom < 0 ? bytes.length : carryFrom));
    if (carryFrom >= 0) carry = bytes.slice(carryFrom); // slice = 拷贝，脱开对 chunk 的引用
    if (parts.length === 1) return parts[0]; // 无注入：整段（或 chunk 的视图）原样返回
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;

    function emit(v: Uint8Array): void {
      parts.push(v);
    }
  }

  /** 处理一条 SGR（`ESC[<params>m`）：先更新状态，再返回要补的序列：
   *  1 = 补 ESC[97m，-1 = 补 ESC[39m，0 = 不补。补色码追加在该序列**之后**——
   *  "同一条序列里既开粗体又给颜色"的情形因此不会被
   *  打乱（那种情况下 fgDefault 已为 false，不会补）。 */
  function applySgr(paramBytes: Uint8Array): number {
    const reset = () => { bold = false; fgDefault = true; applied = false; };
    // 参数写成字符串再切分：真彩色里夹着的 0/1（如 rgb(1,0,0)）必须整段吃掉，
    // 否则会被当成"重置/粗体"，把状态机带偏
    const tokens = String.fromCharCode(...paramBytes).split(";");
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "") { reset(); continue; } // 空参数等同 0（"ESC[m"、"ESC[;m" 都是重置）
      if (!/^\d+$/.test(t)) {
        if (t.startsWith("38:")) { fgDefault = false; applied = false; } // 38:2::r:g:b 子参数写法
        continue;
      }
      const p = Number(t);
      if (p === 0) reset();
      else if (p === 1) bold = true;
      else if (p === 22) bold = false;
      else if (p === 39) { fgDefault = true; applied = false; }
      else if (p === 38 || p === 48 || p === 58) {
        // 扩展色：38/48/58 后面跟 "5;n" 或 "2;r;g;b"，把后续参数一并跳过
        const mode = Number(tokens[i + 1]);
        if (p === 38) { fgDefault = false; applied = false; }
        if (mode === 2) i += 4;
        else if (mode === 5) i += 2;
      } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        fgDefault = false;
        applied = false;
      }
      // 其余参数（背景色 40-47/48/49、下划线、删除线……）不影响前景色
    }
    const want = bold && fgDefault;
    if (want && !applied) { applied = true; return 1; }
    if (!want && applied) { applied = false; return -1; }
    return 0;
  }
}
