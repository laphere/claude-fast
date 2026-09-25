/**
 * tab 拖拽调序的纯逻辑（渲染层，无 DOM 依赖，故放 src/lib 走 vitest 直测）。
 *
 * 为什么单独拎出来：落点用的是**原数组坐标下的「空隙位」**（gap）——光标在 list[i] 的
 * 左半 → gap = i，右半 → i+1，最后一个 tab 右侧的空白 → gap = list.length。把元素从
 * 数组里摘出来之后，插入位要**补偿一格**：自己的原位置在落点之前时整个数组左移了一格。
 * 补偿写反的表现很隐蔽——「往后拖一格没反应、往前拖反而多跑一格」，只有单测盯得住。
 */

/** 把 list[fromIndex] 移到第 gapIndex 个空隙处，返回新数组（不改原数组）。
 *
 *  gapIndex 是**原数组**坐标（0..list.length）：等价于「插到 list[gapIndex] 之前」。
 *  越界一律夹到合法范围；fromIndex 非法时原样返回拷贝。 */
export function reorderItems<T>(list: T[], fromIndex: number, gapIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= list.length) return list.slice();
  const to = gapIndex > fromIndex ? gapIndex - 1 : gapIndex;
  const rest = list.filter((_, i) => i !== fromIndex);
  const at = Math.max(0, Math.min(to, rest.length));
  rest.splice(at, 0, list[fromIndex]);
  return rest;
}
