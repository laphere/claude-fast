// 编译 Electron 主进程与 preload：electron/{main,preload}.ts → dist-electron/*.cjs
// （bundle 一体化输出，electron 运行时无需模块解析；renderer 由 vite 单独构建）
// 公共配置（external 等）与 dev.mjs 共用一份：tools/esbuild-main.config.mjs
import { build } from "esbuild";
import { mainEsbuildConfig } from "./esbuild-main.config.mjs";

await build({
  ...mainEsbuildConfig,
  sourcemap: false,
  logLevel: "info",
});
