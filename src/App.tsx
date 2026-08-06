import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import type { CloseAction, Launcher } from "./types";
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

export type DialogKind = "new" | "batch" | "health" | null;

interface ConfirmState {
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
  onOk: () => void | Promise<void>;
}

export default function App() {
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [dark, setDark] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [claudeOk, setClaudeOk] = useState<boolean | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState("D:\\MyWorkspaces");
  const [closeAction, setCloseAction] = useState<CloseAction>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
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
        await api.saveConfig(favorites, dark, action).catch(() => {});
      }
      if (action === "minimize") {
        await getCurrentWindow().hide();
      } else {
        await api.quitApp();
      }
    },
    [favorites, dark],
  );

  // ---------- 数据加载 ----------

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listLaunchers(), api.loadConfig()]);
      setLaunchers(list);
      setFavorites(cfg.favorites ?? []);
      setDark(cfg.dark ?? false);
      setCloseAction(cfg.closeAction ?? null);
      // 选中项可能已被删除，清理
      setSelectedKey((k) => (k && list.some((l) => l.key === k) ? k : null));
      // 健康检查在后台异步执行（不阻塞列表渲染）；
      // 被移除项目的目录检查较慢/超时，结果回来后自动标记失效。
      api
        .checkLaunchers(list.map((l) => l.path ?? ""))
        .then((results) => {
          setLaunchers((prev) =>
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
    api.getWorkspaceRoot().then(setWorkspaceRoot).catch(() => {});
    // 安装模式首次启动：提示数据目录位置（scripts/config 实际存储处）
    api
      .getDataRoot()
      .then((info) => {
        if (info.installMode && !localStorage.getItem("cf-data-tip")) {
          localStorage.setItem("cf-data-tip", "1");
          setToast(`数据目录：${info.path}（启动脚本 scripts/ 与收藏保存在此）`);
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
        await api.saveConfig(favs, d, ca === undefined ? closeAction : ca);
      } catch (e) {
        showToast("保存配置失败：" + String(e));
      }
    },
    [showToast, closeAction],
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

  const toggleTheme = useCallback(async () => {
    const next = !dark;
    setDark(next);
    await persistConfig(favorites, next);
  }, [dark, favorites, persistConfig]);

  // ---------- 列表派生数据 ----------

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = launchers.filter(
      (l) =>
        !q ||
        l.label.toLowerCase().includes(q) ||
        (l.path ?? "").toLowerCase().includes(q),
    );
    const fav = filtered.filter((l) => favorites.includes(l.key));
    const rest = filtered
      .filter((l) => !favorites.includes(l.key))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    return [...fav, ...rest];
  }, [launchers, favorites, search]);

  const selected = launchers.find((l) => l.key === selectedKey) ?? null;
  const missing = launchers.filter((l) => l.healthy === false);

  // ---------- 操作 ----------

  const launch = useCallback(
    async (key: string) => {
      const l = launchers.find((x) => x.key === key);
      if (!l) return;
      if (l.healthy === false) {
        showToast(`目录不存在，无法启动：${l.path}`);
        return;
      }
      try {
        await api.launchClaude(l.file);
      } catch (e) {
        showToast("启动失败：" + String(e));
      }
    },
    [launchers, showToast],
  );

  const openFolder = useCallback(
    async (l: Launcher) => {
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
    async (l: Launcher) => {
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

  const removeLauncher = useCallback(
    async (l: Launcher) => {
      try {
        await api.deleteLauncher(l.file);
      } catch (e) {
        showToast("删除失败：" + String(e));
        return;
      }
      const favs = favorites.filter((f) => f !== l.key);
      if (favs.length !== favorites.length) {
        setFavorites(favs);
        await persistConfig(favs, dark);
      }
      await load();
      showToast(`已删除 ${l.label}`);
    },
    [favorites, dark, persistConfig, load, showToast],
  );

  const confirmRemove = useCallback(
    (l: Launcher) => {
      setConfirm({
        title: "移除启动脚本",
        message: `将永久删除以下启动脚本：\n\n${l.label}\n${l.file}\n\n继续？`,
        okText: "删除",
        danger: true,
        onOk: () => removeLauncher(l),
      });
    },
    [removeLauncher],
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
        canLaunch={!!selected && selected.healthy !== false}
        onLaunch={() => selected && launch(selected.key)}
        onNew={() => setDialog("new")}
        onBatch={() => setDialog("batch")}
        onHealth={() => setDialog("health")}
        onOpenFolder={() => selected && openFolder(selected)}
      />

      <main className="main">
        <ProjectList
          items={sorted}
          favorites={favorites}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          onLaunch={launch}
          onOpenFolder={(key) => {
            const l = launchers.find((x) => x.key === key);
            if (l?.path) openFolder(l);
          }}
          onToggleFav={toggleFav}
          onContextMenu={(x, y, key) => setMenu({ x, y, key })}
        />
      </main>

      <StatusBar
        total={launchers.length}
        favCount={favorites.length}
        missingCount={missing.length}
        claudeOk={claudeOk}
        workspaceRoot={workspaceRoot}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          launcher={launchers.find((l) => l.key === menu.key) ?? null}
          favorites={favorites}
          onClose={() => setMenu(null)}
          onToggleFav={toggleFav}
          onOpenFolder={openFolder}
          onCopyPath={copyPath}
          onRemove={confirmRemove}
          onHealth={() => {
            setMenu(null);
            setDialog("health");
          }}
        />
      )}

      {dialog === "new" && (
        <NewLauncherDialog
          workspaceRoot={workspaceRoot}
          onClose={() => setDialog(null)}
          onCreated={async () => {
            setDialog(null);
            await load();
          }}
        />
      )}

      {dialog === "batch" && (
        <BatchAddDialog
          workspaceRoot={workspaceRoot}
          onClose={() => setDialog(null)}
          onDone={async (count) => {
            setDialog(null);
            await load();
            showToast(`批量添加完成：新增 ${count} 个启动脚本`);
          }}
        />
      )}

      {dialog === "health" && (
        <HealthDialog
          launchers={launchers}
          claudeOk={claudeOk}
          onClose={() => setDialog(null)}
          onDelete={async (items) => {
            for (const l of items) await removeLauncher(l);
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
