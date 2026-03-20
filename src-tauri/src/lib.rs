use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(not(debug_assertions))]
use serde::Deserialize;
use serde::Serialize;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

/// Holds the sidecar PID so it can be killed on app exit.
struct SidecarPid(Mutex<Option<u32>>);

/// Holds the version string of a pending update, if any.
struct PendingUpdate(Mutex<Option<String>>);

/// Returns the expected symlink/install path for the CLI on this platform.
fn cli_install_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/usr/local/bin/hotsheet")
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".local/bin/hotsheet")
    }
    #[cfg(target_os = "windows")]
    {
        let local_app_data =
            std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\Users\\Public".to_string());
        PathBuf::from(local_app_data)
            .join("Programs")
            .join("hotsheet")
            .join("hotsheet.cmd")
    }
}

/// Returns the path to the CLI script bundled in the app resources.
fn cli_source_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        Ok(resource_dir.join("resources").join("hotsheet"))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(resource_dir.join("resources").join("hotsheet-linux"))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(resource_dir.join("resources").join("hotsheet.cmd"))
    }
}

/// Returns the manual command string for installing the CLI.
fn manual_install_command(source: &PathBuf, dest: &PathBuf) -> String {
    #[cfg(target_os = "macos")]
    {
        format!(
            "sudo sh -c 'mkdir -p \"{}\" && ln -sf \"{}\" \"{}\"'",
            dest.parent().unwrap_or(dest).display(),
            source.display(),
            dest.display()
        )
    }
    #[cfg(target_os = "linux")]
    {
        format!(
            "mkdir -p \"{}\" && ln -sf \"{}\" \"{}\"",
            dest.parent().unwrap_or(dest).display(),
            source.display(),
            dest.display()
        )
    }
    #[cfg(target_os = "windows")]
    {
        format!(
            "mkdir \"{}\" && copy \"{}\" \"{}\"",
            dest.parent().unwrap_or(dest).display(),
            source.display(),
            dest.display()
        )
    }
}

#[cfg(not(debug_assertions))]
#[derive(Deserialize, Default)]
struct DataDirSettings {
    #[serde(default, alias = "App Name")]
    #[serde(rename = "appName")]
    app_name: Option<String>,
}

#[cfg(not(debug_assertions))]
/// Determines the app/window title from .hotsheet/settings.json or the parent folder name.
fn resolve_app_name(data_dir: &str) -> String {
    let data_path = std::fs::canonicalize(data_dir)
        .unwrap_or_else(|_| std::path::PathBuf::from(data_dir));

    // Try reading settings.json from the data directory
    let settings_path = data_path.join("settings.json");
    if let Ok(contents) = std::fs::read_to_string(&settings_path) {
        if let Ok(settings) = serde_json::from_str::<DataDirSettings>(&contents) {
            if let Some(name) = settings.app_name {
                if !name.is_empty() {
                    return name;
                }
            }
        }
    }

    // Fall back to the parent folder name (e.g., .hotsheet's parent = project dir)
    if let Some(project_dir) = data_path.parent() {
        if let Some(name) = project_dir.file_name() {
            return format!("Hot Sheet — {}", name.to_string_lossy());
        }
    }

    "Hot Sheet".to_string()
}

#[derive(Serialize)]
struct CliStatus {
    installed: bool,
    manual_command: String,
}

#[tauri::command]
fn check_cli_installed(app: tauri::AppHandle) -> Result<CliStatus, String> {
    let dest = cli_install_path();
    let source = cli_source_path(&app)?;
    let installed = dest.exists();
    let manual_command = manual_install_command(&source, &dest);
    Ok(CliStatus {
        installed,
        manual_command,
    })
}

#[derive(Serialize)]
struct InstallResult {
    path: String,
}

#[tauri::command]
fn get_pending_update(app: tauri::AppHandle) -> Option<String> {
    app.state::<PendingUpdate>().0.lock().unwrap().clone()
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(not(debug_assertions))]
    {
        let updater = app.updater().map_err(|e| format!("{e}"))?;
        let update = updater.check().await.map_err(|e| format!("{e}"))?;
        if let Some(update) = update {
            *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update.version.clone());
            return Ok(Some(update.version));
        }
        return Ok(None);
    }
    #[allow(unreachable_code)]
    {
        let _ = &app;
        Ok(None)
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        *app.state::<PendingUpdate>().0.lock().unwrap() = None;
        let updater = app.updater().map_err(|e| format!("{e}"))?;
        let update = updater
            .check()
            .await
            .map_err(|e| format!("{e}"))?;
        if let Some(update) = update {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("{e}"))?;
        }
    }
    let _ = &app;
    Ok(())
}

#[tauri::command]
fn install_cli(app: tauri::AppHandle) -> Result<InstallResult, String> {
    let source = cli_source_path(&app)?;
    let dest = cli_install_path();

    if !source.exists() {
        return Err(format!(
            "CLI script not found in app bundle: {}",
            source.display()
        ));
    }

    #[cfg(target_os = "macos")]
    {
        // Use osascript to get admin privileges for /usr/local/bin
        let dest_dir = dest.parent().unwrap_or(&dest);
        let status = std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"mkdir -p '{}' && ln -sf '{}' '{}'\" with administrator privileges",
                    dest_dir.display(),
                    source.display(),
                    dest.display()
                ),
            ])
            .status()
            .map_err(|e| format!("Failed to run osascript: {e}"))?;

        if !status.success() {
            return Err("Installation cancelled or failed".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Create ~/.local/bin if needed, then symlink
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        // Remove existing symlink/file if present
        let _ = std::fs::remove_file(&dest);
        std::os::unix::fs::symlink(&source, &dest)
            .map_err(|e| format!("Failed to create symlink: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Copy the .cmd file to the install location
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        std::fs::copy(&source, &dest)
            .map_err(|e| format!("Failed to copy CLI script: {e}"))?;

        // Add to user PATH via registry
        let output = std::process::Command::new("reg")
            .args([
                "query",
                "HKCU\\Environment",
                "/v",
                "Path",
            ])
            .output();

        if let Ok(output) = output {
            let current_path = String::from_utf8_lossy(&output.stdout).to_string();
            let install_dir = dest.parent().unwrap_or(&dest).to_string_lossy().to_string();
            if !current_path.contains(&install_dir) {
                // Extract current PATH value
                let path_value = current_path
                    .lines()
                    .find(|l| l.contains("REG_EXPAND_SZ") || l.contains("REG_SZ"))
                    .and_then(|l| l.split("    ").last())
                    .unwrap_or("")
                    .trim();

                let new_path = if path_value.is_empty() {
                    install_dir
                } else {
                    format!("{};{}", path_value, install_dir)
                };

                let _ = std::process::Command::new("reg")
                    .args([
                        "add",
                        "HKCU\\Environment",
                        "/v",
                        "Path",
                        "/t",
                        "REG_EXPAND_SZ",
                        "/d",
                        &new_path,
                        "/f",
                    ])
                    .status();
            }
        }
    }

    Ok(InstallResult {
        path: dest.to_string_lossy().to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SidecarPid(Mutex::new(None)))
        .manage(PendingUpdate(Mutex::new(None)))
        .menu(|app| {
            // Custom Undo/Redo items that route to JavaScript instead of native WebView undo.
            // Predefined Undo/Redo would intercept Cmd+Z before the WebView sees it.
            let undo_item = MenuItemBuilder::new("Undo")
                .id("app-undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?;
            let redo_item = MenuItemBuilder::new("Redo")
                .id("app-redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Hot Sheet")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&undo_item)
                .item(&redo_item)
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "app-undo" || id == "app-redo" {
                if let Some(window) = app.get_webview_window("main") {
                    let js_event = if id == "app-undo" { "app:undo" } else { "app:redo" };
                    let _ = window.eval(&format!(
                        "window.dispatchEvent(new Event('{}'))",
                        js_event
                    ));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_cli_installed,
            install_cli,
            get_pending_update,
            check_for_update,
            install_update
        ])
        .setup(|_app| {
            #[allow(unused_variables)]
            let app = _app;

            // --- Dev mode: spawn Node server directly via tsx ---
            #[cfg(debug_assertions)]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");

                let app_args: Vec<String> = std::env::args().collect();
                let mut server_args = vec![
                    "tsx".to_string(),
                    "--tsconfig".to_string(),
                    "tsconfig.json".to_string(),
                    "src/cli.ts".to_string(),
                    "--no-open".to_string(),
                ];
                if let Some(i) = app_args.iter().position(|a| a == "--data-dir") {
                    if let Some(dir) = app_args.get(i + 1) {
                        server_args.push("--data-dir".to_string());
                        server_args.push(dir.clone());
                    }
                }

                // The Rust binary runs from src-tauri/, so set cwd to the project root
                let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
                let mut child = std::process::Command::new("npx")
                    .args(&server_args)
                    .current_dir(project_root)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                    .expect("Failed to start dev server (is npx/tsx installed?)");

                *app.state::<SidecarPid>().0.lock().unwrap() = Some(child.id());

                let stdout = child.stdout.take().expect("Failed to capture stdout");
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        println!("{}", line);
                        if let Some(idx) = line.find("running at ") {
                            let url = line[idx + "running at ".len()..].trim().to_string();
                            if let Ok(parsed) = url.parse() {
                                let _ = window.navigate(parsed);
                            }
                            break;
                        }
                    }
                    // Keep child alive until app exits
                    let _ = child.wait();
                });
            }

            // --- Production mode: spawn sidecar or connect to pre-started server ---
            #[cfg(not(debug_assertions))]
            {
                let app_args: Vec<String> = std::env::args().collect();
                let has_data_dir = app_args.iter().any(|a| a == "--data-dir");

                if !has_data_dir {
                    // No --data-dir: show the welcome/setup screen
                    let window = app
                        .get_webview_window("main")
                        .expect("main window not found");
                    let _ = window.navigate("tauri://localhost/welcome.html".parse().unwrap());

                    // Check for updates (store version for user-initiated install)
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let Ok(updater) = handle.updater() else {
                            return;
                        };
                        let Ok(Some(update)) = updater.check().await else {
                            return;
                        };
                        *handle.state::<PendingUpdate>().0.lock().unwrap() =
                            Some(update.version);
                    });

                    return Ok(());
                }

                // Set window title from settings or project folder name
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");
                if let Some(i) = app_args.iter().position(|a| a == "--data-dir") {
                    if let Some(dir) = app_args.get(i + 1) {
                        let name = resolve_app_name(dir);
                        let _ = window.set_title(&name);
                    }
                }

                // Check if the CLI launcher already started the server
                if let Ok(server_url) = std::env::var("HOTSHEET_SERVER_URL") {
                    // Navigate directly to the pre-started server
                    if let Ok(parsed) = server_url.parse() {
                        let _ = window.navigate(parsed);
                    }

                    // Store the pre-started server PID for cleanup on exit
                    if let Ok(pid_str) = std::env::var("HOTSHEET_SIDECAR_PID") {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            *app.state::<SidecarPid>().0.lock().unwrap() = Some(pid);
                        }
                    }
                } else {
                    // No pre-started server — spawn sidecar ourselves
                    let resource_dir = app
                        .path()
                        .resource_dir()
                        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
                    let cli_js = resource_dir.join("server").join("cli.js");

                    let mut sidecar_args = vec![
                        cli_js.to_string_lossy().to_string(),
                        "--no-open".to_string(),
                    ];
                    if let Some(i) = app_args.iter().position(|a| a == "--data-dir") {
                        if let Some(dir) = app_args.get(i + 1) {
                            sidecar_args.push("--data-dir".to_string());
                            sidecar_args.push(dir.clone());
                        }
                    }

                    let sidecar = app
                        .shell()
                        .sidecar("hotsheet-node")
                        .map_err(|e| format!("Failed to create sidecar command: {e}"))?;

                    let args_refs: Vec<&str> = sidecar_args.iter().map(|s| s.as_str()).collect();
                    let (mut rx, child) = sidecar
                        .args(&args_refs)
                        .spawn()
                        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

                    let sidecar_pid = child.pid();
                    *app.state::<SidecarPid>().0.lock().unwrap() = Some(sidecar_pid);

                    tauri::async_runtime::spawn(async move {
                        let _child = child;
                        let mut navigated = false;
                        while let Some(event) = rx.recv().await {
                            if let CommandEvent::Stdout(line) = event {
                                if !navigated {
                                    let line_str = String::from_utf8_lossy(&line);
                                    if let Some(idx) = line_str.find("running at ") {
                                        let url =
                                            line_str[idx + "running at ".len()..].trim();
                                        if let Ok(parsed) = url.parse() {
                                            let _ = window.navigate(parsed);
                                            navigated = true;
                                        }
                                    }
                                }
                            }
                        }
                    });
                }

                // Check for updates (store version for user-initiated install)
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let Ok(updater) = handle.updater() else {
                        return;
                    };
                    let Ok(Some(update)) = updater.check().await else {
                        return;
                    };
                    *handle.state::<PendingUpdate>().0.lock().unwrap() =
                        Some(update.version);
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill the sidecar process on app exit
                if let Some(pid) = app_handle.state::<SidecarPid>().0.lock().unwrap().take() {
                    #[cfg(unix)]
                    {
                        // Kill the sidecar process directly, then try process group as a fallback.
                        // Direct kill is needed because on the CLI launcher path, the Node process
                        // is backgrounded from a non-interactive shell and is NOT a process group
                        // leader — so kill(-pid, SIGTERM) would silently fail.
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                            libc::kill(-(pid as i32), libc::SIGTERM);
                        }
                    }
                    #[cfg(windows)]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .status();
                    }
                }
            }
        });
}
