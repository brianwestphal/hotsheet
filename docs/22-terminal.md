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
│  [Commands Log]  [Terminal]                         [×] │  ← tab strip
├─────────────────────────────────────────────────────────┤
│                                                         │
│             active tab content                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Only one tab's content is visible at a time. Inactive tab content is hidden via `display: none` — **not unmounted**. The Commands Log keeps its auto-refresh running while hidden; the Terminal keeps its WebSocket and buffer while hidden.

**Push-up layout** (tracked separately in HS-6262): today the drawer is absolutely positioned over the ticket list. This doc depends on that change — a terminal that occludes the ticket list is unusable. The drawer must reflow the main content: the ticket list shrinks to make room, and the drawer, footer status bar, and ticket list stack vertically without overlap. Detail panel docked to bottom stacks *above* the drawer.

## 22.4 Per-project PTY lifecycle

**Spawn (lazy):** On first WebSocket attach for a project with no existing session, the server spawns a PTY running the configured default command. A trigger-once message is broadcast to attached clients noting the startup.

**Persist:** The PTY continues to run independently of any UI state. Closing the drawer, switching tabs, reloading the browser, quitting the Tauri window (without quitting the sidecar), or disconnecting the WebSocket does **not** kill the PTY.

**Explicit stop / start toggle:** The Terminal tab header has a single power button whose icon reflects the session state:

- **Alive:** button shows a Stop glyph. Clicking once POSTs `/api/terminal/kill` with `SIGTERM`, asking the PTY to shut down cleanly. The button enters a latched *stop-pending* state; its tooltip changes to "Stop again to force quit".
- **Stop-pending (still alive):** clicking again opens a confirm dialog ("Force quit the process?"). If confirmed, the client POSTs `/api/terminal/kill` with `SIGKILL`. Any state transition away from `alive` clears the latch.
- **Exited or never spawned:** button shows a Start glyph. Clicking POSTs `/api/terminal/restart`, which tears down leftover state, clears scrollback, and spawns a fresh PTY. The client optimistically sets status to `alive`; new output flows into the already-attached WebSocket subscriber.

There is no separate "Restart" button — the stop/start toggle covers explicit process recycling (stop, wait for exit, start).

**Exit:** When the underlying process exits on its own (user types `exit` in the shell), the session enters a terminated state. The tab shows the exit code; the power button flips to Start. A *new* PTY is spawned only when the user clicks Start or explicitly re-runs the default command.

**Kill on:**
- Project unregister (`DELETE /api/projects/:secret`).
- Server shutdown (SIGTERM handler).
- Explicit Stop / Start cycle.

**Do not kill on:**
- Drawer close, tab switch, browser reload, WebSocket disconnect, multi-project focus change.

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
| `terminal_enabled` | bool | `false` | Feature-flagged during development. When `false`, no Terminal tabs appear. |
| `terminals` | `TerminalConfig[]` | single-entry `[{ id: 'default', name: 'Terminal', command: '{{claudeCommand}}' }]` | One row per configured tab (HS-6271). See §22.17 for the schema. |
| `terminal_scrollback_bytes` | number | `1048576` | Ring buffer size (shared across terminals) |

`TerminalConfig` fields:

- `id` (string, required): stable identifier used as the registry key and client tab id. Generated when the row is added; preserved across renames.
- `name` (string, optional): tab label. Defaults to a short form of the command's first word.
- `command` (string): command template (see §22.5). Must be non-empty.
- `cwd` (string, optional): working directory override. Blank = project root.
- `lazy` (bool, default true): if true (current behavior), the PTY is spawned only on first tab activation. If false, the intent is that the server spawns as soon as the project loads. Eager spawning is declared here for forward compatibility; see §22.14 for status.

**Legacy migration:** if `terminals` is absent but the older `terminal_command` / `terminal_cwd` keys are present (pre-HS-6271), `listTerminalConfigs()` synthesizes a single-entry list with id `default` carrying those values. The legacy keys are no longer written by the settings UI — the next save serializes to the `terminals` array and the old keys are left alone (they're simply not read).

Settings UI lives initially in the Experimental tab ([4-user-interface.md](4-user-interface.md)). `terminal_enabled` graduates out of Experimental once the feature is stable.

## 22.11 Tauri / native dependency

`node-pty` is a native addon. It is the **second** native dep in Hot Sheet (PGLite is the first, and is WASM rather than a prebuilt binary — so `node-pty` is the first true native-binary dep).

- Distribution: use `node-pty`'s prebuilt binaries via its `install.js` script. `tsup` treats `node-pty` as an external.
- Tauri sidecar: `scripts/build-sidecar.sh` must copy the compiled `node-pty` binaries (platform-specific `.node` files) into `src-tauri/server/node_modules/node-pty/build/Release/`.
- Test coverage: add a smoke test that spawns a trivial PTY (`/bin/echo hello` or `cmd /c echo hello`) and verifies output roundtrips. Do not gate CI on live-claude tests.
- Windows: `node-pty` uses ConPTY on modern Windows. Acceptable.

## 22.12 API endpoints

New:

- `GET /api/terminal/status?project=<secret>` — returns `{ alive: bool, startedAt, command, exitCode?, cols, rows, scrollbackBytes }`. Cheap, no-PTY-spawn.
- `POST /api/terminal/restart` — kill the session and start fresh. Body: `{ command? }` (optional override for this invocation).
- `POST /api/terminal/kill` — kill the session without restart. Body: `{ signal? }` (default `SIGTERM`; pass `SIGKILL` to force-quit after a polite stop has stalled, see §22.4).
- `GET /api/terminal/ws?project=<secret>` — WebSocket upgrade (see §22.9).

Existing:

- `/api/shell/exec` (from [15-shell-commands.md](15-shell-commands.md)) is **unchanged**. Shell custom-commands remain one-shot, non-interactive. Interactive use = terminal.
- `/api/channel/status` — unchanged, but the terminal reads it to resolve `{{claudeCommand}}`.

## 22.13 Security

- All terminal endpoints require `X-Hotsheet-Secret` header (same middleware as the rest of the API). The project secret disambiguates which session to use.
- WebSocket upgrade checks the secret before accepting the upgrade. Unauthorized requests return 403 on the upgrade.
- The PTY inherits the environment of the Node server process, minus any keys the user marks private in settings (future). For now: full environment inherits.
- The shell runs as the same user as the Node server. No privilege escalation.
- The terminal is a straightforward extension of existing capabilities — `/api/shell/exec` already runs arbitrary commands as the logged-in user. Terminal is strictly less surface area, not more.

## 22.14 Out of scope

Deliberately not included in the current iteration:

- **Per-user or per-tab private terminals.** Shared model only — all clients attached to the same project/terminalId see the same stream.
- **Session recording / playback to disk.** In-memory scrollback only.
- **SSH / remote targets.** Local-only.
- **File transfer / drag-drop into the terminal.**
- **Split panes within the drawer.** One visible tab at a time (Commands Log *or* one terminal).
- **Eager-spawn for terminals with `lazy:false`.** The setting is persisted but currently behaves the same as `lazy:true` (spawn on first attach). Upgrading this is tracked as a follow-up; it will require calling `attach` at project-boot for every eager terminal, plus reconnecting subscribers.
- **Terminal in the Tauri-native terminal API.** Node sidecar owns the PTY; Tauri is just the webview host.

**Now in scope (previously deferred):**

- **Multiple terminals per project.** Delivered in HS-6271 (configurable defaults) and HS-6306 (ad-hoc dynamic terminals). See §22.17.

## 22.15 Implementation notes

(Non-normative — the code may evolve independently.)

- `src/terminals/registry.ts` — `TerminalRegistry` (keyed by `secret::terminalId`) + PTY lifecycle helpers.
- `src/terminals/config.ts` — `TerminalConfig` type + `listTerminalConfigs` / `findTerminalConfig` (handles legacy migration).
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

1. `Commands Log` — pinned, not closable.
2. One tab per configured default terminal, in settings order. Not closable from the drawer (remove them from Settings).
3. One tab per dynamic terminal, in creation order. Each has an inline **×** close button.
4. A **+** button that creates a new dynamic terminal (see §22.17.3).

The group `(2, 3, 4)` lives inside a horizontally scrollable wrapper so the tab strip never overflows the drawer width. The scrollbar is thin and auto-hides when not needed.

Only the configured + dynamic area is hidden when `terminal_enabled:false`; Commands Log remains visible.

### 22.17.3 Creating dynamic terminals

Click **+** → `POST /api/terminal/create` with an empty body. The server:

1. Generates a unique `dyn-<tsBase36>-<rand>` terminal id.
2. Allocates a `TerminalConfig` with the user's default shell as the command (resolved at spawn time via `$SHELL` / `%COMSPEC%`).
3. Stores the config in the `dynamicConfigs` map and returns it.

The client then refreshes its tab list (`/api/terminal/list`) and selects the new tab. Attach happens on the normal WebSocket flow — the registry spawns the PTY lazily on first connect.

### 22.17.4 Closing dynamic terminals

Click the tab's **×** → `POST /api/terminal/destroy` with the terminal id. The server:

1. Calls `destroyTerminal(secret, terminalId)` — tears down the PTY if alive, removes the session from the registry.
2. Removes the entry from `dynamicConfigs`.

The client removes the tab button and pane from the DOM. If the closed terminal was the active tab, the drawer falls back to Commands Log.

**Configured defaults cannot be closed from the drawer.** To remove one, edit the terminals list in Settings. When a configured default is removed in Settings, `loadAndRenderTerminalTabs()` detects the missing id and tears down the corresponding tab on its next refresh.

### 22.17.5 Registry key format

`TerminalRegistry` keys sessions by the string `${secret}::${terminalId}`. Helper functions:

- `listProjectTerminalIds(secret)` — returns `terminalId`s currently known for a project (used by `/api/terminal/list` to detect dynamic terminals).
- `destroyProjectTerminals(secret)` — mass cleanup on project unregister.

All existing public functions (`attach`, `detach`, `killTerminal`, `restartTerminal`, `writeInput`, `resizeTerminal`, `getTerminalStatus`, `destroyTerminal`) accept an optional trailing `terminalId` parameter defaulting to `'default'`. This preserves the earlier single-terminal API signatures.

### 22.17.6 Websocket addressing

The upgrade URL is `GET /api/terminal/ws?project=<secret>&terminal=<terminalId>`. `terminal` defaults to `default` if omitted. `authenticate()` parses both; `handleConnection()` passes `terminalId` through every registry call on that socket (attach, detach, writeInput, resize).

### 22.17.7 Lazy flag (per-terminal)

`TerminalConfig.lazy` is persisted in settings. Currently the registry is always lazy (PTY spawns on first `attach`). When the eager path ships, the server will call `attach` for every non-lazy configured terminal as part of project load — likely through an internal stub subscriber that just drains output to scrollback until a real WebSocket takes over. Until then, the setting is declared but behavior is identical regardless of its value.

## 22.18 Cross-references

- [4-user-interface.md](4-user-interface.md) — drawer now has tabs; push-up layout affects ticket list region.
- [8-cli-server.md](8-cli-server.md) — startup/shutdown lifecycle must kill live PTYs on SIGTERM.
- [12-claude-channel.md](12-claude-channel.md) — `channelEnabled` gates the `{{claudeCommand}}` substitution.
- [14-commands-log.md](14-commands-log.md) — the other tab in the same drawer.
- [15-shell-commands.md](15-shell-commands.md) — one-shot shell remains separate; interactive use = terminal.
- **Tickets:** HS-6261 (this doc), HS-6262 (drawer push-up layout prerequisite).
