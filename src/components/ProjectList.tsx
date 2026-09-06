import { useCallback, useState } from "react";
import type { DragEvent } from "react";
import type { Project, SessionInfo } from "../types";
import { ChatIcon, TrashIcon } from "./Icons";

interface Props {
  items: Project[];
  favorites: string[];
  selectedKey: string | null;
  /** 当前展开会话列表的项目 key */
  expandedKey: string | null;
  /** 当前在右侧打开的会话文件路径（用于列表高亮标记） */
  activeSessionFile: string | null;
  /** 各项目的会话缓存：undefined = 未加载；null = 加载中；数组 = 已加载 */
  sessionsByKey: Record<string, SessionInfo[] | null | undefined>;
  onSelect: (key: string) => void;
  onToggleFav: (key: string) => void;
  /** 收藏项拖拽排序：把 draggedKey 移动到 targetKey 之前/之后 */
  onReorderFavorite: (draggedKey: string, targetKey: string, before: boolean) => void;
  /** 是否启用拖拽排序（搜索过滤期间禁用） */
  dragEnabled: boolean;
  onToggleExpand: (key: string) => void;
  onRenameSession: (key: string, session: SessionInfo) => void;
  onDeleteSession: (key: string, session: SessionInfo) => void;
  /** 会话行右键菜单（查看内容/终端继续/重命名收进菜单） */
  onSessionContextMenu: (x: number, y: number, key: string, session: SessionInfo) => void;
  /** app 内新开对话 */
  onChatProject: (key: string) => void;
  /** app 内继续已有会话（点击会话行 = 直接进入对话） */
  onChatSession: (key: string, session: SessionInfo) => void;
  onContextMenu: (x: number, y: number, key: string) => void;
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / MM-DD HH:mm */
function formatTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return "昨天";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ProjectList({
  items,
  favorites,
  selectedKey,
  expandedKey,
  activeSessionFile,
  sessionsByKey,
  onSelect,
  onToggleFav,
  onReorderFavorite,
  dragEnabled,
  onToggleExpand,
  onDeleteSession,
  onSessionContextMenu,
  onChatProject,
  onChatSession,
  onContextMenu,
}: Props) {
  // ---------- 收藏拖拽排序（仅临时视觉状态，顺序真源在 App 的 favorites 数组）----------

  /** 正在拖拽的收藏项 key */
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** 悬停目标行 key */
  const [overKey, setOverKey] = useState<string | null>(null);
  /** 悬停在上半/下半（决定插入到目标之前/之后） */
  const [overPos, setOverPos] = useState<"above" | "below">("above");

  /** dragend 兜底清理：Esc 取消 / 窗外释放都会触发 */
  const clearDragState = useCallback(() => {
    setDragKey(null);
    setOverKey(null);
  }, []);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, key: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key); // WebKit：无 data 拖拽不会启动
    setDragKey(key);
  };

  const handleDragOver = (
    e: DragEvent<HTMLDivElement>,
    key: string,
    isFav: boolean,
  ) => {
    if (!dragKey || !isFav) return; // 不 preventDefault → 此处不可放置（浏览器显示禁用光标）
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < r.top + r.height / 2 ? "above" : "below";
    setOverKey((k) => (k === key ? k : key)); // 值不变 → React 跳过重渲染（dragover 高频触发）
    setOverPos((p) => (p === pos ? p : pos));
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>, key: string) => {
    if (overKey !== key) return;
    const rt = e.relatedTarget as Node | null;
    if (rt && e.currentTarget.contains(rt)) return; // 仍在行内（子元素间移动）
    setOverKey(null);
  };

  const handleDrop = (
    e: DragEvent<HTMLDivElement>,
    key: string,
    isFav: boolean,
  ) => {
    if (!dragKey || !isFav) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2; // 从事件重算，不依赖 state
    const dragged = dragKey;
    clearDragState();
    onReorderFavorite(dragged, key, before);
  };

  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">🗂</div>
        <div>没有找到匹配的项目</div>
        <div className="empty-sub">点击「批量添加」扫描 Claude Code 项目，或「新建」手动添加</div>
      </div>
    );
  }

  return (
    <div className="list">
      {items.map((l) => {
        const isFav = favorites.includes(l.key);
        const canDrag = dragEnabled && isFav;
        const showDrop = overKey === l.key && l.key !== dragKey;
        const isSelected = l.key === selectedKey;
        const isExpanded = l.key === expandedKey;
        const sessions = sessionsByKey[l.key];
        return (
          <div key={l.key} className={`row-wrap ${isExpanded ? "expanded" : ""}`}>
            <div
              className={`row ${isSelected ? "selected" : ""} ${
                l.healthy === false ? "broken" : ""
              } ${isFav ? "row-fav" : ""} ${l.key === dragKey ? "dragging" : ""} ${
                showDrop ? (overPos === "above" ? "drop-above" : "drop-below") : ""
              }`}
              draggable={canDrag}
              onDragStart={(e) => handleDragStart(e, l.key)}
              onDragEnd={clearDragState}
              onDragOver={(e) => handleDragOver(e, l.key, isFav)}
              onDragLeave={(e) => handleDragLeave(e, l.key)}
              onDrop={(e) => handleDrop(e, l.key, isFav)}
              onClick={() => {
                onSelect(l.key);
                onToggleExpand(l.key);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(l.key);
                onContextMenu(e.clientX, e.clientY, l.key);
              }}
            >
              <button
                className={`star ${isFav ? "star-on" : ""}`}
                title={isFav ? "取消收藏" : "收藏（置顶）"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFav(l.key);
                }}
              >
                ★
              </button>
              <div className="row-body" title="展开/收起会话列表">
                <div className="row-label">
                  {l.name}
                  {l.healthy === false && <span className="tag tag-danger">失效</span>}
                </div>
                <div className="row-path">{l.path}</div>
              </div>
              {l.healthy !== false && (
                <div className="row-actions">
                  <button
                    className="row-icon row-icon-chat"
                    title="app 内对话（新建会话）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChatProject(l.key);
                    }}
                  >
                    <ChatIcon />
                  </button>
                  <button
                    className="row-icon row-icon-more"
                    title="更多操作（与右键菜单相同：终端启动/打开文件夹/收藏等）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(l.key);
                      onContextMenu(e.clientX, e.clientY, l.key);
                    }}
                  >
                    ⋯
                  </button>
                </div>
              )}
            </div>
            {isExpanded && (
              <div className="sessions">
                {sessions === null ? (
                  <div className="session-empty">会话加载中…</div>
                ) : sessions === undefined || sessions.length === 0 ? (
                  <div className="session-empty">
                    暂无会话（Claude Code 未在本项目启动过）
                  </div>
                ) : (
                  sessions.map((s) => (
                    <div
                      key={s.sessionId}
                      className={`session-row ${
                        s.file === activeSessionFile ? "active" : ""
                      }`}
                      onClick={() => onChatSession(l.key, s)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onSessionContextMenu(e.clientX, e.clientY, l.key, s);
                      }}
                      title="点击在 app 内继续对话，右键更多操作"
                    >
                      <div className="session-body">
                        <div className="session-title">{s.title}</div>
                        <div className="session-meta">
                          {formatTime(s.lastModified)}
                          {s.summary && ` · ${s.summary}`}
                        </div>
                      </div>
                      <button
                        className="session-rename session-del"
                        title="删除会话（移入回收站，可恢复）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(l.key, s);
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
