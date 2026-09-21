// 内嵌终端后端纯逻辑单测（sessionArgs 的注入面校验 / cmd 包装链 / 环境剥离）
// 用例移植自 Tauri 线 src-tauri/src/pty.rs 的 tests（uuid 校验部分），
// buildClaudeCommand / buildSpawnEnv 是 Electron 侧重写的新逻辑。
import { describe, expect, it } from "vitest";
import { buildClaudeCommand, buildSpawnEnv, sessionArgs } from "./pty";

const UID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("sessionArgs", () => {
  it("resume 与新会话两种参数", () => {
    expect(sessionArgs(UID, null)).toEqual(["--resume", UID]);
    expect(sessionArgs(null, UID)).toEqual(["--session-id", UID]);
    // 续聊优先（两者同时给不是正常路径，但不能拼出两条会话参数）
    expect(sessionArgs(UID, UID)).toHaveLength(2);
    expect(sessionArgs(null, null)).toEqual([]);
  });

  it("参数位注入面：flag / 路径 / 引号 / 过短过长全部拒绝", () => {
    for (const bad of [
      "--dangerously-skip-permissions",
      "../evil",
      "",
      "3fa85f64-5717-4562-b3fc-2c963f66afa",
    ]) {
      expect(() => sessionArgs(bad, null), bad).toThrow();
      expect(() => sessionArgs(null, bad), bad).toThrow();
    }
    // hex 之外的字母不允许
    expect(() => sessionArgs("3ga85f64-5717-4562-b3fc-2c963f66afa6", null)).toThrow();
    // 连字符**位置**也要对：形状看着像、位置全错的串同样拒绝
    expect(() => sessionArgs("------------------------------------", null)).toThrow();
    expect(() => sessionArgs("3fa85f6-45717-4562-b3fc-2c963f66afa6", null)).toThrow();
  });

  it("大写 hex 也是合法 uuid", () => {
    expect(sessionArgs("3FA85F64-5717-4562-B3FC-2C963F66AFA6", null)).toEqual([
      "--resume",
      "3FA85F64-5717-4562-B3FC-2C963F66AFA6",
    ]);
  });
});

describe("buildClaudeCommand", () => {
  it("Windows：.cmd/.bat 走 cmd /D /S /C call 链", () => {
    const r = buildClaudeCommand("E:\\node18-global\\claude.cmd", "win32");
    expect(r.file).toMatch(/cmd\.exe$/i);
    expect(r.args).toEqual(["/D", "/S", "/C", "call", "E:\\node18-global\\claude.cmd"]);
  });

  it("Windows：.exe 与 bat 同理直接 spawn；macOS 任何形态都直接 spawn", () => {
    expect(buildClaudeCommand("C:\\x\\claude.exe", "win32").args).toEqual([]);
    expect(buildClaudeCommand("C:\\x\\claude.bat", "win32").args).toEqual([
      "/D",
      "/S",
      "/C",
      "call",
      "C:\\x\\claude.bat",
    ]);
    expect(buildClaudeCommand("/usr/local/bin/claude", "darwin")).toEqual({
      file: "/usr/local/bin/claude",
      args: [],
    });
  });
});

describe("buildSpawnEnv", () => {
  it("声明终端能力并剥掉嵌套 Claude 标记（jsonl 不落盘的根源）", () => {
    const env = buildSpawnEnv({
      PATH: "C:\\Windows",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDECODE: "1",
      KEEP_ME: "yes",
    });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
  });

  it("不改动传入的原始对象", () => {
    const base = { CLAUDECODE: "1" } as NodeJS.ProcessEnv;
    buildSpawnEnv(base);
    expect(base.CLAUDECODE).toBe("1");
  });
});
