# 22. Embedded Terminal

Hot Sheet embeds an interactive terminal inside the footer drawer so the user can run long-lived commands (by default, `claude`) without leaving the app. The terminal is per-project, server-owned, and persistent across UI visibility changes.

## 22.1 Overview

Today the footer drawer contains a single panel (the Commands Log, [14-commands-log.md](14-commands-log.md)). This document extends the drawer to host two tabs — **Commands Log** and **Terminal** — switchable without destroying either. The Terminal tab shows a full-fidelity interactive terminal (xterm, 256-color) connected to a shell process running in the project root.

**Core promises:**

1. One terminal per project. Switching projects switches terminals (or creates one lazily).
2. Switching drawer tabs or closing the drawer does **not** kill the terminal — it just hides it.
3. The terminal survives browser reloads and network blips (reattach with replayed scrollback).
4. Multiple browser windows/tabs on the same project share the same terminal (tmux-like).
5. The default command is user-configurable and channel-aware.

## 22.2 Architecture

**Server side (`src/terminals/`, new):**

- Per-project `TerminalSession` keyed by project secret. Structure:
  - `pty` — the live `node-pty` process.
  - `scrollback` — ring buffer of raw bytes (default 1 MiB).
  - `subscribers` — set of open WebSocket connections.
  - `cols` / `rows` — current dimensions (consensus = max of any attached client, or last-resized).
  - `startedAt`, `command`, `env`.
- `TerminalRegistry` (global within the Node process) holds the map and spawns lazily on first attach.
- PTY is **not** created at server boot. It's created on the first WebSocket attach for a given project.
- A single registry is shared across browser tabs and across Tauri windows (they all talk to the same Node server).

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

**Explicit restart:** A "Restart terminal" button in the Terminal tab header sends a control message that kills the PTY and spawns a fresh one. Scrollback is cleared.

**Exit:** When the underlying process exits on its own (user types `exit` in the shell), the session enters a terminated state. The tab shows the exit code and a "Start again" button. A *new* PTY is spawned only when the user clicks the button or explicitly re-runs the default command.

**Kill on:**
- Project unregister (`DELETE /api/projects/:secret`).
- Server shutdown (SIGTERM handler).
- Explicit "Restart terminal".

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
- Buttons: Restart, Clear (clears the visual buffer only; does not kill the PTY).

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
| `terminal_enabled` | bool | `false` | Feature-flagged during development. When `false`, no Terminal tab appears. |
| `terminal_command` | string | `"{{claudeCommand}}"` | Template; see §22.5 |
| `terminal_cwd` | string | project root | Absolute path |
| `terminal_scrollback_bytes` | number | `1048576` | Ring buffer size |

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
- `POST /api/terminal/kill` — kill the session without restart.
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

Deliberately not included in the v1 of this feature:

- **Multiple concurrent terminals per project.** One per project only. Users can `tmux` inside it if they want.
- **Per-user or per-tab private terminals.** Shared model only.
- **Session recording / playback to disk.** In-memory scrollback only.
- **SSH / remote targets.** Local-only.
- **File transfer / drag-drop into the terminal.**
- **Split panes within the drawer.** One terminal, one log, one visible at a time.
- **Terminal in the Tauri-native terminal API.** Node sidecar owns the PTY; Tauri is just the webview host.

## 22.15 Implementation notes

(Non-normative — the code may evolve independently.)

- `src/terminals/registry.ts` — `TerminalRegistry` + `TerminalSession` types and PTY lifecycle.
- `src/terminals/websocket.ts` — `ws` upgrade handler wired into the Node server.
- `src/routes/terminal.ts` — HTTP endpoints (`status`, `restart`, `kill`).
- `src/client/terminal.tsx` — xterm.js mount + WebSocket client + connection state machine.
- `src/client/drawer.tsx` — refactored drawer with tab strip (currently `commandSidebar.tsx`). The push-up layout work in HS-6262 lands here too.
- Cleanup: `src/cleanup.ts` gains a `killProjectTerminal(secret)` call on project unregister.
- DB: no schema changes required. Sessions are purely in-memory.

## 22.16 Cross-references

- [4-user-interface.md](4-user-interface.md) — drawer now has tabs; push-up layout affects ticket list region.
- [8-cli-server.md](8-cli-server.md) — startup/shutdown lifecycle must kill live PTYs on SIGTERM.
- [12-claude-channel.md](12-claude-channel.md) — `channelEnabled` gates the `{{claudeCommand}}` substitution.
- [14-commands-log.md](14-commands-log.md) — the other tab in the same drawer.
- [15-shell-commands.md](15-shell-commands.md) — one-shot shell remains separate; interactive use = terminal.
- **Tickets:** HS-6261 (this doc), HS-6262 (drawer push-up layout prerequisite).
