// Coding Plan 用量查询单元测试（对齐 v2.0.0 usage_query.rs 测试）。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectVendor,
  extractResetTime,
  millisToIso8601,
  parseKimiTiers,
  parseMinimaxTiers,
  parseOpencodeGoTiers,
  parseZenmuxTiers,
  parseZhipuTokenTiers,
  queryUsage,
} from "./usage-query";

function fakeResp(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  } as unknown as Response;
}

/** 带真实流式 body 的替身（httpGetJson 走 readCapped，读的是 resp.body 而不是 text()） */
function fakeStreamResp(status: number, body: string, chunkBytes = 64 * 1024): Response {
  const bytes = Buffer.from(body, "utf8");
  let off = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader: () => ({
        read: async () => {
          if (off >= bytes.length) return { done: true, value: undefined };
          const value = bytes.subarray(off, Math.min(off + chunkBytes, bytes.length));
          off += value.byteLength;
          return { done: false, value };
        },
        cancel: async () => {
          off = bytes.length;
        },
      }),
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectVendor", () => {
  it("命中已知厂商域名", () => {
    expect(detectVendor("https://api.kimi.com/coding/")).toBe("kimi");
    expect(detectVendor("https://open.bigmodel.cn/api/anthropic")).toBe("zhipu");
    expect(detectVendor("https://api.z.ai/api/anthropic")).toBe("zhipu");
    expect(detectVendor("https://api.minimaxi.com/anthropic")).toBe("minimax");
    expect(detectVendor("https://api.minimax.io/anthropic")).toBe("minimax");
    expect(detectVendor("https://zenmux.ai/api/xxx")).toBe("zenmux");
    expect(detectVendor("https://opencode.ai/zen/go/v1")).toBe("opencode_go");
  });
  it("普通中转不命中", () => {
    expect(detectVendor("https://api.moonshot.cn/anthropic")).toBeNull();
    expect(detectVendor("https://api.anthropic.com")).toBeNull();
  });
});

describe("millisToIso8601 / extractResetTime", () => {
  it("转换正确且秒级自动升位", () => {
    expect(millisToIso8601(1_790_000_000_000)).toBe("2026-09-21T14:13:20.000Z");
    expect(millisToIso8601(0)).toBeNull();
    expect(millisToIso8601(-5)).toBeNull();
    expect(extractResetTime(1_790_000_000)).toBe("2026-09-21T14:13:20.000Z");
    expect(extractResetTime("2026-09-07T12:00:00Z")).toBe("2026-09-07T12:00:00Z");
    expect(extractResetTime(0)).toBeNull();
  });
});

describe("parseKimiTiers", () => {
  it("5 小时 + 周窗口（字符串数字也能解析）", () => {
    const body = {
      limits: [{ detail: { limit: 100.0, remaining: 62.5, resetTime: "2026-09-07T12:00:00Z" } }],
      usage: { limit: "200", remaining: 40.0, resetTime: 1_790_000_000_000 },
    };
    const tiers = parseKimiTiers(body);
    expect(tiers.length).toBe(2);
    expect(tiers[0].name).toBe("five_hour");
    expect(tiers[0].utilization).toBeCloseTo(37.5);
    expect(tiers[0].resetsAt).toBe("2026-09-07T12:00:00Z");
    expect(tiers[1].name).toBe("weekly_limit");
    expect(tiers[1].utilization).toBeCloseTo(80.0);
  });
});

describe("parseZhipuTokenTiers", () => {
  it("unit 字段优先于时间排序", () => {
    const data = {
      limits: [
        { type: "TOKENS_LIMIT", unit: 6, percentage: 40.0, nextResetTime: 1000 },
        { type: "TOKENS_LIMIT", unit: 3, percentage: 70.0, nextResetTime: 2000 },
      ],
    };
    const tiers = parseZhipuTokenTiers(data);
    expect(tiers.length).toBe(2);
    expect(tiers[0].name).toBe("five_hour");
    expect(tiers[0].utilization).toBeCloseTo(70.0);
    expect(tiers[1].name).toBe("weekly_limit");
    expect(tiers[1].utilization).toBeCloseTo(40.0);
  });
  it("unit 缺失走 reset 升序兜底", () => {
    const data = {
      limits: [
        { type: "TOKENS_LIMIT", percentage: 10.0, nextResetTime: 5000 },
        { type: "TOKENS_LIMIT", percentage: 90.0 },
      ],
    };
    const tiers = parseZhipuTokenTiers(data);
    expect(tiers[0].name).toBe("five_hour");
    expect(tiers[0].utilization).toBeCloseTo(90.0);
    expect(tiers[0].resetsAt).toBeNull();
    expect(tiers[1].name).toBe("weekly_limit");
  });
  it("忽略非 TOKENS/CREDIT 限额", () => {
    const data = { limits: [{ type: "PROMPT_LIMIT", unit: 3, percentage: 50.0 }] };
    expect(parseZhipuTokenTiers(data)).toEqual([]);
  });
});

describe("parseMinimaxTiers", () => {
  it("只取 general 且周桶 status=3 不展示", () => {
    const body = {
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: "video", current_interval_remaining_percent: 0.0 },
        {
          model_name: "general",
          current_interval_remaining_percent: 62.5,
          end_time: 1_790_000_000_000,
          current_weekly_status: 3,
          current_weekly_remaining_percent: 100.0,
        },
      ],
    };
    const tiers = parseMinimaxTiers(body);
    expect(tiers.length).toBe(1);
    expect(tiers[0].name).toBe("five_hour");
    expect(tiers[0].utilization).toBeCloseTo(37.5);
  });
  it("周桶 status=1 激活", () => {
    const body = {
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 100.0,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 30.0,
          weekly_end_time: 1_795_000_000_000,
        },
      ],
    };
    const tiers = parseMinimaxTiers(body);
    expect(tiers.length).toBe(2);
    expect(tiers[1].name).toBe("weekly_limit");
    expect(tiers[1].utilization).toBeCloseTo(70.0);
  });
});

describe("parseZenmuxTiers", () => {
  it("百分比 0-1 ×100 且带 $ 金额", () => {
    const data = {
      quota_5_hour: { usage_percentage: 0.375, resets_at: "2026-09-07T15:00:00Z", used_value_usd: 4.5, max_value_usd: 12.0 },
      quota_7_day: { usage_percentage: "0.8", used_value_usd: 24.0, max_value_usd: 30.0 },
    };
    const tiers = parseZenmuxTiers(data);
    expect(tiers.length).toBe(2);
    expect(tiers[0].utilization).toBeCloseTo(37.5);
    expect(tiers[0].usedValueUsd).toBe(4.5);
    expect(tiers[1].utilization).toBeCloseTo(80.0);
  });
});

describe("parseOpencodeGoTiers", () => {
  it("三窗口 + percent=0 丢弃重置时间", () => {
    const body = {
      usage: {
        rolling: { status: "ok", percent: 37, resetsAt: "2026-09-07T13:00:00Z" },
        weekly: { status: "ok", percent: 62, resetsAt: "2026-09-10T13:00:00Z" },
        monthly: { status: "rate-limited", percent: 0, resetsAt: "2099-01-01T00:00:00Z" },
      },
    };
    const tiers = parseOpencodeGoTiers(body);
    expect(tiers.length).toBe(3);
    expect(tiers[0].name).toBe("five_hour");
    expect(tiers[0].utilization).toBeCloseTo(37);
    expect(tiers[1].name).toBe("weekly_limit");
    expect(tiers[2].resetsAt).toBeNull();
  });
});

describe("queryUsage", () => {
  it("非已知厂商返回 supported=false（不发请求）", async () => {
    const r = await queryUsage("https://api.anthropic.com", "sk");
    expect(r.supported).toBe(false);
    expect(r.success).toBe(false);
  });

  it("401/403 统一报认证失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResp(401, "")),
    );
    const r = await queryUsage("https://api.kimi.com/coding", "bad");
    expect(r.supported).toBe(true);
    expect(r.success).toBe(false);
    expect(r.error).toContain("认证失败");
  });

  it("智谱：解析 body.data 信封（漏解包会退化成「响应形态不认识」）", async () => {
    const envelope = {
      code: 200,
      msg: "成功",
      success: true,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, percentage: 70, nextResetTime: 1_790_000_000_000 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12, nextResetTime: 1_790_500_000_000 },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeStreamResp(200, JSON.stringify(envelope))),
    );
    const r = await queryUsage("https://open.bigmodel.cn/api/anthropic", "sk-zhipu");
    expect(r.supported).toBe(true);
    expect(r.vendor).toBe("zhipu");
    expect(r.error).toBeNull();
    expect(r.data.length).toBe(2);
    expect(r.data[0].name).toBe("five_hour");
    expect(r.data[0].utilization).toBeCloseTo(70);
    expect(r.data[1].name).toBe("weekly_limit");
  });

  it("2xx 走流式读体（readCapped 的路径被覆盖）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeStreamResp(200, "{}")),
    );
    const r = await queryUsage("https://api.kimi.com/coding", "sk");
    expect(r.supported).toBe(true);
    // 读到的是合法 JSON，只是没有可识别的用量字段 → 形态不认识（而不是解析失败）
    expect(r.success).toBe(false);
    expect(r.error).toContain("响应形态不认识");
  });

  it("响应体超过上限：读完上限即停，不整段吃内存、不 hang", async () => {
    // 12MB 全是 'x'（非 JSON）：若没有限长，这里会先读满 12MB 再解析失败
    const huge = "x".repeat(12 * 1024 * 1024);
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const base = fakeStreamResp(200, huge) as unknown as {
          body: { getReader: () => Record<string, unknown> };
        };
        const reader = base.body.getReader();
        return {
          ...base,
          body: {
            getReader: () => ({
              ...reader,
              cancel: async () => {
                cancelled = true;
              },
            }),
          },
        } as unknown as Response;
      }),
    );
    const r = await queryUsage("https://api.kimi.com/coding", "sk");
    expect(cancelled).toBe(true); // 读完上限后中止了读取
    expect(r.success).toBe(false);
    expect(r.error).toContain("响应解析失败"); // 截断后的内容不是合法 JSON
  });
});
