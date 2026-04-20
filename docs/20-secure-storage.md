# 20. Secure Storage for Plugin Secrets

## 20.1 Overview

Plugin preferences marked with `secret: true` (e.g., Personal Access Tokens) are currently stored in plain text in `~/.hotsheet/plugin-config.json` (global scope) or the project's PGLite database (project scope). This document specifies secure storage via the OS keychain when running in Tauri, with a transparent fallback to the current file/DB storage in browser mode.

## 20.2 Design Goals

- **Transparent to plugins**: plugins use the existing `context.getSetting(key)` / `context.setSetting(key, value)` API. The storage backend is chosen automatically based on (a) whether the preference is `secret: true` and (b) whether Tauri keychain access is available.
- **OS-native security**: in the Tauri desktop app, secrets are stored in the macOS Keychain / Windows Credential Manager / Linux Secret Service via the `keyring` Rust crate.
- **Graceful fallback**: in the web browser, or if the keychain is unavailable (locked, permissions denied), secrets fall back to the existing storage (global config file or project DB).
- **No data loss**: existing secrets in `plugin-config.json` continue to work. Migration to the keychain is opportunistic — on first read, if the value exists in the file but not the keychain, it's copied to the keychain and optionally removed from the file.

## 20.3 Keychain Entry Format

Each secret preference is stored as a separate keychain entry:

- **Service**: `com.hotsheet.plugin.{pluginId}` (e.g., `com.hotsheet.plugin.github-issues`)
- **Account**: the preference key (e.g., `token`)
- **Password**: the preference value (the secret string)

This per-key granularity allows individual secrets to be managed independently (e.g., revoking a single token without touching others).

## 20.4 Tauri Integration

> **Note:** The Tauri Rust keychain design described in this section (§20.4.1–20.4.3) was considered but not implemented. The actual approach uses Node.js platform commands (`security` on macOS, `secret-tool` on Linux) and is described in §20.8.

### 20.4.1 Rust Side

Add the `keyring` crate to `src-tauri/Cargo.toml`:

```toml
[dependencies]
keyring = "3"
```

Expose two Tauri commands:

```rust
#[tauri::command]
fn keychain_get(service: String, account: String) -> Result<Option<String>, String>;

#[tauri::command]
fn keychain_set(service: String, account: String, password: String) -> Result<(), String>;

#[tauri::command]
fn keychain_delete(service: String, account: String) -> Result<(), String>;
```

These are thin wrappers around `keyring::Entry::new(&service, &account)` with `.get_password()`, `.set_password()`, `.delete_credential()`.

### 20.4.2 Client Side

The client already detects Tauri via `getTauriInvoke()`. No client-side changes needed for secret storage — secrets are read/written server-side via `context.getSetting()` / `context.setSetting()`.

### 20.4.3 Server Side

The server-side `createPluginContext` in `src/plugins/loader.ts` handles `getSetting` and `setSetting`. For `secret: true` preferences:

1. **getSetting**: try keychain first (via Tauri invoke if available). If not found, fall back to `plugin-config.json`. If found in file but not keychain, migrate to keychain.
2. **setSetting**: write to keychain if available. Always also write to file as fallback (for browser mode and migration).

**Open question**: Should the server call Tauri commands? The server runs as a Node.js process, not in the Tauri webview. Tauri commands are typically called from the frontend. Options:
- **(a)** The server stores secrets in the file as today; the Tauri sidecar reads from the keychain and patches the config on startup.
- **(b)** The server exposes an HTTP endpoint (`GET /api/keychain/:service/:account`); the Tauri app's Rust code serves this endpoint by reading the keychain.
- **(c)** The server calls keychain directly via Node.js (using a Node keychain library like `keytar` or spawning `security` on macOS).

Option (c) is simplest for the Node server architecture. The `keytar` npm package (or its successor) provides cross-platform keychain access from Node.js without Tauri. This works in both the Tauri sidecar and the standalone CLI.

## 20.5 Migration

On first read of a `secret: true` preference:
1. Check the keychain. If found, return it.
2. If not in keychain, check `plugin-config.json` (or project DB for project-scoped secrets).
3. If found in file, store it in the keychain for next time.
4. Optionally: remove the plain-text value from the file after successful keychain write (configurable, default: keep both for safety during rollout).

## 20.6 Fallback Behavior

| Runtime | Keychain available | Behavior |
|---------|-------------------|----------|
| Tauri (macOS) | Yes | Keychain for secrets, file/DB for non-secrets |
| Tauri (macOS, keychain locked) | No | File/DB for everything (log warning) |
| Browser (localhost) | No | File/DB for everything |
| CLI (macOS/Linux) | Yes | Spawns `security` / `secret-tool` — no native deps |
| CLI (Windows) | No | File/DB for everything (Windows support not yet implemented) |

## 20.7 Security Considerations

- The keychain entry's **service name** includes the plugin ID, preventing cross-plugin secret leakage.
- Secrets are never logged or included in error messages.
- The `secret: true` preference flag already causes the client to render `<input type="password">` — no UI change needed.
- Plain-text fallback means browser-mode users have the same security posture as today. The keychain is an improvement for desktop users.
- Both file and keychain are written on set (dual-write) so fallback always works.

## 20.8 Implementation Decisions

1. **Platform commands, not native deps**: uses `security` on macOS and `secret-tool` on Linux via `execFile`. Zero native Node dependencies — no `node-gyp`, no `keytar`, no build issues. Works in both Tauri sidecar and standalone CLI.
2. **File kept after migration**: the plain-text value is NOT removed from `plugin-config.json` after keychain migration. Both stores are written on every set (dual-write). This prioritizes reliability over maximum security — the keychain is checked first on read, so the file value is only used as fallback.
3. **All secret preferences**: all preferences with `secret: true` use the keychain, regardless of scope. The keychain is checked first on read; file/DB serves as fallback.
4. **Implemented in**: `src/keychain.ts` (platform abstraction), `src/plugins/loader.ts` (getSetting/setSetting integration), `src/routes/plugins.ts` (global-config GET/POST routes).
