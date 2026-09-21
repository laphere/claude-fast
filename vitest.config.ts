import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 后端（electron/backend）+ 前端纯逻辑（src/lib，如 term-title 清洗）单测，node 环境；
    // 含 DOM 依赖的组件测试不在其列（renderer 侧无组件级自动化）
    include: ["electron/**/*.test.ts", "src/lib/*.test.ts"],
    environment: "node",
  },
});
