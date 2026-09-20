# 交互类工具的开关与契约（ExitPlanMode / AskUserQuestion / EnterPlanMode）

> 2026-09-21 实测。环境：CLI `2.1.278`、SDK `0.3.278`。探针脚本在 `%TEMP%\plan-probe\`（`pptool.mjs` 测工具表、`bypass.mjs` 测 bypass 档、`ask.mjs` 测通道、`ask2.mjs` 测答案回传），**不属源码库、不随分支提交**。
>
> 为什么写这篇：`claude-fast-electron` 的对话层要拿「模型自己进计划模式 / 出方案 / 有分歧时问用户选哪个」这套能力，而 2026-09-20 曾误判为「`--print` 模式下拿不到，只能走启发式兜底」。本文把开关、通道、回传格式逐条钉死。

## TL;DR

1. **唯一的开关是 `--permission-prompt-tool stdio`**。缺它，`ExitPlanMode` / `AskUserQuestion` / `EnterPlanMode` / `DesignSync` 四个交互工具**不在工具表里**。
2. **SDK 会自动补这一对参数**——只要传了 `canUseTool`。裸协议侧要自己加。
3. **`bypassPermissions` 不会把提问自动批掉**：`can_use_tool:AskUserQuestion` 照常到达宿主。
4. **答案经 `updatedInput.answers` 回传**。只回 `{behavior:"allow"}` 不报错、但等于「用户没选」——**静默失效**，是这一层最容易踩的坑。

---

## 1. 工具表开关

交互类工具在非交互（`--print`）模式下默认被裁掉，加 `--permission-prompt-tool stdio` 即恢复。

实测对照（同一组基础参数，`--permission-mode plan`）：

| 参数 | 工具数 | 交互工具命中 |
|---|---|---|
| 基线（无该 flag） | 28 | — |
| `--permission-prompts host` | 28 | — |
| **`--permission-prompt-tool stdio`** | 31 | `ExitPlanMode` `AskUserQuestion` `EnterPlanMode` |

### 两个坑

- **别拿工具总数当判据**：同一组参数下总数会在 24–31 之间抖动（MCP / 插件工具的加载数量波动所致），与交互工具无关。要直接查**具体工具名**。
- **`--permission-prompts host` 是干扰项**：名字极像，但它是另一条 flag（决定「谁回答权限提示」，默认值本来就是 `host`）。加它不解决任何问题。真正管用的是 `--permission-prompt-tool stdio`。
- **`--permission-prompt-tool` 不在 `claude --help` 的选项列表里**：只在 `--permission-prompts` 的说明文字里被顺带提到——`"host" (the SDK host or --permission-prompt-tool)`。这是当初漏掉它的直接原因；也意味着它属于**未正式列出的 CLI 面**（SDK 内部在用），升级 CLI 时值得回归一次。

### SDK 侧

SDK 传了 `canUseTool` 时会自动加上这一对参数（`sdk.mjs` 的 transport `initialize()`）。实测 SDK 真实 spawn 参数：

```
--output-format stream-json --verbose --input-format stream-json
--permission-prompt-tool stdio --permission-mode plan --include-partial-messages
```

## 2. `bypassPermissions` 下的行为（关键场景）

用户场景：**默认 bypassPermissions，不做手动模式切换，仍希望模型有分歧时来问**。

| 参数 | 生效模式 | 工具数 | 命中 |
|---|---|---|---|
| `--permission-mode bypassPermissions`（无 flag） | bypassPermissions | 28 | — |
| `--permission-mode bypassPermissions` + flag | bypassPermissions | 31 | 三个都在 |
| 上者再加 `--allow-dangerously-skip-permissions` | bypassPermissions | 31 | 三个都在 |
| `--dangerously-skip-permissions` + flag | bypassPermissions | 31 | 三个都在 |
| `--permission-mode manual` + flag（对照） | default | 31 | 三个都在 |

**结论：bypass 只是「权限不再逐条确认」，不会把提问类工具一起吞掉。** 这与已知口径一致——被自动批准的模式下仍有少数调用会到达宿主：`AskUserQuestion`、标了 `_meta["anthropic/requiresUserInteraction"]` 的 MCP 工具、组织级设为 ask 的连接器、以及关键路径上的 `rm`/`rmdir`（这条来自文档口径，本次未逐条复现；`AskUserQuestion` 已端到端实测通过）。

## 3. `AskUserQuestion` 的完整契约

### 3.1 下发（CLI → 宿主）

经 `control_request` 的 `can_use_tool`，`tool_name = "AskUserQuestion"`。真实 payload：

```json
{
  "questions": [
    {
      "question": "这个项目接下来优先做哪件事？",
      "header": "优先级",
      "options": [
        { "label": "补文档", "description": "完善 README、模块说明和接口文档，让项目更容易上手和交接。" },
        { "label": "加测试", "description": "补充单元测试/回归用例，先覆盖核心路径和高风险改动点。" },
        { "label": "重构",   "description": "梳理结构、消除重复与耦合，改动前先确认现有行为有测试兜底。" }
      ],
      "multiSelect": false
    }
  ]
}
```

约束（来自 `sdk-tools.d.ts` 的 `AskUserQuestionInput`）：**1–4 题**，每题 **2–4 个选项**，选项含 `label` / `description` / 可选 `preview`（聚焦时的预览内容，可放代码或 mockup）；**不提供 "Other"**，系统会自动给。这套结构可以直接当 UI 数据模型用。

### 3.2 回传（宿主 → CLI）

```
control_response
  response.subtype   = "success"
  response.request_id= <原样回填>
  response.response  = { behavior: "allow", updatedInput: { ...原 input, answers: { "<题目文本>": "<选项文字>" } } }
```

- `answers` 的 **key 是 `question` 的完整文本**（不是 `header`）。
- 多选答案**逗号分隔**（来自类型注释，本次未实测多选）。
- ⚠️ **只回 `{behavior:"allow"}` 而不带 `updatedInput`：不报错，但等于没选。** 实测模型收到的是「问题已发出，但你没有选择任何选项」——**静默失效**，没有任何错误码。这是本层最需要单测覆盖的分支。

### 3.3 结果与流水

CLI 把 `answers` 转成工具结果喂回模型，实测回显：

```
Your questions have been answered: "这个项目接下来优先做哪件事？"="加测试". You can now continue with these answers in mind.
```

模型随后正常继续，实测收尾复述：「你选择了优先「加测试」」。

### 3.4 `AskUserQuestionOutput` 的其余字段

`sdk-tools.d.ts` 里 `AskUserQuestionOutput` 除 `questions` / `answers` 外还有：

| 字段 | 含义 |
|---|---|
| `response?: string` | 用户**没选结构化选项、直接打字**时输入的自由文本 |
| `annotations?: { [题目文本]: { preview?, notes? } }` | 逐题备注（预览选项的说明、用户附加的注记） |
| `afkTimeoutMs?: number` | 对话框**空闲自动解决**时的毫秒数；人类正常作答的路径上不出现 |

后三个本次只读了类型定义，**未实测**。`response` 值得实现——它的存在说明 UI 应当允许「不选选项、直接写字」。

### 3.5 类型出处

`sdk-tools.d.ts`（SDK 随包发布的工具 schema，**这是查工具契约最快的途径**，比读压缩后的 `sdk.mjs` 可靠）：

```
export interface AskUserQuestionInput  { questions: [...] }              // 第 1102 行
export interface AskUserQuestionOutput { questions; answers; response?; annotations?; afkTimeoutMs? }  // 第 3749 行
```

## 4. 对实现的意义

**这一整条链是「flag 级 + 协议级」，不是 SDK 级。** SDK 的贡献只有一条：传 `canUseTool` 时自动补 `--permission-prompt-tool stdio`。

| 环节 | 手搓协议侧（如 `v2.0.0` 的 `chat.rs`）要做什么 |
|---|---|
| 三个工具进工具表 | `build_cli_args` 加一对参数 |
| 收到提问/方案请求 | **已有**（`can_use_tool` 的通用权限卡路径就在收） |
| 回传答案 | `build_permission_response` 支持 `updatedInput`（当前只发 `{behavior:"allow"}`，约 5 行） |
| UI | 选择题卡 / 方案卡，两边都得自己写 |

顺带修正一条此前的误判：`ExitPlanMode` 并非「print 模式下拿不到、原生方案审批是死代码」。**同一个 flag 就能拿到。** 有了它，方案正文是 `input.plan`、选项是模型自己产出的结构化数据——不再需要「猜最后一条助手文本」+ 侧信道让另一个 LLM 整理选项那套模拟做法。

**行为上的注意**：`EnterPlanMode` 是**模型自己的判断**，不保证每次触发（`bypassPermissions` 下它可能直接开干）。要验收「有分歧就问我」，看的是 `AskUserQuestion`，不是「它有没有自己进计划模式」。

## 5. 复现

```bash
node "%TEMP%\plan-probe\pptool.mjs"   # 工具表：基线 / --permission-prompts host / --permission-prompt-tool stdio
node "%TEMP%\plan-probe\bypass.mjs"   # bypassPermissions 各变体
node "%TEMP%\plan-probe\ask.mjs"      # 提问通道是否到达宿主 + payload 形状
node "%TEMP%\plan-probe\ask2.mjs"     # updatedInput.answers 回传闭环
```

踩坑记录：**`--input-format stream-json` 下 `system/init` 要等第一条 stdin 消息才吐**——不发消息只等 init 会一直静默，容易误判成进程卡死。另外用 `node -e` 写探针时 `process.exit()` 会丢掉管道里未 flush 的 stdout。

## 6. 未验证

- **SDK 升级后**该 flag 与 `updatedInput.answers` 契约是否变化（`--permission-prompt-tool` 未列入 `claude --help`，属未正式列出的面）
- **真机打包**（Electron 产物内）行为是否与开发态一致
- `multiSelect: true` 的多选回传格式（逗号分隔来自类型注释）
- `response`（自由文本）与 `afkTimeoutMs`（空闲自动解决）的触发路径
- 一次 `can_use_tool` 携带多题（`questions` 数组长度 >1）时的 UI 与回传
