import { describe, expect, it } from "vitest";
import { reorderItems } from "./tab-order";

/** 用例统一用字母数组，读起来就是「a b c → 谁去了哪」 */
const abc = ["a", "b", "c", "d"];

describe("reorderItems（tab 拖拽调序的插入位补偿）", () => {
  it("落在自己左右两边 = 原样（不产生无意义的改动）", () => {
    // b 的下标 1：gap 1（自己的左半）与 gap 2（自己的右半）都该是原地不动
    expect(reorderItems(abc, 1, 1)).toEqual(abc);
    expect(reorderItems(abc, 1, 2)).toEqual(abc);
  });

  it("往后拖：gap 是原数组坐标，摘出自己后要补偿一格", () => {
    // a→c 左侧（gap 2）：摘掉 a 后 c 落到下标 1，插在它前面 = 下标 1
    expect(reorderItems(abc, 0, 2)).toEqual(["b", "a", "c", "d"]);
    // a→c 右侧（gap 3）
    expect(reorderItems(abc, 0, 3)).toEqual(["b", "c", "a", "d"]);
    // a→末尾（gap = length）
    expect(reorderItems(abc, 0, 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("往前拖：落点在自己之前，不需要补偿", () => {
    // d→a 左侧（gap 0）＝移到最前
    expect(reorderItems(abc, 3, 0)).toEqual(["d", "a", "b", "c"]);
    // d→b 右侧（gap 2）
    expect(reorderItems(abc, 3, 2)).toEqual(["a", "b", "d", "c"]);
  });

  it("相邻互换成对（拖到紧邻那格的另一半）", () => {
    expect(reorderItems(abc, 1, 3)).toEqual(["a", "c", "b", "d"]); // b 到 c 之后
    expect(reorderItems(abc, 2, 1)).toEqual(["a", "c", "b", "d"]); // c 到 b 之前（同一结果）
  });

  it("越界与非法入参不抛错、结果仍是合法排列", () => {
    expect(reorderItems(abc, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(reorderItems(abc, 3, -5)).toEqual(["d", "a", "b", "c"]);
    expect(reorderItems(abc, -1, 0)).toEqual(abc);
    expect(reorderItems(abc, 9, 0)).toEqual(abc);
    expect(reorderItems([], 0, 0)).toEqual([]);
  });

  it("不改原数组（返回新数组）", () => {
    const src = ["a", "b", "c"];
    const out = reorderItems(src, 0, 3);
    expect(src).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(src);
  });
});
