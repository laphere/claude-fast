/** IME 锚点探针（回归用，不是构建产物）：在真 Chromium 里跑一遍 src/lib/ime-anchor.ts，
 *  断言 `.xterm-helper-textarea` 被摆到 claude 画的那个反显光标格上（以及不该接管时不接管）。
 *
 *  为什么要有它：`ime-anchor.ts` 覆盖的是 xterm 的内部方法（`_core._syncTextArea` /
 *  `_core._compositionHelper.updateCompositionElements` / `_core._renderService.dimensions`
 *  / `_core.coreService.isCursorHidden`），这些都是**未声明、随大版本可改**的私有字段。
 *  升级 xterm 后"补丁静默失效"在没有真 IME 的机器上完全看不出来——这个探针就是那条
 *  能在 CI/本地一键重跑的兜底线。跑法见同目录 README.md。
 *
 *  用 DOM 渲染器即可：缓冲区与格尺寸的语义与 WebGL 渲染器一致（app 里那句
 *  `_renderService.dimensions.css.cell` 两个渲染器都提供）。 */
import { Terminal } from "@xterm/xterm";
import { installImeCaretAnchor } from "../../src/lib/ime-anchor";

const pre = document.createElement("pre");
pre.id = "result";
document.body.appendChild(pre);
const dump = (o: unknown): void => {
  pre.textContent = "RESULT:" + JSON.stringify(o);
};
window.addEventListener("error", (e) => dump({ fatal: String(e.message) }));

const host = document.createElement("div");
host.style.cssText = "width:800px;height:400px";
document.body.appendChild(host);
const term = new Terminal({ cols: 80, rows: 20, fontSize: 16 });
term.open(host);
installImeCaretAnchor(term);

const ta = term.textarea!;
/* 内部结构在 typings 里没有声明，探针里同样只能转型取——**取不到就直接算失败**：
 * 那正是"xterm 升级把补丁打没了"的症状。 */
const core = (term as unknown as { _core?: any })._core;
const cell = core?._renderService?.dimensions?.css?.cell ?? { width: 0, height: 0 };
const result: any = { cellW: cell.width, cellH: cell.height, internals: !!core?._syncTextArea, steps: [] };
const C = (col: number, row: number) => ({ left: col * cell.width, top: row * cell.height });
const step = (name: string, expect: { left: number; top: number }): void => {
  const got = { left: parseFloat(ta.style.left || "NaN"), top: parseFloat(ta.style.top || "NaN") };
  result.steps.push({
    name,
    got,
    expect,
    ok: Math.abs(got.left - expect.left) < 0.6 && Math.abs(got.top - expect.top) < 0.6,
  });
};

/** 各阶段：输入字节 → 断言上一阶段的落点 */
const stages: Array<{ write?: string; expect?: string; at?: { left: number; top: number } }> = [
  // claude 式画面：末行 "> 是不是"，第 8 列（0 基）反显空格当光标，真光标藏起来
  { write: "\x1b[2J\x1b[H\x1b[20;1H> 是不是\x1b[9G\x1b[7m \x1b[0m\x1b[?25l" },
  { expect: "① 锚到 claude 画的光标（末行第 8 列）", at: C(8, 19), write: "\x1b[?25h\x1b[1;1H" },
  // 真光标可见 = 这个程序用真光标（shell/vim/nano…）：必须完全不插手，交还 xterm 原行为
  { expect: "② 真光标可见 → 不插手（xterm 原行为 0,0）", at: { left: 0, top: 0 }, write: "\x1b[?25l\x1b[20;60H" },
  { expect: "③ 又藏起来 → 重新锚回第 19 行第 8 列", at: C(8, 19), write: "\x1b[20;1H\x1b[K> 是不是很\x1b[15G\x1b[7m \x1b[0m" },
  { expect: "④ 输入变长后跟到第 14 列", at: C(14, 19), write: "\x1b[10;5H\x1b[7m \x1b[0m\x1b[12;9H\x1b[7m \x1b[0m" },
  { expect: "⑤ 上方另有反显空格 → 仍取最下面那格", at: C(14, 19), write: "\x1b[2J\x1b[H\x1b[3;1H> \x1b[4G\x1b[7m \x1b[0m" },
  // 新会话形态：输入框跟着"已输出内容"走，空会话里它就在屏幕**上方**（logo 正下方），
  // 下面整片是空的——扫描窗只留底部几行会整片漏掉（实测用户新会话就是这么翻车的）
  { expect: "⑥ 输入框在屏幕上方（新会话形态）也命中", at: C(3, 2) },
];

let i = 0;
const next = (): void => {
  const s = stages[i];
  if (!s) {
    result.hiddenWhenVisible = core?.coreService?.isCursorHidden;
    result.pass = result.internals && result.steps.every((x: any) => x.ok);
    dump(result);
    return;
  }
  i++;
  try {
    if (s.expect && s.at) step(s.expect, s.at);
    if (s.write) term.write(s.write);
  } catch (e) {
    dump({ fatal: String(e), stage: i });
    return;
  }
  setTimeout(next, 250);
};
setTimeout(next, 250);
