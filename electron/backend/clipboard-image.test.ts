// CF_HDROP（DROPFILES）字节解析单测：布局自造样本 + 真实形状的边界
import { describe, expect, it } from "vitest";
import { parseDropFiles } from "./clipboard-image";

/** 字符串 → UTF-16LE 字节（DROPFILES 文件区的真实编码；TextEncoder 给的是 UTF-8，别用） */
function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

/** 造一份 DROPFILES：20 字节头（pFiles=20，fWide=1）+ UTF-16LE 路径列表（末尾空串收尾） */
function dropWide(paths: string[]): Uint8Array {
  const parts: Uint8Array[] = [...paths.map((p) => utf16le(p + "\u0000")), utf16le("\u0000")];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    body.set(p, o);
    o += p.length;
  }
  const out = new Uint8Array(20 + body.length);
  new DataView(out.buffer).setUint32(0, 20, true); // pFiles
  new DataView(out.buffer).setUint32(16, 1, true); // fWide
  out.set(body, 20);
  return out;
}

describe("parseDropFiles", () => {
  it("UTF-16LE 多文件列表（资源管理器复制的真实形态）", () => {
    const buf = dropWide(["C:\\Users\\a\\截图.png", "C:\\Users\\a\\说明.txt"]);
    expect(parseDropFiles(buf)).toEqual(["C:\\Users\\a\\截图.png", "C:\\Users\\a\\说明.txt"]);
  });

  it("中文路径完整（UTF-16LE 不截半字）", () => {
    expect(parseDropFiles(dropWide(["D:\\项目\\测试 图.png"]))).toEqual(["D:\\项目\\测试 图.png"]);
  });

  it("头不合法（过短 / pFiles 越界）返回空", () => {
    expect(parseDropFiles(new Uint8Array(8))).toEqual([]);
    const bad = new Uint8Array(64);
    new DataView(bad.buffer).setUint32(0, 40, true); // pFiles 越界
    new DataView(bad.buffer).setUint32(16, 1, true);
    expect(parseDropFiles(bad)).toEqual([]);
  });

  it("单文件无尾随空串也能解（防御性：以缓冲区尽头为界）", () => {
    const one = utf16le("C:\\pic.jpg\u0000");
    const out = new Uint8Array(20 + one.length);
    new DataView(out.buffer).setUint32(0, 20, true);
    new DataView(out.buffer).setUint32(16, 1, true);
    out.set(one, 20);
    expect(parseDropFiles(out)).toEqual(["C:\\pic.jpg"]);
  });
});
