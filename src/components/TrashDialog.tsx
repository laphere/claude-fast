import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrashedSession } from "../types";
import Modal from "./Modal";
import { TrashIcon } from "./Icons";

interface Props {
  onClose: () => void;
  /** 恢复/删除成功后通知 App 刷新（如展开项目的会话列表） */
  onChanged: () => void;
  onToast: (msg: string) => void;
}

/** 删除时间目录名（后端按 UTC 生成：YYYYMMDD_HHMMSS）→ 本地时间 YYYY-MM-DD HH:MM。
 *  裸时间戳无时区标记，必须按 UTC 解析再转本地时区，否则东八区显示会差 8 小时 */
function formatDeletedAt(ts: string): string {
  if (ts.length < 15) return ts;
  const num = (i: number, n = 2) => Number(ts.slice(i, i + n));
  const d = new Date(Date.UTC(num(0, 4), num(4) - 1, num(6), num(9), num(11), num(13)));
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 回收站：删除的会话备份在这里，可恢复或永久删除（永久删除需行内二次确认） */
export default function TrashDialog({ onClose, onChanged, onToast }: Props) {
  const [items, setItems] = useState<TrashedSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 待行内确认永久删除的文件路径 */
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  /** 待确认清空整个回收站 */
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  /** 清空回收站进行中 */
  const [busyAll, setBusyAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listTrashedSessions());
    } catch (e) {
      onToast("加载回收站失败：" + String(e));
      setItems([]);
    }
  }, [onToast]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = async (item: TrashedSession) => {
    setBusy(item.file);
    try {
      await api.restoreSession(item.file);
      onToast(`已恢复会话「${item.title}」到原项目`);
      onChanged();
      await load();
    } catch (e) {
      onToast("恢复失败：" + String(e));
    }
    setBusy(null);
  };

  const purge = async (item: TrashedSession) => {
    setBusy(item.file);
    try {
      await api.purgeSession(item.file);
      onToast(`已永久删除会话「${item.title}」`);
      await load();
    } catch (e) {
      onToast("删除失败：" + String(e));
    }
    setBusy(null);
    setConfirmPurge(null);
  };

  const purgeAll = async () => {
    setBusyAll(true);
    try {
      const count = await api.purgeTrash();
      onToast(`已清空回收站（${count} 个会话已彻底删除）`);
      setConfirmPurgeAll(false);
      await load();
    } catch (e) {
      onToast("清空失败：" + String(e));
    }
    setBusyAll(false);
  };

  return (
    <Modal title="回收站" width={640} onClose={onClose}>
      <div className="trash">
        {items === null ? (
          <div className="session-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="trash-empty">
            <div className="empty-icon">
              <TrashIcon size={34} />
            </div>
            <div>回收站是空的</div>
            <div className="empty-sub">删除的会话会移到这里，可随时恢复</div>
          </div>
        ) : (
          <div className="trash-list">
            {items.map((item) => (
              <div key={item.file} className="trash-row">
                <div className="session-body">
                  <div className="session-title">{item.title}</div>
                  <div className="session-meta">
                    {item.projectPath ?? item.projectDir}
                    {" · "}
                    {formatDeletedAt(item.deletedAt)} 删除
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="btn btn-primary trash-restore"
                    disabled={busy === item.file}
                    onClick={() => restore(item)}
                  >
                    {busy === item.file ? "处理中…" : "恢复"}
                  </button>
                  {confirmPurge === item.file ? (
                    <button
                      className="btn btn-danger"
                      disabled={busy === item.file}
                      onClick={() => purge(item)}
                    >
                      确认永久删除？
                    </button>
                  ) : (
                    <button
                      className="btn trash-purge"
                      disabled={busy === item.file}
                      onClick={() => setConfirmPurge(item.file)}
                    >
                      永久删除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {items !== null && items.length > 0 && (
          <div className="trash-toolbar">
            {confirmPurgeAll ? (
              <button
                className="btn btn-danger"
                disabled={busyAll}
                onClick={() => purgeAll()}
              >
                {busyAll ? "清空中…" : `确认清空？${items.length} 个会话将不可恢复`}
              </button>
            ) : (
              <button
                className="btn trash-purge"
                disabled={busyAll}
                onClick={() => setConfirmPurgeAll(true)}
              >
                清空回收站
              </button>
            )}
          </div>
        )}
        <div className="trash-hint">
          会话删除后移入回收站（数据根 trash/ 目录），恢复后回到原项目，Claude Code 可继续 resume。
        </div>
      </div>
    </Modal>
  );
}
