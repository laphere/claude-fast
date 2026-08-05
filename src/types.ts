export interface Launcher {
  label: string;
  path: string | null;
  file: string;
  key: string;
  /** undefined = 尚未检查（启动时秒渲染，后台异步检查后回填） */
  healthy?: boolean;
}

export interface Config {
  favorites: string[];
  dark: boolean;
}

export interface CreateResult {
  file: string;
  existed: boolean;
}

export interface WorkspaceProject {
  name: string;
  path: string;
}
