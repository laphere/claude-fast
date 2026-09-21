// 主进程（electron/main.ts + preload.ts）的 esbuild 公共配置：
// `npm run build`（build-electron.mjs）与 `npm run dev`（dev.mjs）**必须同一份**——
// 曾经 dev 单独维护 external，build 加了 node-pty 而 dev 没跟上，dev 产物把
// node-pty 打进 bundle，原生模块（prebuilds/*.node）按 bundle 自身路径解析而
// 全部落空，终端 spawn 报「Failed to load native module: conpty.node」（2026-09-21 实测）。
export const mainEsbuildConfig = {
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // ⚠️ @anthropic-ai/claude-agent-sdk 必须 external：它是 ESM-first，
  // 打进 CJS bundle 会让 esbuild 把 `import.meta.url` 降级成占位对象，
  // 而 SDK 靠它定位平台原生二进制 → 产物一载入就抛 ERR_INVALID_ARG_VALUE
  // （2026-09-20 实测）。对话层因此在运行时用动态 `await import()` 访问它。
  // ⚠️ node-pty 同样必须 external：N-API 原生模块靠 require 解析 prebuilds 里的
  // .node / conpty.dll，打进 bundle 会毁掉相对定位（且 asar 内的可执行文件
  // 没法 spawn——package.json 的 asarUnpack 已解包它）。
  external: ["electron", "@anthropic-ai/claude-agent-sdk", "node-pty"],
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
};
