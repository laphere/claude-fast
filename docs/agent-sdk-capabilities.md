# Claude Agent SDK 能力面与用法（本机 0.3.278）

> 2026-09-22 整理。依据：本机 `node_modules/@anthropic-ai/claude-agent-sdk/`——`sdk.d.ts`（9451 行 / 228 个导出类型）、`package.json`（`claudeCodeVersion: "2.1.278"`）、`manifest.json`；加上仓库既有实测（`electron/backend/chat.ts`、`docs/agent-sdk-interactive-tools.md`、`CLAUDE.md` 的「Agent SDK 验证结论」）。
>
> **标注口径**：**实** = 本仓库真跑过、有实测记录；**型** = 只来自 `sdk.d.ts` 的类型面，**没跑过**。标 **型** 的条目在采用前先写探针验一次——这个 SDK 的坑基本都长在「类型上写着、运行时不是那么回事」的地方（`resolvePermissionModeInCli`、`updatedInput.answers` 都是这么发现的）。
>
> 为什么写这篇：对话层目前只用到 `Options` 的 6 项 + `Query` 的 3 个方法，而 SDK 的能力面散在 9451 行 d.ts 里没有索引——「预热子进程」「查上下文占用」「热切模型」「结构化输出」「进程内自定义工具 / 子代理」这些能力都在，本项目一个都没用。本文把「它有什么 / 怎么用 / 本项目用没用」一次钉死，以后不用重读 d.ts。

## TL;DR

1. **它不是新 API，是 Claude Code CLI 的进程包装**：SDK 负责 spawn CLI、按 stream-json 协议收发、把事件翻成 `SDKMessage`。所以「SDK 的能力」≈「CLI 的能力」——CLI 有的它基本都有，只是换了个编程入口。
2. **能力面 = `Options`（68 个开关）× `Query`（28 个运行时方法）× `SDKMessage`（39 种事件）+ 一组会话文件 API**。第一项是配置，第二项是运行中控制，第三项是你要渲染的东西。（四个数字都是按本机 `sdk.d.ts` 数出来的。）
3. **两种输入模式**：`prompt: string`（单发）与 `prompt: AsyncIterable<SDKUserMessage>`（流式）。**`Query` 上的运行时方法（`interrupt` / `setModel` / `setPermissionMode` …）只在流式模式可用**——本项目用的正是流式（队列 generator），天生具备。
4. **传了 `canUseTool` 就自动补 `--permission-prompt-tool stdio`**——交互工具三件套的开关。通道、payload、回传格式见 `docs/agent-sdk-interactive-tools.md`（那份是权威），本文不重复。
5. 打包两条铁律不变（esbuild `external` + asarUnpack），见 §8。

---

## 0. 定位与版本对齐

| 项 | 值 | 说明 |
|---|---|---|
| SDK 版本 | `0.3.278` | `package.json` 的 `version` |
| 对应 CLI | `2.1.278` | `package.json` 的 `claudeCodeVersion` + `manifest.json` 的 `version`，两处一致 |
| 原生二进制 | `optionalDependencies` 列 8 个平台包 | npm 只装匹配本机的那一个（win32-x64 的 `claude.exe` 237MB）。**2026-09-23 起从 `build.files` 排除、不进安装包**——对话层只认本机 claude（§8 第 5 条），安装包不再因它变大 |
| peerDependencies | `@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.0.0` | **都不在本仓 `package.json` 的 dependencies 里**，是 npm 7+ 自动装的 peer。本机 zod 实际是 `4.6.5` |

> ⚠️ **想用 `tool()` / `createSdkMcpServer()`（§6.2）就得显式把 `zod` 与 `@modelcontextprotocol/sdk` 加进 `dependencies`**。现在是传递装进来的，`npm install` 时解析不到就会炸；靠「本机恰好有」不是依赖声明。

**版本对齐是硬约束**：SDK 与 CLI 是同一份协议的两端，`manifest.json` 里的 `sdkCompat.testedWrapperVersions` 记录了测过的 wrapper 版本区间。升 SDK 必须成对升 CLI（或反过来），否则会出现「flag 传了没反应」这类静默失配（`--permission-prompt-tool` 就是未正式列出的 CLI 面，升级时值得回归）。

## 1. 五个入口

| 导入路径 | 内容 | 本项目 |
|---|---|---|
| `.`（`sdk.mjs`） | 主入口，本文除特别说明外都指它 | ✅ 在用（动态 `import()`） |
| `./sdk-tools` | **纯类型**：内置工具的输入 JSON Schema（`BashInput` / `FileEditInput` / `ExitPlanModeInput` / `ReportFindingsInput` … 约 20 个） | 未用。要在渲染层给工具调用做**结构化渲染**（而不是打印 JSON）时很有用 |
| `./browser` | 浏览器环境的 `query` + SSE 相关（`getSseDropCounts` / `getSseLastSequenceNum`） | 未用，本项目是 Electron 主进程 |
| `./bridge` | 远端会话：`attachBridgeSession` / `createCodeSession` / `fetchRemoteCredentials` / `isCredentialsFailure` | 未用 |
| `./extract` | `bun build --compile` 时把原生 CLI 从虚拟 FS 解到真实路径 | 未用，见 §8 |

主入口的顶层导出，按用途分四组：

- **起会话**：`query()`、`startup()`（→ `WarmQuery` 预热，§6.8）
- **会话文件 API**：`listSessions` / `getSessionInfo` / `getSessionMessages` / `getSubagentMessages` / `listSubagents` / `renameSession` / `tagSession` / `deleteSession` / `forkSession` / `importSessionToStore`（§6.6）
- **自定义工具**：`tool()` / `createSdkMcpServer()`（§6.2）
- **工具函数与常量**：`resolveSettings()`、`filterEscalatingDefaultMode()`、`HOOK_EVENTS`（33 个）、`EXIT_REASONS`、`USAGE_LIMIT_ERROR_PREFIXES` / `USAGE_WARNING_PREFIXES` / `USAGE_TRANSITION_PREFIXES` / `ORG_POLICY_LIMIT_PREFIXES`（配额文案识别）、`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、`AbortError`

> 💡 `USAGE_*_PREFIXES` 这几组常量对本项目直接可用：对话层现在是把 CLI 的错误串原样抛给前端，用它们可以区分「配额用完 / 接近上限 / 组织策略禁用」，从而给出不一样的 UI。

## 2. 最小用法

### 2.1 单发（`prompt: string`）

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "用一句话说明这个仓库是做什么的",
  options: { cwd: "/path/to/repo" },
});

for await (const msg of q) {
  if (msg.type === "result" && msg.subtype === "success") console.log(msg.result);
}
```

**型**。这是官方文档的主推写法，本项目没用——单发模式下拿不到 §4 那些运行时方法，也没法中途插话。

### 2.2 流式（`prompt: AsyncIterable<SDKUserMessage>`）—— 本项目这套

要点：自己实现一个**可 push 的队列**当 `AsyncIterable`，然后 `query()` 只调一次、之后所有输入都往队列里推。`electron/backend/chat.ts` 就是这么做的（懒启动 + 多会话并行 + 非激活 tab 继续后台流式都建立在这上面）。

骨架（**实**，`chat.ts` 的简化版）：

```ts
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(msg: SDKUserMessage) { this.pending.push(msg); this.wake?.(); }
  end() { this.done = true; this.wake?.(); }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.pending.length === 0) {
        if (this.done) return;
        await new Promise<void>((r) => { this.wake = r; });
        this.wake = null;
        continue;
      }
      yield this.pending.shift()!;
    }
  }
}

const queue = new InputQueue();
const q = sdk.query({ prompt: queue, options });
void (async () => { for await (const msg of q) handle(msg); })();  // 消费与发送解耦

queue.push({ type: "user", message: { role: "user", content: "…" }, parent_tool_use_id: null });
```

`SDKUserMessage` 的 `content` 可以是字符串，也可以是块数组——**图片走块数组**（`{ type: "image", source: { type: "base64", media_type, data } }`），本项目已实现（≤4.5MB，前后端各拦一次）。

## 3. `Options`：能力面总表

按类分，`实` = 本项目已在用。**未列 `实` 的都是「型」**（类型面存在、未跑）。

| 类 | 字段 |
|---|---|
| **进程 / 路径** | `cwd` **实**、`pathToClaudeCodeExecutable` **实**、`spawnClaudeCodeProcess` **实**、`env`（含 `CLAUDE_AGENT_SDK_CLIENT_APP` 标识，见 §8）、`executable`（`'bun'\|'deno'\|'node'`）、`executableArgs`、`extraArgs`（**裸 CLI flag 逃生口**：`{ "permission-prompt-tool": "stdio" }`）、`stderr`、`abortController` **实**、`loadTimeoutMs` |
| **权限** | `permissionMode` **实**、`canUseTool` **实**、`allowedTools` / `disallowedTools` / `tools` / `toolAliases` / `toolConfig`、`permissionPrompts`(`'host'\|'none'`)、`planModeInstructions`、`allowDangerouslySkipPermissions` |
| **模型 / 思考** | `model`、`fallbackModel`（逗号分隔多档，逐档回退；每轮用户输入会重试主模型，不会永久降级）、`thinking`（`adaptive` / `enabled{budgetTokens}` / `disabled`）、`effort`（`'low'\|'medium'\|'high'\|'xhigh'\|'max'` 或整数）、`maxThinkingTokens`（**已废弃**，改用 `thinking`）、`betas`（如 `['context-1m-2025-08-07']`） |
| **预算** | `maxTurns`、`maxBudgetUsd`（超出返回 `error_max_budget_usd`）、`taskBudget`（alpha，把剩余 token 预算告知模型让它自己收口） |
| **结构化输出** | `outputFormat: { type: 'json_schema', schema }`（§6.4） |
| **扩展** | `mcpServers`、`strictMcpConfig`、`plugins`（仅 `{ type: 'local', path }`）、`skills`（`string[]` 或 `'all'`）、`agents`（子代理定义，§6.5） |
| **沙箱** | `sandbox`（`enabled` / `network` / `filesystem` / `ignoreViolations` / `credentials`，§6.9） |
| **会话续接** | `resume` **实**、`sessionId` **实**、`title`（**新会话直接指定标题**，不再自动从首条消息生成；续聊时以已落盘的标题为准）、`continue`、`forkSession`、`resumeSessionAt`（从链上某条消息处续）、`resumeDropsTurn`、`persistSession`、`sessionStore` / `sessionStoreFlush`（alpha，换存储后端） |
| **设置** | `settingSources`（**本项目刻意不传**，§8）、`settings`（内联 flag 层）、`managedSettings`、`projectConfigRoot`、`additionalDirectories`、`systemPrompt` |
| **文件检查点** | `enableFileCheckpointing`（配 `rewindFiles()`，§6.10） |
| **UI 相关** | `includePartialMessages` **实**、`includeHookEvents`、`forwardSubagentText`、`agentProgressSummaries`、`promptSuggestions`、`onElicitation`、`onUserDialog`、`supportedDialogKinds`、`perTaskStopAffordance` |
| **调试** | `debug`、`debugFile` |

> ⚠️ `tools` / `allowedTools` / `disallowedTools` 三者语义不同：`tools` 是**声明可用集合**，`allowedTools` 是**免确认白名单**，`disallowedTools` 是**硬禁**。`toolAliases` 与 `disallowedTools` 互补而非替代——别名只影响「按名字查模型发出的 tool_use」，`disallowedTools` 连不经名字查找的内部直呼也挡。

## 4. `Query`：运行时控制（28 个方法）

> ⚠️ **标题下这一段方法只在流式输入模式下可用**（d.ts 的注释明确写了「control requests, only supported when streaming input/output is used」）。单发模式调用会拿不到预期效果。

| 用途 | 方法 |
|---|---|
| 打断 / 收尾 | `interrupt()` **实**（新版 CLI 返回 receipt，列出**仍会执行**的异步消息 uuid）、`close()` **实**、`stopTask(taskId)`、`backgroundTasks(toolUseId?)`（把前台 Bash / 子代理转后台） |
| 改状态 | `setPermissionMode(mode)` **实**、`setModel(model?)`、`setMaxThinkingTokens(token, display?)`、`applyFlagSettings(partial)`（只改会话级 flag 层）、`updateSettings(source, obj)`（**真写 settings 文件**，同 `/config` 那条路） |
| 查状态 | `initializationResult()`、`reinitialize()`、`supportedCommands()`（斜杠命令表）、`supportedModels()`、`supportedAgents()`、`accountInfo()`、`getContextUsage()`、`mcpServerStatus()` |
| MCP 热管 | `reconnectMcpServer(name)` / `toggleMcpServer(name, enabled)` / `setMcpServers(record)`（只影响动态加的，settings 文件里的不受影响） |
| 文件 | `readFile(path)`、`seedReadState(path, mtime)`（给 CLI 的读取缓存喂值）、`rewindFiles(userMessageId)` |
| 热重载 | `reloadPlugins()` / `reloadSkills()` / `reloadOutputStyles()` |
| 输入 | `streamInput(stream)`（SDK 内部用于多轮，本项目不需要直接调） |
| MCP 权限 | `setMcpPermissionModeOverride(serverName, 'default' \| 'auto' \| null)`（**只能收紧，不会放宽**） |
| 标题 | `generateSessionTitle(desc, { persist? })`（**实**，2026-09-22；**d.ts 未声明**，见 §6.12） |

> `setMcpPermissionModeOverride` 的「tighten-only」设计值得注意：它只在会话本身已经会自动放行（`bypassPermissions` / `auto`）时才生效，且只接受收紧档——所以可以放心暴露给 UI，不会变成提权后门。

## 5. 事件流：`SDKMessage`

`sdk.d.ts` 里是 39 个成员的联合。按用途分组：

| 组 | 成员 |
|---|---|
| **你要渲染的** | `assistant`、`user`（含 `SDKUserMessageReplay`）、`partial_assistant`（配 `includePartialMessages`，流式增量）、`result`（`SDKResultSuccess` / `SDKResultError`）、`system`（`subtype: 'init'` 带 session_id / model / tools）、`compact_boundary` |
| **工具与任务** | `tool_progress`、`tool_use_summary`、`task_started` / `task_updated` / `task_progress` / `task_notification`、`background_tasks_changed`、`hooks_started` / `hooks_progress` / `hooks_response`、`permission_denied` |
| **状态与元信息** | `status`、`session_state_changed`、`api_retry`、`auth_status`、`rate_limit_event`、`thinking_tokens`、`context_usage` 相关、`commands_changed`、`files_persisted`、`conversation_reset`、`worker_shutting_down` |
| **其他** | `plugin_install`、`memory_recall`、`prompt_suggestion`、`informational`、`mirror_error`、`model_refusal_fallback` / `model_refusal_no_fallback`、`elicitation_complete`、`local_command_output`、`control_request_progress` |

几个容易被忽略但很有用的：

- **`system` / `subtype: 'init'`**：`session_id`、`model`、`permissionMode`、`tools`、`capabilities` 都在这。本项目从它读 `session_id` 做落盘收编，`capabilities` 里还有 `interrupt_receipt_v1` 这类能力位。
  - 该帧**每轮开头都会发**（d.ts 原话：normally ahead of every other message of that turn），所以 `permissionMode` 隔一轮就有一条新鲜的——但**不跟手**。
- **`system` / `subtype: 'status'` 带 `permissionMode`**（2026-09-22 实测，本项目已用）：CLI 把「模式变了」压在这帧上，**与工具结果同刻到达**——`EnterPlanMode` 生效时报 `plan`、批准 `ExitPlanMode` 时报回 prePlanMode。底部模式选择器要跟手就得吃这帧（本项目走 `permission_mode` 事件，见 `chat.ts` 的 `translateSystem`）。注意 `status: 'requesting'` 那类帧 `permissionMode` 为 `undefined`，有才认。
- **`prompt_suggestion`**：每轮**最多一条、且在 `result` 之后到达**——所以消费端必须在拿到 `result` 之后**继续迭代流**，否则永远收不到（想要「下一句猜你想问什么」的 UI 才需要）。
- **`rate_limit_event` + §1 的 `USAGE_*_PREFIXES`**：配额类 UI 的两块料。

## 6. 能力专题

### 6.1 权限与交互类工具（**实**）

`ExitPlanMode` / `AskUserQuestion` / `EnterPlanMode` 这套的开关、通道、回传格式**见 `docs/agent-sdk-interactive-tools.md`**，此处不复述。只重申两条最容易踩的：

- 开关是 `--permission-prompt-tool stdio`，**SDK 传了 `canUseTool` 会自动补**；
- `AskUserQuestion` 的应答**必须带 `updatedInput.answers`**，只回 `{behavior:"allow"}` 静默失效、无错误码。

`canUseTool` 的第三参数（本项目的 `handleCanUseTool` 目前只用了前两个）还挺有用：

```ts
canUseTool: async (toolName, input, o) => {
  o.signal;          // 该操作被中断的信号
  o.blockedPath;     // 触发本次询问的路径（Bash 越界访问时尤其有用）
  o.mcpServer;       // { name, source } —— source === 'sdk' 才是本宿主注册的进程内 server
  o.decisionReason;  // 为什么触发（如 "rule matched / not allowed"）
  o.title;           // 桥接层渲染好的整句提示（"Claude wants to read foo.txt"）
  o.displayName;     // 短名词短语，适合做按钮文案（"Read file"）
  o.description;     // 人类可读副标题
  o.suggestions;     // 「以后别再问」候选，回传到 updatedPermissions
  return { behavior: "allow", updatedInput: input };
}
```

> 💡 `o.title` / `o.displayName` / `o.description` 是桥接层给的现成文案，比自己在 `toolName + input` 上反推提示语准得多。`o.suggestions` + `updatedPermissions` 则是实现「总是允许这个工具」的正路——本项目的权限卡目前只有允许 / 拒绝两键。
>
> ⚠️ `o.mcpServer.name` 是配置里作者写的**不可信文本**，直接显示前要转义；信任判断要看 `source` 而不是名字前缀。

### 6.2 进程内自定义工具（**型**）

```ts
import { tool, createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const getWeather = tool("get_weather", "查某城市天气", { city: z.string() },
  async ({ city }) => ({ content: [{ type: "text", text: `${city}：晴，24℃` }] }));

const server = createSdkMcpServer({ name: "demo", version: "1.0.0", tools: [getWeather] });

query({ prompt: "北京天气怎样？", options: { mcpServers: { demo: server } } });
```

工具在**本进程**执行（不需要真的起 MCP 子进程），适合把 app 自己的能力暴露给模型——比如本项目可把「会话搜索」「用量台账查询」「回收站操作」做成工具，让 app 内对话直接调，而不是每次让模型自己读文件。

`tool()` 的第 5 参数：`{ annotations, searchHint, alwaysLoad }`。`alwaysLoad: true` 让该工具永远在初始 prompt 里、不被工具搜索延后（工具多了以后影响命中率）。

`createSdkMcpServer` 的 `timeout`（ms，v0.3.248+）限制该 server 工具调用时长——**默认实际上是无限的**，会卡住的工具一定要设。

### 6.3 hooks（**型**）

```ts
options.hooks = {
  PreToolUse: [{ matcher: "Bash", hooks: [async (input, toolUseID, { signal }) => ({...})] }],
};
```

- `HookEvent` 共 **33 个**（`HOOK_EVENTS` 常量就是全表）：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` / `PermissionRequest` / `PermissionDenied` / `UserPromptSubmit` / `UserPromptExpansion` / `SessionStart` / `SessionEnd` / `Stop` / `StopFailure` / `SubagentStart` / `SubagentStop` / `PreCompact` / `PostCompact` / `PreModelSwitch` / `PostModelSwitch` / `Notification` / `Setup` / `TeammateIdle` / `TaskCreated` / `TaskCompleted` / `Elicitation` / `ElicitationResult` / `ConfigChange` / `WorktreeCreate` / `WorktreeRemove` / `InstructionsLoaded` / `CwdChanged` / `FileChanged` / `DirectoryAdded` / `MessageDisplay`
- matcher 形状：`{ matcher?: string, hooks: HookCallback[], timeout?: number(秒) }`
- 返回值 `HookJSONOutput`，权限类事件的决策是 `{ decision: 'allow' | 'deny' | 'ask' | 'defer' }`
- ⚠️ **`acceptEdits` / 白名单命中的调用根本不经过 `canUseTool`**——要「逐工具过策略」只能靠 `PreToolUse` hook。这条 `CLAUDE.md` 已记，是本项目将来做「审计每个工具调用」的唯一路。
- `CwdChanged` / `FileChanged` / `DirectoryAdded` / `MessageDisplay` 这几个新事件是给 IDE 型宿主做实时刷新的——本项目「窗口聚焦自动刷新」目前是自己轮询文件 mtime，理论上可以换成事件驱动。

### 6.4 结构化输出（**型**）

```ts
options.outputFormat = {
  type: "json_schema",
  schema: { type: "object", properties: { summary: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["summary"] },
};
```

模型返回匹配 schema 的结构化数据，而不是散文。注意 d.ts 里那条相关约束：这种「end-turn tool 会话」的轮次以 `structured_output` attachment 收尾（**没有尾随 assistant 消息**）——`forkSession` / `resumeSessionAt` 的取点规则因此特殊（要取该轮最后一条链条目，别取最后一条 assistant uuid）。

**对本项目的用处**：会话导出、用量归因、批量扫描时想「稳定地拿结构」而不是解析自然语言。

### 6.5 子代理 / 技能 / 插件（**型**）

```ts
options.agents = {
  "test-runner": {
    description: "跑测试并汇报结果",
    prompt: "你是一个测试执行者…",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "inherit",           // 或模型别名 / 完整 id
    skills: ["…"],
    effort: "high",
  },
};
options.skills = "all";                        // 或 string[] 指定预载
options.plugins = [{ type: "local", path: "./my-plugin" }];  // 目前仅 local
```

`agents` 让宿主自己定义子代理，**不依赖项目里的 `.claude/agents/`**——对本项目意味着「一套 app 内置的子代理，对所有项目可用」，是个产品差异点。`AgentDefinition` 还支持 `memory` 作用域（`user` / `project` / `local` 各自的 agent-memory 目录）与 `withoutClaudeMd`（子代理不读 CLAUDE.md，适合只靠委派提示词干活的角色）。

### 6.6 会话文件 API（**型**，但落盘格式**实**）

这组函数直接读写 `~/.claude/projects/<mangled>/<id>.jsonl`——**与本项目 `sessions.ts` 的读取端是同一份文件**（`CLAUDE.md` 已实测：SDK 建会话、终端能 `--resume`，`renameSession()` 与 `appendCustomTitle` 逐字节相同）。

`listSessions` / `getSessionInfo` / `getSessionMessages(id, { dir })` / `getSubagentMessages(id, agentId)` / `listSubagents(id)` / `renameSession` / `tagSession(id, tag|null)` / `deleteSession` / `forkSession(id, { … })` / `importSessionToStore`（alpha）。

**可用点**：本项目 `sessions.ts` 是自己解析 jsonl（只读首尾 64KB 提元数据、手写标题回退链）。SDK 这几个函数是同源的官方实现，**消息读取**（`getSessionMessages`）尤其是重复劳动——但它是否也做「相邻同 `message.id` 合并」「代表行取收尾行」这两条本项目独有的口径，**必须先验证**：`CLAUDE.md` 里那两条（不合并会让消息数虚高 30~80%、usage 取首行会差 75 倍）是本项目实测出来的，SDK 不保证一致。用之前先对同一个会话比一遍数字。

`forkSession` 的语义值得记一笔：**只分叉对话历史，不分叉文件系统改动**。

### 6.7 预算与成本（**型**）

`maxTurns`（轮数上限）、`maxBudgetUsd`（美元上限，超出返回 `error_max_budget_usd`）、`taskBudget`（token 预算，alpha，会把剩余额度告知模型让它自己收口）。订阅版 jsonl 没有 `costUSD`（本项目的用量台账因此只统计 token），但这两个上限是**客户端护栏**，不依赖账单数据，照样能用。

### 6.8 预热：`startup()`（**型**）

```ts
const warm = await startup({ options, initializeTimeoutMs: 5_000 });
const q = warm.query("你好");     // 一个 WarmQuery 只能 query 一次
warm.close();                     // 不要了就这么丢弃
```

**直接把 CLI 子进程先起好**，等真发第一条消息时 `query()` 立即返回——消掉的正是本项目「懒启动」那一段冷启等待。`WarmQuery extends AsyncDisposable`，可以 `await using`。

对本项目的适配问题：现在是**首条消息才 spawn**，用 `startup()` 就得决定「什么时候预热」——候选是「点项目行「+」开 tab 时」或「窗口聚焦时预热当前项目」。而 `WarmQuery` 只能 query 一次、`Options` 又是起进程时定死的（cwd / resume id 都绑定了），所以**预热粒度是「某个项目的某个新会话」**，不能一个 warm 复用到多个项目。要做的话得配一个带失效策略的 warm 池。

### 6.9 沙箱（**型**）

```ts
options.sandbox = { enabled: true, network: { allowLocalBinding: true }, filesystem: {…} };
```

⚠️ **关键口径**：`sandbox` 只控制沙箱**行为**（开关、auto-allow），**真正的访问限制来自权限规则**——文件系统靠 `Read` / `Edit` 规则、网络靠 `WebFetch` 规则。别以为开了沙箱就等于限住了。另外 `enabled: true` 时 `failIfUnavailable` 默认也是 `true`：沙箱依赖缺失（如 Linux 的 `bubblewrap`）会让 `query()` 直接报错退出，而不是静默降级——想降级要显式 `failIfUnavailable: false`。

### 6.10 文件检查点与回滚（**实**，2026-09-23 探针；未接进对话层）

`enableFileCheckpointing: true` 之后，`rewindFiles(userMessageId, { dryRun? })` 把被跟踪文件回滚到**某条用户消息发出时刻**的状态。探针（`%TEMP%\rewind-probe\`，本机 CLI 2.1.278 / SDK 0.3.278，场景：Write 改文件 → dryRun + 真回滚 → 禁工具凭记忆答内容 → 真读文件）四条硬结论：

- **只回滚文件，不回滚对话**——与 CLI `/rewind`（代码 + 对话一起回）的本质差异。回滚后 jsonl 一行不少：被撤销那轮的 `Edit` / `Write` tool_use 记录仍在链上、session_id 不变、resume 仍见全部历史。对话级「回滚」只有**新开 query** 的 `resumeSessionAt`（从链上某条 UUID fork，配 `resumeDropsTurn` 防误丢校验，**型**）——要完整复刻 CLI `/rewind` 得两者组合。
- **回滚后模型不会误以为文件仍是改过的状态**（采用前最担心的一点，已排除）：rewind 把文件翻回旧内容，在 CLI 的文件新鲜度跟踪眼里等于「文件被外部修改」，**下一轮用户消息自动附一条 `edited_text_file` attachment 注入当前真实内容**（随消息落盘 jsonl，resume 也不翻案）。探针里禁用工具、要求模型「仅凭对话记忆」回答文件内容，答的是回滚后的真值（不是对话里 Write 过的那个）；真 `Read` 也答对。宿主不需要自己补纠偏。
- **返回值口径**：`dryRun: true` → `{canRewind, filesChanged, insertions, deletions}`（不动磁盘）；**真回滚只回 `{canRewind, skippedLinks}`**——`filesChanged` 清单只有 dryRun 给，UI 要展示「将回滚哪些文件」必须先跑一次 dryRun。
- **快照仓就是 `~/.claude/file-history/<sessionId>/<key>@vN`**，与 CLI `/rewind` 的快照同一仓库（memory 里那条手工恢复路就是它）；jsonl 用 `file-history-snapshot`（每条用户消息一份，含 trackedFileBackups）/ `file-history-delta`（改动时记 backupFileName）记账。

`userMessageId` 传**宿主 yield `SDKUserMessage` 时自带的 `uuid`**（客户端 uuid 会落盘进链、`rewindFiles` 直接认它；轮次回显——assistant 首帧 / result 帧上的 `user_message_uuid`——用的也是它）。

**对本项目的用处**：会话页「变更文件面板」（聚合 `Edit` / `Write` / `MultiEdit`，点一下只能定位、不能回退）加「撤销本轮改动」。落地时 UI 要向用户讲清语义：**文件回去了、对话记录还在**（下一轮模型经 `edited_text_file` 附件自己知道文件被还原）。~~仍待验：跟踪文件集合与自家面板聚合口径的重合度~~ → **2026-09-24 二次探针已验**（`%TEMP%\sdk2-probe\`）：同一轮里 `Write` 新建 + `Edit` 修改**两个文件都在跟踪集**，dryRun 的 `filesChanged` 与面板的 Edit/Write 聚合口径一致；Write 建的文件回滚后被**删除**（不留空文件）。已落地：`chat.ts` 的 `rewindLast`（锚点取 result 帧 `user_message_uuids` 的**首位**——数组是「本轮消费掉的整批用户消息」，首位 = 本轮起点；取末位会漏掉「中途塞进本轮的第二条消息之前」的改动，2026-09-24 code review 修正；用户消息的 uuid 由 `buildUserMessage` 生成，SDKUserMessage 类型未声明、运行时认——又一处内部面）+ 变更文件面板的行内二次确认按钮 + **`error` 透传**（`canRewind:false` 有两种成因，吞掉 error 会把「失败」报成「没有改动」）。

### 6.11 上下文占用（**实**，2026-09-22 复验）

`getContextUsage(opts?)` 拿到的是**当前上下文窗口占用**，和会话页头部的「N 条消息 · 总计 token」是两件事：后者是 token 累计，前者是「还剩多少额度」。

```ts
getContextUsage({ detail: 'summary' })
  → { categories: [{ name, tokens, color, kind: 'used'|'free'|'buffer'|'deferred' }],
      totalTokens, maxTokens, rawMaxTokens, percentage, model,
      gridRows, memoryFiles, mcpTools, systemTools, systemPromptSections, agents, … }
```

本机 CLI **可用**，已接进对话层（底部信息区的「已用上下文 %」）。落地时的几条实测结论：

- **`detail: 'summary'` 就够**：走「上一轮 usage + 本地估算」；默认的 `'full'` 会逐类调 token-count API（有成本）。
- **已用量要按 `kind === 'used'` 求和**，别用 `totalTokens`（它还含 free/buffer——`buffer` 是压缩预留）。d.ts 明确要求按 `kind` 判、别按英文名。
- **分母用 `maxTokens`**。另给了 `rawMaxTokens`，两者差的就是那部分预留；界面按 `maxTokens` 算。
- **`percentage` 字段的单位没验**（0-100 还是 0-1）——所以对话层**不转发它**，只把 `usedTokens`/`windowTokens` 两个原始数送给前端自己算比值。要用 `percentage` 先确认单位。
- **返回里带 `model`** ✓——比只靠 `system/init` 更早拿到模型名（原因见 §8 第 9 条）。
- **调用时机**：`detail:'summary'` 在**一轮都没跑过**时也返回（新会话是 0%），所以「进程一起来就显示」是能做到的——但必须**主动问**，不能挂在 init 事件上（§8 第 9 条）。刚 `query()` 完的那一瞬间可能撞上传输层 initialize 握手，对话层因此试两次（间隔 800ms）。

### 6.12 会话标题：`generateSessionTitle()`（**实**，2026-09-22）

**先记住这条：CLI 的自动起名只发生在交互式 TUI 里。** SDK / stream-json 宿主不管，跑完一轮 jsonl 里也不会出现 `ai-title` 行。实测（本机 CLI 2.1.278）：

- `~/.claude/projects/*/*.jsonl` 全量核对：凡有 `{"type":"ai-title","aiTitle":…}` 行的会话，文件里都有 `"origin":{"kind":"human"}` 的用户行（TUI 手输）；没有该 origin 行的会话（= 走 SDK 的 app 内对话）一个 `ai-title` 都没有。
- 探针（`%TEMP%\title-probe\`）：`prompt` 用**字符串**跑完一整轮 → 不写；用**流式输入**、且给 `SDKUserMessage` 加 `origin: {kind:'human'}` → 仍然不写。**所以这不是 origin 的事，是宿主面的事**，别指望靠标 origin 让 CLI 自己起名。
- 起名函数在 CLI 内部只从 TUI 的提交路径调用；SDK 宿主要起名只能走这条控制请求（CLI 侧 control_request `generate_session_title`，SDK 侧 `Query` 上的同名方法）。

```ts
// ⚠️ sdk.d.ts 里没有这个方法（也不是导出函数），只有 sdk.mjs 里实现了 —— 与
// resolvePermissionModeInCli 同一类「内部面」，升级时要回归。对话层用 @ts-expect-error
// 风格的类型断言调用（chat.ts 的 ChatSession.generateTitle）。
generateSessionTitle(description: string, opts?: { persist?: boolean }) → Promise<string>
```

实测行为（2026-09-22，本机 + 第三方供应商都验过）：

- **`persist: true` 会把 `{"type":"ai-title","aiTitle":…}` 追加进 jsonl**，与 TUI 生成的逐字同形——于是左栏列表（回退链 `customTitle > aiTitle > 首条用户消息`）自然读到 AI 标题，不需要宿主自己写文件。`persist` 缺省/`false` 只返回标题、不落盘。
- **已有 `customTitle` / `aiTitle` 的会话直接返回既有标题、不花模型调用**（幂等）。所以「要不要先读 jsonl 判断有没有标题」是不必要的。
- **本轮还在跑时调用同样成功**：init 帧一到就调（`+2077ms`），标题 `+4300ms` 返回并落盘，两者互不干扰——控制请求与消息流是两条车道。
- **调用失败会 reject**（起名用的那个模型不可用时），宿主该降级：标题退回「首条用户消息」那档，不要让它影响对话。
- 描述文本就是「首条用户消息」（TUI 也是这么传的）；纯图消息没有可读文本，TUI 会跳过，宿主同理。

### 6.13 模型热切与命令表：`supportedModels()` / `setModel()` / `supportedCommands()`（**实**，2026-09-24 探针）

探针 `%TEMP%\sdk2-probe\sdk2.mjs`（本机 CLI 2.1.278，GLM 供应商配置），六条硬结论：

- **`supportedModels()` 反映供应商映射后的槽位**：default/opus/fable/sonnet/haiku 各自带 `resolvedModel`——第三方供应商下它们解析到**不同的模型变体**（实测 default → `glm-5.3[1m]`、opus → `glm-5.3[1M]`、haiku → `glm-5.3`），`[1m]` 与 `[1M]` 仅大小写之别即是两回事，**选择器要亮出 resolvedModel 且不能归一化大小写**。
- **`setModel()` 热切后 CLI 立即补发一帧 init（不等下一轮）**——经既有 `session_ready` 翻译链把新模型名送到前端，**不需要新增事件**。
- **`setModel(undefined)` 复位默认**，同样立即回 init。
- **非法名 reject**（供应商 400，错误串带 `model not changed`），reject 而非静默——UI 可以放心 toast / 内联报错。
- **`supportedCommands()` 实测 66 条**（含用户装的技能），形状与 d.ts 一致（name/description/argumentHint/aliases/builtin），往返 <1ms，开了面板现查即可、不必缓存。
- **effort 全程零回显**：`applyFlagSettings({effortLevel})` 成功但没有任何帧带 effort（before=after=0）——SDK 宿主上 effort 只能「自己设过自己记」，盲控制器 + resume 后状态丢失，**v1 砍掉 effort UI**，等有回显通道再做。

与 `getContextUsage`/`generateSessionTitle` 一样，这三个都已在对话层落地（`chat.ts` 的 `supportedModels` / `setModel` / `supportedCommands` + `ModelPicker.tsx` + `/` 补全面板）。

---

## 7. 本项目现状对照

**用的（`chat.ts` 全部家当）**：`cwd`、`canUseTool`、`includePartialMessages`、`abortController`、`spawnClaudeCodeProcess`、`permissionMode`（条件）、`resolvePermissionModeInCli`（内部选项，`@ts-expect-error`）、`resume` \| `sessionId`、`pathToClaudeCodeExecutable`、`enableFileCheckpointing`；运行中调 `interrupt()` / `setPermissionMode()` / `close()` / `getContextUsage()` / `generateSessionTitle()`（内部/未声明面，§6.11、§6.12）/ `supportedModels()` / `setModel()` / `supportedCommands()` / `rewindFiles()`（§6.13、§6.10，2026-09-24 落地：`ModelPicker.tsx` 模型热切、`/` 命令补全面板、变更文件面板的「撤销本轮改动」）。

**没用但值得排队的**（按「对本 app 的收益 ÷ 落地成本」粗排）：

| 能力 | 落地点 | 备注 |
|---|---|---|
| `startup()` | 消掉首条消息的冷启等待 | 需先定预热时机 + warm 池失效策略，见 §6.8 |
| `agents` | app 内置子代理，跨项目可用 | 与「项目 `.claude/agents/`」互补 |
| `outputFormat` | 会话导出 / 批量分析的结构化输出 | 只在特定功能里用 |
| `maxTurns` / `maxBudgetUsd` | 成本护栏（设置项） | 客户端侧，不依赖账单 |
| `options.title` | 新会话标题**开进程时直接给** | 注意与 §6.12 分工：那个是**宿主自己定**一个写死的标题（且给了就不再自动起名）；要让 CLI 起名走 `generateSessionTitle()`。头部统计 / 四按钮现在仍靠轮询 `chat_session_meta` 等 jsonl 里出现标题 |
| `tool()` + `createSdkMcpServer()` | 把会话搜索 / 用量查询 / 回收站做成工具 | 需先显式加 `zod` 依赖 |
| `PreToolUse` hook | 逐工具审计 / 策略（`canUseTool` 覆盖不到的那部分） | 见 §6.3 |
| `USAGE_*_PREFIXES` | 配额类错误的差异化 UI | 常量，直接可用 |

## 8. 坑与约束

1. **`settingSources` 不能传 `[]`**（**实**）：那是 SDK isolation 模式，**连认证一起丢**（实测报 `Not logged in`）。本项目刻意不传任何值 = CLI 用自身默认（user + project + local）。
2. **不传 `settingSources` 也还不够**（**实**）：SDK 默认会显式传 `--permission-mode default`，**CLI flag 压过 settings 里的 `permissions.defaultMode`**。要继承得用内部选项 `resolvePermissionModeInCli: true`（`sdk.d.ts` 里没有、`sdk.mjs` 里实现了），或自己 `resolveSettings()` + `filterEscalatingDefaultMode()` 算好再显式传。
3. **esbuild 必须 `external`**（**实**）：SDK 是 ESM-first，打进 CJS bundle 会让 esbuild 把 `import.meta.url` 降级成占位对象，而 SDK 靠它定位平台原生二进制——产物一载入就抛 `ERR_INVALID_ARG_VALUE`。所以对话层用运行时动态 `await import()`。
4. **asarUnpack 只解 SDK 主包、平台包整体排除**（**实**，2026-09-23 起）：主包 `**/node_modules/@anthropic-ai/claude-agent-sdk/**`（`sdk.mjs` 是动态 `import()` 的 ESM，要按真实文件路径加载）；平台包 `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**` 从 `build.files` 排除、不进安装包——对话层只认本机 claude（见下一条），自带 CLI 是 237MB 死重。
5. **`pathToClaudeCodeExecutable` 只能指真实可执行文件**（**实**）：npm 无扩展名 shim → `failed to launch`；`claude.cmd` → `spawn EINVAL`（SDK 不启 shell）；`bin\claude.exe` → 成功。找不到就抛可读错误（`chat.ts` 的 `requireLocalClaudeExecutable`，chat_send reject → 前端 toast）——**不再回退 SDK 自带**（2026-09-23 起安装包里没有那份）。
6. **`AbortController` 与 `SpawnOptions.signal` 语义不同**（**型**，d.ts 明确解释）：SDK 故意**不**把调用方的裸 signal 交给 Node `spawn()`——Windows 上那会走 `TerminateProcess`（立即、不可捕获），抢在 SDK 的 stdin-EOF 优雅收尾之前把 CLI 打死。要**立即**信号请捕获自己传给 `abortController` 的那个 controller。本项目的优雅关闭（关 stdin 等 3s 再强杀）正是踩在这条上。
7. **`bun build --compile` 另有坑**：编译成单文件后 `require.resolve` 在虚拟 FS 里失效，得用 `./extract` 的 `extractFromBunfs()` 把二进制解到真实路径再传进去。本项目不用 bun，忽略即可。
8. **alpha / 内部面要当心**：`sessionStore` / `taskBudget` / `importSessionToStore` 标了 `@alpha`；`resolvePermissionModeInCli`、`--permission-prompt-tool` 是**未在 d.ts / `--help` 里正式列出**的面。升级 SDK 或 CLI 时这些是第一批要回归的。
9. **`system/init` 要等第一条用户消息才到**（**实**，2026-09-22 踩到）：spawn 完进程（预热）之后**一条 init / result 都没有**，直到真的发一条消息。推论有两条，都很容易踩：
   - **任何「一启动就显示」的信息必须主动问**，不能挂在 `session_ready` 事件上——`getContextUsage()`（§6.11）是现成的主动通道。
   - 终端状态行（`[model ◐ high] ▏0%`）**一启动就有**，那是因为它是 CLI 自己的 UI、读自己的内存状态；宿主复刻不了这条路，只能走控制请求。
   - 实测日志（预热后）：`prewarm done: process up` 之后**没有**任何 `session_ready`。
10. **`init.effort` 在 SDK 宿主上确实拿不到**（**实**，2026-09-22）：`sdk.d.ts` 自己写着「Present on Remote Control bridge init frames (terminal- / Desktop- / VS Code-hosted sessions); absent on hosts that do not publish it」——我们是 SDK 宿主，实测 composer 里那一项一直空着。**全 SDK 没有任何读取接口**（`getContextUsage()` 与 `initializationResult()` 都不带 `effort`；带它的只有 ① `Options.effort`（可写）② hook 输入 ③ `CLAUDE_EFFORT` 环境变量）。要显示就只能**反过来自己设**（`Options.effort` / `applyFlagSettings({ effortLevel })` / `updateSettings('userSettings', { effortLevel })`——后者就是 `/effort` 那条路，且 `SDKModelInfo` 里有 `supportsEffort` 与可选档位，够搭一个选择器）。
11. **`Query.interrupt()` 是无参的，`cancel_queued` 够不着**（**实**）：CLI 侧的 `cancel_queued: true` 才是「一次点击停掉整个队列」的开关，`interrupt_cancel_queued_v1` 能力位也承认它——但 SDK 没把它暴露出来（`Query` 上也没有 `cancel_async_message` 方法）。**能拿到的只有回执**：`interrupt()` 返回 `{ still_queued: string[], cancelled?: string[] }`，`still_queued` 是「这次中断后仍会执行」的消息 uuid，可据此判断"没停干净"。对话层现在的 `MessageQueue.withdraw()` 只管得住**自己那侧**的队列。
12. **SDK 宿主不会自动得到会话标题**（**实**，2026-09-22）：CLI 的自动起名只在交互式 TUI 里发生，SDK / stream-json 那条路跑完也不写 `ai-title`（标 `origin:{kind:'human'}` 也没用）。宿主不主动问，jsonl 里就永远没有 AI 标题，读会话文件的界面只能退回「首条用户消息」那一档。要标题得自己发 `generateSessionTitle()`（§6.12）。**同一个坑在终端侧还有另一个面**：CLI 自己写进终端 OSC 标题的那条回退链 **不含「首条用户消息」**（`customTitle > aiTitle > 'Claude Code'`），所以没生成 aiTitle 的会话在终端里连兜底名都没有。

## 9. 采用前先跑探针的清单

下面这些是本文里**只看了类型、没跑过**，但一旦采用就需要先验的点（照 `docs/agent-sdk-interactive-tools.md` 的做法：写 `%TEMP%\` 下的独立脚本，不提交）：

> ⚠️ **想造「改模型相关 env」的对照，注入层要选对**（2026-09-25 实测）：
> - ❌ **不管用**：`Options.env` 改/删模型变量、把 `CLAUDE_CONFIG_DIR` 指向改过的 settings.json 副本、`settingSources: []`——四组本该互不相同的对照输出**逐字相同**，说明 CLI 用的仍是真实 `~/.claude/settings.json` 里那份 env。
> - ✅ **管用**：`Options.settings = { env: {...} }`（flag 设置层，优先于 user settings）。用它做**加法**实验即可定位某个变量的作用：塞唯一值 → 看模型表/解析值哪一处跟着变。
> - 判据：**几组对照输出完全一致就先怀疑注入没生效**（我在这个坑里连废了 4 轮对照才反应过来）。
> - 已用该法测出的结论：模型表里那条「自定义模型」= **`ANTHROPIC_MODEL` 的值**（塞 `probe-AAA` 它就逐字变成 `probe-AAA`）；`CLAUDE_CODE_SUBAGENT_MODEL` 不影响模型表；而**表里 `default` 那一行跟的是 opus 槽**（改 `ANTHROPIC_DEFAULT_OPUS_MODEL` 会连带改掉 `default` 的解析值，改 `ANTHROPIC_MODEL` 则不动它）。

1. `getSessionMessages()` 的合并 / usage 口径是否与本项目 `sessions.ts` 一致（§6.6）——**不同就用自家的，别混用**。
2. `startup()` 预热后 `query()` 的 `Options` 是否仍可部分覆盖（cwd / resume 是否被 warm 时定死）。
3. ~~`setModel()` / `setPermissionMode()` 热切的**生效边界**~~ → **2026-09-24 探针已验**（§6.13）：`setModel()` 后 CLI **立即**补发 init（不等下一轮）、`setModel(undefined)` 复位、非法名 reject（供应商 400）。jsonl 的 `permissionMode` 字段一致性仍未单独核对（低风险，`listSessions` 只读它做展示）。
4. ~~`rewindFiles()` 的跟踪范围与自家「变更文件面板」的重合度~~ → **2026-09-24 二次探针已验**（§6.10）：Write 新建 + Edit 修改都在跟踪集，与面板聚合口径一致。
5. ~~`getContextUsage()` 的数值口径~~ → **2026-09-22 已接进对话层并复验**：可用，`kind==='used'` 求和 + `maxTokens` 作分母即得占用率；**只有 `percentage` 的单位没验**（所以对话层不转发它，见 §6.11）。
6. `tool()` + `createSdkMcpServer()` 在**打包后**（asar / unpack）能否正常调用。
