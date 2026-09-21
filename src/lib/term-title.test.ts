// 终端标题清洗单测：样本取自 Tauri 线实测（docs/embedded-terminal-plan.md §6.6：
// app 真实 spawn 链 `cmd /D /S /C call claude.cmd` 按序写的四条标题 + 探针抓的
// OSC 原文），规则在 term-title.ts；丢弃 = null（调用方保留 tab 原值）。
import { describe, expect, it } from "vitest";
import { sessionTitleFromOsc } from "./term-title";

describe("sessionTitleFromOsc", () => {
  it("真实 spawn 链按序出现的四条噪声全部丢弃", () => {
    // ① cmd.exe 启动瞬间设的自身路径（大小写混杂的实测原文）
    expect(sessionTitleFromOsc("C:\\Windows\\system32\\cmd.EXE")).toBeNull();
    // ② npm shim 设的泛称
    expect(sessionTitleFromOsc("claude")).toBeNull();
    // ③ claude 的兜底标题（会话还没起名）
    expect(sessionTitleFromOsc("✳ Claude Code")).toBeNull();
    // ④ 退出瞬间清空标题
    expect(sessionTitleFromOsc("")).toBeNull();
  });

  it("剥掉前缀字形与空格，会话名完整保留", () => {
    // 闲时前缀 ✳；干活时 ◐/◑ 每 ~960ms 交替（动画帧，剥掉后内容相同）
    expect(sessionTitleFromOsc("✳ 探针标题·中文")).toBe("探针标题·中文");
    expect(sessionTitleFromOsc("◐ 打包运行时配置")).toBe("打包运行时配置");
    expect(sessionTitleFromOsc("◑ 打包运行时配置")).toBe("打包运行时配置");
    // 没有前缀字形也照常（OS 有别的工具改标题的余量）
    expect(sessionTitleFromOsc("修复登录页面")).toBe("修复登录页面");
  });

  it("只剥「字形 + 空格」的成对形态，不误伤 ◐ 开头的会话名", () => {
    // 用户真把会话名起成 ◐ 开头（无空格跟随）时不是前缀
    expect(sessionTitleFromOsc("◐实体标题")).toBe("◐实体标题");
    // 只剩字形＝没名字
    expect(sessionTitleFromOsc("◐")).toBeNull();
    expect(sessionTitleFromOsc("✳ ")).toBeNull();
  });

  it("空白折叠与控制字符剔除", () => {
    expect(sessionTitleFromOsc("  ✳   多余   空格  ")).toBe("多余 空格");
    expect(sessionTitleFromOsc("\u0007✳ 带BEL的标题")).toBe("带BEL的标题");
  });

  it("其他可执行路径形态也丢弃（.cmd/.bat/.ps1/.com）", () => {
    expect(sessionTitleFromOsc("E:\\DevTool\\claude.cmd")).toBeNull();
    expect(sessionTitleFromOsc("run.ps1")).toBeNull();
    expect(sessionTitleFromOsc("D:/x/y/claude.exe")).toBeNull();
  });

  it("超长串截到 200（会话名不会这么长，多半是误解析）", () => {
    expect(sessionTitleFromOsc("✳ " + "长".repeat(300))!.length).toBe(200);
  });
});
