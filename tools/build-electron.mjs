// 编译 Electron 主进程与 preload：electron/{main,preload}.ts → dist-electron/*.cjs
// （bundle 一体化输出，electron 运行时无需模块解析；renderer 由 vite 单独构建）
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // ⚠️ @anthropic-ai/claude-agent-sdk 必须 external：它是 ESM-first，
  // 打进 CJS bundle 会让 esbuild 把 `import.meta.url` 降级成占位对象，
  // 而 SDK 靠它定位平台原生二进制 → 产物一载入就抛 ERR_INVALID_ARG_VALUE
  // （2026-09-20 实测）。对话层因此在运行时用动态 `await import()` 访问它。
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
  sourcemap: false,
  logLevel: "info",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
};

await build({
  ...common,
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
});
