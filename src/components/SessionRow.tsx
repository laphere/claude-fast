import type { MouseEvent } from "react";
import type { SessionInfo } from "../types";
import { PinIcon } from "./Icons";

interface Props {
  session: SessionInfo;
  /** 已置顶（位于置顶区）→ 图钉按钮语义为「取消置顶」；项目内会话恒为 false */
  pinned: boolean;
  /** 右侧查看器正显示该会话 */
  active: boolean;
  /** 置顶区里显示的所属项目名（项目内部会话列表不传） */
  projectName?: string;
  onOpen: () => void;
  onTogglePin: () => void;
  /** 右键菜单（继续/重命名/置顶/删除都收进菜单，行上不再放按钮挤占标题宽度） */
  onContextMenu?: (e: MouseEvent) => void;
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / MM-DD HH:mm */
export function formatTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return "昨天";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 单条会话行：项目内会话列表与置顶聚合区共用（只有图钉语义与项目名徽标不同） */
export default function SessionRow({
  session,
  pinned,
  active,
  projectName,
  onOpen,
  onTogglePin,
  onContextMenu,
}: Props) {
  return (
    <div
      className={`session-row ${active ? "active" : ""}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(e);
      }}
      title={[session.title, session.summary].filter(Boolean).join("\n")}
    >
      <button
        className="session-pin"
        title={pinned ? "取消置顶" : "置顶（在顶部聚合区常驻显示）"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        <PinIcon />
      </button>
      <div className="session-body">
        <div className="session-title">
          {projectName && <span className="session-project">{projectName}</span>}
          {session.title}
        </div>
        <div className="session-meta">
          {formatTime(session.lastModified)}
          {session.summary && ` · ${session.summary}`}
        </div>
      </div>
    </div>
  );
}
