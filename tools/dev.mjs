// 开发模式：并行启动 vite dev server（renderer，HMR）与 electron（主进程 watch 重建后自动重启）
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context as esbuildContext } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const VITE_PORT = 1420;
const DEV_URL = `http://127.0.0.1:${VITE_PORT}`;

const children = [];
let electronProc = null;
let shuttingDown = false;
/** restartElectron 主动 kill 旧实例时置位，避免通用 exit 监听把 dev 会话整个关掉 */
let expectedExit = false;

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown && child !== electronProc) {
      // vite 等关键子进程意外退出时终止整个 dev 会话
      shutdown(code ?? 1);
    }
  });
  return child;
}

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("vite dev server 启动超时"));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

async function startElectron() {
  const electronExe = require("electron"); // dev 下为 electron 二进制路径
  const proc = spawn(electronExe, ["."], { cwd: root, stdio: "inherit" });
  electronProc = proc;
  children.push(proc);
  proc.on("exit", (code) => {
    if (!shuttingDown && !expectedExit) shutdown(code ?? 0);
  });
  console.log("[dev] electron 已启动（renderer: " + DEV_URL + "），修改 electron/ 下代码会自动重启");
}

function restartElectron() {
  if (shuttingDown) return;
  if (electronProc && electronProc.exitCode === null) {
    const old = electronProc;
    expectedExit = true;
    old.once("exit", () => {
      expectedExit = false;
      startElectron();
    });
    old.kill();
    children.splice(children.indexOf(old), 1);
  } else {
    startElectron();
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      if (c.exitCode === null) c.kill();
    } catch {
      // ignore
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 1. 编译主进程（初始构建，先保证 electron 有产物可跑）。
//    配置与 build-electron.mjs 共用一份（external 列表等曾因两处漂移踩坑，见该文件头注）
import { mainEsbuildConfig } from "./esbuild-main.config.mjs";
const ctx = await esbuildContext({
  ...mainEsbuildConfig,
  logLevel: "info",
});
await ctx.rebuild();

// 2. 启动 vite dev server（显式绑定 127.0.0.1：localhost 在部分环境解析为
//    IPv6 ::1，导致下面的轮询与 electron 加载都连不上）
run(process.execPath, [
  path.join(root, "node_modules", "vite", "bin", "vite.js"),
  "--port",
  String(VITE_PORT),
  "--strictPort",
  "--host",
  "127.0.0.1",
]);

// 3. 等 renderer 就绪后启动 electron；主进程代码改动 → 重建并重启。
//    esbuild 0.25+ 移除了 watch 的 onRebuild 回调，这里用 fs.watch 自行监控源码
await waitForServer(DEV_URL);
await ctx.watch({ delay: 200 });

let rebuildTimer = null;
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    ctx
      .rebuild()
      .then(() => {
        console.log("[dev] 主进程代码已重建，重启 electron…");
        restartElectron();
      })
      .catch((e) => console.error("[dev] 重建失败：", String(e)));
  }, 400);
}
fs.watch(path.join(root, "electron"), { recursive: true }, scheduleRebuild);

await startElectron();
