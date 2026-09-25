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
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
// 起名失败退回兜底标题时与列表同一口径（首条消息的清洗规则）
import { cleanSummary, extractXmlTag } from "./text";

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

/** `Query.supportedModels()` 的精简条目（渲染层在 src/types.ts 有同形副本）。
 *  resolvedModel 保留大小写原样：探针实测 default 槽解析成 `glm-5.3[1m]`、
 *  opus 槽解析成 `glm-5.3[1M]`，1M 标记的大小写即两者之别，不能归一化。 */
export interface ChatModelInfo {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  description: string;
}

/** `Query.supportedCommands()` 的精简条目（渲染层在 src/types.ts 有同形副本） */
export interface ChatCommandInfo {
  name: string;
  description: string;
  argumentHint: string | null;
  aliases: string[];
  builtin: boolean;
}

/** `Query.rewindFiles()` 的归一化结果。dryRun 给全量预览（filesChanged/增删行数），
 *  真回滚只回 canRewind + skippedLinks —— 两条口径不同是 CLI 的设计（探针实测，
 *  docs/agent-sdk-capabilities.md §6.10），UI 要展示「将回滚哪些」必须先跑 dryRun。
 *  `error` 必须透传：`canRewind:false` 有两种成因（本来就没有可回滚的改动 / 回滚真的
 *  失败了——d.ts 写着「每个有差异的文件都还原失败时回滚本身失败」），不看 error 就会把
 *  「失败」报成「没有改动」，用户拿不到任何线索（2026-09-24 code review 发现）。 */
export interface ChatRewindResult {
  canRewind: boolean;
  filesChanged: string[] | null;
  insertions: number | null;
  deletions: number | null;
  skippedLinks: number;
  error: string | null;
}

/** 后端经 IPC 推送给前端的流式事件（tag = type）
 *  ⚠️ 这份声明与 `src/types.ts` 的 ChatEvent 是**两份**（主进程不引渲染层的类型），
 *  加字段时两边都要改，否则这边编译过、那边类型对不上。 */
export type ChatEvent =
  | {
      type: "session_ready";
      sessionId: string;
      model?: string | null;
      permissionMode?: string | null;
      /** init.effort（低/中/高/极高/最高）。CLI 只在 Remote Control 类宿主上发，取不到为 null */
      effort?: string | null;
    }
  /** 新会话由 CLI 生成的 AI 标题（`ai-title` 行落盘后下发，见 ChatSession.generateTitle）。
   *  TUI 里这条是 CLI 自己起的名；SDK 宿主（本 app）得主动问，不问就只剩「首条用户消息」
   *  那一档兜底标题。 */
  | { type: "session_title"; title: string }
  | { type: "status"; state: "thinking" | "idle" }
  /** CLI 实际生效的权限模式变了（system/status 帧带 permissionMode 时下发）。
   *  进/出计划模式就靠它同步底部那个模式选择器：CLI 在 EnterPlanMode / ExitPlanMode
   *  生效的**同一刻**发这帧（2026-09-22 探针实测），只关心 status/init 不带的那部分
   *  （status:'requesting' 那类帧 permissionMode 为 undefined）。 */
  | { type: "permission_mode"; mode: string }
  /** `/xxx` 斜杠命令的生命周期（`command_lifecycle` 帧）。CLI 对**任何以 `/` 开头的
   *  用户消息**都发这一对（实测连 `/status` 这种在本环境不可用的命令也发）：
   *  `queued` → `started`，**没有终态** —— 结束只能由 result/turn_end 推断。
   *  ⚠️ 帧里只有 command_uuid、**没有命令名**：名字要由前端拿自己刚发出去的文本对上。
   *  它是「命令整轮跑在子代理里、主流长时间静默」时唯一能渲染的依据：2026-09-25 探针实测，
   *  一次 `/code-review` 的 82 秒里主流只剩这类帧 + 下面 task_* 心跳，其余全空
   *  （此前这两类都被 translate 的 default 分支静默丢弃 → 界面看起来是卡死）。 */
  | { type: "command_state"; state: string }
  /** 本地命令的**输出正文**（`system` + subtype:"local_command" 的 `<local-command-stdout>`）。
   *  `/code-review` 这类 CLI 自带实现整轮不经过模型：结果就是这条 stdout（实测 3996 字符的
   *  findings 全在里面），母会话 jsonl 里既没有 assistant 消息、也没有任何 ReportFindings
   *  tool_use。⚠️ 与历史侧 sessions.ts 的 parseSessionMessages 成对补 —— 只补一边就会出现
   *  「活视图有、resume 没有」那种不对称（2026-09-25 用户实测报的就是它）。 */
  | { type: "command_output"; text: string }
  /** 子代理活动心跳（`system/task_started|task_progress|task_updated|task_notification`）。
   *  载荷按「拿不到就不给」处理——不同任务类型发的字段不一样（见 sdk.d.ts），别补默认值。 */
  | {
      type: "subagent_activity";
      phase: "started" | "progress" | "done";
      /** 已用工具数 / 已跑毫秒（task_progress 的 usage；task_updated 不带） */
      toolUses?: number | null;
      durationMs?: number | null;
      /** 最后一个工具名（task_progress.last_tool_name） */
      lastTool?: string | null;
      /** 终态：completed / failed / stopped / killed…（notification.status 或 patch.status） */
      status?: string | null;
      /** 一句话摘要（progress / notification 的 summary） */
      summary?: string | null;
    }
  /** 上下文占用（getContextUsage 的读数）；init 一到与每轮结束各推一次。
   *  送**原始数字**而不是 API 的 percentage —— 那个字段的单位（0-100 / 0-1）没验过 */
  | { type: "context_usage"; usedTokens: number; windowTokens: number; model?: string | null }
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
  | {
      type: "turn_end";
      isError: boolean;
      resultText?: string | null;
      /** 本轮（非累计）用量 */
      usage?: ChatUsage | null;
      /** 主模型的上下文窗口，做「已用上下文 %」的分母；取不到为 null */
      contextWindow?: number | null;
    }
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
  // uuid：rewindFiles 的锚点（探针实测客户端 uuid 会落盘进链、CLI 在 result 帧上原样
  // 回显 user_message_uuid）。SDKUserMessage 类型没声明这个字段——又一处运行时认、
  // d.ts 没写的内部面（与 generateSessionTitle 同类），靠这个 as 塞进去。
  return {
    type: "user",
    message: { role: "user", content },
    uuid: randomUUID(),
  } as SDKUserMessage;
}

/** 起名用的描述文本（`generate_session_title` 的 `description`）：只有**新建会话**的
 *  第一条非空文本才算数。
 *  · 续聊/历史会话返回 null（不补标题）：它们该有自己的标题，不该拿这次说的话重起一个。
 *  · 纯图消息（text 为 ""）返回 null，拿不到可读描述——CLI 自己的 TUI 路径也跳过这类。
 *  · 截断到 400 字：描述只喂给起名那次调用，首条消息黏一大段日志进去没必要（与
 *    sessions.ts 的 last-prompt 截断、toolSummaryLine 的 clip 同一思路）。 */
export const TITLE_DESCRIPTION_MAX = 400;

export function titleDescriptionFor(
  resumeId: string | undefined,
  firstPromptText: string | null,
): string | null {
  if (resumeId) return null;
  const t = (firstPromptText ?? "").trim();
  if (t === "") return null;
  return t.length > TITLE_DESCRIPTION_MAX ? t.slice(0, TITLE_DESCRIPTION_MAX) : t;
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
  /** 最近一次下发给前端的权限模式（去重用）：CLI 每轮开头都会发 init、每次状态翻转
   *  都可能发 status，只有真变了才值得推一条事件给前端 setState */
  private lastMode: string | null = null;

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
      case "command_lifecycle":
        // `/xxx` 命令的生命周期（queued → started，无终态）。见 ChatEvent 里那段注释：
        // 这是命令跑在子代理里时主流的唯一可渲染依据，别再让它落进 default 被丢掉。
        return [{ type: "command_state", state: String(m.state ?? "") }];
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
    // 子代理活动心跳：命令型技能（/code-review、/verify 那类）整轮跑在子代理里，
    // 主流只发这几帧。丢掉它们的后果就是整段执行期界面完全静默、看起来像卡死
    // （2026-09-25 探针实测：82 秒里只有它们）。放在 status 之前——两者 subtype 不重叠。
    if (typeof m.subtype === "string" && m.subtype.startsWith("task_")) {
      return [taskActivity(m)];
    }
    // 本地命令的输出（`/code-review` 这类）：正文在 `<local-command-stdout>` 里。
    // 与历史侧 sessions.ts 的 parseSessionMessages 成对，见 ChatEvent.command_output 的注释
    if (m.subtype === "local_command") {
      const raw = m.content != null ? String(m.content) : "";
      const body = extractXmlTag(raw, "local-command-stdout");
      return body !== null && body.trim() !== "" ? [{ type: "command_output", text: body }] : [];
    }
    // status 帧：CLI 把「模式变了」压在它上面（permissionMode 字段）。进计划模式、
    // 批准 ExitPlanMode 退出计划模式时，这帧与工具结果同刻到达——底部模式选择器
    // 就靠它跟手。status:'requesting' 那类帧不带该字段，故有才认。
    // 去重放这里而不是前端：init 每轮开头都发、status 每次状态翻转都发，多数是重复值。
    if (m.subtype === "status") {
      const mode = m.permissionMode != null ? String(m.permissionMode) : null;
      if (mode && mode !== this.lastMode) {
        this.lastMode = mode;
        return [{ type: "permission_mode", mode }];
      }
      return [];
    }
    if (m.subtype !== "init") return [];
    const mode = m.permissionMode != null ? String(m.permissionMode) : null;
    this.lastMode = mode; // 记下基线：与 init 同值的 status 帧不再重复下发
    return [
      {
        type: "session_ready",
        sessionId: String(m.session_id ?? ""),
        model: m.model != null ? String(m.model) : null,
        // 实际生效的权限模式（跟随 settings.json 时的回显依据；CLI 报 'default' 即我们的 manual）
        permissionMode: mode,
        // 思考强度。SDK 文档说这个字段只在 Remote Control 类宿主的 init 帧上出现，
        // SDK 宿主可能拿不到 —— 拿不到就是 null，前端据此不显示，别编默认值
        effort: m.effort != null ? String(m.effort) : null,
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
      contextWindow: contextWindowOf(m),
    },
    { type: "status", state: "idle" },
  ];
}

/** `system/task_*` → 一条子代理活动心跳。
 *  字段一律「拿不到就不给」：SDK d.ts 写明不同任务类型发的字段不同（task_progress 才有
 *  usage/last_tool_name，task_notification 才有 status/summary，task_updated 只有 patch），
 *  所以缺了就是 null，绝不补默认值 —— 补了会让「没数据」看起来像「数据是 0」。 */
function taskActivity(m: Rec): ChatEvent {
  const usage = (m.usage as Rec) ?? {};
  const patch = (m.patch as Rec) ?? {};
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const phase: "started" | "progress" | "done" =
    m.subtype === "task_started" ? "started" : m.subtype === "task_notification" ? "done" : "progress";
  const status =
    m.status != null ? String(m.status) : patch.status != null ? String(patch.status) : null;
  const summary = m.summary != null ? String(m.summary) : null;
  return {
    type: "subagent_activity",
    phase,
    toolUses: num(usage.tool_uses),
    durationMs: num(usage.duration_ms),
    lastTool: m.last_tool_name != null ? String(m.last_tool_name) : null,
    status,
    // 摘要可能很长（notification 的 summary 是模型写的一句话）；截断免得事件体撑爆
    summary: summary != null && summary.length > 200 ? summary.slice(0, 200) : summary,
  };
}

/** 主模型的上下文窗口（给「已用上下文 %」做分母）。
 *  modelUsage 是按模型字符串分组的：子代理/内部调用（如压缩、权限分类器）可能各占一条，
 *  所以取 input 用量最大的那条 —— 主循环的输入量必然压过它们；都没有就返回 null。 */
function contextWindowOf(m: Rec): number | null {
  const raw = m.modelUsage;
  if (!raw || typeof raw !== "object") return null;
  let best: Rec | null = null;
  for (const u of Object.values(raw as Record<string, Rec>)) {
    if (!u || typeof u !== "object") continue;
    if (best === null || Number(u.inputTokens ?? 0) > Number(best.inputTokens ?? 0)) best = u;
  }
  const n = Number(best?.contextWindow ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
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

/** 探测结果缓存：整个进程只探一次（一条会话起一次就有两次同步子进程调用，不该每个
 *  tab 都付）。找不到也缓存 undefined，否则每开一个 tab 都要白等一轮超时。 */
let claudeExeCache: { path: string | undefined } | null = null;

/** 清缓存（单测用） */
export function resetClaudeExecutableCache(): void {
  claudeExeCache = null;
}

/**
 * 从 `where claude`（Windows）/ `command -v claude`（macOS）的输出里挑出**能真跑**的那个。
 * ⚠️ 实测：SDK 不启 shell，指到 npm 垫片上必失败（无扩展名 sh 垫片 `failed to launch`、
 * `claude.cmd` `spawn EINVAL`），所以垫片要顺着同级 `node_modules` 找背后真正的
 * `bin/claude.exe`；找不到真身就跳过该候选，而不是把垫片交出去。
 * macOS 上直接采信候选路径（内核按 shebang 执行，与 v2.0.0 / v1.0.0 同做法，**未在真机验证**）。
 */
export function pickClaudeFromPathOutput(
  stdout: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | undefined {
  const binName = platform === "win32" ? "claude.exe" : "claude";
  for (const raw of stdout.split(/\r?\n/)) {
    const cand = raw.trim();
    if (cand === "" || !exists(cand)) continue;
    if (/\.exe$/i.test(cand)) return cand; // 原生安装的 claude.exe，直接用
    if (platform !== "win32") return cand;
    // Windows 的 .cmd / .bat / 无扩展名 shim → 找同级的真身
    const sibling = path.join(
      path.dirname(cand),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      binName,
    );
    if (exists(sibling)) return sibling;
  }
  return undefined;
}

/**
 * 跟随本机 Claude Code：实测只有真实可执行文件能跑（见 pickClaudeFromPathOutput 的注释）。
 * 找不到就返回 undefined —— 上层 start() 据此抛可读错误（requireLocalClaudeExecutable），
 * 不再有「回退 SDK 自带 claude.exe」这条路（安装包已不带它，见 NO_LOCAL_CLAUDE_MESSAGE）。
 */
export function findClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (claudeExeCache) return claudeExeCache.path;
  claudeExeCache = { path: resolveClaudeExecutable(platform) };
  return claudeExeCache.path;
}

/** 本机探测不到 claude 时 start() 抛出的报错文案（导出供单测断言）。
 *  2026-09-23 起安装包不再携带 SDK 平台包自带的 claude.exe（237MB 死重、版本冻结在
 *  打包时刻越来越旧），「找不到就静默回退旧引擎」不复存在——必须明确失败。与内嵌
 *  终端 tab、健康检查同一口径：全 app 只认本机这一份引擎。 */
export const NO_LOCAL_CLAUDE_MESSAGE =
  "未找到本机 Claude Code，无法开始对话。请先安装 Claude Code（顶栏健康检查可查看状态），然后重试发送。";

/** start() 专用：本机 claude 探测结果为空即抛可读错误（chat_send reject → 前端 toast，
 *  可重试）。入参是探测结果而非函数，纯函数可直接单测。 */
export function requireLocalClaudeExecutable(found: string | undefined): string {
  if (!found) throw new Error(NO_LOCAL_CLAUDE_MESSAGE);
  return found;
}

/** 真正的探测（结果由 findClaudeExecutable 缓存）。顺序按「跟随本机」的权威性排：
 *  ① PATH 上的 claude（用户在终端里跑的那个；官方原生安装也走这条）
 *  ② 开发目录的 node_modules（本仓库自己装了 claude-code 时）
 *  ③ npm 全局根（npm 的 bin 目录不在 PATH 时的兜底） */
function resolveClaudeExecutable(platform: NodeJS.Platform): string | undefined {
  const binName = platform === "win32" ? "claude.exe" : "claude";
  const probe = (prefix: string): string | undefined => {
    if (!prefix) return undefined;
    const p = path.join(prefix, "@anthropic-ai", "claude-code", "bin", binName);
    return fs.existsSync(p) ? p : undefined;
  };
  // ① PATH 探测。此前没有这一步，只猜下面两处目录——官方原生安装（如
  // %USERPROFILE%\.local\bin\claude.exe）一律找不到，当时只能**静默**退化成 SDK 自带
  // 那份（该回退已于 2026-09-23 移除，见 requireLocalClaudeExecutable）。
  try {
    const out =
      platform === "win32"
        ? execFileSync("where", ["claude"], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          })
        : execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8", timeout: 3000 });
    const picked = pickClaudeFromPathOutput(out, platform);
    if (picked) return picked;
  } catch {
    // 不在 PATH / 超时 → 继续走后面的兜底
  }
  // ② 开发目录：node_modules 里装了 claude-code 时直接命中
  const local = probe(path.join(process.cwd(), "node_modules"));
  if (local) return local;
  // ③ 全局 npm 安装目录。⚠️ Windows 上必须带 `shell: true`：npm 是 npm.cmd，
  // execFileSync 不启 shell 时连命令都找不到（实测 `spawnSync npm ENOENT`），错误被
  // 下面的 catch 吞掉后这条分支**等于不存在**。参数是常量，走 shell 没有注入面。
  try {
    const prefix = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 3000,
      shell: platform === "win32",
      windowsHide: true,
    }).trim();
    const global = probe(prefix);
    if (global) return global;
  } catch {
    // 忽略：三条都没命中由末尾统一返回 undefined（上层 start() 报可读错误）
  }
  // 三条都没命中 → undefined，调用方（start() → requireLocalClaudeExecutable）抛可读错误。
  // 旧版在这里「留一行日志然后静默回退 SDK 自带那份」——2026-09-23 起安装包不携带
  // SDK 平台包，回退的路不存在了，报错移到真正失败的发送路径上（前端有 toast）。
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

  /** 撤掉尚未被 SDK 当 prompt 取走的消息，返回撤掉的条数。
   *  用途：用户刚发出就按停止 —— 那条消息还压在队列里，撤回它才算真的「没发出去」；
   *  对已经被取走、正在跑的那一轮，只能靠 query.interrupt() 中断。 */
  withdraw(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    return n;
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

/** 关会话时的优雅退出窗口：先关 stdin 让 CLI 收尾（把 jsonl 写完），超时才强杀。
 *  对齐 v2.0.0 的 `wait_then_kill(child, 3s)`。 */
const GRACEFUL_CLOSE_MS = 3000;
/** app 退出时整体等待上限（各会话并行关；超时后统一强杀，不能让退出被卡住的子进程拖住） */
const GRACEFUL_QUIT_MS = 3000;

/** 一个活跃对话（对应一个 CLI 子进程；懒启动：首条 send 才 spawn） */
class ChatSession {
  private id: string;
  private projectPath: string;
  private resumeId?: string;
  /** 本 sitting 第一条非空用户文本（新建会话的 AI 标题拿它当描述；续聊不记） */
  private firstPromptText: string | null = null;
  /** 标题只问一次：init 每轮开头都发（session_ready 每轮都会有），不问一次就每轮起一次名 */
  private titleAsked = false;
  /** 正在起名（发出去到结果回来之间为真）。`list_sessions` 据此把这条会话从列表里滤掉：
   *  它此刻的标题还只是「首条用户消息」那档兜底，显示了会先闪一下完整首条消息、再被
   *  CLI 起的名字替换（2026-09-22 用户实测反馈）。 */
  private titlePending = false;
  private explicitMode: ChatPermissionMode | null;
  private emit: (e: ChatEvent) => void;

  private queue = new MessageQueue();
  private translator = new SdkMessageTranslator();
  private abort = new AbortController();
  private query: Query | undefined;
  /** 用户已要求中断、但进程还没起来时先记下（见 interrupt / deliver） */
  private interruptRequested = false;
  /** 正卡在 ensureStarted 上的 deliver 条数：只有 >0 时 interrupt 才记账，
   *  否则空闲时按停止会把 flag 留在那儿、把下一次发送误吞 */
  private delivering = 0;
  private child: SpawnedProcess | undefined;
  /** 启动中的 promise（并发 send 共用同一次启动；失败时清空以便重试） */
  private starting: Promise<void> | null = null;
  private exited = false;
  /** 等进程退出的回调（close 的优雅退出窗口用） */
  private exitWaiters: Array<() => void> = [];
  /** 最近一个**完整结束的轮次**的起点用户消息 uuid（rewindFiles 的锚点）。
   *  从 result 帧的 user_message_uuids **首位**取（= 本轮消费的第一条用户消息，
   *  即这一轮开始动手之前），只在轮次收尾时更新。 */
  private lastTurnUserUuid: string | null = null;

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
      // 文件检查点：每条用户消息在 ~/.claude/file-history/<id>/@vN 落一份快照，
      // rewindFiles 靠它做「撤销本轮改动」（与 CLI /rewind 同一快照仓）。开销是
      // 每轮一次快照记账——CLI 自己在 TUI 里也恒开，可接受（探针见 §6.10）。
      enableFileCheckpointing: true,
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
    // 找不到就抛可读错误（requireLocalClaudeExecutable）——安装包不携带 SDK 自带的
    // claude.exe，没有可回退的引擎，报错让用户去装（健康检查可看状态）。
    options.pathToClaudeCodeExecutable = requireLocalClaudeExecutable(findClaudeExecutable());

    const q = sdk.query({ prompt: this.queue, options });
    this.query = q;
    void this.iterate(q);
    // 进程一起来就问一次上下文占用：init 要等第一条消息才到，而「一启动就有模型
    // 和占用率」不能等（对齐终端状态行的观感）——见 pullContextUsageSoon 的注释
    void this.pullContextUsageSoon();
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
    for (const w of this.exitWaiters) w();
    this.exitWaiters.length = 0;
    this.emit({ type: "exited", code, stderrTail: null });
  }

  private async iterate(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        const events = this.translator.translate(msg);
        // 首帧 init（session_ready）= 首条用户消息已被处理、进程与 jsonl 都齐了：此刻去要
        // 一次 AI 标题（终端里这一步由 CLI 自己完成，SDK 宿主得自己问，见 generateTitle）。
        // 放在开头、先把 titleAsked 置上：起名是异步的，不挡住事件下发，也避免重复问。
        if (!this.titleAsked && events.some((e) => e.type === "session_ready")) {
          this.titleAsked = true;
          void this.generateTitle();
        }
        for (const e of events) this.emit(e);
        // 轮次收尾时记下本轮的用户消息 uuid（rewindFiles 的锚点）。
        // ⚠️ 取 user_message_uuids 的**首位**，不是末位：数组是「本轮消费掉的全部用户
        // 消息」（按消费顺序），首位 = 本轮的起点 —— rewindFiles(该 uuid) 还原到「这一轮
        // 开始动手之前」，正是按钮承诺的语义。取末位会漏掉「中途塞进本轮的第二条消息
        // 之前」那些改动（一轮里 Edit 完再发一条接着改，末位只回滚后半段，
        // 2026-09-24 code review 发现）。旧 CLI 没有数组字段则退单个。
        if (msg.type === "result") {
          const uuids = (msg as Rec).user_message_uuids;
          const single = (msg as Rec).user_message_uuid;
          const uuid = Array.isArray(uuids) && uuids.length > 0 ? String(uuids[0]) : single;
          if (typeof uuid === "string" && uuid) this.lastTurnUserUuid = uuid;
        }
        // 每轮结束刷一次上下文占用（起进程那次由 start() 里的 pullContextUsageSoon 负责，
        // 因为 init 要等第一条消息才到 —— 光靠这里会漏掉"一启动就显示"）。
        // 放在这里而不是 translator 里：那层是纯翻译，而 getContextUsage 要 this.query。
        if (events.some((e) => e.type === "turn_end")) void this.emitContextUsage();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", message });
    } finally {
      // 生成器结束（进程退出 / stdin EOF）兜底补 exited
      this.emitExited(this.child?.exitCode ?? null);
    }
  }

  /** 拉一次上下文占用并推给前端。
   *  · `detail: 'summary'` 走「上一轮 usage + 本地估算」的廉价路径；默认的 `'full'`
   *    会逐类调 token-count API（有成本，没必要）。
   *  · 已用量取 `categories` 里 `kind === 'used'` 之和 —— d.ts 明确要求按 `kind` 分类、
   *    **别按英文名判**（`/context` 那套分类：used/free/buffer/deferred，
   *    其中 buffer 是压缩预留，不该算进「已用」）。
   *  · 整个函数静默：这是锦上添花的读数，拿不到就算了（前端还有 turn_end 那条兜底）。
   *  ⚠️ 该 API 在 docs/agent-sdk-capabilities.md 里标「型」（只看了类型、没跑过），
   *  所以前端保留了从 turn_end 推导的旧路径作兜底，两条写同一个状态。 */
  private async emitContextUsage(): Promise<boolean> {
    const q = this.query;
    if (!q || this.exited) return false;
    try {
      const u = await q.getContextUsage({ detail: "summary" });
      const used = (u.categories ?? [])
        .filter((c) => c.kind === "used")
        .reduce((n, c) => n + Number(c.tokens ?? 0), 0);
      const window = Number(u.maxTokens ?? 0);
      if (window <= 0) return false;
      this.emit({
        type: "context_usage",
        usedTokens: used,
        windowTokens: window,
        model: u.model ? String(u.model) : null,
      });
      return true;
    } catch (e) {
      // 不致命、也不弹给用户（前端还有 turn_end 那条兜底），但**留一行 warn**：
      // 这是个标「型」的 API（见 docs/agent-sdk-capabilities.md §9.5），
      // 哪天 CLI 不再提供、口径变了，就只有这里看得出来。与本文件里
      // generateTitle 的失败处理同一口径（降级但可见）。ASCII 输出：
      // 中文在这台机器的控制台里会被按 GBK 解成乱码。
      console.warn("[chat] getContextUsage failed:", e);
      return false;
    }
  }

  /** 进程刚起就把上下文占用拉一次（顺带把模型名带回来）。
   *  ⚠️ 为什么必须主动问、不能等事件：`system/init` 要等**第一条用户消息**才到 ——
   *  实测（2026-09-22）预热完成后进程已起，但一条 init/result 都没有，所以挂在
   *  `session_ready` 上的那次刷新永远不触发，「一启动就显示」也就无从谈起。
   *  首次可能撞上 SDK 传输层的 initialize 握手（控制请求还发不出去），
   *  故失败后退一步重试一次；仍失败就放弃，交给 turn_end 那条兜底。 */
  private async pullContextUsageSoon(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      if (this.exited) return;
      if (await this.emitContextUsage()) return;
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  /** 记下本 sitting 第一条非空用户文本（新建会话的 AI 标题描述用它）。
   *  续聊不记、记过了不覆盖：标题描述只认「这个会话是怎么开起来的」那一条。 */
  noteUserText(text: string): void {
    if (this.resumeId || this.firstPromptText !== null) return;
    if (text.trim() !== "") this.firstPromptText = text;
  }

  /**
   * 向 CLI 要一个 AI 标题（新建会话专属）。
   *
   * ⚠️ 为什么必须显式要：CLI 的自动起名**只发生在交互式 TUI 里**（TUI 提交消息时调它的
   * 内部起名函数）。SDK/stream-json 这条路不触发——2026-09-22 实测 2.1.278：一整轮跑完
   * 不写 `ai-title`；给用户消息加 `origin:{kind:"human"}` 也不写。于是 app 内对话建出来的
   * 会话在左栏只有「首条用户消息」那一档兜底标题。宿主能做的就是自己发这条控制请求。
   *
   * `generateSessionTitle` 在 `sdk.d.ts` 里**没有声明**（运行时方法，与 `resolvePermissionModeInCli`
   * 同一类，见 start() 里的注释与 docs/agent-sdk-capabilities.md）。`persist: true` 让它把
   * `{"type":"ai-title","aiTitle":…}` 追进 jsonl——与 TUI 生成的逐字同形，于是左栏列表
   * （回退链 customTitle > aiTitle > 首条用户消息，见 sessions.ts）与新对话收编轮询
   * 都自然读到 AI 标题。探针实测：本轮还在跑时调用同样成功（返回标题、同时落盘）。
   *
   * 静默降级（与 emitContextUsage 同一口径）：起名失败不致命——标题就停在首条消息那档，
   * 只留一行 warn 供排查。只问一次，失败不重试（重试要再花一次模型调用）。
   */
  private async generateTitle(): Promise<void> {
    const desc = titleDescriptionFor(this.resumeId, this.firstPromptText);
    const q = this.query;
    if (desc === null || !q || this.exited) return;
    this.titlePending = true; // 起名期间把自己从 list_sessions 里摘掉（见字段注释）
    try {
      const raw = await (
        q as unknown as {
          generateSessionTitle(d: string, o?: { persist?: boolean }): Promise<string>;
        }
      ).generateSessionTitle(desc, { persist: true });
      const title = typeof raw === "string" ? raw.trim() : "";
      if (title !== "" && !this.exited) this.emit({ type: "session_title", title });
    } catch (e) {
      // ASCII 输出：中文在这台机器的控制台里会被按 GBK 解成乱码
      console.warn("[chat] generateSessionTitle failed:", e);
      // 起名失败：退回「首条用户消息」那档兜底（与列表回退链同一口径）——不推的话 tab 会
      // 一直挂着项目名，跟左栏那条的名字对不上
      const fallback = cleanSummary(this.firstPromptText ?? "");
      if (fallback !== "" && !this.exited) this.emit({ type: "session_title", title: fallback });
    } finally {
      this.titlePending = false;
    }
  }

  /** 起名中的**会话 id**（jsonl 的 uuid 而不是 tab key）：新建会话的 `this.id` 就是它。
   *  null = 没在起名（含续聊——那条路根本不起名）。 */
  pendingTitleSessionId(): string | null {
    return this.titlePending && !this.resumeId ? this.id : null;
  }

  enqueue(msg: SDKUserMessage): void {
    this.queue.push(msg);
  }

  /** 把一条用户消息交给本轮（内部先等进程起来）。
   *  返回 false = 启动期间用户按了停止、这条消息已撤回**没有入队** —— 前端必须据此
   *  把那条乐观气泡收掉，否则界面上会留一条既没发出去、也不会出现在 jsonl 里的幽灵消息。 */
  async deliver(msg: SDKUserMessage): Promise<boolean> {
    this.delivering++;
    try {
      this.interruptRequested = false; // 清掉上一轮可能残留的记账
      await this.ensureStarted();
      if (this.interruptRequested) {
        this.interruptRequested = false;
        return false;
      }
      this.enqueue(msg);
      return true;
    } finally {
      this.delivering--;
    }
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

  /** 中断本轮。⚠️ 三个时刻都得管，少一个就会出现「按了没反应、要连按几次」：
   *  ① 本轮正在跑（query 已就绪）→ 交给 SDK 中断；
   *  ② 消息刚入队、SDK 还没当 prompt 取走 → 直接撤回，这才算真的「没发出去」；
   *  ③ 进程都还没起来（deliver 卡在 ensureStarted 上；首条消息和 resume 加载历史时
   *     这段最久，实测 resume 的会话要按三次才停）→ 记账，deliver 拿到进程后兑现。 */
  async interrupt(): Promise<void> {
    if (this.query) await this.query.interrupt();
    this.queue.withdraw();
    if (this.delivering > 0) this.interruptRequested = true;
  }

  async setPermissionMode(mode: ChatPermissionMode): Promise<void> {
    this.explicitMode = mode;
    await this.query?.setPermissionMode(toSdkPermissionMode(mode));
  }

  /** 可选模型表（`Query.supportedModels()`）。进程没起 / 已退出返回 null —— 前端据此
   *  显示「发送首条消息后可选」。条目是供应商映射后的槽位：第三方供应商下
   *  opus/fable/sonnet/haiku 各自解析到供应商的模型变体（探针实测 §6.13）。 */
  async supportedModels(): Promise<ChatModelInfo[] | null> {
    const q = this.query;
    if (!q || this.exited) return null;
    const list = await q.supportedModels();
    return list.map((m) => ({
      value: String(m.value),
      resolvedModel: m.resolvedModel != null ? String(m.resolvedModel) : null,
      displayName: String(m.displayName ?? m.value),
      description: String(m.description ?? ""),
    }));
  }

  /** 热切模型。成功后 CLI **立即**补发一帧 init（不用等下一轮，探针实测 §6.13），
   *  经既有 session_ready 翻译把新模型名送到前端——不需要专门的事件。
   *  model 为 null 复位默认。非法名会 reject（供应商 400），交给调用方 toast。 */
  async setModel(model: string | null): Promise<void> {
    await this.query?.setModel(model ?? undefined);
  }

  /** 斜杠命令表（`Query.supportedCommands()`），`/` 补全的数据源。
   *  进程没起 / 已退出返回 null。命令集合会随插件/技能装载变化，前端开了面板现查、
   *  不做长缓存（实测往返 <1ms）。 */
  async supportedCommands(): Promise<ChatCommandInfo[] | null> {
    const q = this.query;
    if (!q || this.exited) return null;
    const list = await q.supportedCommands();
    return list.map((c) => ({
      name: String(c.name),
      description: String(c.description ?? ""),
      argumentHint: c.argumentHint != null ? String(c.argumentHint) : null,
      aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [],
      builtin: c.builtin === true,
    }));
  }

  /** 撤销「最近一个完整轮次」的文件改动（`Query.rewindFiles()`）。
   *  dryRun = true 只算清单不动磁盘（filesChanged/增删行数只有这条给）；真回滚只回
   *  canRewind + skippedLinks —— UI 先 preview 再 apply 是设计使然（探针实测 §6.10）。
   *  ⚠️ 只回滚文件、不回滚对话：jsonl 原样保留，下一轮模型经 edited_text_file 附件
   *  自动知道文件被还原（探针验证过，宿主不用补纠偏）。
   *  没起进程 / 本 sitting 还没跑完过一轮（没有锚点 uuid）→ 返回 null。 */
  async rewindLast(dryRun: boolean): Promise<ChatRewindResult | null> {
    const q = this.query;
    const uuid = this.lastTurnUserUuid;
    if (!q || this.exited || !uuid) return null;
    const r = await q.rewindFiles(uuid, { dryRun });
    return {
      canRewind: r.canRewind === true,
      filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged.map(String) : null,
      insertions: r.insertions != null ? Number(r.insertions) : null,
      deletions: r.deletions != null ? Number(r.deletions) : null,
      skippedLinks: r.skippedLinks != null ? Number(r.skippedLinks) : 0,
      error: r.error != null ? String(r.error) : null,
    };
  }

  async rename(title: string): Promise<void> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await sdk.renameSession(this.id, title, { dir: this.projectPath });
  }

  /** 优雅关：先结束输入（stdin EOF 让 CLI 自己收尾并把 jsonl 写完），最多等
   *  `GRACEFUL_CLOSE_MS`，**超时才** abort 强杀。
   *  ⚠️ 早先是 `queue.end()` 后同一个 tick 直接 `abort.abort()`（abort 又是 spawn 的
   *  signal），等于流式中途砍掉子进程——jsonl 尾部可能不完整，注释里那句「超时由 SDK
   *  强杀」其实没实现。对齐 v2.0.0 的 drop(stdin) → wait_then_kill(child, 3s)。 */
  async close(graceMs: number = GRACEFUL_CLOSE_MS): Promise<void> {
    this.queue.end();
    if (!this.query || this.exited) return; // 从未启动 / 已退出：没什么可等
    const exited = await Promise.race([
      new Promise<boolean>((r) => this.exitWaiters.push(() => r(true))),
      new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), graceMs);
        t.unref?.();
      }),
    ]);
    if (!exited) this.abort.abort();
  }

  /** 立即强杀（整体退出超时的兜底） */
  kill(): void {
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
   *  启动失败会**抛出**（IPC 层转成 reject 让前端提示），不会静默丢掉这条消息。
   *  返回 false = 启动期间用户按了停止，这条消息被撤回（前端据此撤掉乐观气泡）。 */
  async send(sessionId: string, text: string, images?: ChatImage[]): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emit(sessionId, { type: "error", message: "会话不存在" });
      return false;
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
      return false;
    }
    // 首条用户文本要给标题当描述（新会话首轮跑完才会去要标题，得先记下）
    session.noteUserText(text);
    const delivered = await session.deliver(userMsg);
    if (!delivered) {
      // 启动期间用户就按了停止：消息撤回、没有入队。状态得交回 idle，
      // 否则前端会一直停在「思考中…」（它在 send 返回前就把状态置成 thinking 了）
      this.emit(sessionId, { type: "status", state: "idle" });
    }
    return delivered;
  }

  /** 预热：把该会话的 CLI 进程先起好（`--resume` 也在这一刻发生）。
   *  用途：用户点「继续对话」——那一声点击就是在说「接着聊」，此刻 resume 天经地义，
   *  不该等第一条消息。顺带让 init 里的模型信息立刻可用，并把「spawn 期间按停止没反应」
   *  那段窗口从发送路径上挪走（详见 ChatSession.interrupt 的注释）。
   *  ⚠️ 与 start() 分开是**有意的**：start() 只注册不 spawn，若它顺手 spawn，
   *  多开几个对话 tab 就会各起一个 CLI。预热必须是显式动作，不能被 chat_start 兜进来。
   *  ⚠️ 失败照原样抛给调用方：调用方（渲染层）该静默——预热不是用户操作，不该弹错，
   *  真正的报错留给发送路径（那边有 toast 且可重试）。 */
  async prewarm(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.ensureStarted();
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.interrupt();
  }

  async setPermissionMode(sessionId: string, mode: ChatPermissionMode): Promise<void> {
    await this.sessions.get(sessionId)?.setPermissionMode(mode);
  }

  /** 可选模型表（进程没起返回 null；会话不存在同 null） */
  async supportedModels(sessionId: string): Promise<ChatModelInfo[] | null> {
    return (await this.sessions.get(sessionId)?.supportedModels()) ?? null;
  }

  /** 运行中热切模型（null 复位默认；成功后 init 帧自动把新模型送到前端） */
  async setModel(sessionId: string, model: string | null): Promise<void> {
    await this.sessions.get(sessionId)?.setModel(model);
  }

  /** 斜杠命令表（进程没起返回 null） */
  async supportedCommands(sessionId: string): Promise<ChatCommandInfo[] | null> {
    return (await this.sessions.get(sessionId)?.supportedCommands()) ?? null;
  }

  /** 撤销最近一轮的文件改动（dryRun 决定预览或真回滚；没锚点返回 null） */
  async rewindLast(sessionId: string, dryRun: boolean): Promise<ChatRewindResult | null> {
    return (await this.sessions.get(sessionId)?.rewindLast(dryRun)) ?? null;
  }

  /** 前端对权限/方案审批的应答 */
  respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(sessionId)?.resolvePermission(requestId, decision);
  }

  /** 正在起名的会话 id 集合（`list_sessions` 用它把这几条从列表里滤掉几秒——那会儿它们的
   *  标题还只是「首条用户消息」那档兜底，见 ChatSession.titlePending）。空集表示没有。 */
  titlePendingIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions.values()) {
      const id = s.pendingTitleSessionId();
      if (id) out.add(id);
    }
    return out;
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.sessions.get(sessionId)?.rename(title);
  }

  async close(sessionId: string, graceMs: number = GRACEFUL_CLOSE_MS): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // 先摘掉：关的过程中再有 send 不该落到这个正在关的会话上
    this.sessions.delete(sessionId);
    await session.close(graceMs);
  }

  /** 关闭全部（app 退出时）。每个会话各自「关 stdin → 等退出 → 超时强杀」，整体再设
   *  上限——不能让退出流程被一个卡住的子进程无限拖住。 */
  async closeAll(
    totalTimeoutMs: number = GRACEFUL_QUIT_MS,
    graceMs: number = GRACEFUL_CLOSE_MS,
  ): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const done = Promise.all(sessions.map((s) => s.close(graceMs))).catch(() => undefined);
    await Promise.race([
      done,
      new Promise<void>((r) => {
        const t = setTimeout(r, totalTimeoutMs);
        t.unref?.();
      }),
    ]);
    for (const s of sessions) s.kill(); // 兜底：整体超时后仍未退出的直接杀
  }
}
