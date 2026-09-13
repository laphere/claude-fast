interface Props {
  total: number;
  missingCount: number;
  claudeOk: boolean | null;
}

export default function StatusBar({ total, missingCount, claudeOk }: Props) {
  const parts = [
    `共 ${total} 个项目`,
    missingCount > 0 ? `⚠ ${missingCount} 个失效` : "全部目录有效",
    claudeOk === null ? "claude 检查中…" : claudeOk ? "claude ✓" : "claude ✗ 未找到",
  ];
  return (
    <footer className="statusbar">
      <span>{parts.join(" · ")}</span>
    </footer>
  );
}
