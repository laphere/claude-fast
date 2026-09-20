// 本机 Claude Code 版本检查与一键升级——单元测试
// 纯逻辑直接断言；编排函数（claudeUpdateStatus / claudeRunUpgrade）通过注入假 IoDeps
// 驱动，绝不真跑 npm / 网络。errorlevel 兜底链在 Windows 上用真实 cmd 端到端验证一遍。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildLocateCommand,
  buildUpgradeBat,
  buildUpgradeSh,
  buildVersionProbeCommand,
  claudeRunUpgrade,
  claudeUpdateStatus,
  compareVersions,
  extractVersion,
  type IoDeps,
  parseNpmLatestVersion,
  pickWindowsHit,
  shQuote,
  siblingOrPathNpm,
  tailChars,
} from "./claude-update";

// 默认全假实现：每个用例按需覆盖 run / fetchText / runUpgradeScript 等
function fakeDeps(overrides: Partial<IoDeps> = {}): IoDeps {
  return {
    platform: "win32",
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    fetchText: async () => "",
    runUpgradeScript: async () => ({ success: true, timedOut: false }),
    fileExists: () => false,
    tmpDir: () => os.tmpdir(),
    pid: () => 12345,
    writeFile: () => {},
    readFile: () => null,
    removeFile: () => {},
    ...overrides,
  };
}

describe("extractVersion", () => {
  it("基础提取（claude 真实输出形态）", () => {
    expect(extractVersion("2.1.263 (Claude Code)")).toBe("2.1.263");
    expect(extractVersion("claude 1.2.3\nbuild info")).toBe("1.2.3");
  });

  it("带预发布后缀", () => {
    expect(extractVersion("2.2.0-next.1 (Claude Code)")).toBe("2.2.0-next.1");
    expect(extractVersion("1.0.0-beta_2")).toBe("1.0.0-beta_2");
  });

  it("噪声与多行输出（版本藏在中间）", () => {
    expect(extractVersion("npm warn deprecated\n\nv3.4.5 (latest)\ndone")).toBe(
      "3.4.5",
    );
  });

  it("无版本 / 残缺数字返回 null", () => {
    expect(extractVersion("command not found")).toBeNull();
    expect(extractVersion("")).toBeNull();
    // 只有 2 段、且前面有脏数字碎片的，不能误报
    expect(extractVersion("version is ..12 and 1.2")).toBeNull();
  });
});

describe("compareVersions（semver 严格比较）", () => {
  it("相等与逐位比较（段不足补 0）", () => {
    expect(compareVersions("2.1.263", "2.1.263")).toBe(0);
    expect(compareVersions("2.1.264", "2.1.263")).toBe(1);
    expect(compareVersions("2.2.0", "2.1.99")).toBe(1);
    expect(compareVersions("3.0.0", "2.99.99")).toBe(1);
    expect(compareVersions("2.1.0", "2.1")).toBe(0);
  });

  it("预发布低于正式版", () => {
    expect(compareVersions("2.1.0-beta.1", "2.1.0")).toBe(-1);
    expect(compareVersions("2.1.0", "2.1.0-beta.1")).toBe(1);
  });

  it("预发布段间比较（字母序 / 数字段数值 / 数字<文本 / 多标识符更大）", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta")).toBe(1);
    expect(compareVersions("1.0.0-2", "1.0.0-10")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-a")).toBe(-1);
  });

  it("本地抢跑（高于 latest 的 next 通道）不误报可升级", () => {
    // 对应 update_status 的 compareVersions(latest, current)：
    // latest=2.1.266（稳定），current=2.2.0-next.1（用户装了更高的 next）→
    // latest < current（2.1 < 2.2），不满足「严格大于」，故不报升级
    expect(compareVersions("2.1.266", "2.2.0-next.1")).toBe(-1);
  });

  it("latest 小于 current 时不报升级（降级场景）", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });
});

describe("pickWindowsHit（候选路径择优）", () => {
  it(".cmd 优先于无扩展名 shim（npm 全局目录常态）", () => {
    const lines = ["E:\\npm-global\\claude", "E:\\npm-global\\claude.cmd"];
    expect(pickWindowsHit(lines)).toBe("E:\\npm-global\\claude.cmd");
  });

  it(".exe 优先于 .cmd", () => {
    const lines = [
      "C:\\Program Files\\claude\\claude.exe",
      "E:\\npm-global\\claude.cmd",
    ];
    expect(pickWindowsHit(lines)).toBe("C:\\Program Files\\claude\\claude.exe");
  });

  it("过滤 WindowsApps 商店别名，不遮蔽真实安装", () => {
    const lines = [
      "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe",
      "E:\\npm-global\\claude.cmd",
    ];
    expect(pickWindowsHit(lines)).toBe("E:\\npm-global\\claude.cmd");
  });

  it("全部被过滤时返回 null", () => {
    expect(
      pickWindowsHit(["C:\\WindowsApps\\claude.exe"]),
    ).toBeNull();
  });
});

describe("parseNpmLatestVersion（registry 响应解析）", () => {
  it("合法 JSON 取 version", () => {
    expect(parseNpmLatestVersion('{"version":"2.1.300","name":"x"}')).toBe(
      "2.1.300",
    );
  });

  it("缺 version 字段返回 null", () => {
    expect(parseNpmLatestVersion('{"name":"x"}')).toBeNull();
  });

  it("非法 JSON 返回 null", () => {
    expect(parseNpmLatestVersion("not json")).toBeNull();
  });
});

describe("buildLocateCommand / buildVersionProbeCommand", () => {
  it("Windows 定位用 where；其余用 sh -c command -v", () => {
    expect(buildLocateCommand("win32")).toEqual({ cmd: "where", args: ["claude"] });
    expect(buildLocateCommand("darwin")).toEqual({
      cmd: "/bin/sh",
      args: ["-c", "command -v claude"],
    });
  });

  it("Windows .cmd/.bat 经 cmd /D /S /C call；.exe 直接执行", () => {
    expect(buildVersionProbeCommand("E:\\n\\claude.cmd", "win32")).toEqual({
      cmd: "cmd",
      args: ["/D", "/S", "/C", "call", "E:\\n\\claude.cmd", "--version"],
    });
    expect(buildVersionProbeCommand("C:\\n\\claude.exe", "win32")).toEqual({
      cmd: "C:\\n\\claude.exe",
      args: ["--version"],
    });
    expect(buildVersionProbeCommand("C:\\n\\claude", "win32")).toEqual({
      cmd: "C:\\n\\claude",
      args: ["--version"],
    });
    expect(buildVersionProbeCommand("/usr/bin/claude", "darwin")).toEqual({
      cmd: "/usr/bin/claude",
      args: ["--version"],
    });
  });
});

describe("buildUpgradeBat / buildUpgradeSh（升级命令与 errorlevel 兜底链）", () => {
  it("Windows bat：锚定路径 + 失败兜底 npm + 透传 errorlevel + CRLF", () => {
    const s = buildUpgradeBat(
      "C:\\Users\\x\\npm\\claude.cmd",
      "C:\\Users\\x\\npm\\npm.cmd",
    );
    expect(s.startsWith("@echo off")).toBe(true);
    expect(s).toContain('call "C:\\Users\\x\\npm\\claude.cmd" update');
    expect(s).toContain(
      'call "C:\\Users\\x\\npm\\npm.cmd" i -g @anthropic-ai/claude-code@latest',
    );
    expect(s).toContain("if errorlevel 1 exit /b %errorlevel%");
    expect(s).toContain("\r\n"); // 批处理必须 CRLF
  });

  it("macOS/Linux sh：锚定路径 + || 兜底", () => {
    expect(buildUpgradeSh("/usr/local/bin/claude", "/usr/local/bin/npm")).toBe(
      "'/usr/local/bin/claude' update || '/usr/local/bin/npm' i -g @anthropic-ai/claude-code@latest",
    );
  });
});

describe("siblingOrPathNpm / shQuote / tailChars", () => {
  it("同目录有 npm.cmd / npm.exe 时优先兄弟文件", () => {
    const exists = (p: string) => p.endsWith("npm.cmd");
    expect(
      siblingOrPathNpm("E:\\n\\claude.cmd", "win32", exists),
    ).toBe("E:\\n\\npm.cmd");
  });

  it("同目录无 npm 时回退 PATH 裸命令", () => {
    expect(siblingOrPathNpm("E:\\n\\claude.cmd", "win32", () => false)).toBe(
      "npm",
    );
  });

  it("shQuote 含引号路径正确转义", () => {
    expect(shQuote("/opt/claude")).toBe("'/opt/claude'");
    expect(shQuote("/op't claude")).toBe("'/op'\\''t claude'");
  });

  it("tailChars 超长按字符截尾、中文安全、短串原样", () => {
    expect(tailChars("abcdef", 3)).toBe("def");
    expect(tailChars("短", 10)).toBe("短");
    expect([...tailChars("汉".repeat(3000), 2000)].length).toBe(2000);
  });
});

describe("claudeUpdateStatus（编排，假执行器）", () => {
  it("两路成功且 latest > current → updateAvailable=true", async () => {
    const deps = fakeDeps({
      run: async (cmd) => {
        if (cmd === "where")
          return {
            code: 0,
            stdout: "E:\\n\\claude\nE:\\n\\claude.cmd",
            stderr: "",
            timedOut: false,
          };
        // .cmd → cmd /C call 探测
        return {
          code: 0,
          stdout: "2.1.263 (Claude Code)",
          stderr: "",
          timedOut: false,
        };
      },
      fetchText: async () => '{"version":"2.1.300"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.currentVersion).toBe("2.1.263");
    expect(r.latestVersion).toBe("2.1.300");
    expect(r.installPath).toBe("E:\\n\\claude.cmd"); // 择优 .cmd
    expect(r.updateAvailable).toBe(true);
    expect(r.currentError).toBeNull();
    expect(r.latestError).toBeNull();
  });

  it("两路成功但相等 → 不报升级", async () => {
    const deps = fakeDeps({
      run: async (cmd) =>
        cmd === "where"
          ? { code: 0, stdout: "C:\\n\\claude.exe", stderr: "", timedOut: false }
          : { code: 0, stdout: "2.1.263", stderr: "", timedOut: false },
      fetchText: async () => '{"version":"2.1.263"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.updateAvailable).toBe(false);
  });

  it("本地抢跑：current 高于 latest → 不误报", async () => {
    const deps = fakeDeps({
      run: async (cmd) =>
        cmd === "where"
          ? { code: 0, stdout: "C:\\n\\claude.exe", stderr: "", timedOut: false }
          : { code: 0, stdout: "2.2.0-next.1", stderr: "", timedOut: false },
      fetchText: async () => '{"version":"2.1.999"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.updateAvailable).toBe(false);
  });

  it("本地探测失败（where 未命中）→ 仅标记 currentError", async () => {
    const deps = fakeDeps({
      run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
      fetchText: async () => '{"version":"2.1.300"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.currentVersion).toBeNull();
    expect(r.currentError).toBe("未找到 claude 命令");
    expect(r.installPath).toBeNull();
    expect(r.latestVersion).toBe("2.1.300");
    expect(r.updateAvailable).toBe(false);
  });

  it("--version 超时 → 标记超时错误", async () => {
    const deps = fakeDeps({
      run: async (cmd) =>
        cmd === "where"
          ? { code: 0, stdout: "C:\\n\\claude.exe", stderr: "", timedOut: false }
          : { code: 0, stdout: "", stderr: "", timedOut: true },
      fetchText: async () => '{"version":"2.1.300"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.currentError).toBe("claude --version 执行超时");
    expect(r.updateAvailable).toBe(false);
  });

  it("--version 输出无法解析 → 标记解析错误", async () => {
    const deps = fakeDeps({
      run: async (cmd) =>
        cmd === "where"
          ? { code: 0, stdout: "C:\\n\\claude.exe", stderr: "", timedOut: false }
          : { code: 0, stdout: "command not found", stderr: "", timedOut: false },
      fetchText: async () => '{"version":"2.1.300"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.currentError).toContain("无法从 claude --version 输出解析版本号");
  });

  it("网络查询失败 → 仅标记 latestError，本地仍可用", async () => {
    const deps = fakeDeps({
      run: async (cmd) =>
        cmd === "where"
          ? { code: 0, stdout: "C:\\n\\claude.exe", stderr: "", timedOut: false }
          : { code: 0, stdout: "2.1.263", stderr: "", timedOut: false },
      fetchText: async () => {
        throw new Error("HTTP 500");
      },
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.currentVersion).toBe("2.1.263");
    expect(r.latestVersion).toBeNull();
    expect(r.latestError).toContain("查询 npm registry 失败");
    expect(r.updateAvailable).toBe(false);
  });

  it("darwin：取首个命中路径（不择优），正常出结果", async () => {
    const deps = fakeDeps({
      platform: "darwin",
      run: async (cmd) => {
        if (cmd === "/bin/sh")
          return {
            code: 0,
            stdout: "/usr/local/bin/claude",
            stderr: "",
            timedOut: false,
          };
        return { code: 0, stdout: "2.1.263", stderr: "", timedOut: false };
      },
      fetchText: async () => '{"version":"2.1.300"}',
    });
    const r = await claudeUpdateStatus(deps);
    expect(r.installPath).toBe("/usr/local/bin/claude");
    expect(r.updateAvailable).toBe(true);
  });
});

describe("claudeRunUpgrade（编排，假执行器）", () => {
  it("升级成功 → 返回「完成」提示 + 输出尾部", async () => {
    const deps = fakeDeps({
      run: async () => ({
        code: 0,
        stdout: "C:\\n\\claude.cmd",
        stderr: "",
        timedOut: false,
      }),
      runUpgradeScript: async () => ({ success: true, timedOut: false }),
      readFile: () => "upgrade finished ok",
    });
    const out = await claudeRunUpgrade(deps);
    expect(out).toBe("升级命令执行完成。upgrade finished ok");
  });

  it("升级命令失败（退出码非 0）→ 抛错含输出", async () => {
    const deps = fakeDeps({
      run: async () => ({
        code: 0,
        stdout: "C:\\n\\claude.cmd",
        stderr: "",
        timedOut: false,
      }),
      runUpgradeScript: async () => ({ success: false, timedOut: false }),
      readFile: () => "npm ERR! something",
    });
    await expect(claudeRunUpgrade(deps)).rejects.toThrow(
      "升级命令执行失败，请检查输出：npm ERR! something",
    );
  });

  it("升级超时 → 抛超时错误", async () => {
    const deps = fakeDeps({
      run: async () => ({
        code: 0,
        stdout: "C:\\n\\claude.cmd",
        stderr: "",
        timedOut: false,
      }),
      runUpgradeScript: async () => ({ success: false, timedOut: true }),
    });
    await expect(claudeRunUpgrade(deps)).rejects.toThrow("升级超时");
  });

  it("找不到 claude → 抛「无法升级」", async () => {
    const deps = fakeDeps({
      run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    });
    await expect(claudeRunUpgrade(deps)).rejects.toThrow(
      "未找到 claude 命令，无法升级",
    );
  });
});

// 仅在 Windows 上用真实 cmd 跑一遍生成的 bat，验证 errorlevel 兜底链端到端
describe.runIf(process.platform === "win32")("bat errorlevel 链端到端（真实 cmd）", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-upgrade-bat-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("①主命令成功不触发兜底 ②主命令失败触发且成功整体 0 ③都失败整体非 0", () => {
    const claude = path.join(tmp, "claude.cmd");
    const npm = path.join(tmp, "npm.cmd");
    const marker = path.join(tmp, "npm_ran.marker");

    const runBat = (claudeBody: string, npmBody: string) => {
      fs.writeFileSync(claude, claudeBody, "utf8");
      fs.writeFileSync(npm, npmBody, "utf8");
      const bat = path.join(tmp, "upgrade.bat");
      fs.writeFileSync(bat, buildUpgradeBat(claude, npm), "utf8");
      fs.rmSync(marker, { force: true });
      return spawnSync("cmd.exe", ["/D", "/S", "/C", bat], { encoding: "utf8" });
    };

    // ① 主命令成功：兜底不执行
    const ok = runBat(
      "@echo off\r\nexit /b 0\r\n",
      '@echo off\r\ntype nul > "' + marker + '"\r\nexit /b 0\r\n',
    );
    expect(ok.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);

    // ② 主命令失败：兜底执行并成功，整体退出 0
    const ok2 = runBat(
      "@echo off\r\nexit /b 1\r\n",
      '@echo off\r\ntype nul > "' + marker + '"\r\nexit /b 0\r\n',
    );
    expect(ok2.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);

    // ③ 兜底也失败：errorlevel 透传，整体非 0
    const fail = runBat(
      "@echo off\r\nexit /b 1\r\n",
      "@echo off\r\nexit /b 3\r\n",
    );
    expect(fail.status).not.toBe(0);
  });
});
