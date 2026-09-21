// 会话管理单元测试（移植自 Rust：session_meta_* / read_head_tail / append_custom_title /
// parse_session_messages_* / slice / validate）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendCustomTitle,
  extractFirstPrompt,
  getSessionMessages,
  listSessions,
  parseContentBlocks,
  parseJsonLines,
  parseSessionMessages,
  readHeadTail,
  renameSession,
  sessionMetaFromLite,
  sliceMessages,
  validateSessionFile,
  MAX_SESSION_MESSAGES,
} from "./sessions";
import { mangleProjectPath } from "./mangle";

const UUID = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";

let tmp: string;
let projects: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-sess-"));
  projects = path.join(tmp, "projects");
  fs.mkdirSync(projects);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 构造一段含标题/消息的 jsonl head 文本 */
function sampleHead(): string {
  return [
    '{"type":"mode","mode":"normal","sessionId":"' + UUID + '"}',
    '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"修复登录页面的 bug"},"timestamp":"2026-08-12T06:47:46.519Z"}',
    '{"type":"ai-title","aiTitle":"修复登录页面","sessionId":"' + UUID + '"}',
    "",
  ].join("\n");
}

describe("sessionMetaFromLite", () => {
  it("customTitle 优先", () => {
    const tail =
      '{"type":"custom-title","customTitle":"手动改的名字","sessionId":"' + UUID + '"}';
    const info = sessionMetaFromLite(sampleHead(), tail, UUID, 1000)!;
    expect(info.title).toBe("手动改的名字");
    expect(info.summary).toBe("手动改的名字");
    expect(info.lastModified).toBe(1000);
  });

  it("回退 aiTitle，摘要回退首条消息", () => {
    const info = sessionMetaFromLite(sampleHead(), "", UUID, 1000)!;
    expect(info.title).toBe("修复登录页面");
    expect(info.summary).toBe("修复登录页面的 bug");
  });

  it("命令后跟普通对话：标题用第一条普通消息", () => {
    const head = [
      '{"type":"mode","mode":"normal","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name><command-args>新建项目</command-args>"},"timestamp":"2026-08-12T06:47:46.519Z"}',
      '{"type":"user","message":{"role":"user","content":"帮我看一下这个项目的结构"},"timestamp":"2026-08-12T06:48:00.000Z"}',
      "",
    ].join("\n");
    const info = sessionMetaFromLite(head, "", "x", 0)!;
    expect(info.title).toBe("帮我看一下这个项目的结构");
    expect(info.summary).toBe("帮我看一下这个项目的结构");
  });

  it("只执行了 /init 的会话：无实质内容 → 不进列表", () => {
    const head = [
      '{"type":"mode","mode":"normal","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":"<command-message>init</command-message>\\n<command-name>/init</command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}',
      "",
    ].join("\n");
    expect(sessionMetaFromLite(head, "", "x", 0)).toBeNull();
    const head2 = [
      '{"type":"mode","mode":"normal","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}',
      "",
    ].join("\n");
    expect(sessionMetaFromLite(head2, "", "x", 0)).toBeNull();
  });

  it("命令内容清洗后为空 → 会话被过滤", () => {
    const head = [
      '{"type":"mode","mode":"normal","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":"<command-name></command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}',
      "",
    ].join("\n");
    expect(sessionMetaFromLite(head, "", "x", 0)).toBeNull();
  });

  it("数组 content 提取 text 块", () => {
    const head = [
      '{"type":"mode","mode":"normal","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"第一段"},{"type":"tool_use","name":"x"}]},"timestamp":"2026-08-12T06:47:46.519Z"}',
      "",
    ].join("\n");
    expect(sessionMetaFromLite(head, "", "x", 0)!.title).toBe("第一段");
  });

  it("sidechain 会话跳过", () => {
    const head =
      '{"parentUuid":null,"isSidechain":true,"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-08-12T06:47:46.519Z"}';
    expect(sessionMetaFromLite(head, "", "x", 0)).toBeNull();
  });

  it("纯元数据会话跳过", () => {
    expect(sessionMetaFromLite('{"type":"mode","mode":"normal","sessionId":"x"}', "", "x", 0)).toBeNull();
  });

  it("同一字段 head 与 tail 都有时取 tail 最后一条", () => {
    const tail = '{"type":"ai-title","aiTitle":"tail 里的新标题","sessionId":"' + UUID + '"}';
    expect(sessionMetaFromLite(sampleHead(), tail, UUID, 0)!.title).toBe("tail 里的新标题");
  });
});

describe("readHeadTail", () => {
  it("小文件 head == tail；大文件 tail 取末尾 64KB", () => {
    const small = path.join(tmp, "a.jsonl");
    fs.writeFileSync(small, sampleHead());
    const s = readHeadTail(small)!;
    expect(s.head).toBe(s.tail);
    expect(s.mtime).toBeGreaterThan(0);

    const big = path.join(tmp, "b.jsonl");
    const filler = "x".repeat(200_000);
    fs.writeFileSync(big, sampleHead() + filler + sampleHead());
    const b = readHeadTail(big)!;
    expect(b.head.length).toBeLessThanOrEqual(64 * 1024);
    expect(b.tail.length).toBeLessThanOrEqual(64 * 1024);
    expect(b.tail).toContain("修复登录页面");
  });

  it("空文件返回 null", () => {
    const empty = path.join(tmp, "e.jsonl");
    fs.writeFileSync(empty, "");
    expect(readHeadTail(empty)).toBeNull();
  });
});

describe("appendCustomTitle / renameSession", () => {
  it("追加 custom-title 行并保留原内容，可再次提取", () => {
    const file = path.join(tmp, UUID + ".jsonl");
    fs.writeFileSync(file, sampleHead());
    appendCustomTitle(file, UUID, "新名字");
    const content = fs.readFileSync(file, "utf8");
    expect(content.startsWith('{"type":"mode"')).toBe(true);
    const last = content.trimEnd().split("\n").pop()!;
    const v = JSON.parse(last);
    expect(v.type).toBe("custom-title");
    expect(v.customTitle).toBe("新名字");
    expect(v.sessionId).toBe(UUID);
    const ht = readHeadTail(file)!;
    expect(sessionMetaFromLite(ht.head, ht.tail, UUID, 0)!.title).toBe("新名字");
  });

  it("特殊字符正确转义为 JSON", () => {
    const file = path.join(tmp, UUID + ".jsonl");
    fs.writeFileSync(file, sampleHead());
    appendCustomTitle(file, UUID, '含"引号"和\\反斜杠');
    const last = fs.readFileSync(file, "utf8").trimEnd().split("\n").pop()!;
    expect(JSON.parse(last).customTitle).toBe('含"引号"和\\反斜杠');
  });

  it("renameSession：路径校验 + 空标题报错", () => {
    const mangled = mangleProjectPath("D:\\proj\\demo");
    const dir = path.join(projects, mangled);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, UUID + ".jsonl");
    fs.writeFileSync(file, sampleHead());
    renameSession(file, "  新  标题\n ", projects);
    const ht = readHeadTail(file)!;
    expect(sessionMetaFromLite(ht.head, ht.tail, UUID, 0)!.title).toBe("新 标题");
    expect(() => renameSession(file, "  \t ", projects)).toThrow("标题不能为空");
    // projects 目录外的文件拒绝
    const outside = path.join(tmp, UUID + ".jsonl");
    fs.writeFileSync(outside, sampleHead());
    expect(() => renameSession(outside, "x", projects)).toThrow(
      "会话文件不在 Claude Code 目录中",
    );
  });
});

describe("validateSessionFile", () => {
  it("uuid.jsonl 通过并返回 id", () => {
    const file = path.join(projects, "D--demo", UUID + ".jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sampleHead());
    expect(validateSessionFile(file, projects).sessionId).toBe(UUID);
  });

  it("非 uuid / 非 jsonl / 越界路径拒绝", () => {
    expect(() => validateSessionFile(path.join(projects, "abc.jsonl"), projects)).toThrow();
    expect(() => validateSessionFile(path.join(projects, UUID), projects)).toThrow();
    // 越界路径走**词法**作用域就拦下（不必碰文件系统，报错也更准）
    expect(() => validateSessionFile(path.join(tmp, UUID + ".jsonl"), projects)).toThrow(
      "会话文件不在 Claude Code 目录中",
    );
  });

  it("目录内的 uuid.jsonl 但文件不存在 → 拒绝（realpath 兜底要求文件真实存在）", () => {
    const file = path.join(projects, "D--demo", UUID + ".jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    expect(() => validateSessionFile(file, projects)).toThrow("会话文件不存在");
  });
});

describe("listSessions", () => {
  it("按 mangle 定位目录、过滤非 uuid、mtime 倒序", () => {
    const dir = path.join(projects, mangleProjectPath("D:\\proj\\demo"));
    fs.mkdirSync(dir, { recursive: true });
    const f1 = path.join(dir, UUID + ".jsonl");
    fs.writeFileSync(f1, sampleHead());
    fs.utimesSync(f1, new Date(1000000), new Date(1000000));
    const f2 = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
    fs.writeFileSync(f2, sampleHead());
    fs.utimesSync(f2, new Date(2000000), new Date(2000000));
    fs.writeFileSync(path.join(dir, "not-a-uuid.jsonl"), sampleHead());
    fs.writeFileSync(path.join(dir, "ignore.txt"), "x");

    const list = listSessions(projects, "D:\\proj\\demo");
    expect(list.map((s) => s.sessionId)).toEqual([
      "11111111-2222-4333-8444-555555555555",
      UUID,
    ]);
    expect(list[0].file).toBe(f2);
    expect(list[0].title).toBe("修复登录页面");
  });

  it("项目目录不存在返回空数组", () => {
    expect(listSessions(projects, "D:\\nope")).toEqual([]);
  });
});

describe("extractFirstPrompt / parseJsonLines", () => {
  it("isMeta 与命令消息被跳过", () => {
    const head = parseJsonLines(
      [
        '{"type":"user","isMeta":true,"message":{"role":"user","content":"系统注入"}}',
        '{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"}}',
        '{"type":"user","message":{"role":"user","content":"正常的对话"}}',
      ].join("\n"),
    );
    expect(extractFirstPrompt(head)).toBe("正常的对话");
  });
});

describe("parseSessionMessages", () => {
  it("提取 text/thinking/tool_use/tool_result 块", () => {
    const jsonl = [
      '{"type":"mode","mode":"normal","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":"你好，帮我看看"},"timestamp":"2026-08-12T06:47:46.519Z"}',
      '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"好的，我来看看"},{"type":"thinking","thinking":"先分析一下"},{"type":"tool_use","id":"toolu_abc","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-08-12T06:47:47.000Z"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file1.txt"}]},"timestamp":"2026-08-12T06:47:47.500Z"}',
      '{"type":"ai-title","aiTitle":"标题","sessionId":"x"}',
      "",
    ].join("\n");
    const r = parseSessionMessages(jsonl);
    expect(r.length).toBe(3);
    expect(r[0].kind).toBe("user");
    expect(r[0].blocks[0].kind).toBe("text");
    expect(r[0].blocks[0].text).toBe("你好，帮我看看");
    expect(r[0].timestamp).toBe("2026-08-12T06:47:46.519Z");
    const m2 = r[1];
    expect(m2.kind).toBe("assistant");
    expect(m2.model).toBe("claude-sonnet-4");
    expect(m2.blocks.map((b) => b.kind)).toEqual(["text", "thinking", "tool_use"]);
    expect(m2.blocks[2].name).toBe("Bash");
    expect(m2.blocks[2].toolUseId).toBe("toolu_abc");
    expect((m2.blocks[2].input as { command: string }).command).toBe("ls");
    expect(r[2].blocks[0].kind).toBe("tool_result");
    expect(r[2].blocks[0].text).toBe("file1.txt");
    expect(r[2].blocks[0].toolUseId).toBe("toolu_1");
  });

  it("isMeta / sidechain / 命令消息全部过滤", () => {
    const jsonl = [
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"系统注入"}}',
      '{"type":"user","isSidechain":true,"message":{"role":"user","content":"子会话"}}',
      '{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"}}',
      '{"type":"user","message":{"role":"user","content":"正常的对话"}}',
      "",
    ].join("\n");
    const r = parseSessionMessages(jsonl);
    expect(r.length).toBe(1);
    expect(r[0].blocks[0].text).toBe("正常的对话");
  });

  it("task-notification 按工具结果展示（<result> 优先，回退 <summary>）", () => {
    const jsonl =
      '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<task-id>a35e</task-id>\\n<tool-use-id>call_ffd1</tool-use-id>\\n<output-file>C:\\\\temp\\\\x.output</output-file>\\n<status>completed</status>\\n<summary>Agent 任务完成</summary>\\n<result>任务完成，共处理 5 个文件\\n- a.ts 已更新</result>\\n</task-notification>"}}\n';
    const r = parseSessionMessages(jsonl);
    expect(r.length).toBe(1);
    expect(r[0].kind).toBe("user");
    const b = r[0].blocks[0];
    expect(b.kind).toBe("tool_result");
    expect(b.toolUseId).toBe("call_ffd1");
    expect(b.text).toContain("任务完成，共处理 5 个文件");
    expect(b.text).toContain("a.ts 已更新");
    expect(b.text).not.toContain("<task-notification>");
    expect(b.text).not.toContain("<summary>");

    const jsonl2 =
      '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<summary>只有摘要</summary>\\n</task-notification>"}}\n';
    expect(parseSessionMessages(jsonl2)[0].blocks[0].text).toBe("只有摘要");
  });

  it("坏行忽略", () => {
    const r = parseSessionMessages(
      '这不是 json\n{"type":"user"}\n{"type":"user","message":{"role":"user","content":"ok"}}\n',
    );
    expect(r.length).toBe(1);
    expect(r[0].blocks[0].text).toBe("ok");
  });

  it("数组 text 拼接与 is_error 保留", () => {
    const jsonl = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"多块"},{"type":"text","text":"拼接"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"出错了"}]}]}}',
      "",
    ].join("\n");
    const r = parseSessionMessages(jsonl);
    expect(r.length).toBe(2);
    expect(r[0].blocks.length).toBe(2);
    expect(r[0].blocks[0].text).toBe("多块");
    expect(r[0].blocks[1].text).toBe("拼接");
    expect(r[1].blocks[0].isError).toBe(true);
    expect(r[1].blocks[0].text).toBe("出错了");
  });
});

describe("sliceMessages / getSessionMessages", () => {
  function bigJsonl(n: number): string {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(`{"type":"user","message":{"role":"user","content":"消息 ${i}"}}`);
    }
    return lines.join("\n") + "\n";
  }

  it("901 条默认取最后 500 条，has_more / offset 正确", () => {
    const all = parseSessionMessages(bigJsonl(MAX_SESSION_MESSAGES + 401));
    expect(all.length).toBe(MAX_SESSION_MESSAGES + 401);
    const r = sliceMessages(all);
    expect(r.hasMore).toBe(true);
    expect(r.total).toBe(MAX_SESSION_MESSAGES + 401);
    expect(r.offset).toBe(401);
    expect(r.messages.length).toBe(MAX_SESSION_MESSAGES);
    expect(r.messages[0].blocks[0].text).toContain("消息 401");
  });

  it("加载更早：offset=0 返回第一页无更多", () => {
    const all = parseSessionMessages(bigJsonl(MAX_SESSION_MESSAGES + 401));
    const r0 = sliceMessages(all, 0);
    expect(r0.hasMore).toBe(false);
    expect(r0.offset).toBe(0);
    expect(r0.messages.length).toBe(MAX_SESSION_MESSAGES);
    expect(r0.messages[0].blocks[0].text).toContain("消息 0");
  });

  it("不足 limit 全部返回；自定义 limit 生效", () => {
    const all = parseSessionMessages(bigJsonl(100));
    const small = sliceMessages(all);
    expect(small.hasMore).toBe(false);
    expect(small.messages.length).toBe(100);
    const rl = sliceMessages(parseSessionMessages(bigJsonl(200)), 100, 50);
    expect(rl.offset).toBe(100);
    expect(rl.messages.length).toBe(50);
    expect(rl.messages[0].blocks[0].text).toContain("消息 100");
  });

  it("getSessionMessages：文件校验 + 分页", () => {
    const file = path.join(projects, "D--demo", UUID + ".jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bigJsonl(600));
    const page = getSessionMessages(file, projects);
    expect(page.messages.length).toBe(500);
    expect(page.total).toBe(600);
    expect(page.hasMore).toBe(true);
    const earlier = getSessionMessages(file, projects, 0);
    expect(earlier.messages.length).toBe(500);
    expect(earlier.hasMore).toBe(false);
  });
});

describe("parseContentBlocks", () => {
  it("thinking 块从 thinking 字段取文本", () => {
    const blocks = parseContentBlocks([{ type: "thinking", thinking: "想一想" }], "assistant");
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe("thinking");
    expect(blocks[0].text).toBe("想一想");
  });

  it("image 块带出 mediaType 与 base64 数据（查看器与导出都靠它）", () => {
    const blocks = parseContentBlocks(
      [
        { type: "text", text: "看这张图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ],
      "user",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["text", "image"]);
    expect(blocks[1].mediaType).toBe("image/png");
    expect(blocks[1].data).toBe("aGVsbG8=");
  });

  it("非 base64 来源（url 等）不产 image 块", () => {
    const blocks = parseContentBlocks(
      [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
      "user",
    );
    expect(blocks).toEqual([]);
  });

  it("空壳 image 块（缺 media_type / data）不产块——否则导出会多一行图片占位", () => {
    // v2.0.0 要求 source.media_type 与 source.data 都非空（lib.rs:1723-1736）
    expect(parseContentBlocks([{ type: "image", source: { type: "base64" } }], "user")).toEqual([]);
    expect(
      parseContentBlocks(
        [{ type: "image", source: { type: "base64", media_type: "image/png" } }],
        "user",
      ),
    ).toEqual([]);
    expect(parseContentBlocks([{ type: "image" }], "user")).toEqual([]);
  });

  it("多个 image 块都保留（纯图消息 → 只有 image 块）", () => {
    const blocks = parseContentBlocks(
      [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Ag==" } },
      ],
      "user",
    );
    expect(blocks.length).toBe(2);
    expect(blocks[1].mediaType).toBe("image/jpeg");
  });
});
