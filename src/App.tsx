import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import type { CloseAction, Project, SessionInfo } from "./types";
import Header from "./components/Header";
import Toolbar from "./components/Toolbar";
import ProjectList from "./components/ProjectList";
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
import ChatView from "./components/ChatView";
import ChatTabs from "./components/ChatTabs";
import SessionContextMenu from "./components/SessionContextMenu";

export type DialogKind = "new" | "batch" | "health" | null;

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
  const [favorites, setFavorites] = useState<string[]>([]);
  const [dark, setDark] = useState(false);
  const [search, setSearch] = useState("");
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
  // ---------- 会话管理（v2.0.0 阶段一） ----------
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [sessionsByKey, setSessionsByKey] = useState<
    Record<string, SessionInfo[] | null | undefined>
  >({});
  const [renameTarget, setRenameTarget] = useState<{
    session: SessionInfo;
    key: string;
  } | null>(null);
  /** 会话行右键菜单（重命名/终端继续） */
  const [sessionMenu, setSessionMenu] = useState<{
    x: number;
    y: number;
    key: string;
    session: SessionInfo;
  } | null>(null);
  // ---------- app 内直接对话（多会话 tab 并行） ----------
  const [chats, setChats] = useState<
    Array<{
      /** tab 唯一 id */
      id: string;
      projectPath: string;
      title: string;
      /** null = 新对话 */
      session: SessionInfo | null;
      /** 所属项目 key（关闭 tab 时刷新会话列表用） */
      key: string;
    }>
  >([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  /** 各 tab 的对话状态（思考中给 tab 打点） */
  const [chatStatus, setChatStatus] = useState<Record<string, string>>({});
  const nextChatTabId = useRef(`chat-1`);
  const newChatTabId = () => {
    const id = nextChatTabId.current;
    nextChatTabId.current = `chat-${Number(id.slice(5)) + 1}`;
    return id;
  };
  const closeActionRef = useRef<CloseAction>(null);
  closeActionRef.current = closeAction;

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

  const handleCloseChoice = useCallback(
    async (action: "quit" | "minimize", remember: boolean) => {
      setCloseChoiceOpen(false);
      if (remember) {
        setCloseAction(action);
        await api.saveConfig(favorites, projectDirs, excludedDirs, dark, action).catch(() => {});
      }
      if (action === "minimize") {
        await getCurrentWindow().hide();
      } else {
        await api.quitApp();
      }
    },
    [favorites, projectDirs, excludedDirs, dark],
  );

  // ---------- 数据加载 ----------

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listProjects(), api.loadConfig()]);
      setItems(list);
      setFavorites(cfg.favorites ?? []);
      setProjectDirs(cfg.projects ?? []);
      setExcludedDirs(cfg.excluded ?? []);
      setDark(cfg.dark ?? false);
      setCloseAction(cfg.closeAction ?? null);
      // 选中项可能已被删除，清理
      setSelectedKey((k) => (k && list.some((l) => l.key === k) ? k : null));
      // 健康检查在后台异步执行（不阻塞列表渲染）；
      // 路径不存在的结果回来后自动标记失效。
      api
        .checkProjects(list.map((l) => l.path))
        .then((results) => {
          setItems((prev) =>
            prev.map((l, i) => ({ ...l, healthy: results[i] ?? false })),
          );
        })
        .catch(() => {});
    } catch (e) {
      showToast("加载失败：" + String(e));
    }
  }, []);

  useEffect(() => {
    load();
    api.checkClaude().then(setClaudeOk).catch(() => setClaudeOk(false));
    // 安装模式首次启动：提示数据目录位置（scripts/config 实际存储处）
    api
      .getDataRoot()
      .then((info) => {
        if (info.installMode && !localStorage.getItem("cf-data-tip")) {
          localStorage.setItem("cf-data-tip", "1");
          setToast(`数据目录：${info.path}（项目清单与收藏保存在此）`);
          window.setTimeout(() => setToast(null), 5000);
        }
      })
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  // ---------- Toast ----------

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  // ---------- 收藏 / 主题 ----------

  const persistConfig = useCallback(
    async (favs: string[], d: boolean, ca?: CloseAction) => {
      try {
        await api.saveConfig(
          favs,
          projectDirs,
          excludedDirs,
          d,
          ca === undefined ? closeAction : ca,
        );
      } catch (e) {
        showToast("保存配置失败：" + String(e));
      }
    },
    [showToast, closeAction, projectDirs, excludedDirs],
  );

  const toggleFav = useCallback(
    async (key: string) => {
      const next = favorites.includes(key)
        ? favorites.filter((f) => f !== key)
        : [...favorites, key];
      setFavorites(next);
      await persistConfig(next, dark);
    },
    [favorites, dark, persistConfig],
  );

  /** 收藏拖拽排序：按 key 重排（非索引），对过滤/失效 key 天然安全 */
  const reorderFavorites = useCallback(
    async (draggedKey: string, targetKey: string, before: boolean) => {
      if (draggedKey === targetKey) return;
      if (!favorites.includes(draggedKey) || !favorites.includes(targetKey))
        return;
      const next = favorites.filter((k) => k !== draggedKey);
      const to = next.indexOf(targetKey);
      next.splice(before ? to : to + 1, 0, draggedKey);
      if (next.every((k, i) => k === favorites[i])) return; // 位置未变，免写盘
      setFavorites(next);
      await persistConfig(next, dark);
    },
    [favorites, dark, persistConfig],
  );

  const toggleTheme = useCallback(async () => {
    const next = !dark;
    setDark(next);
    await persistConfig(favorites, next);
  }, [dark, favorites, persistConfig]);

  // ---------- 列表派生数据 ----------

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = items.filter(
      (l) =>
        !q ||
        l.name.toLowerCase().includes(q) ||
        l.path.toLowerCase().includes(q),
    );
    // 收藏组按 favorites 数组顺序渲染（拖拽排序的真源；合并列表原始顺序与此无关）
    const byKey = new Map(filtered.map((l) => [l.key, l]));
    const fav = favorites
      .map((k) => byKey.get(k))
      .filter((l): l is Project => !!l);
    const rest = filtered
      .filter((l) => !favorites.includes(l.key))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    return [...fav, ...rest];
  }, [items, favorites, search]);

  const missing = items.filter((l) => l.healthy === false);

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
      const favs = favorites.filter((f) => f !== l.key);
      if (favs.length !== favorites.length) {
        setFavorites(favs);
        await persistConfig(favs, dark);
      }
      await load();
      showToast(`已从列表移除 ${l.name}`);
    },
    [favorites, dark, persistConfig, load, showToast],
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

  // ---------- 会话管理（v2.0.0 阶段一） ----------

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
      // 重命名后刷新该项目会话列表（若仍处于展开状态）
      if (expandedKey === key) {
        const l = items.find((x) => x.key === key);
        if (l?.path) {
          const list = await api.listSessions(l.path).catch(() => null);
          if (list) setSessionsByKey((prev) => ({ ...prev, [key]: list }));
        }
      }
      showToast("已重命名");
    },
    [renameTarget, expandedKey, items, showToast],
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

  const deleteSession = useCallback(
    async (key: string, session: SessionInfo) => {
      try {
        await api.deleteSession(session.file);
        await refreshSessions(key);
        showToast(`已删除「${session.title}」，可在回收站恢复`);
      } catch (e) {
        showToast("删除失败：" + String(e));
      }
    },
    [refreshSessions, showToast],
  );

  const confirmDeleteSession = useCallback(
    (key: string, session: SessionInfo) => {
      setConfirm({
        title: "删除会话",
        message: `将删除会话：\n\n「${session.title}」\n\n删除后移入回收站（可恢复），继续？`,
        okText: "删除",
        danger: true,
        onOk: () => deleteSession(key, session),
      });
    },
    [deleteSession],
  );

  const resumeSession = useCallback(
    async (key: string, session: SessionInfo) => {
      const launcher = items.find((x) => x.key === key);
      if (!launcher?.path) {
        showToast("该项目未解析到路径，无法继续对话");
        return;
      }
      try {
        await api.resumeSession(session.file, launcher.path);
        showToast(`已打开「${session.title}」的继续对话窗口`);
      } catch (e) {
        showToast("启动失败：" + String(e));
      }
    },
    [items, showToast],
  );

  // ---------- app 内直接对话（多会话 tab 并行） ----------

  /** 打开一个对话 tab（已存在同会话的 tab 则只激活）。
   *  id 必须在 updater 外生成、updater 保持纯函数——React（StrictMode 下）
   *  会多次调用 updater，在内部生成 id / 写外部变量会导致 activeChatId
   *  与 tab 实际 id 不一致（表现为第一个会话要点两次） */
  const openChatTab = useCallback(
    (tab: { projectPath: string; title: string; session: SessionInfo | null; key: string }) => {
      // 续聊同一会话不允许开两个进程（会分叉历史），只激活已有 tab
      const dup = tab.session
        ? chats.find((c) => c.session?.file === tab.session!.file)
        : undefined;
      if (dup) {
        setActiveChatId(dup.id);
        return;
      }
      const id = newChatTabId();
      setChats((prev) => [...prev, { id, ...tab }]);
      setActiveChatId(id);
    },
    [chats],
  );

  /** 在 app 内新开对话（claude 工作目录 = 项目路径） */
  const startInAppChat = useCallback(
    (key: string) => {
      const l = items.find((x) => x.key === key);
      if (!l?.path) {
        showToast("该项目未解析到路径，无法对话");
        return;
      }
      if (l.healthy === false) {
        showToast(`目录不存在，无法对话：${l.path}`);
        return;
      }
      openChatTab({ projectPath: l.path, title: l.name, session: null, key });
    },
    [items, showToast, openChatTab],
  );

  /** 在 app 内继续已有会话 */
  const continueInAppChat = useCallback(
    (key: string, session: SessionInfo) => {
      const l = items.find((x) => x.key === key);
      if (!l?.path) {
        showToast("该项目未解析到路径，无法对话");
        return;
      }
      openChatTab({ projectPath: l.path, title: session.title, session, key });
    },
    [items, showToast, openChatTab],
  );

  /** 关闭对话 tab：卸载 ChatView（其 unmount 会优雅关闭进程）并刷新该项目会话列表 */
  const closeChat = useCallback(
    (tabId: string) => {
      const tab = chats.find((c) => c.id === tabId);
      if (tab) void refreshSessions(tab.key);
      const rest = chats.filter((c) => c.id !== tabId);
      setChats(rest);
      // 关闭的是当前 tab → 激活相邻 tab
      setActiveChatId((cur) =>
        cur === tabId ? rest[rest.length - 1]?.id ?? null : cur,
      );
      setChatStatus((prev) => {
        if (!(tabId in prev)) return prev;
        const copy = { ...prev };
        delete copy[tabId];
        return copy;
      });
    },
    [chats, refreshSessions],
  );

  // ---------- 渲染 ----------

  return (
    <div className="app">
      <Header
        dark={dark}
        onToggleTheme={toggleTheme}
        claudeOk={claudeOk}
        missingCount={missing.length}
        onHealth={() => setDialog("health")}
        onSettings={() => setSettingsOpen(true)}
      />

      <Toolbar
        search={search}
        onSearch={setSearch}
        onNew={() => setDialog("new")}
        onBatch={() => setDialog("batch")}
        onHealth={() => setDialog("health")}
        onTrash={() => setTrashOpen(true)}
        onStats={() => setStatsOpen(true)}
      />

      <main className="main main-split">
        <div className="main-left">
          <ProjectList
            items={sorted}
            favorites={favorites}
            selectedKey={selectedKey}
            expandedKey={expandedKey}
            activeSessionFile={activeChatId ? chats.find((c) => c.id === activeChatId)?.session?.file ?? null : null}
            sessionsByKey={sessionsByKey}
            onSelect={setSelectedKey}
            onToggleFav={toggleFav}
            dragEnabled={search.trim() === ""}
            onReorderFavorite={reorderFavorites}
            onToggleExpand={toggleExpand}
            onRenameSession={(key, session) => setRenameTarget({ session, key })}
            onDeleteSession={confirmDeleteSession}
            onSessionContextMenu={(x, y, key, session) =>
              setSessionMenu({ x, y, key, session })
            }            onChatProject={startInAppChat}
            onChatSession={continueInAppChat}
            onContextMenu={(x, y, key) => setMenu({ x, y, key })}
          />
        </div>
        <div className="chat-col">
          {chats.length > 0 && (
            <ChatTabs
              tabs={chats.map((c) => ({ id: c.id, title: c.title }))}
              activeId={activeChatId}
              statusByTab={chatStatus}
              onSelect={setActiveChatId}
              onClose={closeChat}
            />
          )}
          {chats.map((c) => (
            <div
              key={c.id}
              className={c.id === activeChatId ? "chat-page chat-page-active" : "chat-page"}
            >
              <ChatView
                projectPath={c.projectPath}
                title={c.title}
                session={c.session}
                onBack={() => closeChat(c.id)}
                onToast={showToast}
                onStatusChange={(phase) =>
                  setChatStatus((prev) =>
                    prev[c.id] === phase ? prev : { ...prev, [c.id]: phase },
                  )
                }
              />
            </div>
          ))}
          {chats.length === 0 && (
            <div className="viewer-empty" style={{ flex: 1 }}>
              <div className="empty-icon">💬</div>
              <div>点击项目行 💬 新建对话，或点击会话直接继续</div>
              <div className="empty-sub">可同时打开多个对话，标签页切换</div>
            </div>
          )}
        </div>
      </main>

      <StatusBar
        total={items.length}
        favCount={favorites.length}
        missingCount={missing.length}
        claudeOk={claudeOk}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          project={items.find((l) => l.key === menu.key) ?? null}
          favorites={favorites}
          onClose={() => setMenu(null)}
          onToggleFav={toggleFav}
          onLaunch={(l) => launch(l.key)}
          onOpenFolder={openFolder}
          onCopyPath={copyPath}
          onRemove={confirmRemove}
          onHealth={() => {
            setMenu(null);
            setDialog("health");
          }}
        />
      )}

      {sessionMenu && (
        <SessionContextMenu
          x={sessionMenu.x}
          y={sessionMenu.y}
          session={sessionMenu.session}
          onClose={() => setSessionMenu(null)}
          onResumeTerminal={() => resumeSession(sessionMenu.key, sessionMenu.session)}
          onRename={() => setRenameTarget({ session: sessionMenu.session, key: sessionMenu.key })}
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
        />
      )}

      {dialog === "health" && (
        <HealthDialog
          items={items}
          claudeOk={claudeOk}
          onClose={() => setDialog(null)}
          onDelete={async (items) => {
            for (const l of items) await removeProject(l);
            setDialog(null);
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
          onClose={() => setSettingsOpen(false)}
          onSave={async (action) => {
            setCloseAction(action);
            await persistConfig(favorites, dark, action);
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
          onChanged={() => {
            // 回收站操作后刷新当前展开项目的会话列表
            if (expandedKey) refreshSessions(expandedKey);
          }}
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
