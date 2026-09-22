import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import { newSessionId } from "./lib/pty";
import type {
  CloseAction,
  PinnedSession,
  PinnedSessionInfo,
  Project,
  ProviderListState,
  SessionInfo,
  TabActivity,
  TerminalTab,
} from "./types";
import Header from "./components/Header";
import { MessageCircleIcon, SearchIcon, XIcon } from "./components/Icons";
import ProjectList from "./components/ProjectList";
import PinnedSessions from "./components/PinnedSessions";
import StatusBar from "./components/StatusBar";
import ContextMenu from "./components/ContextMenu";
import NewLauncherDialog from "./components/NewLauncherDialog";
import BatchAddDialog from "./components/BatchAddDialog";
import HealthDialog from "./components/HealthDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import SettingsDialog from "./components/SettingsDialog";
import CloseChoiceDialog from "./components/CloseChoiceDialog";
import RenameDialog from "./components/RenameDialog";
import TrashDialog from "./components/TrashDialog";
import StatsDialog from "./components/StatsDialog";
import ProviderDialog from "./components/ProviderDialog";
import ChatView from "./components/ChatView";
import ChatTabs from "./components/ChatTabs";
import TerminalPane from "./components/TerminalPane";
import SessionContextMenu from "./components/SessionContextMenu";
import TabContextMenu from "./components/TabContextMenu";
import { sessionIdFromFile } from "./lib/session-file";

export type DialogKind = "new" | "batch" | "health" | null;

/** 内容区 tab：页面对话（Agent SDK 托管）或内嵌终端（真 claude CLI 跑在 PTY 里），
 *  两种 tab 共存于同一条 tab 栏（简报 §5：改「默认交互方式」不得关掉已开的 tab）。
 *  对话状态收在 tab 对象上（phase），不再旁挂 map——终端 tab 的状态本来就在
 *  TerminalTab.status 里，两套并列时旁挂 map 只会多一张对不上的表。 */
export type ContentTab =
  | {
      kind: "chat";
      id: string;
      projectPath: string;
      title: string;
      /** null = 新对话 */
      session: SessionInfo | null;
      /** 只读会话页（点会话行进来的默认形态）：只渲染历史，无输入框、绝不启动进程。
       *  历史会话要不要继续得先看一眼——误触 resume 会写 jsonl 并把旧会话顶到列表最前 */
      readOnly?: boolean;
      /** 所属项目 key（关闭 tab 时刷新会话列表用） */
      key: string;
      /** 对话状态（"starting"/"thinking" 时 tab 打点、"关闭其他"时跳过） */
      phase: string;
    }
  | ({ kind: "term" } & TerminalTab);

/** 会话进行中 = 正在启动/思考中（"关闭其他会话"时跳过这类 tab）。
 *  **唯一定义处**：ChatTabs 的忙碌小圆点、App 的可关性判断、tab 右键菜单的计数
 *  都从这里取——散成三份后改一处（比如加个 "starting" 之外的过渡态）必然漏改，
 *  表现为「tab 上点着忙点、菜单却肯关它」。 */
export function isBusyPhase(phase: string | undefined): boolean {
  return phase === "thinking" || phase === "starting";
}

/** 窗口过窄自动收起左栏的阈值（40px 迟滞带防边界抖动）：
 *  <980 收起——980-360(左栏)=620px 内容区，再窄会话内容/查看器局促，
 *  收起后同宽度内容区大幅放宽；>1020 恢复。只恢复「被自动收起」的，
 *  用户手动收起/展开的意图不被 resize 覆盖 */
const SIDEBAR_COLLAPSE_BELOW = 980;
const SIDEBAR_EXPAND_ABOVE = 1020;

interface ConfirmState {
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
  onOk: () => void | Promise<void>;
}

export default function App() {
  const [items, setItems] = useState<Project[]>([]);
  const [projectDirs, setProjectDirs] = useState<string[]>([]);
  const [excludedDirs, setExcludedDirs] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [dark, setDark] = useState(false);
  const [search, setSearch] = useState("");
  /** 左栏搜索框是否展开（搜索入口收进了顶栏「搜索」按钮） */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 左栏项目列表是否收起（收起后内容区占满全宽，仅内存态不落盘） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** 当前收起是否由「窗口过窄自动收起」触发（决定拉宽后要不要自动恢复） */
  const autoCollapsedRef = useRef(false);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;

  /** 顶栏开关：手动切换即接管（自动收起标记清除，后续 resize 不再干预） */
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => !c);
    autoCollapsedRef.current = false;
  }, []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [claudeOk, setClaudeOk] = useState<boolean | null>(null);
  const [closeAction, setCloseAction] = useState<CloseAction>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  // ---------- 供应商切换 ----------
  const [providerState, setProviderState] = useState<ProviderListState | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  // ---------- 会话管理 ----------
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [sessionsByKey, setSessionsByKey] = useState<
    Record<string, SessionInfo[] | null | undefined>
  >({});
  /** 置顶清单（config 真源，顺序即展示顺序） */
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>([]);
  /** 置顶区展示数据：后端按清单实时解析的元数据（文件缺失的条目会被后端跳过） */
  const [pinnedMeta, setPinnedMeta] = useState<PinnedSessionInfo[]>([]);
  const [renameTarget, setRenameTarget] = useState<{
    session: SessionInfo;
    key: string;
  } | null>(null);
  /** 会话行右键菜单（终端继续/重命名/置顶/删除） */
  const [sessionMenu, setSessionMenu] = useState<{
    x: number;
    y: number;
    key: string;
    session: SessionInfo;
  } | null>(null);
  // ---------- 内容区 tab（页面对话 + 内嵌终端，多会话并行） ----------
  const [tabs, setTabs] = useState<ContentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** 终端 tab 的忙/闲探针（TerminalPane 挂载时注册）：**右键那一刻现算**，不缓存、不轮询。
   *  轮询+只在变化时上报会留下陈旧快照（挂载后 1s 那次探测看到的是还没画完的空屏）。 */
  const tabProbesRef = useRef(new Map<string, () => TabActivity>());
  /** 两种 tab 共用的"就地击杀"句柄（TerminalPane / ChatView 挂载时注册）：删除会话时
   *  先 await 它拿到「进程确实已退出」的时刻再动会话文件（终端 = pty 杀树跑完，
   *  对话 = chat_close 优雅退出 / 超时强杀）。卸载路径的 kill 是 fire-and-forget，等不到。 */
  const tabKillersRef = useRef(new Map<string, () => Promise<void>>());
  /** tab 清单的镜像：关闭/接管这类在**异步间隙**执行的操作从它取最新列表（闭包里
   *  的 tabs 可能已被期间的其他更新换掉）。
   *
   *  ⚠️ **它只由 updateTabs 写**——既不在渲染体里赋值，也不用 effect 从 state 回灌。
   *  后者看着更「规范」（渲染期写 ref 确是 React 明列的反模式），实际是**倒退**：
   *  updateTabs 把本 ref 当权威源（`fn(tabsRef.current)` 的结果同时写 ref 与 state），
   *  再挂一个「state → ref」的同步，ref 就能被一条**闭包捕获了旧 tabs 的陈旧 effect**
   *  写回旧数组。真机上踩过（现象：点「关闭其他」，toast 说关了 3 个、界面一个没少），
   *  成因链是：某 tab 的状态更新让 tabs 变了（同步 effect 还在排队）→ 用户点关闭 →
   *  removeTabs 正确写入新列表 → 排队的陈旧 effect 落地把 ref 倒回旧数组 → 剩下的 tab
   *  重渲染时经 updateChatPhase 调 updateTabs，从**倒回的 ref** 算出列表 → 关掉的复活。
   *  （那条重渲染由 onStatusChange 内联箭头触发，已在 ChatView 侧一并改用 ref 上报。）
   *
   *  只让 updateTabs 写，ref 就只前进：它表示「最近一次要求 React 渲染的清单」，
   *  比「已提交的 state」更新（同一 tick 内连续更新必须基于前一次结果），
   *  且不会被任何渲染或陈旧 effect 回滚。 */
  const tabsRef = useRef(tabs);
  /** 唯一的清单更新入口：ref 先行、state 随后（两个视图永不脱节） */
  const updateTabs = useCallback((fn: (prev: ContentTab[]) => ContentTab[]) => {
    const next = fn(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
  }, []);
  const tabSeqRef = useRef(0);
  const newChatTabId = () => `chat-${++tabSeqRef.current}`;
  const newTermTabId = () => `term-${++tabSeqRef.current}`;
  /** 新开内容 tab 的默认交互方式（项目行「+」/点会话行用哪种；两种 tab 始终共存） */
  const [defaultInteraction, setDefaultInteraction] = useState<"chat" | "terminal">("chat");
  const closeActionRef = useRef<CloseAction>(null);
  closeActionRef.current = closeAction;

  // ---------- 关闭窗口行为 ----------

  // 拦截关闭：minimize → 隐藏到托盘；null（未设置）→ 弹窗询问；quit → 直接退出
  useEffect(() => {
    // 主进程拦截 close 后转发 window:close-requested，这里按当前设置分发
    // （Electron 侧已经 preventDefault，渲染层只需决定「怎么办」）
    return api.onCloseRequested(async () => {
      const action = closeActionRef.current;
      if (action === "quit") {
        // 显式销毁窗口（绕过关闭拦截，避免事件循环）
        await api.destroyWindow();
        return;
      }
      if (action === "minimize") {
        await api.hideWindow();
      } else {
        setCloseChoiceOpen(true);
      }
    });
  }, []);

  // ---------- 内容区 tab 基础操作（对话 + 终端共用） ----------

  /** 关掉若干 tab 后决定"接下来显示谁"，然后统一移除。
   *  规则（浏览器/终端的通行行为，移植自 Tauri 线）：
   *  ① 当前激活的 tab 没被关 → 不动；
   *  ② 被关了 → 优先 preferId（"关闭其他"传右键那个 tab）；
   *  ③ 再退化到"剩下里的最后一个"——"关闭所有"时会落到那个还在干活、没被关的会话上，
   *     不会一律回落到空态；
   *  ④ 一个都不剩 → null（空态）。
   *  接管 tab 从 ref 的最新列表里挑（见 tabsRef / updateTabs 注释）：ref 里含本 tick
   *  内刚 append 的 tab，连续两次关闭也不会按同一份旧数组互相覆盖。 */
  const removeTabs = useCallback(
    (ids: string[], preferId: string | null = null) => {
      const gone = new Set(ids);
      const rest = tabsRef.current.filter((t) => !gone.has(t.id));
      updateTabs(() => rest);
      setActiveTabId((cur) => {
        if (cur === null) return null;
        if (!gone.has(cur)) return cur;
        if (preferId && !gone.has(preferId)) return preferId;
        return rest.length > 0 ? rest[rest.length - 1].id : null;
      });
    },
    [updateTabs],
  );

  /** 挂着某个会话的终端 tab：续聊 tab 认 resumeSessionId、新会话 tab 认 newSessionId
   *  （都是传给 claude 的那个 uuid，与 SessionInfo.sessionId 同一套 id）。 */
  const termTabsForSession = useCallback(
    (sessionId: string) =>
      tabsRef.current.filter(
        (t): t is ContentTab & { kind: "term" } =>
          t.kind === "term" &&
          (t.resumeSessionId === sessionId || t.newSessionId === sessionId),
      ),
    [],
  );

  /** 同一会话是否已开在**另一种**交互方式的 tab 里？返回那个 tab（没有则 null）。
   *
   *  为什么必须跨 kind 查：两条开 tab 的路各自只在自己的 kind 里查重——对话 tab 按
   *  `session.file` 查，终端 tab 按 `resumeSessionId`/`newSessionId` 查。于是同一会话
   *  先开终端、再从会话行右键「在页面对话中继续」，会起**第二个** claude 进程
   *  `--resume` 同一份 jsonl：两边交错追加，历史分叉（正是「同一会话不允许开两个
   *  进程」要防的事，原来只是防不住跨 kind 这一路）。
   *  已退出的 tab（终端 status==="exited"、对话 phase==="exited"）两边都不算冲突：
   *  进程没了就争不了文件。对话侧这条尤其要紧——已退出的对话 tab 是发不出消息的
   *  （send 对 exited 直接 return），把它当冲突只会把用户送上一个死 tab。
   *  新对话 tab 收编前 `session` 为 null、也没有 jsonl，自然不参与匹配。 */
  const conflictingTabForSession = useCallback(
    (sessionId: string, wanted: "chat" | "term"): ContentTab | null => {
      for (const t of tabsRef.current) {
        if (t.kind === wanted) continue; // 同 kind 交给调用方各自的去重逻辑
        if (t.kind === "term") {
          if (t.status === "exited") continue;
          if (t.resumeSessionId === sessionId || t.newSessionId === sessionId) return t;
        } else {
          if (t.phase === "exited") continue;
          // 只读会话页不算冲突：它只读 jsonl，不起进程、不写文件（想转成可发言时
          // 由「继续对话」按钮再拦一次，见 continueBlockedReason）
          if (t.readOnly) continue;
          if (t.session && sessionIdFromFile(t.session.file) === sessionId) return t;
        }
      }
      return null;
    },
    [],
  );

  /** 挂着某个会话的**所有** tab（两种 kind）：终端按会话 id（resumeSessionId /
   *  预生成的 newSessionId），对话按 jsonl 路径反查出的会话 id。删除会话要把它们
   *  全部关掉——只查终端那一半的话，对话 tab（尤其只读页）会留着继续指一份
   *  已被移走的文件。未收编的新对话 tab `session` 为 null，天然不匹配。 */
  const tabsForSession = useCallback((sessionId: string): ContentTab[] => {
    return tabsRef.current.filter((t) => {
      if (t.kind === "term") {
        return t.resumeSessionId === sessionId || t.newSessionId === sessionId;
      }
      if (!t.session) return false;
      return sessionIdFromFile(t.session.file) === sessionId;
    });
  }, []);

  /** 单个 tab 关闭后的接管者：右邻优先、退化左邻（浏览器惯例） */
  const neighborTabId = useCallback((id: string) => {
    const list = tabsRef.current;
    const i = list.findIndex((t) => t.id === id);
    return i < 0 ? null : (list[i + 1]?.id ?? list[i - 1]?.id ?? null);
  }, []);

  /** 终端 tab 能否安全关闭：进程已结束，或探针判为"空闲"。busy / unknown 一律不关——
   *  关 tab = 卸载终端 = kill 进程，误杀在跑的会话代价远大于漏关几个 tab。
   *  status 是 starting 还是 running 不参与判断：刚开的会话本来就该能关（也还没干过活）。
   *  （对话 tab 的同款判断是 isBusyPhase，两条判据各自的口径原样保留。） */
  const termTabClosable = useCallback(
    (t: TerminalTab, activity: Record<string, TabActivity>) =>
      t.status === "exited" || activity[t.id] === "idle",
    [],
  );

  /** 某个 tab 此刻能否安全关闭（关 = 结束其进程；对话的 thinking/starting 与
   *  终端的 busy/unknown 同为"在跑"，宁可漏关不可误杀）。activity 为空时只按
   *  对话 phase / 终端 status 判断（终端探针结果由调用方现算注入）。 */
  const tabClosableNow = useCallback(
    (t: ContentTab, activity: Record<string, TabActivity>): boolean => {
      if (t.kind === "chat") return !isBusyPhase(t.phase);
      return termTabClosable(t, activity);
    },
    [termTabClosable],
  );

  // ---------- Toast ----------

  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((msg: string, duration = 2500) => {
    // 清掉上一个计时器：否则连续 toast 时，前一条的定时器会提前清掉后一条
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, duration);
  }, []);

  const handleCloseChoice = useCallback(
    async (action: "quit" | "minimize", remember: boolean) => {
      setCloseChoiceOpen(false);
      if (remember) {
        // 先落盘再改内存态：写失败时内存不领先磁盘
        try {
          await api.saveConfig(order, pinnedSessions, projectDirs, excludedDirs, dark, action, defaultInteraction);
        } catch (e) {
          // 失败必须留在窗口内报错：窗口一隐藏/退出，提示再没机会被看到，
          // 用户会以为选择已记住。保持打开，可重试或去掉「记住」再关。
          showToast("保存关闭行为失败：" + String(e));
          return;
        }
        setCloseAction(action);
      }
      if (action === "minimize") {
        await api.hideWindow();
      } else {
        await api.quitApp();
      }
    },
    [order, pinnedSessions, projectDirs, excludedDirs, dark, defaultInteraction, showToast],
  );

  // ---------- 数据加载 ----------

  /** load 竞态守卫：上一次 load 的回包可能晚于本次，过期结果不得覆盖新状态 */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const [list, cfg] = await Promise.all([api.listProjects(), api.loadConfig()]);
      if (seq !== loadSeqRef.current) return;
      setItems(list);
      setOrder(cfg.order ?? []);
      setPinnedSessions(cfg.pinnedSessions ?? []);
      setProjectDirs(cfg.projects ?? []);
      setExcludedDirs(cfg.excluded ?? []);
      setDark(cfg.dark ?? false);
      setCloseAction(cfg.closeAction ?? null);
      setDefaultInteraction(cfg.defaultInteraction ?? "chat");
      // 选中项可能已被删除，清理
      setSelectedKey((k) => (k && list.some((l) => l.key === k) ? k : null));
    } catch (e) {
      showToast("加载失败：" + String(e));
    }
  }, [showToast]);

  /** 重新拉取置顶区数据（置顶/取消、重命名、删除、回收站恢复或清空后调用）。
   *  后端按 config 清单实时解析元数据，已不存在的会话文件会被跳过。 */
  const refreshPinned = useCallback(async () => {
    try {
      setPinnedMeta(await api.listPinnedSessions());
    } catch {
      // 拉取失败不打断主流程，置顶区保持上一次结果
    }
  }, []);

  useEffect(() => {
    load();
    refreshPinned();
    api.checkClaude().then(setClaudeOk).catch(() => setClaudeOk(false));
    // 供应商清单（首次调用会把 live 配置收编为 default 供应商）；失败不阻塞主流程
    api.providerList().then(setProviderState).catch(() => {});
    // 安装模式首次启动：提示数据目录位置（config/台账/回收站实际存储处）
    api
      .getDataRoot()
      .then((info) => {
        if (info.installMode && !localStorage.getItem("cf-data-tip")) {
          localStorage.setItem("cf-data-tip", "1");
          showToast(`数据目录：${info.path}（项目清单与置顶会话保存在此）`, 5000);
        }
      })
      .catch(() => {});
  }, [load, refreshPinned]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  // ---------- 配置持久化 / 主题 ----------
  const persistConfig = useCallback(
    async (
      ord: string[],
      pins: PinnedSession[],
      d: boolean,
      ca?: CloseAction,
      di?: "chat" | "terminal",
    ): Promise<boolean> => {
      try {
        await api.saveConfig(
          ord,
          pins,
          projectDirs,
          excludedDirs,
          d,
          ca === undefined ? closeAction : ca,
          di === undefined ? defaultInteraction : di,
        );
        return true;
      } catch (e) {
        showToast("保存配置失败：" + String(e));
        return false;
      }
    },
    [showToast, closeAction, defaultInteraction, projectDirs, excludedDirs],
  );

  const toggleTheme = useCallback(async () => {
    const next = !dark;
    setDark(next);
    await persistConfig(order, pinnedSessions, next);
  }, [dark, order, pinnedSessions, persistConfig]);

  // ---------- 列表派生数据 ----------

  /** 当前整条项目序列：order 收录项 + 其余按名称追加在后。
   *  这样「拖一次」之后所有项目都有显式顺序，之后的排序不受名称影响。 */
  const fullOrder = useCallback(() => {
    const known = new Set(order);
    return [
      ...order,
      ...items
        .filter((l) => !known.has(l.key))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
        .map((l) => l.key),
    ];
  }, [order, items]);

  /** 全局拖拽排序：把 draggedKey 插到 targetKey 之前/之后，整表落盘 */
  const reorder = useCallback(
    async (draggedKey: string, targetKey: string, before: boolean) => {
      if (draggedKey === targetKey) return;
      const base = fullOrder();
      if (!base.includes(draggedKey) || !base.includes(targetKey)) return;
      const next = base.filter((k) => k !== draggedKey);
      const to = next.indexOf(targetKey);
      next.splice(before ? to : to + 1, 0, draggedKey);
      if (next.every((k, i) => k === base[i])) return; // 位置未变，免写盘
      setOrder(next);
      await persistConfig(next, pinnedSessions, dark);
    },
    [fullOrder, pinnedSessions, dark, persistConfig],
  );

  /** 右键「移到最前」：与拖拽同一套全序列语义，省去从列表底部拖到顶部 */
  const moveTop = useCallback(
    async (l: Project) => {
      const base = fullOrder();
      if (!base.includes(l.key)) return;
      if (base[0] === l.key) {
        showToast(`${l.name} 已经在最前`);
        return;
      }
      const next = [l.key, ...base.filter((k) => k !== l.key)];
      setOrder(next);
      await persistConfig(next, pinnedSessions, dark);
      showToast(`已把 ${l.name} 移到最前`);
    },
    [fullOrder, pinnedSessions, dark, persistConfig, showToast],
  );

  // ---------- 会话置顶（全局聚合区） ----------

  const pinnedFiles = useMemo(
    () => new Set(pinnedSessions.map((p) => p.file)),
    [pinnedSessions],
  );

  /** 置顶 / 取消置顶。新置顶插在最前（置顶区不支持拖拽排序，顺序即置顶时间倒序） */
  const togglePin = useCallback(
    async (projectPath: string, session: SessionInfo) => {
      const pinned = pinnedSessions.some((p) => p.file === session.file);
      const next = pinned
        ? pinnedSessions.filter((p) => p.file !== session.file)
        : [{ file: session.file, projectPath }, ...pinnedSessions];
      setPinnedSessions(next);
      if (pinned) {
        // 立刻从置顶区移除，避免等待后端往返
        setPinnedMeta((prev) => prev.filter((s) => s.file !== session.file));
      }
      if (!(await persistConfig(order, next, dark))) {
        // 落盘失败必须回滚：否则该会话被 pinnedFiles 从项目列表滤掉、又不在置顶区，
        // 等于凭空消失。回到磁盘实际状态即可。
        setPinnedSessions(pinnedSessions);
        await refreshPinned();
        return;
      }
      await refreshPinned();
      showToast(pinned ? "已取消置顶" : "已置顶（见顶部置顶会话）");
    },
    [pinnedSessions, order, dark, persistConfig, refreshPinned, showToast],
  );

  // ---------- 列表派生数据 ----------

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = items.filter(
      (l) =>
        !q ||
        l.name.toLowerCase().includes(q) ||
        l.path.toLowerCase().includes(q),
    );
    // 按 order 数组顺序渲染（未收录的新项目按名称追加在后）
    const byKey = new Map(filtered.map((l) => [l.key, l]));
    const knownKeys = new Set(order);
    const known = order
      .map((k) => byKey.get(k))
      .filter((l): l is Project => !!l);
    const rest = filtered
      .filter((l) => !knownKeys.has(l.key))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    return [...known, ...rest];
  }, [items, order, search]);

  const missing = items.filter((l) => l.healthy === false);

  // ---------- 搜索 ----------

  /** 顶栏「搜索」按钮：展开左栏搜索框并聚焦；再次点击收起并清空关键词 */
  const toggleSearch = useCallback(() => {
    if (searchOpen) setSearch("");
    setSearchOpen(!searchOpen);
  }, [searchOpen]);

  // ---------- 操作 ----------

  const launch = useCallback(
    async (key: string) => {
      const l = items.find((x) => x.key === key);
      if (!l) return;
      if (l.healthy === false) {
        showToast(`目录不存在，无法启动：${l.path}`);
        return;
      }
      try {
        await api.launchProject(l.path);
      } catch (e) {
        showToast("启动失败：" + String(e));
      }
    },
    [items, showToast],
  );

  const openFolder = useCallback(
    async (l: Project) => {
      if (!l.path) return;
      try {
        await api.openFolder(l.path);
      } catch (e) {
        showToast("打开文件夹失败：" + String(e));
      }
    },
    [showToast],
  );

  const copyPath = useCallback(
    async (l: Project) => {
      if (!l.path) return;
      try {
        await navigator.clipboard.writeText(l.path);
        showToast("路径已复制到剪贴板");
      } catch {
        showToast("复制失败");
      }
    },
    [showToast],
  );

  const removeProject = useCallback(
    async (l: Project) => {
      try {
        await api.removeProject(l.path);
      } catch (e) {
        showToast("移除失败：" + String(e));
        return;
      }
      // 排序去该项目、撤该项目置顶会话都由后端 remove_project 持久化完成，
      // 此处严禁再用本地（过期）projectDirs/excludedDirs 走 persistConfig——
      // 会把后端刚写入的排除清单覆盖回旧值，导致被移除的项目被扫描加回来。
      // load() 会从磁盘带回新的 order / pinnedSessions / excluded。
      // 展开态/会话缓存/该项目已打开的对话 tab 也要清：重新添加同一路径时不带旧数据复活
      setExpandedKey((k) => (k === l.key ? null : k));
      setSessionsByKey((prev) => {
        if (!(l.key in prev)) return prev;
        const next = { ...prev };
        delete next[l.key];
        return next;
      });
      // 该项目的对话/终端 tab 直接移除（ChatView unmount 优雅关闭托管进程、
      // TerminalPane unmount kill 终端进程树），激活相邻 tab
      const removedIds = new Set(
        tabsRef.current
          .filter((t) => (t.kind === "chat" ? t.key === l.key : t.projectPath === l.path))
          .map((t) => t.id),
      );
      if (removedIds.size > 0) {
        removeTabs([...removedIds]);
      }
      await refreshPinned();
      await load();
      showToast(`已从列表移除 ${l.name}`);
    },
    [refreshPinned, load, showToast, removeTabs],
  );

  const confirmRemove = useCallback(
    (l: Project) => {
      setConfirm({
        title: "从列表移除项目",
        message: `将从列表移除以下项目：\n\n${l.name}\n${l.path}\n\n（不会删除磁盘上的项目文件）\n继续？`,
        okText: "移除",
        danger: true,
        onOk: () => removeProject(l),
      });
    },
    [removeProject],
  );

  // ---------- 会话管理 ----------

  const toggleExpand = useCallback(
    async (key: string) => {
      if (expandedKey === key) {
        setExpandedKey(null);
        return;
      }
      setExpandedKey(key);
      const l = items.find((x) => x.key === key);
      if (!l?.path) {
        showToast("该项目未解析到路径，无法读取会话");
        return;
      }
      setSessionsByKey((prev) => ({ ...prev, [key]: null })); // 加载中
      try {
        const list = await api.listSessions(l.path);
        setSessionsByKey((prev) => ({ ...prev, [key]: list }));
      } catch (e) {
        setSessionsByKey((prev) => ({ ...prev, [key]: [] }));
        showToast("加载会话失败：" + String(e));
      }
    },
    [expandedKey, items, showToast],
  );

  const renameSession = useCallback(
    async (newTitle: string) => {
      if (!renameTarget) return;
      const { session, key } = renameTarget;
      await api.renameSession(session.file, newTitle); // 失败时向上抛给对话框显示
      setRenameTarget(null);
      // 该会话已开着对话 tab 时同步 tab 标题与其 session，否则标签/头部停留在旧标题。
      // 终端 tab 不用同步：claude 的 /rename 会改写 OSC 终端标题，onTitle 那条路自动跟上
      updateTabs((prev) =>
        prev.map((c) => {
          if (c.kind !== "chat" || !c.session || c.session.file !== session.file) return c;
          return { ...c, session: { ...c.session, title: newTitle }, title: newTitle };
        }),
      );
      // 重命名后刷新该项目会话列表（若仍处于展开状态）
      if (expandedKey === key) {
        const l = items.find((x) => x.key === key);
        if (l?.path) {
          const list = await api.listSessions(l.path).catch(() => null);
          if (list) setSessionsByKey((prev) => ({ ...prev, [key]: list }));
        }
      }
      await refreshPinned(); // 置顶区标题同步
      showToast("已重命名");
    },
    [renameTarget, expandedKey, items, refreshPinned, showToast],
  );

  const refreshSessions = useCallback(
    async (key: string) => {
      const l = items.find((x) => x.key === key);
      if (!l?.path) return;
      const list = await api.listSessions(l.path).catch(() => null);
      if (list) setSessionsByKey((prev) => ({ ...prev, [key]: list }));
    },
    [items],
  );

  /** 最新 items / refreshSessions 的 ref 镜像：落盘升级、标题回填这类异步回调从
   *  ref 取最新版，不进 effect 依赖（items 随清单/健康检查回包频繁换新，跟着
   *  重订阅会反复重置轮询定时器） */
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const refreshSessionsRef = useRef(refreshSessions);
  refreshSessionsRef.current = refreshSessions;
  /** 按项目路径刷新左栏会话列表：新会话落盘后让它直接出现（不用折叠再展开） */
  const refreshSessionsForPath = useCallback((projectPath: string) => {
    const l = itemsRef.current.find((x) => x.path === projectPath);
    if (l) void refreshSessionsRef.current(l.key);
  }, []);

  /** app 内新对话落盘升级（ChatView 首轮结束后回传）：把「无会话」的新对话 tab
   *  升级成续聊态——会话文件挂上 tab 后，头部统计与右上角按钮（搜索/变更文件/
   *  导出/刷新）随之可用；左栏会话列表立即补上这条新会话。顺带修复隐性问题：
   *  升级前点左栏同名会话会另开一个进程续写同一份 jsonl，升级后按 file 去重只激活
   *  已有 tab。
   *  ⚠️ **标题**：`meta.titleFromPrompt` 为真 = jsonl 里还只有「首条用户消息」那档兜底
   *  （CLI 起的名字还在路上），这时**不采纳**它——tab 名保持原样（新对话 tab 是项目名），
   *  等 CLI 起的名字到了由 applyChatTitle 落到 tab 名上。不这么做的话：标题会先变成一整条
   *  首条消息、两三秒后再被替换（2026-09-22 用户实测反馈）。`session.title` 仍记兜底那档
   *  （它就是此刻 jsonl 的真名，列表里显示的也是它），二者都是临时的。 */
  const adoptChatSession = useCallback(
    (tabId: string, meta: { file: string; title: string; titleFromPrompt: boolean }) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "chat" || tab.session) return;
      const sessionId = sessionIdFromFile(meta.file);
      if (sessionId === null) return; // 后端给的不是会话文件：不升级，保持新对话态
      updateTabs((prev) =>
        prev.map((t) =>
          t.kind === "chat" && t.id === tabId && !t.session
            ? {
                ...t,
                title: meta.titleFromPrompt ? t.title : meta.title,
                session: {
                  sessionId,
                  title: meta.title,
                  summary: "",
                  lastModified: Date.now(),
                  file: meta.file,
                },
              }
            : t,
        ),
      );
      refreshSessions(tab.key);
    },
    [updateTabs, refreshSessions],
  );

  /** 新会话的 AI 标题到位（后端向 CLI 要来的，已落进 jsonl）：tab 名与左栏那条一起换。
   *  · 未收编（`tab.session` 为 null）时什么都不做：此刻它还没有会话文件，收编轮询下一次
   *    tick 读到的就是刚落盘的 ai-title，收编带的标题本来就是它——两条时序都收敛。
   *  · 标题没变就不 setState（与 setTabTitle 同口径：避免无谓重渲染 + 列表重读）。 */
  const applyChatTitle = useCallback(
    (tabId: string, title: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "chat" || !tab.session) return;
      if (tab.title === title && tab.session.title === title) return;
      updateTabs((prev) =>
        prev.map((t) =>
          t.id === tabId && t.kind === "chat" && t.session
            ? { ...t, title, session: { ...t.session, title } }
            : t,
        ),
      );
      refreshSessionsForPath(tab.projectPath);
    },
    [updateTabs, refreshSessionsForPath],
  );

  // ---------- 窗口过窄自动收起左栏 ----------

  // 订阅一次、回调经 ref 取最新收起态；80ms 防抖让拖拽过程中只在停顿时落定。
  // 挂载即检一次（窗口可能一开始就窄）
  useEffect(() => {
    let timer: number | undefined;
    const apply = () => {
      const w = window.innerWidth;
      if (w < SIDEBAR_COLLAPSE_BELOW && !sidebarCollapsedRef.current) {
        autoCollapsedRef.current = true;
        setSidebarCollapsed(true);
      } else if (w > SIDEBAR_EXPAND_ABOVE && sidebarCollapsedRef.current && autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setSidebarCollapsed(false);
      }
    };
    const onResize = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(apply, 80);
    };
    apply();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // ---------- 窗口聚焦自动刷新 ----------

  /** 刷新当前展开项目的会话列表 + 置顶区展示元数据（窗口聚焦 / 回收站变更的公共部分） */
  const refreshVisibleLists = useCallback(() => {
    if (expandedKey) refreshSessions(expandedKey);
    void refreshPinned();
  }, [expandedKey, refreshSessions, refreshPinned]);

  /** 重新读盘同步**置顶清单真源**（config.pinnedSessions）。
   *  必要性：彻底删除会话时后端 `prune_dead_pins` 直接改磁盘 config，而内存里的
   *  `pinnedSessions` 是下次 `persistConfig` 的真源——不重新读盘，之后任意一次
   *  保存（切主题/拖拽排序/置顶取消/保存设置）都会把已清掉的死条目写回
   *  config.json，与后端 prune 形成「清了又回」。删除失效项目数据的路径同理
   *  （后端 `drop_pins_for_projects`）。
   *  注意 `refreshPinned` 只刷置顶区**展示元数据**（pinnedMeta），不碰真源清单，
   *  两者不能互相替代。 */
  const syncPinsFromConfig = useCallback(async () => {
    try {
      const cfg = await api.loadConfig();
      setPinnedSessions(cfg.pinnedSessions ?? []);
    } catch {
      // 读盘失败就保持现有清单，不打断回收站/清理操作
    }
  }, []);

  /** 回收站操作后的刷新：会话列表 + 置顶区 + 置顶清单真源（恢复会让被保留的
   *  条目复活，彻底删除会让后端把死条目从磁盘清掉） */
  const refreshAfterTrashChange = useCallback(() => {
    refreshVisibleLists();
    void syncPinsFromConfig();
  }, [refreshVisibleLists, syncPinsFromConfig]);

  // 终端里跑完 claude 回到 app：聚焦时刷新上面两处（新会话/新标题回来即见）。
  // 查看器内容不自动重载——正在阅读的会话被追加内容会把滚动位置拽走，
  // 保持过期优于打扰阅读（查看器自带刷新按钮）。
  // 订阅一次、回调走 latest-ref：refreshSessions 随 items 变化，若放进 deps
  // 会在每次清单/健康检查回填后重订阅（两次 IPC）且节流窗口被重置；
  // 1.5s 节流防 alt-tab 抖动连刷。at 初值取订阅时刻，挡掉挂载后 1.5s 内到达的
  // 聚焦事件——Electron 侧只在窗口 focus 时才发 window:focused（订阅时不回调），
  // 所以这里挡的是启动后紧接着的真实聚焦；此时 expandedKey 恒为 null，
  // 唯一可能重复的只有挂载 effect 已拉过一次的 refreshPinned()，无实际损失。
  const visibleListsRef = useRef({ refresh: refreshVisibleLists, at: 0 });
  useEffect(() => {
    visibleListsRef.current.refresh = refreshVisibleLists;
  });
  useEffect(() => {
    visibleListsRef.current.at = Date.now();
    return api.onFocusChanged(() => {
      const now = Date.now();
      if (now - visibleListsRef.current.at < 1500) return;
      visibleListsRef.current.at = now;
      visibleListsRef.current.refresh();
    });
  }, []);

  const deleteSession = useCallback(
    async (key: string, session: SessionInfo) => {
      // 这个会话还开在内嵌终端里 → **先结束进程、再删文件**，不能反序：
      // ① 反序会在两者之间漏掉 claude 最后追加的一条消息（回收站里的备份不完整）；
      // ② 仍在写的 claude 会让删除静默失效——要么把移走的文件继续写进回收站那份，
      //    要么在原路径重新建出来（会话在列表里"自己回来"）。
      // 不能靠卸载路径（removeTabs → TerminalPane cleanup）的 kill：那是
      // fire-and-forget，这里要的是"进程树确实杀完"的时刻，走 killers 注册表显式 await。
      const attached = tabsForSession(session.sessionId);
      await Promise.all(
        attached.map((t) => {
          // 已结束的终端 tab 不必再杀（pid 可能已被回收）；只读页没有进程，
          // killer 本就是空操作
          if (t.kind === "term" && t.status === "exited") return Promise.resolve();
          return tabKillersRef.current.get(t.id)?.() ?? Promise.resolve();
        }),
      );
      // 已结束的死 tab 同样收掉：文件都没了，留着只是"指向不存在会话"的孤儿
      if (attached.length > 0) removeTabs(attached.map((t) => t.id));
      try {
        await api.deleteSession(session.file);
        await refreshSessions(key);
        // 置顶条目**保留**（后端亦然）：文件只是进了回收站，恢复回原路径即自动复活，
        // 此处重拉后该会话因文件缺失暂时从置顶区消失
        await refreshPinned();
        showToast(`已删除「${session.title}」，可在回收站恢复`);
      } catch (e) {
        showToast("删除失败：" + String(e));
      }
    },
    [refreshSessions, refreshPinned, showToast, tabsForSession, removeTabs],
  );

  const confirmDeleteSession = useCallback(
    (key: string, session: SessionInfo) => {
      // 这个会话还开在 tab 里时，确认框必须说清"连带关掉它们"（关 = 结束 claude 进程）。
      // 两种 kind 都算：早先只查终端 tab，于是对话 tab（尤其只读页）会留在那里继续
      // 指着一份已被移走的文件。
      const attached = tabsForSession(session.sessionId);
      const kinds = [
        attached.some((t) => t.kind === "term") ? "内嵌终端" : null,
        attached.some((t) => t.kind === "chat") ? "对话" : null,
      ]
        .filter(Boolean)
        .join(" / ");
      // 忙/闲**就在点删除这一刻现算**（与 openTabMenu 同一套）：缓存快照会骗人。
      // 终端探针 unknown 按忙处理，口径与 tabClosableNow 一致（宁可说得重一点，
      // 不可轻描淡写）；对话 tab 按 phase 判（thinking/starting 就是在干活）
      const busy =
        attached.some(
          (t) =>
            t.kind === "term" &&
            t.status !== "exited" &&
            (tabProbesRef.current.get(t.id)?.() ?? "unknown") !== "idle",
        ) || attached.some((t) => t.kind === "chat" && isBusyPhase(t.phase));
      const tail =
        attached.length === 0
          ? ""
          : `\n\n该会话还开在 ${kinds} tab 里，删除将一并关闭。` +
            (busy ? "\nclaude 正在干活，这一轮会被中断。" : "");
      setConfirm({
        title: "删除会话",
        message:
          `将删除会话：\n\n「${session.title}」\n\n删除后移入回收站（可恢复），继续？` + tail,
        okText: "删除",
        danger: true,
        onOk: () => deleteSession(key, session),
      });
    },
    [deleteSession, tabsForSession],
  );

  const resumeSession = useCallback(
    async (key: string, session: SessionInfo) => {
      const launcher = items.find((x) => x.key === key);
      try {
        // key 本身即项目绝对路径，items 里查不到（项目已不在列表）时用 key 兜底
        await api.resumeSession(session.file, launcher?.path ?? key);
        showToast(`已打开「${session.title}」的继续对话窗口`);
      } catch (e) {
        showToast("启动失败：" + String(e));
      }
    },
    [items, showToast],
  );

  // ---------- 内容区 tab：开 / 关 / 标题（对话 + 终端） ----------

  /** 打开一个对话 tab（已存在同会话的 tab 则只激活）。
   *  id 必须在 updater 外生成、updater 保持纯函数——React（StrictMode 下）
   *  会多次调用 updater，在内部生成 id / 写外部变量会导致 activeTabId
   *  与 tab 实际 id 不一致（表现为第一个会话要点两次） */
  const openChatTab = useCallback(
    (tab: {
      projectPath: string;
      title: string;
      session: SessionInfo | null;
      key: string;
      readOnly?: boolean;
    }) => {
      // 续聊同一会话不允许开两个进程（会分叉历史），只激活已有 tab
      const dup = tab.session
        ? tabsRef.current.find(
            (c): c is ContentTab & { kind: "chat" } =>
              c.kind === "chat" && c.session?.file === tab.session!.file,
          )
        : undefined;
      if (dup) {
        setActiveTabId(dup.id);
        return;
      }
      // 同一会话已开在终端 tab 里（且进程还活着）→ 只激活它并说明，不起第二个进程。
      // **只读页不查**：它只读 jsonl，不起进程也不写文件，与终端 tab 并存无冲突
      //（起进程那道闸门在「继续对话」按钮与发送路径上）。
      const cross =
        tab.session && !tab.readOnly
          ? conflictingTabForSession(tab.session.sessionId, "chat")
          : null;
      if (cross) {
        setActiveTabId(cross.id);
        showToast("该会话已在终端 tab 中打开");
        return;
      }
      const id = newChatTabId();
      updateTabs((prev) => [...prev, { kind: "chat", id, phase: "idle", ...tab }]);
      setActiveTabId(id);
    },
    [conflictingTabForSession, showToast, updateTabs],
  );

  /** 打开一个内嵌终端 tab（移植自 Tauri 线 openTerminalTab）。
   *  同一会话已开过 tab → 直接激活，避免 --resume 同 id 双开。续聊 tab
   *  （resumeSessionId）与新会话 tab（newSessionId）都要认：新会话的 jsonl
   *  落盘后从右键「继续对话」进来就是同一个 uuid，漏掉它照样双开两个 claude
   *  进程交错写同一份会话文件。**只认还活着的**（exited 不算）：命中一个已退出
   *  的 tab 等于把用户送到死终端上（--resume 永远发不出去）；那种情况下照常新开
   *  一个——旧 tab 的进程已经没了，不会跟它争同一份 jsonl。 */
  const openTerminalTab = useCallback(
    (opts: { title: string; projectPath: string; resumeSessionId: string | null }) => {
      if (opts.resumeSessionId) {
        const dup = termTabsForSession(opts.resumeSessionId).find((t) => t.status !== "exited");
        if (dup) {
          setActiveTabId(dup.id);
          return;
        }
        // 同一会话已开在对话 tab 里 → 只激活它：再起个终端 --resume 同一份 jsonl
        // 就是两个进程交错写（与上面 openChatTab 里的跨 kind 检查互为镜像）
        const cross = conflictingTabForSession(opts.resumeSessionId, "term");
        if (cross) {
          setActiveTabId(cross.id);
          showToast("该会话已在对话 tab 中打开");
          return;
        }
      }
      const tab: ContentTab = {
        kind: "term",
        id: newTermTabId(),
        title: opts.title,
        projectPath: opts.projectPath,
        resumeSessionId: opts.resumeSessionId,
        // 新会话预生成会话 id（交给 claude 的 --session-id）：tab 一开出来就知道
        // 它对应哪个会话文件，会话名一落盘就能回填标题
        newSessionId: opts.resumeSessionId === null ? newSessionId() : null,
        status: "starting",
        exitCode: null,
      };
      updateTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    },
    [conflictingTabForSession, showToast, termTabsForSession, updateTabs],
  );

  /** 项目行「+」：按「默认交互方式」开新会话 tab（页面对话 / 内嵌终端）。
   *  app 内新建会话只有这一个入口（右键菜单只给系统终端那条路）。 */
  const startNewSessionTab = useCallback(
    (key: string) => {
      const l = items.find((x) => x.key === key);
      if (!l?.path) {
        showToast("该项目未解析到路径，无法新建会话");
        return;
      }
      if (l.healthy === false) {
        showToast(`目录不存在，无法新建会话：${l.path}`);
        return;
      }
      if (defaultInteraction === "terminal") {
        openTerminalTab({ title: l.name, projectPath: l.path, resumeSessionId: null });
      } else {
        openChatTab({ projectPath: l.path, title: l.name, session: null, key });
      }
    },
    [items, showToast, defaultInteraction, openTerminalTab, openChatTab],
  );

  /** 点会话行：打开**只读**会话页——不启动进程、不写 jsonl、不动会话时间。
   *  早先这里跟「默认交互方式」走：默认是内嵌终端时点一下就直接 --resume，
   *  于是「只想看看」的误触会改掉 mtime，把历史会话顶到列表最前。起会话一律
   *  要走显式入口：右键菜单（内嵌终端 / 系统终端）或页面上那颗「继续对话」。 */
  const continueSessionTab = useCallback(
    (key: string, session: SessionInfo) => {
      const l = items.find((x) => x.key === key);
      if (!l?.path) {
        showToast("该项目未解析到路径，无法查看会话");
        return;
      }
      openChatTab({
        projectPath: l.path,
        title: session.title,
        session,
        key,
        readOnly: true,
      });
    },
    [items, showToast, openChatTab],
  );

  /** 只读会话页点「继续对话」：**按「默认交互方式」继续**——与项目行「+」同一条口径
   *  （那边是新会话，这边是续聊，用的都是设置里选的那种方式）。
   *  - 页面对话：就地摘掉只读标记，输入框出现（仍懒启动，打字回车才 spawn）
   *  - 内嵌终端：开一个 --resume 的内嵌终端 tab，并收起这个只读页——「继续」就是从
   *    查看转到接着聊，两个 tab 指着同一份会话只会让人不知道看哪个
   *  （系统终端那条固定在右键菜单，不参与这里的分发。） */
  const continueReadOnlyTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "chat" || !tab.session) return;
      if (defaultInteraction === "terminal") {
        openTerminalTab({
          title: tab.session.title,
          projectPath: tab.projectPath,
          resumeSessionId: tab.session.sessionId,
        });
        removeTabs([tabId]);
        return;
      }
      updateTabs((prev) =>
        prev.map((t) => (t.kind === "chat" && t.id === tabId ? { ...t, readOnly: false } : t)),
      );
    },
    [defaultInteraction, openTerminalTab, removeTabs, updateTabs],
  );

  /** 「继续对话」此刻能不能用：同一会话若已跑在别的 tab（内嵌终端）里，从这里发言
   *  就会起第二个进程写同一份 jsonl——禁用并说明原因，关掉那个 tab 即恢复。 */
  const continueBlockedReason = useCallback(
    (sessionId: string): string | null => {
      const c = conflictingTabForSession(sessionId, "chat");
      if (!c) return null;
      return c.kind === "term"
        ? "该会话正开在内嵌终端 tab 里：先关掉它，才能从这里继续"
        : "该会话正开在另一个 tab 里：先关掉它，才能从这里继续";
    },
    [conflictingTabForSession],
  );

  /** 终端状态回传（TerminalPane：starting → running / exited） */
  const updateTabStatus = useCallback(
    (id: string, status: TerminalTab["status"], exitCode: number | null) => {
      updateTabs((prev) =>
        prev.map((t) =>
          t.kind === "term" && t.id === id ? { ...t, status, exitCode } : t,
        ),
      );
    },
    [updateTabs],
  );

  /** 对话状态回传（ChatView：idle/starting/thinking）——收在 tab 对象上 */
  const updateChatPhase = useCallback(
    (id: string, phase: string) => {
      // **phase 没变就返回原数组**（与 setTabTitle 同一考虑）：`prev.map` 每次都产出
      // 新数组，哪怕一个元素都没改，照样 setState 触发一轮渲染——上报方是内联回调，
      // 重渲染会让它重跑，不挡这一路就是「渲染 → 上报 → setState → 渲染」的自激圈。
      updateTabs((prev) => {
        const i = prev.findIndex((t) => t.kind === "chat" && t.id === id);
        const cur = i < 0 ? null : prev[i];
        if (!cur || cur.kind !== "chat" || cur.phase === phase) return prev;
        const next = prev.slice();
        next[i] = { ...cur, phase };
        return next;
      });
    },
    [updateTabs],
  );

  /** 改 tab 标题。**标题没变就不 setState**：claude 干活时每 ~960ms 用 ◐/◑ 重写一次
   *  OSC 标题，剥掉字形后内容完全相同，不挡住这一路会让整棵 tab 条跟着动画帧重渲染。 */
  const setTabTitle = useCallback(
    (id: string, title: string) => {
      updateTabs((prev) => {
        const i = prev.findIndex((t) => t.id === id);
        if (i < 0 || prev[i].title === title) return prev;
        const next = prev.slice();
        next[i] = { ...next[i], title };
        return next;
      });
    },
    [updateTabs],
  );

  /** 标题已定稿的终端 tab：定稿后不再让「会话文件兜底」插话（它读到的可能还是首条
   *  用户消息，比 claude 刚写出的 OSC 标题旧）。ref 给轮询里的同步判断用，
   *  state 用来重算待办清单。 */
  const titledRef = useRef<Set<string>>(new Set());
  const [titledIds, setTitledIds] = useState<string[]>([]);
  const markTitled = useCallback((id: string) => {
    if (titledRef.current.has(id)) return;
    titledRef.current.add(id);
    setTitledIds((prev) => [...prev, id]);
  }, []);

  /** 会话名回传（TerminalPane 的 onTitle：claude 写的 OSC 0 终端标题，已剥字形/滤噪声）。
   *  新会话 tab 开出来时标题是项目名（那会儿会话还没起名），claude 写出会话名后由这里
   *  换成真名字；`/rename` 也一样——定稿即收工，不再轮询会话文件。 */
  const updateTabTitle = useCallback(
    (id: string, title: string) => {
      setTabTitle(id, title);
      markTitled(id);
    },
    [setTabTitle, markTitled],
  );

  /** 待补标题的新会话终端 tab：会话 id 已知、进程还活着、标题还没定稿。
   *  为什么要补：claude 的 OSC 标题取 customTitle > aiTitle > "Claude Code"，
   *  **不带「首条用户消息」这一档**，而左栏列表的标题链是 customTitle > aiTitle >
   *  首条用户消息。于是没生成 aiTitle 的会话（Tauri 线实测 175 个里 10 个）OSC 只写
   *  兜底值、被 term-title.ts 滤掉，tab 就永远挂着项目名。这类会话只能回来读会话
   *  文件——文件在第一条消息之后才出现，所以是轮询。 */
  const pendingTitleTabs = tabs
    .filter(
      (t): t is ContentTab & { kind: "term" } =>
        t.kind === "term" && t.newSessionId !== null && t.status !== "exited" && !titledIds.includes(t.id),
    )
    .map((t) => ({ id: t.id, projectPath: t.projectPath, sessionId: t.newSessionId as string }));
  const pendingTitleKey = pendingTitleTabs.map((t) => t.id).join(",");
  // 轮询里取最新待办：清单随每次渲染重算，但 effect 不该跟着重订阅（那样每 3s 重建一次定时器）
  const pendingTitleRef = useRef(pendingTitleTabs);
  pendingTitleRef.current = pendingTitleTabs;

  // 标题补挂：每 3s 问一次「这个会话起名了吗」。文件没出现时后端只做一次 stat，
  // 代价可忽略；拿到标题即定稿停下（此后 claude 的 /rename 由 OSC 那条路跟）。
  useEffect(() => {
    if (pendingTitleKey === "") return;
    let disposed = false;
    const tick = async () => {
      for (const t of pendingTitleRef.current) {
        if (disposed || titledRef.current.has(t.id)) continue;
        try {
          const title = await api.sessionTitleFor(t.projectPath, t.sessionId);
          // 期间可能已被 OSC 定稿（或 tab 已关）：迟到结果不得覆盖更新的名字
          if (title !== null && !disposed && !titledRef.current.has(t.id)) {
            setTabTitle(t.id, title);
            markTitled(t.id);
            // 会话已落盘：左栏列表立即补上这条新会话（否则要折叠再展开才可见）
            refreshSessionsForPath(t.projectPath);
          }
        } catch {
          /* 读失败（瞬态）：下一轮再试 */
        }
      }
    };
    const timer = window.setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pendingTitleKey, setTabTitle, markTitled, refreshSessionsForPath]);

  /** 关单个 tab：终端的运行中先确认（关闭 = 结束 claude 进程树）；对话直接关
   *  （ChatView unmount 优雅关闭进程）。被关的是当前激活 tab 时接管到右/左邻。 */
  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const next = neighborTabId(tabId);
      if (tab.kind === "term" && tab.status !== "exited") {
        setConfirm({
          title: "关闭终端",
          message: `「${tab.title}」的 claude 会话仍在运行，关闭 tab 将结束该进程。继续？`,
          okText: "关闭",
          danger: true,
          onOk: () => removeTabs([tabId], next),
        });
        return;
      }
      if (tab.kind === "chat") void refreshSessions(tab.key);
      removeTabs([tabId], next);
    },
    [neighborTabId, removeTabs, refreshSessions],
  );

  /** tab 右键菜单打开时刻的**整份快照**：忙/闲（终端探针此刻现算，见 tabProbesRef
   *  注释）+ 由它算出的可关数量与跳过原因。
   *
   *  为什么要连计数一起冻结：菜单曾经自己重写一遍可关性规则、又拿**实时** tabs 配
   *  这份旧 activity 渲染，于是①同一套「能不能关」的判据散在 App 与菜单两处，改一处
   *  就漂移；②菜单开着时新开的 tab 不在 activity 里，计数与它实际要关的东西对不上。
   *  现在策略只在 App 一处，菜单退化成纯渲染。activity 仍留在状态里——
   *  closeTabsSafely 要拿它跟实际关闭动作对齐。 */
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string | null;
    activity: Record<string, TabActivity>;
    /** 右键命中的 tab 标题（null = 点在 tab 栏背景上）；菜单只拿它当标题显示 */
    title: string | null;
    /** 「关闭其他会话」会关掉几个；null = 没命中 tab，该项不渲染 */
    otherCount: number | null;
    /** 「关闭所有会话」会关掉几个 */
    allCount: number;
    /** 会被跳过（在跑/未识别）的会话数与原因分项 */
    skippedCount: number;
    why: string[];
  } | null>(null);

  /** 打开 tab 右键菜单：此刻对每个终端 tab 现算一次忙/闲，连同 tab 清单冻成快照 */
  const openTabMenu = useCallback(
    (e: React.MouseEvent, tabId: string | null) => {
      e.preventDefault();
      e.stopPropagation();
      const snapshot = tabsRef.current;
      const activity: Record<string, TabActivity> = {};
      for (const t of snapshot) {
        if (t.kind !== "term") continue;
        activity[t.id] = tabProbesRef.current.get(t.id)?.() ?? "unknown";
      }
      const kept = snapshot.filter((t) => !tabClosableNow(t, activity));
      // 分开写清楚「为什么没关」，否则只看得到 0、没法判断是探测问题还是真有在跑的。
      // 被跳过的对话 tab 必然是 busy（不是 busy 就会被关），无需再查 phase。
      // 终端探针只会给出 busy/idle/unknown 三态（unknown = 探针没读出来，按忙处理），
      // 没有「还没探测到」这一档——不要为它留分支：那需要 activity 缺键，而这份
      // activity 与 snapshot 出自同一次现算，键必然齐。
      const keptTerm = kept.filter(
        (t): t is ContentTab & { kind: "term" } => t.kind === "term",
      );
      const busyChat = kept.length - keptTerm.length;
      const busyTerm = keptTerm.filter((t) => activity[t.id] === "busy").length;
      const why: string[] = [];
      if (busyChat + busyTerm > 0) why.push(`${busyChat + busyTerm} 个干活中`);
      if (keptTerm.length - busyTerm > 0) why.push(`${keptTerm.length - busyTerm} 个没识别出空闲态`);
      const others = tabId ? snapshot.filter((t) => t.id !== tabId) : null;
      setTabMenu({
        x: e.clientX,
        y: e.clientY,
        tabId,
        activity,
        title: snapshot.find((t) => t.id === tabId)?.title ?? null,
        otherCount: others
          ? others.filter((t) => tabClosableNow(t, activity)).length
          : null,
        allCount: snapshot.length - kept.length,
        skippedCount: kept.length,
        why,
      });
    },
    [tabClosableNow],
  );

  /** 批量关 tab：只关 closable 的，其余跳过并如实报数（对话/终端同一套规则）。
   *  exceptId：保留哪一个（"关闭其他"传右键那个 tab 的 id；"关闭所有"传 null）。 */
  const closeTabsSafely = useCallback(
    (exceptId: string | null, activity: Record<string, TabActivity>) => {
      const targets = tabsRef.current.filter((t) => t.id !== exceptId);
      const closable = targets.filter((t) => tabClosableNow(t, activity));
      const kept = targets.length - closable.length;
      if (closable.length === 0) {
        showToast(kept > 0 ? "没有可关闭的会话（在跑的已跳过）" : "没有可关闭的会话");
        return;
      }
      for (const t of closable) {
        if (t.kind === "chat") void refreshSessions(t.key);
      }
      // 一次性移除（removeTabs 内部经 tabsRef 取最新列表，批量不会丢更新）；
      // exceptId 传给 removeTabs：被关掉的若是当前激活 tab，优先接管到右键那个
      removeTabs(closable.map((t) => t.id), exceptId);
      showToast(
        `已关闭 ${closable.length} 个会话` + (kept > 0 ? `，跳过 ${kept} 个在跑的` : ""),
      );
    },
    [removeTabs, refreshSessions, tabClosableNow, showToast],
  );

  // ---------- 渲染 ----------

  /** 当前激活 tab 若是对话 tab，其会话文件路径（左栏高亮用；终端 tab / 空态为 null） */
  const activeSessionFile = useMemo(() => {
    const t = tabs.find((c) => c.id === activeTabId);
    return t?.kind === "chat" ? t.session?.file ?? null : null;
  }, [tabs, activeTabId]);

  return (
    <div className="app">
      <Header
        dark={dark}
        onToggleTheme={toggleTheme}
        claudeOk={claudeOk}
        missingCount={missing.length}
        providerName={
          providerState?.providers.find((p) => p.id === providerState?.currentId)?.name ?? null
        }
        onHealth={() => setDialog("health")}
        searchOpen={searchOpen}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onToggleSearch={toggleSearch}
        onNew={() => setDialog("new")}
        onBatch={() => setDialog("batch")}
        onTrash={() => setTrashOpen(true)}
        onStats={() => setStatsOpen(true)}
        onProviders={() => {
          setProviderOpen(true);
          // 打开时重新拉取：live 可能已被外部工具（CC Switch 等）改写，
          // 后端 provider_list 顺带做标记重锚定，保证「当前」徽标是磁盘实况
          api.providerList().then(setProviderState).catch((e) => {
            // 从未加载成功过时弹窗无内容可渲染，收回打开态并提示
            if (!providerState) setProviderOpen(false);
            showToast("供应商清单加载失败：" + String(e));
          });
        }}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="main main-split">
        <div className={`main-left ${sidebarCollapsed ? "main-left-collapsed" : ""}`}>
          {searchOpen && (
            <div className="search-box left-search">
              <span className="search-icon">
                <SearchIcon size={15} />
              </span>
              <input
                className="search-input"
                placeholder="搜索项目名或路径…"
                value={search}
                autoFocus
                spellCheck={false}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") toggleSearch();
                }}
              />
              {search && (
                <button className="search-clear" onClick={() => setSearch("")} title="清除">
                  <XIcon size={12} />
                </button>
              )}
            </div>
          )}
          <div className="left-scroll">
            <PinnedSessions
            items={pinnedMeta}
            search={search}
            activeSessionFile={activeSessionFile}
            projects={items}
            onOpenSession={continueSessionTab}
            onTogglePin={togglePin}
            onSessionContextMenu={(x, y, key, session) =>
              setSessionMenu({ x, y, key, session })
            }
          />
          <ProjectList
            items={sorted}
            pinnedFiles={pinnedFiles}
            selectedKey={selectedKey}
            expandedKey={expandedKey}
            activeSessionFile={activeSessionFile}
            sessionsByKey={sessionsByKey}
            onSelect={setSelectedKey}
            onReorder={reorder}
            dragEnabled={search.trim() === ""}
            onTogglePin={togglePin}
            onToggleExpand={toggleExpand}
            onSessionContextMenu={(x, y, key, session) =>
              setSessionMenu({ x, y, key, session })
            }
            onChatProject={startNewSessionTab}
            onChatSession={continueSessionTab}
            onContextMenu={(x, y, key) => setMenu({ x, y, key })}
          />
          </div>
        </div>
        <div className="chat-col">
          {tabs.length > 0 && (
            <ChatTabs
              tabs={tabs}
              activeId={activeTabId}
              onSelect={setActiveTabId}
              onClose={closeTab}
              onTabContextMenu={openTabMenu}
            />
          )}
          {tabs.map((t) => (
            <div
              key={t.id}
              className={t.id === activeTabId ? "chat-page chat-page-active" : "chat-page"}
            >
              {t.kind === "chat" ? (
                <ChatView
                  projectPath={t.projectPath}
                  title={t.title}
                  session={t.session}
                  onToast={showToast}
                  onStatusChange={(phase) => updateChatPhase(t.id, phase)}
                  onSessionReady={(meta) => adoptChatSession(t.id, meta)}
                  onTitle={(title) => applyChatTitle(t.id, title)}
                  readOnly={t.readOnly === true}
                  continueHint={
                    defaultInteraction === "terminal"
                      ? "继续对话"
                      : "继续对话"
                  }
                  continueBlocked={
                    t.readOnly && t.session
                      ? continueBlockedReason(t.session.sessionId)
                      : null
                  }
                  onContinue={() => continueReadOnlyTab(t.id)}
                  tabId={t.id}
                  killers={tabKillersRef}
                />
              ) : (
                <TerminalPane
                  tab={t}
                  onStatus={updateTabStatus}
                  onTitle={updateTabTitle}
                  probes={tabProbesRef}
                  killers={tabKillersRef}
                />
              )}
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="viewer-empty" style={{ flex: 1 }}>
              <div className="empty-icon">
                <MessageCircleIcon size={34} />
              </div>
              <div>点击项目行的 + 新建会话，或点击会话直接继续</div>
              <div className="empty-sub">页面对话与内嵌终端均可，可同时打开多个标签页</div>
            </div>
          )}
        </div>
      </main>

      <StatusBar
        total={items.length}
        missingCount={missing.length}
        claudeOk={claudeOk}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          project={items.find((l) => l.key === menu.key) ?? null}
          onClose={() => setMenu(null)}
          onMoveTop={moveTop}
          onLaunch={(l) => launch(l.key)}
          onOpenFolder={openFolder}
          onCopyPath={copyPath}
          onRemove={confirmRemove}
        />
      )}

      {sessionMenu && (
        <SessionContextMenu
          x={sessionMenu.x}
          y={sessionMenu.y}
          session={sessionMenu.session}
          sessionPinned={pinnedFiles.has(sessionMenu.session.file)}
          onClose={() => setSessionMenu(null)}
          onResumeSystem={() => resumeSession(sessionMenu.key, sessionMenu.session)}
          onRename={() => setRenameTarget({ session: sessionMenu.session, key: sessionMenu.key })}
          onTogglePin={() => togglePin(sessionMenu.key, sessionMenu.session)}
          onDelete={() => confirmDeleteSession(sessionMenu.key, sessionMenu.session)}
        />
      )}

      {tabMenu && (
        <TabContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          tabId={tabMenu.tabId}
          title={tabMenu.title}
          otherCount={tabMenu.otherCount}
          allCount={tabMenu.allCount}
          skippedCount={tabMenu.skippedCount}
          why={tabMenu.why}
          onClose={() => setTabMenu(null)}
          onCloseOthers={(id) => closeTabsSafely(id, tabMenu.activity)}
          onCloseAll={() => closeTabsSafely(null, tabMenu.activity)}
        />
      )}

      {dialog === "new" && (
        <NewLauncherDialog
          onClose={() => setDialog(null)}
          onCreated={async () => {
            setDialog(null);
            await load();
          }}
        />
      )}

      {dialog === "batch" && (
        <BatchAddDialog
          onClose={() => setDialog(null)}
          onDone={async (count) => {
            setDialog(null);
            await load();
            showToast(`批量添加完成：新增 ${count} 个项目`);
          }}
          onRefresh={() => void load()}
        />
      )}

      {dialog === "health" && (
        <HealthDialog
          items={items}
          claudeOk={claudeOk}
          onClose={() => setDialog(null)}
          onDelete={(targets) => {
            setConfirm({
              title: "清除失效项目",
              message:
                `将清除以下 ${targets.length} 个失效项目：\n\n` +
                targets.map((l) => `${l.name}\n${l.path}`).join("\n\n") +
                "\n\n同时删除 Claude Code 用户数据里对应的会话记录\n（projects 数据目录下的残留数据，不可恢复）。继续？",
              okText: "清除",
              danger: true,
              onOk: async () => {
                for (const l of targets) await removeProject(l);
                try {
                  const n = await api.purgeClaudeProjectData(targets.map((l) => l.path));
                  showToast(`已清除 ${targets.length} 个项目，删除 ${n} 份会话数据`);
                } catch (e) {
                  showToast("清除会话数据失败：" + String(e));
                }
                setDialog(null);
              },
            });
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          okText={confirm.okText}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onOk={async () => {
            await confirm.onOk();
            setConfirm(null);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          closeAction={closeAction}
          defaultInteraction={defaultInteraction}
          onClose={() => setSettingsOpen(false)}
          onSave={async (action, interaction) => {
            setCloseAction(action);
            // 两种 tab 共存：改默认只影响之后新开的 tab，已开的不动（简报 §5）
            setDefaultInteraction(interaction);
            await persistConfig(order, pinnedSessions, dark, action, interaction);
            setSettingsOpen(false);
            showToast("设置已保存");
          }}
        />
      )}

      {providerOpen && providerState && (
        <ProviderDialog
          state={providerState}
          onClose={() => setProviderOpen(false)}
          onChanged={setProviderState}
          toast={showToast}
        />
      )}

      {renameTarget && (
        <RenameDialog
          sessionTitle={renameTarget.session.title}
          onClose={() => setRenameTarget(null)}
          onRenamed={renameSession}
        />
      )}

      {trashOpen && (
        <TrashDialog
          onClose={() => setTrashOpen(false)}
          // 恢复与彻底删除都要走这里：前者让被保留的置顶条目复活，后者要
          // 重新读盘同步被后端 prune 掉的死条目（详见 refreshAfterTrashChange）
          onChanged={refreshAfterTrashChange}
          onToast={showToast}
        />
      )}

      {statsOpen && <StatsDialog onClose={() => setStatsOpen(false)} />}

      {closeChoiceOpen && (
        <CloseChoiceDialog
          onClose={() => setCloseChoiceOpen(false)}
          onChoose={handleCloseChoice}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
