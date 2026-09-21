/**
 * 会话页（app 内对话）：托管官方 claude CLI 子进程（后端 chat.rs），经
 * ipc::Channel 接收 stream-json 翻译后的增量事件流式渲染。
 *
 * 会话页 = 对话 + 内容查看二合一：
 * - 历史 jsonl 渲染（向上分页、消息搜索跳转、变更文件面板、导出、token 统计）
 * - 本次会话的实时流式消息追加在历史之后
 * - 「刷新」重读 jsonl 并清空实时区（jsonl 为唯一事实来源）
 * - 历史与实时合成一条统一渲染流，活动组跨消息合并（Claude Code 终端风格）
 * 渲染体系复用 MessageParts；新对话写入 ~/.claude/projects 原生 jsonl。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Channel } from "../lib/channel";
import { api } from "../lib/api";
import AskQuestionCard, {
  parseAskQuestions,
  type AskQuestionItem,
} from "./AskQuestionCard";
import {
  ActivityGroup,
  MarkdownText,
  ThinkingBlock,
  ToolResultCard,
  ToolUseRow,
  activitySummary,
  fmtTokens,
  formatTime,
} from "./MessageParts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  FileIcon,
  MessageCircleIcon,
  RefreshIcon,
  SearchIcon,
  StopIcon,
  XIcon,
} from "./Icons";
import type {
  ChatEvent,
  ChatImage,
  ChatItem,
  ChatPermissionMode,
  ChatPermissionRequest,
  ChatUsage,
  ContentBlock,
  SessionInfo,
  SessionMessage,
  SessionSearchHit,
  SessionUsageStats,
  SessionUserPrompt,
} from "../types";

interface Props {
  /** claude 工作目录（项目绝对路径） */
  projectPath: string;
  /** 标题显示（项目名 / 会话标题） */
  title: string;
  /** 续聊的会话（null = 新对话） */
  session: SessionInfo | null;
  onToast: (msg: string) => void;
  /** 对话状态变化上报（多会话 tab 的进行中标记） */
  onStatusChange?: (phase: ChatStatus["phase"]) => void;
}

/** 每页历史消息数（与后端 MAX_SESSION_MESSAGES 一致） */
const PAGE_SIZE = 500;

/** 权限模式选项（与终端 Shift+Tab 循环的 5 种对齐，支持运行中热切换）。
 *  spawn 时不传 --permission-mode（跟随 settings.json 的 defaultMode，与终端
 *  默认行为一致）；下拉初始选中项 = 解析配置得到的默认模式，session_ready 后
 *  以 CLI init 上报的实际模式为准。
 *  dontAsk 虽是 --permission-mode 的合法取值，但终端交互循环里没有
 *  （程序化调用用），故不进下拉；配置里若配了它，会以原始名动态加入下拉显示 */
const MODE_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "manual", label: "手动确认", title: "每个工具执行前都弹窗确认（原 default，推荐）" },
  { value: "auto", label: "自动模式", title: "自动执行常见安全操作，敏感操作仍确认" },
  { value: "acceptEdits", label: "接受编辑", title: "自动允许文件编辑，其他工具仍需确认" },
  { value: "plan", label: "计划模式", title: "只读分析并给出计划，不执行修改" },
  { value: "bypassPermissions", label: "完全权限", title: "全部工具直接执行，不再确认（危险）" },
];

/** 方案审批被拒时回给模型的话：讲清「不是不要这个方案，是要改」，
 *  模型才会留在计划模式等修改意见（通用工具拒绝文案在这里不合用） */
const PLAN_DENY_MESSAGE =
  "用户暂未批准该方案，希望继续完善；请留在计划模式，等待用户提出修改意见。";

/** 用户直接切走计划模式时用的话——与 PLAN_DENY_MESSAGE 区分开：那条说「请留在
 *  计划模式等修改意见」，而这条路径下用户已经离开了，模型干等一份不会来的意见 */
const PLAN_ABANDON_MESSAGE =
  "用户已切换权限模式，放弃本次方案审批；请停止按该方案推进，等待用户的下一条指令。";

/** settings.json 的 "default" 与 CLI flag 的 manual 同义，归一为 manual 显示 */
function normalizeMode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw === "default" ? "manual" : raw;
}

let nextItemId = 1;

/** 对话进行中（可发停止键） */
function isBusy(status: ChatStatus): boolean {
  return status.phase === "starting" || status.phase === "thinking";
}

type ChatStatus =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "thinking" }
  | { phase: "exited"; code: number | null; stderrTail?: string | null };

/** 变更文件：聚合 Edit/Write/MultiEdit 的 file_path（msgIdx = 历史全局序号，实时消息为 null） */
interface ChangedFile {
  path: string;
  dir: string;
  file: string;
  msgIdx: number | null;
  blockIdx: number;
  count: number;
}

/** 导航轨的一条：历史条目按全局消息序号定位（jumpTo 分页加载），
 *  实时条目按 data-live-user 锚点定位（本次 sitting 的消息还没进历史分页） */
type RailItem =
  | { key: string; kind: "history"; index: number; text: string; timestamp: string | null }
  | { key: string; kind: "live"; liveId: number; text: string };

/** 统一渲染流的一条条目（历史 + 实时合成，见 stream useMemo） */
type StreamEntry =
  | {
      t: "userText";
      key: string;
      text: string;
      images?: ChatImage[];
      msgIndex?: number;
      /** 实时区用户气泡的 item id（导航轨 data-live-user 锚点定位用） */
      liveId?: number;
    }
  | { t: "asstText"; key: string; text: string; msgIndex?: number; streaming?: boolean }
  | { t: "thinking"; key: string; text: string; streaming?: boolean }
  | {
      t: "tool";
      key: string;
      block: ContentBlock;
      /** 搜索/文件面板跳转定位用（历史消息才有） */
      wrap?: { msgIndex: number; blockIdx: number };
      hasResult: boolean;
      isError: boolean;
      resultBlock: ContentBlock | null;
    }
  | { t: "orphanResult"; key: string; block: ContentBlock };

/** 支持粘贴/拖拽的图片类型（与后端 chat.rs 白名单一致） */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 单图大小上限：API 限 5MB，预留 base64 编码余量取 4.5MB */
const IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;

/** File → ChatImage（读为 base64 裸数据）；类型/大小不符时 toast 并返回 null */
function fileToChatImage(file: File, onToast: (msg: string) => void): Promise<ChatImage | null> {
  return new Promise((resolve) => {
    if (!IMAGE_TYPES.has(file.type)) {
      onToast(`不支持的图片格式：${file.type || "未知"}（仅支持 PNG/JPEG/GIF/WebP）`);
      resolve(null);
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      onToast(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 4.5MB`);
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? { mediaType: file.type, data: result.slice(comma + 1) } : null);
    };
    reader.onerror = () => {
      onToast("图片读取失败");
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

export default function ChatView({
  projectPath,
  title,
  session,
  onToast,
  onStatusChange,
}: Props) {
  // ---------- 实时流（本次 sitting 的消息） ----------
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  /** 待发送的图片附件（粘贴/拖拽进入，随消息发送后清空） */
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  /** 当前选中权限模式（原始字符串，"default" 归一为 manual；null = 配置读取中）。
   *  初始值 = settings.json 解析结果；session_ready 后以 CLI init 上报的实际
   *  模式为准。用户改选后显式传 flag（spawn 时）/热切换（运行中） */
  const [mode, setMode] = useState<string | null>(null);
  /** 用户是否手动改选过模式——改选过才在 spawn 时显式传 flag，否则跟随配置 */
  const modeTouchedRef = useRef(false);
  const [status, setStatus] = useState<ChatStatus>({ phase: "idle" });
  const [permissions, setPermissions] = useState<ChatPermissionRequest[]>([]);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [realSessionId, setRealSessionId] = useState<string | null>(null);
  /** 待审批的方案，两种来源：
   *  - native：CLI 经 ExitPlanMode 下发（requestId 非空，应答走 control_response）
   *  - heuristic：计划模式本轮产出结束时的兜底触发。**实测 `--print` 模式下 CLI 的
   *    工具表里没有 ExitPlanMode**（28 个工具，交互类工具在非交互模式被裁掉），
   *    所以当前实际生效的是这一条；原生分支留着，等 CLI 或 SDK 侧放开即自动接管
   *  native 会阻塞在 control_request 上且不超时，任何路径都必须给出 allow/deny */
  const [plan, setPlan] = useState<
    { source: "native"; requestId: string; text: string } | { source: "heuristic"; text: string } | null
  >(null);
  /** 方案审批动作进行中（按钮禁用/文案切换） */
  const [planBusy, setPlanBusy] = useState(false);
  /** 待作答的提问（AskUserQuestion）：模型有分歧时问用户选哪个。卡内状态（当前第几题、
   *  逐题选择与「其他」文本）由 AskQuestionCard 自己持有，卡片按 requestId 重挂载。
   *  ⚠️ 答案必须经 `updatedInput.answers` 回传，只 allow 不带 answers 等于「用户没选」——
   *  不报错但静默失效（见 docs/agent-sdk-interactive-tools.md） */
  const [question, setQuestion] = useState<
    { requestId: string; items: AskQuestionItem[] } | null
  >(null);
  const [questionBusy, setQuestionBusy] = useState(false);
  /** 输入框 ref：「先在对话里说」退出卡片后把光标送过去（不选中就等于没了下文） */
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // ---------- 历史 jsonl ----------
  const [history, setHistory] = useState<SessionMessage[]>([]);
  const [histOffset, setHistOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<SessionUsageStats | null>(null);
  const [historyLoading, setHistoryLoading] = useState(!!session);
  const [reloadKey, setReloadKey] = useState(0);

  // ---------- 搜索 / 变更文件 / 导出 ----------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SessionSearchHit[] | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // ---------- 对话进度条（左侧用户发言导航轨） ----------
  /** 全量用户发言（后端 get_session_user_prompts 提取，index = 历史消息全局序号） */
  const [prompts, setPrompts] = useState<SessionUserPrompt[]>([]);
  /** 视口当前所在的导航轨条目 key（高亮跟随滚动） */
  const [activePromptKey, setActivePromptKey] = useState<string | null>(null);
  /** 悬停气泡：发言 + 相对 chat-main 的纵向位置 */
  const [railTip, setRailTip] = useState<{
    item: RailItem;
    top: number;
  } | null>(null);
  /** 悬停中的横条序号（波浪动效：相邻条按距离递减变宽） */
  const [railHover, setRailHover] = useState<number | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef(0);
  /** 当前会话 file 镜像：loadMore/jumpTo 的异步回包用它判断是否已切换会话，
   *  防止旧会话的迟到结果污染新会话的历史列表 */
  const sessionFileRef = useRef<string | null>(null);
  sessionFileRef.current = session?.file ?? null;
  /** 历史窗口世代号：初始加载/刷新、jumpTo 这类「整窗替换」操作发起时递增；
   *  分页在途回包发现世代已推进（期间发生了跳转/刷新）即整包丢弃 */
  const winSeqRef = useRef(0);
  /** 已提交历史窗口 [start, end) 的镜像：分页回包落地前校验窗口边界未被并发
   *  操作改动（双触发、整窗替换后的迟到回包），防止同一页被前插/追加两次 */
  const winRef = useRef({ start: 0, end: 0 });

  /** 后端跟踪的会话 id（chat_start 返回，chat_send 等凭它寻址） */
  const sessionKeyRef = useRef<string | null>(null);
  /** 会话是否已启动（session_ready 上报过；未启动不弹方案审批卡） */
  const realSessionIdRef = useRef<string | null>(null);
  /** 当前权限模式镜像（handleEvent 等无依赖回调里读最新值） */
  const modeRef = useRef<string | null>(null);
  /** 当前阶段镜像（区分「确曾进入思考态后结束」的那次 idle） */
  const statusRef = useRef<"starting" | "thinking" | "idle" | "exited">("idle");
  /** 上一轮是否出错（出错收尾不弹方案审批卡） */
  const lastTurnErrorRef = useRef(false);
  /** 首次发送前的启动 promise（懒启动：第一条消息才 spawn 进程） */
  const startPromiseRef = useRef<Promise<string> | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 初始加载完成后滚动到底部 */
  const scrollToBottomRef = useRef(true);

  // ---------- 事件处理 ----------

  const handleEvent = useCallback((ev: ChatEvent) => {
    switch (ev.type) {
      case "session_ready":
        setRealSessionId(ev.sessionId);
        realSessionIdRef.current = ev.sessionId;
        // 以 CLI init 上报的实际生效模式为准（校正显示；并复位改选标记，
        // 此后的偏差归配置/CLI，用户再次改选才会显式传 flag）
        {
          const reported = normalizeMode(ev.permissionMode);
          if (reported) {
            setMode(reported);
            modeTouchedRef.current = false;
          }
        }
        break;
      case "status":
        if (ev.state === "thinking") {
          setStatus({ phase: "thinking" });
        } else {
          const wasThinking = statusRef.current === "thinking";
          setStatus((s) => (s.phase === "thinking" ? { phase: "idle" } : s));
          setItems((prev) =>
            prev.map((it) =>
              (it.kind === "text" || it.kind === "thinking") && it.streaming
                ? { ...it, streaming: false }
                : it,
            ),
          );
          // 兜底触发：计划模式下本轮确曾产出（进入过思考态、无错误）→ 弹方案卡。
          // 原生 ExitPlanMode 若已下发，则 native 卡优先，这里不覆盖它
          if (
            wasThinking &&
            modeRef.current === "plan" &&
            !lastTurnErrorRef.current &&
            realSessionIdRef.current
          ) {
            setPlan((p) => (p?.source === "native" ? p : { source: "heuristic", text: "" }));
            setPlanBusy(false);
          }
        }
        break;
      case "content_start":
        setItems((prev) => {
          const id = nextItemId++;
          return ev.kind === "text"
            ? [...prev, { id, kind: "text", text: "", streaming: true }]
            : [...prev, { id, kind: "thinking", text: "", streaming: true }];
        });
        break;
      case "delta": {
        if (ev.kind === "tool_input") break; // tool input 由 tool_use_complete 整体呈现
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === ev.kind && "streaming" in last && last.streaming) {
            const copy = [...prev];
            copy[copy.length - 1] = { ...last, text: last.text + ev.text };
            return copy;
          }
          const id = nextItemId++;
          return ev.kind === "text"
            ? [...prev, { id, kind: "text", text: ev.text, streaming: true }]
            : [...prev, { id, kind: "thinking", text: ev.text, streaming: true }];
        });
        break;
      }
      case "tool_use_start":
        setItems((prev) => {
          if (prev.some((it) => it.kind === "tool_use" && it.toolUseId === ev.toolUseId)) {
            return prev;
          }
          return [
            ...prev,
            {
              id: nextItemId++,
              kind: "tool_use",
              toolUseId: ev.toolUseId,
              name: ev.name,
              input: null,
              hasResult: false,
              isError: false,
            },
          ];
        });
        break;
      case "tool_use_complete":
        setItems((prev) => {
          const idx = prev.findIndex(
            (it) => it.kind === "tool_use" && it.toolUseId === ev.toolUseId,
          );
          if (idx === -1) {
            return [
              ...prev,
              {
                id: nextItemId++,
                kind: "tool_use",
                toolUseId: ev.toolUseId,
                name: ev.name,
                input: ev.input,
                hasResult: false,
                isError: false,
              },
            ];
          }
          const copy = [...prev];
          copy[idx] = { ...copy[idx], name: ev.name, input: ev.input } as ChatItem;
          return copy;
        });
        break;
      case "tool_result":
        setItems((prev) => {
          const idx = prev.findIndex(
            (it) => it.kind === "tool_use" && it.toolUseId === ev.toolUseId,
          );
          const copy = [...prev];
          if (idx !== -1) {
            copy[idx] = {
              ...copy[idx],
              hasResult: true,
              isError: ev.isError,
              resultText: ev.text,
            } as ChatItem;
            return copy;
          }
          const id = nextItemId++;
          return [
            ...copy,
            { id, kind: "tool_result", toolUseId: ev.toolUseId, isError: ev.isError, text: ev.text },
          ];
        });
        break;
      case "message_complete": {
        const u = ev.usage;
        setUsage((prev) =>
          prev
            ? {
                inputTokens: prev.inputTokens + u.inputTokens,
                outputTokens: prev.outputTokens + u.outputTokens,
                cacheReadInputTokens: prev.cacheReadInputTokens + u.cacheReadInputTokens,
                cacheCreationInputTokens:
                  prev.cacheCreationInputTokens + u.cacheCreationInputTokens,
              }
            : u,
        );
        break;
      }
      case "permission_request":
        // 提问单独成卡（选项有语义，不能当普通工具卡把 input 打成 JSON 丢给用户看）
        if (ev.toolName === "AskUserQuestion") {
          const items = parseAskQuestions(ev.input);
          setQuestion({ requestId: ev.requestId, items });
          break;
        }
        setPermissions((prev) =>
          prev.some((p) => p.requestId === ev.requestId)
            ? prev
            : [...prev, { requestId: ev.requestId, toolName: ev.toolName, input: ev.input }],
        );
        break;
      case "permission_cancelled":
        setPermissions((prev) => prev.filter((p) => p.requestId !== ev.requestId));
        // 方案卡同样要收（用户在别处中断/CLI 自己撤销），否则卡会挂在没有请求的状态上
        setPlan((p) =>
          p?.source === "native" && p.requestId === ev.requestId ? null : p,
        );
        setQuestion((q) => (q?.requestId === ev.requestId ? null : q));
        break;
      case "plan_approval":
        // 原生：模型调 ExitPlanMode 请求退出计划模式，出方案卡等应答（同一轮内继续）
        setPlan({ source: "native", requestId: ev.requestId, text: ev.plan });
        setPlanBusy(false);
        break;
      case "turn_end":
        lastTurnErrorRef.current = !!ev.isError;
        if (ev.isError) onToast("本轮执行出错");
        break;
      case "exited": {
        setStatus({ phase: "exited", code: ev.code, stderrTail: ev.stderrTail });
        sessionKeyRef.current = null;
        startPromiseRef.current = null;
        // 进程没了，方案卡/提问卡再也应答不出去：收掉，别留按钮点不动的死卡
        setPlan(null);
        setPlanBusy(false);
        setQuestion(null);
        setQuestionBusy(false);
        if (ev.code !== null && ev.code !== 0) {
          onToast(`claude 进程已退出（code ${ev.code}）`);
        }
        break;
      }
      case "error":
        onToast("对话错误：" + ev.message);
        break;
    }
  }, [onToast]);

  // ---------- 历史 jsonl 加载 ----------

  /** 读取 settings.json 解析出的默认模式（项目 local > 项目 > 用户级），
   *  作为下拉初始选中项——与终端打开时默认所处模式一致 */
  useEffect(() => {
    let cancelled = false;
    api
      .chatDefaultPermissionMode(projectPath)
      .then((raw) => {
        if (!cancelled) setMode(normalizeMode(raw));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // 镜像 ref：handleEvent / changeMode 等稳定回调在闭包里读最新值
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    statusRef.current = status.phase;
  }, [status.phase]);
  /** 兜底卡出现时把正文快照下来（本轮最后一条已完成的助手文本），只快照一次：
   *  卡片正文不该随后续 items 漂移——尤其「刷新」会清空 items，不快照的话正文会
   *  退化成空占位，而三个审批按钮照旧可点 */
  useEffect(() => {
    if (plan?.source !== "heuristic" || plan.text) return;
    let text = "";
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "text" && !it.streaming && it.text.trim()) {
        text = it.text.trim();
        break;
      }
    }
    if (!text) return;
    const snapshot = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    setPlan((p) =>
      p?.source === "heuristic" && !p.text ? { source: "heuristic", text: snapshot } : p,
    );
  }, [plan, items]);

  // 历史初始加载：默认取最后 500 条（会话切换或点「刷新」时重新加载）。
  // 依赖会话 file 而非 session 对象身份：重命名只改标题也会换对象
  // （App 侧同步 tab 标题），按对象重载会把阅读位置与搜索状态一起冲掉
  useEffect(() => {
    if (!session) {
      setHistory([]);
      setStats(null);
      setSearchResults(null);
      setPrompts([]);
      setActivePromptKey(null);
      setRailTip(null);
      winRef.current = { start: 0, end: 0 };
      return;
    }
    setSearchOpen(false);
    setSearchKeyword("");
    setSearchResults(null);
    setFilesOpen(false);
    setExportMenuOpen(false);
    let cancelled = false;
    scrollToBottomRef.current = true;
    setHistoryLoading(true);
    const seq = ++winSeqRef.current; // 递增世代，使在途分页/旧跳转回包作废
    api
      .getSessionMessages(session.file)
      .then((data) => {
        if (cancelled || seq !== winSeqRef.current) return;
        winRef.current = { start: data.offset, end: data.offset + data.messages.length };
        setHistory(data.messages);
        setHistOffset(data.offset);
        setHasMore(data.hasMore);
        setTotal(data.total);
        setStats(data.stats);
      })
      .catch(() => onToast("加载历史消息失败"))
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
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
  }, [session?.file, reloadKey, onToast]);

  /** 加载更早的一页（插入顶部并保持滚动位置） */
  const loadMore = useCallback(async () => {
    if (!session || historyLoading || !hasMore) return;
    const myFile = session.file;
    // 双重作废条件：发起后若发生了跳转/刷新（世代推进）或窗口起点已变
    // （同页双触发、整窗替换），回包一律丢弃——前插页必须恰好接在当前窗口头上
    const reqSeq = winSeqRef.current;
    const reqStart = winRef.current.start;
    const body = bodyRef.current;
    const prevHeight = body?.scrollHeight ?? 0;
    const prevTop = body?.scrollTop ?? 0;
    try {
      const data = await api.getSessionMessages(
        session.file,
        Math.max(0, histOffset - PAGE_SIZE),
      );
      if (sessionFileRef.current !== myFile) return; // 已切换会话，丢弃迟到结果
      if (reqSeq !== winSeqRef.current || winRef.current.start !== reqStart) return;
      winRef.current = { start: data.offset, end: winRef.current.end };
      setHistory((prev) => [...data.messages, ...prev]);
      setHistOffset(data.offset);
      setHasMore(data.hasMore);
      setTotal(data.total);
      setStats(data.stats);
      // 新增内容在顶部：滚动偏移补偿，保持当前阅读位置（回调执行时再校验
      // 会话未切换，否则补偿会写到新会话的滚动容器上、拽走阅读位置）
      requestAnimationFrame(() => {
        if (body && sessionFileRef.current === myFile) {
          body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
        }
      });
    } catch (e) {
      onToast("加载更早消息失败：" + String(e));
    }
  }, [session, historyLoading, hasMore, histOffset, onToast]);

  /** 加载更晚的一页（窗口末尾续接），追加在历史区尾部：跳转整窗替换后，
   *  向下翻靠它把后面的内容接回来。追加不影响当前滚动位置，无需补偿 */
  const loadLater = useCallback(async () => {
    if (!session || historyLoading) return;
    const myFile = session.file;
    const reqSeq = winSeqRef.current;
    const reqEnd = winRef.current.end; // 追加页必须恰好接在当前窗口末尾
    if (reqEnd >= total) return; // 后面没有了
    try {
      const data = await api.getSessionMessages(session.file, reqEnd);
      if (sessionFileRef.current !== myFile) return; // 已切换会话，丢弃迟到结果
      if (reqSeq !== winSeqRef.current || winRef.current.end !== reqEnd) return;
      winRef.current = { start: winRef.current.start, end: reqEnd + data.messages.length };
      setHistory((prev) => [...prev, ...data.messages]);
      setTotal(data.total);
      setStats(data.stats);
    } catch (e) {
      onToast("加载更晚消息失败：" + String(e));
    }
  }, [session, historyLoading, total, onToast]);

  /** 「刷新」：重读 jsonl 并清空实时区（jsonl 为唯一事实来源；对话进行中禁用） */
  const refreshHistory = useCallback(() => {
    if (!session || isBusy(status)) return;
    setItems([]);
    setUsage(null);
    setReloadKey((k) => k + 1);
  }, [session, status]);

  // ---------- 进程生命周期 ----------

  useEffect(
    () => () => {
      const key = sessionKeyRef.current;
      if (key) void api.chatClose(key).catch(() => {});
    },
    [],
  );

  /** 懒启动对话进程（首次发送时调用） */
  const ensureStarted = useCallback((): Promise<string> => {
    if (sessionKeyRef.current) return Promise.resolve(sessionKeyRef.current);
    if (!startPromiseRef.current) {
      setStatus({ phase: "starting" });
      const channel = new Channel<ChatEvent>();
      channel.onmessage = handleEvent;
      startPromiseRef.current = api
        .chatStart(
          projectPath,
          session?.file ?? null,
          // 用户改选过 → 显式传 flag；否则跟随 settings.json（不传 flag）
          modeTouchedRef.current && mode ? (mode as ChatPermissionMode) : null,
          channel,
        )
        .then((key) => {
          sessionKeyRef.current = key;
          setStatus({ phase: "idle" });
          return key;
        })
        .catch((e) => {
          startPromiseRef.current = null;
          setStatus({ phase: "idle" });
          throw e;
        });
    }
    return startPromiseRef.current;
  }, [projectPath, session, mode, handleEvent]);

  // ---------- 发送 / 停止 / 权限 / 模式 ----------

  /** 拒绝一条原生方案请求（ExitPlanMode），返回是否送达。
   *  CLI 阻塞在那条 control_request 上且不会超时，故失败必须让调用方保留卡片可重试——
   *  三条触发路径（发送消息 / 切走计划模式 / 点「继续修改」）共用同一失败语义。 */
  const denyPlan = useCallback(
    async (requestId: string, message: string): Promise<boolean> => {
      const key = sessionKeyRef.current;
      if (!key) return false;
      try {
        await api.chatPermissionResponse(key, requestId, false, message);
        return true;
      } catch (e) {
        onToast("方案应答失败：" + String(e));
        return false;
      }
    },
    [onToast],
  );

  /** 应答一条提问（AskUserQuestion）。
   *  ⚠️ `answers` 是唯一有效回传：只回 allow 不带它 → 模型收到「问题已发出，但你没有
   *  选择任何选项」，不报错但静默失效（见 docs/agent-sdk-interactive-tools.md）。
   *  一道题都没选时把空答案交给后端，由后端明确拒绝（比静默失效好定位）。 */
  const respondQuestion = useCallback(
    async (answers: Record<string, string> | null, response?: string) => {
      const q = question;
      const key = sessionKeyRef.current;
      if (!q || !key) return;
      setQuestionBusy(true);
      try {
        if (answers === null) {
          await api.chatPermissionResponse(key, q.requestId, false, "用户取消了这次提问");
        } else {
          await api.chatPermissionResponse(
            key,
            q.requestId,
            true,
            undefined,
            Object.keys(answers).length > 0 ? answers : undefined,
            response,
          );
        }
        setQuestion(null);
      } catch (e) {
        onToast("提问应答失败：" + String(e));
      } finally {
        setQuestionBusy(false);
      }
    },
    [question, onToast],
  );

  /** 「先在对话里说」（TUI 的 Chat about this）：不选选项、退出卡片回聊天。
   *  走 `response`（自由文本）回传路径：后端已在实测中确认该字段生效
   *  （docs/agent-sdk-interactive-tools.md），模型会收到一条「用户说了什么」而非答案。 */
  const discussQuestion = useCallback(() => {
    void respondQuestion(
      {},
      "（用户选择先在对话里讨论，暂不回答这些问题；请直接回复，必要时再问）",
    );
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [respondQuestion]);

  const send = useCallback(async () => {
    const text = input.trim();
    const images = pendingImages;
    const pendingNative = plan?.source === "native" ? plan : null;
    if (status.phase === "exited") return;
    if (!text && images.length === 0) return;
    // 原生方案请求在等应答时不按「忙碌」拦：那条路径下 status 停在 thinking（模型
    // 阻塞在 ExitPlanMode 上，本轮没结束），但用户此刻正需要打字提修改意见
    if (!pendingNative && isBusy(status)) {
      // 静默 no-op 最难受（提问卡在场时按 Enter 尤其容易撞上）：说清楚为什么没发出去
      if (text || images.length > 0) onToast("本轮还在进行中：等它跑完，或点「停止」再发");
      return;
    }
    // 先应答再动 UI：deny 没送达就整条中止——输入与气泡都不动，用户可原样重试。
    // 顺序也不能反：CLI 阻塞在那条 control_request 上，不先应答，发出去的消息要等
    // 工具调用被解开之后才会被读到。planBusy 顺带按住卡上按钮，防同一 request_id
    // 在 IPC 往返窗口里被应答第二次
    if (pendingNative) {
      setPlanBusy(true);
      const ok = await denyPlan(pendingNative.requestId, PLAN_DENY_MESSAGE);
      setPlanBusy(false);
      if (!ok) return;
    }
    setInput("");
    setPendingImages([]);
    setItems((prev) => [
      ...prev,
      { id: nextItemId++, kind: "user", text, images: images.length > 0 ? images : undefined },
    ]);
    // 两种来源都一样：发出新消息即表示本轮方案卡不再适用
    setPlan(null);
    try {
      const key = await ensureStarted();
      await api.chatSend(key, text, images);
    } catch (e) {
      onToast("发送失败：" + String(e));
    }
  }, [input, pendingImages, status, plan, ensureStarted, denyPlan, onToast]);

  /** 追加图片附件（粘贴/拖拽共用；非图片文件静默忽略） */
  const addImages = useCallback(
    async (files: Array<File | null>) => {
      const imgs = files.filter((f): f is File => f !== null && f.type.startsWith("image/"));
      if (imgs.length === 0) return;
      const converted = await Promise.all(imgs.map((f) => fileToChatImage(f, onToast)));
      const valid = converted.filter((i): i is ChatImage => i !== null);
      if (valid.length > 0) setPendingImages((prev) => [...prev, ...valid]);
    },
    [onToast],
  );

  /** 粘贴图片（截图 Ctrl+V / 复制的图片文件）；纯文本粘贴不受影响 */
  const onPasteImages = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addImages(files);
      }
    },
    [addImages],
  );

  const interrupt = useCallback(async () => {
    const key = sessionKeyRef.current;
    if (!key) return;
    try {
      await api.chatInterrupt(key);
    } catch (e) {
      onToast("中断失败：" + String(e));
    }
  }, [onToast]);

  /** 改选权限模式：立即热切换（进程已启动）；进程未启动时记住选择，
   *  spawn 时显式传 flag（覆盖配置默认） */
  const changeMode = useCallback(
    async (m: string) => {
      // 离开计划模式时收掉方案卡。原生请求必须补一次 deny——CLI 阻塞在那条
      // control_request 上且不会超时，光切模式解不开，会话会一直卡住；
      // 兜底卡没有协议请求，直接收卡即可。deny 没送达就整体中止（保留卡片、不切模式），
      // 否则会留下「模式已切走、请求仍悬空」且用户没有任何可点按钮的状态
      if (m !== "plan" && plan) {
        if (plan.source === "native") {
          setPlanBusy(true);
          const ok = await denyPlan(plan.requestId, PLAN_ABANDON_MESSAGE);
          setPlanBusy(false);
          if (!ok) return;
        }
        setPlan(null);
      }
      setMode(m);
      modeTouchedRef.current = true;
      const key = sessionKeyRef.current;
      if (!key) return;
      try {
        await api.chatSetPermissionMode(key, m as ChatPermissionMode);
      } catch (e) {
        onToast("切换模式失败：" + String(e));
      }
    },
    [onToast, plan, denyPlan],
  );

  /** 方案审批应答，两种来源：
   *  - 原生：批准 = allow（CLI 退出计划模式并在同一轮继续执行）→ 再按所选模式热切换；
   *    继续修改 = deny，模型收到拒绝后留在计划模式等修改意见
   *  - 兜底：批准 = 切模式 + 发一条执行指令（没有协议请求可应答）；
   *    继续修改 = 只收卡（本轮已结束，用户直接打字即可）
   *  原生请求阻塞在 control_request 上且不超时，应答没送达时卡要留着可重试。 */
  const respondPlan = useCallback(
    async (approve: boolean, nextMode?: string) => {
      const req = plan;
      const key = sessionKeyRef.current;
      if (!req || !key) return;
      setPlanBusy(true);
      if (req.source === "native") {
        if (!approve) {
          // 拒绝：共用失败语义（没送达就保留卡片可重试），然后就此结束——
          // 兜底路径「继续修改」只收卡，原生路径则把拒绝交给模型后留在计划模式
          const ok = await denyPlan(req.requestId, PLAN_DENY_MESSAGE);
          setPlanBusy(false);
          if (ok) setPlan(null);
          return;
        }
        try {
          await api.chatPermissionResponse(key, req.requestId, true);
        } catch (e) {
          // 应答没送达 → 卡保留可重试（CLI 仍阻塞在这条请求上）
          onToast("方案应答失败：" + String(e));
          setPlanBusy(false);
          return;
        }
      }
      setPlan(null);
      setPlanBusy(false);
      if (!approve || !nextMode) return;
      try {
        // 顺序要紧：原生路径先 allow 让 CLI 跑完 ExitPlanMode（它自己会恢复
        // prePlanMode），再热切换覆盖成用户选的模式——反过来会被它的恢复动作盖掉
        await api.chatSetPermissionMode(key, nextMode as ChatPermissionMode);
        setMode(nextMode);
        modeTouchedRef.current = true;
        if (req.source === "heuristic") {
          await api.chatSend(key, "（已批准方案）请按上面的方案开始执行。");
        }
      } catch (e) {
        onToast("切换模式失败：" + String(e));
      }
    },
    [plan, denyPlan, onToast],
  );

  const respondPermission = useCallback(
    async (requestId: string, allow: boolean) => {
      setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
      const key = sessionKeyRef.current;
      if (!key) return;
      try {
        await api.chatPermissionResponse(key, requestId, allow);
      } catch (e) {
        onToast("权限响应失败：" + String(e));
      }
    },
    [onToast],
  );

  // ---------- 搜索（防抖全文搜索 + 跳转定位） ----------

  // 依赖与历史初始加载同一键控口径（session?.file）：重命名只换对象身份，
  // 不重发同文件同关键词的冗余查询；内容重载会清空关键词，搜索随之复位
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
  }, [session?.file, searchKeyword, onToast]);

  /** 跳转到某条历史消息（全局序号）：未加载的分页先加载对应页再定位 */
  const jumpTo = useCallback(
    async (globalIndex: number, blockIndex?: number) => {
      const body = bodyRef.current;
      if (!body) return;
      const myFile = session?.file ?? null;
      // 跳转是用户最新意图：递增世代，使在途分页/更早的跳转回包作废，
      // 否则迟到的回包会按旧窗口前插/替换，造成内容重复或乱序
      const seq = ++winSeqRef.current;
      let needFrame = false;
      if (globalIndex < histOffset || globalIndex >= histOffset + history.length) {
        if (!session) return;
        const pageStart = Math.floor(globalIndex / PAGE_SIZE) * PAGE_SIZE;
        try {
          const data = await api.getSessionMessages(session.file, pageStart);
          if (sessionFileRef.current !== myFile) return; // 已切换会话，丢弃迟到结果
          if (seq !== winSeqRef.current) return; // 期间又发起了更新的跳转/刷新
          winRef.current = { start: data.offset, end: data.offset + data.messages.length };
          setHistory(data.messages);
          setHistOffset(data.offset);
          setHasMore(data.hasMore);
          setTotal(data.total);
          setStats(data.stats);
          needFrame = true;
        } catch (e) {
          onToast("定位失败：" + String(e));
          return;
        }
      }
      const locate = () => {
        if (sessionFileRef.current !== myFile) return; // 已切换会话，不定位
        if (seq !== winSeqRef.current) return; // 已有更新的跳转接管定位
        const el = body.querySelector(`[data-msg-index="${globalIndex}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "start" });
        el.classList.remove("msg-flash");
        void (el as HTMLElement).offsetWidth;
        el.classList.add("msg-flash");
        if (blockIndex !== undefined) {
          const card = body.querySelector(
            `[data-block-idx="${globalIndex}-${blockIndex}"] details`,
          );
          if (card) {
            card.setAttribute("open", "");
            card.closest("details.activity")?.setAttribute("open", "");
          }
        }
      };
      if (needFrame) requestAnimationFrame(locate);
      else locate();
    },
    [session, histOffset, history.length, onToast],
  );

  // ---------- 对话进度条（导航轨高亮/悬停） ----------

  /** 本次 sitting 的用户发言（实时导航轨）：过滤口径与后端 user_prompts_impl
   *  一致（无文本的不算，纯图片消息后端清洗后同样为空）；liveId = 实时气泡
   *  的 item id。新对话没有 jsonl 可读，靠它轨道才会随对话生长 */
  const livePrompts = useMemo(
    () =>
      items
        .filter(
          (it): it is Extract<ChatItem, { kind: "user" }> =>
            it.kind === "user" && it.text.trim().length > 0,
        )
        .map((it) => ({ key: `l${it.id}`, liveId: it.id, text: it.text })),
    [items],
  );

  /** 导航轨统一条目：历史（jsonl 提取）在前，实时（本次 sitting）在后 */
  const railItems = useMemo<RailItem[]>(
    () => [
      ...prompts.map((p) => ({
        key: `h${p.index}`,
        kind: "history" as const,
        index: p.index,
        text: p.text,
        timestamp: p.timestamp ?? null,
      })),
      ...livePrompts.map((p) => ({ ...p, kind: "live" as const })),
    ],
    [prompts, livePrompts],
  );

  /** 轨道高亮跟随滚动：视口顶部附近最近的那条用户发言（历史查 data-msg-index，
   *  实时查 data-live-user——实时消息的全局序号要等刷新并入 jsonl 才确定） */
  const updateActivePrompt = useCallback(() => {
    const body = bodyRef.current;
    if (!body || railItems.length === 0) {
      setActivePromptKey(null);
      return;
    }
    const bodyTop = body.getBoundingClientRect().top;
    let active: string | null = null;
    for (const item of railItems) {
      if (item.kind === "history") {
        // 未加载的分页查不到元素，直接跳过（条目按序号升序，扫全量也便宜）
        if (item.index < histOffset) continue;
        if (item.index >= histOffset + history.length) continue;
      }
      const el = body.querySelector(
        item.kind === "live"
          ? `[data-live-user="${item.liveId}"]`
          : `[data-msg-index="${item.index}"]`,
      );
      if (!el) continue;
      if (el.getBoundingClientRect().top - bodyTop <= 140) active = item.key;
      else break;
    }
    // 触底特例：最后一条发言可能还贴在阅读线以下（差不到一屏过不了线），
    // 上面的「过线即激活」只能停在倒数第二条；触底时视口已到内容末尾，
    // 从轨道末尾往回找第一条有 DOM 锚点的条目（历史/实时都可能）
    if (body.scrollHeight - body.scrollTop - body.clientHeight <= 4) {
      for (let i = railItems.length - 1; i >= 0; i--) {
        const item = railItems[i];
        if (
          item.kind === "history" &&
          (item.index < histOffset || item.index >= histOffset + history.length)
        )
          continue; // 未加载的分页查不到元素
        const anchor =
          item.kind === "live"
            ? `[data-live-user="${item.liveId}"]`
            : `[data-msg-index="${item.index}"]`;
        if (body.querySelector(anchor)) {
          active = item.key;
          break;
        }
      }
    }
    setActivePromptKey(active);
  }, [railItems, histOffset, history.length]);

  // 消息/分页/进度数据变化后重算高亮（等 DOM 提交）
  useEffect(() => {
    if (historyLoading) return;
    const id = requestAnimationFrame(updateActivePrompt);
    return () => cancelAnimationFrame(id);
  }, [historyLoading, updateActivePrompt]);

  const onChatScroll = useCallback(() => {
    const body = bodyRef.current;
    if (body) {
      if (body.scrollTop <= 40) void loadMore();
      else if (body.scrollHeight - body.scrollTop - body.clientHeight <= 40)
        void loadLater();
    }
    // 高亮用 rAF 节流，一帧最多算一次
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(updateActivePrompt);
  }, [loadMore, loadLater, updateActivePrompt]);

  /** 定位到实时区的用户气泡（本次 sitting 的消息不在历史分页，走 DOM 锚点） */
  const jumpToLive = useCallback((liveId: number) => {
    const el = bodyRef.current?.querySelector(`[data-live-user="${liveId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.remove("msg-flash");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("msg-flash");
  }, []);

  /** 悬停格子：气泡浮在轨道右侧，纵向对齐格子并夹在可视区内 */
  const openRailTip = useCallback((item: RailItem, btn: HTMLElement) => {
    const main = mainRef.current;
    if (!main) return;
    const mr = main.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const TIP_MAX = 300; // 与 CSS max-height 一致
    const top = Math.max(8, Math.min(br.top - mr.top - 10, mr.height - TIP_MAX - 8));
    setRailTip({ item, top });
  }, []);

  // ---------- 变更文件聚合（历史 + 实时） ----------

  const changedFiles = useMemo(() => {
    const byPath = new Map<string, ChangedFile>();
    const add = (filePath: unknown, msgIdx: number | null, blockIdx: number) => {
      if (typeof filePath !== "string" || !filePath.trim()) return;
      const existing = byPath.get(filePath);
      if (existing) {
        existing.count += 1;
        return;
      }
      const parts = filePath.split(/[\\/]/);
      const file = parts.pop() || filePath;
      byPath.set(filePath, {
        path: filePath,
        dir: parts.join("/"),
        file,
        msgIdx,
        blockIdx,
        count: 1,
      });
    };
    history.forEach((m, i) => {
      m.blocks.forEach((b, bi) => {
        if (b.kind !== "tool_use") return;
        if (b.name !== "Edit" && b.name !== "Write" && b.name !== "MultiEdit") return;
        add(((b.input ?? {}) as Record<string, unknown>).file_path, histOffset + i, bi);
      });
    });
    items.forEach((it) => {
      if (it.kind !== "tool_use") return;
      if (it.name !== "Edit" && it.name !== "Write" && it.name !== "MultiEdit") return;
      add(((it.input ?? {}) as Record<string, unknown>).file_path, null, 0);
    });
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
  }, [history, histOffset, items]);

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
        const ext = format === "markdown" ? "md" : "jsonl";
        const dest = await api.saveFileDialog(
          format === "markdown" ? "导出会话（Markdown）" : "导出会话（JSONL）",
          `${base}.${ext}`,
          [
            {
              name: format === "markdown" ? "Markdown 文档" : "JSON Lines",
              extensions: [ext],
            },
          ],
        );
        if (!dest) return;
        await api.exportSession(session.file, dest, format);
        onToast(`已导出：${dest}`);
      } catch (e) {
        onToast("导出失败：" + String(e));
      }
    },
    [session, onToast],
  );

  // ---------- 自动滚动（贴近底部时跟随） ----------

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // 初始定位：滚动标记在内容真正渲染出来后才消费——加载中（空 body）
    // 就消费会把标记浪费掉，导致打开历史会话停留在开头而不是最新内容
    if (scrollToBottomRef.current) {
      if (historyLoading || (history.length === 0 && items.length === 0)) return;
      body.scrollTop = body.scrollHeight;
      scrollToBottomRef.current = false;
      return;
    }
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    if (nearBottom || isBusy(status)) {
      body.scrollTop = body.scrollHeight;
    }
  }, [items, status, permissions, history, historyLoading]);

  // ---------- 派生渲染数据 ----------

  /** 历史消息的 tool 关联（状态标记 + 展开看结果） */
  const { resultMapPre, resultBlocksPre, toolNames } = useMemo(() => {
    const resultMapPre = new Map<string, boolean>();
    const resultBlocksPre = new Map<string, ContentBlock>();
    const toolNames = new Map<string, string>();
    for (const m of history) {
      for (const b of m.blocks) {
        if (b.kind === "tool_result" && b.toolUseId) {
          resultMapPre.set(b.toolUseId, !!b.isError);
          if (!resultBlocksPre.has(b.toolUseId)) resultBlocksPre.set(b.toolUseId, b);
        }
      }
    }
    for (const m of history) {
      for (const b of m.blocks) {
        if (b.kind === "tool_use" && b.name) {
          toolNames.set(b.toolUseId ?? "", b.name);
        }
      }
    }
    return { resultMapPre, resultBlocksPre, toolNames };
  }, [history]);

  /**
   * 统一渲染流：历史 jsonl 消息 + 实时流式消息合成一条时间线，活动组**跨消息合并**——
   * jsonl 里一轮工具循环拆成多条 assistant 消息（思考/工具调用、工具结果各一条），
   * 若按单条消息分组会出现「思考·读取→搜索→思考…」的碎行；这里从一次文本输出到
   * 下一次文本输出之间的所有思考/工具调用折成同一组（与终端 Ctrl+O 行为一致）。
   */
  const stream = useMemo(() => {
    const entries: StreamEntry[] = [];

    // 历史：纯工具结果的 user 消息不产生用户气泡（结果已并入工具行），仅保留无主结果
    history.forEach((m, i) => {
      const msgIndex = histOffset + i;
      if (m.kind === "user") {
        const texts = m.blocks.filter((b) => b.kind === "text" && b.text);
        const imgs = m.blocks
          .filter((b) => b.kind === "image" && b.mediaType && b.data)
          .map((b) => ({ mediaType: b.mediaType as string, data: b.data as string }));
        if (texts.length > 0 || imgs.length > 0) {
          entries.push({
            t: "userText",
            key: `h${msgIndex}`,
            text: texts.map((b) => b.text ?? "").join("\n"),
            images: imgs.length > 0 ? imgs : undefined,
            msgIndex,
          });
        }
        for (const b of m.blocks) {
          if (b.kind === "tool_result" && b.toolUseId && !resultBlocksPre.has(b.toolUseId)) {
            entries.push({ t: "orphanResult", key: `h${msgIndex}-o`, block: b });
          }
        }
        return;
      }
      for (let bi = 0; bi < m.blocks.length; bi++) {
        const b = m.blocks[bi];
        if (b.kind === "text" && b.text) {
          entries.push({ t: "asstText", key: `h${msgIndex}-t${bi}`, text: b.text, msgIndex });
        } else if (b.kind === "thinking" && b.text) {
          entries.push({ t: "thinking", key: `h${msgIndex}-k${bi}`, text: b.text });
        } else if (b.kind === "tool_use") {
          const id = b.toolUseId ?? "";
          entries.push({
            t: "tool",
            key: `h${msgIndex}-u${bi}`,
            block: b,
            wrap: { msgIndex, blockIdx: bi },
            hasResult: resultMapPre.has(id),
            isError: resultMapPre.get(id) ?? false,
            resultBlock: resultBlocksPre.get(id) ?? null,
          });
        }
      }
    });

    // 实时（本次 sitting 的流式消息）
    for (const it of items) {
      switch (it.kind) {
        case "user":
          entries.push({
            t: "userText",
            key: `l${it.id}`,
            text: it.text,
            images: it.images,
            liveId: it.id,
          });
          break;
        case "text":
          entries.push({
            t: "asstText",
            key: `l${it.id}`,
            text: it.text,
            streaming: it.streaming,
          });
          break;
        case "thinking":
          entries.push({
            t: "thinking",
            key: `l${it.id}`,
            text: it.text,
            streaming: it.streaming,
          });
          break;
        case "tool_use":
          entries.push({
            t: "tool",
            key: `l${it.id}`,
            block: { kind: "tool_use", name: it.name, input: it.input, toolUseId: it.toolUseId },
            hasResult: it.hasResult,
            isError: it.isError,
            resultBlock: it.hasResult
              ? { kind: "tool_result", text: it.resultText ?? "", isError: it.isError }
              : null,
          });
          break;
        case "tool_result":
          entries.push({
            t: "orphanResult",
            key: `l${it.id}`,
            block: { kind: "tool_result", text: it.text, isError: it.isError },
          });
          break;
      }
    }
    return entries;
  }, [history, histOffset, items, resultMapPre, resultBlocksPre]);

  /** 孤儿工具结果的工具名回查（历史优先，实时区兜底） */
  const toolNameOf = useCallback(
    (toolUseId: string): string | null => {
      const fromHistory = toolNames.get(toolUseId);
      if (fromHistory) return fromHistory;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool_use" && it.toolUseId === toolUseId) return it.name;
      }
      return null;
    },
    [toolNames, items],
  );

  // 状态变化上报给 tab 栏（多会话并行的进行中标记）
  useEffect(() => {
    onStatusChange?.(status.phase);
  }, [status.phase, onStatusChange]);

  const statusLabel = useMemo(() => {
    switch (status.phase) {
      case "starting":
        return "启动中…";
      case "thinking":
        return "思考中…";
      case "exited":
        return status.code !== null && status.code !== 0
          ? `已退出（code ${status.code}）`
          : "已退出";
      default:
        // 未开始时不显示徽标（搜索按钮旁留白即可）
        return realSessionId ? "已连接" : "";
    }
  }, [status, realSessionId]);

  /**
   * 统一渲染：活动组跨消息合并——连续的思考/工具/孤儿结果条目折进同一个
   * 可展开组，遇到用户气泡或助手文本即收口（与终端 Ctrl+O 行为一致）。
   * data-msg-index（文本/用户气泡）与 data-block-idx（工具行）供搜索/文件跳转。
   */
  const renderStream = () => {
    const nodes: ReactNode[] = [];
    if (hasMore) {
      nodes.push(
        <button key="more" className="viewer-load-more" onClick={() => void loadMore()}>
          <ArrowUpIcon size={12} /> 加载更早的消息（还剩 {histOffset} 条）
        </button>,
      );
    } else if (histOffset > 0) {
      nodes.push(
        <div key="head" className="viewer-truncated">
          已到会话开头
        </div>,
      );
    }

    let buf: Array<Extract<StreamEntry, { t: "thinking" | "tool" | "orphanResult" }>> = [];
    const flush = () => {
      if (buf.length === 0) return;
      const entries = buf;
      buf = [];
      const last = entries[entries.length - 1];
      // 进行中标记只看实时区尾部（历史都是已完成的）
      const running =
        status.phase === "thinking" &&
        !last.key.startsWith("h") &&
        (last.t === "thinking"
          ? last.streaming === true
          : last.t === "tool"
            ? !last.hasResult
            : false);
      nodes.push(
        <div key={`act-${entries[0].key}`} className="chat-msg chat-msg-assistant">
          <ActivityGroup
            summary={activitySummary(
              entries.map((e) =>
                e.t === "tool"
                  ? { kind: "tool_use", name: e.block.name }
                  : { kind: e.t === "thinking" ? "thinking" : "tool_result" },
              ),
            )}
            running={running}
          >
            {entries.map((e) => {
              if (e.t === "thinking") {
                return <ThinkingBlock key={e.key} text={e.text} />;
              }
              if (e.t === "tool") {
                return (
                  <div
                    key={e.key}
                    data-block-idx={
                      e.wrap ? `${e.wrap.msgIndex}-${e.wrap.blockIdx}` : undefined
                    }
                  >
                    <ToolUseRow
                      block={e.block}
                      hasResult={e.hasResult}
                      isError={e.isError}
                      resultBlock={e.resultBlock}
                    />
                  </div>
                );
              }
              return (
                <ToolResultCard
                  key={e.key}
                  block={e.block}
                  toolName={e.block.toolUseId ? toolNameOf(e.block.toolUseId) : null}
                />
              );
            })}
          </ActivityGroup>
        </div>,
      );
    };

    for (const e of stream) {
      if (e.t === "userText") {
        flush();
        nodes.push(
          <div
            key={e.key}
            className="chat-msg chat-msg-user"
            data-msg-index={e.msgIndex}
            data-live-user={e.liveId}
          >
            {e.images && e.images.length > 0 && (
              <div className="chat-user-images">
                {e.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt="发送的图片"
                  />
                ))}
              </div>
            )}
            {e.text && (
              <div className="chat-user-text" style={{ whiteSpace: "pre-wrap" }}>
                {e.text}
              </div>
            )}
          </div>,
        );
      } else if (e.t === "asstText") {
        flush();
        nodes.push(
          <div key={e.key} className="chat-msg chat-msg-assistant" data-msg-index={e.msgIndex}>
            <MarkdownText text={e.text} />
            {e.streaming && <span className="chat-cursor" />}
          </div>,
        );
      } else {
        buf.push(e);
      }
    }
    flush();
    // 窗口后面还有消息（跳转替换到较早页 / jsonl 增长）→ 尾部给显式入口
    if (histOffset + history.length < total) {
      nodes.push(
        <button
          key="more-later"
          className="viewer-load-more"
          onClick={() => void loadLater()}
        >
          <ArrowDownIcon size={12} /> 加载更晚的消息（还剩 {total - histOffset - history.length} 条）
        </button>,
      );
    }
    return nodes;
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="chat-head-body">
          <div className="viewer-title">{title}</div>
          {(total > 0 || (stats && stats.messageCount > 0)) && (
            <div className="viewer-stats">
              {total > 0 ? `${total} 条消息` : ""}
              {stats && stats.messageCount > 0 && (
                <>
                  {total > 0 ? " · " : ""}总计 {fmtTokens(stats.totalTokens)} · 输入{" "}
                  {fmtTokens(stats.inputTokens)} · 输出 {fmtTokens(stats.outputTokens)}
                  {stats.cacheReadTokens > 0 && ` · 缓存读取 ${fmtTokens(stats.cacheReadTokens)}`}
                </>
              )}
            </div>
          )}
        </div>
        <div className="chat-head-actions">
          {usage && usage.outputTokens + usage.inputTokens > 0 && (
            <span className="chat-usage">
              本次 {fmtTokens(usage.inputTokens + usage.outputTokens)} tok
            </span>
          )}
          {statusLabel && (
            <span className={`chat-status chat-status-${status.phase}`}>{statusLabel}</span>
          )}
          {session && (
            <>
              <button
                className={`icon-btn ${searchOpen ? "icon-btn-on" : ""}`}
                onClick={() => {
                  setSearchOpen((v) => !v);
                  setExportMenuOpen(false);
                }}
                title="搜索消息内容与工具调用"
              >
                <SearchIcon size={15} />
              </button>
              <button
                className={`icon-btn ${filesOpen ? "icon-btn-on" : ""}`}
                onClick={() => setFilesOpen((v) => !v)}
                title={`变更文件列表${changedFiles.length > 0 ? `（${changedFiles.length} 个）` : ""}`}
              >
                <FileIcon size={15} />
              </button>
              <div className="export-wrap">
                <button
                  className="icon-btn"
                  onClick={() => {
                    setExportMenuOpen((v) => !v);
                    setSearchOpen(false);
                  }}
                  title="导出会话（Markdown / JSONL）"
                >
                  <DownloadIcon size={15} />
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
                className="icon-btn"
                disabled={isBusy(status)}
                onClick={refreshHistory}
                title="重新读取会话记录（清空本页实时区，以 jsonl 为准）"
              >
                <RefreshIcon size={15} />
              </button>
            </>
          )}
        </div>
      </div>

      {searchOpen && session && (
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
            <XIcon />
          </button>
          {searchKeyword.trim() && searchResults && searchResults.length > 0 && (
            <div className="search-results">
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

      <div className="chat-main" ref={mainRef}>
        {railItems.length > 0 && (
          <div
            className="msg-rail"
            onMouseLeave={() => {
              setRailTip(null);
              setRailHover(null);
            }}
          >
            {railItems.map((item, i) => {
              // 波浪动效：悬停条最长，相邻条按距离递减（d0/d1/d2 三档）
              const d = railHover === null ? -1 : Math.abs(i - railHover);
              const wave = d === 0 ? "d0" : d === 1 ? "d1" : d === 2 ? "d2" : "";
              return (
                <button
                  key={item.key}
                  className={`msg-rail-tick ${wave} ${activePromptKey === item.key ? "active" : ""}`}
                  onClick={() =>
                    item.kind === "live"
                      ? jumpToLive(item.liveId)
                      : void jumpTo(item.index)
                  }
                  onMouseEnter={(e) => {
                    setRailHover(i);
                    openRailTip(item, e.currentTarget);
                  }}
                  aria-label={`定位到用户发言：${item.text}`}
                />
              );
            })}
          </div>
        )}
        <div className="chat-body" ref={bodyRef} onScroll={onChatScroll}>
          {historyLoading ? (
            <div className="viewer-empty">加载历史消息…</div>
          ) : history.length === 0 && items.length === 0 ? (
            <div className="viewer-empty">
              <div className="empty-icon">
                <MessageCircleIcon size={34} />
              </div>
              <div>{session ? "继续这个对话，输入第一条消息" : "输入消息，开始新对话"}</div>
              <div className="empty-sub">对话记录保存到 Claude Code 会话目录，终端里也能继续</div>
            </div>
          ) : (
            renderStream()
          )}
        </div>

        {railTip && (
          <div className="msg-rail-tip" style={{ top: railTip.top }}>
            <div className="msg-rail-tip-time">
              用户
              {railTip.item.kind === "history" && railTip.item.timestamp
                ? ` · ${formatTime(railTip.item.timestamp)}`
                : " · 本次对话"}
            </div>
            <div className="msg-rail-tip-text">{railTip.item.text}</div>
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
                        title={
                          f.msgIdx !== null
                            ? `${f.path}（点击定位）`
                            : `${f.path}（实时消息，暂不可定位）`
                        }
                        disabled={f.msgIdx === null}
                        onClick={() => f.msgIdx !== null && void jumpTo(f.msgIdx, f.blockIdx)}
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

      {permissions.length > 0 && (
        <div className="chat-permissions">
          {permissions.map((p) => (
            <div key={p.requestId} className="chat-perm">
              <div className="chat-perm-title">
                🔐 请求执行工具：<b>{p.toolName}</b>
              </div>
              <pre className="chat-perm-input">
                {p.input ? JSON.stringify(p.input, null, 2).slice(0, 2000) : ""}
              </pre>
              <div className="chat-perm-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => void respondPermission(p.requestId, true)}
                >
                  允许
                </button>
                <button className="btn" onClick={() => void respondPermission(p.requestId, false)}>
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {question && (
        // key 用 requestId：换一次提问就重挂载，卡内「当前第几题 / 逐题选择」自动归零
        <AskQuestionCard
          key={question.requestId}
          items={question.items}
          busy={questionBusy}
          onSubmit={(answers) => void respondQuestion(answers)}
          onCancel={() => void respondQuestion(null)}
          onDiscuss={discussQuestion}
        />
      )}

      {plan && (
        <div className="plan-approve">
          <div className="plan-approve-title">方案已就绪 · 计划模式</div>
          <div className="plan-approve-preview">
            {plan.text.trim() || "（本轮未捕获到方案正文，可直接在输入框提修改意见）"}
          </div>
          <div className="plan-approve-actions">
            <button
              className="btn btn-primary"
              disabled={planBusy}
              onClick={() => void respondPlan(true, "acceptEdits")}
              title="批准方案并退出计划模式；后续文件编辑自动放行"
            >
              批准并自动接受编辑
            </button>
            <button
              className="btn"
              disabled={planBusy}
              onClick={() => void respondPlan(true, "manual")}
              title="批准方案并退出计划模式；每个工具仍需手动确认"
            >
              批准，逐个确认
            </button>
            <button
              className="btn"
              disabled={planBusy}
              onClick={() => void respondPlan(false)}
              title="留在计划模式，在输入框提出修改意见"
            >
              继续修改
            </button>
          </div>
          <div className="plan-approve-hint">
            批准后退出计划模式并在本轮继续执行；点「继续修改」留在计划模式
          </div>
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="chat-attachments">
          {pendingImages.map((img, i) => (
            <div key={`${i}-${img.data.length}`} className="chat-attachment">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="待发送图片" />
              <button
                className="chat-attachment-remove"
                title="移除图片"
                onClick={() => setPendingImages((prev) => prev.filter((_, idx) => idx !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="chat-composer"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void addImages(Array.from(e.dataTransfer.files));
        }}
      >
        <select
          className="chat-mode"
          value={mode ?? ""}
          onChange={(e) => void changeMode(e.target.value)}
          title="权限模式（等价终端里的 Shift+Tab 切换）"
        >
          {mode === null && (
            <option value="" disabled hidden>
              读取配置…
            </option>
          )}
          {/* 配置了下拉之外的值（如 dontAsk）→ 以原始名动态加入显示 */}
          {mode !== null && !MODE_OPTIONS.some((o) => o.value === mode) && (
            <option value={mode} title="当前生效模式（来自 settings.json 配置）">
              {mode}
            </option>
          )}
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            status.phase === "exited"
              ? "进程已退出，返回后重新打开对话"
              : "输入消息，可粘贴/拖入图片；Enter 发送，Shift+Enter 换行"
          }
          value={input}
          rows={1}
          disabled={status.phase === "exited"}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPasteImages}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {isBusy(status) && plan?.source !== "native" ? (
          <button className="btn" onClick={() => void interrupt()} title="中断当前轮（等价 Esc）">
            <StopIcon />
            停止
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={(!input.trim() && pendingImages.length === 0) || status.phase === "exited"}
            onClick={() => void send()}
            title="发送消息"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
