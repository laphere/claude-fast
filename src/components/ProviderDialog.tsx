import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "./Modal";
import ConfirmDialog from "./ConfirmDialog";
import PresetPicker, { CATEGORY_LABEL } from "./PresetPicker";
import { api } from "../lib/api";
import type {
  ProviderInfo,
  ProviderListState,
  UsageResult,
  UsageTier,
} from "../types";
import {
  providerPresets,
  type ProviderPreset,
} from "../config/claudeProviderPresets";
import { applyTemplateValues, extractBaseUrl } from "../utils/templateValues";

interface Props {
  state: ProviderListState;
  onClose: () => void;
  /** 任何变更（切换/保存/删除/复制/导入）后回传最新清单 */
  onChanged: (state: ProviderListState) => void;
  toast: (msg: string) => void;
}

type ApiKeyField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

/** 模型映射行写入的 env 键（默认模型 = ANTHROPIC_MODEL 回退） */
const MODEL_KEYS = {
  model: "ANTHROPIC_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
} as const;

const EMPTY_JSON =
  '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "",\n    "ANTHROPIC_AUTH_TOKEN": ""\n  }\n}';

interface TemplateInput {
  key: string;
  label: string;
  placeholder: string;
  value: string;
}

/** 表单态：jsonText 是唯一事实来源；结构化字段（baseUrl/apiKey/models）是其回显 */
interface FormState {
  editId: string;
  name: string;
  presetName: string;
  jsonText: string;
  templates: TemplateInput[];
  websiteUrl: string | null;
  category: string | null;
  baseUrl: string;
  apiKey: string;
  apiKeyField: ApiKeyField;
  models: { model: string; sonnet: string; opus: string; haiku: string };
}

type Structured = Pick<
  FormState,
  "baseUrl" | "apiKey" | "apiKeyField" | "models"
>;

function prettyJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function buildTemplateInputs(preset: ProviderPreset): TemplateInput[] {
  return Object.entries(preset.templateValues ?? {}).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    placeholder: cfg.placeholder,
    value:
      cfg.editorValue !== undefined ? cfg.editorValue : (cfg.defaultValue ?? ""),
  }));
}

function renderPresetJson(
  preset: ProviderPreset,
  inputs: TemplateInput[],
): string {
  const tv = Object.fromEntries(
    inputs.map((t) => [
      t.key,
      { ...preset.templateValues![t.key], editorValue: t.value },
    ]),
  );
  return prettyJson(applyTemplateValues(preset.settingsConfig, tv));
}

function displayNameOf(presetName: string): string {
  return providerPresets.find((p) => p.name === presetName)?.name ?? "";
}

/** 从配置 JSON 提取结构化字段的当前值（回显用） */
function readStructured(jsonText: string): Structured {
  let baseUrl = "";
  let apiKey = "";
  let apiKeyField: ApiKeyField = "ANTHROPIC_AUTH_TOKEN";
  const models = { model: "", sonnet: "", opus: "", haiku: "" };
  try {
    const cfg = JSON.parse(jsonText);
    const env =
      cfg && typeof cfg === "object" && !Array.isArray(cfg)
        ? (cfg.env ?? {})
        : {};
    if (typeof env === "object" && env !== null && !Array.isArray(env)) {
      const e = env as Record<string, unknown>;
      baseUrl = typeof e.ANTHROPIC_BASE_URL === "string" ? e.ANTHROPIC_BASE_URL : "";
      apiKeyField =
        typeof e.ANTHROPIC_API_KEY === "string" && e.ANTHROPIC_API_KEY
          ? "ANTHROPIC_API_KEY"
          : "ANTHROPIC_AUTH_TOKEN";
      apiKey =
        typeof e[apiKeyField] === "string" ? (e[apiKeyField] as string) : "";
      for (const [k, envKey] of Object.entries(MODEL_KEYS)) {
        const v = e[envKey];
        (models as Record<string, string>)[k] = typeof v === "string" ? v : "";
      }
    }
  } catch {
    // JSON 非法：结构化字段保持空
  }
  return { baseUrl, apiKey, apiKeyField, models };
}

/** 往配置对象写入 env 键（空值删除；env 不存在时创建） */
function setEnvKey(cfg: Record<string, unknown>, key: string, value: string) {
  const raw = cfg.env;
  const env: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  if (value) env[key] = value;
  else delete env[key];
  cfg.env = env;
}

// ---------------- 用量展示工具 ----------------

const TIER_LABEL: Record<string, string> = {
  five_hour: "5h",
  weekly_limit: "周",
  monthly: "月",
};

/** 重置倒计时文案（过去时间/非法值返回空串不展示） */
function fmtCountdown(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "即将重置";
  if (m < 60) return `${m}分后重置`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}时${m % 60}分后重置`;
  return `${Math.floor(h / 24)}天${h % 24}时后重置`;
}

function usageLevel(pct: number): string {
  return pct < 60 ? "ok" : pct < 85 ? "warn" : "bad";
}

export default function ProviderDialog({ state, onClose, onChanged, toast }: Props) {
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProviderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);

  // 结构化字段写入 jsonText 时打标，回读 effect 跳过这一次（防回声循环）
  const echoRef = useRef<string | null>(null);

  const { providers, currentId } = state;

  // ---------- JSON 外部手改 → 回读结构化字段 ----------
  useEffect(() => {
    if (!form) return;
    if (echoRef.current !== null) {
      if (echoRef.current === form.jsonText) echoRef.current = null;
      return; // 来源是结构化字段写入，不回读
    }
    const s = readStructured(form.jsonText);
    setForm((f) => (f ? { ...f, ...s } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.jsonText]);

  // ---------- 供应商切换 ----------
  const switchTo = async (p: ProviderInfo) => {
    if (p.id === currentId) return;
    setBusy(true);
    try {
      const out = await api.providerSwitch(p.id);
      onChanged(out.list);
      toast(
        out.warnings.length
          ? `已切换到「${p.name}」（告警：${out.warnings.join("；")}）`
          : `已切换到「${p.name}」，新开的 Claude Code 会话即生效`,
      );
    } catch (e) {
      toast("切换失败：" + String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- 复制（立即克隆，不开表单） ----------
  const duplicateProvider = async (p: ProviderInfo) => {
    setBusy(true);
    try {
      const list = await api.providerSave({
        id: "",
        name: `${p.name} 副本`,
        settingsConfig: JSON.parse(JSON.stringify(p.settingsConfig)),
        websiteUrl: p.websiteUrl ?? null,
        category: p.category ?? null,
      });
      onChanged(list);
      toast(`已复制「${p.name}」，可编辑后启用`);
    } catch (e) {
      toast("复制失败：" + String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- 删除 ----------
  const doDelete = async () => {
    if (!confirmDelete) return;
    const p = confirmDelete;
    setConfirmDelete(null);
    setBusy(true);
    try {
      const list = await api.providerDelete(p.id);
      onChanged(list);
      toast(`已删除「${p.name}」`);
    } catch (e) {
      toast("删除失败：" + String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- 表单 ----------
  const openCreate = () => {
    setFormError(null);
    setAdvancedOpen(false);
    setFetchedModels(null);
    echoRef.current = null;
    setForm({
      editId: "",
      name: "",
      presetName: "",
      jsonText: EMPTY_JSON,
      templates: [],
      websiteUrl: null,
      category: "custom",
      baseUrl: "",
      apiKey: "",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
      models: { model: "", sonnet: "", opus: "", haiku: "" },
    });
  };

  const openEdit = (p: ProviderInfo) => {
    setFormError(null);
    setFetchedModels(null);
    echoRef.current = null;
    const jsonText = prettyJson(p.settingsConfig);
    const s = readStructured(jsonText);
    setAdvancedOpen(Object.values(s.models).some(Boolean));
    setForm({
      editId: p.id,
      name: p.name,
      presetName: "",
      jsonText,
      templates: [],
      websiteUrl: p.websiteUrl ?? null,
      category: p.category ?? "custom",
      ...s,
    });
  };

  /** 结构化字段 → 修改 JSON 键 → 回写 jsonText（打标跳过回读） */
  const patchEnv = (envKey: string, value: string, extra: Partial<FormState>) => {
    if (!form) return;
    let nextJson = form.jsonText;
    try {
      const cfg = JSON.parse(form.jsonText);
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
        setEnvKey(cfg as Record<string, unknown>, envKey, value);
        nextJson = prettyJson(cfg);
      }
    } catch {
      // JSON 非法：只更新结构化输入框，不动 JSON 文本
    }
    echoRef.current = nextJson;
    setForm({ ...form, jsonText: nextJson, ...extra });
  };

  const pickPreset = (name: string) => {
    if (!form) return;
    setFormError(null);
    if (!name) {
      echoRef.current = EMPTY_JSON;
      setForm({
        ...form,
        presetName: "",
        jsonText: EMPTY_JSON,
        templates: [],
        baseUrl: "",
        apiKey: "",
        apiKeyField: "ANTHROPIC_AUTH_TOKEN",
        models: { model: "", sonnet: "", opus: "", haiku: "" },
      });
      setAdvancedOpen(false);
      setFetchedModels(null);
      return;
    }
    const preset = providerPresets.find((p) => p.name === name);
    if (!preset) return;
    const templates = buildTemplateInputs(preset);
    const jsonText = renderPresetJson(preset, templates);
    const structured = readStructured(jsonText);
    echoRef.current = jsonText;
    setForm({
      ...form,
      presetName: name,
      name:
        !form.name || form.name === displayNameOf(form.presetName)
          ? preset.name
          : form.name,
      jsonText,
      templates,
      websiteUrl: preset.websiteUrl,
      category: preset.category ?? "custom",
      ...structured,
    });
    setAdvancedOpen(Object.values(structured.models).some(Boolean));
  };

  const updateTemplate = (key: string, value: string) => {
    if (!form) return;
    const preset = providerPresets.find((p) => p.name === form.presetName);
    if (!preset) return;
    const templates = form.templates.map((t) =>
      t.key === key ? { ...t, value } : t,
    );
    const jsonText = renderPresetJson(preset, templates);
    echoRef.current = jsonText;
    setForm({ ...form, templates, jsonText, ...readStructured(jsonText) });
  };

  const importLive = async () => {
    if (!form) return;
    try {
      const live = await api.providerReadLive();
      if (!live) {
        setFormError("未找到 ~/.claude/settings.json");
        return;
      }
      const jsonText = prettyJson(live);
      echoRef.current = jsonText;
      setForm({ ...form, jsonText, ...readStructured(jsonText) });
      setAdvancedOpen(Object.values(readStructured(jsonText).models).some(Boolean));
      setFormError(null);
    } catch (e) {
      setFormError(String(e));
    }
  };

  // ---------- 获取模型列表 ----------
  const doFetchModels = async () => {
    if (!form) return;
    if (!form.baseUrl.trim() || !form.apiKey.trim()) {
      setFormError("获取模型列表前，请先填写接入地址和 API Key");
      return;
    }
    setFetchingModels(true);
    setFormError(null);
    try {
      const list = await api.fetchModels(form.baseUrl.trim(), form.apiKey.trim());
      setFetchedModels(list);
      if (list.length === 0) setFormError("接口返回了空模型列表");
    } catch (e) {
      setFetchedModels(null);
      setFormError("获取模型列表失败：" + String(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const saveForm = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      setFormError("请填写供应商名称");
      return;
    }
    let config: unknown;
    try {
      config = JSON.parse(form.jsonText);
    } catch (e) {
      setFormError("配置不是合法 JSON：" + String(e));
      return;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      setFormError("配置必须是 JSON 对象（如 {\"env\": {…}}）");
      return;
    }
    setBusy(true);
    try {
      const list = await api.providerSave({
        id: form.editId,
        name: form.name.trim(),
        settingsConfig: config as Record<string, unknown>,
        websiteUrl: form.websiteUrl,
        category: form.category,
      });
      onChanged(list);
      toast(form.editId ? "供应商已更新" : "供应商已添加");
      setForm(null);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- CC Switch 备份导入 ----------
  const importCcswitch = async () => {
    const picked = await open({
      multiple: false,
      title: "选择 CC Switch「导出配置」生成的 SQL 备份",
      filters: [{ name: "SQL 备份", extensions: ["sql", "txt"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const out = await api.providerImportCcswitch(picked);
      onChanged(out.list);
      toast(
        `导入完成：新增 ${out.imported} 个` +
          (out.skipped ? `，跳过重复 ${out.skipped} 个` : "") +
          (out.warnings.length ? `（${out.warnings[0]}）` : ""),
      );
    } catch (e) {
      toast("导入失败：" + String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- 用量查询：列表视图打开时自动查一轮，卡片可单卡刷新 ----------
  const [usage, setUsage] = useState<Record<string, { loading: boolean; result?: UsageResult }>>({});
  const usageOnceRef = useRef(false);

  const loadUsage = (targets: ProviderInfo[]) => {
    for (const p of targets) {
      setUsage((u) => ({ ...u, [p.id]: { loading: true, result: u[p.id]?.result } }));
      api
        .providerQueryUsage(p.id)
        .then((r) => setUsage((u) => ({ ...u, [p.id]: { loading: false, result: r } })))
        .catch(() => setUsage((u) => ({ ...u, [p.id]: { loading: false } })));
    }
  };

  useEffect(() => {
    if (form) return; // 表单态不查
    if (usageOnceRef.current) return; // 每次打开对话框只自动查一轮
    usageOnceRef.current = true;
    loadUsage(state.providers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, state.providers]);

  const presetApiKeyUrl = useMemo(() => {
    if (!form || form.editId) return null;
    const preset = providerPresets.find((p) => p.name === form.presetName);
    if (!preset) return null;
    if (preset.category === "official" || preset.isOfficial) return null;
    return preset.apiKeyUrl || preset.websiteUrl || null;
  }, [form]);

  const modelRows: { key: keyof FormState["models"]; envKey: string; label: string; hint?: string }[] = [
    { key: "model", envKey: MODEL_KEYS.model, label: "默认模型", hint: "ANTHROPIC_MODEL" },
    { key: "sonnet", envKey: MODEL_KEYS.sonnet, label: "Sonnet", hint: MODEL_KEYS.sonnet },
    { key: "opus", envKey: MODEL_KEYS.opus, label: "Opus", hint: MODEL_KEYS.opus },
    { key: "haiku", envKey: MODEL_KEYS.haiku, label: "Haiku", hint: MODEL_KEYS.haiku },
  ];

  return (
    <Modal title="供应商切换" width={580} onClose={onClose}>
      {form ? (
        // ---------- 新增 / 编辑表单 ----------
        <div>
          {!form.editId && (
            <div className="provider-field">
              <label>预设模板</label>
              <PresetPicker value={form.presetName} onChange={pickPreset} />
            </div>
          )}

          {form.templates.length > 0 && (
            <div className="provider-field">
              <label>模板变量</label>
              <div className="provider-templates">
                {form.templates.map((t) => (
                  <div key={t.key} className="provider-template-item">
                    <input
                      value={t.value}
                      placeholder={t.placeholder}
                      onChange={(e) => updateTemplate(t.key, e.target.value)}
                    />
                    <span>
                      {t.label}（${"{" + t.key + "}"}）
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="provider-field">
            <label>名称</label>
            <input
              value={form.name}
              placeholder="供应商显示名称"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="provider-field">
            <label>
              <span>API Key</span>
              {presetApiKeyUrl && (
                <button
                  className="provider-link"
                  onClick={() => api.openUrl(presetApiKeyUrl).catch((e) => setFormError(String(e)))}
                >
                  获取 API Key ↗
                </button>
              )}
            </label>
            <input
              type="password"
              autoComplete="off"
              value={form.apiKey}
              placeholder={form.apiKeyField === "ANTHROPIC_API_KEY" ? "sk-…（写入 ANTHROPIC_API_KEY）" : "sk-…（写入 ANTHROPIC_AUTH_TOKEN）"}
              onChange={(e) => patchEnv(form.apiKeyField, e.target.value, { apiKey: e.target.value })}
            />
          </div>

          <div className="provider-field">
            <label>接入地址</label>
            <input
              value={form.baseUrl}
              placeholder="https://…（ANTHROPIC_BASE_URL，留空 = 官方默认）"
              onChange={(e) => patchEnv("ANTHROPIC_BASE_URL", e.target.value.trim(), { baseUrl: e.target.value })}
            />
          </div>

          <div className="provider-adv">
            <button
              type="button"
              className="provider-adv-toggle"
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              {advancedOpen ? "▾" : "▸"} 高级选项（模型映射）
            </button>
            {advancedOpen && (
              <div className="provider-adv-body">
                <div className="provider-field">
                  <label>
                    <span>模型列表</span>
                    <button
                      type="button"
                      className="provider-link"
                      disabled={fetchingModels}
                      onClick={doFetchModels}
                    >
                      {fetchingModels ? "获取中…" : "获取模型列表"}
                    </button>
                  </label>
                  {fetchedModels && (
                    <div className="provider-model-count">
                      已拉取 {fetchedModels.length} 个模型，下方输入框可直接下拉选择（datalist，可搜可手输）
                      <datalist id="provider-model-list">
                        {fetchedModels.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </div>
                  )}
                </div>
                {modelRows.map((row) => (
                  <div key={row.key} className="provider-model-row">
                    <span className="provider-model-label" title={row.hint}>
                      {row.label}
                    </span>
                    <input
                      list={fetchedModels ? "provider-model-list" : undefined}
                      value={form.models[row.key]}
                      placeholder="留空跟随默认"
                      onChange={(e) =>
                        patchEnv(row.envKey, e.target.value, {
                          models: { ...form.models, [row.key]: e.target.value },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="provider-field">
            <label>
              <span>配置 JSON（写入 ~/.claude/settings.json）</span>
              <button
                className="provider-link"
                title="把当前生效的 settings.json 内容填进来"
                onClick={importLive}
              >
                导入当前配置
              </button>
            </label>
            <textarea
              className="provider-json"
              rows={10}
              spellCheck={false}
              value={form.jsonText}
              onChange={(e) => setForm({ ...form, jsonText: e.target.value })}
            />
          </div>

          {formError && <div className="form-error">{formError}</div>}

          <div className="form-actions">
            <button className="btn" onClick={() => setForm(null)}>
              取消
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={saveForm}>
              保存
            </button>
          </div>
        </div>
      ) : (
        // ---------- 供应商卡片列表 ----------
        <div>
          {providers.length === 0 && (
            <div className="provider-empty">
              尚未配置供应商。点击「新增供应商」从预设模板添加，或先把
              Claude Code 配置好再打开本窗口自动导入。
            </div>
          )}
          <div className="provider-list">
            {providers.map((p) => {
              const isCurrent = p.id === currentId;
              const baseUrl = extractBaseUrl(p.settingsConfig);
              const u = usage[p.id];
              return (
                <div
                  key={p.id}
                  className={`provider-card ${isCurrent ? "current" : ""}`}
                >
                  <div className="provider-info">
                    <div className="provider-name">
                      <span title={p.name}>{p.name}</span>
                      {isCurrent && <span className="provider-badge">当前</span>}
                      {p.category && CATEGORY_LABEL[p.category as keyof typeof CATEGORY_LABEL] && (
                        <span className="provider-cat">
                          {CATEGORY_LABEL[p.category as keyof typeof CATEGORY_LABEL]}
                        </span>
                      )}
                    </div>
                    <div className="provider-url" title={baseUrl}>
                      {baseUrl || "官方默认端点"}
                    </div>
                    {u?.result?.supported && (
                      <UsageStrip
                        result={u.result}
                        loading={u.loading}
                        onRefresh={() => loadUsage([p])}
                      />
                    )}
                  </div>
                  <div className="provider-actions">
                    {!isCurrent && (
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => switchTo(p)}
                      >
                        启用
                      </button>
                    )}
                    <button
                      className="btn btn-sm"
                      title="复制此配置为新供应商"
                      disabled={busy}
                      onClick={() => duplicateProvider(p)}
                    >
                      复制
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => openEdit(p)}
                    >
                      编辑
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      title={isCurrent ? "当前供应商不可删除" : "删除"}
                      disabled={busy || isCurrent}
                      onClick={() => setConfirmDelete(p)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="provider-footer">
            <button className="btn" onClick={importCcswitch} disabled={busy}>
              从 CC Switch 备份导入
            </button>
            <button className="btn btn-primary" onClick={openCreate}>
              新增供应商
            </button>
          </div>
          <div className="provider-hint">
            切换 = 整文件替换 ~/.claude/settings.json（切换前自动备份为
            settings.json.bak，离任供应商吸收手工修改后保存到清单）。
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="删除供应商"
          message={`确定删除「${confirmDelete.name}」吗？其配置（含 API Key）将从清单中移除。`}
          okText="删除"
          danger
          onCancel={() => setConfirmDelete(null)}
          onOk={doDelete}
        />
      )}
    </Modal>
  );
}

/** 卡片内联用量条：`5h 37% · 2时13分后重置` 徽标 + 刷新按钮 */
function UsageStrip({
  result,
  loading,
  onRefresh,
}: {
  result: UsageResult;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="provider-usage">
      {result.data.map((t: UsageTier) => {
        const cd = fmtCountdown(t.resetsAt);
        const usd =
          t.usedValueUsd != null && t.maxValueUsd != null
            ? ` ($${t.usedValueUsd.toFixed(2)}/$${t.maxValueUsd.toFixed(2)})`
            : "";
        return (
          <span
            key={t.name}
            className={`usage-tier usage-${usageLevel(t.utilization)}`}
            title={t.resetsAt ?? undefined}
          >
            {TIER_LABEL[t.name] ?? t.name} {Math.round(t.utilization)}%{usd}
            {cd && ` · ${cd}`}
          </span>
        );
      })}
      {result.error && (
        <span className="usage-tier usage-bad" title={result.error}>
          {result.error}
        </span>
      )}
      <button
        className={`usage-refresh ${loading ? "loading" : ""}`}
        title="刷新用量"
        onClick={onRefresh}
        disabled={loading}
      >
        ⟳
      </button>
    </div>
  );
}
