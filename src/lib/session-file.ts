/**
 * 会话文件路径 ↔ 会话 id 的纯逻辑（渲染层用）。
 *
 * 会话 id 就是 jsonl 文件名去掉扩展名：`~/.claude/projects/<mangled>/<uuid>.jsonl`。
 * 渲染层要它来做**跨交互方式**的同会话判定——对话 tab 只认 `session.file`、
 * 终端 tab 只认 `resumeSessionId`/`newSessionId`，两边要能对上同一个会话，
 * 就得从路径把 id 抠出来（见 App 的 conflictingTabForSession）。
 *
 * 为什么不直接用 Node 的 `path.basename`：渲染进程零 Node 权限（contextIsolation，
 * 全部能力经 preload 白名单），没有 path 模块可用。
 */

/** 从会话 jsonl 绝对路径取会话 id（文件名去掉 `.jsonl`）；取不到返回 null。
 *
 *  ⚠️ 两种分隔符都要切：路径由**本机** claude 产生，但项目清单可以是从别的机器
 *  带过来的（便携数据根整个拷走就是这个场景），`\` 与 `/` 都可能出现。
 *  扩展名大小写不敏感（Windows 上 `X.JSONL` 与 `x.jsonl` 是同一个文件）。 */
export function sessionIdFromFile(file: string): string | null {
  const name = file.split(/[\\/]/).pop() ?? "";
  const id = name.replace(/\.jsonl$/i, "");
  return id === "" || id === name ? null : id;
}
