/** 终端标题（claude 写的 OSC 0）→ 会话名。
 *
 *  **为什么 tab 标题要听终端的**：内嵌终端跑的是真 claude CLI，它会把自己的会话名
 *  写进终端标题（OSC 0）——系统终端里 tab 名跟着会话名走就是靠这个，也是用户对
 *  「新会话 tab 没同步会话名」的预期来源。实测（claude 2.1.278，ConPTY 探针抓原始
 *  字节）：启动约 600ms 就写出 `ESC ] 0 ; ✳ <会话名> BEL`，`/rename` 之后会重写
 *  （claude 的设置 `terminalTitleFromRename` 默认 true）。
 *
 *  标题的拼装在 claude 那边是 `${前缀字形} ${会话名}`：干活时前缀在 `◐`/`◑` 间
 *  每 ~960ms 交替（驱动重绘的是动画帧）、闲时固定 `✳`，所以**同一秒内会重写好几次**。
 *  不去掉前缀的话 tab 名会跟着闪（何况 tab 上挂个转圈字形也没意义），故这里统一剥掉；
 *  剥完与上一次相同就不会触发重渲染（见 App 的 updateTabTitle），动画帧被自然吃掉。
 *
 *  另外两类要**丢弃**（丢弃 = 保留 tab 原值，不是清空）：
 *  - 启动瞬间的噪声：先是被 npm shim / cmd 设成可执行文件全路径，再是 `claude`
 *    这种泛称——都不是会话名，写进 tab 会一闪而过；
 *  - claude 的兜底值 `Claude Code`（源码：`sessionTitle ?? aiSessionTitle ??
 *    agentTitle ?? haikuTitle ?? "Claude Code"`）：会话还没起名时它就是标题，
 *    此刻 tab 该显示项目名（新会话）或 resume 的会话名，不该被泛称顶掉。 */
export function sessionTitleFromOsc(raw: string): string | null {
  // 控制字符（claude 不会写，但 OSC 载荷是任意字节）先剔掉，免得 tab 里出现怪东西
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 前缀字形 + 一个空格（`\s+` 而非 `\s*`：claude 拼装时必带空格，要求空格才不会
  // 误伤「用户自己把会话名起成 ◐开头」的情形）
  const body = clean.replace(/^[◐◑✳]\s+/, "").trim();
  if (body === "" || /^[◐◑✳]+$/.test(body)) return null; // 只剩字形＝没名字
  if (/^(claude|claude code)$/i.test(body)) return null; // 泛称 / claude 兜底值
  if (/(^|[\\/])[^\\/]*\.(exe|cmd|bat|ps1|com)$/i.test(body)) return null; // shell 设的 exe 路径
  // 会话名不会太长（rename_session 也限 200）；超长只可能是误解析出来的杂串
  return body.slice(0, 200);
}
