// app 内直接对话层（Electron 后端）。
//
// 设计要点（与 v2.0.0 的 chat.rs 逐条对齐，但底层改用官方
// `@anthropic-ai/claude-agent-sdk` 而非手写的 CLI stdio 协议）：
// - 翻译层 `SdkMessageTranslator` 把 SDK 吐出的结构化 `SDKMessage` 翻成前端消费的
//   `ChatEvent`（字段映射逐字对齐 chat.rs 的 StreamAssembler）。
// - 进程托管 + 多会话 + 权限/方案审批/中断/图片，由 `ChatManager` + `ChatSession` 负责。
//
// ⚠️ ESM 与 CJS：本仓库主进程打成 CJS，SDK 是 ESM-first。所有运行时访问 SDK 都必须走
// 动态 `await import("@anthropic-ai/claude-agent-sdk")`（见 CLAUDE.md 第 4 条）；
// 顶层只用 `import type` 拿类型——它在编译期被擦除，不会进 esbuild 的 CJS bundle 导致炸。

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";

// 仅类型导入：编译期擦除，安全。
import type {
  Options,
  Query,
  SDKMessage,
  PermissionResult,
  PermissionMode,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

// 供单测直接构造 SDK 消息（类型只在编译期存在，不进 bundle）
export type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------- 前端事件协议（与 v2.0.0 src/types.ts 的 ChatEvent 逐字一致） ----------------

/** 粘贴/拖拽的图片附件（data 为 base64 裸数据，无 data: 前缀） */
export interface ChatImage {
  mediaType: string;
  data: string;
}

/** 权限模式（与官方 CLI --permission-mode 取值一致；manual 即 CLI 的 default） */
export type ChatPermissionMode =
  | "manual"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

/** 单条 assistant 消息的 token 用量 */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 后端经 IPC 推送给前端的流式事件（tag = type） */
export type ChatEvent =
  | { type: "session_ready"; sessionId: string; model?: string | null; permissionMode?: string | null }
  | { type: "status"; state: "thinking" | "idle" }
  | { type: "content_start"; kind: "text" | "thinking" }
  | { type: "delta"; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_use_complete"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "message_complete"; usage: ChatUsage }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_cancelled"; requestId: string }
  /** ExitPlanMode 方案审批：plan 为方案正文；应答 = allow（退出计划模式继续执行）/ deny（留在计划模式） */
  | { type: "plan_approval"; requestId: string; plan: string }
  | { type: "turn_end"; isError: boolean; resultText?: string | null; usage?: ChatUsage | null }
  | { type: "exited"; code: number | null; stderrTail?: string | null }
  | { type: "error"; message: string };

/** 前端对一条权限/方案/提问请求的应答（主代理从 IPC 收来后调 respondToPermission）。
 *  ⚠️ 这里**没有**「批准并自动接受编辑」档位：那种档位由前端在 allow 之后另发一条
 *  `chat_set_permission_mode` 完成（见 ChatView 的 respondPlan）。曾经本类型带过
 *  `acceptEdits?: boolean`，但契约与 main 进程都不传它，是个永不触发的死参数。 */
export type PermissionDecision =
  | {
      kind: "allow";
      /** AskUserQuestion 的选项答案：key = 题目**完整文本**（不是 header），多选逗号分隔。
       *  必须回传，否则等于「用户没选」——不报错但静默失效 */
      answers?: Record<string, string>;
      /** 用户没选选项、直接打字的自由文本（对应 AskUserQuestionOutput.response） */
      response?: string;
    }
  | { kind: "deny"; message: string };

/** 启动一个会话时的入参 */
export interface StartChatOptions {
  /** 项目绝对路径（CLI 的 cwd） */
  projectPath: string;
  /** 续聊的会话 id（与 sessionId 互斥；传了就走 --resume） */
  resumeId?: string;
  /** 初始权限模式；不传（undefined）则继承项目 settings 的 defaultMode（由 SDK 内部选项驱动） */
  initialMode?: ChatPermissionMode;
}

// ---------------- 常量 ----------------

/** 单图上限 4.5MB（CLAUDE.md 要求超限报错给前端） */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

/** 方案审批工具名：计划模式下 CLI 调它请求退出计划模式，方案正文在 input.plan */
const EXIT_PLAN_TOOL = "ExitPlanMode";

/** 提问工具名：答案必须经 updatedInput.answers 回传，否则静默失效 */
const ASK_TOOL = "AskUserQuestion";

const ZERO_USAGE: ChatUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

// ---------------- 权限模式映射 ----------------

/** v2.0.0 的 manual 等价于 CLI 的 default；其余原样。 */
export function toSdkPermissionMode(mode: ChatPermissionMode): PermissionMode {
  return mode === "manual" ? "default" : (mode as PermissionMode);
}

/** SDK 回报表里的 'default' 归一显示为 'manual'（前端下拉的「手动确认」）。 */
export function fromSdkPermissionMode(mode: string | null | undefined): ChatPermissionMode | null {
  if (!mode) return null;
  if (mode === "default") return "manual";
  return mode as ChatPermissionMode;
}

/** 把 settings 里的 permissions.defaultMode 字符串归一成 ChatPermissionMode；'default'→'manual'；缺失/非法→null */
export function normalizeDefaultMode(value: string | null | undefined): ChatPermissionMode | null {
  if (!value) return null;
  // CLI 的 "default" 在终端 UI 显示为「手动确认」，等价我们的 manual
  if (value === "default") return "manual";
  const valid: ChatPermissionMode[] = ["manual", "auto", "acceptEdits", "plan", "bypassPermissions", "dontAsk"];
  return valid.includes(value as ChatPermissionMode) ? (value as ChatPermissionMode) : null;
}

// ---------------- 解析类纯函数（可单测） ----------------

type Rec = Record<string, any>;

/** usage 防御式解析（数字字段为主；SDK 的 usage 是 BetaUsage 的 snake_case 形态） */
export function parseUsage(u: unknown): ChatUsage | null {
  if (!u || typeof u !== "object") return null;
  const v = u as Rec;
  const num = (k: string) => Number(v[k] ?? 0) || 0;
  return {
    // 同时容错 camelCase 与 snake_case（不同 SDK 版本字段命名可能漂移）
    inputTokens: num("input_tokens") || num("inputTokens"),
    outputTokens: num("output_tokens") || num("outputTokens"),
    cacheReadInputTokens: num("cache_read_input_tokens") || num("cacheReadInputTokens"),
    cacheCreationInputTokens: num("cache_creation_input_tokens") || num("cacheCreationInputTokens"),
  };
}

/** content 数组容错提取：数组原样 / 单对象包装成数组 / 缺失返回空（对齐 chat.rs block_list） */
function blockList(content: unknown): Rec[] {
  if (Array.isArray(content)) return content as Rec[];
  if (content && typeof content === "object") return [content as Rec];
  return [];
}

/** tool_result 的文本：content 可能是字符串，也可能是块数组（[{type:"text",text}]） */
function toolResultText(block: Rec): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

/**
 * control_request(can_use_tool) → 权限确认请求事件；
 * ExitPlanMode 单独走方案审批（否则会退化成把 {plan:"…"} 原样打成 JSON 的普通工具卡）。
 * 纯函数，供翻译层与 canUseTool 回调用同一份逻辑，保证事件形状一致。
 */
export function buildControlRequestEvent(
  requestId: string,
  toolName: string,
  input: unknown,
): ChatEvent {
  if (toolName === EXIT_PLAN_TOOL) {
    const plan =
      input && typeof input === "object" && typeof (input as Rec).plan === "string"
        ? ((input as Rec).plan as string)
        : "";
    return { type: "plan_approval", requestId, plan };
  }
  return { type: "permission_request", requestId, toolName, input };
}

/**
 * 权限/方案/提问请求的应答 → SDK 的 `PermissionResult`（纯函数，见配套单测）。
 *
 * ⚠️ `AskUserQuestion` 的答案**必须**经 `updatedInput.answers` 回传：只回
 * `{behavior:"allow"}` 不报错，但模型收到的是「问题已发出，但你没有选择任何选项」——
 * 静默失效、没有任何错误码（见 docs/agent-sdk-interactive-tools.md）。同一条路径上
 * `updatedInput.response`（用户不选选项、直接打字的自由文本）已实测生效。
 */
export function buildPermissionResult(
  toolName: string,
  input: Record<string, unknown>,
  decision: PermissionDecision,
): PermissionResult {
  if (decision.kind === "deny") return { behavior: "deny", message: decision.message };
  if (toolName !== ASK_TOOL) return { behavior: "allow" };

  const answers = decision.answers ?? {};
  const hasAnswers = Object.keys(answers).length > 0;
  const hasResponse = typeof decision.response === "string" && decision.response.length > 0;
  if (!hasAnswers && !hasResponse) {
    // 既没选选项也没打字：与其静默失效，不如明确拒绝——模型能据此重问一次
    return { behavior: "deny", message: "用户未选择任何选项" };
  }
  // 展开原 input 再覆盖：CLI 侧按 `question` 完整文本取答案，原 input 里的
  // questions 数组必须原样带上（用户答案优先于 input 里可能已有的同名字段）
  const updated: Record<string, unknown> = { ...input };
  if (hasAnswers) updated.answers = answers;
  if (hasResponse) updated.response = decision.response;
  return { behavior: "allow", updatedInput: updated };
}

/**
 * 拼一条 user 消息（文本 + 图片）。图片为 base64（PNG/JPEG/GIF/WebP）。
 * 单图 > 4.5MB 抛错（由调用方转成 error 事件报前端）；纯图无文本也允许。
 */
export function buildUserMessage(text: string | null, images: ChatImage[]): SDKUserMessage {
  const content: Rec[] = [];
  if (text && text.length > 0) content.push({ type: "text", text });
  for (const img of images) {
    const bytes = Buffer.from(img.data, "base64").length;
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(
        `图片过大（约 ${bytes} 字节），单图上限 ${MAX_IMAGE_BYTES} 字节，请压缩后重试`,
      );
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  if (content.length === 0) {
    throw new Error("消息不能为空：纯文本或至少一张图片");
  }
  return { type: "user", message: { role: "user", content } } as SDKUserMessage;
}

// ---------------- 翻译层（SdkMessageTranslator，纯逻辑可测） ----------------

/** 流式期间正在组装的内容块 */
interface PendingBlock {
  kind: string;
  toolUseId: string | null;
  toolName: string | null;
  /** text/thinking 累计文本，或 tool_use 的 partial_json 累计 */
  text: string;
}

/**
 * SDK 结构化消息 → ChatEvent 的翻译器（每会话一个，跨消息维护去重与流式状态）。
 * 与 chat.rs 的 StreamAssembler 逐字段对齐：完整 assistant 消息凭 message.id 去重、
 * stream_event 负责细粒度增量。
 */
export class SdkMessageTranslator {
  /** 已被流式渲染过的 assistant message.id——完整消息到达时只补 usage，不重复产内容 */
  private streamedMsgIds = new Set<string>();
  /** 当前消息流式中的内容块（key = content block index） */
  private blocks = new Map<number, PendingBlock>();

  translate(msg: SDKMessage): ChatEvent[] {
    const m = msg as unknown as Rec;
    switch (m.type) {
      case "system":
        return this.translateSystem(m);
      case "assistant":
        return this.translateAssistant(m);
      case "user":
        return SdkMessageTranslator.translateUser(m);
      case "stream_event":
        return this.translateStreamEvent(m);
      case "result":
        return translateResult(m);
      case "control_request":
        // 运行时 SDK 已把 can_use_tool 经 canUseTool 回掉消费、不会落到这里；
        // 此分支供单测与防御性使用，事件形状与 canUseTool 回调用同一份 buildControlRequestEvent。
        return [
          buildControlRequestEvent(
            String(m.request_id ?? ""),
            String((m.request as Rec)?.tool_name ?? ""),
            (m.request as Rec)?.input ?? {},
          ),
        ];
      case "control_cancel_request":
        return [{ type: "permission_cancelled", requestId: String(m.request_id ?? "") }];
      case "control_response": {
        // CLI 对我们 control_request 的回执：error 子类型要浮出给前端
        const resp = (m.response as Rec) ?? {};
        if (resp.subtype === "error") {
          return [{ type: "error", message: `CLI 拒绝请求：${String(resp.error ?? "未知原因")}` }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  private translateSystem(m: Rec): ChatEvent[] {
    if (m.subtype !== "init") return [];
    return [
      {
        type: "session_ready",
        sessionId: String(m.session_id ?? ""),
        model: m.model != null ? String(m.model) : null,
        // 实际生效的权限模式（跟随 settings.json 时的回显依据；CLI 报 'default' 即我们的 manual）
        permissionMode: m.permissionMode != null ? String(m.permissionMode) : null,
      },
    ];
  }

  private translateAssistant(m: Rec): ChatEvent[] {
    const message = m.message;
    if (!message || typeof message !== "object") return [];
    const msgId = String(message.id ?? "");
    const usage = parseUsage(message.usage);
    // 已流式渲染过 → 只补 usage，不重复产出内容
    if (msgId && this.streamedMsgIds.has(msgId)) {
      return [{ type: "message_complete", usage: usage ?? ZERO_USAGE }];
    }
    const events: ChatEvent[] = [];
    for (const b of blockList(message.content)) {
      const type = b.type;
      if (type === "text") {
        const text = String(b.text ?? "");
        if (text) {
          events.push({ type: "content_start", kind: "text" });
          events.push({ type: "delta", kind: "text", text });
        }
      } else if (type === "thinking") {
        const text = String(b.thinking ?? b.text ?? "");
        if (text) {
          events.push({ type: "content_start", kind: "thinking" });
          events.push({ type: "delta", kind: "thinking", text });
        }
      } else if (type === "tool_use") {
        events.push({
          type: "tool_use_start",
          toolUseId: String(b.id ?? ""),
          name: String(b.name ?? ""),
        });
        events.push({
          type: "tool_use_complete",
          toolUseId: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: b.input ?? {},
        });
      }
    }
    events.push({ type: "message_complete", usage: usage ?? ZERO_USAGE });
    return events;
  }

  private static translateUser(m: Rec): ChatEvent[] {
    const message = m.message;
    if (!message || typeof message !== "object") return [];
    const events: ChatEvent[] = [];
    for (const b of blockList(message.content)) {
      if (b.type !== "tool_result") continue;
      events.push({
        type: "tool_result",
        toolUseId: String(b.tool_use_id ?? ""),
        isError: Boolean(b.is_error),
        text: toolResultText(b),
      });
    }
    return events;
  }

  private translateStreamEvent(m: Rec): ChatEvent[] {
    const event = m.event;
    if (!event || typeof event !== "object") return [];
    switch (event.type) {
      case "message_start": {
        // 记录本条 assistant 消息 id：完整消息到达时据此去重
        const id = event?.message?.id;
        if (typeof id === "string" && id) this.streamedMsgIds.add(id);
        return [{ type: "status", state: "thinking" }];
      }
      case "content_block_start": {
        const index = Number(event.index ?? 0);
        const block = (event.content_block as Rec) ?? {};
        const kind = block.type;
        if (kind === "tool_use") {
          this.blocks.set(index, {
            kind: "tool_use",
            toolUseId: String(block.id ?? ""),
            toolName: String(block.name ?? ""),
            text: "",
          });
          return [{ type: "tool_use_start", toolUseId: String(block.id ?? ""), name: String(block.name ?? "") }];
        }
        if (kind === "text" || kind === "thinking") {
          this.blocks.set(index, { kind, toolUseId: null, toolName: null, text: "" });
          return [{ type: "content_start", kind }];
        }
        return [];
      }
      case "content_block_delta": {
        const index = Number(event.index ?? 0);
        const delta = (event.delta as Rec) ?? {};
        let kind: "" | "text" | "thinking" | "tool_input" = "";
        let text: string | undefined;
        if (delta.type === "text_delta") {
          kind = "text";
          text = delta.text;
        } else if (delta.type === "thinking_delta") {
          kind = "thinking";
          text = delta.thinking;
        } else if (delta.type === "input_json_delta") {
          kind = "tool_input";
          text = delta.partial_json;
        }
        const pending = this.blocks.get(index);
        if (pending && text) pending.text += text;
        if (!kind || text === undefined) return [];
        return [{ type: "delta", kind, text }];
      }
      case "content_block_stop": {
        const index = Number(event.index ?? 0);
        const pending = this.blocks.get(index);
        if (!pending) return [];
        this.blocks.delete(index);
        if (pending.kind !== "tool_use") return [];
        // 组装 input JSON（失败降级为空对象，tool_result 仍可凭 id 关联）
        let input: unknown = {};
        if (pending.text.trim()) {
          try {
            input = JSON.parse(pending.text);
          } catch {
            input = {};
          }
        }
        return [
          {
            type: "tool_use_complete",
            toolUseId: pending.toolUseId ?? "",
            name: pending.toolName ?? "",
            input,
          },
        ];
      }
      default:
        return [];
    }
  }
}

/** result → turn_end + idle（对齐 chat.rs translate_result） */
function translateResult(m: Rec): ChatEvent[] {
  const subtype = m.subtype;
  const isError =
    subtype === "error_max_turns" ||
    subtype === "error_during_execution" ||
    Boolean(m.is_error);
  return [
    {
      type: "turn_end",
      isError,
      resultText: m.result != null ? String(m.result) : null,
      usage: parseUsage(m.usage),
    },
    { type: "status", state: "idle" },
  ];
}

// ---------------- settings 默认权限档解析 ----------------

function readJsonFile(p: string): Rec | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Rec;
  } catch {
    return null;
  }
}

function readDefaultModeFromFile(p: string): ChatPermissionMode | null {
  const cfg = readJsonFile(p);
  if (!cfg) return null;
  const perms = cfg.permissions;
  if (perms && typeof perms === "object" && typeof (perms as Rec).defaultMode === "string") {
    return normalizeDefaultMode((perms as Rec).defaultMode);
  }
  return null;
}

/**
 * 解析项目初始权限档：优先级 **项目 settings.local.json > 项目 settings.json >
 * 用户级 ~/.claude/settings.json**；CLAUDE_CONFIG_DIR 优先于默认用户目录。
 * 未配置返回 null（表示跟随 CLI 默认，不传 --permission-mode）。
 */
export function defaultPermissionMode(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ChatPermissionMode | null {
  const localPath = path.join(projectPath, ".claude", "settings.local.json");
  const r1 = readDefaultModeFromFile(localPath);
  if (r1) return r1;
  const projPath = path.join(projectPath, ".claude", "settings.json");
  const r2 = readDefaultModeFromFile(projPath);
  if (r2) return r2;
  // 用户级：CLAUDE_CONFIG_DIR 优先
  const cfgDir = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  const home = cfgDir || (platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "");
  const userPath = path.join(home, ".claude", "settings.json");
  return readDefaultModeFromFile(userPath);
}

// ---------------- 定位真实的 Claude Code 可执行文件 ----------------

/**
 * 跟随本机 Claude Code：实测只有 `<claude-code>/bin/claude.exe` 能跑
 * （无扩展名 shim 会 failed to launch、claude.cmd 会 spawn EINVAL）。
 * 找不到就返回 undefined —— 上层不传 pathToClaudeCodeExecutable，SDK 用自带的 claude.exe。
 */
export function findClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const binName = platform === "win32" ? "claude.exe" : "claude";
  const probe = (prefix: string): string | undefined => {
    if (!prefix) return undefined;
    const p = path.join(prefix, "@anthropic-ai", "claude-code", "bin", binName);
    return fs.existsSync(p) ? p : undefined;
  };
  // ① 开发目录：node_modules 里装了 claude-code 时直接命中
  const local = probe(path.join(process.cwd(), "node_modules"));
  if (local) return local;
  // ② 全局 npm 安装目录。⚠️ Windows 上必须带 `shell: true`：npm 是 npm.cmd，
  // execFileSync 不启 shell 时连命令都找不到（实测 `spawnSync npm ENOENT`），错误被
  // 下面的 catch 吞掉后这条分支**等于不存在**——「跟随本机 Claude Code」会静默退化成
  // SDK 自带的那份 claude.exe。参数是常量，走 shell 没有注入面。
  try {
    const prefix = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      shell: platform === "win32",
    }).trim();
    const global = probe(prefix);
    if (global) return global;
  } catch {
    // 忽略：回退到 SDK 自带可执行文件
  }
  return undefined;
}

// ---------------- 进程托管（ChatSession / ChatManager） ----------------

/** 用户消息队列：作为 SDK query 的 prompt（AsyncIterable），不结束则进程常驻等待输入 */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolveNext: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  push(msg: SDKUserMessage): void {
    if (this.done) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    this.done = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift() as SDKUserMessage, done: false });
    }
    if (this.done) {
      return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
    return new Promise((resolve) => {
      this.resolveNext = resolve;
    });
  }
}

/** 一个活跃对话（对应一个 CLI 子进程；懒启动：首条 send 才 spawn） */
class ChatSession {
  private id: string;
  private projectPath: string;
  private resumeId?: string;
  private explicitMode: ChatPermissionMode | null;
  private emit: (e: ChatEvent) => void;

  private queue = new MessageQueue();
  private translator = new SdkMessageTranslator();
  private abort = new AbortController();
  private query: Query | undefined;
  private child: SpawnedProcess | undefined;
  /** 启动中的 promise（并发 send 共用同一次启动；失败时清空以便重试） */
  private starting: Promise<void> | null = null;
  private exited = false;

  /** 进程是否已退出（ChatManager.send 据此拒绝往死会话里塞消息） */
  hasExited(): boolean {
    return this.exited;
  }
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();

  constructor(id: string, opts: StartChatOptions, emit: (e: ChatEvent) => void) {
    this.id = id;
    this.projectPath = opts.projectPath;
    this.resumeId = opts.resumeId;
    this.explicitMode = opts.initialMode ?? null;
    this.emit = emit;
  }

  /**
   * 首条消息才真正 spawn 会话（懒启动）。
   * ⚠️ 失败必须可重试：早先「先置 started 再 await」，一次失败（模块解析不上、
   * SDK 起不来）之后这个会话就永久哑掉——ensureStarted 立刻 return、消息进队列
   * 无人消费，而 chat_send 的 IPC 还照常返回成功，用户看到「发消息毫无反应」。
   * 现在以 `this.query` 为成功标志，`starting` 兼作并发去重（两次并发 send 共用同一次启动）。
   */
  async ensureStarted(): Promise<void> {
    if (this.query) return;
    if (this.starting) return this.starting;
    const p = this.start();
    this.starting = p;
    try {
      await p;
    } catch (e) {
      this.starting = null; // 允许重试（下一次 send 会重新起进程）
      throw e;
    }
  }

  private async start(): Promise<void> {
    // 动态 import：SDK 是 ESM-first，主进程打成 CJS，不能用顶层静态 import（会进 bundle 炸）。
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const options: Options = {
      cwd: this.projectPath,
      // 传 canUseTool 会让 SDK 自动补 --permission-prompt-tool stdio，
      // 从而让 ExitPlanMode / AskUserQuestion 经此回调下发（CLAUDE.md 第 1 条）。
      canUseTool: (toolName, input, o) => this.handleCanUseTool(toolName, input, o),
      includePartialMessages: true,
      // ⚠️ 不传 settingSources（更不能传 []）：传 [] 是 SDK isolation 模式，会连认证一起丢
      // （实测报 Not logged in）。不传 = CLI 用自身默认（user+project+local）。
      abortController: this.abort,
      spawnClaudeCodeProcess: (o: SpawnOptions) => this.spawnProcess(o),
    };

    if (this.explicitMode) {
      // 用户改选过权限档 → 显式传 flag
      options.permissionMode = toSdkPermissionMode(this.explicitMode);
    } else {
      // 未显式指定 → 继承项目 settings 的 defaultMode。
      // ⚠️ 内部选项（sdk.d.ts 未声明、但 sdk.mjs 实现了）：不置 true 会被 SDK 强制
      // --permission-mode default，压过 settings 的 permissions.defaultMode。
      // @ts-expect-error 内部选项：sdk.d.ts 未声明，但 sdk.mjs 实现了。
      options.resolvePermissionModeInCli = true;
    }

    if (this.resumeId) {
      options.resume = this.resumeId;
    } else {
      options.sessionId = this.id;
    }

    // 「跟随本机 Claude Code」：指向用户自己那个 claude 可执行文件，这样 app 内对话
    // 与终端跑的是同一个 CLI、同一份配置。⚠️ 只能指真实可执行文件——实测 npm 的无扩展名
    // shim 会 `failed to launch`、`claude.cmd` 会 `spawn EINVAL`（SDK 不启 shell）。
    // 找不到就**不传**，SDK 回退它自带的 claude-agent-sdk-win32-x64/claude.exe。
    const userClaude = findClaudeExecutable();
    if (userClaude) options.pathToClaudeCodeExecutable = userClaude;

    const q = sdk.query({ prompt: this.queue, options });
    this.query = q;
    void this.iterate(q);
  }

  /** 用 SDK 算好的 command/args 自己 spawn，以便拿到子进程句柄监听退出（emit exited） */
  private spawnProcess(o: SpawnOptions): SpawnedProcess {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      signal: o.signal,
      // 与全仓其它 spawn 一致：Windows 上不加这个会为控制台子进程另开一个窗口
      windowsHide: true,
    });
    child.on("exit", (code) => this.onExit(code ?? null));
    this.child = child as unknown as SpawnedProcess;
    return this.child;
  }

  private onExit(code: number | null): void {
    this.emitExited(code);
  }

  private emitExited(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit({ type: "exited", code, stderrTail: null });
  }

  private async iterate(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        const events = this.translator.translate(msg);
        for (const e of events) this.emit(e);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", message });
    } finally {
      // 生成器结束（进程退出 / stdin EOF）兜底补 exited
      this.emitExited(this.child?.exitCode ?? null);
    }
  }

  enqueue(msg: SDKUserMessage): void {
    this.queue.push(msg);
  }

  /** 权限确认回调：推事件给前端卡片 → 等前端应答 → 返回 {behavior:"allow"} / {behavior:"deny"} */
  private async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<PermissionResult> {
    const requestId = options.requestId;
    // 复用翻译层的分流逻辑：ExitPlanMode 走方案审批卡，否则普通权限卡
    this.emit(buildControlRequestEvent(requestId, toolName, input));

    // 原生请求会一直阻塞在 control 协议上、不会超时，所以每条都必须有应答：
    // 用 Promise 一直等前端 respondToPermission（切走计划模式 / 卡在场时发消息也会补 deny）。
    // 注意：请求被 CLI 撤销（interrupt → control_cancel_request）时这条 promise **不会**
    // 被 resolve，SDK 紧接着会把 cancel 事件转发给前端收卡；此处留下的待定 promise
    // 只占一次内存，不会阻塞消息泵（SDK 对 control_request 是 fire-and-forget）。
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
    });
    this.pendingPermissions.delete(requestId);

    return buildPermissionResult(toolName, input, decision);
  }

  /** 前端应答（主代理从 IPC 转来） */
  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const r = this.pendingPermissions.get(requestId);
    if (r) r(decision);
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  async setPermissionMode(mode: ChatPermissionMode): Promise<void> {
    this.explicitMode = mode;
    await this.query?.setPermissionMode(toSdkPermissionMode(mode));
  }

  async rename(title: string): Promise<void> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await sdk.renameSession(this.id, title, { dir: this.projectPath });
  }

  /** 优雅关：先结束输入（stdin EOF 让 CLI 优雅退出），超时由 SDK 强杀 */
  close(): void {
    this.queue.end();
    this.abort.abort();
  }
}

/** 全部活跃对话（多 tab 并行：切 tab 不中断流、后台继续流式；同一会话不允许开两个进程） */
export class ChatManager {
  private sessions = new Map<string, ChatSession>();

  /** emit：每条事件推给前端的回调（由主代理注入，内部已按 sessionId 绑定） */
  constructor(private emit: (sessionId: string, event: ChatEvent) => void) {}

  /** 建会话对象（懒启动：此时不启进程，首条 send 才 spawn） */
  start(sessionId: string, opts: StartChatOptions): void {
    if (this.sessions.has(sessionId)) return; // 同一会话不允许开两个进程
    const session = new ChatSession(sessionId, opts, (e) => this.emit(sessionId, e));
    this.sessions.set(sessionId, session);
  }

  /** 发送一条消息（文本 + 可选图片；text 为 "" 即纯图消息）。懒启动进程；图片超限转 error 事件报前端。
   *  启动失败会**抛出**（IPC 层转成 reject 让前端提示），不会静默丢掉这条消息。 */
  async send(sessionId: string, text: string, images?: ChatImage[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emit(sessionId, { type: "error", message: "会话不存在" });
      return;
    }
    // 进程已退出：再发就是往一条没人消费的队列里塞（chat_send 还会照常返回成功）。
    // 前端在 exited 态本来就不让发，这里是兜住竞态：报错比静默丢消息好。
    if (session.hasExited()) {
      throw new Error("会话进程已退出，请重新打开对话");
    }
    let userMsg: SDKUserMessage;
    try {
      userMsg = buildUserMessage(text, images ?? []);
    } catch (e) {
      this.emit(sessionId, { type: "error", message: (e as Error).message });
      return;
    }
    await session.ensureStarted();
    session.enqueue(userMsg);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.interrupt();
  }

  async setPermissionMode(sessionId: string, mode: ChatPermissionMode): Promise<void> {
    await this.sessions.get(sessionId)?.setPermissionMode(mode);
  }

  /** 前端对权限/方案审批的应答 */
  respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(sessionId)?.resolvePermission(requestId, decision);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.sessions.get(sessionId)?.rename(title);
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.close();
      this.sessions.delete(sessionId);
    }
  }

  /** 关闭全部（app 退出时：关 stdin 优雅退出，超时由 SDK 强杀） */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
