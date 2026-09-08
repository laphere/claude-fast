import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust 构建产物会被 cargo / 杀软短暂锁定（Windows 报 EBUSY），
      // 监听到它们会让 vite 直接崩溃，整体忽略
      ignored: ["**/src-tauri/target/**"],
    },
  },
});
