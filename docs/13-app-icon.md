# 13. App Icon Variants — REMOVED (HS-9011)

> **This feature was removed in HS-9011 (2026-06-24).**
>
> The dynamic app-icon-variants feature (a Settings picker + 9 flame-motif variants applied to the dock/taskbar icon via the Tauri `set_app_icon` command) had its picker UI disabled in commit `fbea797` and its startup-apply feature-flagged off, leaving it fully dormant. On the maintainer's call it was dropped end-to-end: the picker + `bindAppIconPicker`, the `appIcon` file-setting, the `set_app_icon` Tauri command + `apply_saved_icon` / `set_macos_dock_icon` / `apple_squircle_path` Rust code, the variant assets (`src/client/assets/icon-*.png`, `src-tauri/icons/variants/`), and the related capability grants + bundle resources.
>
> The app now always uses its bundled default icon. See git history at the HS-9011 commit for the prior implementation. The doc number is kept as a tombstone to avoid renumbering §14–§95.
