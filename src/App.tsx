import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import ProjectList from "./components/ProjectList";
import PinnedSessions from "./components/PinnedSessions";
import StatusBar from "./components/StatusBar";
import ContextMenu, { type MenuItem } from "./components/ContextMenu";
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
import SessionViewer from "./components/SessionViewer";
import TerminalPane from "./components/TerminalPane";
import {
  FileTextIcon,
  SearchIcon,
  TerminalIcon,
  XIcon,
} from "./components/Icons";

export type DialogKind = "new" | "batch" | "health" | null;

/** 窗口过窄自动收起左栏的阈值（40px 迟滞带防边界抖动）：
 *  <980 收起——980-360(左栏)=620px 内容区 ≈ 70 列终端，再窄 claude 输入行局促，
 *  收起后同宽度内容区约 110 列；>1020 恢复。只恢复「被自动收起」的，
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
  /** 右键菜单：key=项目 key；session 非空时会话菜单（key 为其归属项目/路径） */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    key: string;
    session: SessionInfo | null;
  } | null>(null);
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
  // ---------- 会话内容 ----------
  const [activeSession, setActiveSession] = useState<{
    session: SessionInfo;
    key: string;
    projectPath: string | null;
  } | null>(null);
  const closeActionRef = useRef<CloseAction>(null);
  closeActionRef.current = closeAction;

  // ---------- 内嵌终端 tab（真 claude CLI 跑在 PTY 里，xterm.js 渲染） ----------
  const [termTabs, setTermTabs] = useState<TerminalTab[]>([]);
  /** 当前激活 tab：null = 查看器 tab（activeSession 的只读内容） */
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabSeqRef = useRef(0);
  /** 终端 tab 的忙/闲探针（TerminalPane 挂载时注册）：**右键那一刻现算**，不缓存、不轮询 */
  const tabProbesRef = useRef(new Map<string, () => TabActivity>());
  /** 终端 tab 的"就地击杀"句柄（TerminalPane 挂载时注册）：删除会话时先 await 它结束
   *  这个 tab 的 claude，再动会话文件——卸载路径上的 kill 不等结果，拿不到退出时刻 */
  const tabKillersRef = useRef(new Map<string, () => Promise<void>>());
  /** 内容区 tab 的右键菜单（tabId=null 表示查看器 tab）。
   *  activity 是**打开菜单那一刻**各 tab 的探针快照——菜单渲染与随后的关闭判定都用这一份，
   *  保证"看到的数字"与"实际关掉的"完全一致（轮询缓存过时是上一版的坑）。 */
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string | null;
    activity: Record<string, TabActivity>;
  } | null>(null);
  /** tab 条容器：滚轮横向滚动用（滚动条已按用户要求隐藏） */
  const tabsRef = useRef<HTMLDivElement | null>(null);

  // tab 条溢出时，鼠标悬浮 + 滚轮 = 横向滚动。
  // 必须用原生监听：React 的 onWheel 是在根节点上的被动监听，preventDefault 不生效，
  // 滚轮会连带滚动外层容器（终端 area）；passive:false 才能拦住。
  // 没溢出时直接放行，滚轮交还给正常滚动链。
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft += d;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // tab 条是条件渲染的，出现/消失都要重挂
  }, [Boolean(activeSession) || termTabs.length > 0]);

  // ---------- 关闭窗口行为 ----------

  // 拦截关闭：minimize → 隐藏到托盘；null（未设置）→ 弹窗询问；quit → 直接退出
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const action = closeActionRef.current;
        if (action === "quit") {
          // 显式销毁窗口（不触发 CloseRequested，避免事件循环；否则窗口不关闭）
          await getCurrentWindow().destroy();
          return;
        }
        event.preventDefault();
        if (action === "minimize") {
          await getCurrentWindow().hide();
        } else {
          setCloseChoiceOpen(true);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
          await api.saveConfig(order, pinnedSessions, projectDirs, excludedDirs, dark, action);
        } catch (e) {
          // 失败必须留在窗口内报错：窗口一隐藏/退出，提示再没机会被看到，
          // 用户会以为选择已记住。保持打开，可重试或去掉「记住」再关。
          showToast("保存关闭行为失败：" + String(e));
          return;
        }
        setCloseAction(action);
      }
      if (action === "minimize") {
        await getCurrentWindow().hide();
      } else {
        await api.quitApp();
      }
    },
    [order, pinnedSessions, projectDirs, excludedDirs, dark, showToast],
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
    ): Promise<boolean> => {
      try {
        await api.saveConfig(
          ord,
          pins,
          projectDirs,
          excludedDirs,
          d,
          ca === undefined ? closeAction : ca,
        );
        return true;
      } catch (e) {
        showToast("保存配置失败：" + String(e));
        return false;
      }
    },
    [showToast, closeAction, projectDirs, excludedDirs],
  );

  const toggleTheme = useCallback(async () => {
    const next = !dark;
    setDark(next);
    await persistConfig(order, pinnedSessions, next);
  }, [dark, order, pinnedSessions, persistConfig]);

  // ---------- 搜索 ----------

  /** 顶栏「搜索」按钮：展开左栏搜索框并聚焦；再次点击收起并清空关键词 */
  const toggleSearch = useCallback(() => {
    if (searchOpen) setSearch("");
    setSearchOpen(!searchOpen);
  }, [searchOpen]);

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

  const missing = items.filter((l) => l.healthy === false);

  // ---------- 内嵌终端 tab 操作 ----------

  /** 关掉若干 tab 后决定"接下来显示谁"，然后统一移除。
   *  规则（浏览器/终端的通行行为）：
   *  ① 当前显示的是查看器（activeTabId=null）→ 保持不动（关终端 tab 不该把只读页顶掉）；
   *  ② 当前激活的 tab 没被关 → 不动；
   *  ③ 被关了 → 优先 preferId（"关闭其他"传右键那个 tab）；
   *  ④ 再退化到"剩下里的最后一个"——"关闭所有"时会落到那个还在干活、没被关的会话上，
   *     不会像旧实现那样一律回落到空查看器；
   *  ⑤ 一个都不剩 → null（查看器/空态）。 */
  const removeTabs = useCallback(
    (ids: string[], preferId: string | null = null) => {
      const gone = new Set(ids);
      setTermTabs((prev) => prev.filter((t) => !gone.has(t.id)));
      setActiveTabId((cur) => {
        // 当前是查看器（null = 只读内容页）→ 保持查看器，不因为关了终端 tab 就跳走
        if (cur === null) return null;
        if (!gone.has(cur)) return cur;
        if (preferId && !gone.has(preferId)) return preferId;
        const rest = termTabs.filter((t) => !gone.has(t.id));
        return rest.length > 0 ? rest[rest.length - 1].id : null;
      });
    },
    [termTabs],
  );

  /** 挂着某个会话的终端 tab：续聊 tab 认 resumeSessionId、新会话 tab 认 newSessionId
   *  （都是传给 claude 的那个 uuid，与 SessionInfo.sessionId 同一套 id）。 */
  const tabsForSession = useCallback(
    (sessionId: string) =>
      termTabs.filter((t) => t.resumeSessionId === sessionId || t.newSessionId === sessionId),
    [termTabs],
  );

  /** 单个 tab 关闭后的接管者：右邻优先、退化左邻（浏览器惯例） */
  const neighborTabId = useCallback(
    (id: string) => {
      const i = termTabs.findIndex((t) => t.id === id);
      return i < 0 ? null : (termTabs[i + 1]?.id ?? termTabs[i - 1]?.id ?? null);
    },
    [termTabs],
  );

  /** 能否安全关闭：进程已结束，或探针判为"空闲"。快照里 busy / unknown 一律不关——
   *  关 tab = 卸载终端 = kill 进程，误杀在跑的会话代价远大于漏关几个 tab。
   *  status 是 starting 还是 running 不参与判断：刚开的会话本来就该能关（也还没干过活）。 */
  const tabClosable = (t: TerminalTab, activity: Record<string, TabActivity>) =>
    t.status === "exited" || activity[t.id] === "idle";

  /** 批量关 tab：只关 tabClosable 的，其余跳过并如实报数。
   *  exceptId：保留哪一个（"关闭其他"传右键那个 tab 的 id；"关闭所有"传 null）。 */
  const closeTabsSafely = useCallback(
    (exceptId: string | null, activity: Record<string, TabActivity>) => {
      const targets = termTabs.filter((t) => t.id !== exceptId);
      const closable = targets.filter((t) => tabClosable(t, activity));
      const kept = targets.length - closable.length;
      if (closable.length === 0) {
        showToast(kept > 0 ? "没有可关闭的会话（在跑的已跳过）" : "没有可关闭的会话");
        return;
      }
      // 一次性移除（removeTabs 内部是函数式 setState，批量不会丢更新）；
      // exceptId 传给 removeTabs：被关掉的若是当前激活 tab，优先接管到右键那个
      removeTabs(closable.map((t) => t.id), exceptId);
      showToast(
        `已关闭 ${closable.length} 个会话` + (kept > 0 ? `，跳过 ${kept} 个在跑的` : ""),
      );
    },
    [termTabs, removeTabs, showToast],
  );

  /** 打开 tab 右键菜单：此刻对每个终端 tab 现算一次忙/闲，结果作为快照放进菜单状态 */
  const openTabMenu = useCallback(
    (e: React.MouseEvent, tabId: string | null) => {
      e.preventDefault();
      e.stopPropagation();
      const activity: Record<string, TabActivity> = {};
      for (const t of termTabs) {
        activity[t.id] = tabProbesRef.current.get(t.id)?.() ?? "unknown";
      }
      setTabMenu({ x: e.clientX, y: e.clientY, tabId, activity });
    },
    [termTabs],
  );

  const openTerminalTab = useCallback(
    (opts: { title: string; projectPath: string; resumeSessionId: string | null }) => {
      // 同一会话已开过 tab → 直接激活，避免 --resume 同 id 双开两条分支
      if (opts.resumeSessionId) {
        const dup = termTabs.find((t) => t.resumeSessionId === opts.resumeSessionId);
        if (dup) {
          setActiveTabId(dup.id);
          return;
        }
      }
      const tab: TerminalTab = {
        id: `t${++tabSeqRef.current}`,
        title: opts.title,
        projectPath: opts.projectPath,
        resumeSessionId: opts.resumeSessionId,
        // 新会话预生成会话 id（交给 claude 的 --session-id）：tab 一开出来就知道
        // 它对应哪个会话文件，会话名一落盘就能回填标题
        newSessionId: opts.resumeSessionId === null ? newSessionId() : null,
        status: "starting",
        exitCode: null,
      };
      setTermTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    },
    [termTabs],
  );

  /** 终端状态回传（TerminalPane：starting → running / exited） */
  const updateTabStatus = useCallback(
    (id: string, status: TerminalTab["status"], exitCode: number | null) => {
      setTermTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status, exitCode } : t)),
      );
    },
    [],
  );

  /** 改 tab 标题。**标题没变就不 setState**：claude 干活时每 ~960ms 用 ◐/◑ 重写一次
   *  OSC 标题，剥掉字形后内容完全相同，不挡住这一路会让整棵 tab 条跟着动画帧重渲染。 */
  const setTabTitle = useCallback((id: string, title: string) => {
    setTermTabs((prev) => {
      const i = prev.findIndex((t) => t.id === id);
      if (i < 0 || prev[i].title === title) return prev;
      const next = prev.slice();
      next[i] = { ...next[i], title };
      return next;
    });
  }, []);

  /** 标题已定稿的 tab：定稿后不再让「会话文件兜底」插话（它读到的可能还是首条用户消息，
   *  比 claude 刚写出的 OSC 标题旧）。ref 给轮询里的同步判断用，state 用来重算待办清单。 */
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

  /** 待补标题的新会话 tab：会话 id 已知、进程还活着、标题还没定稿。
   *  为什么要补：claude 的 OSC 标题取 customTitle > aiTitle > "Claude Code"，
   *  **不带「首条用户消息」这一档**，而左上列表的标题链是 customTitle > aiTitle >
   *  首条用户消息。于是没生成 aiTitle 的会话（实测 175 个里 10 个，用户撞上的那个就在
   *  其中）OSC 只写兜底值、被 term-title.ts 滤掉，tab 就永远挂着项目名。这类会话只能
   *  回来读会话文件——文件在第一条消息之后才出现，所以是轮询。 */
  const pendingTitleTabs = termTabs
    .filter((t) => t.newSessionId !== null && t.status !== "exited" && !titledIds.includes(t.id))
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
  }, [pendingTitleKey, setTabTitle, markTitled]);

  /** 关 tab：运行中先确认（关闭 = 结束 claude 进程）；卸载 TerminalPane 时自动 kill。
   *  被关的是当前激活 tab 时接管到右/左邻，而不是回落到空查看器。 */
  const closeTerminalTab = useCallback(
    (tab: TerminalTab) => {
      const next = neighborTabId(tab.id);
      if (tab.status !== "exited") {
        setConfirm({
          title: "关闭终端",
          message: `「${tab.title}」的 claude 会话仍在运行，关闭 tab 将结束该进程。继续？`,
          okText: "关闭",
          danger: true,
          onOk: () => removeTabs([tab.id], next),
        });
        return;
      }
      removeTabs([tab.id], next);
    },
    [neighborTabId, removeTabs],
  );

  // ---------- 操作 ----------

  const launch = useCallback(
    (key: string) => {
      const l = items.find((x) => x.key === key);
      if (!l) return;
      if (l.healthy === false) {
        showToast(`目录不存在，无法启动：${l.path}`);
        return;
      }
      // 项目行「+」：在内容区新开内嵌终端 tab 起一个 claude 会话
      openTerminalTab({ title: l.name, projectPath: l.path, resumeSessionId: null });
    },
    [items, showToast, openTerminalTab],
  );

  /** 项目右键「在系统终端打开新会话」：走后端 launch_project（cmd /k … && claude），
   *  与「+」的内嵌终端 tab 互补；路径存在性由后端 validate_resume_path 把关 */
  const launchSystemTerminal = useCallback(
    async (l: Project) => {
      if (!l.path) return;
      try {
        await api.launchProject(l.path);
      } catch (e) {
        showToast("在系统终端启动失败：" + String(e));
      }
    },
    [showToast],
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
      // 展开态/会话缓存/正在查看的会话也要清：重新添加同一路径时不带旧数据复活
      setExpandedKey((k) => (k === l.key ? null : k));
      setSessionsByKey((prev) => {
        if (!(l.key in prev)) return prev;
        const next = { ...prev };
        delete next[l.key];
        return next;
      });
      setActiveSession((cur) => (cur && cur.key === l.key ? null : cur));
      await refreshPinned();
      await load();
      showToast(`已从列表移除 ${l.name}`);
    },
    [refreshPinned, load, showToast],
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
      // 右侧查看器正显示该会话时同步其标题，否则头部停留在旧标题
      setActiveSession((cur) =>
        cur && cur.session.file === session.file
          ? { ...cur, session: { ...cur.session, title: newTitle } }
          : cur,
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
  // 聚焦事件——注意 onFocusChanged 订阅时**不会**用当前焦点状态回调一次
  // （@tauri-apps/api 只是注册 FOCUS/BLUR 两个监听），所以这里挡的是启动后
  // 紧接着的真实聚焦；此时 expandedKey 恒为 null，唯一可能重复的只有挂载
  // effect 已拉过一次的 refreshPinned()，无实际损失。
  const visibleListsRef = useRef({ refresh: refreshVisibleLists, at: 0 });
  useEffect(() => {
    visibleListsRef.current.refresh = refreshVisibleLists;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    visibleListsRef.current.at = Date.now();
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        const now = Date.now();
        if (now - visibleListsRef.current.at < 1500) return;
        visibleListsRef.current.at = now;
        visibleListsRef.current.refresh();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
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
        attached
          .filter((t) => t.status !== "exited")
          .map((t) => tabKillersRef.current.get(t.id)?.() ?? Promise.resolve()),
      );
      // 已结束的死 tab 同样收掉：文件都没了，留着只是"指向不存在会话"的孤儿
      if (attached.length > 0) removeTabs(attached.map((t) => t.id));
      try {
        await api.deleteSession(session.file);
        await refreshSessions(key);
        // 置顶条目**保留**（后端亦然）：文件只是进了回收站，恢复回原路径即自动复活，
        // 此处重拉后该会话因文件缺失暂时从置顶区消失
        await refreshPinned();
        // 右侧正显示该会话 → 清空
        setActiveSession((cur) =>
          cur && cur.session.file === session.file ? null : cur,
        );
        showToast(`已删除「${session.title}」，可在回收站恢复`);
      } catch (e) {
        showToast("删除失败：" + String(e));
      }
    },
    [refreshSessions, refreshPinned, showToast, tabsForSession, removeTabs],
  );

  const confirmDeleteSession = useCallback(
    (key: string, session: SessionInfo) => {
      // 终端里开着这个会话时，确认框必须说清"连带关掉终端"（关 = 结束 claude 进程）
      const attached = tabsForSession(session.sessionId);
      const live = attached.filter((t) => t.status !== "exited");
      // 忙/闲**就在点删除这一刻现算**（与 openTabMenu 同一套）：缓存快照会骗人。
      // unknown 按忙处理，口径与 tabClosable 一致（宁可说得重一点，不可轻描淡写）
      const busy = live.some(
        (t) => (tabProbesRef.current.get(t.id)?.() ?? "unknown") !== "idle",
      );
      const tail =
        attached.length === 0
          ? ""
          : live.length === 0
            ? "\n\n该会话的终端 tab（已结束）将一并关闭。"
            : busy
              ? "\n\n该会话正开在终端 tab 里，删除将一并结束它——claude 正在干活，这一轮会被中断。"
              : "\n\n该会话正开在终端 tab 里，删除将一并关闭该终端。";
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

  // ---------- 会话内容 ----------

  const loadSessionMessages = useCallback(
    async (key: string, session: SessionInfo) => {
      const launcher = items.find((x) => x.key === key);
      setActiveSession({
        session,
        key,
        // key 本身即项目绝对路径；items 里查不到（如已移除项目）时用 key 兜底
        projectPath: launcher?.path ?? key,
      });
      // 点会话行 = 查看内容：切回查看器 tab（终端 tab 不受影响）
      setActiveTabId(null);
    },
    [items],
  );

  /** 继续对话：在内容区新开内嵌终端 tab，PTY 里跑 `claude --resume <会话 id>` */
  const resumeSession = useCallback(
    (key: string, session: SessionInfo) => {
      const launcher = items.find((x) => x.key === key);
      // key 本身即项目绝对路径，items 里查不到（项目已不在列表）时用 key 兜底
      openTerminalTab({
        title: session.title,
        projectPath: launcher?.path ?? key,
        resumeSessionId: session.sessionId,
      });
    },
    [items, openTerminalTab],
  );

  /** 会话右键「在系统终端继续对话」：走后端 resume_session（系统终端里 claude --resume），
   *  与内嵌终端 tab 的 resumeSession 互补；key 同为项目绝对路径（置顶区传 projectPath） */
  const resumeSystemTerminal = useCallback(
    async (key: string, s: SessionInfo) => {
      const launcher = items.find((x) => x.key === key);
      try {
        await api.resumeSession(s.file, launcher?.path ?? key);
      } catch (e) {
        showToast("在系统终端继续对话失败：" + String(e));
      }
    },
    [items, showToast],
  );

  // ---------- 渲染 ----------

  /** 内容区 tab 右键菜单的内容。可关闭项 = 已结束 + 探针判为空闲；忙碌/未识别的只报数、
   *  不列进菜单（关 tab = 杀 claude 进程）。全部基于打开菜单时的快照。 */
  const tabMenuView = useMemo(() => {
    if (!tabMenu) return null;
    const act = tabMenu.activity;
    const closable = termTabs.filter((t) => tabClosable(t, act));
    const otherClosable = closable.filter((t) => t.id !== tabMenu.tabId);
    const rightTab = tabMenu.tabId ? termTabs.find((t) => t.id === tabMenu.tabId) : null;
    // 右键查看器 tab 时"其他"与"所有"没有区别，只算"所有"那一份
    const scope = tabMenu.tabId ? termTabs.filter((t) => t.id !== tabMenu.tabId) : termTabs;
    const kept = scope.filter((t) => !tabClosable(t, act));
    const keptBusy = kept.filter((t) => act[t.id] === "busy").length;
    const keptSilent = kept.filter((t) => act[t.id] === undefined).length;
    const keptUnknown = kept.length - keptBusy - keptSilent;

    // 分开写清楚"为什么没关"，否则只看得到 0、没法判断是探测问题还是真有在跑的
    const why: string[] = [];
    if (keptBusy > 0) why.push(`${keptBusy} 个干活中`);
    if (keptUnknown > 0) why.push(`${keptUnknown} 个没识别出空闲态`);
    if (keptSilent > 0) why.push(`${keptSilent} 个还没探测到`);
    const noteLines: string[] = [];
    if (why.length > 0) noteLines.push(`跳过 ${kept.length} 个：${why.join(" · ")}`);

    const items: MenuItem[] = [];
    if (tabMenu.tabId) {
      items.push({
        label: `关闭其他会话（${otherClosable.length}）`,
        disabled: otherClosable.length === 0,
        onSelect: () => {
          // 关掉其他之后"谁接管"由 removeTabs 的 preferId 决定（= 右键这个 tab）
          closeTabsSafely(tabMenu.tabId, act);
        },
      });
    }
    items.push({
      label: `关闭所有会话（${closable.length}）`,
      disabled: closable.length === 0,
      onSelect: () => closeTabsSafely(null, act),
    });

    return {
      title: rightTab?.title ?? activeSession?.session.title ?? "查看器",
      note: noteLines.length > 0 ? noteLines.join("\n") : null,
      items,
    };
  }, [tabMenu, termTabs, activeSession, closeTabsSafely]);

  return (
    <div className="app">
      <Header
        dark={dark}
        onToggleTheme={toggleTheme}
        claudeOk={claudeOk}
        missingCount={missing.length}
        searchOpen={searchOpen}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onToggleSearch={toggleSearch}
        onHealth={() => setDialog("health")}
        onNew={() => setDialog("new")}
        onBatch={() => setDialog("batch")}
        onTrash={() => setTrashOpen(true)}
        onStats={() => setStatsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        providerName={
          providerState?.providers.find((p) => p.id === providerState?.currentId)?.name ?? null
        }
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
            activeSessionFile={activeSession?.session.file ?? null}
            projects={items}
            onOpenSession={loadSessionMessages}
            onTogglePin={togglePin}
            onSessionContextMenu={(projectPath, session, x, y) =>
              setMenu({ x, y, key: projectPath, session })
            }
          />
          <ProjectList
            items={sorted}
            pinnedFiles={pinnedFiles}
            selectedKey={selectedKey}
            expandedKey={expandedKey}
            activeSessionFile={activeSession?.session.file ?? null}
            sessionsByKey={sessionsByKey}
            onSelect={setSelectedKey}
            onLaunch={launch}
            onReorder={reorder}
            dragEnabled={search.trim() === ""}
            onToggleExpand={toggleExpand}
            onTogglePin={togglePin}
            onSessionContextMenu={(key, session, x, y) => setMenu({ x, y, key, session })}
            onOpenSession={loadSessionMessages}
            onContextMenu={(x, y, key) => setMenu({ x, y, key, session: null })}
          />
          </div>
        </div>
        {/* 内容区：查看器 tab + 内嵌终端 tab 共用一套 tab 条（无任何 tab 时
            退化为原查看器形态，空态由 SessionViewer 自行渲染） */}
        <div className="content">
          {(activeSession || termTabs.length > 0) && (
            <div className="content-tabs" ref={tabsRef}>
              {activeSession && (
                <button
                  type="button"
                  className={`content-tab ${activeTabId === null ? "active" : ""}`}
                  onClick={() => setActiveTabId(null)}
                  onContextMenu={(e) => openTabMenu(e, null)}
                  title={`查看：${activeSession.session.title}`}
                >
                  <FileTextIcon />
                  <span className="content-tab-title">{activeSession.session.title}</span>
                </button>
              )}
              {termTabs.map((t) => (
            <div
              key={t.id}
              className={`content-tab content-tab-term status-${t.status} ${
                activeTabId === t.id ? "active" : ""
              }`}
              onClick={() => setActiveTabId(t.id)}
              onContextMenu={(e) => openTabMenu(e, t.id)}
              title={t.title}
            >
                  <TerminalIcon className="content-tab-icon" />
                  <span className="content-tab-title">{t.title}</span>
                  <button
                    type="button"
                    className="content-tab-close"
                    title={t.status === "exited" ? "关闭" : "关闭（结束进程）"}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminalTab(t);
                    }}
                  >
                    <XIcon size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={`content-body ${activeTabId === null ? "" : "content-body-hidden"}`}>
            <SessionViewer
              session={activeSession?.session ?? null}
              onResume={() => {
                if (activeSession) {
                  resumeSession(activeSession.key, activeSession.session);
                }
              }}
              onToast={showToast}
            />
          </div>
          {termTabs.map((t) => (
            <div
              key={t.id}
              className={`content-body ${activeTabId === t.id ? "" : "content-body-hidden"}`}
            >
              <TerminalPane
                tab={t}
                onStatus={updateTabStatus}
                onTitle={updateTabTitle}
                probes={tabProbesRef}
                killers={tabKillersRef}
              />
            </div>
          ))}
        </div>
      </main>

      <StatusBar
        total={items.length}
        missingCount={missing.length}
        claudeOk={claudeOk}
      />

      {tabMenu && tabMenuView && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          title={tabMenuView.title}
          note={tabMenuView.note}
          items={tabMenuView.items}
          onClose={() => setTabMenu(null)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          project={items.find((l) => l.key === menu.key) ?? null}
          session={menu.session}
          sessionPinned={menu.session ? pinnedFiles.has(menu.session.file) : false}
          onClose={() => setMenu(null)}
          onMoveTop={moveTop}
          onLaunchSystemTerminal={launchSystemTerminal}
          onOpenFolder={openFolder}
          onCopyPath={copyPath}
          onRemove={confirmRemove}
          onResumeSession={(s) => resumeSession(menu.key, s)}
          onResumeSystemTerminal={(s) => resumeSystemTerminal(menu.key, s)}
          onRenameSession={(s) => setRenameTarget({ session: s, key: menu.key })}
          onTogglePinSession={(s) => togglePin(menu.key, s)}
          onDeleteSession={(s) => confirmDeleteSession(menu.key, s)}
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

      {providerOpen && providerState && (
        <ProviderDialog
          state={providerState}
          onClose={() => setProviderOpen(false)}
          onChanged={setProviderState}
          toast={showToast}
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
          onClose={() => setSettingsOpen(false)}
          onSave={async (action) => {
            setCloseAction(action);
            await persistConfig(order, pinnedSessions, dark, action);
            setSettingsOpen(false);
            showToast("设置已保存");
          }}
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
