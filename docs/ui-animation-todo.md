# 全 app 动画缺失待优化清单

> 2026-09-19 用户记录：收起侧栏是突变、整 app 缺过渡动画；先做功能，后续统一补。

## 已知突变点

- 左栏收起/展开（手动开关 + 窗口 <980 自动收起）瞬间跳变
- 对话框开关（Modal 系）、toast 出入、右键菜单弹出
- 左栏搜索框展开/收起
- 提问卡收起/展开（卡头开关，2026-09-24 新增）：卡体是 `display:none` 隐藏（藏而不卸，为保卡内已选答案），不能过渡；收起后消息区高度跳变

## 实现注意

- 左栏动画：`.main-left` 是 `flex-basis 360px + display:none`，`display` 不能过渡——需改 width/max-width transition 或父级 grid-template-columns 过渡
- 动画期间若有内嵌终端（原 Tauri `embedded-terminal` 分支，已移植进主线、该分支已退休），其 ResizeObserver 会连续触发 refit（已有 150ms 防抖），动画时长需与之对齐，避免中途反复 resize PTY 造成 claude TUI 抖动
- 优先级建议：侧栏过渡 > 对话框/菜单 > toast > 其他；统一一个 easing/时长体系（如 150-200ms ease-out）保持手感一致
