interface Props {
  total: number;
  favCount: number;
  missingCount: number;
  claudeOk: boolean | null;
  workspaceRoot: string;
}

export default function StatusBar({ total, favCount, missingCount, claudeOk, workspaceRoot }: Props) {
  const parts = [
    `共 ${total} 个项目`,
    `收藏 ${favCount}`,
    missingCount > 0 ? `⚠ ${missingCount} 个失效` : "全部目录有效",
    claudeOk === null ? "claude 检查中…" : claudeOk ? "claude ✓" : "claude ✗ 未找到",
  ];
  return (
    <footer className="statusbar">
      <span>{parts.join(" · ")}</span>
      <span className="statusbar-right">{workspaceRoot}</span>
    </footer>
  );
}
