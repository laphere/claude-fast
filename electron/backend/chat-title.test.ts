// 新会话的 AI 标题：
// 老 CLI（2.1.278 时代）的自动起名只发生在交互式 TUI 里（2026-09-22 实测：SDK/stream-json
// 那条路跑完一轮也不写 ai-title），app 内对话得自己发 `generate_session_title` 控制请求。
// **2026-09-27 订正（CLI 2.1.283）**：SDK 会话 CLI 也会自动落 ai-title 了，但首轮任何
// 时点问都**秒回 null**（resolve、不落盘、不花模型调用），第二轮 init 之后问才正常返回。
// 所以编排变成：首轮 init 问一次（老 CLI 此时直接成功），回 null 下一轮 init 补问一次
// （封顶 2 次）。⚠️ 补问的档位按**轮**发放：同一轮内可能来多帧 init（切模型会让 CLI
// 立即补发一帧），那些帧既不重复问、也不占预算——所以本文件的假 CLI 以 `frames`
// 逐帧描述「什么时候是新一轮」（`result` 即轮末）。这里 mock 掉 SDK 验证这一圈：
// 问的时机与次数、带的是首条用户文本、persist:true（要落进 jsonl）、成功推 session_title
// 事件、null 重试、同轮多帧不重问、续聊不问、失败不炸。
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** 收到的起名请求（描述 + persist） */
  titles: [] as Array<{ desc: string; persist?: boolean }>,
  /** 前 N 次调用秒回 null（2.1.283：会话还没有可起名的内容时） */
  nullTitles: 0,
  /** 起名是否失败（测降级路径） */
  failTitle: false,
  /** 挂住起名不放（测「起名中」那个窗口 / 并发去重） */
  holdTitle: false,
  releaseTitle: null as null | (() => void),
  /** 放行挂起的首帧 init（真实的 CLI 是处理完首条用户消息后才发它） */
  releaseInit: null as null | (() => void),
  /** 逐帧脚本：'init' = 轮首（init 每轮开头发一帧）、'result' = 轮末。
   *  「新一轮」由 result 划出——起名的补问档位正是按它算的（见 chat.ts 的 roundIndex）。 */
  frames: ["init", "init"] as Array<"init" | "result">,
  /** 逐帧脚本走到过几个 result（= 已收尾几轮）：2.1.283 下起名的放行闸门。 */
  resultsSeen: 0,
  /** 2.1.283 的真实行为：**首轮内**任何时点问都秒回 null（与第几次问无关）。
   *  这条分辨得出「按轮发档」与「按帧计数」——后者会在首轮内的多帧 init 上把
   *  两次预算都烧光（补问永不发生）。 */
  nullWhileFirstRound: false,
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
            if (step <= fake.frames.length) {
              // 只有**第一帧**挂起等放行——模拟「首条消息已入队并被处理」。
              // 后续帧随拉随放：for-await 是串行拉的，第二帧在被拉取时才登记闸，
              // releaseInit 的批放行根本等不到它——「第二帧 init 到来触发补问」这条
              // 路径就永远测不到（2026-09-27 null 补问用例实测踩过）。
              const kind = fake.frames[step - 1];
              if (kind === "result") fake.resultsSeen++;
              const frame: IteratorResult<unknown> = {
                value:
                  kind === "init"
                    ? {
                        type: "system",
                        subtype: "init",
                        session_id: "s1",
                        permissionMode: "default",
                      }
                    : // result = 轮末（turn_end + status idle，见 translateResult）
                      { type: "result", subtype: "success", session_id: "s1", result: "ok" },
                done: false,
              };
              if (step === 1) {
                return new Promise<IteratorResult<unknown>>((resolve) => {
                  gates.push(() => resolve(frame));
                });
              }
              return Promise.resolve(frame);
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
        // null 分支放在 hold/fail 之前：真实的秒回 null 不吃挂起、也不该走到失败分支
        if (fake.nullWhileFirstRound && fake.resultsSeen === 0) return null;
        if (fake.nullTitles > 0) {
          fake.nullTitles--;
          return null;
        }
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
  fake.nullTitles = 0;
  fake.failTitle = false;
  fake.holdTitle = false;
  fake.releaseTitle = null;
  fake.releaseInit = null;
  fake.frames = ["init", "init"];
  fake.resultsSeen = 0;
  fake.nullWhileFirstRound = false;
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

  it("同一轮内的多帧 init（切模型会给同轮补发一帧）不重复问、也不占补问预算", async () => {
    // 首轮三帧 init（其中两帧是切模型补发的）、轮末 result、第二轮再一帧。
    // ⚠️ 2.1.283 的 null 判据是**轮**不是次数（首轮内问几次都回 null），所以「按帧计数」
    // 的旧实现会在首轮把两次预算一起烧光、第二轮那帧被封顶挡掉 → 一个标题都拿不到。
    fake.nullWhileFirstRound = true;
    fake.frames = ["init", "init", "init", "result", "init"];
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "第一次说话");
    await mgr.send("s1", "第二次说话");
    fake.releaseInit?.();

    // 只问两次（首轮那一帧 + 第二轮那一帧），第二问答上并推给前端
    await vi.waitFor(() => expect(titlesOf(events)).toEqual(["构建脚本提速"]));
    await sleep(50);
    expect(fake.titles.length).toBe(2);
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
    fake.frames = ["init"]; // 只送一帧 init：别让补问掺进来（那不在本用例的关注点里）
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

  it("CLI 秒回 null（2.1.283 首轮）不算终态：下一轮 init 补问一次，成功推标题", async () => {
    fake.nullTitles = 1;
    fake.frames = ["init", "result", "init"]; // 两轮：补问在第二轮的 init
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "第一次说话");
    fake.releaseInit?.();

    // 首轮 init 问了（null），第二轮 init 补问——共两次
    await vi.waitFor(() => expect(fake.titles.length).toBe(2));
    expect(fake.titles[0]).toEqual({ desc: "第一次说话", persist: true });
    await vi.waitFor(() => expect(titlesOf(events)).toEqual(["构建脚本提速"]));

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("两次都回 null 就封顶：第三轮的 init 也不再问、不推事件", async () => {
    fake.nullTitles = 3;
    fake.frames = ["init", "result", "init", "result", "init"];
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "第一次说话");
    fake.releaseInit?.();

    await vi.waitFor(() => expect(fake.titles.length).toBe(2));
    await sleep(50); // 再等一拍：第三轮 init 已到，也不该问第三遍
    expect(fake.titles.length).toBe(2);
    expect(titlesOf(events)).toEqual([]);

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("补问在飞时撞上下一轮 init：不并发再问（白花一次调用 + 可能落两条 ai-title）", async () => {
    fake.holdTitle = true; // 第一次问挂住不放（慢的起名模型）
    fake.frames = ["init", "result", "init"]; // 第二轮 init 恰好在第一次问还没回来时到
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "帮我看看这个 bug");
    fake.releaseInit?.();

    await vi.waitFor(() => expect(fake.titles.length).toBe(1));
    await sleep(50); // 第二轮 init 已到：在飞期间不得再问
    expect(fake.titles.length).toBe(1);
    fake.releaseTitle?.();
    await vi.waitFor(() => expect(titlesOf(events)).toEqual(["构建脚本提速"]));

    fake.finish?.();
    await mgr.close("s1", 200);
  });

  it("补问期间不再从列表摘掉（titlePending 只挂第一次问——兜底标题多半已亮出来）", async () => {
    fake.nullTitles = 1; // 第一次问秒回 null
    fake.holdTitle = true; // 第二次问（真实模型调用，在下一轮 init）挂住
    fake.frames = ["init", "result", "init"];
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "帮我看看这个 bug");
    fake.releaseInit?.();

    await vi.waitFor(() => expect(fake.titles.length).toBe(2)); // 补问已发出、被挂住
    expect([...mgr.titlePendingIds()]).toEqual([]); // 不摘：避免列表「先显示又消失」
    fake.releaseTitle?.();
    await vi.waitFor(() => expect(titlesOf(events)).toEqual(["构建脚本提速"]));
    expect([...mgr.titlePendingIds()]).toEqual([]);

    fake.finish?.();
    await mgr.close("s1", 200);
  });
});
