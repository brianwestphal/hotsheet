# 13. App Icon Variants

## 13.1 Overview

Hot Sheet ships with 9 app icon variants that users can switch between in Settings. The selected icon is applied to the dock icon at runtime and persists across launches. All variants use the Hot Sheet flame motif.

## 13.2 Icon Variants

| Variant | Description |
|---------|-------------|
| 1 | Blue gradient flame on lined paper (default) |
| 2 | Green gradient flame on lined paper |
| 3 | Gray/silver gradient flame on lined paper |
| 4 | White flame on orange-red gradient, rounded |
| 5 | White flame on blue gradient, rounded |
| 6 | White flame on yellow-green gradient, rounded |
| 7 | White flame on dark gray gradient, rounded |
| 8 | White flame on black, square |
| 9 | Black flame on white, square |

Source PNGs are stored in the project's `.hotsheet/attachments/` (development) and bundled as Tauri resources at `icons/variants/` in production.

## 13.3 Settings UI

- A dropdown button appears in Settings → General, next to the App Name field.
- The dropdown shows a grid of icon variant thumbnails (small previews of each variant).
- Clicking a variant selects it immediately — the dock icon updates without requiring a relaunch.
- The currently selected variant has a visible indicator (border or checkmark).

## 13.4 Storage

- Selected variant stored as `app_icon` in `.hotsheet/settings.json` (file-based, not database).
- Values: `"default"` or `"variant-1"` through `"variant-9"`. Default: `"default"` (variant 1).
- Read by both the Rust Tauri binary and the CLI launcher shell script.

## 13.5 Implementation — Tauri (Desktop)

### Runtime Dock Icon Change

A Tauri command `set_app_icon` accepts a variant identifier:

1. Reads the corresponding `.icns` from bundled resources (`icons/variants/{variant}.icns`), falling back to PNG.
2. Creates an `NSImage` from the icon data using the `objc2` crate.
3. Renders the icon to match macOS Dock appearance using Apple's exact icon grid: 824×824 body within 1024×1024 canvas, clipped to a continuous-corner rounded rect (the "squircle" shape) using bezier control points reverse-engineered from Apple's implementation (corner radius 45% of half-side), with a drop shadow via `NSShadow`. This replicates the Dock's treatment of bundle icons, which `setApplicationIconImage` does not apply automatically.
4. Calls `NSApplication.sharedApplication().setApplicationIconImage(renderedImage)` to update the dock icon immediately.
5. No relaunch required.

### Reset to Default

When switching back to "default", reads `icon.icns` from the resource directory (the bundle's original icon) and applies the same rendering process.

### Startup

Icon restoration uses two complementary mechanisms:

1. **Client-side (primary):** When the web page loads, the client reads `appIcon` from `/api/file-settings` and invokes the Tauri `set_app_icon` command. This is the most reliable path because the page loads after the app is fully initialized and the Dock has settled.
2. **Rust-side (fallback):** During `setup()`, the Rust code reads `appIcon` from `.hotsheet/settings.json` and dispatches `set_app_icon` to the main thread after a 500ms delay via `run_on_main_thread`. The delay is necessary because macOS resets the dock icon to the bundle icon during app launch.

### Icon Resources

All 9 variant PNGs are bundled as Tauri resources. Each variant needs a single high-resolution PNG (512x512 or 1024x1024). The same PNG is used for both the `NSImage` runtime update and for generating `.icns` files.

## 13.6 Implementation — CLI Launcher (Stub App)

The CLI launcher script (`resources/hotsheet`) creates a stub `.app` for Dock/Cmd+Tab identity.

### Icon Selection in Stub

When creating or updating the stub app:

1. Read `app_icon` from `.hotsheet/settings.json` using the bundled Node binary.
2. If a variant is selected, symlink or copy the corresponding `.icns` file from the main app bundle's resources to the stub's `Contents/Resources/icon.icns`.
3. If no variant is set or value is `"default"`, use the main app's `icon.icns` (current behavior).

### Stub Regeneration

The stub should be regenerated (icon updated) when:
- The app name changes (existing behavior).
- The `app_icon` setting changes. The stub creation check should also compare the current icon variant.

## 13.7 Icon File Preparation

Each variant PNG must be converted to `.icns` format for macOS. The build process should:

1. Take the 9 source PNGs (1024x1024).
2. Generate multi-resolution `.icns` files using `iconutil` or `sips`.
3. Place them in `src-tauri/icons/variants/variant-{1-9}.icns`.
4. Also keep the PNGs as Tauri resources for the runtime `NSImage` creation.

## 13.8 Cross-Platform Support

Icon switching works on all platforms:
- **macOS**: Dock icon updated via `NSApplication.setApplicationIconImage()` (objc2 crate). Window icon also set via Tauri `set_icon()`.
- **Windows**: Taskbar icon updated via Tauri `Window::set_icon()`.
- **Linux**: Window icon updated via Tauri `Window::set_icon()`.

No relaunch required on any platform. The Rust command `set_app_icon` handles all platforms in a single call.

## 13.9 Requirements

- The default icon must match the existing app icon to avoid confusion on first install.
- Stub app icon update may require relaunching the CLI (the stub is recreated on next launch).
- Icon variant PNGs are bundled as both Tauri resources (for runtime `set_icon`) and as static client assets (for the settings UI thumbnails).
