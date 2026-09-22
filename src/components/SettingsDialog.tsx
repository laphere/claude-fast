import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import Modal from "./Modal";
import type { CloseAction } from "../types";
import { api } from "../lib/api";

interface Props {
  closeAction: CloseAction;
  /** 新开会话（项目行「+」）的默认交互方式（页面对话 / 内嵌终端；两种 tab 始终共存）。
   *  不作用于会话行单击——那条固定是只读查看，不起进程 */
  defaultInteraction: "chat" | "terminal";
  onClose: () => void;
  onSave: (action: CloseAction, interaction: "chat" | "terminal") => Promise<void>;
}

const OPTIONS: { value: CloseAction; label: string; desc: string }[] = [
  { value: null, label: "每次询问", desc: "点击关闭时弹出选择：退出程序或最小化到通知栏" },
  { value: "quit", label: "直接退出程序", desc: "点击关闭窗口后立即退出（当前行为）" },
  { value: "minimize", label: "最小化到通知栏", desc: "点击关闭窗口后隐藏到系统托盘，托盘图标可重新打开；通过托盘菜单「退出程序」彻底退出" },
];

const INTERACTIONS: { value: "chat" | "terminal"; label: string; desc: string }[] = [
  { value: "chat", label: "页面对话", desc: "图形界面对话（权限确认 / 方案审批 / 提问都有卡片）" },
  { value: "terminal", label: "内嵌终端", desc: "app 内嵌真 claude 终端（完整 TUI 交互，等价系统终端）" },
];

/** 选项卡片外壳（单选 / 复选共用）：整块可点，选中态铺强调底色 */
const cardStyle = (active: boolean): CSSProperties => ({
  display: "block",
  padding: "10px 12px",
  marginBottom: 8,
  border: "1px solid var(--border)",
  borderRadius: 8,
  cursor: "pointer",
  background: active ? "var(--accent-soft)" : "transparent",
});

/** 卡片内说明文字：左缩进与控件后的标题对齐（24 = 控件宽 + 8 间距），勿改 */
const cardDescStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
  marginTop: 4,
  paddingLeft: 24,
};

/** 设置分组：粗体小标题 + 可选说明段 + 内容 */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div style={{ fontWeight: 600, marginBottom: hint ? 8 : 12 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8, paddingLeft: 2 }}>{hint}</div>
      )}
      {children}
    </section>
  );
}

export default function SettingsDialog({ closeAction, defaultInteraction, onClose, onSave }: Props) {
  const [value, setValue] = useState<CloseAction>(closeAction);
  const [interaction, setInteraction] = useState<"chat" | "terminal">(defaultInteraction);
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
    // 横向布局（780 × 约 480）：单列会把三个分组摞成竖条——窗口不高时正文早早超出一屏、
    // 被迫内滚。上面「开机自启动」占满整行（就一个开关，行内摆开），下面两组单选并排两栏。
    // ⚠️ 分组这么摆是量过的：换成「自启动+新会话 | 关闭行为」或「新会话 | 自启动+关闭行为」，
    // 两栏高差都会拉到 150px 上下、某一栏底部空掉一大块。
    <Modal
      title="设置"
      width={780}
      onClose={onClose}
      // 走 Modal footer 槽：正文再长（800×500 这类窄窗口）按钮也钉在底部可见可按
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave(value, interaction);
              setSaving(false);
            }}
          >
            保存
          </button>
        </>
      }
    >
      {autoSupported && (
        <Section title="开机自启动">
          {/* 整行卡片：说明挪到行尾右对齐，不然 780 宽的卡右边空一大块 */}
          <label
            style={{ ...cardStyle(autoStart), display: "flex", alignItems: "center", gap: 8 }}
          >
            <input
              type="checkbox"
              checked={autoStart}
              disabled={autoBusy}
              onChange={(e) => toggleAutoStart(e.target.checked)}
            />
            <span style={{ fontWeight: 500 }}>登录系统后自动启动 CC Desktop</span>
            <span style={{ fontSize: 12, opacity: 0.7, marginLeft: "auto" }}>
              {autoBusy ? "正在设置…" : "开启后，开机登录时自动在后台运行本应用"}
            </span>
          </label>
        </Section>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
          alignItems: "start",
          marginTop: autoSupported ? 22 : 0,
        }}
      >
        <Section
          title="新开会话的默认方式"
          hint="决定「项目行 +」用哪种方式新建会话，也决定只读页上「继续对话」用哪种方式接着聊。点击会话行固定打开只读查看（不起进程）；在系统终端里继续那条固定在右键菜单里，不受此设置影响。两种标签页可同时打开，切换此设置不影响已打开的标签页"
        >
          {INTERACTIONS.map((o) => (
            <label key={o.value} style={cardStyle(interaction === o.value)}>
              <input
                type="radio"
                name="defaultInteraction"
                checked={interaction === o.value}
                onChange={() => setInteraction(o.value)}
                style={{ marginRight: 8 }}
              />
              <span style={{ fontWeight: 500 }}>{o.label}</span>
              <div style={cardDescStyle}>{o.desc}</div>
            </label>
          ))}
        </Section>

        <Section title="关闭窗口时的行为">
          {OPTIONS.map((o) => (
            <label key={String(o.value)} style={cardStyle(value === o.value)}>
              <input
                type="radio"
                name="closeAction"
                checked={value === o.value}
                onChange={() => setValue(o.value)}
                style={{ marginRight: 8 }}
              />
              <span style={{ fontWeight: 500 }}>{o.label}</span>
              <div style={cardDescStyle}>{o.desc}</div>
            </label>
          ))}
        </Section>
      </div>
    </Modal>
  );
}
