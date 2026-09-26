import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Project, SessionInfo } from "../types";
import { FolderIcon, MoreIcon, PinIcon, PlusIcon } from "./Icons";
import { useFlip } from "../lib/flip";

interface Props {
  items: Project[];
  /** 已置顶会话的文件集合：置顶会话不在项目列表里重复显示 */
  pinnedFiles: Set<string>;
  selectedKey: string | null;
  /** 当前展开会话列表的项目 key */
  expandedKey: string | null;
  /** 当前在右侧打开的会话文件路径（用于列表高亮标记） */
  activeSessionFile: string | null;
  /** 各项目的会话缓存：undefined = 未加载；null = 加载中；数组 = 已加载 */
  sessionsByKey: Record<string, SessionInfo[] | null | undefined>;
  onSelect: (key: string) => void;
  /** 全局拖拽排序：把 draggedKey 移动到 targetKey 之前/之后 */
  onReorder: (draggedKey: string, targetKey: string, before: boolean) => void;
  /** 置顶 / 取消置顶（置顶条目只存 jsonl 路径 + 项目路径，故传 file 而非整份元数据） */
  onTogglePin: (key: string, file: string) => void;
  /** 是否启用拖拽排序（搜索过滤期间禁用） */
  dragEnabled: boolean;
  onToggleExpand: (key: string) => void;
  /** 会话行右键菜单（终端继续/重命名/置顶/删除收进菜单，行上不放按钮挤占标题宽度） */
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
  pinnedFiles,
  selectedKey,
  expandedKey,
  activeSessionFile,
  sessionsByKey,
  onSelect,
  onReorder,
  onTogglePin,
  dragEnabled,
  onToggleExpand,
  onSessionContextMenu,
  onChatProject,
  onChatSession,
  onContextMenu,
}: Props) {
  // ---------- 全局拖拽排序（仅临时视觉状态，顺序真源在 App 的 order 数组）----------

  const listRef = useRef<HTMLDivElement>(null);
  // FLIP 让位：拖拽落位 / 移到最前 / 删除项目后，其余行平滑滑到新位；展开/收起把
  // 下方行推下去收上来（所以签名里带 expandedKey——它改行高、同样产生位移）。
  // 搜索过滤期间 enabled=false：逐键重排，播了反而抖，只记基线
  useFlip(
    listRef,
    ".row-wrap",
    items.map((l) => l.key).join("\u0000") + "\u0000" + (expandedKey ?? ""),
    dragEnabled,
  );

  /** 正在拖拽的项目 key */
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

  const handleDragOver = (e: DragEvent<HTMLDivElement>, key: string) => {
    if (!dragKey) return;
    e.preventDefault(); // 任意行都是合法目标
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

  const handleDrop = (e: DragEvent<HTMLDivElement>, key: string) => {
    if (!dragKey) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2; // 从事件重算，不依赖 state
    const dragged = dragKey;
    clearDragState();
    onReorder(dragged, key, before);
  };

  if (items.length === 0) {
    // 搜索中（dragEnabled=false 即搜索期）与「真的没有项目」是两种空态
    const searching = !dragEnabled;
    return (
      <div className="empty">
        <div className="empty-icon">
          <FolderIcon size={34} />
        </div>
        <div>{searching ? "没有找到匹配的项目" : "还没有项目"}</div>
        <div className="empty-sub">
          {searching
            ? "换个关键词试试，或清空搜索查看全部项目"
            : "点击「批量添加」扫描 Claude Code 项目，或「新建」手动添加"}
        </div>
      </div>
    );
  }

  return (
    <div className="list" ref={listRef}>
      {items.map((l) => {
        const showDrop = overKey === l.key && l.key !== dragKey;
        const isSelected = l.key === selectedKey;
        const isExpanded = l.key === expandedKey;
        const sessions = sessionsByKey[l.key];
        // 置顶会话不在项目里重复显示（置顶区单独列出）
        const visibleSessions =
          sessions?.filter((s) => !pinnedFiles.has(s.file)) ?? null;
        return (
          <div key={l.key} className={`row-wrap ${isExpanded ? "expanded" : ""}`}>
            <div
              className={`row ${isSelected ? "selected" : ""} ${
                l.healthy === false ? "broken" : ""
              } ${dragEnabled ? "row-draggable" : ""} ${l.key === dragKey ? "dragging" : ""} ${
                showDrop ? (overPos === "above" ? "drop-above" : "drop-below") : ""
              }`}
              draggable={dragEnabled}
              onDragStart={(e) => handleDragStart(e, l.key)}
              onDragEnd={clearDragState}
              onDragOver={(e) => handleDragOver(e, l.key)}
              onDragLeave={(e) => handleDragLeave(e, l.key)}
              onDrop={(e) => handleDrop(e, l.key)}
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
              <div className="row-body" title="展开/收起会话列表">
                <div className="row-label">
                  {l.name}
                  {l.healthy === false && <span className="tag tag-danger">失效</span>}
                </div>
                <div className="row-path">{l.path}</div>
              </div>
              {/* 行内两枚按钮的图标与左右顺序对齐 v1.0.0：先是「更多操作」（⋯），
                  再是 PlusIcon（+）。+ 按「默认交互方式」开新会话 tab（页面对话或
                  内嵌终端，设置里可切）；两种 tab 共存，互不影响。 */}
              {l.healthy !== false && (
                <div className="row-actions">
                  <button
                    className="row-icon row-icon-more"
                    title="更多操作（与右键菜单相同）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(l.key);
                      onContextMenu(e.clientX, e.clientY, l.key);
                    }}
                  >
                    <MoreIcon size={15} />
                  </button>
                  <button
                    className="row-icon row-icon-add"
                    title="新建会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChatProject(l.key);
                    }}
                  >
                    <PlusIcon size={15} />
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
                ) : visibleSessions && visibleSessions.length === 0 ? (
                  <div className="session-empty">会话已全部置顶（见顶部置顶会话）</div>
                ) : (
                  visibleSessions!.map((s) => (
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
                      title={[s.title, s.summary, "点击在 app 内继续对话 · 右键更多操作"]
                        .filter(Boolean)
                        .join("\n")}
                    >
                      <button
                        className="session-pin"
                        title="置顶（在顶部聚合区常驻显示）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePin(l.key, s.file);
                        }}
                      >
                        <PinIcon />
                      </button>
                      <div className="session-body">
                        <div className="session-title">{s.title}</div>
                        <div className="session-meta">
                          {formatTime(s.lastModified)}
                          {s.summary && ` · ${s.summary}`}
                        </div>
                      </div>
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
