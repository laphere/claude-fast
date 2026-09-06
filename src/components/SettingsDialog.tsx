import { useEffect, useState } from "react";
import Modal from "./Modal";
import type { CloseAction } from "../types";
import { api } from "../lib/api";

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
  // ---------- 开机自启动 ----------
  const [autoStart, setAutoStart] = useState(false);
  const [autoSupported, setAutoSupported] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);

  // 打开设置时读取：当前平台是否支持 + 目前是否已开启
  useEffect(() => {
    let disposed = false;
    (async () => {
      const [supported, enabled] = await Promise.all([
        api.isAutostartSupported(),
        api.autostartEnabled(),
      ]);
      if (disposed) return;
      setAutoSupported(supported);
      setAutoStart(enabled);
    })().catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const toggleAutoStart = async (on: boolean) => {
    setAutoBusy(true);
    try {
      if (on) await api.autostartTurnOn();
      else await api.autostartTurnOff();
      setAutoStart(on);
    } catch {
      setAutoStart(!on); // 失败回滚显示
    } finally {
      setAutoBusy(false);
    }
  };

  return (
    <Modal title="设置" width={460} onClose={onClose}>
      {autoSupported && (
        <>
          <div style={{ marginBottom: 12, fontWeight: 600 }}>开机自启动</div>
          <label
            style={{
              display: "block",
              padding: "10px 12px",
              marginBottom: 16,
              border: "1px solid var(--border)",
              borderRadius: 8,
              cursor: "pointer",
              background: autoStart ? "var(--accent-soft)" : "transparent",
            }}
          >
            <input
              type="checkbox"
              checked={autoStart}
              disabled={autoBusy}
              onChange={(e) => toggleAutoStart(e.target.checked)}
              style={{ marginRight: 8 }}
            />
            <span style={{ fontWeight: 500 }}>登录系统后自动启动 CC Desktop</span>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, paddingLeft: 24 }}>
              {autoBusy
                ? "正在设置…"
                : "开启后，开机登录时自动在后台运行本应用"}
            </div>
          </label>
        </>
      )}

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
