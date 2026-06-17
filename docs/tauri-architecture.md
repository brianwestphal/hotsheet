# Tauri Desktop App Architecture

Hot Sheet's desktop app wraps the Node.js server in a native window using Tauri v2. This document explains how the pieces fit together.

## Why a sidecar?

PGLite (embedded PostgreSQL compiled to WASM) needs filesystem access to its data files and WASM modules. Single-binary compilers like `pkg` or `bun compile` break this because they virtualize the filesystem. So instead of compiling the server to a native binary, we bundle a **Node.js binary as a Tauri sidecar** and run the server JS bundle through it.

## File layout

```
src-tauri/
├── src/
│   ├── lib.rs              # Core app logic (setup, sidecar management, CLI install)
│   └── main.rs             # Entry point → lib.rs::run()
├── tauri.conf.json         # Tauri config (window, bundling, updater, sidecar)
├── Cargo.toml              # Rust dependencies
├── Entitlements.plist      # macOS entitlements (JIT for V8/WASM)
├── capabilities/
│   └── default.json        # Permissions (shell:sidecar, updater, process)
├── loading/
│   ├── index.html          # "Starting Hot Sheet..." spinner
│   └── welcome.html        # First-run CLI install wizard
├── resources/
│   ├── hotsheet            # macOS CLI launcher script
│   ├── hotsheet-linux      # Linux CLI launcher script
│   └── hotsheet.cmd        # Windows CLI launcher batch
├── binaries/
│   └── hotsheet-node-*     # Downloaded Node.js binary (per target triple)
├── server/                 # Bundled server JS + client assets + node_modules
│   ├── cli.js
│   ├── client/
│   └── node_modules/
└── icons/
```

```
scripts/
├── build-sidecar.sh        # Downloads Node.js + bundles server for production
├── ensure-sidecar-stub.sh  # Creates placeholder binary for dev mode
└── release.sh              # npm + Tauri version bumping + publish
```

## Launch flows

There are three ways the app starts, each with a different code path:

### 1. Double-click the app (no `--data-dir`)

```
User double-clicks Hot Sheet.app
  → Tauri binary starts
  → No --data-dir arg detected
  → Navigates to welcome.html (CLI install wizard)
  → Checks for updates in background
```

The welcome screen uses `window.__TAURI__.core.invoke()` to call `check_cli_installed` and `install_cli` Rust commands. These check whether `/usr/local/bin/hotsheet` exists and create the symlink (with admin prompt on macOS).

### 2. CLI launch: `hotsheet` (macOS — the complex one)

This is the most involved flow because of two macOS restrictions:
- **WASM/JIT is blocked** for processes launched via `open -a` on unsigned app bundles
- **Filesystem access to `~/Documents`** is denied for unsigned apps (TCC privacy)

The solution splits server startup from the Tauri window:

```
User runs `hotsheet` in a project directory
  │
  ├─ CLI script (resources/hotsheet) runs in terminal context
  │   ├─ Resolves app name from .hotsheet/settings.json or folder name
  │   ├─ Creates/updates a stub .app in .hotsheet/ (for Dock/Cmd+Tab identity)
  │   ├─ Starts Node server in background (terminal context = JIT works)
  │   ├─ Waits for "running at http://..." in server output
  │   ├─ Writes URL + PID to /tmp/hotsheet-server-{hash}.info
  │   └─ Runs: open -a ".hotsheet/Hot Sheet — projectname.app"
  │
  └─ Stub app launches
      ├─ Launcher script reads /tmp info file
      ├─ Sets HOTSHEET_SERVER_URL and HOTSHEET_SIDECAR_PID env vars
      └─ exec's to the real Tauri binary with --data-dir
          ├─ Detects HOTSHEET_SERVER_URL → navigates directly (no sidecar spawn)
          ├─ Stores HOTSHEET_SIDECAR_PID for cleanup on exit
          ├─ Sets window title from settings.json or folder name
          └─ Checks for updates in background
```

**Why the stub app?** Each project gets its own `.app` bundle with a unique `CFBundleName` in its `Info.plist`. This gives each instance a distinct name in the Dock and Cmd+Tab switcher (e.g., "Hot Sheet — myproject" vs "Hot Sheet — otherproject").

**Why start Node from the CLI script?** macOS blocks V8 JIT execution and restricts filesystem access for apps launched via `open -a` on unsigned bundles. By starting the Node server in the terminal (where these restrictions don't apply), we avoid PGLite WASM crashes. The server URL is passed to the Tauri window through a temp file in `/tmp/`.

### 3. Tauri binary with `--data-dir` (fallback / direct launch)

When the Tauri binary is run directly with `--data-dir` but without `HOTSHEET_SERVER_URL`, it spawns the sidecar itself:

```
Tauri binary starts with --data-dir
  → No HOTSHEET_SERVER_URL env var
  → Resolves cli.js from app resource directory
  → Spawns hotsheet-node sidecar via tauri-plugin-shell
  → Reads sidecar stdout for "running at http://..."
  → Navigates window to that URL
  → Stores sidecar PID for cleanup
```

This path works for direct binary execution (e.g., during development or on platforms without stub app complexity).

## Sidecar lifecycle

The Node.js server process must be cleaned up when the Tauri window closes:

- **PID tracking**: The sidecar PID is stored in `SidecarPid` managed state, whether it comes from `HOTSHEET_SIDECAR_PID` (CLI launch) or from the sidecar spawn.
- **Exit handler**: The `.build().run()` pattern provides a `RunEvent::Exit` callback that kills the sidecar's process group on shutdown:
  - Unix: `libc::kill(-pid, SIGTERM)` — negative PID targets the process group
  - Windows: `taskkill /PID ... /T /F` — `/T` kills the process tree
- **Graceful exit only**: This cleanup runs on Cmd+Q or window close. Force-killing the Tauri process (e.g., `kill -9`) will orphan the Node server. PGLite's lock file (`postmaster.pid`) must then be manually removed before the next launch.

## IPC capabilities & the remote-origin gotcha (HS-8828)

Hot Sheet's frontend is **not** a bundled Tauri asset — it's served by the Node server over `http://localhost:<port>`, and the main window `navigate()`s there (dev *and* prod). To Tauri's security model that is a **remote origin**, not trusted local app content, so IPC from it is governed by a dedicated capability:

- `capabilities/remote-localhost.json` — `"remote": { "urls": ["http://localhost:*", "http://localhost:*/*"] }`, granting `core:default`, `notification:default`, and an explicit `allow-<cmd>` for **every** app command the frontend invokes.
- `capabilities/default.json` — the same grants for local content (the pre-navigation `loading/` splash), as a safety mirror.

**The gotcha:** an app's own `#[tauri::command]`s are allowed for *local* windows by default, but **NOT for a remote-origin window** — each must be granted explicitly. Those `allow-<cmd>` permissions don't exist until the commands are declared in `src-tauri/build.rs`:

```rust
tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["confirm_quit", "quicklook", /* … */]),
    ),
).expect("failed to run tauri-build");
```

This generates `allow-<cmd>` / `deny-<cmd>` permissions (kebab-case: `confirm_quit` → `allow-confirm-quit`) into `gen/schemas/`, which the capability files then reference.

**Tauri 2.10 → 2.11 regression that caused HS-8828:** 2.10 still tolerated app commands on the remote origin without explicit grants; 2.11 (bumped 2026-06-16) enforces it, rejecting ungranted calls with `<cmd> not allowed. Plugin not found`. That silently broke **Quit** (`confirm_quit` rejected → `app.exit(0)` never ran → window stayed open) and **Quick Look** (`quicklook` rejected → broken-image fallback, HS-8826).

**Maintenance rule:** when you add a `#[tauri::command]` that the frontend calls, you MUST (1) add it to `generate_handler!` in `lib.rs`, (2) add it to the `commands(&[…])` list in `build.rs`, and (3) add `allow-<cmd>` to both capability files. Forgetting (2)/(3) makes the command fail *only from the desktop app* (Playwright/browser tests won't catch it — there's no Tauri ACL there). `cargo check` validates that every `allow-*` in a capability resolves, so a typo'd identifier fails the build. The `acl_grant_sync_tests` module in `lib.rs` (run by `npm run test:rust`) goes further: it parses these four lists from source and fails if they drift — every `generate_handler!` command must be registered in `build.rs`, and every registered command must be granted in *both* capability files — so a forgotten grant is a unit-test failure, not a desktop-only runtime regression.

## Dev mode vs production

| | Dev (`tauri:dev`) | Production (`tauri:build`) |
|---|---|---|
| Node server | Runs via `npm run dev:server` (tsx, separate process) | Bundled sidecar (downloaded Node.js binary) |
| Frontend | Loaded from `http://localhost:4174` (dev URL) | Loaded from `loading/index.html`, then navigated |
| Sidecar binary | Stub placeholder (from `ensure-sidecar-stub.sh`) | Real Node.js binary (from `build-sidecar.sh`) |
| Server code | Source TypeScript via tsx | Bundled `cli.js` in `server/` resource dir |
| Release-only code | Skipped (`#[cfg(not(debug_assertions))]`) | Active (sidecar spawn, welcome screen, updater) |

In dev mode, Tauri's `beforeDevCommand` starts the Node server, and the webview connects to `devUrl`. The sidecar binary is never used — `ensure-sidecar-stub.sh` creates a no-op placeholder so Tauri's build system doesn't complain about a missing binary.

## Build pipeline

### `npm run tauri:build`

1. **`scripts/build-sidecar.sh`** runs first:
   - Downloads Node.js v20 for the target platform (cached if already present)
   - Places it at `src-tauri/binaries/hotsheet-node-{target-triple}`
   - Runs `npm run build` (tsup → `dist/cli.js` + client assets)
   - Copies `dist/`, client assets, and runtime `node_modules` into `src-tauri/server/`

2. **`tauri build`** then:
   - Compiles Rust code
   - Bundles the `.app` (macOS), `.AppImage` (Linux), or `.msi` (Windows)
   - Includes the sidecar binary, server resources, CLI launcher scripts, and icons

### CI/CD (`.github/workflows/release-desktop.yml`)

Triggered by git tags (`v*`) or manual dispatch. Builds for 4 targets:
- macOS aarch64 (Apple Silicon) + x86_64 (Intel)
- Linux x86_64
- Windows x86_64

macOS builds are code-signed and notarized via Apple Developer credentials. All builds are update-signed with the Tauri updater key. Creates a draft GitHub Release with all artifacts + `latest.json` for auto-updates.

**Per-platform release notes (HS-7963).** The `Extract release notes from tag` step composes the release body to include direct download links per platform (macOS Apple Silicon / macOS Intel / Linux deb+AppImage+rpm / Windows exe+msi) on top of any tag-annotation body the maintainer wrote, plus a closing npm-install hint. Asset URLs are deterministic — composed from `${{ github.repository }}` + the tag — so they're embedded at release-create time even though the rename step (`HotSheet-<version>-macOS-{Apple-Silicon,Intel}.dmg`) runs in a later job. If a build for a given platform fails, its direct link 404s; the user falls through to the always-present "Assets" list below.

## Auto-updates

The app checks for updates on every launch via `tauri-plugin-updater`. Updates are served from GitHub Releases — the CI generates a `latest.json` file that the updater reads to determine if a new version is available. Updates are verified against a public key embedded in `tauri.conf.json`.

The CLI symlink (`/usr/local/bin/hotsheet` → `Hot Sheet.app/Contents/Resources/resources/hotsheet`) automatically points to the updated app — no re-installation needed.

## macOS entitlements

`Entitlements.plist` grants three permissions required for V8/WASM execution under Hardened Runtime (which is required for notarization):

- `com.apple.security.cs.allow-jit` — V8 JIT compilation
- `com.apple.security.cs.allow-unsigned-executable-memory` — WASM memory
- `com.apple.security.cs.disable-library-validation` — Loading bundled Node.js

Without these, PGLite's WASM crashes with `RuntimeError: unreachable` on CI-built (code-signed) binaries.

## Platform-specific CLI launchers

Each platform has a launcher script bundled as a Tauri resource:

| Platform | File | Install location | Mechanism |
|----------|------|-----------------|-----------|
| macOS | `resources/hotsheet` | `/usr/local/bin/hotsheet` (symlink) | Starts server, creates stub `.app`, `open -a` |
| Linux | `resources/hotsheet-linux` | `~/.local/bin/hotsheet` (symlink) | Starts Tauri binary directly |
| Windows | `resources/hotsheet.cmd` | `%LOCALAPPDATA%/Programs/hotsheet/hotsheet.cmd` (copy) | Starts Tauri binary with `start` |

The macOS launcher is significantly more complex due to the stub app mechanism. Linux and Windows launchers are straightforward — they just exec the Tauri binary with `--data-dir`.

## Apple Foundation Models helper (Announcer on-device provider, HS-8790)

The Announcer can summarize on-device via Apple Foundation Models (§78, macOS 26
+ Apple Intelligence) instead of the Anthropic cloud API. Apple's `FoundationModels`
framework is native-only, and the **Node sidecar can't call Tauri/Swift** (the
`invoke` IPC is WebView→Rust only). So the provider is a standalone **Swift CLI
helper** the server shells out to — keeping summarization server-side, so it works
in both the manual "Listen" path and the live-mode generator.

- **Source:** `src-tauri/apple-fm-helper/main.swift` (NOT compiled by cargo).
  `--probe` prints `available`/`unavailable`; `--summarize` reads
  `{"system","material"}` JSON on stdin and writes `{"entries":[…]}` JSON on
  stdout. Uses **guided generation** (`@Generable`/`@Guide` + `respond(to:generating:)`)
  so the structure is guaranteed, then re-encodes the exact wire shape — no fragile
  prompt-to-JSON. **Verified compiling + running on macOS 26.5 / Xcode 26.5**
  (`swiftc -target arm64-apple-macos26`; `--probe` → `available`, `--summarize`
  produced clean structured entries on-device).
- **Build:** `scripts/build-apple-fm-helper.sh [outPath]` compiles (and, with
  `CODESIGN_IDENTITY` set, signs) it. It is **guarded** — a no-op (exit 0) on
  non-macOS, when `swiftc` is missing, or when the macOS 26 SDK isn't present —
  so it can be called from any build without breaking it. `npm run build:apple-fm-helper`
  is the alias (outputs `./apple-fm-helper` at the repo root); **`npm run tauri:dev`
  calls it automatically** (the guard no-ops it off macOS).
- **Server resolution:** `src/announcer/appleFoundation.ts` finds the binary via
  `HOTSHEET_APPLE_FM_BIN` (preferred), else `<cwd>/apple-fm-helper`. On non-darwin
  / missing binary / failing probe it reports unavailable and the Announcer falls
  back to Anthropic.

**Dev (`npm run tauri:dev`) works out of the box on macOS:** `tauri:dev` builds
the helper to `./apple-fm-helper`, and the Rust app spawns the dev server (`npx
tsx src/cli.ts`) with **cwd = repo root** (`lib.rs`), so the server discovers the
helper via the `<cwd>/apple-fm-helper` fallback — no env var or bundling needed.
A swiftc-built binary is ad-hoc-signed and could call `FoundationModels` locally
in testing. (For the plain `npm run dev` browser path, run `npm run build:apple-fm-helper`
once first.)

**To finish wiring the *signed, packaged* bundle (remaining desktop task):**
(1) call `scripts/build-apple-fm-helper.sh` from `build-sidecar.sh` so the binary
lands in the bundled `server/` dir (or a Tauri resource); (2) include it in
`tauri.conf.json` bundle resources so it's code-signed + notarized with the app
(Hardened Runtime, like the Node sidecar); (3) set `HOTSHEET_APPLE_FM_BIN` to its
installed path when the launcher starts the server (or place it at
`<cwd>/apple-fm-helper`). Until then the *packaged* app's option stays hidden
(probe returns false) and it uses Anthropic.
