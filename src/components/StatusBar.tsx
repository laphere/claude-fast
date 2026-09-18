import type { ReactNode } from "react";
import { CheckIcon, TriangleAlertIcon, XIcon } from "./Icons";

interface Props {
  total: number;
  missingCount: number;
  claudeOk: boolean | null;
}

export default function StatusBar({ total, missingCount, claudeOk }: Props) {
  const parts: ReactNode[] = [
    `共 ${total} 个项目`,
    missingCount > 0 ? (
      <>
        <span className="inline-icon">
          <TriangleAlertIcon size={11} />
        </span>{" "}
        {missingCount} 个失效
      </>
    ) : (
      "全部目录有效"
    ),
    claudeOk === null ? (
      "claude 检查中…"
    ) : claudeOk ? (
      <>
        claude{" "}
        <span className="inline-icon">
          <CheckIcon size={11} />
        </span>
      </>
    ) : (
      <>
        claude{" "}
        <span className="inline-icon">
          <XIcon size={11} />
        </span>{" "}
        未找到
      </>
    ),
  ];
  return (
    <footer className="statusbar">
      <span>
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? " · " : ""}
            {p}
          </span>
        ))}
      </span>
    </footer>
  );
}
