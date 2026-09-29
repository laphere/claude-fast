import { describe, expect, it } from "vitest";

// list-markers.ts 无 import、模块顶层无副作用，静态引入安全（与 links.test.ts
// 不同，那边要先垫 window 桩）。node 环境没有 DOMParser，DOM 变换路径靠
// Electron 隐身窗探针验证（项目惯例，同 linkifyHtml）；这里只覆盖不依赖 DOM
// 的行为：任何输入都不抛、原样返回。两条出口（无 <ol>/<ul> 的快速门 / 无
// DOMParser 的兜底）在 node 里返回值相同，区分不了——快速门的判据（转义实体
// 不触发）由探针侧覆盖。
import { materializeListMarkers } from "./list-markers";

describe("materializeListMarkers（无 DOM 环境）", () => {
  it("没有 <ol>/<ul> 标签时原样返回", () => {
    const html = "<p>普通段落</p><pre><code>代码块</code></pre>";
    expect(materializeListMarkers(html)).toBe(html);
  });

  it("node 无 DOMParser：含列表也原样返回（防御性兜底，不抛）", () => {
    expect(materializeListMarkers('<ol start="5"><li>a</li></ol>')).toBe('<ol start="5"><li>a</li></ol>');
    expect(materializeListMarkers("<ul><li>x</li></ul>")).toBe("<ul><li>x</li></ul>");
  });

  it("空串 / 纯文本不抛", () => {
    expect(materializeListMarkers("")).toBe("");
    expect(materializeListMarkers("就是一句话")).toBe("就是一句话");
  });
});
