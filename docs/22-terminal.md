# 22. Embedded Terminal

Hot Sheet embeds an interactive terminal inside the footer drawer so the user can run long-lived commands (by default, `claude`) without leaving the app. The terminal is per-project, server-owned, and persistent across UI visibility changes.

## 22.1 Overview

Today the footer drawer contains a single panel (the Commands Log, [14-commands-log.md](14-commands-log.md)). This document extends the drawer to host two tabs — **Commands Log** and **Terminal** — switchable without destroying either. The Terminal tab shows a full-fidelity interactive terminal (xterm, 256-color) connected to a shell process running in the project root.

**Core promises:**

1. One or more terminals per project (see §22.17 for the multi-terminal model).
2. Switching drawer tabs or closing the drawer does **not** kill any terminal — it just hides it.
3. Terminals survive browser reloads and network blips (reattach with replayed scrollback).
4. Multiple browser windows/tabs on the same project share the same terminals (tmux-like).
5. The default command is user-configurable and channel-aware.

## 22.2 Architecture

**Server side (`src/terminals/`):**

- `TerminalSession` keyed by `(projectSecret, terminalId)`. Structure:
  - `pty` — the live `node-pty` process.
  - `scrollback` — ring buffer of raw bytes (default 1 MiB).
  - `subscribers` — set of open WebSocket connections.
  - `cols` / `rows` — current dimensions (consensus = max of any attached client, or last-resized).
  - `startedAt`, `command`, `env`, `terminalId`, `configOverride`.
- `TerminalRegistry` (global within the Node process) holds the map and spawns lazily on first attach.
- PTY is **not** created at server boot. It's created on the first WebSocket attach for a given terminal.
- A single registry is shared across browser tabs and across Tauri windows (they all talk to the same Node server).
- `configOverride` is used by dynamic terminals (§22.17) whose config is not persisted to `settings.json`.

**Client side (`src/client/terminal.tsx`, new):**

- xterm.js instance mounted inside the Terminal tab of the drawer.
- WebSocket connection managed by a module-level singleton per project (reused across tab switches).
- When the tab or drawer is hidden, the DOM element stays mounted (`display: none` is fine — xterm.js survives); the WebSocket stays open.
- When the xterm instance first attaches, server sends current scrollback, then streams real-time.

**Transport:** WebSocket on the Hono server. A new upgrade handler on `/api/terminal/ws?project=<secret>`. Messages are binary frames of raw PTY bytes for output, plus a small text/JSON control channel for resize and lifecycle (`{ type: "resize", cols, rows }`, `{ type: "kill" }`).

## 22.3 Drawer layout (tabs + push-up)

The footer drawer grows a tab strip at the top:

```
┌─────────────────────────────────────────────────────────┐
│  [📜] │ [Terminal]                                  [×] │  ← tab strip
├─────────────────────────────────────────────────────────┤
│                                                         │
│             active tab content                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Only one tab's content is visible at a time. Inactive tab content is hidden via `display: none` — **not unmounted**. The Commands Log keeps its auto-refresh running while hidden; the Terminal keeps its WebSocket and buffer while hidden.

**Push-up layout** (tracked separately in HS-6262): today the drawer is absolutely positioned over the ticket list. This doc depends on that change — a terminal that occludes the ticket list is unusable. The drawer must reflow the main content: the ticket list shrinks to make room, and the drawer, footer status bar, and ticket list stack vertically without overlap. Detail panel docked to bottom stacks *above* the drawer.

**Full-height expand (HS-6312).** At the far right of the drawer tab strip there is an **Expand** button (lucide `arrow-up-from-line`) that collapses the ticket area and lets the drawer claim all remaining vertical space below the header. Clicking it again (the icon flips to `arrow-down-from-line`) restores the default two-pane layout. The state persists per-project under `drawer_expanded` and is reapplied by `applyPerProjectDrawerState` on project switch and on initial load. Closing the drawer clears the expanded flag — there is no "expanded but collapsed" state.

## 22.4 Per-project PTY lifecycle

**Spawn (lazy):** On first WebSocket attach for a project with no existing session, the server spawns a PTY running the configured default command. A trigger-once message is broadcast to attached clients noting the startup.

**Persist:** The PTY continues to run independently of any UI state. Closing the drawer, switching tabs, reloading the browser, quitting the Tauri window (without quitting the sidecar), or disconnecting the WebSocket does **not** kill the PTY.

**Explicit stop / start toggle:** The Terminal tab header has a single power button whose icon reflects the session state:

- **Alive:** button shows a Stop glyph. Clicking once POSTs `/api/terminal/kill` with `SIGHUP`, asking the PTY to shut down cleanly — this is the same signal a terminal emulator sends when the user closes the window, which interactive shells (zsh, bash, fish) respect (HS-6471). The button enters a latched *stop-pending* state; its tooltip changes to "Stop again to force quit".
- **Stop-pending (still alive):** clicking again opens a confirm dialog ("Force quit the process?"). If confirmed, the client POSTs `/api/terminal/kill` with `SIGKILL`. Any state transition away from `alive` clears the latch.
- **Exited or never spawned:** button shows a Start glyph. Clicking POSTs `/api/terminal/restart`, which tears down leftover state, clears scrollback, and spawns a fresh PTY. The client optimistically sets status to `alive`; new output flows into the already-attached WebSocket subscriber.

There is no separate "Restart" button — the stop/start toggle covers explicit process recycling (stop, wait for exit, start).

**Exit:** When the underlying process exits on its own (user types `exit` in the shell), the session enters a terminated state. The tab shows the exit code; the power button flips to Start. A *new* PTY is spawned only when the user clicks Start or explicitly re-runs the default command.

**Kill on:**
- Project unregister (`DELETE /api/projects/:secret`).
- Server shutdown (SIGTERM / SIGINT handler in `cli.ts`, plus `/api/shutdown` endpoint — HS-7528).
- Explicit Stop / Start cycle.

**Do not kill on:**
- Drawer close, tab switch, browser reload, WebSocket disconnect, multi-project focus change.

**Shutdown signal (HS-7528).** Every internal teardown path (`destroyAllTerminals`, `restartTerminal`, `destroyTerminal`) sends `SIGHUP` to the PTY, matching the `POST /api/terminal/kill` default. Interactive shells (zsh / bash / fish) ignore `SIGTERM` but exit cleanly on hang-up per HS-6471 — the earlier hardcoded `SIGTERM` in `teardownPty` left shells running after Hot Sheet shutdown, so the PTYs became orphans when the server process exited. Three server-side entry points all route through the same SIGHUP path:

1. **SIGINT / SIGTERM handler in `cli.ts`:** `setupInstanceLifecycle` synchronously calls `destroyAllTerminals()` before `process.exit(0)`. Runs for Ctrl+C in a dev terminal, `kill <pid>`, and the Tauri sidecar shutdown path (the Tauri `RunEvent::Exit` handler sends `SIGTERM` to the Node sidecar with a 300ms wait for cleanup).
2. **`process.on('exit')` fallback:** same `destroyAllTerminals()` call, synchronous, so any path that lands at `process.exit(N)` without a signal (e.g. crashes, `--close` via the HTTP endpoint below) still kills PTYs before the process dies. Registry module is pre-imported at lifecycle setup time so the synchronous exit hook has an immediate reference.
3. **`POST /api/shutdown`:** the HTTP shutdown endpoint used by `hotsheet --close` and stale-instance auto-cleanup dynamic-imports the registry and fires `destroyAllTerminals()` before its 500ms `setTimeout(process.exit)`.

Three unit tests in `src/terminals/registry.test.ts` guard the signal: `destroyAllTerminals sends SIGHUP to every live PTY`, `restartTerminal sends SIGHUP to the outgoing PTY`, `destroyTerminal sends SIGHUP to the PTY`.

## 22.5 Default command + channel-aware substitution

A per-project setting `terminal_command` (stored in `.hotsheet/settings.json`) holds a template string. Default value:

```
{{claudeCommand}}
```

`{{claudeCommand}}` resolves at PTY spawn time:

- If `channelEnabled === true` (global config, with per-project `channel_enabled` fallback — see [12-claude-channel.md](12-claude-channel.md)) **and** `claude` is found on PATH → `claude --dangerously-load-development-channels server:hotsheet-channel`.
- Else if `claude` is found on PATH → `claude`.
- Else → fall back to the user's default shell (`$SHELL` on Unix, `%COMSPEC%` on Windows).

A user who wants a plain shell (or any other command) overrides `terminal_command` in settings — the value is passed verbatim, no substitution. The setting surface lives in the **Experimental** tab of the Settings dialog initially; graduates to its own section when the feature ships.

Additional per-project settings:
- `terminal_cwd` — working directory. Defaults to the project root (parent of `.hotsheet/`). Same semantics as `/api/shell/exec`.
- `terminal_scrollback_bytes` — ring buffer size. Default 1048576 (1 MiB). Range 64 KiB – 16 MiB.

## 22.6 Client UI (xterm.js)

- Renderer: xterm.js 5.x, canvas addon for performance.
- Font: monospace stack consistent with Commands Log detail view.
- Theme: matches the existing Hot Sheet light/dark theme tokens.
- Add-ons: `@xterm/addon-fit` for resize, `@xterm/addon-web-links` for clickable URLs, `@xterm/addon-serialize` for scrollback replay.
- Resize behavior: on drawer resize or tab show, call `fit.fit()` and send `{ type: "resize" }` to the server.
- Copy/paste: standard terminal conventions (Cmd/Ctrl+C copies when a selection exists; falls back to SIGINT otherwise — xterm.js default).
- **Focus outline (HS-6535).** When keyboard focus is inside the terminal pane (xterm's helper textarea is the active element), `.terminal-body` paints a 2 px inset accent-colored ring via `box-shadow`. The ring is inset (not a border) so it does not change layout or shift the xterm grid. It clears as soon as focus moves elsewhere. This makes it obvious which terminal will receive keystrokes when there are multiple tabs open.
- **Text selection highlight (HS-7330).** The shared `readXtermTheme()` helper emits `selectionBackground` and `selectionInactiveBackground` derived from `--accent` (40% and 20% alpha respectively). Without these, xterm falls back to a near-white translucent default that is invisible on the app's white `--bg` — selection still happens but the user cannot see it. The helper accepts any `#rgb` or `#rrggbb` accent colour and falls back to the default Hot Sheet blue for unsupported colour syntaxes (named colours, `rgb()`, `hsl()`) so a custom `--accent` override never produces an unreadable selection.

**Header row above the xterm instance:**

- Project-scoped label: `claude · <appName>` (or the user's command name).
- Status dot: green (alive), red (exited), gray (not yet spawned).
- Buttons: Stop/Start (power toggle — see §22.4), Clear (clears the visual buffer only; does not kill the PTY).

## 22.7 Scrollback & reattach

The server keeps the last N bytes of PTY output in a ring buffer. On WebSocket attach, the server sends a single `{ type: "history", bytes: <base64> }` frame before any live output — the client calls `term.write(...)` to replay.

This lets the UI detach and reattach freely:
- Opening the drawer after it was closed → replays history.
- Reloading the browser → replays history (not a full persistence — only what's currently in RAM).
- Opening a second browser window on the same project → replays history, then both windows see the same live stream.

**Not preserved:** scrollback across server restarts. An explicit "save terminal session to disk" feature is out of scope (see §22.14).

## 22.8 Multi-tab / multi-window semantics

Opening two browser windows or tabs on the same project attaches **both** to the same PTY. Both see the same live output. Input from either window goes to the same PTY (last-write-wins on a per-keystroke basis; the PTY doesn't care which socket it came from). This matches a tmux-attached session.

**This is a deliberate choice, not a bug.** Rationale: a "private per-window terminal" model requires extra state (window/tab identity, pick-up/drop-off), and the common case for Hot Sheet is a single long-running `claude` session per project. Users who want a second terminal spawn a new shell inside the first (e.g., `tmux new-window`).

## 22.9 Transport

- `GET /api/terminal/ws?project=<secret>` — WebSocket upgrade. Authenticated by the project secret in the query string **and** the `X-Hotsheet-Secret` header on the upgrade request (WebSocket clients pass it via cookies or an auth-token query param, matching the pattern used elsewhere).
- Binary frames = raw PTY output bytes (server → client) or raw keystrokes (client → server).
- Text frames = JSON control messages: `resize`, `history`, `exit`, `kill`, `ping`/`pong`.
- Hono does not ship WebSocket upgrade for `@hono/node-server` out of the box. Implementation uses `ws` attached to the underlying Node HTTP server, gated by the project-secret middleware.

## 22.10 Settings

Keys on `.hotsheet/settings.json`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `terminals` | `TerminalConfig[]` | `[]` (HS-6337 — no implicit default terminal per project) | One row per configured tab (HS-6271). See §22.17 for the schema. |
| `terminal_scrollback_bytes` | number | `1048576` | Ring buffer size (shared across terminals) |
| `drawer_open` | bool (as `"true"`/`"false"`) | `false` | Drawer visibility for this project; restored on project switch (HS-6309). |
| `drawer_active_tab` | string | `"commands-log"` | Active drawer tab id for this project: `"commands-log"` or `"terminal:<id>"`. Restored on project switch (HS-6309). |
| `drawer_expanded` | bool (as `"true"`/`"false"`) | `false` | Full-height drawer toggle state (HS-6312). Restored on project switch; cleared automatically when the drawer closes. |

The previous `terminal_enabled` checkbox (a per-project "show terminal tabs in the drawer" toggle) was removed in HS-6337: the terminal feature is simply on whenever Hot Sheet is running inside Tauri (HS-6437), and empty when no terminals are configured. Legacy settings.json files may still contain `terminal_enabled`; it is ignored on read.

`TerminalConfig` fields:

- `id` (string, required): stable identifier used as the registry key and client tab id. Generated when the row is added; preserved across renames.
- `name` (string, optional): tab label. Defaults to a short form of the command's first word.
- `command` (string): command template (see §22.5). Must be non-empty.
- `cwd` (string, optional): working directory override. Blank = project root.
- `lazy` (bool, default true): if true (current behavior), the PTY is spawned only on first tab activation. If false, the intent is that the server spawns as soon as the project loads. Eager spawning is declared here for forward compatibility; see §22.14 for status.

**Encoding.** `terminals` is stored as a native JSON array on disk. The `/api/file-settings` PATCH route accepts JSON-typed values (`UpdateFileSettingsSchema = z.record(z.string(), z.unknown())`) so the client sends the array directly without `JSON.stringify` (HS-6370). For backward compatibility with pre-fix settings.json files that still hold the array as a stringified value, `listTerminalConfigs()` parses string values defensively before checking `Array.isArray`.

**Legacy migration:** if `terminals` is absent but the older `terminal_command` / `terminal_cwd` keys are present (pre-HS-6271), `listTerminalConfigs()` synthesizes a single-entry list with id `default` carrying those values. The legacy keys are no longer written by the settings UI — the next save serializes to the `terminals` array and the old keys are left alone (they're simply not read). A completely empty project (no `terminals`, no legacy keys) resolves to `[]`, no PTY is ever spawned, and the drawer tab strip has only the `+` add-button (HS-6337).

Settings UI lives on its own **Terminal** tab in the Settings dialog (HS-6337) — moved out of Experimental. The tab button only shows when the client is running inside Tauri (HS-6437).

## 22.11 Tauri / native dependency

`node-pty` is a native addon. It is the **second** native dep in Hot Sheet (PGLite is the first, and is WASM rather than a prebuilt binary — so `node-pty` is the first true native-binary dep).

- Distribution: use `node-pty`'s prebuilt binaries via its `install.js` script. `tsup` treats `node-pty` as an external.
- Tauri sidecar: `scripts/build-sidecar.sh` must copy the compiled `node-pty` binaries (platform-specific `.node` files) into `src-tauri/server/node_modules/node-pty/build/Release/`.
- Test coverage: add a smoke test that spawns a trivial PTY (`/bin/echo hello` or `cmd /c echo hello`) and verifies output roundtrips. Do not gate CI on live-claude tests.
- Windows: `node-pty` uses ConPTY on modern Windows. Acceptable.

**Tauri-only feature gating (HS-6437).** The embedded-terminal feature only makes sense when Hot Sheet is running on the user's own machine — i.e. inside the Tauri desktop app. When the client is accessed via a plain browser (no `window.__TAURI__`), the UI hides both the drawer terminal tab strip (`applyTerminalTabVisibility()` treats non-Tauri as disabled regardless of the saved setting) and the Settings → Embedded Terminal section (`#settings-terminal-section` is toggled in `bindSettingsDialog`). Server-side, `eagerSpawnTerminals()` returns early unless `terminal_enabled` is true so that a web-only deployment never launches PTYs nobody will ever see.

## 22.12 API endpoints

New:

- `GET /api/terminal/status?project=<secret>` — returns `{ alive: bool, startedAt, command, exitCode?, cols, rows, scrollbackBytes }`. Cheap, no-PTY-spawn.
- `POST /api/terminal/restart` — kill the session and start fresh. Body: `{ command? }` (optional override for this invocation).
- `POST /api/terminal/kill` — kill the session without restart. Body: `{ signal? }` (default `SIGHUP`; pass `SIGKILL` to force-quit after a polite stop has stalled, see §22.4).
- `GET /api/terminal/ws?project=<secret>` — WebSocket upgrade (see §22.9).

Existing:

- `/api/shell/exec` (from [15-shell-commands.md](15-shell-commands.md)) is **unchanged**. Shell custom-commands remain one-shot, non-interactive. Interactive use = terminal.
- `/api/channel/status` — unchanged, but the terminal reads it to resolve `{{claudeCommand}}`.

## 22.13 Security

- All terminal endpoints require `X-Hotsheet-Secret` header (same middleware as the rest of the API). The project secret disambiguates which session to use.
- WebSocket upgrade checks the secret before accepting the upgrade. Unauthorized requests return 403 on the upgrade.
- The PTY inherits the environment of the Node server process, minus tool-marker variables that leak from the launching runtime (HS-7527). See §22.14.1 below.
- The shell runs as the same user as the Node server. No privilege escalation.
- The terminal is a straightforward extension of existing capabilities — `/api/shell/exec` already runs arbitrary commands as the logged-in user. Terminal is strictly less surface area, not more.

### 22.13.1 Environment-variable scrubbing (HS-7527)

Before a PTY is spawned, `buildEnv()` in `src/terminals/registry.ts` routes `process.env` through the `scrubParentEnv` helper, which drops tool-marker variables that the launching runtime injected. Without this scrub, those variables leak into every interactive shell Hot Sheet spawns and break unrelated tools that branch on their presence.

**Canonical repro (HS-7527).** Hot Sheet is often run via `tsx` (dev: `npm run dev`; production sidecar: packaged with tsx). tsx exports `TSX_TSCONFIG_PATH=tsconfig.json` so a re-exec'd child Node process reuses the same config. That var inherits into the PTY. When the user then runs e.g. `npm run some-script` inside a Hot Sheet terminal in an unrelated project, the script's own `tsx` invocation reads `TSX_TSCONFIG_PATH` and tries to open a path that only exists in Hot Sheet's working tree — crashing with `Cannot resolve tsconfig at path: …`.

**The scrub list** (every entry is a concrete tool-marker pattern the launching runtime adds to its children's environment, not the user's shell or desktop env):

- **tsx loader:** `TSX_*` (HS-7527 root cause — the TSX_TSCONFIG_PATH variable)
- **npm scripts:** `npm_*` (case-sensitive — `npm_lifecycle_script`, `npm_package_*`, `npm_config_*`, `npm_node_execpath`, `npm_command`, etc.)
- **Node runtime hijacks:** `NODE`, `NODE_OPTIONS`, `NODE_PATH`
- **pnpm / yarn / berry:** `PNPM_*`, `INIT_CWD`, `YARN_*`, `BERRY_*`
- **macOS CoreFoundation:** `__CF*` (the `__CFBundleIdentifier` family that Launch Services injects)
- **Tauri sidecar markers:** `TAURI_*`

Matches are **case-sensitive prefix matches** — `npm_MyCustomVar` (the user's own env var) is not an npm-script marker and passes through. `PATH`, `HOME`, `USER`, `SHELL`, `TERM_PROGRAM`, `LANG`, `LC_ALL`, `PWD`, `TMPDIR`, and every other user/desktop variable are untouched. `HOTSHEET_IN_TERMINAL=1` is still added by `buildEnv` so scripts can detect "running inside the Hot Sheet terminal" intentionally.

`scrubParentEnv` and `shouldStripEnvKey` are exported from `registry.ts` and have 11 unit tests in `registry.test.ts` covering every matcher family, case-sensitivity, undefined-value handling, and non-mutation of the input env.

## 22.14 Out of scope

Deliberately not included in the current iteration:

- **Per-user or per-tab private terminals.** Shared model only — all clients attached to the same project/terminalId see the same stream.
- **Session recording / playback to disk.** In-memory scrollback only.
- **SSH / remote targets.** Local-only.
- **File transfer / drag-drop into the terminal.**
- **Split panes within the drawer.** One visible tab at a time (Commands Log *or* one terminal).
- **Terminal in the Tauri-native terminal API.** Node sidecar owns the PTY; Tauri is just the webview host.

**Now in scope (previously deferred):**

- **Multiple terminals per project.** Delivered in HS-6271 (configurable defaults) and HS-6306 (ad-hoc dynamic terminals). See §22.17.

## 22.15 Implementation notes

(Non-normative — the code may evolve independently.)

- `src/terminals/registry.ts` — `TerminalRegistry` (keyed by `secret::terminalId`) + PTY lifecycle helpers, including `ensureSpawned` used by the eager path.
- `src/terminals/config.ts` — `TerminalConfig` type + `listTerminalConfigs` / `findTerminalConfig` (handles legacy migration).
- `src/terminals/eagerSpawn.ts` — iterates `listTerminalConfigs` and calls `ensureSpawned` for every `lazy:false` entry. Invoked at project registration and on `/file-settings` PATCHes that touch `terminals`.
- `src/terminals/websocket.ts` — `ws` upgrade handler wired into the Node server; parses `?terminal=<id>`.
- `src/routes/terminal.ts` — HTTP endpoints (`list`, `status`, `restart`, `kill`, `create`, `destroy`).
- `src/client/terminal.tsx` — xterm.js mount + WebSocket client + per-tab state, tab lifecycle.
- `src/client/terminalsSettings.tsx` — outline list + edit modal for the configured-defaults list.
- `src/client/commandLog.tsx` — drawer shell; delegates any `terminal:<id>` tab to the terminal module.
- Cleanup: `src/cleanup.ts` gains a `killProjectTerminal(secret)` call on project unregister.
- DB: no schema changes required. Sessions are purely in-memory.

## 22.17 Multiple terminals per project (HS-6271, HS-6306)

**Motivation.** A single terminal per project is sufficient for a solo Claude workflow but falls short for developers who want a separate pane for e.g. `npm run dev`, a REPL, and an interactive shell alongside Claude. The drawer is a natural place to host these without stealing real estate from the ticket list.

### 22.17.1 Model

- **Configured default terminals**: user-editable list stored in `.hotsheet/settings.json` under `terminals` (see §22.10). Each entry has a stable `id`, a tab name, a command template, an optional cwd override, and a per-terminal lazy flag. The list is rendered as an outline in Settings → Experimental → Embedded Terminal (one row per terminal, drag to reorder, edit-modal for the fields). Drag order in the list = left-to-right order in the drawer tab strip.
- **Dynamic terminals**: ad-hoc terminals created at runtime via the drawer's **+** button. They are never written to `settings.json`. Their `TerminalConfig` lives in an in-memory map on the server (`dynamicConfigs`) keyed by `(secret, terminalId)`, and their PTY state lives in the same `TerminalRegistry` as configured terminals.

### 22.17.2 Drawer tab strip

Layout (left to right):

1. **Commands Log** — pinned, not closable. Rendered as an icon-only button (HS-6474) with a `title` / `aria-label` of "Commands Log" so the tab stays recognizable without consuming horizontal space. The icon is a clipboard-list lucide glyph.
2. A **thin vertical divider** (HS-6475) separating the Commands Log button from the terminal tabs. Same color as the drawer tab strip bottom border; hidden alongside the terminal tabs wrap when the desktop-only gate is off.
3. One tab per configured default terminal, in settings order. Not closable from the drawer (remove them from Settings).
4. One tab per dynamic terminal, in creation order. Each has an inline **×** close button.
5. A **+** button that creates a new dynamic terminal (see §22.17.3). The button sits immediately after the last tab and scrolls horizontally with the tab strip when the list overflows (HS-6340).

The group `(3, 4, 5)` lives inside a horizontally scrollable wrapper so the tab strip never overflows the drawer width. The scrollbar is thin and auto-hides when not needed.

The divider and the scrollable wrapper are both hidden on web (non-desktop) sessions; Commands Log remains visible.

### 22.17.3 Creating dynamic terminals

Click **+** → `POST /api/terminal/create` with an empty body. The server:

1. Generates a unique `dyn-<tsBase36>-<rand>` terminal id.
2. Allocates a `TerminalConfig` with the user's default shell as the command (resolved at spawn time via `$SHELL` / `%COMSPEC%`) and a friendly `name` (capitalized basename of the command, e.g. `Zsh`) so the drawer tab has a visible label even before any output arrives.
3. Stores the config in the `dynamicConfigs` map and returns it.

The client then refreshes its tab list (`/api/terminal/list`) and selects the new tab. `/list` enumerates `dynamicConfigs` directly (not the registry) so freshly-created terminals appear in the response before any WebSocket attach (HS-6341). Attach then happens on the normal WebSocket flow — the registry spawns the PTY lazily on first connect.

### 22.17.4 Closing dynamic terminals

Click the tab's **×** → `POST /api/terminal/destroy` with the terminal id. The server:

1. Calls `destroyTerminal(secret, terminalId)` — tears down the PTY if alive, removes the session from the registry.
2. Removes the entry from `dynamicConfigs`.

The client removes the tab button and pane from the DOM. If the drawer was showing the closed terminal, the drawer falls back to the **nearest remaining terminal tab** (HS-7275): starting from the position of the first closed tab in the pre-close left-to-right order, walk rightward looking for a surviving terminal tab; if none is found, walk leftward; if no terminal tab survives the close, fall back to **Commands Log**. The "first closed tab" anchor matters only for bulk flows (below) — for a single close there is only one. The fallback is skipped entirely when the drawer was already showing a different tab (e.g., Commands Log or a surviving terminal) so the user is not yanked away from what they were viewing. Selection is computed by the pure helper `pickNearestTerminalTabId(orderBeforeClose, closedIds)` in `src/client/terminalTabSelection.ts`, with unit coverage in the sibling `.test.ts`.

**Confirm-before-kill (HS-6701).** To match the Settings → Embedded Terminal delete flow (§22.17.4 above):

- If the clicked tab's `TerminalInstance.status` is `alive` (the PTY has a live process), the client first calls `previewDrawerTab` to reveal the tab in the drawer, then shows an in-app confirm overlay: *"Close terminal "NAME"? Its running process will be stopped."* with a danger-styled **Close** button. Destroy only runs on confirm; on cancel, the drawer returns to whatever tab was active before.
- If the status is `exited` or `not-connected`, there is no process to interrupt — the tab closes silently without a dialog.

**Bulk close (Close Other Tabs / Close Tabs to the Left / Close Tabs to the Right).** Same protection applied across the selection:

- 0 alive in the selection → destroy all silently.
- Exactly 1 alive → fall through to the single-tab confirm flow for that one tab; on confirm, the inert tabs in the selection are also destroyed; on cancel, the whole bulk operation aborts (no tab is destroyed, even the inert ones).
- 2+ alive → single **"Stop all running terminals?"** dialog listing the running tab names by bullet; confirming stops and destroys every tab in the selection, canceling aborts the whole bulk operation.

**Configured defaults cannot be closed from the drawer.** To remove one, edit the terminals list in Settings and click its trash icon. The delete flow (HS-6403):

1. Temporarily hides the Settings dialog and opens the drawer to the target terminal so the user can see what they're about to remove.
2. Shows an in-app confirm overlay (not `window.confirm`, which is a silent no-op in Tauri's WKWebView).
3. On confirm: `POST /api/terminal/destroy` tears down the PTY, the row is removed from the terminals array, and a debounced PATCH persists the new list. `loadAndRenderTerminalTabs()` then removes the tab from the drawer.
4. On cancel (or after confirm): the drawer returns to whatever state it was in before, and the Settings dialog reappears.

**Tab context menu (HS-6470).** Right-clicking any terminal tab opens a lightweight menu with:

- **Close Tab** — destroys the clicked terminal. Disabled when the clicked tab is a configured default.
- **Close Other Tabs** — destroys every dynamic tab except the clicked one. Configured defaults are never closed.
- **Close Tabs to the Left** — destroys dynamic tabs positioned before the clicked one (left-to-right in the tab strip order). Configured defaults are skipped.
- **Close Tabs to the Right** — destroys dynamic tabs positioned after the clicked one. Configured defaults are skipped.
- *(separator)*
- **Rename...** (HS-6668) — opens an in-app dialog pre-populated with the current tab label. Submitting updates the drawer-tab label immediately. The rename is **transient**: it updates the in-memory `TerminalTabConfig.name` on the client instance only, never persists to `settings.json`, and resets on page reload or project-tab switch. Clearing the input and submitting restores the default derivation (configured `name`, or the capitalized shell basename for dynamic tabs). Available for both configured defaults and dynamic tabs; the configured-default "stored setting value" is deliberately untouched so the user's saved terminal name remains the source of truth across sessions. Dialog closes via Enter, the Rename button, Escape, the Cancel button, or clicking the overlay backdrop. The in-pane header label still prefers any runtime OSC 0/2 title pushed by the process ([§23](23-terminal-titles-and-bell.md)); the rename only replaces the config-derived fallback.

The four close entries appear on every tab (including configured defaults) so the menu shape stays predictable; configured defaults simply disable "Close Tab" and are exempt from the bulk-close paths.

### 22.17.5 Registry key format

`TerminalRegistry` keys sessions by the string `${secret}::${terminalId}`. Helper functions:

- `listProjectTerminalIds(secret)` — returns `terminalId`s currently known for a project (used by `/api/terminal/list` to detect dynamic terminals).
- `destroyProjectTerminals(secret)` — mass cleanup on project unregister.

All existing public functions (`attach`, `detach`, `killTerminal`, `restartTerminal`, `writeInput`, `resizeTerminal`, `getTerminalStatus`, `destroyTerminal`) accept an optional trailing `terminalId` parameter defaulting to `'default'`. This preserves the earlier single-terminal API signatures.

### 22.17.6 Websocket addressing

The upgrade URL is `GET /api/terminal/ws?project=<secret>&terminal=<terminalId>`. `terminal` defaults to `default` if omitted. `authenticate()` parses both; `handleConnection()` passes `terminalId` through every registry call on that socket (attach, detach, writeInput, resize).

### 22.17.7 Per-project drawer state (HS-6309)

The drawer's open/closed state and its active tab id are **project-scoped**. They live in `.hotsheet/settings.json` under `drawer_open` and `drawer_active_tab` (see §22.10) and are applied on project switch so each project returns to whatever the user last had in view.

On project switch, the client:

1. Calls `onProjectSwitch()` on the terminal module, tearing down every `TerminalInstance` (xterm + ws) from the old project. The server-side PTYs are untouched — they persist until explicit kill or server shutdown.
2. Fetches `/api/terminal/list` for the new project and rebuilds the tab strip.
3. Reads `drawer_open` and `drawer_active_tab` from the new project's settings, then opens/closes the drawer and activates the saved tab. If the saved tab is a `terminal:<id>` that no longer exists server-side, it falls back to `commands-log`.

Saves happen on `openPanel` / `closePanel` / `switchDrawerTab`. A `suspendSave` latch prevents the restore path from writing back to settings (otherwise the act of restoring would fire a redundant PATCH).

### 22.17.8 Lazy flag (per-terminal) — eager-spawn (HS-6310)

`TerminalConfig.lazy` is persisted in settings. Terminals with `lazy:true` (the default) spawn only on first WebSocket attach. Terminals with `lazy:false` spawn **eagerly**:

- **On project boot** — `registerExistingProject` (primary project) and `restorePreviousProjects` (additional projects) both call `eagerSpawnTerminals(secret, dataDir)`, which iterates `listTerminalConfigs` and spawns any entry whose `lazy` field is explicitly `false`.
- **On settings save** — `PATCH /api/file-settings` recognizes a `terminals` body and re-runs `eagerSpawnTerminals`. Terminals that were just flipped from lazy to eager launch immediately without a page reload.

The eager path uses a new `registry.ensureSpawned(secret, dataDir, terminalId, configOverride?)` which spawns a PTY without requiring a subscriber. Scrollback fills in the ring buffer from the moment the PTY starts; the first client WebSocket that attaches receives a `history` frame with the accumulated output and then streams live. If an eager terminal's process exits before any client attaches, the session stays in `exited` state and `ensureSpawned` does not resurrect it — a user action (Start button, or a fresh project boot) is required.

`eagerSpawnTerminals` is best-effort: a failing spawn (missing `node-pty`, bad shell, etc.) is logged to `stderr` and does not block the rest of startup.

**First-attach cleanup (HS-6799).** Eager-spawned PTYs run at `DEFAULT_COLS=80` × `DEFAULT_ROWS=24` until the first client attaches, so their startup output (shell welcome banner, zsh `PROMPT_SP` EOL mark, Apple Terminal's `Restored session: …`, the prompt) is laid out for an 80×24 buffer. Replaying those bytes into a client pane of a different width produces stray characters at the top — cursor-positioning escapes, charset shifts, and wrapped lines don't cleanly reflow into the wider buffer.

To avoid that, the client includes its post-fit xterm dims on the WebSocket URL (`?cols=N&rows=M`), and the server's `attach()` detects the first real subscriber on an eager-spawned session. In that case it: (1) resizes the PTY to the client's real dims, (2) clears the scrollback ring buffer, (3) writes `\x0c` (Ctrl-L / Form Feed) to the PTY so the shell's `clear-screen` widget redraws its prompt at the correct geometry. The client then receives an empty `history` frame followed by live bytes generated *at* its actual pane size. Subsequent attaches (browser refresh, second window) replay the existing scrollback normally — the cleanup only fires on the very first attach to a given session.

On the client side, `activateTerminal()` runs `doFit()` *before* `connect()` so the URL query reflects the real pane geometry rather than xterm's default 80×24.

**xterm stylesheet in the production bundle (HS-6799).** The stray-glyph symptom ("weird characters at the top of the pane", plus a visible resizable `<textarea>` drawn *inside* the terminal body) also appeared in Tauri production builds even after the first-attach cleanup above. Root cause was a build-pipeline gap: `npm run build:client` (the dev path) appended `node_modules/@xterm/xterm/css/xterm.css` to `dist/client/styles.css`, but `npm run build` (what `scripts/build-sidecar.sh` runs to populate `src-tauri/server/client/`) did not. Without xterm's stylesheet, `.xterm-helper-textarea` — the hidden IME/a11y surface — loses its `opacity: 0` / `left: -9999em` hiding rules and renders as a plain resizable textarea; `.xterm-viewport` and `.xterm-screen` lose their absolute positioning, and xterm's canvas row layers misalign. The fix extends the client bundle's `onSuccess` hook in `tsup.config.ts` to append xterm.css to the compiled `styles.css`, matching what `build:client` does. `src/build-assets.test.ts` guards both code paths (tsup config + `build:client` script) against regression and verifies the source xterm.css still carries the hide/position rules.

### 22.17.9 Auto-fit on drawer resize (HS-6502)

The active terminal's xterm grid must track the drawer pane's size in real time. Fits triggered by a window-level `resize` event alone are insufficient: the drawer can change height via (a) the user dragging the resize handle at the top of `#command-log-panel` (see `initResize()` in `src/client/commandLog.tsx`), or (b) toggling the full-height expand button (`toggleDrawerExpanded()`), neither of which fires a window resize.

`initTerminal()` attaches a `ResizeObserver` to `#command-log-panel`. On every observed size change, the active terminal's `FitAddon.fit()` runs (via the same `doFit(inst)` helper as the window-resize path). The guard `isTerminalTabActive(active)` keeps fits from running against hidden panes where `getBoundingClientRect()` would return zero and confuse xterm. The FitAddon's computed `{cols, rows}` is then forwarded to the server PTY via the existing `term.onResize → ws.send({type:'resize',…})` pipeline, so the shell knows about the new window size without any additional code.

## 22.18 Terminal-focused keyboard shortcuts (HS-6472)

When a terminal pane owns keyboard focus (xterm's helper textarea, or any descendant of `.drawer-terminal-pane` / `.xterm`), the global tab-navigation shortcut is rerouted so that users working inside a terminal can still cycle through tabs without leaving the keyboard:

| Shortcut (macOS) | Shortcut (Windows/Linux) | Action |
| --- | --- | --- |
| `Cmd+Shift+Left/Right` | `Ctrl+Shift+Left/Right` | Previous / next terminal tab in the drawer tab strip. Wraps at either end. No-op if fewer than two terminal tabs exist. |
| `Cmd+Shift+Opt+Left/Right` | `Ctrl+Shift+Alt+Left/Right` | Previous / next project tab (escapes the terminal scope). Always routes to project tabs regardless of focus. |
| `Cmd+Shift+[` / `Cmd+Shift+]` | `Ctrl+Shift+[` / `Ctrl+Shift+]` | Unchanged — always project tabs. These bracket shortcuts work even from within a terminal because their chord is distinct. |
| `Cmd+K` (macOS only) | `Ctrl+K` (Linux/Windows only) | Clear the terminal (HS-7329 / HS-7459). Delegates to xterm's `term.clear()` which keeps the current prompt row and drops everything above it — both the visible viewport and the scrollback. Matches Terminal.app / iTerm2 / VS Code convention. **Platform-specific match is critical**: on macOS we only match Cmd+K, so `Ctrl+K` in a shell still reaches readline's `kill-line`. On Linux/Windows we only match Ctrl+K, since there is no Cmd key there. Intercepted unconditionally on the matching platform including when a TUI like `vim` is running; users who want readline's `Ctrl+K` on Linux/Windows can hold Shift or Alt and the event passes through. |
| `Cmd+F` (macOS only) | `Ctrl+F` (Linux/Windows only) | Open the terminal find widget (HS-7331 / HS-7460). The platform-specific match means `Ctrl+F` on macOS still reaches readline's `forward-char` in the shell, and `Cmd+F` on Linux/Windows passes through (no convention there). Outside a terminal the global `Cmd/Ctrl+F` continues to focus the ticket-search input — no platform conflict there. See [34-terminal-search.md](34-terminal-search.md) for the widget itself. |
| `Cmd+Up` / `Cmd+Down` (macOS only) | `Ctrl+Up` / `Ctrl+Down` (Linux/Windows only) | Jump the xterm viewport to the previous / next OSC 133 prompt marker (HS-7269 / HS-7460). Requires shell integration to be enabled both server-side (the marks are present) and client-side (Settings → Terminal → "Enable shell integration UI"). The platform-specific match preserves macOS `Ctrl+Up/Down` for tmux pane resize, vim/nvim, fish-shell history-token-search, and any other shell-side binding that uses those chords. See [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md). |

**HS-7329 / HS-7459 / HS-7460 — platform-specific xterm shortcuts.** The match logic for every cross-xterm shortcut lives in `src/client/terminalKeybindings.ts` as small pure helpers (`isClearTerminalShortcut`, `isFindShortcut`, `isJumpShortcut`) shared by every xterm the app mounts — drawer terminal, dashboard tile xterm, dashboard dedicated-view xterm. Each instance's `term.attachCustomKeyEventHandler` calls the helpers in order and, on match, runs the action and returns `false` to suppress xterm's own handling. All three helpers are platform-aware: each takes an optional `isMac` boolean which defaults to `navigator.userAgent.includes('Mac')`. On macOS only the Cmd-prefixed variants match; on Linux/Windows only the Ctrl-prefixed variants match. The shared private helper `hasPlatformPrimaryModifier` rejects the wrong-platform modifier, both modifiers held simultaneously, and any Alt/Shift held — so `Cmd+Shift+Up` (selection extend) and `Ctrl+Shift+K` (kill-line variant) still pass through to xterm's defaults. The same `isFindShortcut` helper also gates the global `Cmd/Ctrl+F` listener in `src/client/shortcuts.tsx`: when a terminal has focus, only the platform-correct find shortcut hijacks the event; the wrong-platform variant returns early without `preventDefault` so xterm's already-completed forward to the shell stands. 40 unit tests (`terminalKeybindings.test.ts`) cover all three helpers across macOS / non-macOS branches, both-modifiers-held rejection, case-insensitivity on the letter helpers, Alt/Shift passthrough, other-key rejection, non-keydown rejection, and the runtime platform-detection default.

When focus is **outside** a terminal, `Cmd+Shift+Left/Right` continues to switch project tabs as defined in [4-user-interface.md §4.2](4-user-interface.md), and `Cmd+Shift+Opt+Left/Right` is equivalent to `Cmd+Shift+Left/Right` (still project-tab navigation — the Alt modifier is a no-op outside terminals).

**Detection.** `isTerminalFocused()` walks `document.activeElement` up to the nearest `.drawer-terminal-pane` or `.xterm` ancestor. This catches both the xterm helper textarea (`.xterm-helper-textarea`) and any custom element a future terminal pane might render. The check is cheap and runs on every keydown.

**Tab selection.** `switchTerminalTabByOffset()` queries `.drawer-terminal-tab` elements in DOM order, finds the one with `.active`, and delegates to `switchDrawerTab(dataDrawerTab)` from `src/client/commandLog.tsx` — same code path as clicking a tab. Selecting a new terminal tab re-focuses that terminal's xterm instance via `activateTerminal` → `term.focus()`, so subsequent presses keep cycling without requiring a re-click.

## 22.19 Cross-references

- [4-user-interface.md](4-user-interface.md) — drawer now has tabs; push-up layout affects ticket list region.
- [8-cli-server.md](8-cli-server.md) — startup/shutdown lifecycle must kill live PTYs on SIGTERM.
- [12-claude-channel.md](12-claude-channel.md) — `channelEnabled` gates the `{{claudeCommand}}` substitution.
- [14-commands-log.md](14-commands-log.md) — the other tab in the same drawer.
- [15-shell-commands.md](15-shell-commands.md) — one-shot shell remains separate; interactive use = terminal.
- **Tickets:** HS-6261 (this doc), HS-6262 (drawer push-up layout prerequisite), HS-6472 (terminal-focused keyboard shortcuts), HS-7329 (Cmd/Ctrl+K clear), HS-7330 (selection highlight colour), HS-7459 (platform-specific Cmd+K only on macOS / Ctrl+K only on Linux/Windows — forwards Ctrl+K on macOS to readline kill-line), HS-7460 (extends the same platform-specific match to `isFindShortcut` for `Cmd/Ctrl+F` and `isJumpShortcut` for `Cmd/Ctrl+Up/Down`, and aligns the global `shortcuts.tsx` Cmd/Ctrl+F handler so terminal-focused wrong-platform variants pass through to the shell).
