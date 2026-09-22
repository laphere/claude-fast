// 新会话的 AI 标题：
// CLI 的自动起名**只发生在交互式 TUI 里**（2026-09-22 实测 2.1.278：SDK/stream-json
// 那条路跑完一轮也不写 ai-title，给用户消息加 origin:{kind:"human"} 同样不写），
// 所以 app 内对话得自己发 `generate_session_title` 控制请求。这里 mock 掉 SDK，
// 验证 ChatSession 那一圈的编排：首帧 init 一到问一次、带的是首条用户文本、
// persist:true（要落进 jsonl）、成功推 session_title 事件、续聊不问、失败不炸。
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** 收到的起名请求（描述 + persist） */
  titles: [] as Array<{ desc: string; persist?: boolean }>,
  /** 起名是否失败（测降级路径） */
  failTitle: false,
  /** 挂住起名不放（测「起名中」那个窗口：list_sessions 会据此不列这条会话） */
  holdTitle: false,
  releaseTitle: null as null | (() => void),
  /** 放行挂起的 init 帧（真实的 CLI 是处理完首条用户消息后才发它） */
  releaseInit: null as null | (() => void),
  /** 送几帧 init（真实 CLI 每轮开头都发一帧） */
  initFrames: 2,
  /** 让「子进程」退出 */
  finish: null as null | (() => void),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    const gates: Array<() => void> = [];
    let step = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            step++;
            if (step <= fake.initFrames) {
              // init 帧先挂起，等测试放行——模拟「这条消息已经入队并被处理」
              return new Promise<IteratorResult<unknown>>((resolve) => {
                gates.push(() =>
                  resolve({
                    value: {
                      type: "system",
                      subtype: "init",
                      session_id: "s1",
                      permissionMode: "default",
                    },
                    done: false,
                  }),
                );
              });
            }
            // 之后常驻挂起，直到测试调用 finish()
            return new Promise<IteratorResult<unknown>>((resolve) => {
              fake.finish = () => resolve({ value: undefined, done: true });
            });
          },
          return: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      // 给个可用读数，免得 pullContextUsageSoon 走「失败→800ms 重试」留下挂起定时器
      getContextUsage: async () => ({
        categories: [{ kind: "used", tokens: 100 }],
        maxTokens: 200000,
      }),
      generateSessionTitle: async (desc: string, o?: { persist?: boolean }) => {
        fake.titles.push({ desc, persist: o?.persist });
        if (fake.holdTitle) await new Promise<void>((r) => (fake.releaseTitle = r));
        if (fake.failTitle) throw new Error("title model unavailable");
        return "构建脚本提速";
      },
    };
    fake.releaseInit = () => {
      for (const g of gates) g();
      gates.length = 0;
    };
    return iterable;
  },
  renameSession: async () => {},
}));

import { ChatManager, type ChatEvent } from "./chat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newManager(): { mgr: ChatManager; events: ChatEvent[] } {
  const events: ChatEvent[] = [];
  const mgr = new ChatManager((_sid, e) => events.push(e));
  return { mgr, events };
}

const titlesOf = (events: ChatEvent[]): string[] =>
  events
    .filter((e): e is ChatEvent & { type: "session_title" } => e.type === "session_title")
    .map((e) => e.title);

beforeEach(() => {
  fake.titles = [];
  fake.failTitle = false;
  fake.holdTitle = false;
  fake.releaseTitle = null;
  fake.releaseInit = null;
  fake.initFrames = 2;
  fake.finish = null;
});

describe("新会话 AI 标题", () => {
  it("init 一到就问一次，带首条用户文本 + persist，起好的标题推给前端", async () => {
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "帮我把构建脚本改快一点");
    fake.releaseInit?.();

    await vi.waitFor(() => expect(fake.titles.length).toBe(1));
    expect(fake.titles[0]).toEqual({ desc: "帮我把构建脚本改快一点", persist: true });
    // 推给前端（App 据此改 tab 名 + 刷左栏那条）
    await vi.waitFor(() => expect(titlesOf(events)).toEqual(["构建脚本提速"]));

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("init 每轮都发（这里两帧），也只问一次、描述仍是首条文本", async () => {
    const { mgr } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "第一次说话");
    await mgr.send("s1", "第二次说话");
    fake.releaseInit?.();

    await vi.waitFor(() => expect(fake.titles.length).toBe(1));
    await sleep(50); // 再等一拍：两帧 init 都在，第二帧不该再问一次
    expect(fake.titles.length).toBe(1);
    expect(fake.titles[0].desc).toBe("第一次说话");

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("续聊（--resume）不问标题：历史会话不补", async () => {
    const { mgr, events } = newManager();
    mgr.start("s1", {
      projectPath: process.cwd(),
      resumeId: "afc29ea3-0000-4000-8000-000000000000",
    });
    await mgr.send("s1", "接着说");
    fake.releaseInit?.();
    await sleep(50);
    expect(fake.titles).toEqual([]);
    expect(titlesOf(events)).toEqual([]);

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("纯图首条消息（无文本）不问标题", async () => {
    const { mgr } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "", [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
    fake.releaseInit?.();
    await sleep(50);
    expect(fake.titles).toEqual([]);

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("起名失败不炸：退回兜底标题推一次（别让 tab 永远挂着项目名）", async () => {
    fake.failTitle = true;
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "帮我看个问题");
    fake.releaseInit?.();

    await vi.waitFor(() => expect(fake.titles.length).toBe(1));
    await vi.waitFor(() => expect(titlesOf(events)).toEqual(["帮我看个问题"]));

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("起名期间挂进 titlePendingIds（list_sessions 据此先不列这条），拿到即摘掉", async () => {
    fake.holdTitle = true;
    const { mgr } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "帮我看看这个 bug");

    // 还没起名（init 都没放行）→ 不在名单里
    expect([...mgr.titlePendingIds()]).toEqual([]);

    fake.releaseInit?.();
    await vi.waitFor(() => expect([...mgr.titlePendingIds()]).toEqual(["s1"]));
    // 拿到标题（成功或失败都算）必须摘掉，否则这条会话会一直不出现在左栏
    fake.releaseTitle?.();
    await vi.waitFor(() => expect([...mgr.titlePendingIds()]).toEqual([]));

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("续聊不进 titlePendingIds（根本不起名，列表照常列）", async () => {
    const { mgr } = newManager();
    mgr.start("s1", {
      projectPath: process.cwd(),
      resumeId: "afc29ea3-0000-4000-8000-000000000000",
    });
    await mgr.send("s1", "接着说");
    fake.releaseInit?.();
    await sleep(50);
    expect([...mgr.titlePendingIds()]).toEqual([]);

    fake.finish?.();
    await mgr.close("s1", 200);
  });
});
