import { useMemo } from "react";
import type { PinnedSessionInfo, Project, SessionInfo } from "../types";
import SessionRow from "./SessionRow";

interface Props {
  /** 后端按置顶清单顺序返回的置顶会话（未过滤） */
  items: PinnedSessionInfo[];
  /** 搜索词：置顶区跟随项目列表一起过滤（标题或项目名命中才显示） */
  search: string;
  /** 打开中的对话 tab 正显示的会话文件 */
  activeSessionFile: string | null;
  /** 项目清单：用于项目名徽标与失效判断 */
  projects: Project[];
  /** 点击 = 在 app 内继续该会话（打开/激活对话 tab） */
  onOpenSession: (projectPath: string, session: SessionInfo) => void;
  /** 取消置顶（置顶条目只存 jsonl 路径 + 项目路径，故传 file 而非整份元数据） */
  onTogglePin: (projectPath: string, file: string) => void;
  /** 会话行右键菜单（终端继续/重命名/取消置顶/删除收进菜单，行上不放按钮挤占标题宽度） */
  onSessionContextMenu: (x: number, y: number, projectPath: string, session: SessionInfo) => void;
}

/** 项目名徽标：项目已不在列表里（手工改过 config 等）时退化为路径末段 */
function projectNameOf(projects: Project[], path: string): string {
  const hit = projects.find((p) => p.key === path);
  if (hit) return hit.name;
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 置顶会话聚合区：跨项目列出已置顶会话。没有置顶会话时整块不渲染 */
export default function PinnedSessions({
  items,
  search,
  activeSessionFile,
  projects,
  onOpenSession,
  onTogglePin,
  onSessionContextMenu,
}: Props) {
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        projectNameOf(projects, s.projectPath).toLowerCase().includes(q),
    );
  }, [items, search, projects]);

  if (shown.length === 0) return null;
  return (
    <div className="pinned-block">
      <div className="pinned-head">
        <span className="pinned-title">置顶会话</span>
        <span className="pinned-count">{shown.length}</span>
      </div>
      <div className="pinned-list">
        {shown.map((s) => (
          <SessionRow
            key={s.file}
            session={s}
            pinned
            active={s.file === activeSessionFile}
            projectName={projectNameOf(projects, s.projectPath)}
            onOpen={() => onOpenSession(s.projectPath, s)}
            onTogglePin={() => onTogglePin(s.projectPath, s.file)}
            onContextMenu={(x, y) => onSessionContextMenu(x, y, s.projectPath, s)}
          />
        ))}
      </div>
      <div className="pinned-sep" />
    </div>
  );
}
