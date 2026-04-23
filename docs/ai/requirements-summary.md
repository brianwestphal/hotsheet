# Hot Sheet — AI Requirements Summary

**Purpose.** A single-file synthesis of every requirements document under `docs/`. Read this to understand *what Hot Sheet is supposed to do* without reading each doc front-to-back. Pair it with `docs/ai/code-summary.md` (*where the code lives*).

**Status legend.** Each entry is tagged:
- **Shipped** — fully implemented and tested.
- **Partial** — core shipped, enumerated gaps noted.
- **Design only** — doc exists, implementation not yet built.
- **Deferred** — intentionally postponed; see the entry for the trigger to revisit.

**Maintenance.** See §15. Update this file in the same change as any requirements doc change.

---

## 1. Product vision & foundational decisions

Hot Sheet is a local-first, developer-focused ticket tracker that lives next to a codebase. A CLI (`hotsheet`) spins up an embedded HTTP server + browser UI; data lives in `.hotsheet/` beside the project; a Tauri wrapper offers a native desktop experience. The product's central bet is **AI-integration**: tickets are auto-exported to markdown worklists, and an MCP channel lets Claude Code work through the worklist turn-by-turn.

- **Non-functional requirements** (§1): strict data locality, debounces tuned for responsiveness (worklist 500 ms, open-tickets 5 s), parameterized SQL only, soft-delete everywhere, 3-tier auto backups, signed desktop updates, cross-platform (macOS, Linux, Windows).
- **Build outputs** (§1): `dist/cli.js`, `dist/channel.js`, `dist/client/app.global.js`, `dist/client/styles.css`.
- **Status:** Shipped.

---

## 2. Data & storage (`2-data-storage.md`)

PGLite embedded Postgres with automatic additive migrations, tables for tickets (HS-prefixed auto-increment IDs, never reused), attachments, stats snapshots, command log, settings (plugin-only now — project config moved to `.hotsheet/settings.json`), plus sync tables (`ticket_sync`, `sync_outbox`, `note_sync`). Notes stored as JSON array `{ id, text, created_at }`. File-based settings.json carries `appName`, `backupDir`, `appIcon`, `ticketPrefix`, `secret`, `port`, UI layout keys. A `.hotsheet/hotsheet.lock` file (pid/startedAt) enforces single-instance per data dir; `~/.hotsheet/instance.json` + `projects.json` support multi-project.

**Status:** Shipped (full schema, migrations, stale-lock cleanup, multi-project registry). Cross-refs: §3 (notes), §7 (backupDir), §18 (plugin_enabled prefix).

---

## 3. Ticket management (`3-ticket-management.md`)

The core domain model.

- **IDs:** `HS-N`, sequence-backed, never reused even after delete.
- **6 default categories** (customizable): Issue, Bug, Feature, Req Change, Task, Investigation — each with label, shortLabel, color, shortcut key, description.
- **5 priorities:** highest / high / default / low / lowest.
- **7 statuses:** not_started, started, completed, verified, backlog, archive, deleted. Composite filter values: `open`, `non_verified`, `active`.
- **Tags:** bracket syntax `[tag]` in titles auto-extracts. Stored normalized lowercase, displayed Title Case.
- **Notes:** JSON array with auto-generated IDs.
- **Up Next flag** can reopen completed/verified tickets.
- **Batch operations, soft + hard delete, restore.**
- **Auto-cleanup:** configurable (default 3 days for deleted, 30 days for verified/completed).

**Status:** Shipped; conflict resolution UI is cross-cutting with the plugin system (§18).

---

## 4. User interface (`4-user-interface.md`)

Six UI regions: header (title / search / layout toggles / settings), sidebar (status views, category/priority filters, drag targets, stats bar, custom views), list/column/kanban views with scroll-position preservation, detail panel (side or bottom, resizable, 300 ms debounced auto-save), footer (shortcuts / status), and banners. Column view is not available for single-status views and supports drag-and-drop across columns. Settings dialog has tabs: General, Categories, Backups, Context, Plugins, Experimental, Updates. Unread indicator (blue dot) triggered when `updated_at > last_read_at`. Custom views support AND/OR logic with Category/Priority/Status/Title/Details/Up Next/Tags conditions. Dashboard shows 7/30/90-day metrics, throughput, CFD, category donut, cycle-time scatter. Undo/redo stack holds up to 1000 entries (in-memory only).

**Status:** Shipped. Cross-refs: §3 (tags/notes), §7 (preview mode), §12 (attention badges), §18 (plugin UI extensions in toolbar/detail/context).

---

## 5. Attachments (`5-attachments.md`)

Drag-and-drop files into the detail panel (nested enter/leave counter prevents flicker); files stored as `.hotsheet/attachments/{ticket_number}_{original_name}.{ext}`. Multiple files upload sequentially. Standard MIME types (PNG/JPEG/GIF/SVG/WebP, PDF, text/markdown/JSON, ZIP, HTML/CSS/JS) served correctly; unknown types fall back to octet-stream. Platform-specific "Reveal in Finder" (macOS `open -R`, Windows `explorer /select`, Linux `xdg-open`). Deletion removes DB row + file. Auto-cleanup runs on hard-delete and trash empty.

**Status:** Shipped.

---

## 6. Markdown sync & AI-skill generation (`6-markdown-sync.md`)

The bridge from Hot Sheet to AI tools.

- **Exports:** `.hotsheet/worklist.md` (Up Next, 500 ms debounced), `.hotsheet/open-tickets.md` (all open, 5 s debounced). Worklist includes curl examples for status updates and ticket creation.
- **Auto-prioritize** (default on, settings key `auto_order`): when Up Next is empty, the worklist contains instructions for the AI to select the next items itself.
- **Skill generation:** `.claude/skills/hotsheet/SKILL.md` + per-category `hs-{category}/SKILL.md` for Claude Code; `.cursor/rules/hotsheet.mdc`, `.github/prompts/hotsheet.prompt.md`, `.windsurf/rules/hotsheet.md`. Per-category skills parse prefixes like "next" / "up next" / "do next" to set `up_next: true`.
- **Version-gated regeneration:** skills include `<!-- hotsheet-skill-version: N -->`; only regenerated when the code's version bumps. Bump it whenever generated skill content should change.
- **Secret validation:** mutations outside localhost require `X-Hotsheet-Secret` header.
- **Port range pattern:** curl examples in generated skills use 4170–4199 so they survive port fallback.

**Status:** Shipped.

---

## 7. Backup & restore (`7-backup-restore.md`)

Three-tier automated backups (5-minute × 12 → ~1 hour retention; hourly × 12 → ~12 hours; daily × 7 → ~1 week). Stored as PGLite tar.gz dumps in `.hotsheet/backups/{tier}/` or a custom `backupDir`. "Backup Now" triggers the 5-minute tier and resets its timer. **Preview mode** loads a backup into a temporary PGLite instance with read-only UI (banner + disabled detail panel). Restore creates a safety backup first, closes current DB, loads the backup, and triggers markdown resync. Cleanup combines count-based (maxCount) and time-based (maxAge) pruning.

**Status:** Shipped.

---

## 8. CLI & server (`8-cli-server.md`)

The `hotsheet` global CLI. Args: `--port` (default 4174), `--data-dir` (default `.hotsheet/`), `--no-open` (Tauri sidecar mode), `--strict-port` (fail rather than fall back), `--close` (unregister project), `--list` (show registered projects), `--check-for-updates`, `--demo:N` (scenarios 1–10 with pre-populated data), `--help`. Port fallback tries 20 consecutive ports (4174–4193). Multi-project: single server process; subsequent invocations join via `~/.hotsheet/instance.json`. Demo scenarios tune UI (scenario 6 → detail_position=bottom, 7 → layout=columns, 10 → registers 2 extra projects). 23-step documented startup sequence covering args, update check, lock, PGLite init, cleanup, server, markdown sync, skill generation, backup scheduler, project restoration, stale channel cleanup, heartbeat hooks, instance file, browser launch.

**Status:** Shipped.

---

## 9. REST API (`9-api.md`)

Single source of truth for HTTP contracts. Zod validation throughout. All mutations bump a change version consumed by long-poll (`/api/poll`, 30 s timeout, 5 s retry); header `X-Hotsheet-User-Action: true` bumps `last_read_at` (controls the unread dot). Endpoint surface covered in `code-summary.md §4`. Noteworthy behaviors:

- **Composite status values** on `GET /api/tickets`: `open`, `non_verified`, `active`.
- **Batch endpoint** actions: delete, restore, category, priority, status, up_next, mark_read, mark_unread.
- **Custom view query** (`POST /api/tickets/query`): logic, conditions, required_tag AND'd.
- **Dashboard** returns 7/30/90-day KPIs, throughput, CFD, cycle-time scatter.
- **Settings are split** between DB (plugin-only) and file (`/api/file-settings`).

**Status:** Shipped.

---

## 10. Desktop app (`10-desktop-app.md`)

Tauri v2 wraps the Node server as a sidecar (see §Tauri below for why). CLI launcher may pre-start the server (`HOTSHEET_SERVER_URL` + `HOTSHEET_SIDECAR_PID` env vars); Tauri alternatively spawns the sidecar itself. Sidecar cleanup: Unix sends SIGTERM then kills the process group; Windows uses `taskkill /T /F`. Welcome screen appears if no prior projects. Window title: custom `appName` or `"Hot Sheet — {folder_name}"`. Software updater checks GitHub releases and prompts user with an Install button (user-initiated, restart required). CLI installer symlinks to `/usr/local/bin/hotsheet` (macOS, osascript admin prompt), `~/.local/bin/hotsheet` (Linux), or `%LOCALAPPDATA%/Programs/hotsheet` + PATH (Windows). IPC surface: `check_cli_installed`, `install_cli`, `get_pending_update`, `check_for_update`, `install_update`, `set_app_icon`, `request_attention[_once]`, `open_url`, `quicklook`, `pick_folder`, `open_project`. Capabilities: `default` (core IPC + shell + updater + process) and `remote-localhost` (IPC to `localhost:*`). Known: WKWebView on macOS may suppress `confirm()` dialogs.

**Status:** Shipped except **Windows code signing** (SmartScreen warning accepted; Azure Trusted Signing deferred). Cross-refs: §13 (app-icon), tauri-architecture.md (sidecar details).

---

## 12. Claude Channel (`12-claude-channel.md`)

The MCP channel gives Claude Code a real-time link to Hot Sheet. Three components: channel server (MCP server, bundled at `dist/channel.js`, listens on local HTTP port, forwards to Claude Code over stdio), Hot Sheet server (detects channel via `.hotsheet/channel-port` file, POSTs events), and Hot Sheet UI (play button in sidebar).

- **Settings:** Experimental tab → Claude Channel toggle. Disabled if Claude CLI < v2.1.80. Stored as `channelEnabled` in `~/.hotsheet/config.json`, with per-project `channel_enabled` fallback.
- **.mcp.json registration:** production uses `node dist/channel.js --data-dir ...`; dev uses `npx tsx src/channel.ts`.
- **Play button:** single-click verifies channel, checks Up Next, flushes pending syncs, sends event. Double-click toggles **auto mode** (immediate trigger, 5 s debounce on Up Next changes, exponential backoff 5→10→20→40→80→120 s on busy, re-trigger on `/channel/done`).
- **Busy/idle status:** spinner + text, 60 s fallback timeout. Heartbeat hooks installed into `~/.claude/settings.json` (PostToolUse=heartbeat, UserPromptSubmit=busy, Stop=idle, 30 s sliding timer).
- **Permission relay:** channel server receives permission_request notifications, exposes via `/permission`; Hot Sheet polls `/api/channel/permission` (long-poll + notify). Overlay shows tool name/description/input preview; buttons Allow / Deny / Dismiss (120 s expiry). Compact popup for inactive project tabs.
- **Custom commands:** 9-color palette, Lucide icon picker (1693 icons, 24 featured), name, prompt, stored in `custom_commands` settings key. Appear as buttons below play button.

**Status:** Shipped. Cross-refs: §1 (localhost-only), §6 (skill regeneration bump), §15 (custom command targets), §16 (command groups).

---

## 13. App icon (`13-app-icon.md`)

9 icon variants (flame motif) plus the default. Settings → General tab shows a dropdown with thumbnail grid. Click updates the dock icon immediately (no relaunch) via Tauri's `set_app_icon`. Stored in `.hotsheet/settings.json` as `appIcon` (values `default` or `variant-1`…`variant-9`). macOS implementation: reads `.icns`, builds an `NSImage` via the `objc2` crate with a 824×824 body in a 1024×1024 continuous-corner rounded-rect canvas + drop shadow, calls `NSApplication.setApplicationIconImage()`. Cross-platform: Windows taskbar + Linux window via `Window::set_icon()`.

**Shipped:** 9 variants, dropdown, runtime change. **Design only:** startup icon restoration (currently only applied when the Settings dialog opens). Cross-refs: §2 (appIcon), §10 (IPC command).

---

## 14. Command log (`14-commands-log.md`)

**Missing from CLAUDE.md reading order — add it.** UI panel recording all Claude channel and shell-command activity. Persisted in the `command_log` table (capped ~1000 entries). Event types: `trigger` (outgoing channel event), `done` (incoming `/channel/done`), `permission_request` (incoming, updated in place on response), `shell_command` (outgoing, updated in place on completion). Footer has a panel icon with an accent-colored dot when new entries arrive. Panel is resizable (default 300 px, min 150, max 600). Search (300 ms debounce) + multi-select event-type filter + clear button + minimize. Entries show direction indicator (→ blue / ← green / ● gray), event-type badge, summary, relative timestamp, first 3 lines of detail (click to expand). API: `GET /api/command-log` (limit, offset, event_type, search), `DELETE /api/command-log`, `GET /api/command-log/count`. Auto-refresh every 5 s when open.

**Status:** Shipped. Cross-refs: §12 (channel events), §15 (shell command events, `---SHELL_OUTPUT---` separator).

---

## 15. Shell commands (`15-shell-commands.md`)

Custom commands can target **Claude Code** (requires channel) or **Shell** (runs locally). When channel is disabled, new commands default to Shell and are always visible; Claude-target commands hide when channel is disabled. Execution: `POST /api/shell/exec` → `child_process.spawn` with `shell: true`, cwd = project root (parent of `.hotsheet/`). A `shell_command` log entry is created; client shows "Shell running" (same busy indicator as Claude Channel); stdout/stderr captured and appended (separator `---SHELL_OUTPUT---`); client polls `/api/shell/running`. Kill: `POST /api/shell/kill` sends SIGTERM, SIGKILL after 3 s if not exited. `CustomCommand` interface: `name`, `prompt`, `icon`, `color`, `target` (`claude`|`shell`, default `claude`), `autoShowLog` (boolean). Non-zero exit auto-opens the command log regardless of `autoShowLog`.

**Status:** Shipped.

---

## 16. Command groups (`16-command-groups.md`)

Custom commands can be organized into named groups (collapsible in sidebar, grouped in the settings editor). Data model: `CommandItem = CustomCommand | CommandGroup`; `CommandGroup` has `type: 'group'`, `name`, optional `collapsed`, explicit `children[]`. Ungrouped commands appear at top level before/between groups. Auto-migration from an older `group: string` field. Settings editor is an outline view: flat list of items, group headers drag-reorderable (contentEditable name — Enter/blur saves, Escape cancels, empty reverts). Two buttons: Add Command, Add Group. Command editor modal has color picker, icon picker, name, target segmented control (Claude/Shell), prompt textarea, auto-show-log checkbox (Shell only), and a Claude Channel warning when target=Claude and channel is disabled.

**Status:** Shipped.

---

## 17. Share (`17-share.md`)

Persistent footer link: "Know someone who'd love this? Share Hot Sheet" (accent blue). Click triggers Web Share API (title "Hot Sheet", text "A fast, local ticket tracker that feeds your AI coding tools.", URL `https://www.npmjs.com/package/hotsheet`); clipboard fallback if unavailable. **Share prompt banner** appears when: total accumulated time ≥ 5 min (300 s), current session ≥ 1 min (60 s), not prompted in last 30 days (or never), `shareAccepted !== true`. Timing tracked every 30 s into `shareTotalSeconds` in `~/.hotsheet/config.json`. Banner buttons: "Share" (sets `shareAccepted: true`, never reappears) and "Not now" (sets `shareLastPrompted`, banner returns after 30 days). API: `GET`/`PATCH /api/global-config`.

**Status:** Shipped.

---

## 18. Plugin system (`18-plugins.md`)

Extensible plugin system for external ticketing backends (GitHub, Linear, Jira, …) and custom UI. Build-time toggle `PLUGINS_ENABLED=false` disables the subsystem. Plugins installed under `~/.hotsheet/plugins/<id>/` (global); bundled plugins copied there if missing or outdated, tracked in `~/.hotsheet/dismissed-plugins.json`. Per-project enable state in DB `plugin_enabled:{id}`; reactivation on config change, sync, action, or push-ticket endpoints.

- **Manifest fields:** id, name, version, description?, author?, entry?, icon? (inline SVG), preferences?, configLayout?.
- **Preference types:** string, boolean, number, select, dropdown, combo. Optional: default, description, required, secret, scope (global|project), options.
- **ConfigLayout items:** preference, divider, spacer, label (id/text/color + `updateConfigLabel`), button (id/label/action/icon?/style?), group (title/collapsed?/items).
- **PluginContext:** config, log, getSetting, setSetting, registerUI, updateConfigLabel.
- **TicketingBackend:** identity, capabilities (create/update/delete/incrementalPull/comments/syncableFields), fieldMappings, CRUD, sync (`pullChanges(since)`, `getRemoteTicket?`), status (`checkConnection`, `getRemoteUrl?`, `shouldAutoSync?`), comments, attachments (`uploadAttachment?`).
- **Sync engine:** push via direct timestamp comparison; pull fetches via `pullChanges`; comments via three-way merge using `note_sync.last_synced_text`; attachments uploaded via backend then posted as markdown link.
- **UI extensions (8 locations):** toolbar, status_bar, sidebar_actions_top, sidebar_actions_bottom, detail_top, detail_bottom, batch_menu, context_menu. **Element types rendered:** button, link. **Declared but not yet rendered:** toggle, switch, segmented_control.
- **Image proxy:** `GET /api/plugins/:id/image-proxy` handles private-repo images with stored PAT.
- **API endpoints:** 27 endpoints covering install, enable/disable/reactivate, sync, push-ticket, action, uninstall, config, schedules.

**Status:** Mostly shipped. **Design only:** `batch_menu` rendering, `toggle`/`switch`/`segmented_control` UI types. Cross-refs: §19 (demo), §20 (secret storage).

---

## 19. Demo plugin (`19-demo-plugin.md`)

Bundled plugin that exercises every surface of the plugin API. Not connected to any external system. Demonstrates all 7 preference types (string/secret/global, required string, boolean, number, select/dropdown, combo), all configLayout types (including button actions and dynamic label colors — transient/success/error/warning), field validation (min length, no-spaces, URL format, numeric range), and UI at all 8 locations. Label-color demo: "Not tested" (transient), valid creds (success), short API key (error), missing fields (warning). Available in source (`plugins/demo-plugin/`), not bundled for production — install via "Find Plugins > From Disk".

**Status:** Shipped.

---

## 20. Secure storage (`20-secure-storage.md`)

**Missing from CLAUDE.md reading order — add it.** Plugin preferences with `secret: true` are stored in the OS keychain with transparent file/DB fallback. Entry format: service `com.hotsheet.plugin.{pluginId}`, account = preference key, password = secret value. **Actual implementation (§20.8) differs from the initial Tauri design (§20.4):** uses Node-level platform commands (`security` on macOS, `secret-tool` on Linux via `execFile`) with zero native dependencies. `getSetting` tries keychain → file fallback → migrate on first read. `setSetting` dual-writes to both for reliability. Fallbacks: Tauri locked keychain → file/DB (warn), browser → file/DB, CLI macOS/Linux → spawn platform command, **CLI Windows → not yet implemented**. Secrets never logged; `secret: true` renders a password input. Implemented in `src/keychain.ts` + `src/plugins/loader.ts` + `src/routes/plugins.ts`.

**Shipped:** macOS + Linux keychain integration. **Design only:** Windows Credential Manager. Cross-refs: §18 (secret preference type).

---

## 22. Embedded terminal (`22-terminal.md`)

Adds Terminal tabs to the footer drawer (alongside Commands Log) hosting interactive xterm.js terminals wired to per-project PTYs on the server. The Commands Log tab is icon-only (HS-6474) with a vertical divider before the terminal tabs (HS-6475); Cmd+Shift+Arrow cycles terminal tabs when a terminal is focused (HS-6472, add Alt/Option to route back to project tabs). Each project can run **multiple terminals**: (a) configured default terminals persisted in `settings.terminals` (editable outline list in Settings → Experimental), and (b) dynamic terminals created ad-hoc via a **+** button in the drawer tab strip and closed via an **×** button on the tab. Registry keys sessions by `${secret}::${terminalId}` so multiple terminals coexist. Terminals are server-owned so they survive drawer close / tab switch / browser reload / multi-window attach (tmux-like — multiple windows share the same session per terminal). Spawn is lazy (on first attach); scrollback kept in a 1 MiB (configurable) ring buffer on the server for reattach replay. Default command is a template `command` field per-terminal; `{{claudeCommand}}` resolves to `claude --dangerously-load-development-channels server:hotsheet-channel` when `channelEnabled` is true, else `claude`, else the user's shell. Power toggle (Stop/Start) replaces the earlier Restart button: first click sends SIGHUP (interactive shells ignore SIGTERM but respect SIGHUP, HS-6471), a latched second click prompts before escalating to SIGKILL, Start spawns a fresh PTY. Right-click on a tab opens a context menu with Close Tab / Close Others / Close to the Left / Close to the Right (HS-6470) — configured defaults disable Close Tab and are exempt from the bulk-close actions. The whole feature is **Tauri-only** (HS-6437): non-Tauri clients (plain browser access) hide the drawer tab strip and the Settings → Terminal tab button. Settings live on their own dedicated **Terminal** tab (HS-6337, moved out of Experimental), the legacy `terminal_enabled` checkbox is gone (the feature is simply on in Tauri), and projects default to an empty `terminals` list — there is no implicit default terminal. Transport is WebSocket (`/api/terminal/ws?project=<secret>&terminal=<id>`); native dep is `node-pty` (first non-WASM native addon). Drawer-layout prerequisite (push-up, HS-6262) was delivered separately; HS-6312 added a full-height expand button in the drawer tab strip (state persisted as `drawer_expanded`).

**Out of scope:** per-window private terminals, session recording, SSH / remote targets, split panes. Cross-refs: §4 (drawer layout), §12 (channel gates command substitution), §14 (Commands Log tab sits next to them), §15 (one-shot shell stays separate).

**Status:** Shipped — full v1 end-to-end plus HS-6271 (configurable multi-terminal defaults), HS-6306 (dynamic + button), HS-6304 (stop/start power button), HS-6305 (trash icon for clear), HS-6308 (no black strip below the xterm grid), HS-6309 (per-project drawer state + terminal scoping), and HS-6310 (eager-spawn for `lazy:false` terminals — spawns at project boot and on settings save). Installed deps: `node-pty` (prod), `ws` (prod + @types/ws dev), `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` + `@xterm/addon-serialize` (prod). Server side: `src/terminals/{config,ringBuffer,resolveCommand,registry,websocket,eagerSpawn}.ts` + `src/routes/terminal.ts`; client side: `src/client/{terminal,terminalsSettings}.tsx`. 52 unit tests across 6 terminal modules. Deferred follow-ups: E2E smoke test, live Tauri per-platform smoke (manual-test-plan §12), Windows ConPTY verification.

---

## 23. Terminal titles and bell indicators (`23-terminal-titles-and-bell.md`)

Two QOL surface enhancements on top of §22. (1) **Title-change escapes:** `term.onTitleChange` is wired so OSC 0 / OSC 2 (`\x1b]0;TITLE\x07`) updates `runtimeTitle` on the `TerminalInstance`, and the drawer tab + in-pane header label resolve to it via `effectiveTabLabel`. Falls back to the configured `name` (or derived basename) when the runtime title is empty; resets on PTY restart and on project switch. (2) **Bell indicator (Phase 1):** `term.onBell` sets `hasBell` on the `TerminalInstance`; when the firing terminal isn't the active drawer tab, a Lucide `bell` glyph wiggles into place next to the tab label and clears as soon as the tab is activated. The bell-during-active case is suppressed by an `isTerminalTabActive` guard. **Phase 2** is specified separately in §24.

**Status:** Shipped Phase 1 — title escapes (full) + same-project bell indicator. Implementation in `src/client/terminal.tsx` (`runtimeTitle`, `hasBell`, `effectiveTabLabel`, `BELL_ICON`, `updateTabLabel`) and `src/client/styles.scss` (`.drawer-tab-bell` + `drawer-tab-bell-shake` keyframe). Cross-refs: §22 (base terminal feature), §24 (Phase 2 spec).

---

## 24. Cross-project bell indicator (`24-cross-project-bell.md`)

Phase 2 of the bell indicator: surface bells fired in non-current projects (where no client xterm is mounted) and in not-yet-mounted terminals within a project. Server-side `\x07` detection is added to the `TerminalRegistry` PTY data handler, setting a per-session `bellPending: boolean` flag that survives until explicitly cleared. New endpoints: `POST /api/terminal/clear-bell` (acknowledge + clear), `GET /api/projects/bell-state` (cross-project long-poll mirroring `/api/projects/permissions`), and an extended `/api/terminal/list` that includes `bellPending` per session. Client gains a `src/client/bellPoll.tsx` long-poll loop that updates a per-project bell map and re-renders both the project-tab indicator (suppressed on the active project, shown on others) and the in-drawer per-terminal indicators. Activating a project hides the project-tab indicator without clearing per-terminal flags, so the user can still see which specific terminal wanted attention. Activating a terminal tab clears its server-side `bellPending`. In-memory only — server restart drops all pending bells (intentional). No new user settings in v1; possible follow-ups call out an audio chime, decay timer, and full suppression toggle.

**Status:** Shipped. Server-side: `TerminalRegistry`'s PTY data handler flips a per-session `bellPending` flag on `0x07`; helpers (`getBellPending`, `clearBellPending`, `listBellPendingForProject`) are exposed to the route layer. `/api/terminal/list` now includes `bellPending` per entry; `/api/terminal/clear-bell` clears the flag; `/api/projects/bell-state` long-poll aggregates pending state across every registered project. Client-side: `src/client/bellPoll.tsx` runs the long-poll loop from app boot, populates a module-level `BellStateMap`, and fans out via `updateProjectBellIndicators` in `projectTabs.tsx` (adds `.has-bell` + Lucide bell SVG to non-active project tabs) and a `subscribeToBellState` callback in `terminal.tsx` (syncs in-drawer per-terminal indicators). `loadAndRenderTerminalTabs` seeds `inst.hasBell` from the list response's `bellPending` field; `activateTerminal` fires-and-forgets `/api/terminal/clear-bell` so the server flag drops. In-memory only — server restart clears all pending bells. Cross-refs: §22 (base terminal), §23 (Phase 1).

---

## 25. Terminal dashboard view (`25-terminal-dashboard.md`)

A second top-level client view (alongside the normal per-project ticket view) for eyeballing every terminal across every registered project at once. Entered via a new `square-terminal` toolbar button placed before the first project tab (HS-7030 — was `layout-panel-left`) (Tauri-only, hidden entirely on web). While active, only the toggle button and the project-tab strip remain visible in the top toolbar — settings, search, layout toggles, channel cluster, ticket area, detail panel, and per-project drawer are all hidden. Content area becomes a vertically scrollable column of per-project sections: project heading, then a flex-wrap grid of 4:3 terminal tiles with the terminal title centered below each tile. Every tile is identically sized — one global computation picks the largest width such that all tiles fit the viewport (min 100 px preview height; content scrolls vertically when even the floor doesn't fit). Tiles render a shared xterm instance pinned at a per-tile cols × rows picked at mount time from measured cell metrics so natural pixel size ≈ 1280 × 960 (matches the 4:3 tile) — typically ~160 × 60 on macOS ui-monospace 13px — and visually fit via `transform: scale(...)` — the PTY is untouched and other attachers (drawer, other windows) see no reflow. Single-click zooms a tile to ~70 % viewport centered overlay with focus + keyboard input; click outside / Esc / click same tile returns to grid; click a different tile swaps. Double-click enters a dedicated full-viewport view that _does_ `fit()` (PTY resized to match) and whose Back/Esc return to the grid. Bells bounce the tile once (350 ms keyframe) and persist an accent outline until the user centers the tile, enters its dedicated view, or exits dashboard and opens the drawer — any of which fires `POST /api/terminal/clear-bell` (reusing §24 transport). Lazy-unspawned and exited terminals render a placeholder tile (label + play glyph + status); spawning happens on enlarge (center or dedicated), not at dashboard open. Projects with zero terminals still render their heading plus an "open Settings → Terminal to add one" empty-state row. Exit paths: click the toggle again, press Esc on the bare grid, or click any project tab (auto-exits dashboard **and** navigates to that project's ticket view). No new server endpoints, no new settings — dashboard-open is an in-memory client-only flag that resets on reload.

**Status:** Shipped v1 — HS-6272 parent and HS-6832 through HS-6838 sub-tickets all completed. Bug-fix follow-ups: HS-6865 (explicit xterm-root width/height so xterm's internal absolutely-positioned layers have a concrete post-scale box), HS-6866 (share `readXtermTheme()` with the drawer so tile canvases use `--bg` / `--text` / `--accent` instead of xterm's default black), HS-6867 (FLIP grow-from-slot animation with a grey placeholder so centering a tile doesn't reflow the rest of the grid), HS-6868 (suppress the active-tab highlight while dashboard mode is open — global view, no project is "selected"), HS-6898 (non-uniform `scale(scaleX, scaleY)` to fill the 4:3 tile — **superseded by HS-6931**), HS-6931 (uniform `scale(s)` — text no longer stretches; `.xterm-screen` is the authoritative natural-dim measurement source rather than the block-level outer xterm root. The HS-6931 follow-up that resized xterm to a measured-cell 4:3 target (1280 × 960) was **superseded by HS-6965** — force-resetting the xterm back to that target after the history replay caused live bytes formatted for the PTY's own cols × rows to wrap at the wrong column and leave a band of empty rows below the last line of real content. The dedicated view's deferred `fit()` + `ResizeObserver` is retained.), HS-6964 (centered tile preview was sliding off the viewport centre because `tile.style.width` stayed at the grid-slot value while the preview was resized to `previewWidth` — `align-items: center` then flex-centered the larger preview around the smaller tile box. Fix: `centerTile` also sets `tile.style.width = previewWidth`, `applyTileSizing` skips centered tiles on resize, the dashboard's resize handler calls `recenterTile` so the centered overlay tracks the viewport centre, and preview snap writes use `transition: none` so the outer FLIP is the only animation running.), HS-6965 (superseded by HS-7097 follow-up — replay still runs at the PTY's cols × rows so scrollback bytes render correctly, but the tile then resizes its xterm to tile-native 4:3 dims via `tileNativeGridFromCellMetrics` AND pushes a `'resize'` message to the server-side PTY so a running TUI like `nano` actually `SIGWINCH`-redraws to fill the tile-native geometry — without the PTY resize, the tile shows the TUI's content from the original wide-short PTY rows with empty white rows below), HS-6997 (top-align the scaled xterm inside the tile preview — vertical dead space from HS-6965's letterboxing falls below the content in one band, like a macOS Terminal pane whose content hasn't yet reached the bottom, rather than sandwiching the content between equal bands top and bottom; encoded as `top: 0, left: centered` in `computeTileScale()`), HS-7096 (no CSS transition on preview width / height — slider drags and window resizes must snap, not animate, or the xterm transform scales against an intermediate box), HS-7097 (rescale via `.xterm-screen` ResizeObserver — replaces the earlier two-rAF chain that raced xterm's own render scheduler and could still fire against pre-resize `.xterm-screen` dims on first-history-after-mount; follow-up: tile's xterm is pinned to tile-native 4:3 cols × rows via `tileNativeGridFromCellMetrics` after replay + on mount; final follow-up: the tile's history handler also pushes a `'resize'` message to the server-side PTY at tile-native dims so a TUI like `nano` redraws to fill the tile geometry — the buffer-only resize left rows past the PTY's row count empty (visible as the white band on the user's "still wrong" screenshots). `exitDedicatedView()` re-sends the same `'resize'` so the PTY snaps back to the tile's geometry after the dedicated view temporarily took it. E2E coverage in `e2e/terminal-dashboard-tile-rendering.spec.ts` with a real PTY running a Python `SIGWINCH`-redraw fixture asserts the BOTTOM marker sits within 10 % of the preview bottom across all three views.), HS-7098 (`.terminal-dashboard-dedicated-body` keeps `padding: 16px` for the visual frame + xterm opens inside an inner `.terminal-dashboard-dedicated-pane` flex child with NO padding so FitAddon sees real available space; follow-up: pane is a flex container with centering + `.xterm` child has `flex: 0 0 auto` so it shrinks to `.xterm-screen`'s content width — sub-cell slop becomes symmetric left/right padding instead of an asymmetric right-side gap), HS-7099 (REMOVED by HS-7097 follow-up — mirroring the dedicated view's non-4:3 fit dims onto the grid tile re-introduced HS-7097's vertical-dead-space regression; tile now stays on tile-native 4:3 dims through the dedicated-view lifecycle), HS-7129 (slider default 50 → 33 so the dashboard opens with ~three tiles per row on a typical laptop instead of one big tile). Out of scope for v1 (deferred): keyboard shortcut to toggle, drag-to-reorder tiles, per-tile lifecycle buttons, input into grid tiles, resizable centered overlay, persisted dashboard-open state, multi-select, audio bell. Cross-refs: §22 (base terminal), §23 (bell Phase 1 — same concept at tile granularity), §24 (bell-state long-poll reused verbatim), §4 (top toolbar chrome that gets hidden), §10 (Tauri-only gating pattern).

---

## 21. Feedback notes (`21-feedback.md`)

AI tools request user feedback by adding a note to a ticket whose text begins with a recognized prefix (checked only on the most recent note):

- `FEEDBACK NEEDED:` — shows dialog when ticket is opened.
- `IMMEDIATE FEEDBACK NEEDED:` — auto-selects the ticket in the project's tab and opens the dialog.

Dialog shows prompt as markdown, a textarea, file attachments, and three buttons: **Later** (muted link, dismiss), **No Response Needed** (adds `NO RESPONSE NEEDED` note, clears state), **Submit** (creates note with response, uploads attachments, notifies channel). Click-outside dismisses like Later. Dialog auto-shows **once per detail-panel open** (tracked by note ID). "Provide Feedback" link button appears below a feedback-prefix note if it's the most recent.

**Indicators:**
- Ticket dot: **purple** (#8b5cf6) for pending feedback, takes priority over blue unread dot.
- Project tab: purple dot while any ticket has pending feedback; priority order feedback (purple) > permissions attention (blue) > channel busy (yellow).

**Channel notification:** on submit (when channel alive), sends `triggerChannelAndMarkBusy` with text "Feedback was provided on ticket {ticketNumber}. Please re-read the worklist and continue work on this ticket." The worklist.md includes a "Requesting User Feedback" section with curl examples. Skill version bumps on prefix changes so skills regenerate.

**Status:** Shipped.

---

## Tauri architecture & setup (`tauri-architecture.md`, `tauri-setup.md`)

**Both missing from CLAUDE.md reading order — add them.**

**Architecture:** Tauri v2 wraps Node as a sidecar because PGLite (WASM) needs filesystem access — single-binary compilers break it. Layout: `src-tauri/{src, tauri.conf.json, Cargo.toml, Entitlements.plist, capabilities, loading, resources, binaries, server, icons}`. Three launch flows: (1) double-click (no `--data-dir`) → welcome.html → CLI install wizard; (2) CLI launch on macOS (complex due to JIT/filesystem restrictions) → CLI script resolves app name, creates a stub `.app` in `.hotsheet/`, starts Node in background, writes URL+PID to `/tmp/hotsheet-server-{hash}.info`, `open -a` with stub app → stub launcher reads `/tmp`, sets `HOTSHEET_SERVER_URL`+`HOTSHEET_SIDECAR_PID`, execs real Tauri binary with `--data-dir`; (3) Tauri with `--data-dir` (fallback/dev) → spawns sidecar, waits for "running at" on stdout. Sidecar lifecycle tracked via `SidecarPid` managed state, killed on `RunEvent::Exit` (Unix: `libc::kill(-pid, SIGTERM)`; Windows: `taskkill /T /F`). Build pipeline: `scripts/build-sidecar.sh` downloads Node v20, runs `npm run build`, copies `dist/` + assets into `src-tauri/server/`; `tauri build` produces `.app`/`.AppImage`/`.msi`. CI/CD (`release-desktop.yml`) builds 4 targets, signs macOS, signs updates, creates draft GitHub Release. macOS entitlements: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` (required for signed V8/WASM).

**Setup:** Prerequisites = Rust + npm. One-time config: generate updater keys via `npx tauri signer generate -w ~/.tauri/hotsheet.key`, copy pubkey to `tauri.conf.json plugins.updater.pubkey`; generate icons via `npx tauri icon path/to/1024.png`; set GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` + password. macOS code-signing needs Developer ID Application cert + app-specific Apple ID password (secrets: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID). Release: tag `v*` → CI builds/signs/publishes draft release. Version must stay in sync across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.

**Status:** Shipped. Windows signing intentionally skipped.

---

## plugin-development-guide.md

AI-focused guide covering both ticketing-backend plugins and non-ticketing plugins (time trackers, exporters, notifications, AI assistants, custom views, CI/CD bridges). Includes: minimal manifest, full preference/configLayout reference, entry-point contract (`activate`, `onAction`, `validateField`), PluginContext API, the 8 UI extension points, the `TicketingBackend` interface with all methods, how pull/push/conflict/comment/attachment sync works, field-mapping rules (canonical local categories/priorities/statuses), `RemoteChange` format, and a complete Linear plugin skeleton. Reference: `plugins/github-issues/` (real implementation).

**Status:** Shipped (intended to stay current with §18).

---

## Manual test plan (`manual-test-plan.md`)

Checklist of features automated tests can't reliably cover. 11 sections:

1. **Drag-and-drop:** column status changes, sidebar status/category drag targets, file attachment drag-over, project-tab reorder.
2. **Platform-specific:** macOS Finder reveal, Windows Explorer reveal, Linux xdg-open, Tauri window title, sidecar lifecycle, CLI installer, app-icon variant (no relaunch, persists).
3. **Claude Channel:** play button, single/double-click, auto mode, exponential backoff, permission overlay.
4. **Shell commands:** execution, busy indicator, log entry, stop button, working directory.
5. **Command groups:** reorder within/between/out-of groups, header reorder.
6. **Share prompt:** link, banner criteria, Share/Not now buttons.
7. **CLI/Server:** port args, multi-project join, list/close, stale lock cleanup, port fallback.
8. **Demo mode:** scenarios 1/7/10.
9. **Backup/restore:** preview banner, read-only detail panel, safety backup, custom backupDir.
10. **Visual/styling:** strikethrough/muted, detail resize, search animation, dropdown positioning, toast notifications, combo filtering.
11. **Keychain/secure storage:** verify via `security` (macOS) / `secret-tool` (Linux), locked/unavailable fallback.

Also lists automated coverage so you know what's already under test.

**Status:** Shipped as a living checklist — add/remove items as automation coverage changes.

---

## `docs/testing/` directory

Eight internal testing specification docs: 1-overview (strategy, phases, coverage goals), 2-database, 3-api, 4-backup-restore, 5-markdown-sync, 6-skills, 7-cleanup-and-lifecycle, 8-client. These are planning/coverage-target docs, not user-facing requirements.

---

## 13. Themes (cross-doc)

- **Core:** §1, §2, §3, §4.
- **Attachments:** §5.
- **AI integration:** §6, §12, §14, §15, §16, §21.
- **Desktop & CLI:** §8, §10, §13, tauri-architecture, tauri-setup.
- **Backup & recovery:** §7.
- **API:** §9 (surface), §14 / §15 / §18 add more endpoints under their concerns.
- **Plugins:** §18, §19, §20, plugin-development-guide.
- **Engagement:** §17 (share).
- **Testing:** manual-test-plan, `docs/testing/`.

---

## 14. Implementation-status dashboard at a glance

| Doc | Status | Key unshipped bits |
|---|---|---|
| 1 — overview | Shipped | — |
| 2 — data storage | Shipped | — |
| 3 — ticket management | Shipped | Conflict-UI is in §18 |
| 4 — user interface | Shipped | — |
| 5 — attachments | Shipped | — |
| 6 — markdown sync | Shipped | — |
| 7 — backup/restore | Shipped | — |
| 8 — CLI/server | Shipped | — |
| 9 — API | Shipped | — |
| 10 — desktop | Partial | Windows code-signing deferred |
| 12 — Claude channel | Shipped | — |
| 13 — app icon | Partial | Startup icon restoration not implemented |
| 14 — command log | Shipped | — |
| 15 — shell commands | Shipped | — |
| 16 — command groups | Shipped | — |
| 17 — share | Shipped | — |
| 18 — plugins | Partial | `batch_menu` rendering; `toggle`/`switch`/`segmented_control` element types |
| 19 — demo plugin | Shipped | — |
| 20 — secure storage | Partial | Windows Credential Manager not implemented |
| 21 — feedback | Shipped | — |
| 22 — terminal | Shipped | full v1 (HS-6261 through HS-6270); future: E2E smoke test, live Tauri per-platform verification |
| 23 — terminal titles & bell | Shipped (Phase 1) | Phase 2 spec lives in §24 |
| 24 — cross-project bell | Shipped | server `0x07` detection + `bellPending` flag, `/api/projects/bell-state` long-poll, `/api/terminal/clear-bell`, project-tab `.has-bell` indicator, client bellPoll (HS-6603) |
| 25 — terminal dashboard | Shipped | full v1 — toggle button, per-project grid, live tiles at tile-native 4:3 cols × rows (from measured cell metrics — HS-7097 final follow-up: tile resizes both its xterm AND the server-side PTY to those dims via a `'resize'` message, so TUIs like nano redraw to fill the tile's geometry instead of leaving rows past the original PTY row count empty) with uniform transform:scale, click-to-center (FLIP grow-from-slot animation w/ grey placeholder) that tracks the viewport centre on resize, dedicated full-viewport view, tile bell indicators, lazy/exited placeholders with spawn-on-enlarge (HS-6272, HS-6832–6838; bug fixes HS-6865/HS-6866/HS-6867/HS-6868/HS-6898 superseded by HS-6931; HS-6964 fixed centered-tile off-viewport-centre; HS-6965 "PTY dims verbatim" and HS-7099 "tile mirrors dedicated fit" both superseded by HS-7097 final follow-up; HS-7098 follow-up flex-centers `.xterm` inside the dedicated pane for an even frame on all sides) |
| tauri-architecture | Shipped | — |
| tauri-setup | Shipped | — |
| plugin-development-guide | Shipped (living doc) | — |
| manual-test-plan | Living checklist | — |

---

## 15. Maintenance rules

**Update this file in the same change whenever any of these triggers fire:**

1. **New requirements doc** under `docs/` — add a section here **and** add the doc to the CLAUDE.md reading order.
2. **Status change** (a Design-only feature ships; a Shipped feature regresses or is deferred) — update the relevant entry *and* the dashboard in §14.
3. **Feature is superseded or deferred** — note it in the entry and reflect in §14.
4. **New sub-phase / major addition under an existing doc** (e.g., new plugin UI element type, new command log event type) — update that section.
5. **Cross-reference change** (doc moved / renumbered / renamed) — update links here and in CLAUDE.md.

Keep each section **4–6 sentences**. This doc exists to *replace* reading 20+ files during orientation — if an entry balloons, the detail belongs in the source doc, not here.

---

## 16. Related reading

- **Code map:** `docs/ai/code-summary.md` (sibling file — read together).
- **Project-level conventions:** `/CLAUDE.md`.
- **Source docs:** `docs/1-overview.md` … `docs/21-feedback.md`, `docs/plugin-development-guide.md`, `docs/tauri-architecture.md`, `docs/tauri-setup.md`, `docs/manual-test-plan.md`, `docs/testing/*`.
