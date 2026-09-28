import { describe, expect, it } from "vitest";

// links.ts → api.ts 在模块顶层读 window.claudeFast（node 环境没有 window），
// 静态 import 会在加载期就炸。先垫一个最小 window 桩、再动态引入被测模块。
// 这里只测 trimUrlTail 这块纯逻辑：linkifyHtml 依赖 DOMParser，vitest 是 node
// 环境（vitest.config 注释明说 renderer 侧不进组件级自动化），DOM 部分靠
// headless 探针/真机验证。
(globalThis as Record<string, unknown>).window = {
  claudeFast: { invoke: () => Promise.resolve() },
};
const { trimUrlTail } = await import("./links");

describe("trimUrlTail", () => {
  it("干净的 URL 原样返回", () => {
    expect(trimUrlTail("http://127.0.0.1:17642")).toBe("http://127.0.0.1:17642");
    expect(trimUrlTail("https://example.com/a?b=1&c=2")).toBe("https://example.com/a?b=1&c=2");
  });

  it("尾部 ASCII 标点剥掉（中文句子常见的句读接在 URL 后面）", () => {
    expect(trimUrlTail("https://example.com/x.")).toBe("https://example.com/x");
    expect(trimUrlTail("https://example.com/x,")).toBe("https://example.com/x");
    expect(trimUrlTail("https://example.com/x...")).toBe("https://example.com/x");
    expect(trimUrlTail("https://example.com/x');")).toBe("https://example.com/x");
    // 句末 `）。` 的 ASCII 对应形态：`)` 走配平规则、`.` 走标点
    expect(trimUrlTail("https://example.com/x).")).toBe("https://example.com/x");
  });

  it("未配平的右括号剥掉、配平的保留（wiki 风格 URL）", () => {
    expect(trimUrlTail("https://example.com/x)")).toBe("https://example.com/x");
    expect(trimUrlTail("https://en.wikipedia.org/wiki/Python_(programming_language)")).toBe(
      "https://en.wikipedia.org/wiki/Python_(programming_language)",
    );
    // 配平之后再拖了标点的：先剥标点，再对剩下的配平判定
    expect(trimUrlTail("https://en.wikipedia.org/wiki/Python_(programming_language).")).toBe(
      "https://en.wikipedia.org/wiki/Python_(programming_language)",
    );
  });

  it("剥到只剩 scheme 也不越界（调用方用 URL_MIN 再判一次，这里只保证不抛不空转）", () => {
    expect(trimUrlTail("https://...")).toBe("https://");
    expect(trimUrlTail("https://")).toBe("https://");
  });

  it("空串 / 单字符不抛", () => {
    expect(trimUrlTail("")).toBe("");
    expect(trimUrlTail(".")).toBe("");
  });
});
