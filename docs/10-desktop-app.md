# 10. Desktop Application (Tauri)

## Functional Requirements

### 10.1 Native Wrapper

- The desktop app wraps the web UI in a native window using Tauri v2.
- The Node.js server runs as a sidecar process managed by the Tauri app.
- The webview navigates to the locally-running server once it reports its URL.

### 10.2 Sidecar Management

Two launch modes:

- **CLI launcher** — The CLI shell script pre-starts the Node server, sets `HOTSHEET_SERVER_URL` and `HOTSHEET_SIDECAR_PID` environment variables, then launches the Tauri app. The app navigates directly to the pre-started server and stores the PID for cleanup.
- **Direct sidecar** — If no pre-started server is detected, the Tauri app spawns the Node sidecar itself via `hotsheet-node`, passing `--no-open` and `--data-dir` arguments. It watches stdout for the "running at" message to know when to navigate.

On app exit, the sidecar process is terminated:
- Unix: `SIGTERM` to the process directly, then to the process group as fallback.
- Windows: `taskkill /PID /T /F`.

### 10.3 Welcome Screen

- If launched without `--data-dir` (e.g., double-clicking the app icon), a welcome/setup screen is shown instead of the main UI.
- The welcome screen navigates to `tauri://localhost/welcome.html`.

### 10.4 Window Title

- Default title: "Hot Sheet".
- If a custom `appName` is set in `.hotsheet/settings.json`, the window title uses that name.
- Otherwise, falls back to "Hot Sheet — {project_folder_name}" based on the data directory's parent folder.

### 10.5 Software Updater

- Checks for updates via the Tauri updater plugin against a GitHub releases endpoint.
- The update check runs asynchronously on startup and stores the result for the UI to poll.
- A "Check for Updates" button in the settings dialog allows manual checking with explicit feedback ("Your software is up to date." or the available version).
- When an update is available, a banner appears with an "Install Update" button.
- Installing downloads and applies the update; the user is prompted to restart.
- The update is user-initiated — the app never silently installs updates.

### 10.6 CLI Installer

- The desktop app can install the `hotsheet` CLI command for terminal use.
- Platform-specific installation:
  - macOS: Symlinks to `/usr/local/bin/hotsheet` (requires admin privileges via osascript).
  - Linux: Symlinks to `~/.local/bin/hotsheet`.
  - Windows: Copies to `%LOCALAPPDATA%\Programs\hotsheet\hotsheet.cmd` and adds to user PATH via registry.
- The `check_cli_installed` command reports whether the CLI is installed and provides a manual install command.

### 10.7 IPC Commands

| Command | Description |
|---------|-------------|
| `check_cli_installed` | Check if CLI is installed, return manual install command |
| `install_cli` | Install the CLI with platform-specific logic |
| `get_pending_update` | Poll for a pending update version (stored from async check) |
| `check_for_update` | Actively check for updates, return version or null |
| `install_update` | Download and install the pending update |

### 10.8 Capabilities

- `default` — Grants core IPC, shell (sidecar spawn), updater, and process permissions to the main window.
- `remote-localhost` — Grants core IPC to `http://localhost:*` URLs so the Node-served frontend can call Tauri commands.

### 10.8.1 WKWebView Dialog Limitations

Native JavaScript dialogs (`confirm()`, `alert()`) may be suppressed or auto-dismissed in the Tauri WKWebView on macOS. The app avoids relying on `confirm()` for destructive actions, using direct actions or custom HTML dialogs instead.

## Non-Functional Requirements

### 10.9 Platforms

- macOS: arm64 (Apple Silicon) and x86_64 (Intel), `.app.tar.gz` bundles.
- Windows: x86_64, MSI and NSIS installers.
- Linux: x86_64, AppImage, deb, and rpm packages.

### 10.10 Security

- Updates are signed with a public key and verified before installation.
- CSP is disabled (set to null) since the frontend is served from localhost.
- The app never silently installs updates; user action is required.

### 10.11 Build Artifacts

- Server code bundled in `server/` resource directory.
- CLI launcher scripts bundled in `resources/` (platform-specific).
- Node.js bundled as `hotsheet-node` external binary (sidecar).
