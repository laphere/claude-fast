/**
 * 消息渲染共享组件：会话页（ChatView）内历史区与实时区共用的内容块渲染体系——
 * 活动组折叠摘要、Markdown、思考折叠、工具调用/结果、代码变更 diff 卡。
 */
import { useMemo, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { ContentBlock } from "../types";

/** ISO 时间戳 → HH:MM */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Markdown 渲染（marked + DOMPurify 消毒，cc-haha 同方案） */
export function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    } catch {
      return text;
    }
  }, [text]);
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 工具调用摘要（仿 cc-haha formatRecentToolUseSummary）：Bash · 命令 / Read · 文件名 */
export function toolSummary(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const leaf = (p: unknown) =>
    String(p ?? "")
      .split(/[\\/]/)
      .pop() ?? "";
  switch (name) {
    case "Bash":
      return `Bash · ${String(obj.command ?? "")}`;
    case "Read":
      return `Read · ${leaf(obj.file_path)}`;
    case "Write":
      return `Write · ${leaf(obj.file_path)}`;
    case "Edit":
      return `Edit · ${leaf(obj.file_path)}`;
    case "MultiEdit":
      return `MultiEdit · ${leaf(obj.file_path)}`;
    case "Glob":
      return `Glob · ${String(obj.pattern ?? "")}`;
    case "Grep":
      return `Grep · ${String(obj.pattern ?? "")}`;
    case "Agent":
      return `Agent · ${String(obj.description ?? "")}`;
    case "TodoWrite":
      return "TodoWrite · 更新任务列表";
    default:
      return name;
  }
}

/** 将文本按行拆分，过滤末尾空行 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// ---- 简单 LCS diff 算法（O(n*m)，会话内行数有限不会超时） ----

type DiffOp = { type: "equal" | "delete" | "insert"; text: string };

function lcsDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯生成 diff
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: "equal", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "insert", text: newLines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "delete", text: oldLines[i - 1] });
      i--;
    }
  }
  return ops;
}

// ---- 扩展 diff：给 equal 行加行号，delete/insert 行也带行号 ----

type DiffLine = {
  op: "equal" | "delete" | "insert";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

function enrichDiffOps(ops: DiffOp[]): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLn = 1;
  let newLn = 1;
  for (const op of ops) {
    switch (op.type) {
      case "equal":
        result.push({ op: "equal", text: op.text, oldLine: oldLn, newLine: newLn });
        oldLn++;
        newLn++;
        break;
      case "delete":
        result.push({ op: "delete", text: op.text, oldLine: oldLn, newLine: null });
        oldLn++;
        break;
      case "insert":
        result.push({ op: "insert", text: op.text, oldLine: null, newLine: newLn });
        newLn++;
        break;
    }
  }
  return result;
}

// ---- 渲染 ----

/** Claude Code 风格 diff 行（行号 + -/ + 前缀 + 内容） */
function DiffLineRow({ line }: { line: DiffLine }) {
  const cls = line.op === "delete" ? "diff-del" : line.op === "insert" ? "diff-add" : "";
  const prefix = line.op === "delete" ? "-" : line.op === "insert" ? "+" : " ";
  const lineNum = line.oldLine ?? line.newLine ?? null;
  return (
    <div className={`diff-line ${cls}`}>
      <span className="diff-ln">{lineNum ?? ""}</span>
      <span className="diff-prefix">{prefix}</span>
      <span className="diff-text">{line.text || " "}</span>
    </div>
  );
}

/** 编辑摘要行：Added N lines, removed M lines */
function editSummary(oldCount: number, newCount: number): string {
  const parts: string[] = [];
  if (newCount > 0) parts.push(`Added ${newCount} line${newCount > 1 ? "s" : ""}`);
  if (oldCount > 0) parts.push(`removed ${oldCount} line${oldCount > 1 ? "s" : ""}`);
  return parts.join(", ");
}

/** 代码变更卡片内的错误输出（工具执行出错时显示在 diff 末尾） */
function ToolErrorOutput({ resultBlock }: { resultBlock?: ContentBlock | null }) {
  if (!resultBlock?.isError || !resultBlock.text) return null;
  return <pre className="tool-body tool-result-error">{resultBlock.text.slice(0, 4000)}</pre>;
}

/** 代码变更卡片：Claude Code 风格（resultBlock 出错时在 diff 末尾附错误输出） */
export function CodeChangeCard({
  block,
  resultBlock,
}: {
  block: ContentBlock;
  resultBlock?: ContentBlock | null;
}) {
  const name = block.name ?? "";
  const input = (block.input ?? {}) as Record<string, unknown>;
  const filePath = (input.file_path as string) ?? "";

  if (name === "Edit") {
    const oldLines = splitLines(String(input.old_string ?? ""));
    const newLines = splitLines(String(input.new_string ?? ""));
    const ops = lcsDiff(oldLines, newLines);
    const diffLines = enrichDiffOps(ops);
    return (
      <details className="diff-card" open={false}>
        <summary className="diff-summary">
          <span className="diff-icon">●</span>
          <span className="diff-title">Edit</span>
          <span className="diff-path">{filePath}</span>
        </summary>
        <div className="diff-summary-sub">
          {editSummary(oldLines.length, newLines.length)}
        </div>
        <div className="diff-body">
          {diffLines.map((dl, i) => (
            <DiffLineRow key={i} line={dl} />
          ))}
        </div>
        <ToolErrorOutput resultBlock={resultBlock} />
      </details>
    );
  }

  if (name === "Write") {
    const content = splitLines(String(input.content ?? ""));
    return (
      <details className="diff-card" open={false}>
        <summary className="diff-summary">
          <span className="diff-icon">●</span>
          <span className="diff-title">Write</span>
          <span className="diff-path">{filePath}</span>
        </summary>
        <div className="diff-summary-sub">
          Added {content.length} line{content.length > 1 ? "s" : ""}
        </div>
        <div className="diff-body">
          {content.map((line, i) => (
            <DiffLineRow
              key={i}
              line={{ op: "insert", text: line, oldLine: null, newLine: i + 1 }}
            />
          ))}
        </div>
        <ToolErrorOutput resultBlock={resultBlock} />
      </details>
    );
  }

  if (name === "MultiEdit") {
    const edits = (input.edits ?? []) as Array<Record<string, unknown>>;
    return (
      <details className="diff-card" open={false}>
        <summary className="diff-summary">
          <span className="diff-icon">●</span>
          <span className="diff-title">MultiEdit</span>
          <span className="diff-path">{filePath}</span>
        </summary>
        <div className="diff-summary-sub">
          {edits.length} edit{edits.length !== 1 ? "s" : ""}
        </div>
        <div className="diff-body">
          {edits.map((edit, i) => {
            const oldLines = splitLines(String(edit.old_string ?? ""));
            const newLines = splitLines(String(edit.new_string ?? ""));
            const ops = lcsDiff(oldLines, newLines);
            const diffLines = enrichDiffOps(ops);
            return (
              <div key={i} className="diff-edit-group">
                <div className="diff-edit-separator">
                  Edit #{i + 1}
                  <span className="diff-edit-sep-stat">
                    {editSummary(oldLines.length, newLines.length)}
                  </span>
                </div>
                {diffLines.map((dl, j) => (
                  <DiffLineRow key={j} line={dl} />
                ))}
              </div>
            );
          })}
          {edits.length === 0 && (
            <div className="diff-empty">No edits</div>
          )}
        </div>
        <ToolErrorOutput resultBlock={resultBlock} />
      </details>
    );
  }

  return null;
}

/** 工具调用行（默认折叠）：代码变更工具展开显示 diff，其他工具展开显示输入 JSON
 *  与执行结果——每次工具调用只占一行摘要，结果不再单独渲染成卡片 */
export function ToolUseRow({
  block,
  hasResult,
  isError,
  resultBlock,
}: {
  block: ContentBlock;
  hasResult: boolean;
  isError: boolean;
  resultBlock?: ContentBlock | null;
}) {
  const name = block.name ?? "工具";
  if (name === "Edit" || name === "Write" || name === "MultiEdit") {
    return <CodeChangeCard block={block} resultBlock={resultBlock} />;
  }
  return (
    <details className="tool-row" open={false}>
      <summary className="tool-summary">
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{toolSummary(name, block.input)}</span>
        <span className={`tool-status ${isError ? "tool-error" : ""}`}>
          {isError ? "• 出错" : hasResult ? "• done" : ""}
        </span>
      </summary>
      <pre className="tool-body">
        {block.input ? JSON.stringify(block.input, null, 2).slice(0, 4000) : "（无输入）"}
      </pre>
      {resultBlock && (
        <pre className={`tool-body ${isError ? "tool-result-error" : "tool-result-ok"}`}>
          {`── 执行结果 ──\n` + (resultBlock.text ?? "").slice(0, 4000)}
        </pre>
      )}
    </details>
  );
}

/** 工具结果卡 */
export function ToolResultCard({
  block,
  toolName,
}: {
  block: ContentBlock;
  toolName: string | null;
}) {
  return (
    <details className="tool-result" open={false}>
      <summary className="tool-summary">
        <span className="tool-icon">{block.isError ? "⚠️" : "📄"}</span>
        <span className="tool-name">
          {block.isError ? "工具执行出错" : `${toolName ?? "工具"} 结果`}
        </span>
      </summary>
      <pre className="tool-body">{(block.text ?? "").slice(0, 4000)}</pre>
    </details>
  );
}

/** thinking 块：折叠展示 */
export function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking-block">
      <summary>💭 思考过程</summary>
      <div className="thinking-body">
        <MarkdownText text={text} />
      </div>
    </details>
  );
}

/** token 缩写：1234 → 1.2K，3456789 → 3.5M */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---- 活动组（Claude Code 终端风格）：思考+工具调用折叠成一行摘要，点击展开 ----

/** 工具名 → 摘要动词短语（数量由调用方聚合） */
function toolPhrase(name: string, count: number): string {
  switch (name) {
    case "Read":
      return `读取 ${count} 个文件`;
    case "Glob":
    case "Grep":
      return `搜索 ${count} 次`;
    case "Bash":
      return `执行 ${count} 条命令`;
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `编辑 ${count} 个文件`;
    case "WebFetch":
    case "WebSearch":
      return `联网查询 ${count} 次`;
    case "TodoWrite":
      return "更新任务列表";
    case "Task":
    case "Agent":
      return `派出子代理 ${count} 次`;
    default:
      return `${name} × ${count}`;
  }
}

/** 从一段活动内容生成摘要行（如「思考 · 读取 2 个文件 · 执行 1 条命令」） */
export function activitySummary(
  entries: Array<{ kind: string; name?: string | null }>,
): string {
  const hasThinking = entries.some((e) => e.kind === "thinking");
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== "tool_use") continue;
    const key = e.name ?? "工具";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const phrases = [...counts.entries()].map(([name, n]) => toolPhrase(name, n));
  const parts = [...(hasThinking ? ["思考"] : []), ...phrases];
  return parts.length > 0 ? parts.join(" · ") : "执行操作";
}

/** 活动组容器：默认折叠（终端里 Ctrl+O 的等价物），点击摘要行展开 */
export function ActivityGroup({
  summary,
  running,
  children,
}: {
  summary: string;
  /** 组内仍有工具在跑/正在流式输出时显示进行中标记 */
  running?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="activity">
      <summary className="activity-summary">
        <span className="activity-caret">▶</span>
        <span className="activity-label">{summary}</span>
        {running && <span className="activity-running">…</span>}
      </summary>
      <div className="activity-body">{children}</div>
    </details>
  );
}
