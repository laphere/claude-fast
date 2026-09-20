// 会话域增强命令单元测试（不读真实 ~/.claude，全部用临时目录造 fixture）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  searchSessionMessages,
  getSessionUserPrompts,
  exportSession,
  renderSessionMarkdown,
  purgeClaudeProjectData,
  listPinnedSessions,
  MAX_SEARCH_HITS,
  type SessionMessage,
} from "./session-extra";
import { mangleProjectPath } from "./mangle";

const UUID_A = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";
const UUID_B = "0f3c6dd8-7a12-4b3e-9c5a-1d2e3f4a5b6c";
const UUID_C = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

let tmp: string;
let projects: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-extra-"));
  projects = path.join(tmp, "projects");
  fs.mkdirSync(projects);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 把一条 Claude Code 会话行写成 JSONL（type 即 role，content 可为字符串或块数组） */
function line(type: "user" | "assistant", content: unknown, model?: string): string {
  return JSON.stringify({
    type,
    message: { role: type, content },
    timestamp: "2026-08-12T06:47:46.519Z",
    ...(model ? { model } : {}),
  });
}

function writeSession(uuid: string, lines: string[]): string {
  const p = path.join(projects, uuid + ".jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// 1. 搜索：跳过 thinking / tool_result，命中 text + tool_use 输入
// ---------------------------------------------------------------------------
describe("searchSessionMessages", () => {
  it("跳过 thinking 与 tool_result，只命中 text 与 tool_use 输入", () => {
    const p = writeSession(UUID_A, [
      line("user", "find needle here"),
      line("assistant", [{ type: "thinking", thinking: "needle in thought" }]),
      line("assistant", [{ type: "tool_result", content: "needle in result", tool_use_id: "t1" }]),
      line("assistant", [{ type: "tool_use", name: "Grep", id: "t1", input: { pattern: "needle" } }], "claude-opus"),
    ]);
    const hits = searchSessionMessages(p, "needle", projects);
    expect(hits.length).toBe(2);
    expect(hits[0].index).toBe(0);
    expect(hits[0].kind).toBe("user");
    expect(hits[0].snippet).toContain("needle");
    expect(hits[0].snippet).not.toContain("\n");
    // 第 4 条是 tool_use（index=3），命中其 input
    expect(hits[1].index).toBe(3);
    expect(hits[1].snippet).toContain("needle");
  });

  it("大小写不敏感", () => {
    const p = writeSession(UUID_A, [line("user", "Find NEEDLE here")]);
    expect(searchSessionMessages(p, "needle", projects).length).toBe(1);
  });

  it("空关键词返回空", () => {
    const p = writeSession(UUID_A, [line("user", "anything")]);
    expect(searchSessionMessages(p, "   ", projects)).toEqual([]);
  });

  it("命中上限为 MAX_SEARCH_HITS (200)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(line("user", `line ${i} needle`));
    const p = writeSession(UUID_A, lines);
    const hits = searchSessionMessages(p, "needle", projects);
    expect(hits.length).toBe(MAX_SEARCH_HITS);
  });

  it("路径穿越被拒（文件在 projectsDir 之外直接抛错）", () => {
    const outside = path.join(tmp, UUID_A + ".jsonl");
    fs.writeFileSync(outside, line("user", "needle"), "utf8");
    expect(() => searchSessionMessages(outside, "needle", projects)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. 用户发言提取：跳过命令消息
// ---------------------------------------------------------------------------
describe("getSessionUserPrompts", () => {
  it("跳过命令消息（含标记/中断提示），返回可定位的 index", () => {
    const p = writeSession(UUID_A, [
      line("user", "真实问题 A"),
      // 带 command-message 标记的文本块：消息会被 parse 收录，但须被显式跳过
      line("user", [{ type: "text", text: "<command-message>/init</command-message> 初始化" }]),
      line("assistant", [{ type: "text", text: "助手回复" }]),
      line("user", [{ type: "text", text: "<local-command-stdout>done</local-command-stdout> 收尾" }]),
      line("user", "真实问题 B"),
      line("user", "[Request interrupted by user]"),
    ]);
    const prompts = getSessionUserPrompts(p, projects);
    expect(prompts.length).toBe(2);
    expect(prompts[0].index).toBe(0);
    expect(prompts[0].text).toBe("真实问题 A");
    expect(prompts[1].index).toBe(4);
    expect(prompts[1].text).toBe("真实问题 B");
    expect(prompts[0].timestamp).toBe("2026-08-12T06:47:46.519Z");
  });

  it("无用户发言时返回空", () => {
    const p = writeSession(UUID_A, [line("assistant", "only assistant")]);
    expect(getSessionUserPrompts(p, projects)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 导出：Markdown 四种块形态 / JSONL 字节数
// ---------------------------------------------------------------------------
describe("renderSessionMarkdown", () => {
  const msgs: SessionMessage[] = [
    { kind: "user", blocks: [{ kind: "text", text: "Hello world" }], timestamp: "2026-08-12T06:47:46.519Z" },
    {
      kind: "assistant",
      model: "claude-opus-4",
      blocks: [
        { kind: "thinking", text: "deep thought" },
        { kind: "tool_use", name: "Grep", input: { pattern: "foo" }, toolUseId: "t1" },
        { kind: "tool_result", text: "y".repeat(250), toolUseId: "t1" },
        { kind: "image" },
      ],
    },
  ];

  it("四种块形态：text 原样 / thinking 引用块 / tool_use 摘要 / tool_result 截断 200 / image 占位", () => {
    const md = renderSessionMarkdown(msgs, "我的会话");
    expect(md).toContain("# 我的会话");
    expect(md).toContain("Hello world");
    expect(md).toContain("> 💭 思考过程（省略）");
    expect(md).toContain("🔧 Grep · foo");
    // tool_result 用 tool_use_id 反查到工具名 Grep，并截断到 200 字符 + …
    expect(md).toMatch(/📄 Grep 结果：y{200}…/);
    expect(md).toContain("🖼️ [图片]");
  });

  it("标题缺省回退「未命名会话」", () => {
    const md = renderSessionMarkdown(msgs, "");
    expect(md).toContain("# 未命名会话");
  });
});

describe("exportSession", () => {
  it("jsonl 原样复制，返回字节数（含多字节字符）", () => {
    const content = '{"type":"user"}\n{"中文":"内容"}\n';
    const p = writeSession(UUID_A, [content.trim()]);
    const dest = path.join(tmp, "out.jsonl");
    const bytes = exportSession(p, dest, "jsonl", projects);
    expect(bytes).toBe(Buffer.from(content, "utf8").length);
    expect(fs.readFileSync(dest, "utf8")).toBe(content);
  });

  it("markdown 导出解析标题并写入文件", () => {
    const p = writeSession(UUID_A, [
      '{"type":"ai-title","aiTitle":"我的标题","sessionId":"' + UUID_A + '"}',
      line("user", "正文内容"),
    ]);
    const dest = path.join(tmp, "out.md");
    exportSession(p, dest, "markdown", projects);
    expect(fs.readFileSync(dest, "utf8")).toContain("# 我的标题");
  });

  it("导出目标不能是会话文件本身（大小写不敏感）", () => {
    const p = writeSession(UUID_A, [line("user", "x")]);
    expect(() => exportSession(p, p.toUpperCase(), "jsonl", projects)).toThrow();
  });

  it("不支持的格式抛错", () => {
    const p = writeSession(UUID_A, [line("user", "x")]);
    expect(() => exportSession(p, path.join(tmp, "o.txt"), "pdf", projects)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. 清除失效项目数据
// ---------------------------------------------------------------------------
describe("purgeClaudeProjectData", () => {
  it("删除真实路径已消失的项目目录，返回删除数", () => {
    const deadPath = "D:\\dead\\proj";
    const deadDir = path.join(projects, mangleProjectPath(deadPath));
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(path.join(deadDir, UUID_A + ".jsonl"), "{}");
    const removed = purgeClaudeProjectData([deadPath], projects);
    expect(removed).toBe(1);
    expect(fs.existsSync(deadDir)).toBe(false);
  });

  it("真实路径仍存活的项目跳过不删", () => {
    const alivePath = path.join(tmp, "alive-proj");
    fs.mkdirSync(alivePath);
    const aliveDir = path.join(projects, mangleProjectPath(alivePath));
    fs.mkdirSync(aliveDir, { recursive: true });
    const removed = purgeClaudeProjectData([alivePath], projects);
    expect(removed).toBe(0);
    expect(fs.existsSync(aliveDir)).toBe(true);
  });

  it("只删精确同名目录，相似名字兄弟目录无恙", () => {
    const dirProj = path.join(projects, mangleProjectPath("Proj"));
    const dirProj2 = path.join(projects, mangleProjectPath("Proj2"));
    fs.mkdirSync(dirProj, { recursive: true });
    fs.mkdirSync(dirProj2, { recursive: true });
    const removed = purgeClaudeProjectData(["Proj"], projects);
    expect(removed).toBe(1);
    expect(fs.existsSync(dirProj)).toBe(false);
    expect(fs.existsSync(dirProj2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. 置顶会话清单：顺序保持 + 缺失文件静默跳过
// ---------------------------------------------------------------------------
describe("listPinnedSessions", () => {
  function writePinned(uuid: string, title: string): string {
    const p = path.join(projects, uuid + ".jsonl");
    fs.writeFileSync(
      p,
      [
        line("user", "首条发言"),
        '{"type":"custom-title","customTitle":"' + title + '","sessionId":"' + uuid + '"}',
      ].join("\n") + "\n",
      "utf8",
    );
    return p;
  }

  it("按清单顺序实时解析；缺失文件静默跳过", () => {
    const fileA = writePinned(UUID_A, "标题A");
    const fileB = writePinned(UUID_B, "标题B");
    const missing = path.join(projects, UUID_C + ".jsonl");
    const pins = [
      { file: fileB, projectPath: "P2" }, // 故意把 B 排在 A 前
      { file: fileA, projectPath: "P1" },
      { file: missing, projectPath: "P3" },
    ];
    const out = listPinnedSessions(projects, pins);
    expect(out.length).toBe(2);
    expect(out[0].file).toBe(fileB);
    expect(out[0].title).toBe("标题B");
    expect(out[0].projectPath).toBe("P2");
    expect(out[1].file).toBe(fileA);
    expect(out[1].title).toBe("标题A");
    expect(out[1].projectPath).toBe("P1");
    expect(typeof out[0].lastModified).toBe("number");
  });

  it("非 jsonl / 非 uuid 文件名条目被跳过", () => {
    const fileA = writePinned(UUID_A, "标题A");
    const pins = [
      { file: fileA, projectPath: "P1" },
      { file: path.join(projects, "notes.txt"), projectPath: "P2" },
    ];
    const out = listPinnedSessions(projects, pins);
    expect(out.length).toBe(1);
    expect(out[0].file).toBe(fileA);
  });
});
