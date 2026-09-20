// 供应商域单元测试（对齐 v2.0.0 provider.rs 测试）。
// 不碰真实 ~/.claude/settings.json：路径与数据根都经 temp dir 注入。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  type ProviderInfo,
} from "./config";
import {
  claudeSettingsPathFrom,
  importDefaultFrom,
  parseCcswitchSql,
  providerDeleteFrom,
  providerImportCcswitchFrom,
  providerListFrom,
  providerReorderFrom,
  providerSaveFrom,
  readLiveSettings,
  reanchorCurrentFrom,
  sanitizeClaudeSettings,
  switchProviderFrom,
  writeFileAtomic,
} from "./provider";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-provider-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 构造供应商（settingsConfig 为整份 JSON 字符串，贴合本分支数据模型） */
function provider(id: string, baseUrl: string, token = "sk-1"): ProviderInfo {
  return {
    id,
    name: id,
    settingsConfig: JSON.stringify({
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token },
    }),
  };
}

function writeLive(obj: unknown, name = "settings.json"): void {
  writeFileAtomic(path.join(tmp, name), JSON.stringify(obj, null, 2));
}

// ---------------- sanitize ----------------

describe("sanitizeClaudeSettings", () => {
  it("只删内部键，保留业务键", () => {
    const v = {
      apiFormat: "openai_chat",
      api_format: "x",
      openrouterCompatMode: true,
      openrouter_compat_mode: true,
      env: { ANTHROPIC_BASE_URL: "https://x" },
      permissions: { defaultMode: "acceptEdits" },
    };
    const out = sanitizeClaudeSettings(v) as Record<string, unknown>;
    expect(out.apiFormat).toBeUndefined();
    expect(out.api_format).toBeUndefined();
    expect(out.openrouterCompatMode).toBeUndefined();
    expect(out.openrouter_compat_mode).toBeUndefined();
    expect(out.env).toBeDefined();
    expect(out.permissions).toBeDefined();
  });
});

// ---------------- 路径解析 ----------------

describe("claudeSettingsPathFrom", () => {
  it("settings.json 优先于遗留 claude.json", () => {
    fs.writeFileSync(path.join(tmp, "settings.json"), "{}");
    fs.writeFileSync(path.join(tmp, "claude.json"), "{}");
    expect(claudeSettingsPathFrom(tmp)).toBe(path.join(tmp, "settings.json"));
  });
  it("settings.json 缺失时回退 claude.json", () => {
    fs.writeFileSync(path.join(tmp, "claude.json"), "{}");
    expect(claudeSettingsPathFrom(tmp)).toBe(path.join(tmp, "claude.json"));
  });
  it("都不存在时默认 settings.json（切换时创建）", () => {
    expect(claudeSettingsPathFrom(tmp)).toBe(path.join(tmp, "settings.json"));
  });
});

// ---------------- 首启导入 ----------------

describe("importDefaultFrom", () => {
  it("live 存在则整文件收编为 default（custom 类）", () => {
    writeLive({ env: { ANTHROPIC_BASE_URL: "https://relay.example" }, permissions: { allow: ["Bash"] } });
    const p = importDefaultFrom(tmp);
    expect(p?.id).toBe("default");
    expect(p?.category).toBe("custom");
    expect(JSON.parse(p!.settingsConfig).permissions.allow[0]).toBe("Bash");
  });
  it("live 缺失返回 null", () => {
    expect(importDefaultFrom(tmp)).toBeNull();
  });
});

// ---------------- 切换三步 ----------------

describe("switchProviderFrom", () => {
  it("顺序：回填离任 + 记 current + sanitize 写 live", () => {
    writeLive({
      env: { ANTHROPIC_BASE_URL: "https://old.example", ANTHROPIC_AUTH_TOKEN: "sk-1" },
      permissions: { defaultMode: "acceptEdits" },
    });
    const providers = [provider("old", "https://old.example"), provider("new", "https://new.example")];
    const r = switchProviderFrom(tmp, providers, "old", "new");
    expect(r.warnings).toEqual([]);
    expect(r.currentId).toBe("new");

    const live = JSON.parse(fs.readFileSync(path.join(tmp, "settings.json"), "utf8"));
    expect(live.env.ANTHROPIC_BASE_URL).toBe("https://new.example");
    // 离任条目吸收了 live 里的手工修改（permissions 被回填）
    const oldSlot = providers.find((p) => p.id === "old")!;
    expect(JSON.parse(oldSlot.settingsConfig).permissions.defaultMode).toBe("acceptEdits");
  });

  it("切给自己不回填，live 被存储配置整文件覆盖", () => {
    writeLive({ env: { ANTHROPIC_BASE_URL: "https://old.example" }, hacked: true });
    const providers = [provider("old", "https://old.example")];
    const r = switchProviderFrom(tmp, providers, "old", "old");
    expect(r.warnings).toEqual([]);
    const live = JSON.parse(fs.readFileSync(path.join(tmp, "settings.json"), "utf8"));
    expect(live.hacked).toBeUndefined();
    expect(live.env.ANTHROPIC_BASE_URL).toBe("https://old.example");
  });

  it("切换前为旧 live 生成 .bak", () => {
    writeLive({ env: {} });
    const providers = [provider("old", "u1"), provider("new", "u2")];
    switchProviderFrom(tmp, providers, "old", "new");
    const bak = JSON.parse(fs.readFileSync(path.join(tmp, "settings.json.bak"), "utf8"));
    expect(bak.env).toEqual({});
  });

  it("live 缺失：回填告警但不阻塞（仍写 live、记 current）", () => {
    const providers = [provider("old", "https://old.example"), provider("new", "u")];
    const r = switchProviderFrom(tmp, providers, "old", "new");
    expect(r.warnings).toEqual(["backfill_failed:old"]);
    expect(r.currentId).toBe("new");
    expect(fs.existsSync(path.join(tmp, "settings.json"))).toBe(true);
  });

  it("live 指纹与离任不符：跳过回填仅告警", () => {
    writeLive({
      env: { ANTHROPIC_BASE_URL: "https://other.example", ANTHROPIC_AUTH_TOKEN: "sk-other" },
      permissions: { defaultMode: "acceptEdits" },
    });
    const old = provider("old", "https://old.example");
    const stored = JSON.stringify(JSON.parse(old.settingsConfig));
    const providers = [old, provider("new", "https://new.example")];
    const r = switchProviderFrom(tmp, providers, "old", "new");
    expect(r.warnings).toEqual(["backfill_skipped:old"]);
    expect(providers.find((p) => p.id === "old")!.settingsConfig).toBe(stored);
    expect(r.currentId).toBe("new");
  });

  it("目标不存在抛错且不写盘", () => {
    const providers = [provider("old", "https://old.example")];
    expect(() => switchProviderFrom(tmp, providers, "old", "ghost")).toThrow();
    expect(fs.existsSync(path.join(tmp, "settings.json"))).toBe(false);
  });
});

// ---------------- 标记重锚定 ----------------

describe("reanchorCurrentFrom", () => {
  it("live 与唯一条目 sanitize 后一致时修正 current", () => {
    const b = provider("b", "https://b.example");
    b.settingsConfig = JSON.stringify({
      ...JSON.parse(b.settingsConfig),
      apiFormat: "openai_chat",
      permissions: { defaultMode: "bypassPermissions" },
    });
    writeLive(sanitizeClaudeSettings(JSON.parse(b.settingsConfig)));
    const providers = [provider("a", "https://a.example"), b];
    expect(reanchorCurrentFrom(tmp, providers, "a")).toBe("b");
  });
  it("live 不匹配置/多匹配时保持原状", () => {
    const providers = [provider("a", "https://a.example"), provider("b", "https://b.example")];
    writeLive({
      env: { ANTHROPIC_BASE_URL: "https://a.example", ANTHROPIC_AUTH_TOKEN: "sk-1" },
      tweaked: true,
    });
    expect(reanchorCurrentFrom(tmp, providers, "a")).toBe("a");
  });
  it("live 缺失不修正", () => {
    const providers = [provider("a", "https://a.example")];
    expect(reanchorCurrentFrom(tmp, providers, "a")).toBe("a");
  });
});

// ---------------- CC Switch SQL 解析 ----------------

describe("parseCcswitchSql", () => {
  it("多行/''转义/app_type 过滤/NULL 列/is_current 采纳", () => {
    const sql = `BEGIN TRANSACTION;
INSERT INTO "providers" ("id", "app_type", "name", "settings_config", "website_url", "category", "is_current") VALUES
('p1', 'claude', 'Kimi 中转', '{"env":{"ANTHROPIC_BASE_URL":"https://api.moonshot.cn/anthropic"}}', 'https://kimi.com', 'cn_official', 1),
('p2', 'codex', '不该出现', '{}', NULL, NULL, 0),
('p3', 'claude', 'It''s 官方', '{"env":{}}', NULL, 'official', 0);
COMMIT;`;
    const [providers, current, warnings] = parseCcswitchSql(sql);
    expect(providers.length).toBe(2);
    expect(providers[0].id).toBe("p1");
    expect(providers[0].name).toBe("Kimi 中转");
    expect(JSON.parse(providers[0].settingsConfig).env.ANTHROPIC_BASE_URL).toBe(
      "https://api.moonshot.cn/anthropic",
    );
    expect(providers[0].websiteUrl).toBe("https://kimi.com");
    expect(providers[1].name).toBe("It's 官方");
    expect(current).toBe("p1");
    expect(warnings).toEqual([]);
  });

  it("列序无关 + 额外列", () => {
    const sql = `INSERT INTO "providers" ("meta", "sort_index", "name", "app_type", "settings_config", "id") VALUES ('{}', 3, 'B', 'claude', '{"env":{}}', 'pb'), ('{}', 1, 'A', 'claude', '{"env":{}}', 'pa');`;
    const [providers, current] = parseCcswitchSql(sql);
    expect(providers.length).toBe(2);
    expect(providers[0].id).toBe("pb"); // 按列名取值，与列序无关
    expect(current).toBeNull();
  });

  it("CAST blob 行跳过并告警", () => {
    const sql = `INSERT INTO "providers" ("id", "app_type", "name", "settings_config") VALUES ('bad', 'claude', '二进制', CAST(x'7B00FF' AS TEXT)), ('ok', 'claude', '正常', '{}');`;
    const [providers, , warnings] = parseCcswitchSql(sql);
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("ok");
    expect(warnings.length).toBe(1);
  });

  it("忽略其它表并继续扫描", () => {
    const sql = `INSERT INTO "mcp_servers" ("id", "name", "server_config") VALUES ('m1', 'x', '{}');
INSERT INTO "providers" ("id", "app_type", "name", "settings_config") VALUES ('only', 'claude', '唯一', '{"env":{}}');`;
    const [providers] = parseCcswitchSql(sql);
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("only");
  });

  it("同 id 去重 + 字符串内 ')' 与 INSERT INTO 不干扰", () => {
    const sql = `INSERT INTO "providers" ("id", "app_type", "name", "settings_config") VALUES ('dup', 'claude', '名字 (v2) INSERT INTO 伪造', '{}'), ('dup', 'claude', '重复', '{}');`;
    const [providers] = parseCcswitchSql(sql);
    expect(providers.length).toBe(1);
    expect(providers[0].name).toBe("名字 (v2) INSERT INTO 伪造");
  });

  it("非 SQL 文本返回空", () => {
    const [providers, current] = parseCcswitchSql("这不是 SQL 备份 {随机文本}");
    expect(providers).toEqual([]);
    expect(current).toBeNull();
  });
});

// ---------------- 命令层 ----------------

describe("providerListFrom", () => {
  it("首启自动收编 live 为 default 并持久化", async () => {
    writeLive({ env: { ANTHROPIC_BASE_URL: "https://relay.example" }, permissions: { allow: ["Bash"] } });
    const state = await providerListFrom(tmp, tmp);
    expect(state.currentId).toBe("default");
    expect(state.providers.length).toBe(1);
    // 落盘验证
    const cfg = loadConfig(tmp);
    expect(cfg.currentProvider).toBe("default");
    expect(cfg.providers.length).toBe(1);
    // live 未被消费
    expect(readLiveSettings(tmp)).not.toBeNull();
  });
});

describe("providerSaveFrom", () => {
  it("保存当前供应商同步写 live", async () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({
        providers: [
          {
            id: "a",
            name: "A",
            settingsConfig: JSON.stringify({
              env: {
                ANTHROPIC_BASE_URL: "https://a.example",
                ANTHROPIC_AUTH_TOKEN: "sk-1",
                ANTHROPIC_DEFAULT_HAIKU_MODEL: "old-model",
              },
            }),
          },
          { id: "b", name: "B", settingsConfig: "{}" },
        ],
        currentProvider: "a",
      }),
    );
    writeLive({
      env: {
        ANTHROPIC_BASE_URL: "https://a.example",
        ANTHROPIC_AUTH_TOKEN: "sk-1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "old-model",
      },
    });
    const updated: ProviderInfo = {
      id: "a",
      name: "A",
      settingsConfig: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://a.example",
          ANTHROPIC_AUTH_TOKEN: "sk-1",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "new-model",
        },
      }),
    };
    await providerSaveFrom(tmp, tmp, updated);
    const live = JSON.parse(fs.readFileSync(path.join(tmp, "settings.json"), "utf8"));
    expect(live.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("new-model");
    const cfg = loadConfig(tmp);
    expect(JSON.parse(cfg.providers.find((p) => p.id === "a")!.settingsConfig).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      "new-model",
    );
  });

  it("保存非当前供应商不碰 live", async () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({
        providers: [
          { id: "a", name: "A", settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://a.example" } }) },
          { id: "b", name: "B", settingsConfig: "{}" },
        ],
        currentProvider: "a",
      }),
    );
    writeLive({ env: { ANTHROPIC_BASE_URL: "https://a.example", TWEAKED: true } });
    await providerSaveFrom(tmp, tmp, {
      id: "b",
      name: "B",
      settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://b.example" } }),
    });
    const live = JSON.parse(fs.readFileSync(path.join(tmp, "settings.json"), "utf8"));
    expect(live.env.TWEAKED).toBe(true);
    expect(live.env.ANTHROPIC_BASE_URL).toBe("https://a.example");
  });

  it("名称为空报错、settingsConfig 非法报错", async () => {
    await expect(
      providerSaveFrom(tmp, tmp, { id: "", name: "  ", settingsConfig: "{}" }),
    ).rejects.toThrow();
    await expect(
      providerSaveFrom(tmp, tmp, { id: "", name: "X", settingsConfig: "not json" }),
    ).rejects.toThrow();
  });
});

describe("providerDeleteFrom / providerReorderFrom", () => {
  function seedConfig() {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({
        providers: [
          { id: "a", name: "A", settingsConfig: "{}" },
          { id: "b", name: "B", settingsConfig: "{}" },
          { id: "c", name: "C", settingsConfig: "{}" },
        ],
        currentProvider: "a",
      }),
    );
  }

  it("删除非当前成功，删除当前报错", async () => {
    seedConfig();
    const r = await providerDeleteFrom(tmp, tmp, "b");
    expect(r.providers.map((p) => p.id)).toEqual(["a", "c"]);
    await expect(providerDeleteFrom(tmp, tmp, "a")).rejects.toThrow();
    await expect(providerDeleteFrom(tmp, tmp, "ghost")).rejects.toThrow();
  });

  it("按 ids 顺序稳定重排并持久化", async () => {
    seedConfig();
    // 只提及 b：a/c 未提及按原相对顺序沉底
    await providerReorderFrom(tmp, tmp, ["b"]);
    const cfg = loadConfig(tmp);
    expect(cfg.providers.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});

describe("providerImportCcswitchFrom", () => {
  it("无 Claude 供应商报错", async () => {
    const f = path.join(tmp, "backup.sql");
    fs.writeFileSync(f, `INSERT INTO "providers" ("id","app_type","name","settings_config") VALUES ('x','codex','y','{}');`);
    await expect(providerImportCcswitchFrom(tmp, f)).rejects.toThrow();
  });
});
