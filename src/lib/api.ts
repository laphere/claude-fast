import { invoke } from "@tauri-apps/api/core";
import type { Config, CreateResult, Launcher, WorkspaceProject } from "../types";

/** Tauri 后端命令封装 */
export const api = {
  listLaunchers: () => invoke<Launcher[]>("list_launchers"),
  loadConfig: () => invoke<Config>("load_config"),
  saveConfig: (favorites: string[], dark: boolean) =>
    invoke<void>("save_config", { favorites, dark }),
  createLauncher: (dir: string) => invoke<CreateResult>("create_launcher", { dir }),
  deleteLauncher: (file: string) => invoke<void>("delete_launcher", { file }),
  launchClaude: (file: string) => invoke<void>("launch_claude", { file }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  checkClaude: () => invoke<boolean>("check_claude"),
  checkLaunchers: (paths: string[]) =>
    invoke<boolean[]>("check_launchers", { paths }),
  scanWorkspace: () => invoke<WorkspaceProject[]>("scan_workspace"),
  getWorkspaceRoot: () => invoke<string>("get_workspace_root"),
  getDataRoot: () => invoke<{ path: string; installMode: boolean }>("get_data_root"),
};
