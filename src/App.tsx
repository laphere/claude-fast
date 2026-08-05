import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import type { Launcher } from "./types";
import Header from "./components/Header";
import Toolbar from "./components/Toolbar";
import ProjectList from "./components/ProjectList";
import StatusBar from "./components/StatusBar";
import ContextMenu from "./components/ContextMenu";
import NewLauncherDialog from "./components/NewLauncherDialog";
import BatchAddDialog from "./components/BatchAddDialog";
import HealthDialog from "./components/HealthDialog";
import ConfirmDialog from "./components/ConfirmDialog";

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

  // ---------- 数据加载 ----------

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listLaunchers(), api.loadConfig()]);
      setLaunchers(list);
      setFavorites(cfg.favorites ?? []);
      setDark(cfg.dark ?? false);
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
    async (favs: string[], d: boolean) => {
      try {
        await api.saveConfig(favs, d);
      } catch (e) {
        showToast("保存配置失败：" + String(e));
      }
    },
    [showToast],
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
