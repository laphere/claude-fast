import { useState } from "react";
import Modal from "./Modal";
import type { CloseAction } from "../types";

interface Props {
  closeAction: CloseAction;
  onClose: () => void;
  onSave: (action: CloseAction) => Promise<void>;
}

const OPTIONS: { value: CloseAction; label: string; desc: string }[] = [
  { value: null, label: "每次询问", desc: "点击关闭时弹出选择：退出程序或最小化到通知栏" },
  { value: "quit", label: "直接退出程序", desc: "点击关闭窗口后立即退出（当前行为）" },
  { value: "minimize", label: "最小化到通知栏", desc: "点击关闭窗口后隐藏到系统托盘，托盘图标可重新打开；通过托盘菜单「退出程序」彻底退出" },
];

export default function SettingsDialog({ closeAction, onClose, onSave }: Props) {
  const [value, setValue] = useState<CloseAction>(closeAction);
  const [saving, setSaving] = useState(false);

  return (
    <Modal title="设置" width={460} onClose={onClose}>
      <div style={{ marginBottom: 12, fontWeight: 600 }}>关闭窗口时的行为</div>
      {OPTIONS.map((o) => (
        <label
          key={String(o.value)}
          style={{
            display: "block",
            padding: "10px 12px",
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 8,
            cursor: "pointer",
            background: value === o.value ? "var(--accent-soft)" : "transparent",
          }}
        >
          <input
            type="radio"
            name="closeAction"
            checked={value === o.value}
            onChange={() => setValue(o.value)}
            style={{ marginRight: 8 }}
          />
          <span style={{ fontWeight: 500 }}>{o.label}</span>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, paddingLeft: 24 }}>
            {o.desc}
          </div>
        </label>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await onSave(value);
            setSaving(false);
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}
