# 统计模块迭代方案 —— 按时间范围 / 按模型查看用量

> 参考实现：本地 `D:\MyWorkspaces\myProject\cc-switch`（逐行给出了可对照的源码位置）
> 撰写日期：2026-09-16 ｜ 基线提交：`dfaf477`

---

## 进展（2026-09-16 晚）

用户澄清了真实诉求：**"模型的 token 消耗只能看到 7 天/30 天/全部的区间聚合，看不到按天"**，
**不需要做到四拆的程度**。据此调整并已落地：

| 项 | 状态 |
|---|---|
| 趋势图「总量 / 按模型」双视图（同一根柱按当日各模型用量堆叠） | ✅ 已落地，随后**删掉「总量」视图**——柱高本身就是总量，单色柱是堆叠的严格子集 |
| 模型分布每行加同色色块（充当趋势图堆叠段的图例） | ✅ 已落地 |
| 模型分布行内迷你柱（该模型窗口内逐日用量） | ❌ 已移除（用户要求）——逐日粒度只保留在趋势图，同一份数据不在两处重复呈现 |
| 后端字段扩展 / `LEDGER_VERSION` 变更 / 台账全量重扫 | **不需要**（零后端改动） |
| 期 1（四拆入台账）、期 2（接口 scope 化） | 暂缓 |
| 期 4（项目 × 模型、会话下钻）、期 5（去重、成本） | 待评估 |

**为什么零后端改动**：后端 `perModel[].perDay`（`RankDayUsage`）一直带着逐日明细
（`lib.rs:1953` + `lib.rs:2549-2560`），前端此前只拿它算窗口合计、没上时间轴。
"看不到模型的时间维度"是**纯展示缺口**，不是数据缺口 —— 这一点修正了本文档 0 节的初始判断。

**顺带查出的后端数据缺口（已在 `CLAUDE.md` 记录）**：台账里有 4 个条目
`per_day` 有量而 `per_day_model` 为空（实测 53 天里 4 天、占总量 0.20%）。
根因是会话文件在 `per_day_model` 字段引入（v2，`214b6fb`）**之前**就被删除，
条目永久缺该字段；v2 之后不可能再产生（`scan_file_usage` 里两者写在同一个
`if let Some(date)` 块内）。前端为此补了一条「未归属」堆叠段兜底 ——
不补的话 `flex-grow` 归一化会把各模型占比整体放大（实测单日失真 5.66%）。

---

## 0. 先说结论

**现状并不是"看不到模型"**：`模型分布（按 token）` 区块从首个统计提交（`5ddd2e0`，2026-08-31）就在，
后端 `per_model` 与 `per_day_model`（date × model）也一直存在，范围切换早已生效。

真正缺的是下面四件事，而它们都指向同一个根因：

| # | 缺口 | 证据 |
|---|---|---|
| A | **每个模型只有 total token，没有「输入 / 输出 / 缓存读 / 缓存写」四拆** | `per_day_model` 单元类型是 `(u64, usize)`，见 `lib.rs:2018`、`lib.rs:2234` |
| B | **没有自定义时间范围**，只有 7d/30d/全部三个预设 | `StatsDialog.tsx:23-27` |
| C | **模型不是"筛选维度"**：不能把整个面板收窄到某个模型，趋势图也不能按模型堆叠 | `StatsDialog.tsx:378-390` 只渲染排行榜；趋势图每柱只有 `d.tokens` 一个值 |
| D | **不能交叉**：项目 × 模型、"某模型每天用了多少"看不到 | 数据其实都在台账里（`per_day_model`），只是没有接口/UI 暴露 |

**根因一句话**：四拆（输入/输出/缓存读/缓存写）在**文件级**有（`LedgerEntry.input_tokens` 等，`lib.rs:2224-2227`），
在**日 × 模型交叉**里没有 —— 一旦按天或按模型切分，四拆就丢了，只剩一个总数。
这就是"只能看到总量"的由来。

### 实测数据量级（本机真实台账）

`%APPDATA%\claude-fast\stats-ledger.json`（`version: 3`, `tz: 480`）：

| 指标 | 值 |
|---|---|
| 台账体积 | **258 KB** |
| 文件条目 | 421 |
| `per_day` 单元格合计 | 485 |
| `per_model` 单元格合计 | 453 |
| `per_day_model` 单元格合计 | **499** |
| 模型数 | **12**（deepseek-v4-flash / deepseek-v4-pro / glm-5.3 / kimi-k2.7-code / minimax-m3 …） |
| 项目数 | 19 |
| 日期跨度 | 2026-07-19 ~ 2026-09-16（53 天） |

**结论：数据量级极小。** 不需要为了性能重写查询层，也不需要引入数据库。
`per_day_model` 只有 499 个单元格 —— 这意味着"模型 × 时间"的原始数据**已经全在手上了**，
缺的只是把它拆成四类 token、再暴露给 UI。

### 移植建议（一句话）

**不要**搬 cc-switch 的 SQLite 事实表那套（它的根基是"本地代理逐请求记账"，
我们是"jsonl 事后扫描"，数据源根本不同，引入 rusqlite + 版本迁移链收益不匹配）；
**该搬的是它的产品形态**（作用域筛选 + 四拆汇总卡 + 模型统计表 + 日历区间选择器）
**和两段具体算法**（跨文件语义指纹去重、明细/汇总分层查询）。

---

## 1. 现状盘点（代码级）

### 1.1 数据链路

```
~/.claude/projects/<项目>/**/*.jsonl
        │
        ▼  scan_file_usage()            lib.rs:2085
   FileUsage { per_day, per_model, per_day_model }   lib.rs:2006
        │
        ▼  持久化（mtime+size 未变则跳过重扫）
   LedgerEntry  → stats-ledger.json     lib.rs:2214 / 2256(LEDGER_VERSION=3)
        │
        ▼  aggregate_stats_ledger()     lib.rs:2349
   UsageStats { per_day, per_project, per_model, 全局四拆 }   lib.rs:1981
        │
        ▼  get_usage_stats(tzOffsetMinutes)   lib.rs:2613（一次全量返回）
   前端 StatsDialog：切范围 = 前端过滤 perDay/perModel.perDay   StatsDialog.tsx:125-242
```

### 1.2 各层的维度能力对照

| 层级 | 按日 | 按模型 | 按项目 | 四类 token 拆分 | 按会话 |
|---|---|---|---|---|---|
| 文件级 `FileUsage` / `LedgerEntry` | ✅ `per_day` | ✅ `per_model` | ✖（文件归属单项目） | ✅ `input/output/cache_read/cache_creation` | — |
| 日 × 模型 `per_day_model` | ✅ | ✅ | ✖ | ❌ **只有 total** | ✖ |
| `UsageStats` 全局 | ✅ `perDay` | ✅ `perModel` | ✅ `perProject` | ✅ 但仅全局总计 | ✅ |
| 前端展示 | 趋势图（**仅一条总量**） | 排行榜（**仅总量**） | 排行榜 | 仅"全部"范围的汇总卡副标题 | 汇总卡 |

> 注意上表倒数第二行最后一列：`StatsDialog.tsx:293-297` 的四拆副标题**只在 `range === "all"` 时渲染** ——
> 选了"近 7 天"连全局四拆都看不到。

### 1.3 现有口径（**迭代中不得改动**）

以下三条是历次修复沉淀下来的，新维度必须沿用：

1. **每日会话数按「最后活跃日」归属** —— 跨天会话只计一次，窗口内累加 = 去重会话数（`lib.rs:2485`）。
   另有 `active_sessions`（当日活跃）专供趋势图 tooltip（`lib.rs:2437`）。
2. **子代理文件归属父会话 id** —— `usage_jsonl_files` 扫 `<项目>/<uuid>/subagents/**`（含 `workflows/wf_*`），
   但 `session_id` 记父会话（`lib.rs:2296`），会话数按 `session_id` 去重。
3. **`excluded` 项目整体不计**（含其台账历史，`lib.rs:2421`）。

---

## 2. cc-switch 是怎么做的

### 2.1 架构：两层表 + UNION 查询

| 组件 | 位置 | 说明 |
|---|---|---|
| 明细事实表 `proxy_request_logs` | `database/schema.rs:197` | **逐请求一行**：`model` / 四类 token / 四类成本 / `latency_ms` / `status_code` / `session_id` / `created_at` / `data_source` |
| 日汇总表 `usage_daily_rollups` | `database/schema.rs:277` | PK = `(date, app_type, provider_id, model, request_model, pricing_model)`，**保留四类 token** |
| 归档剪枝 | `dao/usage_rollup.rs:62` | 超过保留期的明细聚合成日汇总后**删除明细**（SAVEPOINT 保证原子） |
| 查询 | `services/usage_stats.rs:1494-1521` | **`UNION ALL`**：老数据查汇总表、近期查明细表，外层再 `GROUP BY model` |
| 部分覆盖天的裁剪 | `services/usage_stats.rs:523` | `compute_rollup_date_bounds` —— 区间起点非零点就顺延到次日，终点非 23:59 就回退到前一日，避免"半天既进了汇总又是明细"的重复计数 |
| 去重台账 | `database/schema.rs:322` | `session_usage_dedup(data_source, request_id, semantic_id, has_entry_id)` |
| 语义指纹去重 | `services/usage_stats.rs:349-432` | `DedupKey{app_type,model,四类token,created_at}`，在 `created_at ± 窗口` 内匹配已存在的代理行；`request_id` 已存在则直接跳过 |
| 导入侧 | `services/session_usage.rs:401` / `:794` | Claude jsonl → `proxy_request_logs`，`provider_id="_session"` / `data_source="session_log"` 区分来源；`session_log_sync` 表存**字节游标 + 尾部指纹**做增量读 |

### 2.2 前端：一个 scope 驱动全部面板

`UsageDashboard.tsx`：

- 顶栏筛选：**应用 Tab**（all/claude/codex/gemini…）× **Provider 下拉** × **模型下拉** × 刷新间隔 × **日历区间选择器**
  - 级联规则值得抄：切应用 → 清空 provider 与 model；切 provider → 清空 model（`UsageDashboard.tsx:122-134`）
  - 选项池动态生成：只列出**当前范围内真实有数据**的 provider / model（`:245-274`）
  - 自定义选项加 `v:` 前缀隔离值域，避免用户自定义名撞上 `"all"` 哨兵（`:81-84`）
- 区间语义：`today / 1d / 7d / 14d / 30d / custom`（`types/usage.ts:165`），
  custom 支持**起止日期**与 `liveEndTime`（结束时间跟随"现在"，`lib/usageRange.ts:50-59`）
- 面板：`UsageHero`（四拆 + 缓存命中率 + 成功率）、`UsageTrendChart`（recharts AreaChart，可堆叠）、
  三个 Tab（请求明细 / Provider 统计 / **模型统计**）
- 后端接口也是 scope 化：`get_usage_summary / get_usage_trends / get_provider_stats / get_model_stats / get_request_logs`
  全部带 `(start_date, end_date, app_type, provider_name, model)`（`commands/usage.rs:9-100`）

### 2.3 可移植性判定

| 项 | 判定 | 理由 |
|---|---|---|
| SQLite 事实表 + rusqlite + 迁移链 | ❌ 不移植 | 数据源不同（它是代理逐请求记账，我们是事后扫 jsonl）；引入 DB 与迁移体系成本远超收益（当前台账 258 KB） |
| 日汇总表 + `UNION ALL` 分层 | ⚠️ 部分借鉴 | 我们的 `LedgerEntry` 本身就是"汇总层"，无需再分层；但**"汇总单元必须携带完整维度"**这一原则要抄 |
| **语义指纹去重** | ✅ 值得移植 | 直接解决我们 `CLAUDE.md` 里记的已知取舍"`claude --resume`/compact 拷贝出的新文件（同 message.id）仍会双计" |
| **作用域筛选（scope）形态** | ✅ 强烈建议抄 | 模型下拉 + 级联清空 + 动态选项池 + 日历区间 |
| **四拆 + 缓存命中率展示** | ✅ 抄 | `UsageHero.tsx:299-330` |
| 字节游标增量读 | ⚠️ 参考 | 我们已有 `mtime+size` 判定 + `USAGE_CACHE`，但对"同尺寸重写"无防护；`last_tail_fingerprint`（`session_usage.rs:350`）思路可补 |
| 成本核算（`model_pricing` + models.dev 同步） | 🔶 可选 | 我们是订阅/中转场景，jsonl 无 `costUSD`；要做只能内置价目表，默认应关闭 |

---

## 3. 迭代方案（5 期）

### 期 1 ｜ 后端数据口径：让「日 × 模型」带上四拆 ★地基

**改动**（`src-tauri/src/lib.rs`）：

```rust
// 现状 lib.rs:2006 FileUsage
per_day:       BTreeMap<String, (u64, usize)>,
per_model:     HashMap<String, (u64, usize)>,
per_day_model: BTreeMap<String, HashMap<String, (u64, usize)>>,

// 目标：抽出可复用的单元结构（前后端字段名 camelCase）
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageCell {
    tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    messages: usize,
}
// per_day / per_model / per_day_model 三处单元统一换成 UsageCell
```

- `scan_file_usage`（`lib.rs:2143-2167`）累加处补四个字段。
- `RankDayUsage`（`lib.rs:1926`）与 `ModelUsage`（`lib.rs:1953`）增加四拆字段。
- `aggregate_stats_ledger` 的 `model_days` / `day_map` / `project_map.days` 桶同步升级（`lib.rs:2439-2532`）。
- **`LEDGER_VERSION` 3 → 4**（`lib.rs:2256`），触发一次全量重扫 —— 本机 421 个文件，代价秒级。
- 台账体积：`per_day_model` 仅 499 单元格，预计 258 KB → 约 300–400 KB，可接受。

**新增单测**：

1. 四拆守恒：任一单元 `input + output + cache_read + cache_creation == tokens`；
2. 旧台账（缺四拆字段）反序列化不 panic（`#[serde(default)]` 兜底，且 `version` 不匹配强制重扫）；
3. 日期 × 模型交叉：同一 date 下多模型各自四拆互不串味。

**验收**：写入一个含 2 个模型、跨 2 天的 fixture jsonl，断言两张 `per_day_model` 单元格的四拆与 total 一致。

---

### 期 2 ｜ 查询接口作用域化（`get_usage_stats` 加参数）

```rust
#[tauri::command]
async fn get_usage_stats(
    tz_offset_minutes: i64,
    // 新增，全部可选；不传 = 现状行为（全量，向后兼容）
    start_date: Option<String>,      // YYYY-MM-DD，本地日历，含
    end_date: Option<String>,        // YYYY-MM-DD，本地日历，含
    models: Option<Vec<String>>,     // 模型白名单（多选）
    project_paths: Option<Vec<String>>,
    group_by: Option<String>,        // "day"(默认) | "month"
) -> Result<UsageStats, String>
```

- 返回结构**不变**（`perDay` / `perModel` / `perProject` 即窗口内结果），前端从"拉全量再过滤"改成"传参拿窗口"。
- `group_by: "month"` 把现在前端做的月度聚合（`StatsDialog.tsx:127-152`）下沉到后端。

**取舍要说清**：以实测数据量（499 单元格 / 258 KB）看，**现状的"后端全量 + 前端过滤"完全够用**，
这一期的目的不是性能，而是两件事：

1. 支持**任意起止区间**（Excel 式日历筛选）——不把 53 天的明细全塞给前端也能算；
2. 模型/项目**多选下钻**时保持接口语义清晰（筛选逻辑只有一份，在后端）。

> 若想压缩范围，**期 2 可以整个跳过**：期 3 的所有 UI 都能靠前端已拿到的 `perModel.perDay` 实现，
> 只是要额外传一个窗口起点（现有 `rangeStart` 机制，`StatsDialog.tsx:198`）。

---

### 期 3 ｜ UI：把"模型"提升为一等筛选维度 ★用户感知最强

按收益从高到低排列，前四项建议一起做：

1. **工具栏加时间范围**：`今天 / 近 7 天 / 近 14 天 / 近 30 天 / 全部 / 自定义`。
   自定义用两个 `<input type="date">` + 可选"结束时间跟随现在"（对应 cc-switch 的 `liveEndTime`）。
   现有 `windowStart` / `addDaysStr`（`StatsDialog.tsx:48-59`）可直接复用为预设解析。
2. **新增模型下拉筛选器（多选）**，作用于汇总卡 / 趋势图 / 项目排行 / 模型表。
   选项池从 `stats.perModel` 动态生成；抄 cc-switch 的**级联清空**与"选中项掉出选项池时补回"两条规则
   （`UsageDashboard.tsx:256-274`）。
3. ✅ **趋势图支持按模型堆叠**（**已落地**）：`chartMode` 切换「总量 / 按模型」，**打开默认按模型**；
   每根柱按当日各模型用量分段着色，hover tooltip 列各模型当日用量（单序列时不渲染明细列表，避免只重复一次总数）。
   项目**零图表库**（现有 `.stat-chart/.stat-col/.stat-bar` 手写，`styles.css:1286-1345`），
   实现照旧手写（`.stat-stack` + `.stat-seg` 用 `flex-grow` 分配高度），**未引 recharts** —— 避免了 +100KB 与主题适配成本。
   配色按当前窗口用量排名从 9 色固定色板取（最强模型恒为陶土色，与 accent 同源），超 9 个模型折叠「其他」。
4. **汇总卡四拆在所有范围都显示**，别再只在"全部"时给副标题（`StatsDialog.tsx:293-297`）。
   同时新增**缓存命中率**卡：`cacheRead / (input + cacheCreation + cacheRead)`（口径抄 `UsageHero.tsx:115`）。
5. **模型分布从"条形排行"升级为表格**：`模型 / 消息数 / 输入 / 输出 / 缓存读 / 缓存写 / 总计 / 占比`，
   表头可排序；**点击行 = 下钻**（等价于把模型筛选器设为该模型）。
6. 模型分布行加"占窗口总量百分比"，与汇总卡呼应。

---

### 期 4 ｜ 交叉维度（零版本 bump 也能做）

- **项目 × 模型**：`project_map` 聚合时（`lib.rs:2504`）顺带按 `model` 建桶即可 ——
  `LedgerEntry.per_model` 已在，**不需要新增台账字段，不需要 bump 版本**。
  前端：项目行可展开，显示该项目下的模型构成条。
- **会话级下钻**：从台账按 `model` 聚合出该模型消耗最高的会话（台账 `session_id` + `project_path` 都有），
  点击直接打开会话查看器（复用 `SessionViewer`），把"统计"和"看会话"打通。
  这是 cc-switch `RequestLogTable`（逐请求明细）在我们数据源下的**等价物**（我们是逐会话，没有逐请求）。

---

### 期 5 ｜ 口径修正与可选扩展

**5.1 跨文件去重（建议做，移植 cc-switch 语义指纹）**

现状：`CLAUDE.md` 明确记载"去重/台账粒度是单文件内，`claude --resume`/compact 拷贝出的新文件（同 message.id）仍会双计"。
cc-switch 的做法（`services/usage_stats.rs:349-432`）可直接搬：

- 台账 `LedgerEntry` 增 `msg_ids: Vec<u64>`（存放已计入的 `message.id` 的 64 位 hash，压缩体积）；
- 聚合前做**全局**去重：同一 `message.id` 只计一次；
- 跨源场景才需要 `created_at ± 窗口` 的模糊指纹，我们只有一个数据源，**精确 id 去重即可**，比 cc-switch 更简单也更准。

代价：台账体积增加（约 `8 字节 × 消息数`）。本机 421 文件、消息量级不大，可接受。
**注意：这一期也要 bump `LEDGER_VERSION` —— 请与期 1 的 bump 合并成一次**，避免两次全量重扫。

**5.2 成本估算（可选，默认关闭）**

若要"花了多少钱"，只能自带价目表：内置 `model_pricing`（四类单价 / 百万 token）+ 用户可编辑覆盖，
按 `tokens × 单价` 计算，UI 标注"估算值"。**必须在设置里默认关闭** ——
用户多在中转/订阅场景，单价不可知，默认展示会误导。

---

## 4. 风险与铁律

| 风险 | 处置 |
|---|---|
| `LEDGER_VERSION` 每次 bump = 一次全量重扫 | **把期 1 与期 5.1 的字段变更合并为一次 bump**；bump 前在提交信息里写明触发重扫 |
| 破坏现有三条口径（最后活跃日归属 / 子代理归属父会话 / excluded 整体不计） | 新维度只做"加"，不改归属算法；每条口径补一条回归测试 |
| 时区 | 四拆单元嵌在 `per_day_model` 内，仍沿用"`tz_offset_minutes` 变化 → 全量重扫"（`lib.rs:2357`） |
| 台账体积 | 每次加字段前先按本机真实数据估算（本期基线：258 KB / 421 文件 / 499 单元格）；超过 ~2 MB 时改分片（每项目一个台账文件） |
| 新增按钮的墨迹居中 | 项目铁律（`CLAUDE.md` 有对照表）：新按钮必须 `inline-flex + 居中` + 按 line-height 加不对称 padding，并放大目检 |
| 图表库选择 | 坚持手写，不引 recharts/echarts —— 保持零图表依赖 |
| 前端过滤 vs 服务端过滤并存 | 若跳过期 2，需在 `CLAUDE.md` 写明"`perModel.perDay` 是范围过滤的依据"，防止后续误删 |

---

## 5. 工作量与收益排序

| 期 | 内容 | 主要文件 | 用户可见收益 | 依赖 |
|---|---|---|---|---|
| **1** | 台账单元带四拆 | `lib.rs`（2006/2214/2349 区段） | 间接（解锁后续） | — |
| **3** | 筛选条 + 模型下钻 + 堆叠趋势 + 模型明细表 | `StatsDialog.tsx`、`styles.css`、`types.ts` | ★★★★★ | 期 1 |
| **2** | `get_usage_stats` scope 参数 | `lib.rs`、`api.ts` | ★★（支持任意区间/多选） | 期 1 |
| **4** | 项目×模型、会话下钻 | `lib.rs`、`StatsDialog.tsx` | ★★★ | 期 1 |
| **5.1** | 跨文件去重 | `lib.rs` | ★★★（数字更准） | 与期 1 合并 bump |
| **5.2** | 成本估算 | `lib.rs` + 新价目表 | ★★（可选） | 期 1 |

**推荐路径**：期 1 → 期 3 →（期 2）→（期 4 → 期 5.1，合并一次 bump）→ 期 5.2。
只做「期 1 + 期 3」就能覆盖用户诉求（按时间范围、按模型看用量）。

---

## 6. 关键代码位置索引

### 本项目（claude-fast）

| 位置 | 内容 |
|---|---|
| `src-tauri/src/lib.rs:1981` | `UsageStats` 定义 |
| `src-tauri/src/lib.rs:1926` / `:1953` | `RankDayUsage` / `ModelUsage` |
| `src-tauri/src/lib.rs:2006` | `FileUsage`（三张维度表） |
| `src-tauri/src/lib.rs:2085` | `scan_file_usage`（核心扫描） |
| `src-tauri/src/lib.rs:2214` / `:2239` | `LedgerEntry` / `StatsLedger` |
| `src-tauri/src/lib.rs:2256` | `LEDGER_VERSION`（当前 3） |
| `src-tauri/src/lib.rs:2296` | `usage_jsonl_files`（扫描范围，含 subagents） |
| `src-tauri/src/lib.rs:2349` | `aggregate_stats_ledger` |
| `src-tauri/src/lib.rs:2613` | `get_usage_stats` 命令 |
| `src/components/StatsDialog.tsx:23-27` | 范围预设 |
| `src/components/StatsDialog.tsx:125-242` | `bars` / `projectRows` / `modelRows`（前端范围过滤） |
| `src/components/StatsDialog.tsx:293-297` | 四拆副标题（仅"全部"显示） |
| `src/components/StatsDialog.tsx:378-390` | 模型分布渲染 |
| `src/styles.css:1160-1390` | `.stats-*` / `.stat-*` 样式 |

### cc-switch（参考）

| 位置 | 内容 |
|---|---|
| `src-tauri/src/database/schema.rs:197` | `proxy_request_logs` 明细表 |
| `src-tauri/src/database/schema.rs:277` | `usage_daily_rollups` 日汇总表 |
| `src-tauri/src/database/schema.rs:322` | `session_usage_dedup` 去重台账 |
| `src-tauri/src/services/usage_stats.rs:349-432` | `DedupKey` + 语义指纹去重 |
| `src-tauri/src/services/usage_stats.rs:523` | `compute_rollup_date_bounds`（部分天裁剪） |
| `src-tauri/src/services/usage_stats.rs:1494-1521` | detail ∪ rollup 的 `UNION ALL` 查询 |
| `src-tauri/src/services/session_usage.rs:401` / `:794` | jsonl → 明细表导入 + 增量字节游标 |
| `src/components/usage/UsageDashboard.tsx` | 顶栏 scope 筛选（级联清空 / 动态选项池） |
| `src/components/usage/UsageHero.tsx:299-330` | 四拆 + 缓存命中率展示 |
| `src/lib/usageRange.ts` | 预设与自定义区间的解析 |
