# 50. Installable-Version Upgrade Nudge

HS-7962. A throttled (≤ once per 30 days) overlay dialog shown on app boot to users running the npm-launched server, encouraging them to switch to the installable Tauri build for the embedded terminal + auto-updates + native-OS integration.

> **Status:** Shipped.

## 50.1 Why

The npm-launched flow is the easiest way to try Hot Sheet (`npx hotsheet`) but lacks native-only features the Tauri desktop build ships with. Most prominently the **embedded terminal** ([§22](22-terminal.md)) — the npm web client deliberately hides the terminal feature because PTYs only make sense when Hot Sheet runs on the user's own machine ([§22 HS-6437 Tauri-only feature gating](22-terminal.md)). A user who's only ever launched via npm has no signal that the terminal feature exists at all; this dialog closes that discovery gap.

## 50.2 Scope

**In scope.**
- One-shot overlay on app boot, throttled by a localStorage timestamp (`hotsheet_upgrade_nudge_last_shown`).
- Per-platform CTA button (`Download for macOS` / `Linux` / `Windows`) deep-linking to the latest release's per-platform asset.
- Secondary "View All Releases" link.
- "Don't show again" link that suppresses the nudge forever for that browser.

**Out of scope.**
- **Suppress when running under Tauri.** Always — the user is already on the installable build. Implemented via the existing `getTauriInvoke() !== null` check.
- **In-app upgrade flow.** The dialog is a discoverability nudge, not an installer. Clicking the CTA opens the GitHub Releases page (or asset URL) in an external browser; the user installs by hand.
- **Per-version re-prompting.** A user who dismisses keeps seeing the dialog every 30 days regardless of whether new versions ship — the throttle is purely time-based. A per-version dialog would also work but adds a "is this version newer than the dismissed version" comparison the user didn't ask for.
- **Server-side detection of npm-launched vs Tauri-launched.** Done client-side via `getTauriInvoke()`. The server can't distinguish — it serves the same client to either context.

## 50.3 Detection

**Client mode** — `getTauriInvoke()` returns `null` outside Tauri's WKWebView. When non-null the nudge skips entirely.

**OS platform** — pure helper `detectPlatform(userAgent)` scans `navigator.userAgent` for `Mac` / `Windows` / `Linux` (case-insensitive). Returns `null` for unrecognised user agents (rare-OS browsers, custom embeds), in which case the nudge skips rather than rendering a misleading "Download for {something}" button.

**Throttle gate** — pure helper `shouldShowNudge(lastShownMs, nowMs, intervalMs?)`. True when `lastShownMs === null` (never shown) OR `(nowMs - lastShownMs) >= intervalMs` (default 30 days). Special-cases the `Number.MAX_SAFE_INTEGER` sentinel (Don't-show-again) by always returning false.

## 50.4 Asset resolution

On first show, lazy-fetch `https://api.github.com/repos/brianwestphal/hotsheet/releases/latest` and run `pickPlatformAsset(assets, platform)` to find the best per-platform asset URL. Match patterns:

- **macOS** — `^HotSheet-.*-macOS-Apple-Silicon\.dmg$` first (the post-2020 default), `^HotSheet-.*-macOS-Intel\.dmg$` second.
- **Linux** — `amd64\.AppImage$` first (most distro-portable), `amd64\.deb$` second, `x86_64\.rpm$` third.
- **Windows** — `x64-setup\.exe$` first, `x64_en-US\.msi$` second.

On any failure — rate limit, no internet, asset shape changed — the CTA falls back to `https://github.com/brianwestphal/hotsheet/releases/latest` so the button never dead-ends. The result is cached in module state for the session.

The Apple-Silicon-vs-Intel ambiguity is intentionally resolved by picking Apple Silicon as the default. Users on 2019-or-older Intel Macs reach the Intel build via the "View All Releases" link or the HS-7963 per-platform release-notes section. A more nuanced UA-architecture probe is deferred until users actually report friction.

## 50.5 UI

```
┌─────────────────────────────────────────┐
│ Get the desktop app             [ × ]   │
├─────────────────────────────────────────┤
│                                          │
│ Hot Sheet's installable version adds an  │
│ embedded terminal — see your shell,      │
│ Claude, and any other tool right         │
│ alongside your tickets. Plus auto-       │
│ updates, native-OS integration, and a    │
│ few other features the npm-launched      │
│ server can't provide.                    │
│                                          │
│ ┌─────────────────────────────────────┐  │
│ │  ↓  Download for macOS              │  │
│ └─────────────────────────────────────┘  │
│                                          │
│            View All Releases             │
│                                          │
│           Don't show again               │
└─────────────────────────────────────────┘
```

- 480 px wide (clamped to 92 vw on narrow browsers); auto height.
- z-index 2300 (below the feedback dialog at 2500 and the reader overlay at 2400 so a stuck feedback / reader takes precedence — but those are rare boot-time states).
- Tauri-safe — plain DOM `position: fixed; inset: 0` div mounted on `document.body`. Uses `openExternalUrl` (Tauri-routed via `open_url`, `window.open` fallback) for every external-URL click.

**Dismissal paths.** Each writes to localStorage:
- **X close button** OR **backdrop click** OR **CTA click** OR **View All Releases click** → `Date.now()` (re-prompt in 30 days).
- **Don't show again** link → `Number.MAX_SAFE_INTEGER` (never re-prompt for that browser).

## 50.6 Implementation

- New `src/client/upgradeNudge.tsx` — exports `maybeShowUpgradeNudge()` (the entry-point called once from `app.tsx::init`) + 3 pure helpers (`detectPlatform`, `pickPlatformAsset`, `shouldShowNudge`) + `showUpgradeNudgeDialog(resolved)` (test-friendly direct entry).
- `app.tsx::init` calls `maybeShowUpgradeNudge()` immediately after `bindOpenFolder()` so the dialog appears before any other transient UI.
- SCSS in `styles.scss` — `.upgrade-nudge-overlay`, `.upgrade-nudge-dialog`, `.upgrade-nudge-header`, `.upgrade-nudge-close`, `.upgrade-nudge-body`, `.upgrade-nudge-cta` (full-width filled-bg primary button per the ticket spec), `.upgrade-nudge-secondary` (centered link-style "View All Releases"), `.upgrade-nudge-dismiss` (muted "Don't show again" footer link).
- Tests in `upgradeNudge.test.ts` — 24 unit tests across the 3 pure helpers + the dialog mount/dismiss + localStorage persistence (happy-dom env).

## 50.7 Cross-references

- §1 — overall architecture (the npm vs Tauri distinction).
- §10 — desktop app (the upgrade target).
- §22 HS-6437 — Tauri-only feature gating (the embedded terminal that the dialog promotes).
- HS-7963 — per-platform release-notes section on the GitHub release page; the dialog's "View All Releases" link lands on a page that's now self-explanatory.
