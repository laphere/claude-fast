import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { FileIcon, PlayIcon, SearchIcon } from "./Icons";
import type {
  ContentBlock,
  SessionInfo,
  SessionMessage,
  SessionSearchHit,
  SessionUsageStats,
  SessionUserPrompt,
} from "../types";

interface Props {
  session: SessionInfo | null;
  /** 会话所属项目真实路径（resume 用） */
  projectPath: string | null;
  onResume: () => void;
  onToast: (msg: string) => void;
}

/** 每页消息数（与后端 MAX_SESSION_MESSAGES 一致） */
const PAGE_SIZE = 500;

/** ISO 时间戳 → HH:MM */
function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Markdown 渲染（marked + DOMPurify 消毒，cc-haha 同方案） */
function MarkdownText({ text }: { text: string }) {
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
function toolSummary(name: string, input: unknown): string {
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

/** 代码变更卡片：Claude Code 风格 */
function CodeChangeCard({ block }: { block: ContentBlock }) {
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
      </details>
    );
  }

  return null;
}

/** 工具调用行：代码变更工具用 Claude Code diff，其他工具用摘要+JSON */
function ToolUseRow({
  block,
  hasResult,
  isError,
}: {
  block: ContentBlock;
  hasResult: boolean;
  isError: boolean;
}) {
  const name = block.name ?? "工具";
  if (name === "Edit" || name === "Write" || name === "MultiEdit") {
    return <CodeChangeCard block={block} />;
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
        {block.input ? JSON.stringify(block.input, null, 2).slice(0, 4000) : ""}
      </pre>
    </details>
  );
}

/** 工具结果卡 */
function ToolResultCard({
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
function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking-block">
      <summary>💭 思考过程</summary>
      <div className="thinking-body">
        <MarkdownText text={text} />
      </div>
    </details>
  );
}

/** 单条消息（data-msg-index 供搜索/文件面板定位跳转） */
function Message({
  msg,
  resultMap,
  toolNames,
  msgIndex,
}: {
  msg: SessionMessage;
  resultMap: Map<string, boolean>;
  toolNames: Map<string, string>;
  msgIndex: number;
}) {
  if (msg.kind === "user") {
    const texts = msg.blocks.filter((b) => b.kind === "text");
    const results = msg.blocks.filter((b) => b.kind === "tool_result");
    if (texts.length === 0 && results.length > 0) {
      return (
        <div className="msg msg-tool-result-only" data-msg-index={msgIndex}>
          {results.map((b, i) => (
            <ToolResultCard
              key={i}
              block={b}
              toolName={b.toolUseId ? toolNames.get(b.toolUseId) ?? null : null}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="msg msg-user" data-msg-index={msgIndex}>
        <div className="msg-user-body">
          {texts.map((b, i) => (
            <MarkdownText key={i} text={b.text ?? ""} />
          ))}
          {results.map((b, i) => (
            <ToolResultCard
              key={`r${i}`}
              block={b}
              toolName={b.toolUseId ? toolNames.get(b.toolUseId) ?? null : null}
            />
          ))}
          <div className="msg-time">{formatTime(msg.timestamp)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant" data-msg-index={msgIndex}>
      <div className="msg-head">
        <span className="msg-model">{msg.model ?? "Claude"}</span>
        <span className="msg-time">{formatTime(msg.timestamp)}</span>
      </div>
      {msg.blocks.map((b, i) => {
        switch (b.kind) {
          case "text":
            return <MarkdownText key={i} text={b.text ?? ""} />;
          case "thinking":
            return <ThinkingBlock key={i} text={b.text ?? ""} />;
          case "tool_use": {
            const id = b.toolUseId ?? `${i}`;
            // data-block-idx 供搜索命中/文件面板跳转时定位并展开该工具行
            return (
              <div key={i} data-block-idx={`${msgIndex}-${i}`}>
                <ToolUseRow
                  block={b}
                  hasResult={resultMap.has(id)}
                  isError={resultMap.get(id) ?? false}
                />
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

/** token 缩写：1234 → 1.2K，3456789 → 3.5M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 还原高亮：把 <mark> 恢复为纯文本节点（关键词清空时调用） */
function clearHighlight(root: HTMLElement) {
  root.querySelectorAll("mark").forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent ?? ""));
  });
}

/**
 * 关键词高亮：TreeWalker 只处理文本节点，包裹 <mark>。
 * 不用字符串替换净化后的 HTML —— 关键词若出现在属性值里会注入非法标记。
 */
function highlightKeyword(root: HTMLElement, keyword: string) {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    if (!lower.includes(kw)) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    let idx: number;
    while ((idx = lower.indexOf(kw, pos)) !== -1) {
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + kw.length);
      frag.appendChild(mark);
      pos = idx + kw.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode?.replaceChild(frag, node);
  }
}

/** 变更文件：聚合 Edit/Write/MultiEdit 的 file_path（相对路径） */
interface ChangedFile {
  path: string;
  /** 所在目录（file_path 除最后一段外的部分） */
  dir: string;
  file: string;
  /** 首见位置：messages 数组内索引（全局序号 = offset + msgIdx） */
  msgIdx: number;
  blockIdx: number;
  /** 编辑次数 */
  count: number;
}

/** 右侧会话内容区：打开定位在最后一条，向上翻自动加载更早的 500 条。
 *  会话域增强（v2.0.0）：消息搜索、token/成本统计、导出、变更文件导航。 */
export default function SessionViewer({
  session,
  projectPath,
  onResume,
  onToast,
}: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<SessionUsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  /** 初始加载完成后滚动到底部（焦点在最新一条） */
  const scrollToBottomRef = useRef(true);

  // ---------- 搜索 ----------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SessionSearchHit[] | null>(null);

  // ---------- 变更文件面板 / 导出 ----------
  const [filesOpen, setFilesOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // ---------- 对话进度条（左侧用户发言导航轨） ----------
  /** 全量用户发言（后端提取，index 与消息全局序号一致） */
  const [prompts, setPrompts] = useState<SessionUserPrompt[]>([]);
  /** 视口当前所在的用户发言序号（高亮跟随滚动） */
  const [activePrompt, setActivePrompt] = useState<number | null>(null);
  /** 悬停气泡：格子对应的发言 + 相对 viewer-main 的纵向位置 */
  const [railTip, setRailTip] = useState<{
    prompt: SessionUserPrompt;
    top: number;
  } | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef(0);
  const prevFileRef = useRef<string | null>(null);

  // 初始加载：默认取最后 500 条（session 切换或点「刷新」时重新加载）
  useEffect(() => {
    if (!session) {
      setMessages([]);
      setStats(null);
      setSearchResults(null);
      setPrompts([]);
      prevFileRef.current = null;
      return;
    }
    // 切换会话时重置搜索与面板状态
    setSearchOpen(false);
    setSearchKeyword("");
    setSearchResults(null);
    setFilesOpen(false);
    setExportMenuOpen(false);
    if (prevFileRef.current !== session.file) {
      // 仅切换会话时清空进度条（点「刷新」保留旧数据避免闪烁）
      setPrompts([]);
      setActivePrompt(null);
      setRailTip(null);
      prevFileRef.current = session.file;
    }
    let cancelled = false;
    scrollToBottomRef.current = true;
    setLoading(true);
    api
      .getSessionMessages(session.file)
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages);
        setOffset(data.offset);
        setHasMore(data.hasMore);
        setTotal(data.total);
        setStats(data.stats);
      })
      .catch((e) => onToast("加载会话内容失败：" + String(e)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // 进度条数据并行加载（失败不打扰主内容，只少一条导航轨）
    api
      .getSessionUserPrompts(session.file)
      .then((p) => {
        if (!cancelled) setPrompts(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, reloadKey, onToast]);

  // 初始加载完成后滚动到底部
  useEffect(() => {
    if (!loading && messages.length > 0 && scrollToBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      scrollToBottomRef.current = false;
    }
  }, [loading, messages]);

  // 加载更早的一页（offset - 500），插入顶部并保持滚动位置
  const loadMore = useCallback(async () => {
    if (!session || loadingMore || !hasMore) return;
    const body = bodyRef.current;
    const prevHeight = body?.scrollHeight ?? 0;
    const prevTop = body?.scrollTop ?? 0;
    setLoadingMore(true);
    try {
      const data = await api.getSessionMessages(
        session.file,
        Math.max(0, offset - PAGE_SIZE),
      );
      setMessages((prev) => [...data.messages, ...prev]);
      setOffset(data.offset);
      setHasMore(data.hasMore);
      setTotal(data.total);
      setStats(data.stats);
      // 新增内容在顶部：滚动偏移补偿，保持当前阅读位置
      requestAnimationFrame(() => {
        if (body) body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
      });
    } catch (e) {
      onToast("加载更早消息失败：" + String(e));
    }
    setLoadingMore(false);
  }, [session, loadingMore, hasMore, offset, onToast]);

  // 进度条高亮跟随滚动：视口顶部附近最近的那条用户发言
  const updateActivePrompt = useCallback(() => {
    const body = bodyRef.current;
    if (!body || prompts.length === 0) {
      setActivePrompt(null);
      return;
    }
    const bodyTop = body.getBoundingClientRect().top;
    let active: number | null = null;
    for (const p of prompts) {
      if (p.index < offset) continue; // 更早的分页未加载
      if (p.index >= offset + messages.length) break;
      const el = body.querySelector(`[data-msg-index="${p.index}"]`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - bodyTop <= 140) active = p.index;
      else break;
    }
    setActivePrompt(active);
  }, [prompts, offset, messages.length]);

  // 消息/分页/进度数据变化后重算高亮（等 DOM 提交）
  useEffect(() => {
    if (loading) return;
    const id = requestAnimationFrame(updateActivePrompt);
    return () => cancelAnimationFrame(id);
  }, [loading, updateActivePrompt]);

  // 滚到顶部附近自动加载更早
  const onScroll = useCallback(() => {
    const body = bodyRef.current;
    if (body && body.scrollTop <= 40) void loadMore();
    // 进度条高亮用 rAF 节流，一帧最多算一次
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(updateActivePrompt);
  }, [loadMore, updateActivePrompt]);

  // tool_use / tool_result 跨消息关联
  const { resultMap, toolNames } = useMemo(() => {
    const resultMap = new Map<string, boolean>();
    const toolNames = new Map<string, string>();
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === "tool_result" && b.toolUseId) {
          resultMap.set(b.toolUseId, !!b.isError);
        }
      }
    }
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === "tool_use" && b.name) {
          toolNames.set(b.toolUseId ?? "", b.name);
        }
      }
    }
    return { resultMap, toolNames };
  }, [messages]);

  // ---------- 搜索 ----------

  // 防抖 300ms 调后端全文搜索（结果按消息序号返回）
  useEffect(() => {
    if (!session || !searchKeyword.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const kw = searchKeyword.trim();
    let cancelled = false;
    const t = window.setTimeout(() => {
      setSearching(true);
      api
        .searchSessionMessages(session.file, kw)
        .then((r) => {
          if (!cancelled) setSearchResults(r);
        })
        .catch((e) => {
          if (!cancelled) onToast("搜索失败：" + String(e));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [session, searchKeyword, onToast]);

  // 关键词高亮：作用于消息区与搜索结果片段（关键词清空/消息增减时重建）
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    clearHighlight(body);
    if (searchKeyword.trim()) highlightKeyword(body, searchKeyword);
  }, [searchKeyword, messages]);
  useEffect(() => {
    const results = resultsRef.current;
    if (!results) return;
    clearHighlight(results);
    if (searchKeyword.trim()) highlightKeyword(results, searchKeyword);
  }, [searchKeyword, searchResults]);

  /** 跳转到某条消息（全局序号）：未加载的分页先加载对应页再定位 */
  const jumpTo = useCallback(
    async (globalIndex: number, blockIndex?: number) => {
      if (!session) return;
      const first = offset; // messages[0] 的全局序号
      let needFrame = false;
      if (globalIndex < first || globalIndex >= first + messages.length) {
        const pageStart = Math.floor(globalIndex / PAGE_SIZE) * PAGE_SIZE;
        try {
          const data = await api.getSessionMessages(session.file, pageStart);
          setMessages(data.messages);
          setOffset(data.offset);
          setHasMore(data.hasMore);
          setTotal(data.total);
          setStats(data.stats);
          needFrame = true; // 等 React 提交 DOM 后再定位
        } catch (e) {
          onToast("定位失败：" + String(e));
          return;
        }
      }
      const locate = () => {
        const body = bodyRef.current;
        if (!body) return;
        const el = body.querySelector(`[data-msg-index="${globalIndex}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "start" });
        // 高亮闪烁（重触发动画）
        const flash = el as HTMLElement;
        flash.classList.remove("msg-flash");
        void flash.offsetWidth;
        flash.classList.add("msg-flash");
        if (blockIndex !== undefined) {
          // data-block-idx 在外层包装 div 上；details（diff 卡/工具行）是它的子元素
          const card = body.querySelector(
            `[data-block-idx="${globalIndex}-${blockIndex}"] details`,
          );
          if (card) card.setAttribute("open", "");
        }
      };
      if (needFrame) requestAnimationFrame(locate);
      else locate();
    },
    [session, offset, messages, onToast],
  );

  /** 悬停格子：气泡浮在轨道右侧，纵向对齐格子并夹在可视区内 */
  const openRailTip = (p: SessionUserPrompt, btn: HTMLElement) => {
    const main = mainRef.current;
    if (!main) return;
    const mr = main.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const TIP_MAX = 300; // 与 CSS max-height 一致
    const top = Math.max(8, Math.min(br.top - mr.top - 10, mr.height - TIP_MAX - 8));
    setRailTip({ prompt: p, top });
  };

  // ---------- 变更文件聚合 ----------

  const changedFiles = useMemo(() => {
    const byPath = new Map<string, ChangedFile>();
    messages.forEach((m, i) => {
      m.blocks.forEach((b, bi) => {
        if (b.kind !== "tool_use") return;
        if (b.name !== "Edit" && b.name !== "Write" && b.name !== "MultiEdit") return;
        const fp = ((b.input ?? {}) as Record<string, unknown>).file_path;
        if (typeof fp !== "string" || !fp.trim()) return;
        const existing = byPath.get(fp);
        if (existing) {
          existing.count += 1;
          return;
        }
        const parts = fp.split(/[\\/]/);
        const file = parts.pop() || fp;
        byPath.set(fp, {
          path: fp,
          dir: parts.join("/"),
          file,
          msgIdx: i,
          blockIdx: bi,
          count: 1,
        });
      });
    });
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
  }, [messages]);

  // 按目录分组展示
  const fileGroups = useMemo(() => {
    const groups = new Map<string, ChangedFile[]>();
    for (const f of changedFiles) {
      const key = f.dir || ".";
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }
    return [...groups.entries()] as Array<[string, ChangedFile[]]>;
  }, [changedFiles]);

  // ---------- 导出 ----------

  const doExport = useCallback(
    async (format: "markdown" | "jsonl") => {
      setExportMenuOpen(false);
      if (!session) return;
      const base =
        (session.title || session.sessionId)
          .replace(/[\\/:*?"<>|]/g, "_")
          .split("\n")
          .join(" ")
          .trim()
          .slice(0, 80) || session.sessionId;
      try {
        // 格式名（markdown/jsonl）与文件扩展名（md/jsonl）不同，导出对话框用扩展名
        const ext = format === "markdown" ? "md" : "jsonl";
        const dest = await save({
          defaultPath: `${base}.${ext}`,
          filters: [
            {
              name: format === "markdown" ? "Markdown 文档" : "JSON Lines",
              extensions: [ext],
            },
          ],
        });
        if (!dest) return; // 用户取消
        await api.exportSession(session.file, dest, format);
        onToast(`已导出：${dest}`);
      } catch (e) {
        onToast("导出失败：" + String(e));
      }
    },
    [session, onToast],
  );

  if (!session) {
    return (
      <div className="viewer">
        <div className="viewer-empty">
          <div className="empty-icon">💬</div>
          <div>选择左侧会话查看内容</div>
          <div className="empty-sub">点击项目行展开会话列表，再点击会话</div>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="viewer-head-body">
          <div className="viewer-title">{session.title}</div>
          <div className="viewer-meta">
            {projectPath ?? session.file}
            {total > 0 ? ` · 共 ${total} 条消息` : ""}
          </div>
          {stats && stats.messageCount > 0 && (
            <div className="viewer-stats">
              总计 {fmtTokens(stats.totalTokens)} · 输入 {fmtTokens(stats.inputTokens)} · 输出{" "}
              {fmtTokens(stats.outputTokens)}
              {stats.cacheReadTokens > 0 && ` · 缓存读取 ${fmtTokens(stats.cacheReadTokens)}`}
            </div>
          )}
        </div>
        <div className="viewer-actions">
          <button
            className="btn"
            onClick={() => {
              setSearchOpen((v) => !v);
              setExportMenuOpen(false);
            }}
            title="搜索消息内容与工具调用"
          >
            <SearchIcon />
            搜索
          </button>
          <button
            className="btn"
            onClick={() => setFilesOpen((v) => !v)}
            title="本会话变更的文件列表"
          >
            <FileIcon />
            文件{changedFiles.length > 0 ? ` (${changedFiles.length})` : ""}
          </button>
          <div className="export-wrap">
            <button
              className="btn"
              onClick={() => {
                setExportMenuOpen((v) => !v);
                setSearchOpen(false);
              }}
              title="导出会话内容"
            >
              导出 ▾
            </button>
            {exportMenuOpen && (
              <>
                <div className="menu-overlay" onClick={() => setExportMenuOpen(false)} />
                <div className="export-menu">
                  <button onClick={() => void doExport("markdown")}>Markdown 文档</button>
                  <button onClick={() => void doExport("jsonl")}>JSONL（原文）</button>
                </div>
              </>
            )}
          </div>
          <button
            className="btn"
            onClick={() => setReloadKey((k) => k + 1)}
            title="重新读取会话内容"
          >
            刷新
          </button>
          <button className="btn btn-primary" onClick={onResume} title="新开窗口继续这个对话">
            <PlayIcon />
            继续
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="viewer-search">
          <input
            className="search-input"
            placeholder="搜索消息内容与工具调用…（Esc 关闭）"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
            }}
            autoFocus
          />
          <span className="search-status">
            {searching
              ? "搜索中…"
              : searchKeyword.trim() && searchResults
                ? `${searchResults.length} 条结果`
                : ""}
          </span>
          <button className="btn" onClick={() => setSearchOpen(false)} title="关闭搜索">
            ✕
          </button>
          {searchKeyword.trim() && searchResults && searchResults.length > 0 && (
            <div className="search-results" ref={resultsRef}>
              {searchResults.slice(0, 50).map((h, i) => (
                <button
                  key={i}
                  className="search-hit"
                  onClick={() => void jumpTo(h.index, h.blockIndex)}
                  title="点击跳转到对应消息"
                >
                  <span className={`search-kind ${h.kind === "user" ? "" : "sk-claude"}`}>
                    {h.kind === "user" ? "用户" : "Claude"}
                  </span>
                  <span className="search-snippet">{h.snippet}</span>
                </button>
              ))}
              {searchResults.length > 50 && (
                <div className="search-more">
                  仅显示前 50 条，共 {searchResults.length} 条
                </div>
              )}
            </div>
          )}
          {searchKeyword.trim() && searchResults && searchResults.length === 0 && (
            <div className="search-results search-empty">无匹配结果</div>
          )}
        </div>
      )}

      <div className="viewer-main" ref={mainRef}>
        {prompts.length > 0 && (
          <div className="msg-rail" onMouseLeave={() => setRailTip(null)}>
            {prompts.map((p) => (
              <button
                key={p.index}
                className={`msg-rail-tick ${activePrompt === p.index ? "active" : ""}`}
                onClick={() => void jumpTo(p.index)}
                onMouseEnter={(e) => openRailTip(p, e.currentTarget)}
                aria-label={`定位到用户发言：${p.text}`}
              />
            ))}
          </div>
        )}
        <div className="viewer-body" ref={bodyRef} onScroll={onScroll}>
          {loading ? (
            <div className="viewer-empty">加载中…</div>
          ) : messages.length === 0 ? (
            <div className="viewer-empty">
              <div className="empty-icon">🗒</div>
              <div>这个会话没有可显示的内容</div>
            </div>
          ) : (
            <>
              {hasMore ? (
                <button
                  className="viewer-load-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "加载中…" : `↑ 加载更早的消息（还剩 ${offset} 条）`}
                </button>
              ) : offset > 0 ? (
                <div className="viewer-truncated">已到会话开头</div>
              ) : null}
              {messages.map((m, i) => (
                <Message key={i} msg={m} resultMap={resultMap} toolNames={toolNames} msgIndex={offset + i} />
              ))}
            </>
          )}
        </div>

        {railTip && (
          <div className="msg-rail-tip" style={{ top: railTip.top }}>
            <div className="msg-rail-tip-time">
              用户 · {formatTime(railTip.prompt.timestamp)}
            </div>
            <div className="msg-rail-tip-text">{railTip.prompt.text}</div>
          </div>
        )}

        {filesOpen && (
          <div className="viewer-files">
            <div className="files-head">
              变更文件 <span className="files-count">{changedFiles.length}</span>
            </div>
            <div className="files-body">
              {fileGroups.length === 0 ? (
                <div className="files-empty">未发现文件变更</div>
              ) : (
                fileGroups.map(([dir, files]) => (
                  <div className="file-group" key={dir}>
                    <div className="file-dir" title={dir}>
                      {dir}
                    </div>
                    {files.map((f) => (
                      <button
                        key={f.path}
                        className="file-item"
                        title={`${f.path}（点击定位）`}
                        onClick={() => void jumpTo(offset + f.msgIdx, f.blockIdx)}
                      >
                        <span className="file-name">{f.file}</span>
                        {f.count > 1 && <span className="file-count">{f.count}</span>}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}