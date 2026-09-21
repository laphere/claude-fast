// 关会话的优雅退出窗口（对应 docs/chat-behavior-spec.md §2 B6）：
// mock 掉 SDK，验证「先关 stdin 等进程自己收尾，超过窗口才 abort 强杀」。
// 早先是 queue.end() 后同一个 tick 直接 abort，等于流式中途砍掉子进程。
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** SDK 收到的 AbortController（我们传进去的那个），用来断言有没有被强杀 */
  abort: null as AbortSignal | null,
  /** 让「子进程」退出：resolve 掉挂起的 next()，for-await 随之结束 */
  finish: null as null | (() => void),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  // 注意入参形状：SDK 的 query 收的是 `{ prompt, options }`（options 里才有 abortController）
  query: (req: { options?: { abortController?: AbortController } }) => {
    fake.abort = req.options?.abortController?.signal ?? null;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          // 模拟常驻进程：一直挂起，直到测试调用 finish()（= CLI 收尾退出）
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              fake.finish = () => resolve({ value: undefined, done: true });
            }),
          return: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
    };
    return iterable;
  },
  renameSession: async () => {},
}));

import { ChatManager } from "./chat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 让「子进程」退出。（走一层函数是为了绕开 TS 对 `fake.finish = null` 之后的收窄） */
function exitProcess(): void {
  (fake.finish as null | (() => void))?.();
}

function newManager(): { mgr: ChatManager; events: { type: string }[] } {
  const events: { type: string }[] = [];
  const mgr = new ChatManager((_sid, e) => events.push(e as { type: string }));
  return { mgr, events };
}

describe("ChatSession 优雅关闭", () => {
  it("进程自己退出时不强杀（窗口内等它收尾落盘）", async () => {
    fake.finish = null;
    const { mgr, events } = newManager();
    mgr.start("s1", { projectPath: process.cwd() });
    await mgr.send("s1", "hi");
    expect(fake.abort).not.toBeNull();

    const closing = mgr.close("s1", 2000);
    await sleep(20);
    expect(fake.abort?.aborted).toBe(false); // 还在等，没有强杀

    exitProcess();
    await closing;
    expect(fake.abort?.aborted).toBe(false); // 优雅退出：整个过程都没动 abort
    expect(events.map((e) => e.type)).toContain("exited");
  });

  it("进程赖着不退 → 超过窗口强杀", async () => {
    fake.finish = null;
    const { mgr } = newManager();
    mgr.start("s2", { projectPath: process.cwd() });
    await mgr.send("s2", "hi");

    let done = false;
    const closing = mgr.close("s2", 30).then(() => {
      done = true;
    });
    await sleep(15);
    expect(done).toBe(false); // 窗口内还没返回
    await sleep(60);
    await closing;
    expect(done).toBe(true);
    expect(fake.abort?.aborted).toBe(true); // 超时才强杀
  });

  it("closeAll：整体超时后仍不退出的直接强杀", async () => {
    fake.finish = null;
    const { mgr } = newManager();
    mgr.start("s3", { projectPath: process.cwd() });
    await mgr.send("s3", "hi");

    let done = false;
    const all = mgr.closeAll(20, 5000).then(() => {
      done = true;
    });
    await sleep(60);
    await all;
    expect(done).toBe(true);
    expect(fake.abort?.aborted).toBe(true);
  });

  it("从未启动过的会话：close 直接返回，不等窗口", async () => {
    const { mgr } = newManager();
    mgr.start("s4", { projectPath: process.cwd() });
    const t0 = Date.now();
    await mgr.close("s4", 10_000);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
