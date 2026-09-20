// 回收站：删除会话 = 先备份再删除（数据安全铁律），支持恢复/永久删除
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidUuid, unmangleExistingAny } from "./mangle";
import { readHeadTail, sessionMetaFromLite } from "./sessions";

export interface TrashedSession {
  /** 备份文件绝对路径（恢复/永久删除时回传） */
  file: string;
  sessionId: string;
  /** 标题（复用会话元数据解析：customTitle > aiTitle > 首条消息） */
  title: string;
  /** 删除时间（备份目录名 YYYYMMDD_HHMMSS，UTC） */
  deletedAt: string;
  /** 原项目 mangled 目录名 */
  projectDir: string;
  /** 原项目路径（unmangle 反向解析，找到真实存在者；找不到则为 null） */
  projectPath: string | null;
}

/** UTC 时间戳目录名：YYYYMMDD_HHMMSS（备份/回收站目录用） */
export function utcTimestamp(now: Date = new Date()): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return (
    `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1, 2)}${p(now.getUTCDate(), 2)}` +
    `_${p(now.getUTCHours(), 2)}${p(now.getUTCMinutes(), 2)}${p(now.getUTCSeconds(), 2)}`
  );
}

/** 删除会话文件的核心逻辑：**先备份到 trash_root/<时间戳>/<项目>/ 再删除**
 *  （数据安全铁律：破坏性操作先备份；备份即回收站，可恢复）。返回备份文件路径。 */
export function deleteSessionFile(p: string, trashRoot: string): string {
  const name = path.basename(p);
  if (name === "" || name === "." || name === "..") throw new Error("非法会话文件名");
  // 保留原项目 mangled 目录名，恢复时直接放回 projects/<mangled>/
  const parent = path.dirname(p);
  const mangled = path.basename(parent) || "unknown";
  const backupDir = path.join(trashRoot, utcTimestamp(), mangled);
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, name);
  // 同卷 rename 原子优先；跨卷（便携模式 exe 在别的盘）回退 copy + remove
  try {
    fs.renameSync(p, backup);
  } catch {
    try {
      fs.copyFileSync(p, backup);
    } catch (e) {
      throw new Error(`备份会话失败：${String(e)}`);
    }
    try {
      fs.unlinkSync(p);
    } catch (e) {
      throw new Error(`删除会话失败：${String(e)}`);
    }
  }
  return backup;
}

function isValidTrashedJsonl(name: string): string | null {
  if (!name.endsWith(".jsonl")) return null;
  const sessionId = name.slice(0, -".jsonl".length);
  return isValidUuid(sessionId) ? sessionId : null;
}

/** 列出回收站中的全部会话备份（按删除时间倒序）。
 *  trashRoot / platform 可注入（测试用临时目录与跨平台验证）。 */
export function listTrashedSessionsIn(
  trashRoot: string,
  platform: NodeJS.Platform = process.platform,
): TrashedSession[] {
  const out: TrashedSession[] = [];
  let batches: fs.Dirent[];
  try {
    batches = fs.readdirSync(trashRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const batch of batches) {
    const ts = batch.name;
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(path.join(trashRoot, ts), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const proj of projects) {
      const projectDir = proj.name;
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(path.join(trashRoot, ts, projectDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile()) continue;
        const sessionId = isValidTrashedJsonl(f.name);
        if (!sessionId) continue;
        const p = path.join(trashRoot, ts, projectDir, f.name);
        // 复用会话元数据解析提取标题
        const ht = readHeadTail(p);
        const title =
          (ht ? sessionMetaFromLite(ht.head, ht.tail, sessionId, 0)?.title : null) ??
          "未命名会话";
        // 反向解析原项目路径（取真实存在者）
        const projectPath = unmangleExistingAny(projectDir, platform);
        out.push({
          file: p,
          sessionId,
          title,
          deletedAt: ts,
          projectDir,
          projectPath,
        });
      }
    }
  }
  out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  return out;
}

/** 校验回收站备份文件路径：必须位于数据根 trash/sessions/ 下、名称为 <uuid>.jsonl。
 *  返回 (path, sessionId, mangled 项目目录名)。
 *
 *  同 `validateSessionFile`：先词法作用域（不碰文件系统、报错准确），再 canonicalize
 *  作用域（挡住指向外部的符号链接）；备份文件不存在时 realpath 失败即拒绝。 */
export function validateTrashFile(
  file: string,
  root: string,
): { path: string; sessionId: string; mangled: string } {
  const p = path.resolve(file);
  const name = path.basename(p);
  if (!name.endsWith(".jsonl")) throw new Error("非法备份文件");
  const sessionId = name.slice(0, -".jsonl".length);
  if (!isValidUuid(sessionId)) throw new Error("非法备份文件");
  const trashRoot = path.join(root, "trash", "sessions");
  const rel = path.relative(trashRoot, p);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("备份文件不在回收站中");
  }
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(p);
    realRoot = fs.realpathSync(trashRoot);
  } catch {
    throw new Error("备份文件不存在");
  }
  const realRel = path.relative(realRoot, real);
  if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error("备份文件不在回收站中");
  }
  // 备份路径结构：trash/sessions/<ts>/<mangled>/<uuid>.jsonl
  const mangled = path.basename(path.dirname(real));
  if (!mangled) throw new Error("非法备份文件");
  return { path: real, sessionId, mangled };
}

/** 恢复会话的核心逻辑：移回 projects_root/<mangled>/。返回恢复后的路径。 */
export function restoreTrashedFile(p: string, projectsRoot: string): string {
  const name = path.basename(p);
  const mangled = path.basename(path.dirname(p));
  const targetDir = path.join(projectsRoot, mangled);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, name);
  // 目标已存在（会话已恢复过）→ 拒绝，避免覆盖
  if (fs.existsSync(target)) {
    throw new Error("目标位置已存在同名会话，请先确认是否已恢复过");
  }
  try {
    fs.renameSync(p, target);
  } catch {
    try {
      fs.copyFileSync(p, target);
    } catch (e) {
      throw new Error(`恢复会话失败：${String(e)}`);
    }
    try {
      fs.unlinkSync(p);
    } catch (e) {
      throw new Error(`清理备份失败：${String(e)}`);
    }
  }
  return target;
}

/** 从回收站永久删除备份（不可恢复）。调用方必须已二次确认。 */
export function purgeSessionBackup(file: string, root: string): void {
  const { path: p } = validateTrashFile(file, root);
  try {
    fs.unlinkSync(p);
  } catch (e) {
    throw new Error(`删除备份失败：${String(e)}`);
  }
}

/** 清空回收站的核心逻辑：彻底删除 trash/sessions 下的全部会话备份
 *  （释放磁盘空间，不可恢复）。调用方必须已二次确认。返回被删除的会话数。 */
export function purgeTrashIn(trashRoot: string): number {
  const count = listTrashedSessionsIn(trashRoot).length;
  if (count === 0) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(trashRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error(`读取回收站失败：${String(e)}`);
  }
  for (const entry of entries) {
    const p = path.join(trashRoot, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: false });
      } else {
        fs.unlinkSync(p);
      }
    } catch (e) {
      throw new Error(
        `${entry.isDirectory() ? "删除备份目录" : "删除备份"}失败：${String(e)}`,
      );
    }
  }
  return count;
}
