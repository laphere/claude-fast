/**
 * 对话 tab 栏：一个 tab = 一个打开的会话进程。切换只做显示/隐藏
 * （进程保持运行、后台继续流式），× 关闭对应 tab（优雅关闭进程）。
 * 思考中/启动中的 tab 显示状态点，多会话并行时一眼看出谁在干活。
 */
interface Tab {
  id: string;
  title: string;
}

interface Props {
  tabs: Tab[];
  activeId: string | null;
  /** tab id → 对话状态（starting/thinking 时显示进行中标记） */
  statusByTab: Record<string, string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export default function ChatTabs({
  tabs,
  activeId,
  statusByTab,
  onSelect,
  onClose,
}: Props) {
  return (
    <div className="chat-tabs">
      {tabs.map((t) => {
        const phase = statusByTab[t.id];
        const busy = phase === "thinking" || phase === "starting";
        return (
          <div
            key={t.id}
            className={`chat-tab ${t.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(t.id)}
            title={t.title}
          >
            {busy && <span className="chat-tab-dot" />}
            <span className="chat-tab-title">{t.title}</span>
            <button
              className="chat-tab-close"
              title="关闭此对话"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
