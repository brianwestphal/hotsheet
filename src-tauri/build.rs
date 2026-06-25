// HS-8828 — register the app's own `#[tauri::command]`s with the ACL so they can
// be explicitly granted to the remotely-navigated WebView. Hot Sheet's frontend
// is served by the Node server over `http://localhost:<port>` — a "remote"
// origin from Tauri's point of view — and the main window navigates there.
//
// Tauri 2.11 (Dependabot bump, 2026-06-16: tauri 2.10.3 → 2.11.2 / wry 0.54.3 →
// 0.55.1) stopped treating a remote-origin webview as a trusted "app window".
// App commands that used to be allowed there by default (`confirm_quit`,
// `quicklook`, …) started being rejected from the localhost frontend with
// `<cmd> not allowed. Plugin not found` — which broke Quit ("Quit Anyway" no
// longer fires `app.exit(0)`) and Quick Look (fell back to the broken-image
// overlay, HS-8826).
//
// Declaring the commands here generates `allow-<command>` / `deny-<command>`
// permissions (kebab-case) that `capabilities/remote-localhost.json` grants to
// the localhost origin. KEEP THIS LIST IN SYNC with the `generate_handler!`
// list in `src/lib.rs` (and the matching grants in the two capability files).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "check_cli_installed",
                "install_cli",
                "get_pending_update",
                "check_for_update",
                "install_update",
                "request_attention",
                "request_attention_once",
                "pick_folder",
                "save_file",
                "open_url",
                "set_window_title",
                "show_native_notification",
                "quicklook",
                "confirm_quit",
                "tts_speak",
                "tts_stop",
                "open_project",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
