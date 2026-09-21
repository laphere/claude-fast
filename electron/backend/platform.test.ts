// 平台交互纯逻辑单元测试（resume 校验/命令行、scanClaudeProjects、listProjects；
// spawn 类函数不测副作用）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildLaunchScript,
  buildResumeCmdline,
  buildResumeScript,
  launchProject,
  listProjects,
  scanClaudeProjects,
  validateResumePath,
} from "./platform";
import { mangleProjectPath } from "./mangle";
import { shQuote } from "./scriptnames";

const UUID = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-platform-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validateResumePath", () => {
  it("空路径拒绝", () => {
    expect(() => validateResumePath("", "win32")).toThrow("项目路径不能为空");
  });

  it("不存在的目录拒绝", () => {
    expect(() => validateResumePath(path.join(tmp, "no-such"), "win32")).toThrow(
      "项目路径不存在",
    );
  });

  it("存在的目录通过", () => {
    expect(validateResumePath(tmp, "win32")).toBe(tmp);
  });

  it("Windows 只拒引号内仍有效的 \" % !（& | < > ^ ( ) 是字面量，必须放行）", () => {
    const d1 = path.join(tmp, "d1");
    fs.mkdirSync(d1, { recursive: true });
    /** 是否**被字符规则**拒掉——放行时校验会继续走到「路径不存在」，故不能一概用
     *  `toThrow()`（`< > |` 在 Windows 上根本建不出同名目录）。 */
    const charRejected = (name: string): boolean => {
      try {
        validateResumePath(path.join(d1, name), "win32");
        return false;
      } catch (e) {
        return String(e).includes("非法字符");
      }
    };
    // 引号截断 / 变量展开 / 延迟展开
    expect(charRejected('a"b')).toBe(true);
    expect(charRejected("a%b")).toBe(true);
    expect(charRejected("a!b")).toBe(true);
    // 双引号内均为字面量：多拒它们会让 `C:\Program Files (x86)\…` 下的项目
    // 「启动能开、继续对话报错」（v2.0.0 / v1.0.0 有回归测试断言必须放行）
    for (const name of ["a&b", "a|b", "a<b", "a>b", "a^b", "a(b", "a)b"]) {
      expect([name, charRejected(name)]).toEqual([name, false]);
    }
    // 端到端：真实存在的 `Program Files (x86) & test` 目录必须原样通过
    const tricky = path.join(d1, "Program Files (x86) & test");
    fs.mkdirSync(tricky, { recursive: true });
    expect(validateResumePath(tricky, "win32")).toBe(tricky);
  });

  it("macOS 不额外拒字符（shQuote 已转义），但拒绝控制字符", () => {
    const d = path.join(tmp, "tricky");
    fs.mkdirSync(d, { recursive: true });
    const tricky = path.join(d, "my'app (v2)\\3");
    fs.mkdirSync(tricky, { recursive: true });
    expect(validateResumePath(tricky, "darwin")).toBe(tricky);
    expect(() => validateResumePath(d + "\u0001", "darwin")).toThrow();
  });
});

describe("launchProject / buildLaunchScript", () => {
  // 只测「校验拦下」的分支：放行的分支会真的开一个终端窗口，单测不碰副作用
  it("启动路径与 resume 共用同一套校验（\" % ! 拦住）", () => {
    expect(() => launchProject(path.join(tmp, "a%b"), "win32")).toThrow("非法字符");
    expect(() => launchProject(path.join(tmp, "a!b"), "win32")).toThrow("非法字符");
    expect(() => launchProject(path.join(tmp, 'a"b'), "win32")).toThrow("非法字符");
  });

  it("目录不存在时拒绝", () => {
    expect(() => launchProject(path.join(tmp, "nope"), "win32")).toThrow("项目路径不存在");
  });

  it("macOS 临时脚本与 resume 同款 shQuote：`$` 与反引号不做命令替换", () => {
    const d = path.join(tmp, "$(whoami)-`id`");
    fs.mkdirSync(d, { recursive: true });
    const script = buildLaunchScript(d, "darwin");
    expect(script).toBe(`#!/bin/bash\ncd "${shQuote(d)}" || exit 1\nexec claude\n`);
    // 未转义的话这两段会被 bash 当命令执行——转义后 `$` 与反引号前各有一个反斜杠
    expect(script).toContain("\\$(whoami)");
    expect(script).toContain("\\`id\\`");
  });
});

describe("buildResumeCmdline / buildResumeScript", () => {
  it("Windows 命令行：start 链新开 console + claude --resume", () => {
    const cmd = buildResumeCmdline(tmp, UUID, "win32");
    // start 的第一个带引号参数是窗口标题，/d 设工作目录，内层 cmd /k 运行 claude
    expect(cmd.startsWith('start "Claude Code" /d "')).toBe(true);
    expect(cmd).toContain(`cmd /k claude --resume ${UUID}`);
  });

  it("Windows 非法路径先被校验拦截（只拦 \" % !）", () => {
    expect(() => buildResumeCmdline("D:\\a%b", UUID, "win32")).toThrow("非法字符");
    expect(() => buildResumeCmdline("D:\\a!b", UUID, "win32")).toThrow("非法字符");
    // `&` 不再是非法字符：拼进双引号内是字面量（校验会继续走到「路径不存在」）
    expect(() => buildResumeCmdline("D:\\a&b", UUID, "win32")).toThrow("项目路径不存在");
  });

  it("macOS 临时脚本：shQuote 转义 + exec claude --resume", () => {
    const script = buildResumeScript(tmp, UUID, "darwin");
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    // Windows 路径的 `\` 经 shQuote 转义为 `\\`（bash 双引号内语义正确）
    expect(script).toContain(`cd "${shQuote(tmp)}" || exit 1`);
    expect(script).toContain(`exec claude --resume ${UUID}`);
  });

  it.runIf(process.platform !== "win32")(
    "macOS 脚本转义路径中的特殊字符（引号/$ 在 Windows 文件名非法，仅 mac 跑）",
    () => {
      const d = path.join(tmp, 'we"ird$path');
      fs.mkdirSync(d, { recursive: true });
      const script = buildResumeScript(d, UUID, "darwin");
      expect(script).toContain(`cd "${shQuote(d)}" || exit 1`);
      expect(script).toContain('\\"');
      expect(script).toContain("\\$");
    },
  );
});

describe("scanClaudeProjects", () => {
  // unmangle 的歧义枚举无法区分「字面 -」与「分隔 -」，且段过多时降级；
  // 因此 scan 用例的项目路径必须放在**不含 '-'** 的目录下（模拟真实场景中
  // '-' 多为路径分隔符转义而来的情况）。TEMP 可能被重定向为含 '-' 的路径，
  // 故优先用 USERPROFILE；它也含 '-' 时跳过。
  let scanBase: string;

  beforeEach((ctx) => {
    const home = process.env.USERPROFILE ?? os.homedir();
    if (home === "" || /-/.test(home)) {
      ctx.skip();
      return;
    }
    scanBase = path.join(home, `cfxscan${process.pid}${Math.floor(Math.random() * 1e9)}`);
    fs.mkdirSync(scanBase, { recursive: true });
  });

  afterEach(() => {
    if (scanBase) fs.rmSync(scanBase, { recursive: true, force: true });
  });

  it("mangled 目录反解为真实路径；missing 标记正确", () => {
    // 真实项目目录（叶子名不含 '-'，保证全分隔候选唯一命中）
    const projRoot = path.join(scanBase, "p1", "demo");
    fs.mkdirSync(projRoot, { recursive: true });
    const projectsDir = path.join(scanBase, "projects");
    fs.mkdirSync(projectsDir);
    const mangled = mangleProjectPath(projRoot);
    fs.mkdirSync(path.join(projectsDir, mangled));

    const list = scanClaudeProjects(projectsDir, "win32");
    expect(list.length).toBe(1);
    expect(list[0].path).toBe(projRoot);
    expect(list[0].name).toBe("demo");
    expect(list[0].missing).toBe(false);
  });

  it("真实路径已不存在 → missing=true，path 为首选候选", () => {
    const projectsDir = path.join(scanBase, "projects2");
    fs.mkdirSync(projectsDir);
    fs.mkdirSync(path.join(projectsDir, "D--ghost"));
    const list = scanClaudeProjects(projectsDir, "win32");
    expect(list.length).toBe(1);
    expect(list[0].missing).toBe(true);
    expect(list[0].path).toBe("D:\\ghost");
  });

  it("projects 目录不存在返回空数组", () => {
    expect(scanClaudeProjects(path.join(scanBase, "nope"), "win32")).toEqual([]);
  });
});

describe("listProjects", () => {
  let base: string;

  beforeEach((ctx) => {
    const home = process.env.USERPROFILE ?? os.homedir();
    if (home === "" || /-/.test(home)) {
      ctx.skip();
      return;
    }
    base = path.join(home, `cfxlist${process.pid}${Math.floor(Math.random() * 1e9)}`);
    fs.mkdirSync(base, { recursive: true });
  });

  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("合并会话扫描与手动清单并去重", () => {
    const projRoot = path.join(base, "p2", "beta");
    fs.mkdirSync(projRoot, { recursive: true });
    const projectsDir = path.join(base, "projects");
    fs.mkdirSync(projectsDir);
    fs.mkdirSync(path.join(projectsDir, mangleProjectPath(projRoot)));

    const list = listProjects(projectsDir, [projRoot, "D:\\manual\\delta"], [], "win32");
    // 会话扫描 1 个 + 手动 1 个新路径（manual delta 不存在 → missing 显示）
    expect(list.length).toBe(2);
    const beta = list.find((x) => x.path === projRoot)!;
    expect(beta.missing).toBe(false);
    const delta = list.find((x) => x.path === "D:\\manual\\delta")!;
    expect(delta.missing).toBe(true); // 手动路径不存在 → 标红
    expect(delta.name).toBe("delta");
  });

  it("手动清单大小写不敏感去重", () => {
    const projectsDir = path.join(base, "projects3");
    fs.mkdirSync(projectsDir);
    const list = listProjects(
      projectsDir,
      ["D:\\Same\\Path", "d:\\same\\path"],
      [],
      "win32",
    );
    expect(list.length).toBe(1);
  });

  it("排除清单中的项目不出现在列表里", () => {
    const projRoot = path.join(base, "p3", "gamma");
    fs.mkdirSync(projRoot, { recursive: true });
    const projectsDir = path.join(base, "projects4");
    fs.mkdirSync(projectsDir);
    fs.mkdirSync(path.join(projectsDir, mangleProjectPath(projRoot)));
    const manual = [path.join(base, "p3", "delta")];
    fs.mkdirSync(manual[0], { recursive: true });

    // 无排除：两项都出现
    const all = listProjects(projectsDir, manual, [], "win32");
    expect(all.length).toBe(2);
    // 排除 gamma（会话扫描来源）后只剩 delta —— 「移除」对扫描来源的项目生效
    const list = listProjects(
      projectsDir,
      manual,
      [path.join(base, "p3", "gamma")],
      "win32",
    );
    expect(list.length).toBe(1);
    expect(list[0].path).toBe(manual[0]);
  });
});
