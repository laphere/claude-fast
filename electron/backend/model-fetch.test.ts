// 模型列表单元测试（对齐 v2.0.0 model_fetch.rs 测试）。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelsUrlCandidates,
  fetchModels,
  parseModelsResponse,
  type FetchedModel,
} from "./model-fetch";

/** 造一个最小 Response 替身（用到 status / ok / body.getReader——读取走流式限长） */
function fakeResp(status: number, body: string): Response {
  const bytes = Buffer.from(body, "utf8");
  let sent = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader: () => ({
        read: async () =>
          sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes }),
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildModelsUrlCandidates", () => {
  it("普通 base 追加 /v1/models（结尾斜杠被修剪）", () => {
    expect(buildModelsUrlCandidates("https://api.example.com")).toEqual([
      "https://api.example.com/v1/models",
    ]);
    expect(buildModelsUrlCandidates("https://api.example.com/")).toEqual([
      "https://api.example.com/v1/models",
    ]);
  });

  it("版本段结尾拼 /models（/v1 只给 /models；paas/v4 给兜底）", () => {
    expect(buildModelsUrlCandidates("https://api.example.com/v1")).toEqual([
      "https://api.example.com/v1/models",
    ]);
    expect(buildModelsUrlCandidates("https://open.bigmodel.cn/api/coding/paas/v4")).toEqual([
      "https://open.bigmodel.cn/api/coding/paas/v4/models",
      "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
    ]);
  });

  it("兼容后缀追加剥离后的根路径（去重生效）", () => {
    expect(buildModelsUrlCandidates("https://api.moonshot.cn/anthropic")).toEqual([
      "https://api.moonshot.cn/anthropic/v1/models",
      "https://api.moonshot.cn/v1/models",
      "https://api.moonshot.cn/models",
    ]);
    const c = buildModelsUrlCandidates("https://x.example.com/api/coding");
    expect(new Set(c).size).toBe(c.length);
  });

  it("空地址报错", () => {
    expect(() => buildModelsUrlCandidates("  ")).toThrow();
  });
});

describe("parseModelsResponse", () => {
  it("提取并按 id 排序去重（重复项 ownedBy 丢弃）", () => {
    const body = JSON.stringify({
      data: [
        { id: "claude-b", owned_by: "zhipu" },
        { id: "claude-a" },
        { id: "claude-a", owned_by: "other" },
        { object: "model" },
      ],
    });
    const models = parseModelsResponse(body);
    expect(models.length).toBe(2);
    expect(models[0].id).toBe("claude-a");
    expect(models[0].ownedBy).toBeUndefined();
    expect(models[1].id).toBe("claude-b");
    expect(models[1].ownedBy).toBe("zhipu");
  });

  it("缺 data / 非法 JSON 报错", () => {
    expect(() => parseModelsResponse(JSON.stringify({ error: "nope" }))).toThrow();
    expect(() => parseModelsResponse("not json")).toThrow();
  });
});

describe("fetchModels", () => {
  it("404/405 换下一候选，命中即解析", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return fakeResp(404, "");
        return fakeResp(200, JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
      }),
    );
    // 三个候选：第 1 个 404 → 第 2 个命中
    const models = await fetchModels("https://api.moonshot.cn/anthropic", "sk");
    expect(models.map((m: FetchedModel) => m.id)).toEqual(["a", "b"]);
    expect(calls).toBe(2);
  });

  it("405 同样换候选", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return fakeResp(405, "");
        return fakeResp(200, JSON.stringify({ data: [{ id: "x" }] }));
      }),
    );
    const models = await fetchModels("https://api.moonshot.cn/anthropic", "sk");
    expect(models[0].id).toBe("x");
  });

  it("非 404/405 立即失败（不换候选）", async () => {
    const fn = vi.fn(async () => fakeResp(500, "boom"));
    vi.stubGlobal("fetch", fn);
    await expect(fetchModels("https://api.example.com/v1", "sk")).rejects.toThrow(/HTTP 500/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("网络错误立即失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(fetchModels("https://api.example.com/v1", "sk")).rejects.toThrow(/网络错误/);
  });
});
