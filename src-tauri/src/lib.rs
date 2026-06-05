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
        } else if a == "--check-for-updates" || a == "--strict-port" || a == "--force" {
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

/// Read app_icon from settings.json in the data directory and apply it on startup.
/// NOTE: Custom icon support is feature-flagged out — always uses default icon.
fn apply_saved_icon(app: &tauri::AppHandle) {
    // Custom icon switching disabled — always use default icon
    let _ = app;
    return;

    // Find the data dir from CLI args (--data-dir <path>)
    #[allow(unreachable_code)]
    let args: Vec<String> = std::env::args().collect();
    let data_dir = args.iter().position(|a| a == "--data-dir")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.join(".hotsheet").to_string_lossy().to_string())
                .unwrap_or_default()
        });

    if data_dir.is_empty() {
        eprintln!("[icon] no data dir found in args");
        return;
    }

    let settings_path = std::path::PathBuf::from(&data_dir).join("settings.json");
    let variant = match std::fs::read_to_string(&settings_path) {
        Ok(contents) => {
            serde_json::from_str::<serde_json::Value>(&contents)
                .ok()
                .and_then(|v| v.get("appIcon").and_then(|i| i.as_str().map(String::from)))
        }
        Err(e) => {
            eprintln!("[icon] could not read {}: {}", settings_path.display(), e);
            None
        }
    };

    if let Some(ref variant) = variant {
        if variant != "default" && !variant.is_empty() {
            // Delay icon application until after macOS finishes launching the app.
            // If set during setup(), macOS resets the dock icon to the bundle icon
            // when applicationDidFinishLaunching fires. We sleep past that, then
            // dispatch back to the main thread (MainThreadMarker requires it).
            let handle1 = app.clone();
            let handle2 = app.clone();
            let variant = variant.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let _ = handle1.run_on_main_thread(move || {
                    match set_app_icon(handle2, variant) {
                        Ok(msg) => eprintln!("[icon] startup: {}", msg),
                        Err(e) => eprintln!("[icon] startup error: {}", e),
                    }
                });
            });
        }
    }
}

#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, variant: String) -> Result<String, String> {
    let resource_dir = app.path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {}", e))?;

    if variant == "default" {
        // Reset to bundle's original icon
        #[cfg(target_os = "macos")]
        {
            // In a macOS .app bundle, Tauri places the icon at Contents/Resources/icon.icns.
            // resource_dir() points to Contents/Resources/, so icon.icns is directly inside.
            // In dev mode the icon lives at src-tauri/icons/icon.icns.
            let icns_data = std::fs::read(resource_dir.join("icon.icns"))
                .or_else(|_| std::fs::read(resource_dir.join("icons").join("icon.icns")))
                .map_err(|e| format!("read default icon: {}", e))?;
            set_macos_dock_icon(&icns_data);
        }
        #[cfg(not(target_os = "macos"))]
        {
            // On non-macOS, reset by loading the default PNG
            let png_path = resource_dir.join("icons/variants/variant-1.png");
            if let Ok(png_data) = std::fs::read(&png_path) {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(image) = tauri::image::Image::from_bytes(&png_data) {
                        let _ = win.set_icon(image);
                    }
                }
            }
        }
        return Ok("icon reset to default".to_string());
    }

    // Load the variant
    let png_path = resource_dir.join("icons/variants").join(format!("{}.png", variant));
    let png_data = std::fs::read(&png_path)
        .map_err(|e| format!("read icon {}: {}", png_path.display(), e))?;

    // Set window icon (cross-platform: taskbar on Windows/Linux)
    #[cfg(not(target_os = "macos"))]
    if let Some(win) = app.get_webview_window("main") {
        let image = tauri::image::Image::from_bytes(&png_data)
            .map_err(|e| format!("parse png: {}", e))?;
        let _ = win.set_icon(image);
    }

    // macOS: use .icns for proper squircle mask rendering
    #[cfg(target_os = "macos")]
    {
        let icns_path = resource_dir.join("icons/variants").join(format!("{}.icns", variant));
        let icon_data = std::fs::read(&icns_path).unwrap_or(png_data);
        set_macos_dock_icon(&icon_data);
    }

    Ok(format!("icon set to {}", variant))
}

/// Build the Apple continuous-corner rounded rect (squircle) path.
/// Uses the exact bezier control points reverse-engineered from Apple's icon shape
/// (see Liam Rosenfeld's "My Quest for the Apple Icon Shape"). This produces the
/// correct continuous-curvature corners that `NSBezierPath::bezierPathWithRoundedRect`
/// (which uses circular arcs) cannot match.
///
/// Coordinates are in flipped (screen) space: origin top-left, Y increases downward.
#[cfg(target_os = "macos")]
fn apple_squircle_path(
    l: f64, t: f64, r: f64, b: f64, cr: f64,
) -> objc2::rc::Retained<objc2_app_kit::NSBezierPath> {
    use objc2_app_kit::NSBezierPath;
    use objc2_core_foundation::CGPoint;

    let p = |x: f64, y: f64| CGPoint::new(x, y);

    let path = NSBezierPath::bezierPath();

    // Start at top edge, right of top-left corner
    path.moveToPoint(p(l + cr * 1.52866483, t));
    // Top edge
    path.lineToPoint(p(r - cr * 1.52866471, t));
    // Top-right corner
    path.curveToPoint_controlPoint1_controlPoint2(
        p(r - cr * 0.63149399, t + cr * 0.07491100),
        p(r - cr * 1.08849296, t),
        p(r - cr * 0.86840694, t),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(r - cr * 0.07491100, t + cr * 0.63149399),
        p(r - cr * 0.37282392, t + cr * 0.16905899),
        p(r - cr * 0.16905899, t + cr * 0.37282401),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(r, t + cr * 1.52866483),
        p(r, t + cr * 0.86840701),
        p(r, t + cr * 1.08849299),
    );
    // Right edge
    path.lineToPoint(p(r, b - cr * 1.52866471));
    // Bottom-right corner
    path.curveToPoint_controlPoint1_controlPoint2(
        p(r - cr * 0.07491100, b - cr * 0.63149399),
        p(r, b - cr * 1.08849299),
        p(r, b - cr * 0.86840701),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(r - cr * 0.63149399, b - cr * 0.07491100),
        p(r - cr * 0.16905899, b - cr * 0.37282401),
        p(r - cr * 0.37282392, b - cr * 0.16905899),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(r - cr * 1.52866483, b),
        p(r - cr * 0.86840694, b),
        p(r - cr * 1.08849296, b),
    );
    // Bottom edge
    path.lineToPoint(p(l + cr * 1.52866471, b));
    // Bottom-left corner
    path.curveToPoint_controlPoint1_controlPoint2(
        p(l + cr * 0.63149399, b - cr * 0.07491100),
        p(l + cr * 1.08849296, b),
        p(l + cr * 0.86840694, b),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(l + cr * 0.07491100, b - cr * 0.63149399),
        p(l + cr * 0.37282392, b - cr * 0.16905899),
        p(l + cr * 0.16905899, b - cr * 0.37282401),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(l, b - cr * 1.52866483),
        p(l, b - cr * 0.86840701),
        p(l, b - cr * 1.08849299),
    );
    // Left edge
    path.lineToPoint(p(l, t + cr * 1.52866471));
    // Top-left corner
    path.curveToPoint_controlPoint1_controlPoint2(
        p(l + cr * 0.07491100, t + cr * 0.63149399),
        p(l, t + cr * 1.08849299),
        p(l, t + cr * 0.86840701),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(l + cr * 0.63149399, t + cr * 0.07491100),
        p(l + cr * 0.16905899, t + cr * 0.37282401),
        p(l + cr * 0.37282392, t + cr * 0.16905899),
    );
    path.curveToPoint_controlPoint1_controlPoint2(
        p(l + cr * 1.52866483, t),
        p(l + cr * 0.86840694, t),
        p(l + cr * 1.08849296, t),
    );
    path.closePath();

    path
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(icon_data: &[u8]) {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSColor, NSCompositingOperation,
        NSGraphicsContext, NSImage, NSShadow,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::NSData;

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[icon] not on main thread — cannot set dock icon");
        return;
    };

    let data = NSData::with_bytes(icon_data);
    let Some(source) = NSImage::initWithData(NSImage::alloc(), &data) else {
        eprintln!("[icon] failed to create NSImage from data");
        return;
    };

    // Render to match macOS Dock icon appearance. setApplicationIconImage does NOT
    // apply the system mask — only bundle icons get that treatment.
    //
    // Apple icon grid (1024×1024 canvas):
    //   Body: 824×824, inset 100px from each edge
    //   Corner radius: 185.4px (= 824 × 0.225, i.e. 45% of half the side)
    //   Shadow: ~10px Y offset, ~18px blur, ~25% black
    //
    // The squircle shape uses Apple's continuous-corner bezier curves (NOT circular
    // arcs from NSBezierPath::bezierPathWithRoundedRect).
    let canvas = 1024.0;
    let body = 824.0;
    let inset = (canvas - body) / 2.0; // 100
    let cr = 208.0;

    // Shift body up ~8px so shadow below doesn't clip at canvas edge.
    // In macOS coords (Y-up), "up" = larger Y.
    let body_y = inset + 8.0; // 108
    let body_rect = CGRect::new(
        CGPoint::new(inset, body_y),
        CGSize::new(body, body),
    );

    source.setSize(CGSize::new(body, body));

    #[allow(deprecated)]
    let result = NSImage::initWithSize(NSImage::alloc(), CGSize::new(canvas, canvas));
    #[allow(deprecated)]
    result.lockFocus();

    // The squircle path is vertically symmetric so the bezier constants work in
    // both Y-up (macOS) and Y-down (screen) coords — just pass min_y as t, max_y as b.
    let path = apple_squircle_path(
        inset,               // left
        body_y,              // t (min Y)
        inset + body,        // right
        body_y + body,       // b (max Y)
        cr,
    );

    // 1) Draw shadow: fill the squircle shape with shadow enabled. The shadow
    //    is cast outside the fill. The white fill itself gets covered by the icon.
    NSGraphicsContext::saveGraphicsState_class();
    let shadow = NSShadow::new();
    shadow.setShadowOffset(CGSize::new(0.0, -10.0));  // negative Y = downward in macOS coords
    shadow.setShadowBlurRadius(80.0);
    shadow.setShadowColor(Some(&NSColor::colorWithWhite_alpha(0.0, 0.3)));
    shadow.set();
    NSColor::colorWithWhite_alpha(1.0, 1.0).setFill();
    path.fill();
    NSGraphicsContext::restoreGraphicsState_class();

    // 2) Draw the icon clipped to the squircle (covers the white fill exactly)
    NSGraphicsContext::saveGraphicsState_class();
    path.addClip();
    source.drawInRect_fromRect_operation_fraction(
        body_rect,
        CGRect::ZERO,
        NSCompositingOperation::Copy,
        1.0,
    );
    NSGraphicsContext::restoreGraphicsState_class();

    #[allow(deprecated)]
    result.unlockFocus();

    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&result)); }
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
    let confirmed = app.state::<QuitConfirmed>();
    confirmed.0.store(true, Ordering::SeqCst);
    app.exit(0);
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

#[tauri::command]
async fn quicklook(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("qlmanage")
            .arg("-p")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // On non-macOS, open with default application via xdg-open/start
        let cmd = if cfg!(target_os = "windows") { "start" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
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
                if !confirmed.0.load(Ordering::SeqCst) {
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
            set_app_icon,
            request_attention,
            request_attention_once,
            pick_folder,
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

            // Apply saved icon variant on startup
            apply_saved_icon(app.handle());

            // --- Dev mode: spawn Node server directly via tsx ---
            #[cfg(debug_assertions)]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");

                let app_args: Vec<String> = std::env::args().collect();
                // Dev builds always start a clean server: if a prior instance is running,
                // --replace tells the CLI to shut it down before starting.
                let mut server_args = vec![
                    "tsx".to_string(),
                    "--tsconfig".to_string(),
                    "tsconfig.json".to_string(),
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
                server_args.extend(collect_forwarded_server_args(&app_args));

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
                        // Case 1: server started fresh
                        if let Some(idx) = line.find("running at ") {
                            let url = line[idx + "running at ".len()..].trim().to_string();
                            if let Ok(parsed) = url.parse() {
                                let _ = window.navigate(parsed);
                            }
                            break;
                        }
                        // Case 2: joined an existing running instance
                        if let Some(idx) = line.find("running instance on port ") {
                            let port_str = line[idx + "running instance on port ".len()..].trim().to_string();
                            let url = format!("http://localhost:{}", port_str);
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
                    if !confirmed.0.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("quit-confirm-requested", ());
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    // Kill the sidecar process on app exit
                    if let Some(pid) = app_handle.state::<SidecarPid>().0.lock().unwrap().take() {
                        #[cfg(unix)]
                        {
                            // Send SIGTERM to let the Node process clean up (release lock files, etc.)
                            unsafe {
                                libc::kill(pid as i32, libc::SIGTERM);
                                libc::kill(-(pid as i32), libc::SIGTERM);
                            }
                            // Wait briefly for cleanup before the process is force-killed by OS
                            std::thread::sleep(std::time::Duration::from_millis(300));
                        }
                        #[cfg(windows)]
                        {
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .status();
                        }
                    }
                }
                _ => {}
            }
        });
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
}
