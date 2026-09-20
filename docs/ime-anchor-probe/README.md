# IME 锚点探针（回归用）

`src/lib/ime-anchor.ts` 干的事是「把 IME 候选窗锚到 claude 自己画的那个反显光标格上」。
它覆盖的是 xterm 的**私有**内部（`_core._syncTextArea`、`_core._compositionHelper.updateCompositionElements`、
`_core._renderService.dimensions.css.cell`、`_core.coreService.isCursorHidden`）——typings 里
没有声明、随大版本可改。升级 xterm 后补丁一旦静默失效，在没有真 IME 的机器上完全看不出来，
所以留这个探针：在真 Chromium 里把补丁跑一遍并在 DOM 上断言落点。

它验的是机制（textarea 落在哪一格），**验不了真输入法**——候选窗到底贴不贴光标只能人工用
真 IME 试（见 CLAUDE.md 终端那条）。

## 跑法

```bash
# 1) 打包探针（用仓库自己的 esbuild；@xterm/xterm 用别名指到 node_modules，
#    因为探针文件在 docs/ 下，按普通解析找不到顶层 node_modules）
npx esbuild docs/ime-anchor-probe/probe.ts --bundle --format=esm \
  --outfile=docs/ime-anchor-probe/probe.bundle.mjs --log-level=warning \
  --alias:@xterm/xterm="$PWD/node_modules/@xterm/xterm/lib/xterm.js"

# 2) 起静态服务（ES module 不能走 file://）
node docs/ime-anchor-probe/serve.cjs &

# 3) headless 跑一遍，抓结果行（Edge 与 WebView2 同为 Chromium；Chrome 同理）
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --no-sandbox --virtual-time-budget=12000 \
  --dump-dom "http://localhost:8791/probe.html" 2>/dev/null | grep -o 'RESULT:.\{0,1200\}'
```

期望输出里 `"pass":true` 且五步全 `ok`：

| 步骤 | 断言 |
|---|---|
| ① | 藏光标 + 自画反显空格 → textarea 锚到那一格（而不是 xterm 认的逻辑光标） |
| ② | 真光标可见 → **完全不插手**（落回 xterm 原行为）；这条是 vim/nano 之类不被误伤的关键 |
| ③ | 再次藏光标 → 重新锚回 |
| ④ | 输入变长、光标后移 → 跟着走 |
| ⑤ | 上方另有反显空格（别的 UI 元素）→ 仍取最下面那格 |

`"internals":false` 或 ① 就不过 = 探针摸不到 xterm 内部字段了（多半是 xterm 升级改了名字）：
此时 `installImeCaretAnchor` 会走"不接管"分支（行为退回改动前，不会更差），
按新的字段名修 `src/lib/ime-anchor.ts` 里的 `XtermInternals` 即可。

跑完记得删掉 `probe.bundle.mjs`（构建产物不入库）并关掉服务。
