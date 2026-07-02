use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(not(debug_assertions))]
use serde::Deserialize;
use serde::Serialize;
use tauri::Manager;
use tauri::Emitter;
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

/// §78 Announcer (HS-8747) — holds the PID of the currently-speaking `say`
/// child so `tts_stop` can interrupt it (play/pause/skip in the announcer
/// PIP). Only one announcer utterance plays at a time, so a single slot is
/// enough; `tts_speak` overwrites it (killing any prior child first) and
/// clears it when the child exits.
struct TtsChild(Mutex<Option<u32>>);

/// HS-7596 / §37 — quit-confirm gate. The CloseRequested handler intercepts
/// every quit attempt (⌘Q, traffic-light close, Alt+F4) and emits a
/// `quit-confirm-requested` event to the JS frontend. The JS frontend runs
/// the §37 confirm flow and either calls the `confirm_quit` Tauri command
/// (which sets this flag to true and re-issues window.close) or calls
/// `cancel_quit` (which is a no-op since the original close was already
/// prevented). The flag is checked at the top of the CloseRequested handler
/// — if true, the close proceeds normally.
struct QuitConfirmed(AtomicBool);

/// HS-8911 — set by `confirm_quit` once the user has committed to quitting and
/// the sidecar's graceful shutdown has been started. While true, the sidecar's
/// stdout `[lifecycle:progress]` markers are streamed to the webview (so the
/// "Shutting Down" overlay can name the current step), and the sidecar's exit
/// triggers `app.exit(0)` — instead of `confirm_quit` exiting immediately and
/// leaving the OS to beachball the app while the sidecar drains.
struct ShuttingDown(AtomicBool);

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

/// Forward Hot Sheet CLI flags from the Tauri binary's argv to the spawned server.
/// Tauri-controlled flags (`--no-open`, `--replace`, `--data-dir`) and early-exit flags
/// (`--close`, `--list`, `--help`) are intentionally excluded — the caller handles
/// data dir resolution itself and the early-exit flags would kill the server child
/// before the window can navigate.
fn collect_forwarded_server_args(app_args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < app_args.len() {
        let a = &app_args[i];
        if a.starts_with("--demo:") {
            out.push(a.clone());
        } else if a == "--check-for-updates" || a == "--strict-port" || a == "--force" || a == "--test" {
            // HS-8921 — `--test` forwards to the sidecar so a Tauri dev launch
            // can run the isolated test instance. Its own `HOTSHEET_HOME` /
            // `instance.json` keeps it from fighting the prod `--replace`.
            out.push(a.clone());
        } else if a == "--port" {
            if let Some(v) = app_args.get(i + 1) {
                out.push(a.clone());
                out.push(v.clone());
                i += 1;
            }
        }
        i += 1;
    }
    out
}

/// HS-8704 (option A — self-diagnosing launch): mirror a startup diagnostic
/// line to BOTH stderr (visible only on a terminal launch) AND
/// `~/.hotsheet/startup.log` — the only record that survives a GUI launch
/// (Dock / Spotlight / Finder), where the process has no controlling terminal
/// and every `eprintln!` vanishes ("open -a 'Hot Sheet' hangs, but no logs are
/// shown"). The Node sidecar appends its own `[startup +Nms] …` phase markers
/// to the SAME file (see `src/startup-log.ts`), so the two processes interleave
/// by timestamp into one launch timeline. Best-effort: any filesystem error is
/// swallowed so logging never affects the launch. Release-only — dev builds
/// always run from a terminal.
#[cfg(not(debug_assertions))]
fn startup_log(msg: &str) {
    eprintln!("{msg}");
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    if let Some(home) = home {
        use std::io::Write;
        let dir = std::path::PathBuf::from(home).join(".hotsheet");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("startup.log"))
        {
            let _ = writeln!(f, "{msg}");
        }
    }
}

/// HS-8828 — quit/shutdown diagnostic logger. Unlike `startup_log` (release-
/// only) this is compiled into EVERY build, because the reported "app never
/// quits" hang reproduces under `npm run tauri:dev` — a debug build. Mirrors to
/// stderr (visible on a terminal / dev run) AND appends to
/// `~/.hotsheet/shutdown.log` so a GUI launch — where stderr is discarded —
/// still leaves a trail to pair with the Node sidecar's `[lifecycle] step …`
/// lines. Best-effort: any filesystem error is swallowed so logging never
/// affects the quit path.
fn shutdown_log(msg: &str) {
    eprintln!("[shutdown] {msg}");
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    if let Some(home) = home {
        use std::io::Write;
        let dir = std::path::PathBuf::from(home).join(".hotsheet");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("shutdown.log"))
        {
            let _ = writeln!(f, "{msg}");
        }
    }
}

/// HS-8828 — build the dev-mode (`npm run tauri:dev`) server child invocation.
/// Returns the args for `node` (program is always `node`).
///
/// We launch the server as `node --import tsx src/cli.ts …` rather than the old
/// `npx tsx …` ON PURPOSE. With `npx tsx`, the process we spawn (and whose PID
/// we store in `SidecarPid` to SIGTERM on quit) is the `npm exec` wrapper; the
/// real `cli.ts` Node process — the one carrying the SIGINT/SIGTERM
/// graceful-shutdown handler — is its GRANDCHILD (npx → tsx CLI → node cli.ts).
/// So `RunEvent::Exit`'s `kill(pid)` only ever hit the wrapper, the server was
/// orphaned, it kept the port + lockfile, and the app "never actually quit."
/// `node --import tsx` runs `cli.ts` IN the spawned process (verified
/// single-process with tsx 4.x), so `child.id()` IS the server and the quit
/// SIGTERM lands on its handler. `TSX_TSCONFIG_PATH=tsconfig.json` (set by the
/// caller) replaces the old `--tsconfig` CLI flag now that we use tsx as a
/// loader rather than its CLI.
#[cfg(debug_assertions)]
fn build_dev_server_args(app_args: &[String]) -> Vec<String> {
    let mut server_args = vec![
        "--import".to_string(),
        "tsx".to_string(),
        "src/cli.ts".to_string(),
        "--no-open".to_string(),
        "--replace".to_string(),
    ];
    if let Some(i) = app_args.iter().position(|a| a == "--data-dir") {
        if let Some(dir) = app_args.get(i + 1) {
            server_args.push("--data-dir".to_string());
            server_args.push(dir.clone());
        }
    }
    // Forward Hot Sheet CLI flags (--demo:N, --port, --strict-port, --force,
    // --check-for-updates) from the Tauri binary's argv into the server child.
    server_args.extend(collect_forwarded_server_args(app_args));
    server_args
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


#[tauri::command]
fn request_attention(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::UserAttentionType;
    let win = app.get_webview_window("main")
        .ok_or_else(|| "window 'main' not found".to_string())?;
    win.request_user_attention(Some(UserAttentionType::Critical))
        .map_err(|e| format!("request_user_attention failed: {}", e))?;
    Ok("bounce sent (critical)".to_string())
}

#[tauri::command]
fn request_attention_once(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::UserAttentionType;
    let win = app.get_webview_window("main")
        .ok_or_else(|| "window 'main' not found".to_string())?;
    win.request_user_attention(Some(UserAttentionType::Informational))
        .map_err(|e| format!("request_user_attention failed: {}", e))?;
    Ok("bounce sent (informational)".to_string())
}

#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// HS-8451 — update the native window title from the WKWebView side. Tauri does
/// not auto-sync `document.title` to the native window title bar, so a
/// `loadAppName()` / project-switch / dashboard-enter must explicitly invoke
/// this command for the desktop window chrome to reflect the new label.
#[tauri::command]
fn set_window_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    let win = app.get_webview_window("main")
        .ok_or_else(|| "window 'main' not found".to_string())?;
    win.set_title(&title).map_err(|e| e.to_string())
}

/// HS-7596 / §37 — flip the QuitConfirmed flag and re-issue the quit. Called
/// from JS after the user clicks "Quit Anyway" in the §37 confirm dialog.
/// Uses `app.exit(0)` (not `window.close()`) so the same code path covers
/// every quit trigger — red traffic-light close, ⌘Q via the macOS Quit menu
/// item, Alt+F4, or any future `app.exit()` call. With the flag set, both
/// the `WindowEvent::CloseRequested` handler AND the `RunEvent::ExitRequested`
/// handler pass-through and the resulting `RunEvent::Exit` kills the sidecar
/// as before.
#[tauri::command]
fn confirm_quit(app: tauri::AppHandle) -> Result<(), String> {
    shutdown_log("confirm_quit invoked");
    app.state::<QuitConfirmed>().0.store(true, Ordering::SeqCst);

    // HS-8911 — instead of `app.exit(0)` immediately (which tears down the
    // webview before the sidecar's bounded `gracefulShutdown` drains, leaving the
    // OS to beachball the exiting app), drive the drain WHILE the webview stays up
    // showing the "Shutting Down" overlay. SIGTERM the sidecar to start the
    // graceful shutdown; its stdout `[lifecycle:progress]` markers are streamed to
    // the overlay by the stdout readers below, and the sidecar's exit triggers
    // `app.exit(0)`. A safety timer force-exits if the sidecar never reports done.
    let pid = *app.state::<SidecarPid>().0.lock().unwrap();
    match pid {
        Some(pid) => {
            app.state::<ShuttingDown>().0.store(true, Ordering::SeqCst);
            shutdown_log(&format!("confirm_quit: starting graceful drain of sidecar pid={pid}"));
            #[cfg(unix)]
            unsafe {
                // SIGTERM → cli.ts's signal handler runs gracefulShutdown (snapshot,
                // DB close, …) then process.exit. Both the process and its group.
                libc::kill(pid as i32, libc::SIGTERM);
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                // Windows has no graceful SIGTERM for Node; taskkill is immediate,
                // so the overlay just flashes before the exit hook fires.
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status();
            }
            // Safety net: never let the overlay hang. The normal path is the
            // sidecar's own exit (detected on its stdout → app.exit). This timer
            // only bites if the sidecar somehow never exits. HS-9028 raised the
            // sidecar's heavy-step budget (HTTP drain + DB snapshot/close) to 90s
            // each, so the timer must sit PAST a legitimate slow drain — otherwise
            // it would force-exit mid-snapshot and lose the very work the longer
            // budget exists to protect. 95s = one 90s heavy step + buffer (a second
            // `app.exit` after the app is already gone is harmless).
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(95_000));
                shutdown_log("confirm_quit: safety timer fired — app.exit(0)");
                app2.exit(0);
            });
        }
        None => {
            // No sidecar to drain (rare) — exit immediately, the pre-HS-8911 path.
            shutdown_log("confirm_quit: no sidecar pid — app.exit(0)");
            app.exit(0);
        }
    }
    Ok(())
}

/// HS-7272: fire a native OS notification. Called from JS when an OSC 9
/// desktop-notification arrives while the Hot Sheet window is backgrounded
/// or unfocused (the in-app toast always fires alongside; native is the
/// extra channel for the not-currently-looking case). `title` is typically
/// the project name, `body` is the shell-pushed message. macOS routes this
/// through the user's Notification Center preferences; first fire may show
/// an OS-level permission prompt.
#[tauri::command]
async fn show_native_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// HS-8826 — build the OS Quick Look / open command for `platform`. macOS uses
/// `qlmanage -p <path>` (the CLI Quick Look preview panel); other platforms open
/// the file in its default app (`xdg-open` on Linux, `cmd /C start "" <path>` on
/// Windows — `start` is a `cmd.exe` builtin, not an executable, so the previous
/// `Command::new("start")` form never actually launched anything). Pure data so
/// the per-platform construction is unit-testable on any host (mirrors
/// `build_tts_command` / `build_kill_command`).
fn build_quicklook_command(platform: TtsPlatform, path: &str) -> CommandSpec {
    match platform {
        TtsPlatform::MacOs => CommandSpec {
            program: "qlmanage".to_string(),
            args: vec!["-p".to_string(), path.to_string()],
            env: Vec::new(),
        },
        TtsPlatform::Windows => CommandSpec {
            program: "cmd".to_string(),
            // The empty "" is `start`'s title argument, so a quoted path isn't
            // mis-parsed as the window title.
            args: vec![
                "/C".to_string(),
                "start".to_string(),
                String::new(),
                path.to_string(),
            ],
            env: Vec::new(),
        },
        TtsPlatform::Linux => CommandSpec {
            program: "xdg-open".to_string(),
            args: vec![path.to_string()],
            env: Vec::new(),
        },
    }
}

#[tauri::command]
async fn quicklook(path: String) -> Result<(), String> {
    // HS-8826 — fail fast when the file is gone (e.g. an attachment deleted
    // out-of-band — see HS-8825). `qlmanage` on a missing path shows an empty /
    // error preview while `spawn()` still returns Ok, so the client could never
    // tell the preview failed. Returning Err here lets the client fall back to
    // its inline browser overlay, which fetches the file via the HTTP route
    // (and benefits from that route's serve-time self-heal, HS-8808).
    if !std::path::Path::new(&path).exists() {
        return Err(format!("file not found: {path}"));
    }
    spec_to_command(&build_quicklook_command(current_tts_platform(), &path))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// §78 Announcer (HS-8747) — the host OS, for selecting the TTS / kill command.
/// A plain enum (not `#[cfg]`) so the command builders below are pure functions
/// testable for every platform on any host (`build_tts_command` /
/// `build_kill_command` unit tests). `current_tts_platform()` resolves the
/// real host via `cfg!`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TtsPlatform {
    MacOs,
    Linux,
    Windows,
}

fn current_tts_platform() -> TtsPlatform {
    // `cfg!` compiles every arm but evaluates to the host's value, so this
    // stays correct cross-platform without `#[cfg]` blocks fragmenting the fn.
    if cfg!(target_os = "macos") {
        TtsPlatform::MacOs
    } else if cfg!(target_os = "windows") {
        TtsPlatform::Windows
    } else {
        // Linux + any other Unix fall back to the speech-dispatcher path.
        TtsPlatform::Linux
    }
}

/// A fully-resolved external command: program, argv, and any env to set. Pure
/// data so the per-platform construction can be asserted in tests without
/// spawning anything.
#[derive(Debug, PartialEq, Eq)]
struct CommandSpec {
    program: String,
    args: Vec<String>,
    /// Env pairs to set on the child (Windows passes the utterance text via an
    /// env var so quotes/specials don't need shell escaping).
    env: Vec<(String, String)>,
}

/// Build the OS text-to-speech command for `platform`. macOS uses `say`
/// (honoring `voice` / `rate`); Linux uses `spd-say --wait` (voice/rate are
/// best-effort and not mapped — spd-say's `-r` is a -100..100 relative scale,
/// not macOS words-per-minute); Windows drives the .NET `System.Speech`
/// synthesizer from PowerShell with the text passed via `HOTSHEET_TTS_TEXT`.
fn build_tts_command(
    platform: TtsPlatform,
    text: &str,
    voice: Option<&str>,
    rate: Option<u32>,
) -> CommandSpec {
    match platform {
        TtsPlatform::MacOs => {
            let mut args: Vec<String> = Vec::new();
            if let Some(v) = voice.filter(|v| !v.is_empty()) {
                args.push("-v".to_string());
                args.push(v.to_string());
            }
            if let Some(r) = rate {
                args.push("-r".to_string());
                args.push(r.to_string());
            }
            args.push(text.to_string());
            CommandSpec { program: "say".to_string(), args, env: Vec::new() }
        }
        TtsPlatform::Linux => CommandSpec {
            program: "spd-say".to_string(),
            args: vec!["--wait".to_string(), text.to_string()],
            env: Vec::new(),
        },
        TtsPlatform::Windows => CommandSpec {
            program: "powershell".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Add-Type -AssemblyName System.Speech; \
                 $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
                 $s.Speak($env:HOTSHEET_TTS_TEXT)"
                    .to_string(),
            ],
            env: vec![("HOTSHEET_TTS_TEXT".to_string(), text.to_string())],
        },
    }
}

/// Build the command that interrupts a running TTS child by PID. Unix SIGTERMs
/// via `kill`; Windows force-kills the tree via `taskkill`.
fn build_kill_command(platform: TtsPlatform, pid: u32) -> CommandSpec {
    match platform {
        TtsPlatform::Windows => CommandSpec {
            program: "taskkill".to_string(),
            args: vec!["/PID".to_string(), pid.to_string(), "/F".to_string(), "/T".to_string()],
            env: Vec::new(),
        },
        // macOS + Linux are both Unix — SIGTERM via `kill`.
        TtsPlatform::MacOs | TtsPlatform::Linux => CommandSpec {
            program: "kill".to_string(),
            args: vec![pid.to_string()],
            env: Vec::new(),
        },
    }
}

/// Turn a `CommandSpec` into a runnable `std::process::Command`.
fn spec_to_command(spec: &CommandSpec) -> std::process::Command {
    let mut c = std::process::Command::new(&spec.program);
    c.args(&spec.args);
    for (k, v) in &spec.env {
        c.env(k, v);
    }
    c
}

/// §78 Announcer (HS-8747) — speak `text` aloud using the OS text-to-speech
/// voice, resolving only when the utterance finishes (or is interrupted by
/// `tts_stop`). This is the desktop-primary TTS path chosen by the HS-8744
/// spike: it uses the OS voice directly rather than depending on WKWebView
/// `speechSynthesis`, whose reliability in this Tauri build is unverified
/// (it's the same browser-API class as the Tauri-unsafe `confirm`). The
/// browser build falls back to `speechSynthesis` (see `src/client/tts.ts`).
///
/// macOS uses `/usr/bin/say`; Linux uses `spd-say --wait` when present;
/// Windows uses PowerShell's `System.Speech` synthesizer. The child PID is
/// stored so `tts_stop` can interrupt mid-utterance. Resolving on child exit
/// is what lets the client play entries sequentially (await one, then speak
/// the next).
#[tauri::command]
async fn tts_speak(
    state: tauri::State<'_, TtsChild>,
    text: String,
    voice: Option<String>,
    rate: Option<u32>,
) -> Result<(), String> {
    // Interrupt anything already speaking before starting the new utterance.
    stop_tts_child(&state);

    let spec = build_tts_command(current_tts_platform(), &text, voice.as_deref(), rate);
    let mut child = spec_to_command(&spec).spawn().map_err(|e| e.to_string())?;
    // Record the PID so `tts_stop` can kill this utterance.
    {
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        *slot = Some(child.id());
    }
    let status = child.wait().map_err(|e| e.to_string());
    // Clear the slot if it still points at us (a concurrent `tts_stop` or a
    // newer `tts_speak` may have already replaced it).
    if let Ok(mut slot) = state.0.lock() {
        if *slot == Some(child.id()) {
            *slot = None;
        }
    }
    status.map(|_| ())
}

/// §78 Announcer (HS-8747) — interrupt the currently-speaking utterance, if
/// any. Used by play/pause, skip, prev/next, and PIP close.
#[tauri::command]
fn tts_stop(state: tauri::State<'_, TtsChild>) -> Result<(), String> {
    stop_tts_child(&state);
    Ok(())
}

/// Kill the tracked `say` child (if any) and clear the slot. Best-effort —
/// a missing/already-exited PID is not an error.
fn stop_tts_child(state: &tauri::State<'_, TtsChild>) {
    let pid = state.0.lock().ok().and_then(|mut slot| slot.take());
    let Some(pid) = pid else { return };
    let _ = spec_to_command(&build_kill_command(current_tts_platform(), pid)).status();
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    let handle = rfd::AsyncFileDialog::new()
        .set_title("Open Folder")
        .pick_folder()
        .await;
    Ok(handle.map(|h| h.path().to_string_lossy().to_string()))
}

/// HS-9024 — write `contents` to a path the user picks via a native Save dialog.
/// Used to export a minted client `.p12` for mTLS device enrollment: WKWebView
/// silently no-ops `<a download>`, so the desktop build routes byte downloads
/// through this command instead (the web/browser build keeps the blob path).
/// Returns true if saved, false if the user canceled. `default_name` seeds the
/// dialog's filename (sanitized so a device label can't smuggle a path).
#[tauri::command]
async fn save_file(default_name: String, contents: Vec<u8>) -> Result<bool, String> {
    let name = sanitize_save_filename(&default_name);
    let handle = rfd::AsyncFileDialog::new()
        .set_title("Save File")
        .set_file_name(&name)
        .save_file()
        .await;
    match handle {
        Some(h) => {
            std::fs::write(h.path(), &contents).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false), // user canceled the dialog
    }
}

/// Strip path separators / control characters from a proposed download filename
/// so a (user-supplied) device label can't smuggle a traversal into the save
/// dialog's default name. Pure (no platform/IO) → unit-testable on any host.
fn sanitize_save_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() { "download".to_string() } else { trimmed.to_string() }
}

#[cfg(not(debug_assertions))]
/// Spawns the sidecar Node process with the given data_dir, waits for the "running at" URL,
/// navigates the main window to it, stores the PID for cleanup, and sets the window title.
async fn spawn_sidecar_and_navigate(
    app: &tauri::AppHandle,
    data_dir: &str,
    extra_args: Vec<String>,
) -> Result<(), String> {
    startup_log(&format!("[sidecar] spawn_sidecar_and_navigate called with data_dir={} extra_args={:?}", data_dir, extra_args));
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let cli_js = resource_dir.join("server").join("cli.js");
    startup_log(&format!("[sidecar] cli_js={}, exists={}", cli_js.display(), cli_js.exists()));

    let mut sidecar_args = vec![
        cli_js.to_string_lossy().to_string(),
        "--no-open".to_string(),
    ];
    if !data_dir.is_empty() {
        sidecar_args.push("--data-dir".to_string());
        sidecar_args.push(data_dir.to_string());
    }
    sidecar_args.extend(extra_args);
    eprintln!("[sidecar] args={:?}", sidecar_args);

    let mut sidecar = app
        .shell()
        .sidecar("hotsheet-node")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?;

    // HS-8876 → HS-8907 — point the server at the bundled Apple Foundation Models
    // helper (copied into `server/apple-fm-helper` by build-sidecar.sh on arm64
    // macOS, from the `apple-fm` npm package). The `apple-fm` library reads the
    // `APPLE_FM_BIN` env var to locate the helper; without this it would try its
    // own bundled path, which doesn't exist in the tsup'd sidecar (a single JS
    // file with no node_modules), so on-device Apple Intelligence narration would
    // be unavailable. Set only when the binary is present (absent on non-arm64 /
    // non-macOS builds), so it's a no-op elsewhere.
    let apple_fm = resource_dir.join("server").join("apple-fm-helper");
    if apple_fm.exists() {
        sidecar = sidecar.env("APPLE_FM_BIN", apple_fm.to_string_lossy().to_string());
    }

    let args_refs: Vec<&str> = sidecar_args.iter().map(|s| s.as_str()).collect();
    let (mut rx, child) = sidecar
        .args(&args_refs)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    let sidecar_pid = child.pid();
    startup_log(&format!("[sidecar] spawned with PID {}", sidecar_pid));
    *app.state::<SidecarPid>().0.lock().unwrap() = Some(sidecar_pid);

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // Set window title from settings or project folder name (skip in demo mode — no fixed dataDir)
    if !data_dir.is_empty() {
        let name = resolve_app_name(data_dir);
        let _ = window.set_title(&name);
    }

    let data_dir_owned = data_dir.to_string();
    tauri::async_runtime::spawn(async move {
        let _child = child;
        let mut navigated = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[sidecar stdout] {}", line_str.trim());
                    // HS-8911 — stream graceful-shutdown step progress to the
                    // "Shutting Down" overlay (the only channel that survives
                    // `closeHttpServer`, step 1).
                    if let Some(label) = line_str.trim().strip_prefix("[lifecycle:progress] ") {
                        let _ = window.emit("shutdown-progress", label.trim().to_string());
                    }
                    if !navigated {
                        // HS-8704 — LOAD-BEARING string match. These two
                        // substrings are emitted by `src/server.ts` ("running
                        // at ") and `src/cli.ts` ("running instance on port ").
                        // If they drift, the WebView never navigates off the
                        // "Starting Hot Sheet…" splash and the installed app
                        // hangs at launch. The cross-file coupling is pinned by
                        // `src/launchReadinessContract.test.ts`.
                        // Case 1: sidecar started its own server
                        if let Some(idx) = line_str.find("running at ") {
                            let url = line_str[idx + "running at ".len()..].trim();
                            if let Ok(parsed) = url.parse() {
                                let _ = window.navigate(parsed);
                                navigated = true;
                                // HS-8704 — the SUCCESS milestone: the WebView
                                // has been told to leave the "Starting Hot
                                // Sheet…" splash. Its absence in the log
                                // pinpoints a hang to BEFORE this navigate.
                                startup_log(&format!("[sidecar] navigated WebView to {} (own server)", url));
                            }
                        }
                        // Case 2: sidecar joined an existing instance
                        if let Some(idx) = line_str.find("running instance on port ") {
                            let port_str = line_str[idx + "running instance on port ".len()..].trim();
                            let url = format!("http://localhost:{}", port_str);
                            if let Ok(parsed) = url.parse() {
                                let _ = window.navigate(parsed);
                                navigated = true;
                                startup_log(&format!("[sidecar] navigated WebView to {} (joined existing instance)", url));
                            }
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar stderr] {}", String::from_utf8_lossy(&line).trim());
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: code={:?} signal={:?}", payload.code, payload.signal);
                }
                _ => {}
            }
        }
        // HS-8911 — the event channel closed = the sidecar process exited. If the
        // user initiated a quit, the graceful drain is done (bounded by the
        // sidecar's per-step budgets — heavy HTTP/DB steps up to 90s each, HS-9028)
        // so finish the app exit now — the overlay has been showing progress the
        // whole time, so there's no beachball.
        if window.app_handle().state::<ShuttingDown>().0.load(Ordering::SeqCst) {
            shutdown_log("[sidecar] exited during shutdown — app.exit(0)");
            window.app_handle().exit(0);
            return;
        }
        // Fallback: if sidecar exited without navigating, try reading port from settings.json.
        // Skipped in demo mode — the sidecar picks a temp dataDir we don't know up front.
        if !navigated && !data_dir_owned.is_empty() {
            startup_log("[sidecar] process exited without navigating, trying settings.json fallback");
            let settings_path = std::path::PathBuf::from(&data_dir_owned).join("settings.json");
            if let Ok(contents) = std::fs::read_to_string(&settings_path) {
                if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&contents) {
                    if let Some(port) = settings.get("port").and_then(|p| p.as_u64()) {
                        let url = format!("http://localhost:{}", port);
                        startup_log(&format!("[sidecar] fallback: navigating to {}", url));
                        if let Ok(parsed) = url.parse() {
                            let _ = window.navigate(parsed);
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
async fn open_project(app: tauri::AppHandle, data_dir: String) -> Result<(), String> {
    // Kill existing sidecar if any, and wait for it to clean up (lock files, etc.)
    if let Some(pid) = app.state::<SidecarPid>().0.lock().unwrap().take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
        }
        // Give the Node process time to run cleanup handlers (release lock files)
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    spawn_sidecar_and_navigate(&app, &data_dir, Vec::new()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(SidecarPid(Mutex::new(None)))
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(TtsChild(Mutex::new(None)))
        .manage(QuitConfirmed(AtomicBool::new(false)))
        .manage(ShuttingDown(AtomicBool::new(false)))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // HS-7596 / §37 — quit-confirm gate. The first time the user
                // attempts to close the window, we prevent the close, emit a
                // `quit-confirm-requested` event to the JS frontend, and let
                // the JS-side confirm flow decide. When the user clicks "Quit
                // Anyway", JS calls the `confirm_quit` Tauri command which
                // sets the QuitConfirmed flag + re-issues window.close().
                // The second close attempt sees the flag and proceeds.
                let confirmed = window.app_handle().state::<QuitConfirmed>();
                let already = confirmed.0.load(Ordering::SeqCst);
                shutdown_log(&format!("WindowEvent::CloseRequested (confirmed={already})"));
                if !already {
                    api.prevent_close();
                    let _ = window.emit("quit-confirm-requested", ());
                }
            }
        })
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

            let prefs_item = MenuItemBuilder::new("Preferences...")
                .id("app-preferences")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let open_folder_item = MenuItemBuilder::new("Open Folder...")
                .id("app-open-folder")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;

            // HS-8655 — custom "Close Tab" item instead of the predefined
            // `.close_window()`. The predefined item binds ⌘W to closing the
            // OS window (which the user never wants — ⌘W should close an
            // in-app tab, never the whole app). By owning the item we route
            // ⌘W through `on_menu_event` → the `app:close-tab` JS event, which
            // the frontend turns into "close the focused terminal (with
            // confirm) or the active project tab (with confirm)". The window
            // stays closeable via the red traffic light and ⌘Q (both of which
            // still run the §37 quit-confirm flow).
            let close_tab_item = MenuItemBuilder::new("Close Tab")
                .id("app-close-tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;

            // HS-7596 / §37 — custom Quit item instead of the predefined `.quit()`.
            // The predefined item maps to NSApp::terminate: on macOS, which in
            // this Tauri version does NOT fire RunEvent::ExitRequested reliably
            // — so ⌘Q bypassed the confirm dialog. By owning the menu item we
            // route every ⌘Q press (and dock-menu / app-menu Quit clicks that
            // hit this item) through our `on_menu_event` handler, which emits
            // the same `quit-confirm-requested` event the red-traffic-light
            // close uses. After the user confirms, `confirm_quit` sets the
            // flag and calls `app.exit(0)` to actually exit.
            let quit_item = MenuItemBuilder::new("Quit Hot Sheet")
                .id("app-quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Hot Sheet")
                .about(Some(tauri::menu::AboutMetadataBuilder::new()
                    .name(Some("Hot Sheet"))
                    .build()))
                .separator()
                .item(&prefs_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&quit_item)
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_folder_item)
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
                .item(&close_tab_item)
                .build()?;
            MenuBuilder::new(app)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                "app-undo" | "app-redo" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let js_event = if id == "app-undo" { "app:undo" } else { "app:redo" };
                        let _ = window.eval(&format!(
                            "window.dispatchEvent(new Event('{}'))",
                            js_event
                        ));
                    }
                }
                "app-preferences" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.dispatchEvent(new Event('app:preferences'))");
                    }
                }
                "app-open-folder" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.dispatchEvent(new Event('app:open-folder'))");
                    }
                }
                "app-close-tab" => {
                    // HS-8655 — ⌘W never closes the window. Route it to the
                    // frontend, which closes the focused terminal (with
                    // confirm) or the active project tab (with confirm).
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.dispatchEvent(new Event('app:close-tab'))");
                    }
                }
                "app-quit" => {
                    // HS-7596 / §37 — route ⌘Q (and the App menu / dock menu
                    // Quit click) through the same confirm flow as the red
                    // traffic-light close. If the user has already confirmed
                    // (e.g. they clicked Quit Anyway and `confirm_quit` is now
                    // re-issuing the exit), exit immediately. Otherwise emit
                    // the JS event — the frontend shows the dialog and
                    // ultimately calls `confirm_quit` (which calls app.exit(0))
                    // or just leaves the app running.
                    let confirmed = app.state::<QuitConfirmed>();
                    if confirmed.0.load(Ordering::SeqCst) {
                        app.exit(0);
                    } else if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("quit-confirm-requested", ());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_cli_installed,
            install_cli,
            get_pending_update,
            check_for_update,
            install_update,
            request_attention,
            request_attention_once,
            pick_folder,
            save_file,
            open_url,
            set_window_title,
            show_native_notification,
            quicklook,
            confirm_quit,
            tts_speak,
            tts_stop,
            #[cfg(not(debug_assertions))]
            open_project
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
                // Dev builds always start a clean server: if a prior instance is running,
                // --replace tells the CLI to shut it down before starting.
                // HS-8828 — `node --import tsx` (NOT `npx tsx`) so the spawned
                // child IS the cli.ts server and is directly killable on quit;
                // see `build_dev_server_args`.
                let server_args = build_dev_server_args(&app_args);

                // The Rust binary runs from src-tauri/, so set cwd to the project root
                let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
                shutdown_log(&format!("[dev] spawning server: node {}", server_args.join(" ")));
                let mut child = std::process::Command::new("node")
                    .args(&server_args)
                    .current_dir(project_root)
                    // tsx-as-loader reads the tsconfig (jsx / jsxImportSource /
                    // paths) from here instead of the old `--tsconfig` CLI flag.
                    .env("TSX_TSCONFIG_PATH", "tsconfig.json")
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                    .expect("Failed to start dev server (is node/tsx installed?)");

                shutdown_log(&format!("[dev] server child pid = {}", child.id()));
                *app.state::<SidecarPid>().0.lock().unwrap() = Some(child.id());

                let stdout = child.stdout.take().expect("Failed to capture stdout");
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(stdout);
                    // HS-8911 — keep reading stdout AFTER navigation (the pre-fix loop
                    // `break`d on the first "running at" line) so the graceful-shutdown
                    // `[lifecycle:progress]` markers reach the overlay during quit.
                    let mut navigated = false;
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        println!("{}", line);
                        // HS-8911 — stream shutdown step progress to the overlay.
                        if let Some(label) = line.trim().strip_prefix("[lifecycle:progress] ") {
                            let _ = window.emit("shutdown-progress", label.trim().to_string());
                            continue;
                        }
                        if !navigated {
                            // Case 1: server started fresh
                            if let Some(idx) = line.find("running at ") {
                                let url = line[idx + "running at ".len()..].trim().to_string();
                                if let Ok(parsed) = url.parse() {
                                    let _ = window.navigate(parsed);
                                    navigated = true;
                                }
                            }
                            // Case 2: joined an existing running instance
                            else if let Some(idx) = line.find("running instance on port ") {
                                let port_str = line[idx + "running instance on port ".len()..].trim().to_string();
                                let url = format!("http://localhost:{}", port_str);
                                if let Ok(parsed) = url.parse() {
                                    let _ = window.navigate(parsed);
                                    navigated = true;
                                }
                            }
                        }
                    }
                    // stdout EOF = the dev server exited. Wait, then (if the user quit)
                    // finish the app exit — the overlay showed progress the whole time.
                    let _ = child.wait();
                    if app_handle.state::<ShuttingDown>().0.load(Ordering::SeqCst) {
                        shutdown_log("[dev] server exited during shutdown — app.exit(0)");
                        app_handle.exit(0);
                    }
                });
            }

            // --- Production mode: spawn sidecar or connect to pre-started server ---
            #[cfg(not(debug_assertions))]
            {
                let app_args: Vec<String> = std::env::args().collect();
                let has_data_dir = app_args.iter().any(|a| a == "--data-dir");
                let has_demo = app_args.iter().any(|a| a.starts_with("--demo:"));
                let forwarded = collect_forwarded_server_args(&app_args);

                startup_log(&format!("[setup] has_data_dir={} has_demo={} args={:?}", has_data_dir, has_demo, app_args));

                // Demo mode: bypass project restoration and let the sidecar pick its own
                // temp dataDir (cli.ts resolveDemoDataDir). The forwarded --demo:N flag tells
                // it which scenario to seed.
                if has_demo && !has_data_dir {
                    let handle = app.handle().clone();
                    let extra = forwarded.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = spawn_sidecar_and_navigate(&handle, "", extra).await {
                            startup_log(&format!("[setup] failed to spawn demo sidecar: {e}"));
                        }
                    });
                    return Ok(());
                }

                if !has_data_dir {
                    // Check ~/.hotsheet/projects.json for previously opened projects
                    let mut restored_dir: Option<String> = None;
                    if let Ok(home) = std::env::var("HOME") {
                        let projects_path = std::path::PathBuf::from(&home)
                            .join(".hotsheet")
                            .join("projects.json");
                        eprintln!("[setup] checking projects.json at {}", projects_path.display());
                        if let Ok(contents) = std::fs::read_to_string(&projects_path) {
                            eprintln!("[setup] projects.json contents: {}", contents.trim());
                            if let Ok(entries) = serde_json::from_str::<Vec<String>>(&contents) {
                                for entry in &entries {
                                    let exists = std::path::Path::new(entry).is_dir();
                                    eprintln!("[setup] project entry: {} (exists={})", entry, exists);
                                    if exists && restored_dir.is_none() {
                                        restored_dir = Some(entry.clone());
                                    }
                                }
                            } else {
                                eprintln!("[setup] failed to parse projects.json as Vec<String>");
                            }
                        } else {
                            eprintln!("[setup] no projects.json found");
                        }
                    } else {
                        eprintln!("[setup] HOME env var not set");
                    }

                    if let Some(ref data_dir) = restored_dir {
                        startup_log(&format!("[setup] restoring project: {}", data_dir));
                        // Restore the most recent project — spawn sidecar and return
                        let handle = app.handle().clone();
                        let dir = data_dir.clone();
                        let extra = forwarded.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = spawn_sidecar_and_navigate(&handle, &dir, extra).await {
                                startup_log(&format!("[setup] failed to restore project: {e}"));
                                // Navigate to welcome screen as fallback
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.navigate("tauri://localhost/welcome.html".parse().unwrap());
                                }
                            }
                        });

                        // Check for updates
                        let handle = app.handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let Ok(updater) = handle.updater() else { return; };
                            let Ok(Some(update)) = updater.check().await else { return; };
                            *handle.state::<PendingUpdate>().0.lock().unwrap() = Some(update.version);
                        });

                        return Ok(());
                    } else {
                        // No previous projects — show the welcome/setup screen
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
                }

                // Check if the CLI launcher already started the server
                if let Ok(server_url) = std::env::var("HOTSHEET_SERVER_URL") {
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
                    let data_dir = app_args.iter().position(|a| a == "--data-dir")
                        .and_then(|i| app_args.get(i + 1))
                        .cloned()
                        .unwrap_or_default();
                    let handle = app.handle().clone();
                    let extra = forwarded.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = spawn_sidecar_and_navigate(&handle, &data_dir, extra).await {
                            startup_log(&format!("[setup] failed to spawn sidecar: {e}"));
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
            match event {
                // HS-7596 / §37 — quit-confirm gate for the application-level
                // quit path (⌘Q via the macOS Quit menu item, programmatic
                // app.exit(), dock menu Quit). The window-level red traffic-
                // light close goes through `WindowEvent::CloseRequested` and is
                // handled there; this handler covers everything else. When the
                // user has not yet confirmed, prevent the exit and emit the
                // same `quit-confirm-requested` event the JS frontend already
                // listens for. After the user confirms, `confirm_quit` flips
                // the flag and calls `app.exit(0)` again — this fires
                // `ExitRequested` a second time, the flag is now true so we
                // do nothing, and the exit proceeds normally.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let confirmed = app_handle.state::<QuitConfirmed>();
                    let already = confirmed.0.load(Ordering::SeqCst);
                    shutdown_log(&format!("RunEvent::ExitRequested (confirmed={already})"));
                    if !already {
                        api.prevent_exit();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("quit-confirm-requested", ());
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    shutdown_log("RunEvent::Exit — tearing down server child");
                    // Kill the sidecar / dev-server process on app exit
                    if let Some(pid) = app_handle.state::<SidecarPid>().0.lock().unwrap().take() {
                        #[cfg(unix)]
                        {
                            // Send SIGTERM to let the Node process clean up
                            // (run gracefulShutdown → release lock files, etc.).
                            // HS-8828 — `pid` is now the cli.ts server itself
                            // (dev: `node --import tsx`; prod: the sidecar
                            // binary), so `kill(pid)` reaches its graceful
                            // handler. `kill(-pid)` additionally sweeps the
                            // group when the child happens to lead one.
                            shutdown_log(&format!("RunEvent::Exit — SIGTERM server pid {pid}"));
                            unsafe {
                                let r1 = libc::kill(pid as i32, libc::SIGTERM);
                                let r2 = libc::kill(-(pid as i32), libc::SIGTERM);
                                shutdown_log(&format!(
                                    "RunEvent::Exit — kill(pid)={r1} kill(-pid)={r2}"
                                ));
                            }
                            // Poll for the server to actually exit, escalating to
                            // SIGKILL if it doesn't. The old fixed 300ms-then-exit
                            // left a WEDGED server (event loop blocked, so SIGTERM
                            // never runs its handler) orphaned — still holding the
                            // HTTP port and every project lock — which made the
                            // NEXT launch see a live lock and FATAL-exit. The TERM
                            // grace is generous so a legitimate gracefulShutdown
                            // (CHECKPOINT/snapshot/HTTP drain) completes cleanly; a
                            // clean exit is detected within one poll so a normal
                            // quit isn't slowed. HS-9028 raised the sidecar's heavy
                            // steps to a 90s budget each, so the TERM grace must
                            // exceed that or a slow-but-legit drain gets SIGKILLed
                            // mid-write — 95s = one 90s heavy step + buffer.
                            let term_grace = std::time::Duration::from_secs(95);
                            let kill_grace = std::time::Duration::from_secs(3);
                            let poll = std::time::Duration::from_millis(100);
                            let start = std::time::Instant::now();
                            let mut escalated = false;
                            loop {
                                let action = teardown_action(
                                    server_alive(pid as i32),
                                    start.elapsed(),
                                    term_grace,
                                    kill_grace,
                                    escalated,
                                );
                                match action {
                                    TeardownAction::Done => {
                                        shutdown_log(&format!(
                                            "RunEvent::Exit — server exited after {}ms",
                                            start.elapsed().as_millis()
                                        ));
                                        break;
                                    }
                                    TeardownAction::Escalate => {
                                        shutdown_log("RunEvent::Exit — TERM grace elapsed; escalating to SIGKILL");
                                        unsafe {
                                            libc::kill(pid as i32, libc::SIGKILL);
                                            libc::kill(-(pid as i32), libc::SIGKILL);
                                        }
                                        escalated = true;
                                        std::thread::sleep(poll);
                                    }
                                    TeardownAction::Abandon => {
                                        shutdown_log("RunEvent::Exit — server still alive after SIGKILL grace; abandoning");
                                        break;
                                    }
                                    TeardownAction::WaitMore => std::thread::sleep(poll),
                                }
                            }
                        }
                        #[cfg(windows)]
                        {
                            shutdown_log(&format!("RunEvent::Exit — taskkill /T /F pid {pid}"));
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .status();
                        }
                    } else {
                        shutdown_log("RunEvent::Exit — no server pid recorded");
                    }
                }
                _ => {}
            }
        });
}

/// Next action for the server-teardown poll loop in `RunEvent::Exit`. Pure (no
/// syscalls / no clock), so the escalation policy is unit-testable on any host;
/// the real loop just executes the returned action.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum TeardownAction {
    /// The server is gone — stop polling.
    Done,
    /// Still within a grace window — keep waiting.
    WaitMore,
    /// TERM grace elapsed and the server is still alive — send SIGKILL.
    Escalate,
    /// SIGKILL grace also elapsed and it's STILL alive — give up (exit anyway).
    Abandon,
}

/// Decide the next teardown step from the child's liveness, time elapsed since
/// SIGTERM, and whether we've already escalated to SIGKILL.
#[cfg(unix)]
fn teardown_action(
    alive: bool,
    elapsed: std::time::Duration,
    term_grace: std::time::Duration,
    kill_grace: std::time::Duration,
    escalated: bool,
) -> TeardownAction {
    if !alive {
        TeardownAction::Done
    } else if !escalated {
        if elapsed >= term_grace {
            TeardownAction::Escalate
        } else {
            TeardownAction::WaitMore
        }
    } else if elapsed >= term_grace + kill_grace {
        TeardownAction::Abandon
    } else {
        TeardownAction::WaitMore
    }
}

/// True if `pid` is still a live process. Best-effort reaps it first
/// (`waitpid(WNOHANG)`) so a child that already exited isn't read as alive via a
/// lingering zombie entry (which would needlessly slow a clean quit); the reap
/// is a harmless no-op when `pid` isn't our child.
#[cfg(unix)]
fn server_alive(pid: i32) -> bool {
    unsafe {
        let mut status: libc::c_int = 0;
        libc::waitpid(pid, &mut status, libc::WNOHANG);
        libc::kill(pid, 0) == 0
    }
}

#[cfg(all(test, unix))]
mod teardown_action_tests {
    //! HS-8874 follow-up — escalation policy for the `RunEvent::Exit` server
    //! teardown. A wedged server (event loop blocked) ignores SIGTERM; the loop
    //! must escalate to SIGKILL so it can't orphan and hold the port + locks.
    use super::{teardown_action, TeardownAction};
    use std::time::Duration;

    const TERM: Duration = Duration::from_secs(10);
    const KILL: Duration = Duration::from_secs(3);

    #[test]
    fn dead_process_is_done_regardless_of_timing() {
        assert_eq!(teardown_action(false, Duration::ZERO, TERM, KILL, false), TeardownAction::Done);
        assert_eq!(teardown_action(false, Duration::from_secs(100), TERM, KILL, true), TeardownAction::Done);
    }

    #[test]
    fn waits_within_term_grace() {
        assert_eq!(teardown_action(true, Duration::from_secs(5), TERM, KILL, false), TeardownAction::WaitMore);
        assert_eq!(teardown_action(true, Duration::from_millis(9_999), TERM, KILL, false), TeardownAction::WaitMore);
    }

    #[test]
    fn escalates_once_term_grace_elapses() {
        assert_eq!(teardown_action(true, TERM, TERM, KILL, false), TeardownAction::Escalate);
        assert_eq!(teardown_action(true, Duration::from_secs(11), TERM, KILL, false), TeardownAction::Escalate);
    }

    #[test]
    fn waits_within_kill_grace_after_escalation() {
        assert_eq!(teardown_action(true, Duration::from_secs(11), TERM, KILL, true), TeardownAction::WaitMore);
    }

    #[test]
    fn abandons_after_kill_grace() {
        assert_eq!(teardown_action(true, TERM + KILL, TERM, KILL, true), TeardownAction::Abandon);
        assert_eq!(teardown_action(true, Duration::from_secs(20), TERM, KILL, true), TeardownAction::Abandon);
    }
}

#[cfg(test)]
mod tts_command_tests {
    //! §78 Announcer (HS-8747) — per-platform TTS / kill command construction.
    //!
    //! `build_tts_command` and `build_kill_command` are pure (platform is a
    //! parameter, not `#[cfg]`), so every OS branch is asserted here regardless
    //! of the host running `cargo test`. This is the only automated coverage of
    //! the Linux/Windows voice paths until they get a real desktop pass
    //! (HS-8748) — the macOS `say` path is the only one exercised live in dev.
    use super::*;

    #[test]
    fn macos_say_includes_voice_and_rate_when_provided() {
        let spec = build_tts_command(TtsPlatform::MacOs, "hello world", Some("Samantha"), Some(180));
        assert_eq!(spec.program, "say");
        assert_eq!(spec.args, vec!["-v", "Samantha", "-r", "180", "hello world"]);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn macos_say_omits_voice_and_rate_when_absent() {
        let spec = build_tts_command(TtsPlatform::MacOs, "just text", None, None);
        assert_eq!(spec.program, "say");
        // Only the text — no -v / -r flags.
        assert_eq!(spec.args, vec!["just text"]);
    }

    #[test]
    fn macos_say_treats_empty_voice_as_absent() {
        let spec = build_tts_command(TtsPlatform::MacOs, "x", Some(""), None);
        assert_eq!(spec.args, vec!["x"]);
    }

    #[test]
    fn linux_uses_spd_say_wait_and_ignores_voice_rate() {
        let spec = build_tts_command(TtsPlatform::Linux, "from linux", Some("ignored"), Some(99));
        assert_eq!(spec.program, "spd-say");
        assert_eq!(spec.args, vec!["--wait", "from linux"]);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn windows_passes_text_via_env_not_argv() {
        let spec = build_tts_command(TtsPlatform::Windows, "windows speech", None, None);
        assert_eq!(spec.program, "powershell");
        assert_eq!(spec.args[0], "-NoProfile");
        assert_eq!(spec.args[1], "-Command");
        // The script references the env var; the literal text must NOT appear
        // in argv (that's the whole point — no shell-escaping of the utterance).
        assert!(spec.args[2].contains("System.Speech"));
        assert!(spec.args[2].contains("$env:HOTSHEET_TTS_TEXT"));
        assert!(!spec.args.iter().any(|a| a.contains("windows speech")));
        assert_eq!(spec.env, vec![("HOTSHEET_TTS_TEXT".to_string(), "windows speech".to_string())]);
    }

    #[test]
    fn kill_command_is_taskkill_on_windows() {
        let spec = build_kill_command(TtsPlatform::Windows, 4321);
        assert_eq!(spec.program, "taskkill");
        assert_eq!(spec.args, vec!["/PID", "4321", "/F", "/T"]);
    }

    #[test]
    fn kill_command_is_kill_on_unix() {
        for platform in [TtsPlatform::MacOs, TtsPlatform::Linux] {
            let spec = build_kill_command(platform, 4321);
            assert_eq!(spec.program, "kill");
            assert_eq!(spec.args, vec!["4321"]);
        }
    }

    #[test]
    fn current_platform_matches_the_host() {
        let platform = current_tts_platform();
        if cfg!(target_os = "macos") {
            assert_eq!(platform, TtsPlatform::MacOs);
        } else if cfg!(target_os = "windows") {
            assert_eq!(platform, TtsPlatform::Windows);
        } else {
            assert_eq!(platform, TtsPlatform::Linux);
        }
    }

    /// HS-9197 — end-to-end smoke test: the macOS `say` TTS actually EMITS audio.
    /// Every other announcer-TTS test is either mocked (the JS `SpeechEngine` /
    /// browser `speechSynthesis`) or pure (`build_tts_command` construction, above);
    /// this is the ONE test that runs the real synthesizer and asserts the output
    /// is non-empty AND non-silent, so a regression that makes `say` emit nothing
    /// is caught. It captures to a file (`-o`) instead of playing, so it's silent
    /// and headless-safe. macOS-only + `say`-gated → auto-skips on Linux/Windows
    /// CI (the Apple-FM / local-provider paths that can't be captured headlessly
    /// are covered by the manual test plan, §Announcer TTS audio).
    #[test]
    fn macos_say_emits_nonempty_nonsilent_audio() {
        if !cfg!(target_os = "macos") {
            return; // `say` is macOS-only — skip elsewhere.
        }
        use std::process::Command;
        // Reuse the exact invocation the announcer builds (voice/rate absent → just
        // the utterance), adding `-o <file>` so it writes an AIFF instead of playing.
        let spec = build_tts_command(TtsPlatform::MacOs, "Hot Sheet audio smoke test.", None, None);
        assert_eq!(spec.program, "say");

        let out_path = std::env::temp_dir()
            .join(format!("hotsheet-tts-smoke-{}.aiff", std::process::id()));
        let _ = std::fs::remove_file(&out_path);

        let status = match Command::new("say").arg("-o").arg(&out_path).args(&spec.args).status() {
            Ok(s) => s,
            Err(_) => return, // `say` unexpectedly unavailable — skip rather than fail.
        };
        assert!(status.success(), "`say -o` exited with failure: {status:?}");

        // Non-empty: a real utterance is many KB of PCM; a failed synth leaves the
        // file missing or tiny.
        let meta = std::fs::metadata(&out_path).expect("say should have written the AIFF");
        assert!(
            meta.len() > 2_000,
            "TTS output suspiciously small ({} bytes) — likely silent/failed",
            meta.len(),
        );

        // Non-silent (best-effort): `afinfo` reports an estimated duration > 0 for
        // real audio. If `afinfo` is somehow unavailable the size check above stands.
        if let Ok(out) = Command::new("afinfo").arg(&out_path).output() {
            if out.status.success() {
                let info = String::from_utf8_lossy(&out.stdout);
                let dur = info
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("estimated duration:"))
                    .and_then(|v| v.trim().split_whitespace().next())
                    .and_then(|n| n.parse::<f64>().ok())
                    .unwrap_or(0.0);
                assert!(dur > 0.0, "afinfo reported zero duration — audio is empty/silent:\n{info}");
            }
        }

        let _ = std::fs::remove_file(&out_path);
    }

    // HS-8826 — Quick Look / open command per platform. Pure builder, so all
    // three OS branches are asserted on any host (the macOS `qlmanage` path is
    // the only one exercised live in dev).

    #[test]
    fn quicklook_macos_uses_qlmanage_preview() {
        let spec = build_quicklook_command(TtsPlatform::MacOs, "/tmp/a file.png");
        assert_eq!(spec.program, "qlmanage");
        assert_eq!(spec.args, vec!["-p", "/tmp/a file.png"]);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn quicklook_linux_uses_xdg_open() {
        let spec = build_quicklook_command(TtsPlatform::Linux, "/home/x/doc.pdf");
        assert_eq!(spec.program, "xdg-open");
        assert_eq!(spec.args, vec!["/home/x/doc.pdf"]);
    }

    #[test]
    fn quicklook_windows_uses_cmd_start_with_empty_title() {
        let spec = build_quicklook_command(TtsPlatform::Windows, "C:\\tmp\\doc.pdf");
        assert_eq!(spec.program, "cmd");
        // `cmd /C start "" <path>` — the empty title arg keeps a quoted path
        // from being swallowed as the window title.
        assert_eq!(spec.args, vec!["/C", "start", "", "C:\\tmp\\doc.pdf"]);
    }
}

// HS-8828 — dev-mode server launch must spawn the cli.ts server IN-process
// (`node --import tsx`) so its PID is directly killable on quit, NOT via an
// `npx`/`tsx`-CLI wrapper whose real server is an unreachable grandchild. Gated
// to debug builds because `build_dev_server_args` only exists there (it's the
// dev-only launch path). `cargo test` is a debug build, so this runs in CI.
#[cfg(all(test, debug_assertions))]
mod dev_server_args_tests {
    use super::*;

    #[test]
    fn launches_cli_via_node_import_tsx_not_npx_wrapper() {
        let args = build_dev_server_args(&[]);
        // node flags first: `--import tsx` runs cli.ts in THIS process, so the
        // spawned child PID is the server the quit-time SIGTERM must reach.
        assert_eq!(args[0], "--import");
        assert_eq!(args[1], "tsx");
        assert_eq!(args[2], "src/cli.ts");
        assert!(args.iter().any(|a| a == "--no-open"));
        assert!(args.iter().any(|a| a == "--replace"));
        // Guard against a regression to the old wrapper form, where the child
        // PID was `npm exec`/`npx` and the server was an unkillable grandchild.
        assert!(!args.iter().any(|a| a == "npx"));
        // tsconfig is now passed via TSX_TSCONFIG_PATH env, not the CLI flag.
        assert!(!args.iter().any(|a| a == "--tsconfig"));
    }

    #[test]
    fn forwards_data_dir_to_the_server() {
        let args = build_dev_server_args(&[
            "--data-dir".to_string(),
            "/some/dir".to_string(),
        ]);
        let i = args.iter().position(|a| a == "--data-dir").expect("--data-dir forwarded");
        assert_eq!(args[i + 1], "/some/dir");
    }

    // HS-8921 — `--test` must reach the sidecar so a Tauri dev launch can run
    // the isolated test instance.
    #[test]
    fn forwards_test_flag_to_the_server() {
        let args = build_dev_server_args(&["--test".to_string()]);
        assert!(args.iter().any(|a| a == "--test"), "--test forwarded to sidecar");
    }

    #[test]
    fn omits_test_flag_when_not_requested() {
        let args = build_dev_server_args(&[]);
        assert!(!args.iter().any(|a| a == "--test"), "--test only forwarded when passed");
    }
}

// HS-8828 — guard the ACL grant-sync invariant that the *definitive* root cause
// violated. Hot Sheet's frontend is served from `http://localhost:<port>` — a
// "remote" origin to Tauri — and the main window navigates there. Tauri 2.11
// stopped auto-allowing the app's own `#[tauri::command]`s for remote-origin
// webviews, so every command must be (a) registered in `build.rs` (which
// generates an `allow-<cmd>` permission) and (b) explicitly granted to the
// localhost origin in `capabilities/remote-localhost.json` (and mirrored in
// `default.json`). A command in `generate_handler!` but missing a grant is
// silently rejected at runtime with `<cmd> not allowed. Plugin not found` —
// exactly the Quit/Quick Look breakage we just fixed.
//
// These four lists are maintained by hand in four separate files, so they WILL
// drift. This test reads the real source files and fails the build the moment
// they disagree — turning a runtime-only, GUI-only regression into a unit-test
// failure that names the offending command.
#[cfg(test)]
mod acl_grant_sync_tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;

    fn crate_file(rel: &str) -> String {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push(rel);
        fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
    }

    /// Pull every double-quoted token out of `src` whose value is between the
    /// first `start` marker and the next `end` marker after it.
    fn quoted_between(src: &str, start: &str, end: &str) -> Vec<String> {
        let from = src.find(start).unwrap_or_else(|| panic!("marker {start:?} not found"));
        let rest = &src[from + start.len()..];
        let to = rest.find(end).unwrap_or_else(|| panic!("marker {end:?} not found"));
        let block = &rest[..to];
        quoted_tokens(block)
    }

    /// All `"..."` string literals in `block` (no escapes expected here).
    fn quoted_tokens(block: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut chars = block.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c == '"' {
                if let Some(close) = block[i + 1..].find('"') {
                    out.push(block[i + 1..i + 1 + close].to_string());
                    // Skip past the closing quote so the inner content isn't rescanned.
                    while let Some(&(j, _)) = chars.peek() {
                        if j <= i + 1 + close { chars.next(); } else { break; }
                    }
                }
            }
        }
        out
    }

    /// `confirm_quit` -> `allow-confirm-quit`.
    fn allow_perm(cmd: &str) -> String {
        format!("allow-{}", cmd.replace('_', "-"))
    }

    /// The app-command grants in a capability file: `"allow-..."` tokens that
    /// are NOT namespaced (`core:`, `shell:allow-spawn`, …) — those are plugin
    /// permissions, not our generated app-command grants.
    fn app_grants(json: &str) -> BTreeSet<String> {
        quoted_tokens(json)
            .into_iter()
            .filter(|t| t.starts_with("allow-") && !t.contains(':'))
            .collect()
    }

    /// Commands registered via `build.rs`'s `AppManifest::new().commands([...])`.
    fn build_rs_commands() -> Vec<String> {
        quoted_between(&crate_file("build.rs"), ".commands(&[", "])")
    }

    /// Bare identifiers inside `generate_handler![ ... ]` in lib.rs (skipping
    /// `#[cfg(...)]` attribute lines and the macro/handler scaffolding).
    fn generate_handler_commands() -> BTreeSet<String> {
        let src = crate_file("src/lib.rs");
        let from = src.find("generate_handler![").expect("generate_handler! present");
        let rest = &src[from + "generate_handler![".len()..];
        let to = rest.find(']').expect("generate_handler! closing ]");
        rest[..to]
            .lines()
            .map(|l| l.trim().trim_end_matches(','))
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn build_rs_command_list_is_not_empty() {
        // Sanity: if the parse breaks (markers renamed), fail loudly here rather
        // than silently passing the comparisons below against empty sets.
        let cmds = build_rs_commands();
        assert!(cmds.contains(&"confirm_quit".to_string()), "got: {cmds:?}");
        assert!(cmds.contains(&"quicklook".to_string()), "got: {cmds:?}");
    }

    #[test]
    fn every_invoke_handler_command_is_registered_in_build_rs() {
        let registered: BTreeSet<String> = build_rs_commands().into_iter().collect();
        let handled = generate_handler_commands();
        let missing: Vec<_> = handled.difference(&registered).cloned().collect();
        assert!(
            missing.is_empty(),
            "commands in generate_handler! but NOT registered in build.rs \
             (so no allow-<cmd> permission is generated): {missing:?}"
        );
    }

    #[test]
    fn remote_localhost_grants_every_app_command() {
        let expected: BTreeSet<String> =
            build_rs_commands().iter().map(|c| allow_perm(c)).collect();
        let granted = app_grants(&crate_file("capabilities/remote-localhost.json"));
        assert_eq!(
            expected, granted,
            "remote-localhost.json app-command grants are out of sync with build.rs. \
             A command registered but not granted here is rejected from the localhost \
             frontend with `<cmd> not allowed. Plugin not found` (HS-8828)."
        );
    }

    #[test]
    fn default_capability_mirrors_the_same_app_command_grants() {
        let expected: BTreeSet<String> =
            build_rs_commands().iter().map(|c| allow_perm(c)).collect();
        let granted = app_grants(&crate_file("capabilities/default.json"));
        assert_eq!(
            expected, granted,
            "default.json app-command grants drifted from build.rs / remote-localhost.json"
        );
    }
}

// HS-9024 — the `save_file` command's pure filename sanitizer (the native save
// dialog + fs write can't run headlessly, but the sanitization that protects it
// from a malicious device label can be tested on any host).
#[cfg(test)]
mod save_file_tests {
    use super::sanitize_save_filename;

    #[test]
    fn keeps_a_normal_p12_filename() {
        assert_eq!(sanitize_save_filename("hotsheet-laptop.p12"), "hotsheet-laptop.p12");
    }

    #[test]
    fn strips_path_separators_and_traversal() {
        let out = sanitize_save_filename("../../etc/passwd");
        assert!(!out.contains('/'), "got {out:?}");
        assert!(!out.contains('\\'), "got {out:?}");
        assert!(!out.is_empty());
    }

    #[test]
    fn strips_backslashes_and_control_chars() {
        let out = sanitize_save_filename("a\\b\nc");
        assert!(!out.contains('\\'));
        assert!(!out.contains('\n'));
    }

    #[test]
    fn empty_or_dotonly_becomes_download() {
        assert_eq!(sanitize_save_filename("   "), "download");
        assert_eq!(sanitize_save_filename("..."), "download");
        assert_eq!(sanitize_save_filename(""), "download");
    }
}
