import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LEDGER_VERSION,
  aggregateStatsLedger,
  betterUsageRow,
  buildUsageStats,
  clearUsageCache,
  loadLedger,
  localDateOf,
  nodeFs,
  saveLedger,
  scanFileUsage,
  isoToEpochMs,
  usageJsonlFiles,
  type LedgerEntry,
  type ProjectRef,
  type StatsLedger,
  type UsageRow,
} from "./usage-stats";
import { beforeEach, describe, expect, it } from "vitest";

// 工具：创建临时目录（不碰真实 ~/.claude）
function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `usagestats-${prefix}-`));
}

function row(p: Partial<UsageRow>): UsageRow {
  return {
    finalRow: false,
    tokens: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    model: "m",
    date: null,
    ...p,
  };
}

function entry(p: Partial<LedgerEntry> & { perDay: Record<string, [number, number]> }): LedgerEntry {
  return {
    mtime: 0,
    size: 0,
    sessionId: "s1",
    projectDir: "D--proj",
    projectName: "proj",
    projectPath: "D:/proj",
    messages: 1,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    perModel: {},
    perDayModel: {},
    ...p,
  };
}

beforeEach(() => clearUsageCache());

describe("better_usage_row 代表行取舍", () => {
  it("只有中间行：取 token 更大者", () => {
    const a = row({ finalRow: false, tokens: 100 });
    const b = row({ finalRow: false, tokens: 50 });
    expect(betterUsageRow(a, b)).toBe(true); // 新行 token 大 → 取代
    expect(betterUsageRow(b, a)).toBe(false); // 新行 token 小 → 保留旧
  });

  it("只有收尾行：同为收尾取 token 更大者", () => {
    const a = row({ finalRow: true, tokens: 100 });
    const b = row({ finalRow: true, tokens: 200 });
    expect(betterUsageRow(b, a)).toBe(true);
    expect(betterUsageRow(a, b)).toBe(false);
  });

  it("中间行 vs 收尾行：收尾行优先（即使 token 更小）", () => {
    // 收尾行（stop_reason）是最终值，不能让 token 更大的中间行覆盖它
    const finalRow = row({ finalRow: true, tokens: 120 });
    const biggerIntermediate = row({ finalRow: false, tokens: 999 });
    expect(betterUsageRow(finalRow, biggerIntermediate)).toBe(true);
    expect(betterUsageRow(biggerIntermediate, finalRow)).toBe(false);
  });
});

describe("本地时区归属", () => {
  it("UTC 16:00 的消息在东八区跨日到次日", () => {
    // 2026-08-17T16:00:00Z = 本地(UTC+8) 次日 00:00
    const ms = isoToEpochMs("2026-08-17T16:00:00.000Z") ?? 0;
    expect(localDateOf(ms, 0)).toBe("2026-08-17");
    expect(localDateOf(ms, 480)).toBe("2026-08-18");
  });

  it("scanFileUsage 按本地时区把跨日消息归属到不同日期", () => {
    const jsonl = [
      `{"type":"assistant","message":{"id":"a","role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":100,"output_tokens":1}},"timestamp":"2026-08-17T16:00:00.000Z"}`,
      `{"type":"assistant","message":{"id":"b","role":"assistant","content":[{"type":"text","text":"y"}],"usage":{"input_tokens":200,"output_tokens":2}},"timestamp":"2026-08-17T02:00:00.000Z"}`,
    ].join("\n");
    const utc = scanFileUsage(jsonl, 0);
    expect(utc.perDay.size).toBe(1);
    const cst = scanFileUsage(jsonl, 480);
    expect(cst.perDay.size).toBe(2); // 02:00+8h=10:00 归 17 日；16:00+8h=次日 00:00 归 18 日
    expect(cst.perDay.get("2026-08-18")![0]).toBe(101);
    expect(cst.perDay.get("2026-08-17")![0]).toBe(202);
  });
});

describe("<synthetic> 占位消息排除", () => {
  it("synthetic 不进消息计数与模型分布", () => {
    const jsonl = [
      `{"type":"assistant","message":{"id":"s","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}],"usage":{"input_tokens":0,"output_tokens":0}},"timestamp":"2026-08-12T06:00:00.000Z"}`,
      `{"type":"assistant","message":{"id":"r","role":"assistant","model":"glm-5.3","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}},"timestamp":"2026-08-12T07:00:00.000Z"}`,
    ].join("\n");
    const u = scanFileUsage(jsonl, 0);
    expect(u.messages).toBe(1);
    expect(u.tokens).toBe(15);
    expect(u.perModel.has("<synthetic>")).toBe(false);
    expect(u.perModel.get("glm-5.3")![0]).toBe(15);
    expect(u.perDayModel.get("2026-08-12")!.has("<synthetic>")).toBe(false);
  });
});

describe("每日会话数按最后活跃日（跨天会话只计一次）", () => {
  it("跨两天的一个会话：只计到最后活跃日，窗口累加 = 去重会话数", () => {
    const e = entry({
      sessionId: "cross-day",
      perDay: { "2026-08-12": [202, 1], "2026-08-13": [101, 1] },
      tokens: 303,
      messages: 2,
    });
    const stats = buildUsageStats([e]);
    expect(stats.sessions).toBe(1); // 一个会话，不随跨天虚增
    const d12 = stats.perDay.find((d) => d.date === "2026-08-12")!;
    const d13 = stats.perDay.find((d) => d.date === "2026-08-13")!;
    // 最后活跃日是 08-13 → 只有那天计 sessions；两天都算 activeSessions
    expect(d12.sessions).toBe(0);
    expect(d12.activeSessions).toBe(1);
    expect(d13.sessions).toBe(1);
    expect(d13.activeSessions).toBe(1);
    // 任意窗口内每日 sessions 累加 = 窗口内去重会话数（=1）
    expect(d12.sessions + d13.sessions).toBe(stats.sessions);
  });
});

describe("台账命中 / LEDGER_VERSION / 时区变化 / mtime+size 跳过", () => {
  const sid = "aaaaaaaa-1111-4111-8111-111111111111";

  function makeProject(): { root: string; file: string; content: string } {
    const root = tmpDir("ledger");
    const proj = path.join(root, "D--proj");
    fs.mkdirSync(path.join(proj, sid), { recursive: true });
    const file = path.join(proj, `${sid}.jsonl`);
    // 文件真实内容：tokens = 101（input 100 + output 1）
    const content = `{"type":"assistant","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"x"}],"model":"m1","usage":{"input_tokens":100,"output_tokens":1}},"timestamp":"2026-08-12T06:00:00.000Z"}`;
    fs.writeFileSync(file, content);
    return { root, file, content };
  }

  it("mtime+size 未变 → 台账命中跳过重扫（用台账旧值，文件内容变化不影响）", () => {
    const { root, file } = makeProject();
    const st = fs.statSync(file)!;
    const ledger: StatsLedger = {
      version: LEDGER_VERSION,
      tzOffsetMinutes: 0,
      files: {
        [file]: entry({
          sessionId: sid,
          mtime: st.mtimeMs,
          size: st.size,
          tokens: 999, // 故意与文件真实值不同：命中即不应重扫
          messages: 5,
          perDay: { "2026-08-12": [999, 5] },
          perModel: { m1: [999, 5] },
          perDayModel: { "2026-08-12": { m1: [999, 5] } },
        }),
      },
    };
    const projects: ProjectRef[] = [{ name: "proj", path: "D:/proj", dir: path.join(root, "D--proj") }];
    const stats = aggregateStatsLedger(projects, [], 0, ledger, nodeFs);
    // 命中台账 → 用旧值 999，而非文件扫描的 101
    expect(stats.tokens).toBe(999);
    expect(stats.messages).toBe(5);
  });

  it("LEDGER_VERSION 不一致 → 全量重扫，取文件真实值", () => {
    const { root, file } = makeProject();
    const st = fs.statSync(file)!;
    const ledger: StatsLedger = {
      version: 0, // 旧版本，触发重扫
      tzOffsetMinutes: 0,
      files: {
        [file]: entry({
          sessionId: sid,
          mtime: st.mtimeMs,
          size: st.size,
          tokens: 999,
          messages: 5,
          perDay: { "2026-08-12": [999, 5] },
          perModel: { m1: [999, 5] },
          perDayModel: { "2026-08-12": { m1: [999, 5] } },
        }),
      },
    };
    const projects: ProjectRef[] = [{ name: "proj", path: "D:/proj", dir: path.join(root, "D--proj") }];
    const stats = aggregateStatsLedger(projects, [], 0, ledger, nodeFs);
    expect(stats.tokens).toBe(101); // 重扫后取文件真实值
    expect(stats.messages).toBe(1);
    expect(ledger.version).toBe(LEDGER_VERSION);
    // 重扫后台账条目补齐了 perDayModel（与 perDay 同块写入）
    expect(ledger.files[file].perDayModel["2026-08-12"].m1[0]).toBe(101);
  });

  it("时区变化 → 全量重扫", () => {
    const { root, file } = makeProject();
    const st = fs.statSync(file)!;
    const ledger: StatsLedger = {
      version: LEDGER_VERSION,
      tzOffsetMinutes: 0, // 与本次调用的 480 不同 → 重扫
      files: {
        [file]: entry({
          sessionId: sid,
          mtime: st.mtimeMs,
          size: st.size,
          tokens: 999,
          messages: 5,
          perDay: { "2026-08-12": [999, 5] },
          perModel: { m1: [999, 5] },
          perDayModel: { "2026-08-12": { m1: [999, 5] } },
        }),
      },
    };
    const projects: ProjectRef[] = [{ name: "proj", path: "D:/proj", dir: path.join(root, "D--proj") }];
    const stats = aggregateStatsLedger(projects, [], 480, ledger, nodeFs);
    expect(stats.tokens).toBe(101); // 重扫取文件真实值
    expect(ledger.tzOffsetMinutes).toBe(480);
  });

  it("台账读写 round-trip（stats-ledger.json）", () => {
    const root = tmpDir("ledgerio");
    const ledger: StatsLedger = {
      version: LEDGER_VERSION,
      tzOffsetMinutes: 480,
      files: {
        "/x.jsonl": entry({ sessionId: sid, tokens: 7, messages: 1, perDay: { "2026-08-12": [7, 1] }, perDayModel: { "2026-08-12": { m1: [7, 1] } } }),
      },
    };
    saveLedger(root, ledger, nodeFs);
    const loaded = loadLedger(root, nodeFs);
    expect(loaded.version).toBe(LEDGER_VERSION);
    expect(loaded.tzOffsetMinutes).toBe(480);
    expect(loaded.files["/x.jsonl"].tokens).toBe(7);
    expect(loaded.files["/x.jsonl"].perDayModel["2026-08-12"].m1[0]).toBe(7);
  });
});

describe("三层扫描范围（subagents / workflows 计入且归属父会话）", () => {
  const sid = "bbbbbbbb-2222-4222-8222-222222222222";

  it("主会话 + subagents + workflows/wf_* 被计入，且都归属父会话 id", () => {
    const root = tmpDir("scan");
    const proj = path.join(root, "D--work-alpha");
    const sub = path.join(proj, sid, "subagents");
    const wf = path.join(sub, "workflows", "wf_1");
    fs.mkdirSync(wf, { recursive: true });
    fs.mkdirSync(path.join(proj, "memory"), { recursive: true });
    fs.mkdirSync(path.join(proj, sid, "tool-results"), { recursive: true });

    const line = (tokens: number, ts: string) =>
      `{"type":"assistant","message":{"id":"m${tokens}","role":"assistant","content":[{"type":"text","text":"x"}],"model":"deepseek-v4.1-flash","usage":{"input_tokens":${tokens},"output_tokens":1}},"timestamp":"${ts}"}`;

    // 4 个应被计入的文件（全部 sessionId = sid）
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), line(100, "2026-08-12T01:00:00.000Z"));
    fs.writeFileSync(path.join(proj, "journal.jsonl"), line(7, "2026-08-12T01:00:00.000Z")); // 顶层非 uuid → 不计
    fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), line(50, "2026-08-12T02:00:00.000Z"));
    fs.writeFileSync(path.join(sub, "journal.jsonl"), line(9, "2026-08-12T02:00:00.000Z")); // subagents 内 → 计入
    fs.writeFileSync(path.join(wf, "agent-b2.jsonl"), line(25, "2026-08-12T03:00:00.000Z"));
    fs.writeFileSync(path.join(proj, sid, "tool-results", "r1.jsonl"), line(3, "2026-08-12T03:00:00.000Z")); // 不在 subagents → 不计
    fs.writeFileSync(path.join(proj, "memory", "m.jsonl"), line(3, "2026-08-12T03:00:00.000Z")); // memory → 不计

    const files = usageJsonlFiles(proj, nodeFs);
    // 计入：主 <sid>.jsonl、subagents/agent-a1.jsonl、subagents/journal.jsonl、workflows/wf_1/agent-b2.jsonl
    expect(files.length).toBe(4);
    for (const f of files) expect(f.sessionId).toBe(sid); // 全部归属父会话

    // 端到端聚合：4 个文件各 1 条消息 → sessions=1（不虚增），tokens 累加
    const ledger: StatsLedger = { version: 0, tzOffsetMinutes: 0, files: {} };
    const projects: ProjectRef[] = [{ name: "work-alpha", path: "D:/work-alpha", dir: proj }];
    const stats = aggregateStatsLedger(projects, [], 0, ledger, nodeFs);
    expect(stats.sessions).toBe(1);
    expect(stats.messages).toBe(4);
    // 计入的 4 个文件各含 output_tokens:1：101 + 51 + 10 + 26 = 188
    // （顶层 journal 7、tool-results 3、memory 3 被排除）
    expect(stats.tokens).toBe(188);
    expect(stats.perModel[0].tokens).toBe(188);
  });
});

describe("excluded 项目不计（含其台账历史）", () => {
  it("retain 阶段移除被排除项目的台账条目", () => {
    const ledger: StatsLedger = {
      version: LEDGER_VERSION,
      tzOffsetMinutes: 0,
      files: {
        "/excluded.jsonl": entry({
          sessionId: "ex",
          projectDir: "D--excluded",
          projectPath: "D:/excluded",
          tokens: 500,
          messages: 3,
          perDay: { "2026-08-12": [500, 3] },
        }),
        "/kept.jsonl": entry({
          sessionId: "kept",
          projectDir: "D--kept",
          projectPath: "D:/kept",
          tokens: 10,
          messages: 1,
          perDay: { "2026-08-12": [10, 1] },
        }),
      },
    };
    // 无现存项目（不新增扫描），仅验证排除 retain
    const stats = aggregateStatsLedger([], ["D:\\excluded"], 0, ledger, nodeFs);
    expect(stats.tokens).toBe(10); // 被排除的历史 500 被剔除
    expect(Object.keys(ledger.files)).toEqual(["/kept.jsonl"]);
  });
});
