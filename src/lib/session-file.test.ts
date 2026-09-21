import { describe, expect, it } from "vitest";
import { sessionIdFromFile } from "./session-file";

const UUID = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";

describe("sessionIdFromFile", () => {
  // ⚠️ 反斜杠写成 `\\`：`"C:\Users\x"` 里 `\U`/`\x` 不是转义序列，会被悄悄吃成
  // `C:Usersx`——测试照样绿，但「Windows 路径」这条根本没验到（本仓踩过一次）
  it("Windows 路径：盘符与反斜杠都照常切", () => {
    expect(sessionIdFromFile(`C:\\Users\\laphe\\.claude\\projects\\D--proj\\${UUID}.jsonl`)).toBe(
      UUID,
    );
  });

  it("POSIX 路径", () => {
    expect(sessionIdFromFile(`/Users/foo/.claude/projects/-Users-foo-bar/${UUID}.jsonl`)).toBe(UUID);
  });

  it("扩展名大小写不敏感（Windows 上 X.JSONL 与 x.jsonl 是同一个文件）", () => {
    expect(sessionIdFromFile(`C:\\p\\${UUID}.JSONL`)).toBe(UUID);
  });

  it("不是会话文件：无扩展名 / 空串 / 目录路径一律 null", () => {
    for (const bad of [`C:\\p\\${UUID}`, "", "/", "/Users/foo/", "x.txt"]) {
      expect(sessionIdFromFile(bad), bad).toBeNull();
    }
  });

  it("混合分隔符也能取（便携数据根从别的机器带过来的场景）", () => {
    expect(sessionIdFromFile(`C:\\p/sub\\${UUID}.jsonl`)).toBe(UUID);
  });
});
