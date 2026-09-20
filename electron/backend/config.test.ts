// 配置读写单元测试（对齐 v2.0.0：strip_bom / load 回退 / save 原子写 / 读改写 / 不丢字段）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultConfig,
  decodeConfig,
  dropPinsForProjects,
  encodeConfig,
  loadConfig,
  mutateConfig,
  pruneDeadPins,
  saveConfig,
  updateConfig,
  type Config,
} from "./config";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-config-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readDisk(dir = tmp): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
}

describe("loadConfig", () => {
  it("读取正常配置", () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({
        order: ["D:\\a"],
        favorites: ["D:\\a", "D:\\b"],
        projects: ["D:\\x"],
        dark: true,
        closeAction: "quit",
      }),
    );
    const c = loadConfig(tmp);
    expect(c.order).toEqual(["D:\\a"]);
    expect(c.favorites).toEqual(["D:\\a", "D:\\b"]);
    expect(c.projects).toEqual(["D:\\x"]);
    expect(c.dark).toBe(true);
    expect(c.closeAction).toBe("quit");
  });

  it("BOM 文件可读", () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', "utf8")]);
    fs.writeFileSync(path.join(tmp, "config.json"), raw);
    // 字段缺失时回退默认值（不抛错）；"a" 是未知键 → 进 unknownFields
    const c = loadConfig(tmp);
    expect(c).toEqual({ ...defaultConfig(), unknownFields: { a: 1 } });
  });

  it("主文件损坏 → 回退 .bak 并恢复主文件", () => {
    fs.writeFileSync(path.join(tmp, "config.json.bak"), '{"favorites":["x"],"dark":true}');
    fs.writeFileSync(path.join(tmp, "config.json"), "{broken");
    const c = loadConfig(tmp);
    expect(c.favorites).toEqual(["x"]);
    expect(c.dark).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8")).dark).toBe(true);
  });

  it("都缺失 → 默认配置", () => {
    expect(loadConfig(tmp)).toEqual(defaultConfig());
  });

  it("favorites → order 迁移：order 缺失时用旧收藏顺序当显示顺序初值", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ favorites: ["D:\\b", "D:\\a"] }));
    expect(loadConfig(tmp).order).toEqual(["D:\\b", "D:\\a"]);
  });

  it("order 显式为 [] 时不被旧 favorites 覆盖回去", () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ order: [], favorites: ["D:\\a"] }),
    );
    expect(loadConfig(tmp).order).toEqual([]);
  });

  it("未知顶层字段进 unknownFields（不是丢弃）", () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ dark: true, someFutureKey: { nested: 1 }, another: "x" }),
    );
    const c = loadConfig(tmp);
    expect(c.unknownFields).toEqual({ someFutureKey: { nested: 1 }, another: "x" });
  });

  it("供应商 / 置顶条目的形状归一（坏条目跳过，不整份解析失败）", () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({
        providers: [
          { id: "p1", name: "智谱", settingsConfig: "{}", extra: 1 },
          "garbage",
          null,
          { name: "无 id" },
        ],
        pinnedSessions: [{ file: "C:\\s.jsonl", projectPath: "C:\\p" }, { nope: 1 }, 3],
      }),
    );
    const c = loadConfig(tmp);
    expect(c.providers.length).toBe(2);
    expect(c.providers[0]).toEqual({ id: "p1", name: "智谱", settingsConfig: "{}", extra: 1 });
    expect(c.providers[1].id).toBe("");
    expect(c.pinnedSessions).toEqual([{ file: "C:\\s.jsonl", projectPath: "C:\\p" }]);
  });
});

describe("encodeConfig", () => {
  it("落盘写全 8 个已知键（数据根判定依赖这一点：缺键会让 portable 根认不出来）", () => {
    const onDisk = JSON.parse(encodeConfig(defaultConfig()));
    expect(Object.keys(onDisk).sort()).toEqual(
      [
        "order",
        "projects",
        "excluded",
        "dark",
        "closeAction",
        "providers",
        "currentProvider",
        "pinnedSessions",
        "favorites",
      ].sort(),
    );
  });

  it("已知键覆盖 unknownFields 里的同名脏值", () => {
    const cfg = defaultConfig();
    cfg.unknownFields = { dark: "not-a-bool", keep: 1 };
    cfg.dark = true;
    const onDisk = JSON.parse(encodeConfig(cfg));
    expect(onDisk.dark).toBe(true);
    expect(onDisk.keep).toBe(1);
  });
});

describe("saveConfig", () => {
  it("三步保护：临时文件 → .bak 备份 → 原子替换", () => {
    const first: Config = { ...defaultConfig(), favorites: ["a"] };
    saveConfig(tmp, first);
    expect(loadConfig(tmp).favorites).toEqual(["a"]);

    saveConfig(tmp, { ...defaultConfig(), favorites: ["a", "b"], dark: true, closeAction: "minimize" });
    const bak = JSON.parse(fs.readFileSync(path.join(tmp, "config.json.bak"), "utf8"));
    expect(bak.favorites).toEqual(["a"]);
    const main = loadConfig(tmp);
    expect(main.favorites).toEqual(["a", "b"]);
    expect(main.dark).toBe(true);
    expect(main.closeAction).toBe("minimize");
    expect(fs.existsSync(path.join(tmp, "config.json.tmp"))).toBe(false);
  });
});

describe("updateConfig / mutateConfig（读改写）", () => {
  it("只覆盖 patch 里出现过的键——未传字段（供应商/置顶/顺序）不被清空", async () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({
        order: ["D:\\a"],
        projects: ["D:\\a"],
        excluded: [],
        dark: false,
        closeAction: null,
        providers: [{ id: "p1", name: "智谱", settingsConfig: "{}" }],
        currentProvider: "p1",
        pinnedSessions: [{ file: "C:\\s.jsonl", projectPath: "D:\\a" }],
        favorites: ["D:\\a"],
      }),
    );
    // 模拟「设置对话框只改了主题 + 关闭行为」
    await updateConfig(tmp, { dark: true, closeAction: "quit" });

    const disk = readDisk();
    expect(disk.dark).toBe(true);
    expect(disk.closeAction).toBe("quit");
    expect(disk.providers).toEqual([{ id: "p1", name: "智谱", settingsConfig: "{}" }]);
    expect(disk.currentProvider).toBe("p1");
    expect(disk.pinnedSessions).toEqual([{ file: "C:\\s.jsonl", projectPath: "D:\\a" }]);
    expect(disk.order).toEqual(["D:\\a"]);
    expect(disk.projects).toEqual(["D:\\a"]);
  });

  it("未知字段在保存后仍在（跨版本共存不丢数据）", async () => {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ dark: false, futureKey: ["x"] }));
    await updateConfig(tmp, { dark: true });
    expect(readDisk().futureKey).toEqual(["x"]);
  });

  it("closeAction 非法值归一为 null", async () => {
    await updateConfig(tmp, { closeAction: "nonsense" as unknown as null });
    expect(readDisk().closeAction).toBe(null);
  });

  it("同一数据根的并发写被串行化，不会互相覆盖（无丢失更新）", async () => {
    await updateConfig(tmp, { projects: [] });
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      ops.push(
        mutateConfig(tmp, (cfg) => {
          cfg.projects = [...cfg.projects, `D:\\p${i}`];
        }),
      );
    }
    await Promise.all(ops);
    expect(loadConfig(tmp).projects.length).toBe(12);
  });

  it("前一个写操作抛错不阻塞后续写", async () => {
    await expect(
      mutateConfig(tmp, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await updateConfig(tmp, { dark: true });
    expect(loadConfig(tmp).dark).toBe(true);
  });
});

describe("置顶条目清理语义", () => {
  it("dropPinsForProjects 按项目路径撤条目（大小写不敏感）", () => {
    const cfg: Config = {
      ...defaultConfig(),
      pinnedSessions: [
        { file: "C:\\a\\1.jsonl", projectPath: "D:\\Proj" },
        { file: "C:\\a\\2.jsonl", projectPath: "D:\\other" },
      ],
    };
    dropPinsForProjects(cfg, ["d:\\proj"]);
    expect(cfg.pinnedSessions.map((p) => p.file)).toEqual(["C:\\a\\2.jsonl"]);
  });

  it("pruneDeadPins 清掉文件已不存在的条目", () => {
    const cfg: Config = {
      ...defaultConfig(),
      pinnedSessions: [
        { file: "C:\\keep.jsonl", projectPath: "D:\\p" },
        { file: "C:\\gone.jsonl", projectPath: "D:\\p" },
      ],
    };
    pruneDeadPins(cfg, (f) => f.includes("keep"));
    expect(cfg.pinnedSessions.map((p) => p.file)).toEqual(["C:\\keep.jsonl"]);
  });

  it("decodeConfig 对非对象输入返回默认配置", () => {
    expect(decodeConfig(null)).toEqual(defaultConfig());
    expect(decodeConfig([1, 2])).toEqual(defaultConfig());
  });
});
