import { useState } from "react";
import Modal from "./Modal";

interface Props {
  onClose: () => void;
  onChoose: (action: "quit" | "minimize", remember: boolean) => Promise<void>;
}

/** 关闭窗口时（未设置固定行为）的询问对话框：退出 / 最小化 + 记住选择 */
export default function CloseChoiceDialog({ onClose, onChoose }: Props) {
  const [remember, setRemember] = useState(false);

  return (
    <Modal title="关闭 Claude 快速启动" width={420} onClose={onClose}>
      <div style={{ marginBottom: 16 }}>
        关闭窗口后要做什么？
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          className="btn primary"
          onClick={async () => {
            await onChoose("minimize", remember);
          }}
        >
          最小化到通知栏
        </button>
        <button
          className="btn"
          onClick={async () => {
            await onChoose("quit", remember);
          }}
        >
          退出程序
        </button>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        记住我的选择，下次不再询问
      </label>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 10 }}>
        可在「设置」中随时修改关闭行为
      </div>
    </Modal>
  );
}
