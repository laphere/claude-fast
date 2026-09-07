import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "./Modal";
import ConfirmDialog from "./ConfirmDialog";
import PresetPicker, { CATEGORY_LABEL } from "./PresetPicker";
import { EyeIcon, EyeOffIcon } from "./Icons";
import { api } from "../lib/api";
import type {
  FetchedModel,
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

// ---------------- 模型映射行（移植 cc-switch ClaudeFormFields 行定义） ----------------

/** `[1M]` 字面后缀 = 声明该模型支持 1M 上下文（cc-switch CLAUDE_ONE_M_MARKER 同款） */
const ONE_M_MARKER = "[1M]";

function has1M(model: string): boolean {
  return model.trimEnd().toLowerCase().endsWith("[1m]");
}

function strip1M(model: string): string {
  const trimmedEnd = model.trimEnd();
  if (!trimmedEnd.toLowerCase().endsWith("[1m]")) return model;
  return trimmedEnd.slice(0, -ONE_M_MARKER.length).trimEnd();
}

function set1M(model: string, enabled: boolean): string {
  const base = strip1M(model).trim();
  if (!base) return "";
  return enabled ? `${base}${ONE_M_MARKER}` : base;
}

/** 模型映射行：envKey 写入键；nameKey 为显示名配套键（_NAME，随模型同步）；
 *  Haiku 不支持 1M 声明（与上游一致）；上游废弃的 ANTHROPIC_SMALL_FAST_MODEL 在写入时清理 */
const MODEL_ROWS = [
  { key: "model", envKey: "ANTHROPIC_MODEL", nameKey: null, label: "默认模型", hint: "兜底模型 ANTHROPIC_MODEL", supportsOneM: true },
  { key: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", nameKey: "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", label: "Sonnet", hint: undefined, supportsOneM: true },
  { key: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", nameKey: "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", label: "Opus", hint: undefined, supportsOneM: true },
  { key: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL", nameKey: "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", label: "Fable", hint: undefined, supportsOneM: true },
  { key: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", nameKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", label: "Haiku", hint: undefined, supportsOneM: false },
  { key: "subagent", envKey: "CLAUDE_CODE_SUBAGENT_MODEL", nameKey: null, label: "子代理", hint: "CLAUDE_CODE_SUBAGENT_MODEL", supportsOneM: true },
] as const;

type ModelRowKey = (typeof MODEL_ROWS)[number]["key"];

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
  models: Record<ModelRowKey, string>;
}

type Structured = Pick<
  FormState,
  "baseUrl" | "apiKey" | "apiKeyField" | "models"
>;

const EMPTY_MODELS: Record<ModelRowKey, string> = {
  model: "",
  sonnet: "",
  opus: "",
  fable: "",
  haiku: "",
  subagent: "",
};

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

/** 从配置 JSON 提取结构化字段的当前值（回显用；模型行严格读 env 键，空=留空跟随默认） */
function readStructured(jsonText: string): Structured {
  let baseUrl = "";
  let apiKey = "";
  let apiKeyField: ApiKeyField = "ANTHROPIC_AUTH_TOKEN";
  const models: Record<ModelRowKey, string> = { ...EMPTY_MODELS };
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
      for (const row of MODEL_ROWS) {
        const v = e[row.envKey];
        models[row.key] = typeof v === "string" ? v : "";
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

/**
 * 前端镜像的 Coding Plan 厂商探测：打开弹窗渲染卡片时即可知道该供应商
 * 是否会出现用量条，从而预留固定高度的骨架占位（避免结果到达后弹窗被撑大）。
 * ⚠️ 清单需与 src-tauri/src/usage_query.rs 的 detect_vendor 保持同步。
 */
function detectUsageVendor(baseUrl: string): string | null {
  const url = baseUrl.toLowerCase();
  if (!url) return null;
  if (url.includes("api.kimi.com/coding")) return "kimi";
  if (url.includes("bigmodel.cn") || url.includes("api.z.ai")) return "zhipu";
  if (url.includes("minimaxi.com") || url.includes("minimax.io")) return "minimax";
  if (url.includes("zenmux")) return "zenmux";
  if (url.includes("opencode.ai/zen/go")) return "opencode_go";
  return null;
}

// ---------------- 会话级用量缓存（stale-while-revalidate） ----------------

interface UsageState {
  loading: boolean;
  result?: UsageResult;
  /** 上次拿到结果的时刻（ms）：新鲜度判断 + 「N分钟前查询」标注 */
  fetchedAt?: number;
}

/** 模块级缓存：对话框关闭重开后 useState 直接以它初始化，第二次打开起秒显
 *  上次结果。cc-switch 同为内存缓存（react-query + usage_cache），重启后
 *  双方的首次打开都会重新查询。 */
let usageCache: Record<string, UsageState> = {};
/** 缓存新鲜期（同 cc-switch 默认 autoQueryInterval=5 分钟） */
const USAGE_FRESH_MS = 5 * 60_000;

/** 相对时间（「N分钟前查询」标注） */
function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

/** 重置倒计时（cc-switch 风格：纯 d/h/m 单位，取前两个非零档位，
 *  如 `2d 13h` / `5h 21m` / `45m`；过去时间/非法值返回空串不展示） */
function fmtCountdown(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "<1m";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m % 60 > 0 && parts.length < 2) parts.push(`${m % 60}m`);
  return parts.join(" ") || "<1m";
}

/** 利用率分档与色值对齐 cc-switch utilizationColor：<70 绿 / <90 橙 / 其余红 */
function usageLevel(pct: number): string {
  return pct < 70 ? "ok" : pct < 90 ? "warn" : "bad";
}

export default function ProviderDialog({ state, onClose, onChanged, toast }: Props) {
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProviderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [showKey, setShowKey] = useState(false);

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
    setShowKey(false);
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
      models: { ...EMPTY_MODELS },
    });
  };

  const openEdit = (p: ProviderInfo) => {
    setFormError(null);
    setFetchedModels(null);
    setShowKey(false);
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

  /** 结构化字段 → 修改 JSON → 回写 jsonText（打标跳过回读）。
   *  JSON 非法时只更新结构化输入框，不动 JSON 文本 */
  const patchJson = (mutate: (cfg: Record<string, unknown>) => void, extra: Partial<FormState>) => {
    if (!form) return;
    let nextJson = form.jsonText;
    try {
      const cfg = JSON.parse(form.jsonText);
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
        mutate(cfg as Record<string, unknown>);
        nextJson = prettyJson(cfg);
      }
    } catch {
      // JSON 非法：只更新结构化输入框，不动 JSON 文本
    }
    echoRef.current = nextJson;
    setForm({ ...form, jsonText: nextJson, ...extra });
  };

  const patchEnv = (envKey: string, value: string, extra: Partial<FormState>) => {
    patchJson((cfg) => setEnvKey(cfg, envKey, value), extra);
  };

  /** 模型行变更（移植 cc-switch handleRoleModelChange）：Haiku 剥离 1M 标记；
   *  同步 _NAME 显示名键；清理上游废弃的 ANTHROPIC_SMALL_FAST_MODEL */
  const changeModelRow = (rowKey: ModelRowKey, rawValue: string) => {
    if (!form) return;
    const row = MODEL_ROWS.find((r) => r.key === rowKey)!;
    const value = row.supportsOneM ? rawValue : strip1M(rawValue);
    patchJson(
      (cfg) => {
        setEnvKey(cfg, row.envKey, value);
        const env = cfg.env as Record<string, unknown>;
        delete env.ANTHROPIC_SMALL_FAST_MODEL; // 上游废弃键，避免覆盖 Haiku 回退
        if (row.nameKey) {
          const base = strip1M(value).trim();
          setEnvKey(cfg, row.nameKey, base);
        }
      },
      { models: { ...form.models, [rowKey]: value } },
    );
  };

  const toggleModel1M = (rowKey: ModelRowKey, enabled: boolean) => {
    if (!form) return;
    const row = MODEL_ROWS.find((r) => r.key === rowKey)!;
    if (!row.supportsOneM) return;
    changeModelRow(rowKey, set1M(form.models[rowKey], enabled));
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
        models: { ...EMPTY_MODELS },
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

  // ---------- 用量查询：会话级缓存 + stale-while-revalidate（对齐 cc-switch 显示逻辑） ----------
  // 打开弹窗立即显示缓存的上次结果（含「N分钟前查询」标注），仅当缓存缺失
  // 或超过新鲜期才后台重查、原地更新；骨架只出现在「从未查过」的供应商上
  // （每个供应商每次应用会话最多一次）。
  const [usage, setUsageState] = useState<Record<string, UsageState>>(usageCache);
  const usageOnceRef = useRef(false);

  const setUsage = (updater: (u: Record<string, UsageState>) => Record<string, UsageState>) => {
    setUsageState((u) => {
      const next = updater(u);
      usageCache = next; // 同步写回模块级缓存，供下次挂载秒显
      return next;
    });
  };

  /** 查询指定供应商用量；非 force 且缓存仍新鲜（<5 分钟，同上游 staleTime）时跳过 */
  const refreshUsage = (targets: ProviderInfo[], force = false) => {
    for (const p of targets) {
      const cached = usageCache[p.id];
      const fresh =
        !!cached?.result &&
        !!cached.fetchedAt &&
        Date.now() - cached.fetchedAt < USAGE_FRESH_MS;
      if (!force && fresh) continue;
      setUsage((u) => ({
        ...u,
        [p.id]: { loading: true, result: u[p.id]?.result, fetchedAt: u[p.id]?.fetchedAt },
      }));
      api
        .providerQueryUsage(p.id)
        .then((r) =>
          setUsage((u) => ({
            ...u,
            [p.id]: { loading: false, result: r, fetchedAt: Date.now() },
          })),
        )
        .catch(() =>
          setUsage((u) => ({
            ...u,
            [p.id]: {
              loading: false,
              result: u[p.id]?.result,
              fetchedAt: u[p.id]?.fetchedAt,
            },
          })),
        );
    }
  };

  useEffect(() => {
    if (form) return; // 表单态不查
    if (usageOnceRef.current) return; // 每次挂载只自动查一轮（内部另有新鲜度跳过）
    usageOnceRef.current = true;
    refreshUsage(state.providers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, state.providers]);

  const presetApiKeyUrl = useMemo(() => {
    if (!form || form.editId) return null;
    const preset = providerPresets.find((p) => p.name === form.presetName);
    if (!preset) return null;
    if (preset.category === "official" || preset.isOfficial) return null;
    return preset.apiKeyUrl || preset.websiteUrl || null;
  }, [form]);

  return (
    <Modal
      title="供应商切换"
      width={640}
      onClose={onClose}
      footer={
        form ? (
          <>
            {formError && <div className="form-error">{formError}</div>}
            <button className="btn" onClick={() => setForm(null)}>
              取消
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={saveForm}>
              保存
            </button>
          </>
        ) : undefined
      }
    >
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
            <div className="key-input-wrap">
              <input
                type={showKey ? "text" : "password"}
                autoComplete="off"
                value={form.apiKey}
                placeholder={form.apiKeyField === "ANTHROPIC_API_KEY" ? "sk-…（写入 ANTHROPIC_API_KEY）" : "sk-…（写入 ANTHROPIC_AUTH_TOKEN）"}
                onChange={(e) => patchEnv(form.apiKeyField, e.target.value, { apiKey: e.target.value })}
              />
              <button
                type="button"
                className="key-eye"
                title={showKey ? "隐藏 API Key" : "显示 API Key"}
                onClick={() => setShowKey((s) => !s)}
              >
                {showKey ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
              </button>
            </div>
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
                      已拉取 {fetchedModels.length} 个模型：点击各行输入框右侧箭头展开搜索选择，也可直接手输
                    </div>
                  )}
                </div>
                {MODEL_ROWS.map((row) => (
                  <ModelRow
                    key={row.key}
                    row={row}
                    value={form.models[row.key]}
                    models={fetchedModels}
                    onChange={(v) => changeModelRow(row.key, v)}
                    onToggle1M={(on) => toggleModel1M(row.key, on)}
                  />
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
                  <div className="provider-main">
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
                  {/* 用量条横跨卡片整行（同 cc-switch footer 布局），不与操作按钮抢宽度 */}
                  {detectUsageVendor(baseUrl) && (
                    <UsageStrip
                      state={u}
                      onRefresh={() => refreshUsage([p], true)}
                    />
                  )}
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

/** 单行模型映射：标签 + 可搜索下拉输入 + 「声明支持 1M」勾选（Haiku 不支持） */
function ModelRow({
  row,
  value,
  models,
  onChange,
  onToggle1M,
}: {
  row: (typeof MODEL_ROWS)[number];
  value: string;
  models: FetchedModel[] | null;
  onChange: (value: string) => void;
  onToggle1M: (enabled: boolean) => void;
}) {
  return (
    <div className="provider-model-row">
      <span className="provider-model-label" title={row.hint}>
        {row.label}
      </span>
      <ModelSelect
        value={value}
        models={models}
        onChange={onChange}
      />
      {row.supportsOneM ? (
        <label className="model-1m" title="在模型名后追加 [1M] 标记，声明该模型支持 1M 上下文">
          <input
            type="checkbox"
            checked={has1M(value)}
            onChange={(e) => onToggle1M(e.target.checked)}
          />
          1M
        </label>
      ) : (
        <span className="model-1m model-1m-placeholder" />
      )}
    </div>
  );
}

/** cc-switch 式模型选择：文本框可手输；点击箭头弹出搜索 + 按 ownedBy 分组的列表（缺失归 Other） */
function ModelSelect({
  value,
  models,
  onChange,
}: {
  value: string;
  models: FetchedModel[] | null;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const hasList = !!models && models.length > 0;

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, FetchedModel[]>();
    for (const m of models ?? []) {
      if (q && !m.id.toLowerCase().includes(q)) continue;
      const g = m.ownedBy?.trim() || "Other";
      const arr = map.get(g);
      if (arr) arr.push(m);
      else map.set(g, [m]);
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b),
    );
  }, [models, query]);

  return (
    <div className="model-select" ref={wrapRef}>
      <input
        value={value}
        placeholder="留空跟随默认"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="model-chevron"
        title={hasList ? "选择模型" : "请先点击上方「获取模型列表」"}
        disabled={!hasList}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="model-pop">
          <input
            className="model-pop-search"
            autoFocus
            placeholder="搜索模型…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="model-pop-list">
            {groups.map(([group, list]) => (
              <div key={group}>
                <div className="model-pop-group">{group}</div>
                {list.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`model-pop-item ${m.id === value ? "active" : ""}`}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    {m.id}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <div className="model-pop-empty">没有匹配「{query}」的模型</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 卡片内联用量条：`5h 37% · 2h 13m` 徽标 + 刷新按钮。
 * 渲染条件由调用方保证：仅当 base_url 探测命中厂商时挂载（占位防跳动）——
 * 首查加载中显示骨架 pill（与徽标行同高，结果到达原地替换，布局零位移）；
 * 刷新时保留旧结果，不闪骨架。
 */
function UsageStrip({
  state,
  onRefresh,
}: {
  state?: UsageState;
  onRefresh: () => void;
}) {
  const loading = state?.loading ?? false;
  const result = state?.result;
  const fetchedAt = state?.fetchedAt;

  // 探测命中但后端返回不支持（两侧清单同步后理论上不会发生）：占位行留空
  if (result && !result.supported) {
    return <div className="provider-usage" aria-hidden="true" />;
  }

  // 首查中：骨架占位
  if (!result) {
    return (
      <div className="provider-usage">
        <span className="usage-skeleton" style={{ width: 72 }} />
        <span className="usage-skeleton" style={{ width: 52 }} />
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

  return (
    <div className="provider-usage">
      {result.data.map((t: UsageTier) => {
        const cd = fmtCountdown(t.resetsAt);
        const usd =
          t.usedValueUsd != null && t.maxValueUsd != null
            ? `$${t.usedValueUsd.toFixed(2)}/$${t.maxValueUsd.toFixed(2)}`
            : "";
        return (
          <span key={t.name} className="usage-tier" title={t.resetsAt ?? undefined}>
            <span className="usage-tier-name">{TIER_LABEL[t.name] ?? t.name}</span>
            <b className={`usage-pct usage-${usageLevel(t.utilization)}`}>
              {Math.round(t.utilization)}%
            </b>
            {usd && <span className="usage-extra">{usd}</span>}
            {cd && <span className="usage-reset">· {cd}</span>}
          </span>
        );
      })}
      {result.error && (
        <span className="usage-tier usage-err" title={result.error}>
          {result.error}
        </span>
      )}
      {fetchedAt && (
        <span className="usage-queried-at" title="上次查询时间">
          {fmtAgo(fetchedAt)}查询
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
