// T1 三项新能力的后端用例（2026-09-24）：模型热切 / 斜杠命令 / 撤销本轮改动。
// 模式照 chat-session.test.ts：mock 掉 SDK，假 Query 上 stub 新方法并记账。
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** query() 收到的 options（断言 enableFileCheckpointing 用） */
  options: null as Record<string, unknown> | null,
  /** setModel / rewindFiles 的调用记账 */
  setModelCalls: [] as (string | undefined)[],
  rewindCalls: [] as { uuid: string; dryRun: boolean }[],
  /** 置真后 rewindFiles 返回「失败」形状（canRewind:false + error） */
  failRewind: false,
  /** 往消息泵里塞一帧（init / result …） */
  push: null as null | ((m: unknown) => void),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (req: { options?: Record<string, unknown> }) => {
    fake.options = req.options ?? null;
    // 最小消息泵：frames 缓冲 + 等待者唤醒（与 MessageQueue 同构）
    const frames: unknown[] = [];
    const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
    fake.push = (m) => {
      frames.push(m);
      while (waiters.length > 0 && frames.length > 0) {
        waiters.shift()!({ value: frames.shift(), done: false });
      }
    };
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            frames.length > 0
              ? Promise.resolve({ value: frames.shift(), done: false })
              : new Promise<IteratorResult<unknown>>((resolve) => {
                  waiters.push(resolve);
                }),
          return: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      supportedModels: async () => [
        { value: "default", resolvedModel: "m-std", displayName: "Default", description: "d" },
        { value: "opus", resolvedModel: "m-big", displayName: "Opus", description: "d" },
      ],
      supportedCommands: async () => [
        { name: "init", description: "初始化", argumentHint: null, aliases: [], builtin: true },
      ],
      setModel: async (m?: string) => {
        fake.setModelCalls.push(m);
      },
      rewindFiles: async (uuid: string, opts?: { dryRun?: boolean }) => {
        fake.rewindCalls.push({ uuid, dryRun: opts?.dryRun === true });
        if (fake.failRewind) {
          return { canRewind: false, error: "every differing file failed to restore" };
        }
        return opts?.dryRun
          ? { canRewind: true, filesChanged: ["a.txt", "b.ts"], insertions: 3, deletions: 1 }
          : { canRewind: true, skippedLinks: 1 };
      },
      getContextUsage: async () => ({
        categories: [{ kind: "used", tokens: 5 }],
        maxTokens: 100,
        model: "m-std",
      }),
      generateSessionTitle: async () => "标题",
    };
    return iterable;
  },
  renameSession: async () => {},
}));

import { ChatManager, buildUserMessage, type ChatEvent } from "./chat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起一个会话并跑完一轮（init + result），返回管理器。
 *  result 带 user_message_uuids: ["u1", "u2"] —— 末位 u2 即「本轮最后一条用户消息」。 */
async function sessionAfterTurn(id: string): Promise<ChatManager> {
  const mgr = new ChatManager(() => {});
  mgr.start(id, { projectPath: process.cwd() });
  await mgr.send(id, "hi");
  fake.push!({
    type: "system",
    subtype: "init",
    session_id: id,
    model: "m-std",
    permissionMode: "default",
    tools: [],
  });
  fake.push!({
    type: "result",
    subtype: "success",
    result: "ok",
    user_message_uuids: ["u1", "u2"],
  });
  await sleep(20);
  return mgr;
}

describe("buildUserMessage 的 uuid（rewindFiles 的锚点）", () => {
  it("每条用户消息都带一个合法 uuid（SDKUserMessage 类型未声明、运行时认的内部面）", () => {
    const a = buildUserMessage("hi", []) as { uuid?: string };
    const b = buildUserMessage("hi", []) as { uuid?: string };
    expect(a.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.uuid).not.toBe(b.uuid); // 每条独立生成，不是常量
  });
});

describe("spawn 选项", () => {
  it("enableFileCheckpointing 恒开（rewindFiles 依赖每轮快照）", async () => {
    await sessionAfterTurn("opt-check");
    expect(fake.options?.enableFileCheckpointing).toBe(true);
  });
});

describe("模型热切（supportedModels / setModel）", () => {
  it("进程没起：supportedModels 返回 null（前端据此禁用选择器）", async () => {
    const mgr = new ChatManager(() => {});
    mgr.start("m0", { projectPath: process.cwd() });
    expect(await mgr.supportedModels("m0")).toBeNull();
  });

  it("起进程后：返回精简条目；setModel 原样透传、null → undefined（复位默认）", async () => {
    fake.setModelCalls = [];
    const mgr = await sessionAfterTurn("m1");
    const models = await mgr.supportedModels("m1");
    expect(models).toEqual([
      { value: "default", resolvedModel: "m-std", displayName: "Default", description: "d" },
      { value: "opus", resolvedModel: "m-big", displayName: "Opus", description: "d" },
    ]);
    await mgr.setModel("m1", "opus");
    await mgr.setModel("m1", null);
    expect(fake.setModelCalls).toEqual(["opus", undefined]);
  });
});

describe("斜杠命令（supportedCommands）", () => {
  it("进程没起返回 null；起后返回精简条目", async () => {
    const idle = new ChatManager(() => {});
    idle.start("c0", { projectPath: process.cwd() });
    expect(await idle.supportedCommands("c0")).toBeNull();

    const mgr = await sessionAfterTurn("c1");
    expect(await mgr.supportedCommands("c1")).toEqual([
      { name: "init", description: "初始化", argumentHint: null, aliases: [], builtin: true },
    ]);
  });
});

describe("撤销本轮改动（rewindLast）", () => {
  it("没起进程 / 没跑完过一轮：返回 null（没有锚点 uuid）", async () => {
    const mgr = new ChatManager(() => {});
    mgr.start("r0", { projectPath: process.cwd() });
    await mgr.send("r0", "hi"); // 进程起了，但还没有 result 帧
    expect(await mgr.rewindLast("r0", true)).toBeNull();
  });

  it("一轮结束后：锚点取 result 帧 user_message_uuids 的**首位**；dryRun 与真回滚各自透传", async () => {
    fake.rewindCalls = [];
    const mgr = await sessionAfterTurn("r1");
    const dry = await mgr.rewindLast("r1", true);
    expect(dry).toEqual({
      canRewind: true,
      filesChanged: ["a.txt", "b.ts"],
      insertions: 3,
      deletions: 1,
      skippedLinks: 0, // dryRun 没给 → 归零
      error: null,
    });
    const real = await mgr.rewindLast("r1", false);
    expect(real).toEqual({
      canRewind: true,
      filesChanged: null, // 真回滚不给清单（CLI 设计），归 null
      insertions: null,
      deletions: null,
      skippedLinks: 1,
      error: null,
    });
    // 两次都以 u1 为锚 —— **首位**是本轮起点。取末位（u2）会漏掉「中途塞进本轮的第二条
    // 消息之前」那些改动，而按钮承诺的是「回滚到该轮开始前」
    expect(fake.rewindCalls).toEqual([
      { uuid: "u1", dryRun: true },
      { uuid: "u1", dryRun: false },
    ]);
  });

  it("CLI 给的 error 要透传（canRewind:false 既可能是没改动、也可能是真的失败）", async () => {
    fake.failRewind = true;
    try {
      const mgr = await sessionAfterTurn("r2");
      const r = await mgr.rewindLast("r2", false);
      expect(r?.canRewind).toBe(false);
      expect(r?.error).toBe("every differing file failed to restore");
    } finally {
      fake.failRewind = false;
    }
  });
});

/** 跑一轮并把**发出的事件**收集下来（上面几个用例只看后端 API 的返回值，这里要看事件流） */
async function eventsForTurn(id: string, frames: unknown[]): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const mgr = new ChatManager((_sid, ev) => events.push(ev));
  mgr.start(id, { projectPath: process.cwd() });
  await mgr.send(id, "hi");
  fake.push!({
    type: "system",
    subtype: "init",
    session_id: id,
    model: "m-std",
    permissionMode: "default",
    tools: [],
  });
  for (const f of frames) fake.push!(f);
  await sleep(20);
  return events;
}

// 2026-09-25 用户实测：app 内发 `/code-review`，界面「思考中…」82 秒无反应。
// 根因是这两类帧此前都落进 translate 的 default 分支被丢掉，而命令型技能整轮跑在
// 子代理里、主流只剩它们 —— 丢掉就等于整段执行期零可渲染内容，看起来是卡死。
describe("斜杠命令与子代理的可见性（command_lifecycle / system/task_*）", () => {
  it("command_lifecycle → command_state（state 原样透传，不再被静默丢弃）", async () => {
    const evs = await eventsForTurn("cmd1", [
      { type: "command_lifecycle", command_uuid: "u1", state: "queued" },
      { type: "command_lifecycle", command_uuid: "u1", state: "started" },
    ]);
    expect(evs.filter((e) => e.type === "command_state")).toEqual([
      { type: "command_state", state: "queued" },
      { type: "command_state", state: "started" },
    ]);
  });

  it("system/local_command → command_output（解出 <local-command-stdout>；空正文不发）", async () => {
    const evs = await eventsForTurn("cmd3", [
      {
        type: "system",
        subtype: "local_command",
        content: "<local-command-stdout>findings 正文</local-command-stdout>",
      },
      // 空正文不该发一条空事件
      { type: "system", subtype: "local_command", content: "<local-command-stdout></local-command-stdout>" },
    ]);
    expect(evs.filter((e) => e.type === "command_output")).toEqual([
      { type: "command_output", text: "findings 正文" },
    ]);
  });

  it("task_* 四帧 → subagent_activity；缺的字段给 null，绝不补 0", async () => {
    const evs = await eventsForTurn("cmd2", [
      { type: "system", subtype: "task_started", task_id: "t1", description: "review" },
      {
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        usage: { total_tokens: 9, tool_uses: 12, duration_ms: 80000 },
        last_tool_name: "Grep",
      },
      // task_updated 只有 patch，没有 usage —— 不能把已记下的数字覆盖成 0
      { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "running" } },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
        summary: "找到 3 个问题",
        usage: { total_tokens: 1, tool_uses: 13, duration_ms: 82000 },
      },
    ]);
    expect(evs.filter((e) => e.type === "subagent_activity")).toEqual([
      { type: "subagent_activity", phase: "started", toolUses: null, durationMs: null, lastTool: null, status: null, summary: null },
      { type: "subagent_activity", phase: "progress", toolUses: 12, durationMs: 80000, lastTool: "Grep", status: null, summary: null },
      { type: "subagent_activity", phase: "progress", toolUses: null, durationMs: null, lastTool: null, status: "running", summary: null },
      { type: "subagent_activity", phase: "done", toolUses: 13, durationMs: 82000, lastTool: null, status: "completed", summary: "找到 3 个问题" },
    ]);
  });
});
