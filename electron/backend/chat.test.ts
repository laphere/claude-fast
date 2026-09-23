// 翻译层 + 纯函数单测（不启真实 CLI 进程）。
// 覆盖：文本增量 / 思考块 / tool_use / tool_result / can_use_tool 请求→应答 /
// ExitPlanMode 分流 / result 收尾 / 错误消息 / 图片消息拼装 / 权限模式映射 /
// >4.5MB 图片被拒 / system init / 默认权限档解析。

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SdkMessageTranslator,
  buildControlRequestEvent,
  buildPermissionResult,
  buildUserMessage,
  parseUsage,
  toSdkPermissionMode,
  fromSdkPermissionMode,
  normalizeDefaultMode,
  defaultPermissionMode,
  pickClaudeFromPathOutput,
  requireLocalClaudeExecutable,
  NO_LOCAL_CLAUDE_MESSAGE,
  titleDescriptionFor,
  TITLE_DESCRIPTION_MAX,
  ChatManager,
  type SDKMessage,
  type ChatImage,
} from "./chat";

// 任意可当 SDKMessage 传入（translate 内部只按字段读取，不强校验类型）
function msg(obj: Record<string, unknown>): SDKMessage {
  return obj as unknown as SDKMessage;
}

describe("文本增量（stream_event）", () => {
  it("message_start + text 增量 + stop → status/thinking/content_start/delta", () => {
    const t = new SdkMessageTranslator();
    const out = [
      ...t.translate(msg({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } })),
      ...t.translate(
        msg({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }),
      ),
      ...t.translate(
        msg({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } } }),
      ),
      ...t.translate(msg({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })),
    ];
    expect(out).toEqual([
      { type: "status", state: "thinking" },
      { type: "content_start", kind: "text" },
      { type: "delta", kind: "text", text: "你好" },
      // text 块 stop 不再发事件
    ]);
  });
});

describe("思考块（stream_event）", () => {
  it("thinking_delta → content_start(thinking)/delta(thinking)", () => {
    const t = new SdkMessageTranslator();
    const out = [
      ...t.translate(
        msg({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }),
      ),
      ...t.translate(
        msg({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我想想" } } }),
      ),
      ...t.translate(msg({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })),
    ];
    expect(out).toEqual([
      { type: "content_start", kind: "thinking" },
      { type: "delta", kind: "thinking", text: "让我想想" },
    ]);
  });
});

describe("tool_use", () => {
  it("tool_use_start + 累计 input_json + complete", () => {
    const t = new SdkMessageTranslator();
    const out = [
      ...t.translate(
        msg({
          type: "stream_event",
          event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } },
        }),
      ),
      ...t.translate(
        msg({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' } } }),
      ),
      ...t.translate(msg({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })),
    ];
    expect(out).toEqual([
      { type: "tool_use_start", toolUseId: "t1", name: "Bash" },
      // tool_input 增量也照发：协议里有这个 kind（v2.0.0 的 ChatEvent 同款），
      // 前端 ChatView 明确忽略它（"tool input 由 tool_use_complete 整体呈现"）
      { type: "delta", kind: "tool_input", text: '{"cmd":"ls"}' },
      { type: "tool_use_complete", toolUseId: "t1", name: "Bash", input: { cmd: "ls" } },
    ]);
  });

  it("input_json 非法时降级空对象", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(
      msg({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    );
    // 没有对应 content_block_start，blocks 里没有 → 不产出
    expect(out).toEqual([]);
  });
});

describe("tool_result（user 消息）", () => {
  it("字符串 content → tool_result", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(
      msg({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] } }),
    );
    expect(out).toEqual([{ type: "tool_result", toolUseId: "t1", isError: false, text: "ok" }]);
  });

  it("块数组 content → 拼接文本", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(
      msg({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "行1" }, { type: "text", text: "行2" }] },
          ],
        },
      }),
    );
    expect(out).toEqual([{ type: "tool_result", toolUseId: "t1", isError: true, text: "行1\n行2" }]);
  });
});

describe("can_use_tool 请求→应答", () => {
  it("普通工具 → permission_request", () => {
    const ev = buildControlRequestEvent("r1", "Bash", { cmd: "ls" });
    expect(ev).toEqual({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { cmd: "ls" } });
  });
});

describe("ExitPlanMode 分流", () => {
  it("有 plan 字段 → plan_approval", () => {
    const ev = buildControlRequestEvent("r2", "ExitPlanMode", { plan: "# 方案\n改 X" });
    expect(ev).toEqual({ type: "plan_approval", requestId: "r2", plan: "# 方案\n改 X" });
  });

  it("缺 plan 字段 → plan 空串（前端回退占位）", () => {
    const ev = buildControlRequestEvent("r3", "ExitPlanMode", {});
    expect(ev).toEqual({ type: "plan_approval", requestId: "r3", plan: "" });
  });

  it("翻译层 control_request(can_use_tool) 同样分流", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(
      msg({ type: "control_request", request_id: "r9", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "P" } } }),
    );
    expect(out).toEqual([{ type: "plan_approval", requestId: "r9", plan: "P" }]);
  });
});

describe("result 收尾", () => {
  it("success → turn_end + status idle（usage 解析）", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(
      msg({
        type: "result",
        subtype: "success",
        result: "完成",
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      }),
    );
    expect(out).toEqual([
      { type: "turn_end", isError: false, resultText: "完成", usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 }, contextWindow: null },
      { type: "status", state: "idle" },
    ]);
  });

  it("contextWindow 取 modelUsage 里 input 用量最大的那条（子代理会各占一条）", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(
      msg({
        type: "result",
        subtype: "success",
        result: "完成",
        is_error: false,
        usage: { input_tokens: 1 },
        modelUsage: {
          "claude-haiku-x": { inputTokens: 20, contextWindow: 200000 },
          "deepseek-v4.1-flash[1m]": { inputTokens: 900, contextWindow: 1000000 },
        },
      }),
    );
    expect(out[0]).toMatchObject({ type: "turn_end", contextWindow: 1000000 });
  });

  it("contextWindow 缺失 / 非正数 → null（前端据此不显示百分比）", () => {
    const t = new SdkMessageTranslator();
    expect(t.translate(msg({ type: "result", subtype: "success", is_error: false, modelUsage: { m: { inputTokens: 5 } } }))[0]).toMatchObject({ contextWindow: null });
    expect(t.translate(msg({ type: "result", subtype: "success", is_error: false, modelUsage: { m: { inputTokens: 5, contextWindow: 0 } } }))[0]).toMatchObject({ contextWindow: null });
  });

  it("error_during_execution → isError true", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(msg({ type: "result", subtype: "error_during_execution", result: "", errors: ["boom"] }));
    expect(out[0]).toMatchObject({ type: "turn_end", isError: true });
  });
});

describe("错误消息", () => {
  it("control_response error 子类型 → error 事件", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(msg({ type: "control_response", response: { subtype: "error", error: "拒绝" } }));
    expect(out).toEqual([{ type: "error", message: "CLI 拒绝请求：拒绝" }]);
  });

  it("control_response 非 error → 静默", () => {
    const t = new SdkMessageTranslator();
    expect(t.translate(msg({ type: "control_response", response: { subtype: "success" } }))).toEqual([]);
  });
});

describe("system init", () => {
  it("init → session_ready（permissionMode 'default' 原样带出）", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(msg({ type: "system", subtype: "init", session_id: "s1", model: "claude-x", permissionMode: "default" }));
    expect(out).toEqual([{ type: "session_ready", sessionId: "s1", model: "claude-x", permissionMode: "default", effort: null }]);
  });

  it("init 带 effort → 原样带出；不带 → null（CLI 只在 Remote Control 类宿主上发这个字段）", () => {
    const t = new SdkMessageTranslator();
    expect(
      t.translate(msg({ type: "system", subtype: "init", session_id: "s1", model: "m", effort: "high" })),
    ).toMatchObject([{ effort: "high" }]);
    expect(
      t.translate(msg({ type: "system", subtype: "init", session_id: "s1", model: "m" })),
    ).toMatchObject([{ effort: null }]);
  });
});

describe("权限模式变化（system/status）", () => {
  // 实测（2026-09-22 探针）：进计划模式 / 批准 ExitPlanMode 时，CLI 在**同一刻**发一帧
  // status，permissionMode 就是新档位。底部模式选择器靠它跟手，别再退回「只看 init」。
  it("status 带 permissionMode → permission_mode 事件", () => {
    const t = new SdkMessageTranslator();
    const out = t.translate(msg({ type: "system", subtype: "status", status: null, permissionMode: "plan" }));
    expect(out).toEqual([{ type: "permission_mode", mode: "plan" }]);
  });

  it("不带 permissionMode 的 status（requesting 那类）→ 不产出", () => {
    const t = new SdkMessageTranslator();
    expect(t.translate(msg({ type: "system", subtype: "status", status: "requesting" }))).toEqual([]);
    expect(t.translate(msg({ type: "system", subtype: "status", status: "compacting" }))).toEqual([]);
  });

  it("同一模式只下发一次（init 记基线，重复的 status 不重复推）", () => {
    const t = new SdkMessageTranslator();
    // init 报 plan：走 session_ready，同时把基线记成 plan
    t.translate(msg({ type: "system", subtype: "init", session_id: "s1", model: "m", permissionMode: "plan" }));
    expect(t.translate(msg({ type: "system", subtype: "status", status: null, permissionMode: "plan" }))).toEqual([]);
    // 真变了才发
    expect(t.translate(msg({ type: "system", subtype: "status", status: null, permissionMode: "bypassPermissions" }))).toEqual([
      { type: "permission_mode", mode: "bypassPermissions" },
    ]);
    expect(t.translate(msg({ type: "system", subtype: "status", status: null, permissionMode: "bypassPermissions" }))).toEqual([]);
  });

  it("其它 system 子类型（如 compact_boundary）不产出", () => {
    const t = new SdkMessageTranslator();
    expect(t.translate(msg({ type: "system", subtype: "compact_boundary" }))).toEqual([]);
  });
});

describe("完整流去重（streamed_msg_ids）", () => {
  it("流式渲染过的内容，完整 assistant 消息到达时只补 usage", () => {
    const t = new SdkMessageTranslator();
    t.translate(msg({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }));
    t.translate(msg({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }));
    t.translate(msg({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }));
    t.translate(msg({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }));
    // 完整 assistant 消息（同 id）到达
    const out = t.translate(
      msg({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 3, output_tokens: 2 } } }),
    );
    expect(out).toEqual([
      { type: "message_complete", usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    ]);
  });
});

describe("图片消息拼装", () => {
  const tinyImg: ChatImage = { mediaType: "image/png", data: "iVBORw0KGgo=" };

  it("文本 + 图片", () => {
    const m = buildUserMessage("看这张图", [tinyImg]);
    expect(m).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ],
      },
    });
  });

  it("纯图片无文本也允许", () => {
    const m = buildUserMessage(null, [tinyImg]);
    expect((m.message.content as unknown[]).length).toBe(1);
    expect((m.message.content as any[])[0].type).toBe("image");
  });

  it("空消息（无文本无图）抛错", () => {
    expect(() => buildUserMessage("", [])).toThrow();
  });

  it(">4.5MB 图片被拒（抛错）", () => {
    const big = "A".repeat(7_000_000); // 解码约 5.25MB
    expect(() => buildUserMessage("x", [{ mediaType: "image/png", data: big }])).toThrow(/图片过大/);
  });

  it("边界：恰好 4.5MB 不被拒", () => {
    // 经 base64 编码后解码约 4.5MB
    const len = Math.floor((4.5 * 1024 * 1024 * 4) / 3);
    const ok = "A".repeat(len);
    expect(() => buildUserMessage("x", [{ mediaType: "image/png", data: ok }])).not.toThrow();
  });
});

describe("会话标题描述（titleDescriptionFor）", () => {
  it("新建会话：用首条用户文本", () => {
    expect(titleDescriptionFor(undefined, "帮我把构建脚本改快一点")).toBe("帮我把构建脚本改快一点");
  });

  it("首尾空白去掉（描述只喂给起名那次调用）", () => {
    expect(titleDescriptionFor(undefined, "  看下这个 bug\n")).toBe("看下这个 bug");
  });

  it("续聊（有 resumeId）不起名：历史会话不补标题", () => {
    expect(titleDescriptionFor("afc29ea3-0000-4000-8000-000000000000", "接着说")).toBeNull();
  });

  it("纯图消息（无文本）不起名", () => {
    expect(titleDescriptionFor(undefined, null)).toBeNull();
    expect(titleDescriptionFor(undefined, "")).toBeNull();
    expect(titleDescriptionFor(undefined, "   \n ")).toBeNull();
  });

  it("超长首条消息截断（不带巨长日志去起名）", () => {
    const long = "日".repeat(TITLE_DESCRIPTION_MAX + 100);
    const got = titleDescriptionFor(undefined, long);
    expect(got).not.toBeNull();
    expect([...(got as string)].length).toBe(TITLE_DESCRIPTION_MAX);
  });
});

describe("权限模式映射", () => {
  it("manual → default（CLI 取值）", () => {
    expect(toSdkPermissionMode("manual")).toBe("default");
  });
  it("plan/auto/acceptEdits/dontAsk/bypassPermissions 原样", () => {
    expect(toSdkPermissionMode("plan")).toBe("plan");
    expect(toSdkPermissionMode("auto")).toBe("auto");
    expect(toSdkPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(toSdkPermissionMode("dontAsk")).toBe("dontAsk");
    expect(toSdkPermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });
  it("fromSdk：default → manual；其余原样", () => {
    expect(fromSdkPermissionMode("default")).toBe("manual");
    expect(fromSdkPermissionMode("auto")).toBe("auto");
    expect(fromSdkPermissionMode(null)).toBeNull();
  });
  it("normalizeDefaultMode：default→manual；未知/缺失→null", () => {
    expect(normalizeDefaultMode("default")).toBe("manual");
    expect(normalizeDefaultMode("plan")).toBe("plan");
    expect(normalizeDefaultMode("bogus")).toBeNull();
    expect(normalizeDefaultMode(undefined)).toBeNull();
  });
});

describe("parseUsage 容错", () => {
  it("snake_case 与 camelCase 都认", () => {
    expect(parseUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    });
    expect(parseUsage(null)).toBeNull();
  });
});

describe("defaultPermissionMode（settings 优先链）", () => {
  it("优先级 local > project > user；未配置返回 null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-perm-"));
    const projClaude = path.join(dir, ".claude");
    fs.mkdirSync(projClaude, { recursive: true });
    fs.writeFileSync(path.join(projClaude, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
    fs.writeFileSync(path.join(projClaude, "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
    // 用户级（HOME 指向 dir 的父，确保不命中）：用 CLAUDE_CONFIG_DIR 指向一个无 settings 的目录
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-user-"));
    fs.mkdirSync(path.join(userDir, ".claude"), { recursive: true });

    const env = { ...process.env, HOME: userDir, USERPROFILE: userDir, CLAUDE_CONFIG_DIR: path.join(userDir, ".claude") };
    expect(defaultPermissionMode(dir, "linux", env)).toBe("acceptEdits"); // local 胜出

    fs.rmSync(path.join(projClaude, "settings.local.json"));
    expect(defaultPermissionMode(dir, "linux", env)).toBe("plan"); // project 胜出

    fs.rmSync(path.join(projClaude, "settings.json"));
    expect(defaultPermissionMode(dir, "linux", env)).toBeNull(); // 用户级也没有 → null
  });
});

describe("ChatManager 基础契约", () => {
  it("同一会话不允许开两个进程（第二次 start 被忽略）", () => {
    const mgr = new ChatManager(() => {});
    mgr.start("s1", { projectPath: process.cwd() });
    mgr.start("s1", { projectPath: process.cwd() }); // 不应抛错，也不覆盖
    mgr.close("s1");
    expect(() => mgr.close("s1")).not.toThrow();
  });

  it("未知会话 send/respond 不抛错", () => {
    const mgr = new ChatManager(() => {});
    mgr.send("nope", "hi");
    mgr.respondToPermission("nope", "r", { kind: "deny", message: "x" });
    mgr.closeAll();
  });
});

// ---------------- buildPermissionResult（canUseTool 的应答形状） ----------------
// 这一层最容易踩的坑：AskUserQuestion 只回 {behavior:"allow"} 而不带 updatedInput.answers
// 不报错，但等于「用户没选」——静默失效、没有错误码（docs/agent-sdk-interactive-tools.md）。
// 这些用例就是那条分支的回归防线。

describe("buildPermissionResult", () => {
  const askInput = {
    questions: [
      { question: "优先做哪件事？", header: "优先级", options: [{ label: "补文档" }, { label: "加测试" }] },
    ],
  };

  it("普通工具：allow 不带 updatedInput（别乱塞字段）", () => {
    expect(buildPermissionResult("Bash", { command: "ls" }, { kind: "allow" })).toEqual({
      behavior: "allow",
    });
  });

  it("deny：原样透出 message", () => {
    expect(buildPermissionResult("Bash", {}, { kind: "deny", message: "用户拒绝了该操作" })).toEqual({
      behavior: "deny",
      message: "用户拒绝了该操作",
    });
  });

  it("提问 + 选项：带 updatedInput.answers（key 是题目完整文本）", () => {
    const r = buildPermissionResult("AskUserQuestion", askInput, {
      kind: "allow",
      answers: { "优先做哪件事？": "加测试" },
    });
    expect(r.behavior).toBe("allow");
    const ui = (r as { updatedInput?: Record<string, unknown> }).updatedInput!;
    expect(ui.answers).toEqual({ "优先做哪件事？": "加测试" });
    // 原 input（questions 数组）必须原样带上，CLI 要靠它对齐题目
    expect(ui.questions).toEqual(askInput.questions);
  });

  it("提问 + 自由文本：带 updatedInput.response（未选选项直接打字）", () => {
    const r = buildPermissionResult("AskUserQuestion", askInput, {
      kind: "allow",
      response: "先重构",
    });
    const ui = (r as { updatedInput?: Record<string, unknown> }).updatedInput!;
    expect(ui.response).toBe("先重构");
    expect(ui.answers).toBeUndefined();
  });

  it("提问 + 选项与自由文本同时给：两个都带上", () => {
    const r = buildPermissionResult("AskUserQuestion", askInput, {
      kind: "allow",
      answers: { "优先做哪件事？": "补文档" },
      response: "备注",
    });
    const ui = (r as { updatedInput?: Record<string, unknown> }).updatedInput!;
    expect(ui.answers).toEqual({ "优先做哪件事？": "补文档" });
    expect(ui.response).toBe("备注");
  });

  it("提问 + 既没选也没打字：明确 deny（而不是静默失效）", () => {
    expect(buildPermissionResult("AskUserQuestion", askInput, { kind: "allow" }).behavior).toBe("deny");
    // 空 answers 对象 / 空串 response 同样算「没选」
    expect(
      buildPermissionResult("AskUserQuestion", askInput, { kind: "allow", answers: {} }).behavior,
    ).toBe("deny");
    expect(
      buildPermissionResult("AskUserQuestion", askInput, { kind: "allow", response: "" }).behavior,
    ).toBe("deny");
  });

  it("用户的答案覆盖 input 里可能已有的同名字段", () => {
    const polluted = { ...askInput, answers: { "优先做哪件事？": "旧值" } };
    const r = buildPermissionResult("AskUserQuestion", polluted, {
      kind: "allow",
      answers: { "优先做哪件事？": "新值" },
    });
    const ui = (r as { updatedInput?: Record<string, unknown> }).updatedInput!;
    expect(ui.answers).toEqual({ "优先做哪件事？": "新值" });
  });

  it("提问工具在 deny 时不受特殊处理", () => {
    expect(
      buildPermissionResult("AskUserQuestion", askInput, { kind: "deny", message: "用户取消了这次提问" }),
    ).toEqual({ behavior: "deny", message: "用户取消了这次提问" });
  });
});

describe("pickClaudeFromPathOutput（本机 claude 定位，B7）", () => {
  const win = "win32" as NodeJS.Platform;
  const mac = "darwin" as NodeJS.Platform;
  /** npm 垫片同级的真身路径（与 chat.ts 的拼法一致） */
  const real = (p: string): string =>
    path.join(path.dirname(p), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

  it("Windows：原生安装的 claude.exe 直接用", () => {
    const exe = "C:\\Users\\me\\.local\\bin\\claude.exe";
    expect(pickClaudeFromPathOutput(exe + "\n", win, (p) => p === exe)).toBe(exe);
  });

  it("Windows：npm 垫片（无扩展名 shim / .cmd）顺着同级 node_modules 找真身", () => {
    // 本机的形状就是这样：PATH 上是 shim 与 .cmd，直接指过去会
    // failed to launch / spawn EINVAL（SDK 不启 shell）
    const shim = "E:\\DevTool\\node18-global\\claude";
    const out = [shim, "E:\\DevTool\\node18-global\\claude.cmd"].join("\r\n");
    expect(pickClaudeFromPathOutput(out, win, (p) => p === shim || p === real(shim))).toBe(real(shim));
  });

  it("Windows：垫片找不到真身就跳过它（宁可不选，也不交一个跑不起来的路）", () => {
    const shim = "E:\\DevTool\\node18-global\\claude.cmd";
    expect(pickClaudeFromPathOutput(`${shim}\n`, win, (p) => p === shim)).toBeUndefined();
  });

  it("不存在的候选跳过，继续看下一个", () => {
    const exe = "C:\\bin\\claude.exe";
    expect(pickClaudeFromPathOutput(`C:\\gone\\claude.exe\n${exe}\n`, win, (p) => p === exe)).toBe(exe);
  });

  it("macOS：command -v 的结果直接采信", () => {
    const p = "/usr/local/bin/claude";
    expect(pickClaudeFromPathOutput(`${p}\n`, mac, (x) => x === p)).toBe(p);
  });

  it("空输出 / 只有空行 → undefined", () => {
    expect(pickClaudeFromPathOutput("\n\n", win, () => true)).toBeUndefined();
  });
});

describe("requireLocalClaudeExecutable（无本机 claude → 明确报错，不回退 SDK 自带）", () => {
  it("探测不到 → 抛可读错误（含安装指引），而非静默回退", () => {
    // 2026-09-23 起安装包不携带 SDK 平台包的 claude.exe：探测失败必须明确报错，
    // 否则渲染成「发消息毫无反应」或跑到一份不存在的引擎上
    expect(() => requireLocalClaudeExecutable(undefined)).toThrowError(NO_LOCAL_CLAUDE_MESSAGE);
  });

  it("探测得到 → 原样返回路径", () => {
    const exe = "C:\\Users\\me\\.local\\bin\\claude.exe";
    expect(requireLocalClaudeExecutable(exe)).toBe(exe);
  });
});
