// paths.ts 单元测试（对齐 v2.0.0：looks_like_our_config / is_root_dir / resolve_root_from /
// app_data_root / claude_projects_dir）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appDataRoot,
  claudeProjectsDir,
  isRootDir,
  KNOWN_CONFIG_KEYS,
  legacyMarker,
  looksLikeOurConfig,
  resetRootCache,
  resolveRootDir,
  resolveRootFrom,
  scriptExt,
} from "./paths";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-paths-"));
  resetRootCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  resetRootCache();
});

/** 一份「本项目写出的」配置对象：8 个键全写（序列化器不跳过空字段） */
function fullConfigObject(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order: [],
    projects: [],
    excluded: [],
    dark: false,
    closeAction: null,
    providers: [],
    currentProvider: null,
    pinnedSessions: [],
    ...extra,
  };
}

function writeFullConfig(dir: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(fullConfigObject(extra), null, 2));
}

describe("scriptExt / legacyMarker", () => {
  it("按平台返回 bat/sh", () => {
    expect(scriptExt("win32")).toBe("bat");
    expect(scriptExt("darwin")).toBe("sh");
    expect(scriptExt("linux")).toBe("sh");
    // 旧标记只服务于旧数据迁移，不再参与数据根判定
    expect(legacyMarker("win32")).toBe("claude-claude-fast.bat");
    expect(legacyMarker("darwin")).toBe("claude-claude-fast.sh");
  });
});

describe("looksLikeOurConfig", () => {
  it("已知字段键表与 v2.0.0 的 KNOWN_KEYS 一致（两端必须逐字同表）", () => {
    expect([...KNOWN_CONFIG_KEYS]).toEqual([
      "order",
      "projects",
      "excluded",
      "dark",
      "closeAction",
      "defaultInteraction",
      "providers",
      "currentProvider",
      "pinnedSessions",
    ]);
  });

  it("空对象 {} 算本项目的配置（便携模式的正规引导方式）", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "{}");
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(true);
  });

  it("命中 ≥2 个已知字段才算", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ dark: true, projects: [] }));
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(true);
  });

  it("只命中 1 个字段 → 不算（避免认领别人家的配置）", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ dark: true }));
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(false);
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ projects: ["D:\\x"] }));
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(false);
  });

  it("非对象 / 坏 JSON / 不存在 → 不算", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "[1,2,3]");
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(false);
    fs.writeFileSync(path.join(tmp, "config.json"), "{broken");
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(false);
    fs.writeFileSync(path.join(tmp, "config.json"), '"text"');
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(false);
    expect(looksLikeOurConfig(path.join(tmp, "nope.json"))).toBe(false);
  });

  it("BOM 文件可识别", () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"dark":true,"projects":[]}')]);
    fs.writeFileSync(path.join(tmp, "config.json"), raw);
    expect(looksLikeOurConfig(path.join(tmp, "config.json"))).toBe(true);
  });
});

describe("isRootDir", () => {
  it("config.json 通过内容校验 → 是根（不再要求 scripts/ 目录）", () => {
    writeFullConfig(tmp);
    expect(isRootDir(tmp)).toBe(true);
  });

  it("主文件损坏但 .bak 合格 → 仍是根（否则会静默换根、清单看似为空）", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "{broken");
    fs.writeFileSync(
      path.join(tmp, "config.json.bak"),
      JSON.stringify(fullConfigObject({ dark: true }), null, 2),
    );
    expect(isRootDir(tmp)).toBe(true);
  });

  it("旧脚本标记不再算数据根（去脚本化）", () => {
    fs.writeFileSync(path.join(tmp, legacyMarker("win32")), "");
    expect(isRootDir(tmp)).toBe(false);
  });

  it("只有 config.json 但内容不像本项目配置 → 不是根", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ dark: true }));
    expect(isRootDir(tmp)).toBe(false);
  });
});

describe("resolveRootFrom", () => {
  it("向上最多 6 级、首个命中即返回", () => {
    const deep = path.join(tmp, "a", "b", "c", "d", "e", "f");
    fs.mkdirSync(deep, { recursive: true });
    writeFullConfig(tmp);
    // tmp/a/b/c/d/e → 5 级到 tmp，命中
    expect(resolveRootFrom(path.join(tmp, "a", "b", "c", "d", "e"))).toBe(tmp);
  });

  it("太深（>6 级）时找不到", () => {
    const deep = path.join(tmp, "a", "b", "c", "d", "e", "f", "g", "h");
    fs.mkdirSync(deep, { recursive: true });
    writeFullConfig(tmp);
    expect(resolveRootFrom(deep)).toBeNull();
  });
});

describe("appDataRoot", () => {
  it("指向 claude-fast 数据目录", () => {
    const p = appDataRoot("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
    expect(p.toLowerCase()).toContain("claude-fast");
    const m = appDataRoot("darwin", { HOME: "/Users/me" });
    expect(m).toBe(path.join("/Users/me", "Library", "Application Support", "claude-fast"));
  });
});

describe("resolveRootDir", () => {
  it("便携模式：exe 所在目录即数据根 → installMode=false", () => {
    writeFullConfig(tmp);
    const r = resolveRootDir(path.join(tmp, "claude-fast.exe"), "win32", {
      APPDATA: path.join(tmp, "appdata"),
    });
    expect(r.root).toBe(tmp);
    expect(r.installMode).toBe(false);
  });

  it("便携模式：数据根在 exe 上级目录", () => {
    writeFullConfig(tmp);
    const sub = path.join(tmp, "app", "bin");
    fs.mkdirSync(sub, { recursive: true });
    const r = resolveRootDir(path.join(sub, "claude-fast.exe"), "win32", {
      APPDATA: path.join(tmp, "appdata"),
    });
    expect(r.root).toBe(tmp);
    expect(r.installMode).toBe(false);
  });

  it("安装模式：找不到标记 → 回退 %APPDATA%\\claude-fast 并创建数据根本身", () => {
    const appdata = path.join(tmp, "appdata");
    const r = resolveRootDir(path.join(tmp, "bin", "claude-fast.exe"), "win32", { APPDATA: appdata });
    expect(r.root).toBe(path.join(appdata, "claude-fast"));
    expect(r.installMode).toBe(true);
    expect(fs.existsSync(r.root)).toBe(true);
  });

  it("同一 exe 路径重复调用命中缓存（同一次瞬态读失败不会让后续命令换根）", () => {
    const appdata = path.join(tmp, "appdata");
    const exe = path.join(tmp, "bin", "claude-fast.exe");
    const first = resolveRootDir(exe, "win32", { APPDATA: appdata });
    expect(first.installMode).toBe(true);
    // 结果缓存后，即便此刻出现了合格的便携根，也不改变本次会话的判定
    writeFullConfig(tmp);
    const second = resolveRootDir(exe, "win32", { APPDATA: appdata });
    expect(second).toBe(first);
    // reset 后重新判定才看得到新的便携根
    resetRootCache();
    expect(resolveRootDir(exe, "win32", { APPDATA: appdata }).root).toBe(tmp);
  });
});

describe("claudeProjectsDir", () => {
  it("CLAUDE_CONFIG_DIR 优先（官方自定义数据目录）", () => {
    const fake = path.join(tmp, "cc-config-dir");
    expect(claudeProjectsDir("win32", { CLAUDE_CONFIG_DIR: fake, USERPROFILE: "C:\\u" })).toBe(
      path.join(fake, "projects"),
    );
  });

  it("Windows 默认 %USERPROFILE%\\.claude\\projects", () => {
    expect(claudeProjectsDir("win32", { USERPROFILE: "C:\\Users\\me" })).toBe(
      path.join("C:\\Users\\me", ".claude", "projects"),
    );
  });

  it("macOS：~/.claude/projects 存在则优先", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    expect(claudeProjectsDir("darwin", { HOME: home })).toBe(
      path.join(home, ".claude", "projects"),
    );
  });

  it("macOS：~/.claude 缺失时后备 Claude Desktop 目录", () => {
    const home = path.join(tmp, "home2");
    fs.mkdirSync(
      path.join(home, "Library", "Application Support", "Claude", "projects"),
      { recursive: true },
    );
    expect(claudeProjectsDir("darwin", { HOME: home })).toBe(
      path.join(home, "Library", "Application Support", "Claude", "projects"),
    );
  });

  it("macOS：两者都缺失 → 返回 CLI 规范路径", () => {
    const home = path.join(tmp, "home3");
    expect(claudeProjectsDir("darwin", { HOME: home })).toBe(
      path.join(home, ".claude", "projects"),
    );
  });
});
