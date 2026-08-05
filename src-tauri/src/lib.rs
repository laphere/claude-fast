use serde::{Deserialize, Serialize};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 控制台子进程不创建新窗口（GUI 主进程 spawn where 等工具时防止闪黑窗口）
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const WORKSPACE_ROOT: &str = "D:\\MyWorkspaces";
/// 启动脚本专用目录（相对数据根目录）
const SCRIPTS_DIR: &str = "scripts";

// ---------------- 数据模型 ----------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Launcher {
    label: String,
    path: Option<String>,
    file: String,
    key: String,
    // healthy 不在 list_launchers 中计算（避免启动时阻塞在目录检查上），
    // 由前端调用 check_launchers 异步获取后回填。
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    favorites: Vec<String>,
    dark: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    file: String,
    existed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    path: String,
    install_mode: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    name: String,
    path: String,
}

// ---------------- 路径定位 ----------------

/// 判断目录是否为数据根：新布局（config.json + scripts/ 子目录）或旧布局
/// （根目录直接放 claude-claude-fast.bat）
fn is_root_dir(dir: &Path) -> bool {
    (dir.join("config.json").is_file() && dir.join(SCRIPTS_DIR).is_dir())
        || dir.join("claude-claude-fast.bat").is_file()
}

/// 安装模式数据根：%APPDATA%\claude-fast（Windows）/
/// ~/Library/Application Support/claude-fast（macOS）。
/// 安装包模式下 exe 位于 Program Files（只读），用户数据统一放这里。
fn app_data_root() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA").unwrap_or_default();
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(|h| format!("{}/Library/Application Support", h))
        .unwrap_or_default();
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(base).join("claude-fast")
}

/// 定位数据根目录（双模式）：
/// 1. **便携模式**：exe 所在目录向上逐级查找首个根目录标记
///    （config.json + scripts/，或旧标记 claude-claude-fast.bat）——
///    开发目录、整体移动的文件夹、绿色版均走此路径。
/// 2. **安装模式**：找不到便携标记时回退到应用数据目录
///    （%APPDATA%\claude-fast），首次运行自动创建 scripts/ 子目录。
fn resolve_root_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let mut dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    for _ in 0..6 {
        if is_root_dir(&dir) {
            return dir;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    // 安装模式：应用数据目录（幂等创建 scripts/，保证「安装后自动生效」）
    let app = app_data_root();
    let _ = fs::create_dir_all(app.join(SCRIPTS_DIR));
    app
}

/// 启动脚本目录（数据根下）
fn scripts_dir() -> PathBuf {
    resolve_root_dir().join(SCRIPTS_DIR)
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

fn read_config_file(path: &Path) -> Option<Config> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(strip_bom(&raw)).ok()
}

/// 从启动脚本内容解析 `cd /d "..."` 中的目录路径（兼容带引号/不带引号）
fn parse_cd_path(content: &str) -> Option<String> {
    for line in content.lines() {
        let t = line.trim();
        if t.to_ascii_lowercase().starts_with("cd /d") {
            let rest = t[5..].trim();
            if let Some(stripped) = rest.strip_prefix('"') {
                if let Some(end) = stripped.find('"') {
                    return Some(stripped[..end].to_string());
                }
            } else {
                let p = rest.split_whitespace().next().unwrap_or("");
                if !p.is_empty() {
                    return Some(p.to_string());
                }
            }
        }
    }
    None
}

// ---------------- commands ----------------

#[tauri::command]
fn list_launchers() -> Vec<Launcher> {
    let mut files: Vec<PathBuf> = fs::read_dir(scripts_dir())
        .map(|entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.is_file()
                        && p.extension()
                            .map(|e| e.eq_ignore_ascii_case("bat"))
                            .unwrap_or(false)
                        && p.file_stem()
                            .map(|s| s.to_string_lossy().to_lowercase().starts_with("claude-"))
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();

    files
        .into_iter()
        .map(|f| {
            let key = f.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let label = key.strip_prefix("claude-").unwrap_or(&key).to_string();
            let content = fs::read_to_string(&f).unwrap_or_default();
            let path = parse_cd_path(&content);
            Launcher {
                label,
                path,
                file: f.to_string_lossy().to_string(),
                key,
            }
        })
        .collect()
}

/// 读取配置：主文件损坏时自动回退到 .bak 并恢复主文件（收藏不丢失）
#[tauri::command]
fn load_config() -> Config {
    let root = resolve_root_dir();
    let cfg_path = root.join("config.json");
    let bak_path = root.join("config.json.bak");
    if let Some(c) = read_config_file(&cfg_path) {
        return c;
    }
    if let Some(c) = read_config_file(&bak_path) {
        let _ = fs::copy(&bak_path, &cfg_path);
        return c;
    }
    Config::default()
}

/// 保存配置：写临时文件 → 旧文件备份为 .bak → 原子替换
#[tauri::command]
fn save_config(favorites: Vec<String>, dark: bool) -> Result<(), String> {
    let root = resolve_root_dir();
    let cfg = Config { favorites, dark };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    let bak_path = root.join("config.json.bak");
    let tmp_path = root.join("config.json.tmp");
    fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    if cfg_path.exists() {
        fs::copy(&cfg_path, &bak_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, &cfg_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 生成启动脚本文件名：相对 WORKSPACE_ROOT 的路径（反斜杠转 -），
/// 工作区外的路径用叶子目录名
fn build_bat_name(dir: &str) -> String {
    let lower = dir.to_lowercase();
    let ws = WORKSPACE_ROOT.to_lowercase();
    let rel = if lower.starts_with(&ws) {
        dir[WORKSPACE_ROOT.len()..].trim_start_matches('\\').to_string()
    } else {
        Path::new(dir)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let safe: String = rel
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let safe = safe.trim_matches('-').to_string();
    let safe = if safe.is_empty() { "project".to_string() } else { safe };
    format!("claude-{}.bat", safe)
}

/// 与旧版 PowerShell 完全一致的 bat 模板
fn gen_bat(dir: &str, leaf: &str) -> String {
    format!(
        "@echo off\r\nchcp 65001 >nul\r\ntitle Claude Code - {leaf}\r\n\
         cd /d \"{dir}\" || goto :err\r\nwhere claude >nul 2>nul || goto :err\r\n\
         call claude\r\nif errorlevel 1 goto :err\r\nexit /b 0\r\n\
         :err\r\necho [错误] 启动失败：目录不存在或 claude 命令未找到。\r\npause\r\n"
    )
}

#[tauri::command]
fn create_launcher(dir: String) -> Result<CreateResult, String> {
    let dir_path = Path::new(&dir);
    if !dir_path.is_dir() {
        return Err("路径不存在或不是文件夹".to_string());
    }
    let bat_name = build_bat_name(&dir);
    let scripts = scripts_dir();
    fs::create_dir_all(&scripts).map_err(|e| e.to_string())?;
    let bat_path = scripts.join(&bat_name);
    let existed = bat_path.exists();
    let leaf = dir_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    fs::write(&bat_path, gen_bat(&dir, &leaf)).map_err(|e| e.to_string())?;
    Ok(CreateResult {
        file: bat_path.to_string_lossy().to_string(),
        existed,
    })
}

#[tauri::command]
fn delete_launcher(file: String) -> Result<(), String> {
    let p = Path::new(&file);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 启动 Claude：用 ShellExecuteW 打开 cmd（等效双击，stdio 正确连接新控制台）。
/// 不能再用 `Command::new("cmd").args(["/c", "\"path\""])`：Rust 的 args 在 Windows 上
/// 会按 CommandLineToArgvW 规则把引号转义成 `\"`，而 cmd 不认 `\"` 转义，
/// 会把 `\"path\"` 当命令名报「不是内部或外部命令」秒退（窗口一闪而过）。
#[tauri::command]
fn launch_claude(file: String) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

    let root = resolve_root_dir();
    let cmdline = format!("/c \"{}\"", file);
    let exe: Vec<u16> = "cmd.exe".encode_utf16().chain(Some(0)).collect();
    let params: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
    let dir: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let res = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            std::ptr::null(),
            exe.as_ptr(),
            params.as_ptr(),
            dir.as_ptr(),
            SW_SHOW,
        )
    };
    if res as isize > 32 {
        Ok(())
    } else {
        Err(format!("启动失败（ShellExecute 返回 {}）", res as isize))
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// claude 命令可用性检查：在阻塞线程池中执行，不阻塞主线程/UI。
/// `where` 可能因 PATH 含慢速目录（网络盘等）卡住，限制 3 秒超时。
#[tauri::command]
async fn check_claude() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(mut child) = Command::new("where")
            .arg("claude")
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// 健康检查：并行检查各启动脚本指向的目录是否存在（在阻塞线程池中执行，
/// 不阻塞主线程/UI；某个路径卡住时其余结果不受影响）
#[tauri::command]
async fn check_launchers(paths: Vec<String>) -> Vec<bool> {
    let mut tasks = Vec::with_capacity(paths.len());
    for p in paths {
        tasks.push(tauri::async_runtime::spawn_blocking(move || {
            Path::new(&p).is_dir()
        }));
    }
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        out.push(t.await.unwrap_or(false));
    }
    out
}

/// 批量添加：扫描工作区下含 CLAUDE.md 或 .git 的项目目录（最多 3 层）
fn scan_dir(dir: &Path, rel: &str, depth: usize, out: &mut Vec<WorkspaceProject>) {
    if depth >= 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut subdirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    subdirs.sort();
    for sub in subdirs {
        let name = sub
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let sub_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}\\{}", rel, name)
        };
        if sub.join("CLAUDE.md").is_file() || sub.join(".git").exists() {
            out.push(WorkspaceProject {
                name: sub_rel.replace('\\', "-"),
                path: sub.to_string_lossy().to_string(),
            });
        }
        scan_dir(&sub, &sub_rel, depth + 1, out);
    }
}

/// 批量添加：扫描工作区（在阻塞线程池中执行，避免冻结 UI）
#[tauri::command]
async fn scan_workspace() -> Vec<WorkspaceProject> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        scan_dir(Path::new(WORKSPACE_ROOT), "", 0, &mut out);
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn get_workspace_root() -> String {
    WORKSPACE_ROOT.to_string()
}

/// 返回数据根信息：path = 数据根目录；installMode = true 表示处于安装模式
/// （数据根在 %APPDATA% 而非 exe 所在目录）
#[tauri::command]
fn get_data_root() -> DataRootInfo {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let root = resolve_root_dir();
    DataRootInfo {
        path: root.to_string_lossy().to_string(),
        install_mode: root != exe_dir,
    }
}

// ---------------- 入口 ----------------

// ---------------- 单元测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "claude-fast-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn parse_cd_quoted() {
        assert_eq!(
            parse_cd_path("@echo off\r\nchcp 65001 >nul\r\ncd /d \"D:\\MyWorkspaces\\yaotu\\tdc\""),
            Some("D:\\MyWorkspaces\\yaotu\\tdc".to_string())
        );
    }

    #[test]
    fn parse_cd_unquoted() {
        assert_eq!(
            parse_cd_path("cd /d C:\\proj"),
            Some("C:\\proj".to_string())
        );
    }

    #[test]
    fn parse_cd_missing() {
        assert_eq!(parse_cd_path("@echo off\r\necho hi"), None);
    }

    #[test]
    fn parse_cd_case_insensitive() {
        assert_eq!(
            parse_cd_path("CD /D \"X:\\y z\""),
            Some("X:\\y z".to_string())
        );
    }

    #[test]
    fn strip_bom_works() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"{\"a\":1}");
        let c: serde_json::Value = serde_json::from_slice(strip_bom(&b)).unwrap();
        assert_eq!(c["a"], 1);
    }

    #[test]
    fn bat_name_inside_workspace() {
        assert_eq!(
            build_bat_name("D:\\MyWorkspaces\\yaotu\\tdc"),
            "claude-yaotu-tdc.bat"
        );
        assert_eq!(
            build_bat_name("D:\\MyWorkspaces\\proj a\\sub"),
            "claude-proj a-sub.bat"
        );
    }

    #[test]
    fn bat_name_outside_workspace_uses_leaf() {
        assert_eq!(
            build_bat_name("C:\\Users\\me\\stuff\\myproj"),
            "claude-myproj.bat"
        );
    }

    #[test]
    fn bat_name_safe_chars() {
        assert_eq!(
            build_bat_name("D:\\MyWorkspaces\\a:b\\c<d"),
            "claude-a-b-c-d.bat"
        );
        assert_eq!(build_bat_name("D:\\MyWorkspaces\\"), "claude-project.bat");
    }

    #[test]
    fn gen_bat_template() {
        let bat = gen_bat("D:\\MyWorkspaces\\tdc", "tdc");
        assert!(bat.starts_with("@echo off\r\n"));
        assert!(bat.contains("chcp 65001"));
        assert!(bat.contains("cd /d \"D:\\MyWorkspaces\\tdc\""));
        assert!(bat.contains("call claude"));
        assert!(bat.contains(":err"));
        assert!(!bat.contains('\n') || bat.contains("\r\n"));
    }

    #[test]
    fn scan_finds_projects_only() {
        let root = temp_root("scan");
        let git_p = root.join("proj-git");
        fs::create_dir_all(&git_p).unwrap();
        fs::write(git_p.join(".git"), "").unwrap();
        let md_p = root.join("proj-md");
        fs::create_dir_all(&md_p).unwrap();
        fs::write(md_p.join("CLAUDE.md"), "").unwrap();
        let none_p = root.join("plain");
        fs::create_dir_all(&none_p).unwrap();
        fs::write(none_p.join("readme.txt"), "").unwrap();
        let hidden_p = root.join(".hidden");
        fs::create_dir_all(&hidden_p).unwrap();
        fs::write(hidden_p.join("CLAUDE.md"), "").unwrap();
        let nm_p = root.join("node_modules");
        fs::create_dir_all(&nm_p).unwrap();
        fs::write(nm_p.join("CLAUDE.md"), "").unwrap();

        let mut out = Vec::new();
        scan_dir(&root, "", 0, &mut out);
        let names: Vec<&str> = out.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["proj-git", "proj-md"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolve_root_finds_project() {
        let root = resolve_root_dir();
        // 新布局：config.json + scripts/ 子目录
        assert!(root.join("config.json").is_file());
        assert!(root.join(SCRIPTS_DIR).is_dir());
        // 兼容旧标记
        assert!(is_root_dir(&root));
    }

    #[test]
    fn is_root_dir_detects_layouts() {
        let root = temp_root("root");
        // 新布局
        fs::write(root.join("config.json"), "{}").unwrap();
        fs::create_dir_all(root.join(SCRIPTS_DIR)).unwrap();
        assert!(is_root_dir(&root));
        // 只有 config.json 没有 scripts 目录 → 不是根
        fs::remove_dir_all(root.join(SCRIPTS_DIR)).unwrap();
        assert!(!is_root_dir(&root));
        // 旧布局：claude-claude-fast.bat
        fs::write(root.join("claude-claude-fast.bat"), "").unwrap();
        assert!(is_root_dir(&root));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn app_data_root_points_to_claude_fast() {
        let p = app_data_root();
        assert!(!p.as_os_str().is_empty());
        let s = p.to_string_lossy().to_lowercase();
        assert!(s.contains("claude-fast"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_launchers,
            check_launchers,
            load_config,
            save_config,
            create_launcher,
            delete_launcher,
            launch_claude,
            open_folder,
            check_claude,
            scan_workspace,
            get_workspace_root,
            get_data_root
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
