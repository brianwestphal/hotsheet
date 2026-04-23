# Hot Sheet — AI Code Summary

**Purpose.** This document is the fast-onboarding map of the Hot Sheet codebase for a fresh AI session (or human reader). Read it first; then open only the specific files you need. It is a *map*, not a reference — for full behavior see `docs/*` (requirements) and the code itself.

**Maintenance.** This file must be kept in sync with the code. See §17 (Maintenance rules) — if any trigger listed there fires in a change, update this file in the same pass.

---

## 1. Stack at a glance

- **Runtime:** Node.js 20+, ESM (`"type": "module"`, `.js` extensions on imports).
- **Language:** TypeScript strict mode.
- **Server:** Hono on `@hono/node-server`, default port 4174 (fallback 4174–4193).
- **DB:** PGLite (embedded Postgres WASM). Per-project data in `.hotsheet/db/`.
- **Rendering:** Custom JSX runtime → HTML strings (`SafeHtml`). Shared server + client. No React.
- **Build:** tsup (server CLI + channel + client IIFE), sass for styles, esbuild for plugins.
- **Desktop:** Tauri v2 wraps the Node server as a sidecar.
- **AI integration:** Markdown worklist exports + MCP channel server (`src/channel.ts`, `CHANNEL_VERSION=3`).

---

## 2. Request lifecycles

### Server startup (`src/cli.ts` → `src/server.ts`)

1. Parse args (`--port`, `--data-dir`, `--no-open`, `--demo:N`, `--close`, `--list`, `--strict-port`, `--check-for-updates`).
2. Check for update (`src/update-check.ts`), resolve/register data dir, acquire lock (`src/lock.ts`).
3. Init PGLite + run schema migrations (`src/db/connection.ts`).
4. Auto-cleanup (stale trash, attachments) — `src/cleanup.ts`.
5. Start Hono server + mount routes (`src/routes/api.ts`).
6. Debounced markdown export (`src/sync/markdown.ts`) → `.hotsheet/worklist.md` (500ms), `.hotsheet/open-tickets.md` (5s).
7. Generate AI skill files (Claude `.claude/skills/hotsheet`, Cursor, Copilot, Windsurf) — version-gated.
8. Schedule 3-tier backups (`src/backup.ts`).
9. Write `~/.hotsheet/instance.json`, open browser unless `--no-open`.

### Client boot (`src/client/app.tsx`)

Served via `/` → `src/routes/pages.tsx` renders HTML shell (`src/components/layout.tsx`), which loads `/static/app.js` (IIFE) + `/static/styles.css`. `app.tsx` initializes state, binds handlers, starts long-poll (`poll.tsx`), and mounts sidebar/list/detail modules.

### Mutations

UI → `src/client/api.tsx` → `/api/...` → route handler → `src/db/*` → change-version bumps → long-poll notifies other tabs → debounced markdown resync.

---

## 3. Directory tree (annotated)

### `src/` top-level

| File | Role |
|---|---|
| `cli.ts` | CLI entry + arg parsing, multi-project boot |
| `server.ts` | Hono app, middleware, static assets, secret validation |
| `channel.ts` | MCP server (stdio + HTTP). `CHANNEL_VERSION=3` |
| `channel-config.ts` | `.mcp.json` registration + `EXPECTED_CHANNEL_VERSION` check |
| `claude-hooks.ts` | Install/remove Claude hook entries in `~/.claude/settings.json` |
| `jsx-runtime.ts` | `SafeHtml`, `raw()`, server/client shared JSX → HTML strings. **Footgun:** passing a DOM element as a JSX child throws — the runtime renders to strings, so DOM nodes can't be composed. Build trees in one JSX expression and `querySelector` after `toElement()` (HS-6341/HS-6342 root cause). |
| `types.ts` | `Ticket`, `TicketCategory`, `TicketPriority`, `AppEnv` |
| `projects.ts` / `project-list.ts` | Multi-project registry (secret ↔ dataDir) |
| `instance.ts` | `~/.hotsheet/instance.json` PID + port; stale cleanup |
| `lock.ts` | `.hotsheet/hotsheet.lock` — single instance per dataDir |
| `file-settings.ts` | Read/write `.hotsheet/settings.json` (reserved vs user keys) |
| `global-config.ts` | `~/.hotsheet/config.json` (channel enabled, share stats) |
| `backup.ts` | 3-tier automated backups (5min/hourly/daily) |
| `cleanup.ts` | Prune old trash/completed/verified + orphaned attachments |
| `demo.ts` | `--demo:N` seed data |
| `skills.ts` | Generates `.claude/skills/hotsheet` + per-category `hs-{cat}` + Cursor/Copilot/Windsurf files |
| `feature-flags.ts` | `PLUGINS_ENABLED` (build-time, env fallback, browser-safe) |
| `keychain.ts` | macOS `security` / Linux `secret-tool` abstraction (no native deps) |
| `mime-types.ts` | Attachment MIME mapping |
| `open-in-file-manager.ts` | Platform-specific "Reveal in Finder/Explorer" |
| `gitignore.ts` | Ensure `.hotsheet/` is in `.gitignore` |
| `migrate-settings.ts` | Upgrade older settings.json shapes |
| `update-check.ts` | Version freshness check against npm |
| `test-helpers.ts` | `setupTestDb` / `cleanupTestDb` for unit tests |

### `src/routes/`

| File | Endpoints |
|---|---|
| `api.ts` | Composes all sub-routers + `/api/poll`, `/api/shutdown`, `/api/ensure-skills`, etc. |
| `tickets.ts` | `GET/POST/PATCH/DELETE /api/tickets[...]`, `/batch`, `/query`, `/duplicate`, `/restore`, `/up-next`, notes bulk/single |
| `attachments.ts` | `POST /api/tickets/:id/attachments`, `DELETE /api/attachments/:id`, `POST /:id/reveal`, `GET /api/attachments/file/*` |
| `settings.ts` | `/api/categories`, `/api/category-presets`, `/api/tags`, DB `/api/settings`, file `/api/file-settings`, `/api/gitignore` |
| `channel.ts` | `/api/channel/{status,trigger,heartbeat,claude-check,permission,permission/respond,permission/dismiss,permission/notify,done}` |
| `commandLog.ts` | `GET /api/command-log`, `DELETE /api/command-log`, `GET /api/command-log/count` |
| `dashboard.ts` | `/api/poll`, `/api/stats`, `/api/dashboard`, `/api/worklist-info`, `/api/browse`, `/api/global-config` |
| `plugins.ts` | `GET /api/plugins`, `/ui`, `:id/{action,validate,config,test}`, `/sync/manual`, conflicts, schedules, `global-config`, `image-proxy`, bundled install |
| `shell.ts` | `POST /api/shell/exec`, `/shell/kill`, `GET /api/shell/running` |
| `backups.ts` | `GET /api/backups`, `POST /api/backups/restore/:id`, preview flow |
| `projects.ts` | `/api/projects` register/list/unregister, reorder, per-project channel-status, `/api/projects/permissions` long-poll, `/api/projects/bell-state` long-poll (HS-6638 §24.3.3 — aggregates per-project `bellPending`) |
| `terminal.ts` | `GET /api/terminal/list` (includes `bellPending`), `/status`, `/restart`, `/kill`, `/create`, `/destroy`, `/clear-bell` (HS-6638 §24.3.2) |
| `notify.ts` | Shared long-poll + change-version bus (change / permission / bell waiter lists; HS-6638 added `bellVersion` + `addBellWaiter` + `notifyBellWaiters`) |
| `pages.tsx` | `GET /` server-rendered HTML |
| `validation.ts` | Zod schemas for body/query validation |
| `helpers.ts` | `parseIntParam`, header readers, etc. |

### `src/db/`

| File | Role |
|---|---|
| `connection.ts` | PGLite instance per dataDir, `initSchema()` — all `CREATE TABLE` + migrations live here |
| `queries.ts` | Aggregates/re-exports query helpers |
| `tickets.ts` | CRUD, filtering, batch, status transitions |
| `attachments.ts` | Attachment row ops |
| `notes.ts` | JSON-serialized notes; `note_id` generation |
| `tags.ts` | Normalization (lowercase), extraction from `[tag]` syntax |
| `settings.ts` | Plugin-scoped DB settings (`plugin:{id}:{key}`, `plugin_enabled:{id}`) |
| `commandLog.ts` | Shell + channel + permission log entries |
| `stats.ts` | Rolling daily snapshot for dashboard charts |
| `sync.ts` | `ticket_sync`, `sync_outbox`, `note_sync` accessors |

### `src/client/` (browser bundle)

**Entry + infra:** `app.tsx`, `api.tsx`, `state.tsx`, `dom.ts`, `icons.ts` + `lucide-icons.json`, `animate.ts`, `poll.tsx`, `xtermTheme.ts` (HS-6866 — shared `readXtermTheme()` used by the drawer terminal and both dashboard xterm instances; reads `--bg` / `--text` / `--accent` off `:root`), `bellPoll.tsx` (HS-6603 §24.4.1 cross-project bell long-poll against `/api/projects/bell-state`; exports `startBellPolling()`, `getBellState()`, `subscribeToBellState(cb)` — terminal.tsx subscribes to keep in-drawer indicators in sync), `shortcuts.tsx`, `tauriIntegration.tsx`, `projectTabs.tsx` (includes `updateProjectBellIndicators(bellStates)` + `.project-tab-bell` span injection for HS-6603 §24.4.2), `pluginTypes.ts`.

**List / rows / details:** `ticketList.tsx`, `ticketListState.ts`, `ticketRow.tsx`, `draftRow.tsx`, `detail.tsx`, `columnView.tsx`, `contextMenu.tsx`, `batch.tsx`, `dropdown.tsx`.

**Sidebar / search / nav:** `sidebar.tsx`, `customViews.tsx`, `dashboardMode.tsx`, `dashboard.tsx`, `share.tsx`.

**Tagging / notes / print / clipboard:** `tags.tsx`, `tagsDialog.tsx`, `tagAutocomplete.tsx`, `noteRenderer.tsx`, `print.tsx`, `clipboard.ts`, `clipboardUtil.tsx`, `imageProxy.tsx`.

**Settings / backups / icons:** `settingsDialog.tsx`, `settingsLoader.tsx`, `settingsCategories.tsx`, `experimentalSettings.tsx`, `iconPicker.tsx`, `backups.tsx`, `openFolder.tsx`.

**Dialogs / overlays:** `confirm.tsx` — `confirmDialog({message, title?, confirmLabel?, cancelLabel?, danger?}) → Promise<boolean>` in-app replacement for `window.confirm`, which is a silent no-op in Tauri WKWebView (always returns false without showing a dialog). Use this for every yes/no prompt.

**Channel / commands / feedback:** `channelUI.tsx`, `permissionOverlay.tsx` (permission popup, poll loop, HS-6637 minimize-to-pulsating-dot flow — exports `reopenMinimizedForSecret(secret)` called from the project tab click, `getMinimizedPermissionSecrets()` read by `updateStatusDots`; uses capture-phase outside-click handler so the owning-tab click minimizes without bouncing back open), `permissionPreview.ts` (`formatInputPreview(tool, raw)` — strips JSON wrapper off Claude's `input_preview`, with forgiving partial-JSON fallback for truncated Bash commands, HS-6634), `commandLog.tsx` (drawer shell, delegates `terminal:<id>` tabs; exports `previewDrawerTab(tab)` that returns a restorer — used by Settings → Terminal delete to reveal the doomed terminal before the confirm), `commandLogFilter.tsx`, `commandSidebar.tsx`, `commandEditor.tsx`, `feedbackDialog.tsx`.

**Terminal dashboard (HS-6272):** `terminalDashboard.tsx` + `terminalDashboardSizing.ts` (pure math: `tileWidthFromSlider(value, rootWidth)` for the HS-7031 manual size slider — linear interp 0..100 between `SLIDER_MIN_TILE_WIDTH` (~133 px) and `rootWidth`, `computeTileWidth()` retained for its existing tests but no longer called at runtime since HS-7031 replaced auto-fit with the explicit slider, `computeTileScale()` for per-tile xterm-root scale + explicit width/height per HS-6865, `computeTileGridDims()` (HS-7097 follow-up brought this back at runtime — see `tileNativeGridFromCellMetrics()` which wraps it so tile xterms resize to 4:3-native dims post-replay), `tileNativeGridFromCellMetrics(cellW, cellH)` (thin wrapper so tile-native intent reads clearly at call sites)) — Tauri-only second top-level view that displaces the ticket UI with a grid of every configured terminal across every registered project. HS-6832 (foundation): `initTerminalDashboard()` wires up `#terminal-dashboard-toggle` (lucide `square-terminal` since HS-7030 — was `layout-panel-left`, pre-rendered into `.app-header` before `#app-title-area` with `display:none`), the module-level `active` flag, `body.terminal-dashboard-active` class that CSS uses to hide the sidebar / header-controls / batch toolbar / detail panel / drawer / banners / footer, and Esc handling (skipped when a center-overlay or dedicated-view child is mounted so §25.7 / §25.8 can consume Esc first). `exitDashboard()` is called from `projectTabs.tsx`'s tab click handler so clicking any project tab auto-exits and navigates to the ticket view. HS-6833 (grid + sizing): on enter, fetches `/api/projects` then a per-project `/api/terminal/list` via `apiWithSecret()`, renders `<section>` per project with a heading + either a flex-wrap `.terminal-dashboard-grid` of tile skeletons or an empty-state row; `applyTileSizing()` picks a single global tile width via `computeTileWidth()` (pure module, iterates from 480 px down to the 100 px-preview-height floor of 133 px-width; honours viewport height; root vertical-scrolls when even the floor doesn't fit) and writes preview width/height inline on every tile so a resize observer can retune in-place. HS-6838 (placeholder spawn-on-enlarge): `/api/terminal/list` additionally annotates `exitCode` alongside `state`. Tiles whose state is `not_spawned` or `exited` render a `.terminal-dashboard-tile-placeholder-cold` inside the preview (big lucide `play` glyph + `Not yet started` or `Exited (code N)` status) and the dashboard DashboardTile record is still created so click handlers wire the same way as live tiles. Single-click on a placeholder → `spawnAndEnlarge(tile, 'center')`; double-click → `spawnAndEnlarge(tile, 'dedicated')`. `spawnAndEnlarge()` shows a "Starting…" placeholder, POSTs `/api/terminal/restart` if the tile was `exited` (lazy-unspawned terminals just open the WebSocket which triggers a spawn), flips the tile to `alive` (swaps class + mounts xterm + opens WebSocket), then transitions to the requested view. On failure the original placeholder is restored so the user can retry. HS-6837 (tile bell indicators): on dashboard enter, `subscribeToBellState` (from `bellPoll.tsx` §24) registers a callback that walks `liveTiles` on every long-poll tick; tiles whose terminalId appears in the bell state entry get `.has-bell` (bounce keyframe + 2 px accent outline); tiles that drop off the list have the class removed. `term.onBell` is also wired per-tile so same-project live bells fire the bounce immediately without waiting for the next tick. `clearTileBell(tile)` removes the class and fires `POST /api/terminal/clear-bell` — called from both `centerTile()` and `enterDedicatedView()`. Server's clear-bell wakes the bell-state long-poll so other windows / the project-tab indicator update promptly. HS-6836 (dedicated full-viewport view): double-click on a live tile calls `enterDedicatedView()` which appends a `.terminal-dashboard-dedicated` overlay to `#terminal-dashboard-root` (positioned absolute, z-index 400), renders a slim back-button bar (`lucide arrow-left` + `Project › Terminal` label), and mounts a NEW `XTerm` instance with `FitAddon` in the full body — separate from the grid tile's computed-cols × rows xterm. The dedicated xterm calls `fit.fit()` immediately and forwards `onResize` to a fresh WebSocket that DOES include `cols`/`rows` in the URL so the PTY can grow to match. HS-7063 (post-replay refit): the dedicated view's WS message handler uses `applyDedicatedHistoryFrame(term, fit, frame)` (from `terminalReplay.ts`) instead of `replayHistoryToTerm` directly — the replay's inner `term.resize(historyCols, historyRows)` fires xterm's `onResize` which gets relayed to the server and shrinks the PTY; without the follow-up `fit()` nano/vim/less stay at the drawer's dims and leave the bottom of the pane empty. Back button / Esc / dashboard-toggle-click all route through `exitDedicatedView()` which disposes the dedicated xterm + WebSocket, removes the overlay, and restores the prior state (grid OR whichever tile was centered before double-click). The grid tile's own fixed-cols-rows xterm is untouched — both instances attach to the same PTY so the dedicated view's fit() can't break the grid. Click/dblclick disambiguation uses a 220 ms single-click delay (`SINGLE_CLICK_DELAY_MS`) cancelled by dblclick — `e.detail` alone is unreliable because the centered tile's position shifts mid-gesture and confuses the browser's dblclick hit-testing. HS-6835 (click-to-center): single-click on a live tile centers it via `centerTile()` — adds `.centered` class, applies fixed position / `translate(-50%,-50%)` / z-index 500, resizes the preview to min(70 vw, 70 vh × 4/3) preserving the 4:3 aspect, re-runs `applyTileScale()` at the zoomed dims, and appends a `.terminal-dashboard-center-backdrop` (z-index 499 with a fade-in keyframe). `mountTileXterm()` wires `term.onData` to the tile's WebSocket so the centered tile accepts keystrokes. CSS drops `pointer-events:none` + the helper-textarea hide rule for `.centered` tiles so focus + input work. Dismissal: click backdrop (uses `uncenterTile()`), click same tile (toggle), Esc (document-level capture-phase keydown listener so it fires before xterm swallows the key — consumes Esc when a tile is centered and routes to `uncenterTile()` instead of `exitDashboard()`). `applyTileSizing()` persists `gridPreviewWidth` / `gridPreviewHeight` on the `DashboardTile` struct so `uncenterTile()` restores exactly the same grid dims without re-running the global sizer. HS-6834 (live tiles): `/api/terminal/list` extended to annotate every entry with `state: 'alive' | 'exited' | 'not_spawned'` so the client knows which tiles can safely WebSocket-attach. For `state === 'alive'` tiles `mountTileXterm()` creates a fresh `XTerm` instance at an initial `DASHBOARD_INITIAL_COLS × DASHBOARD_INITIAL_ROWS` (80 × 60 fallback) and calls `reapplyTileScaleFromPreview()` on the next rAF so the xterm's natural dims committed by the renderer get scaled into the preview. `connectTileSocket()` opens `/api/terminal/ws?project=&terminal=` WITHOUT `cols`/`rows` query params so the server skips the first-attach cleanup (HS-6799), then `replayHistoryToTerm()` resizes xterm to the history frame's cols × rows (= the PTY's real geometry) and writes the bytes so the scrollback renders at the geometry it was formatted for — and THEN (HS-7097 follow-up) the tile immediately resizes its xterm back down to tile-native 4:3 via `tileNativeDimsFromXterm(term, xtermRoot)` + `tileNativeGridFromCellMetrics(cellW, cellH)`. Those tile-native dims become the tile's `targetCols / targetRows` for the rest of the tile's lifetime, and the `.xterm-screen` ResizeObserver re-runs the scale pass when xterm commits the post-resize render. The xterm never runs `fit()` and the tile visually scales via `transform: scale(s)` only. `applyTileScale()` reads the authoritative natural size from the `.xterm-screen` child (xterm.js sizes that element to `cols × cellW` / `rows × cellH`, whereas the outer xterm root is a block-level wrapper that fills its parent horizontally and therefore mis-reports width as the tile width — root cause of HS-6931), then routes through `computeTileScale()` to apply a uniform `transform: scale(s)` + explicit inline `width` / `height` + an `absolute` left/top offset. HS-6997: `computeTileScale()` returns `left = horizontal-centered, top = 0` so the scaled xterm is top-aligned inside the preview — vertical dead space falls below the content (macOS-Terminal-style) rather than sandwiching it top-and-bottom, which was jarring for wide / short PTYs (e.g. 151 × 13). The preview background (HS-6866) matches xterm's theme background so the dead space is visually seamless with the canvas. HS-6865: without explicit dims xterm's absolutely-positioned `.xterm-viewport` collapses and the tile lays out wrong — `width` / `height` are set to the xterm's natural pixel size. HS-6931 (supersedes HS-6898): single uniform `scale(s) = min(tileW/naturalW, tileH/naturalH)`. The earlier two-axis `scale(scaleX, scaleY)` filled the 4:3 tile but stretched text enough to look distorted (a bad measurement against the block-level root also produced ~9× axis mismatches like `scale(3.478, 0.375)`). HS-6931's follow-up that resized xterm to a measured-cell 4:3 target (1280 × 960) was superseded by HS-6965 (see below) — stretching is gone, but letterboxing is accepted as the cost of correct wrapping. HS-6965 / HS-7097 follow-up (tile-native 4:3 dims, **PTY follows**): the `connectTileSocket` history handler first replays bytes at the PTY's cols × rows (so scrollback renders in its original geometry — HS-6965's original insight), resizes the tile's xterm back to tile-native 4:3 dims via `computeTileGridDims(measuredCellW, measuredCellH)`, AND sends a `'resize'` JSON message back over the WebSocket so the server-side PTY also moves to tile-native dims. The PTY-resize step is the load-bearing one — without it, a TUI like `nano` keeps drawing for the drawer's wide-short geometry and the tile's xterm shows nano's footer at row 14 of a 60-row buffer with rows 15-60 empty (HS-7097's "still wrong" screenshots). Pushing the PTY too makes nano `SIGWINCH`-redraw to fill the new geometry and the tile fills properly. Symmetric exit-path: `exitDedicatedView()` re-sends a `'resize'` with the tile's stored `targetCols × targetRows` so the PTY snaps back from the dedicated pane's geometry to the tile's after the dedicated view closes — without that, the tile would stay rendering bytes formatted for the dedicated pane until the next view-switch. E2E coverage: `e2e/terminal-dashboard-tile-rendering.spec.ts` configures a real PTY running a Python SIGWINCH-redraw fixture (`e2e/fixtures/terminal-draw.py`) and asserts the BOTTOM marker sits within 10 % of the preview bottom in grid / centered / dedicated views. HS-6964 (centered positioning): `centerTile()` also sets `tile.style.width = previewWidth` — without it, flex `align-items: center` slides the larger preview around the grid-slot-sized tile and the visual centre drifts away from the viewport centre. `applyTileSizing()` skips centered tiles on resize, and the dashboard resize handler calls `recenterTile()` so the centered overlay tracks the viewport centre across window resizes. Preview CSS width/height snap writes are done with `transition: none` + forced reflow in `centerTile`, `finishUncenterTile`, and `recenterTile` so the outer FLIP animation is the only grow/shrink animation running. The dedicated view's `fit.fit()` is wrapped in `requestAnimationFrame` + a per-body `ResizeObserver` so it doesn't measure pre-layout dims — xterm would otherwise stay at its default 80 cols and the pane would leave half the viewport empty. HS-6867 (grow-from-slot animation): `centerTile()` inserts a grey `.terminal-dashboard-tile-slot` placeholder of the tile's current grid size into the tile's slot before promoting it to the fixed-position overlay, so the surrounding tiles don't reflow. The tile is placed at its final centered geometry, then an inverse `translate(dx, dy) scale(sx, sy)` transform is applied without a transition to visually pin it at the placeholder, and in the next frame that transform is removed with a transition enabled — the browser interpolates the transform so the tile "grows" out of the slot. `uncenterTile()` runs the animation in reverse against the placeholder's current bounding box, then on `transitionend` (with a safety timeout) removes the placeholder and returns the tile to grid flow. HS-6868: while `body.terminal-dashboard-active` is set, the `.project-tab.active` highlight is suppressed via CSS — the dashboard is a cross-project view, so no project tab reads as "selected"; status dots and bell indicators are untouched. Both the grid-tile and the dedicated-view xterm instances pass `theme: readXtermTheme()` (HS-6866) so tile canvases pick up `--bg` / `--text` / `--accent` instead of xterm's default black palette — same helper the drawer terminal uses. Grid-view tiles are non-interactive (`pointer-events: none` on `.terminal-dashboard-tile-xterm`, helper textarea hidden). `teardownAllTiles()` disposes xterm + closes WebSockets on exit or project switch — PTYs are left alone. Lazy / exited tiles keep the placeholder stub; HS-6838 will replace that with a spawn-on-enlarge flow. Zoom / dedicated view, bell indicators, and placeholder spawn are owned by HS-6835 through HS-6838. HS-7096 (no animation on slider / window resize): the `.terminal-dashboard-tile-preview` CSS no longer transitions `width` / `height` — slider drags and window resizes must snap, not animate, or the xterm `transform: scale(..)` chases the animating preview box instead of matching it; the only size-change animation is the tile-root FLIP transform during center / uncenter. HS-7097 (rescale via `.xterm-screen` ResizeObserver — NOT a rAF chain): `mountTileXterm` installs a per-tile `ResizeObserver` on the `.xterm-screen` element and calls `reapplyTileScaleFromPreview(tile)` every time xterm's renderer commits new inline `width` / `height` (initial mount, post-`term.resize()`, font-load reflow, anything). Replaces the earlier two-rAF chain in `connectTileSocket`'s history handler, which raced xterm's own render scheduler and could fire while `.xterm-screen` still held pre-resize dims on first-history-after-mount. Observer is tracked on `DashboardTile.screenObserver` and disconnected in `disposeTile`. HS-7098 (dedicated-view padding + inner pane wrapper + flex-centered xterm): `.terminal-dashboard-dedicated-body` keeps `padding: 16px` (visual frame), xterm opens inside an inner `.terminal-dashboard-dedicated-pane` flex child with NO padding (so FitAddon's `getComputedStyle(parent).height / width` with the app-wide `box-sizing: border-box` reset sees the real available space — otherwise fit overcounts rows by `padding * 2 / cellHeight` and clips bottom content). Follow-up: the pane is itself a flex container with `align-items / justify-content: center` and its direct `.xterm` child uses `flex: 0 0 auto` — xterm shrinks to `.xterm-screen`'s content width (viewport / helpers are absolutely positioned, so they don't contribute to intrinsic width), and the sub-cell slop between `cols * cellW` and pane width becomes symmetric left/right padding instead of an asymmetric gap on the right. HS-7099 (REMOVED by HS-7097 follow-up): earlier policy resynced the grid tile's xterm to the dedicated view's fit dims — both live (on `term.onResize`) and as a safety net on `exitDedicatedView`. Removed because mirroring the dedicated pane's non-4:3 geometry onto the grid tile re-introduced the vertical-dead-space regression HS-7097 fixed. `tileResyncOnExitDedicated` is gone from `terminalDashboardSizing.ts`; the tile now stays at tile-native 4:3 for the whole dedicated-view lifecycle. HS-7129 (default slider value 33): `pages.tsx` starts `#terminal-dashboard-size-slider` at `value="33"` and the module-level `sliderValue` default is `33` — previous `50` produced tiles large enough that only 1–2 fit per row on a typical laptop, defeating the dashboard's "see every terminal at a glance" purpose. See docs/25-terminal-dashboard.md.

**Embedded terminal:** `terminal.tsx` (per-terminal tab state, xterm mount, WebSocket, stop/start power button, `onProjectSwitch` teardown so tabs rebuild per-project, `onTitleChange` → `runtimeTitle` and `onBell` → `hasBell` for HS-6473. `activateTerminal()` runs `doFit()` BEFORE `connect()` so the WebSocket URL (`?project=&terminal=&cols=N&rows=M`) carries the real pane geometry instead of xterm's default 80×24 — the server uses those dims for the eager-spawn first-attach cleanup (HS-6799). History-replay on subsequent attaches is delegated to `terminalReplay.ts`'s `replayHistoryToTerm(term, h)` which resizes xterm to the history's origin cols/rows BEFORE writing the bytes — writing at xterm's own 80×24 default followed by a resize leaves stray glyphs from wrapped escape sequences (HS-6799) — **only the in-pane terminal toolbar** tracks `runtimeTitle`; the drawer tab keeps its static configured/derived name so long per-cwd shell titles don't clutter the narrow tab (HS-6473 follow-up). Bell glyph wiggles on the drawer tab when the bell fires while the tab isn't active. HS-6603 Phase 2 seed: `loadAndRenderTerminalTabs()` reads the server-side `bellPending` field from `/api/terminal/list` entries and seeds `inst.hasBell` accordingly; a `subscribeToBellState` hook re-syncs the active project's in-drawer indicators on every bellPoll tick; `activateTerminal()` fires-and-forgets `POST /api/terminal/clear-bell` so the server-side flag drops. HS-6701: closing an alive dynamic tab (via × button, right-click → Close Tab, or Close Others / Close Tabs to the Left / Close Tabs to the Right) now routes through an in-app `confirmDialog` — single-tab flow reveals the target tab first; bulk flow shows a single "Stop all running terminals?" dialog listing the alive tab names. Tabs whose status is `exited` / `not-connected` still close silently. Tab context menu (HS-6470) also includes a **Rename...** entry (HS-6668) that opens `promptRenameTerminal(inst)` — a transient in-memory rename that updates `config.name` on the client instance but never persists to `settings.json`), `terminalsSettings.tsx` (settings outline list + edit modal for configured default terminals). Per-project drawer state (`drawer_open`, `drawer_active_tab`) persists in `settings.json` and is reapplied by `commandLog.applyPerProjectDrawerState` on project switch and on initial load.

**Plugins:** `pluginSettings.tsx`, `pluginConfigDialog.tsx`, `pluginUI.tsx`.

**Undo stack:** `undo/{stack.ts,actions.ts,types.ts}`.

**Constants:** `constants/{timers.ts,unicode.ts}`.

**Styling:** `styles.scss` (single entry; see conventions — split into partials as it grows).

**Assets:** `assets/` — app icon PNGs (`icon-default.png`, `icon-variant-1..9.png`, plus `glassbox-icon.png`).

### `src/plugins/`, `src/sync/`, `src/terminals/`, `src/components/`, `src/utils/`

- `plugins/{types.ts,loader.ts,syncEngine.ts}` — plugin API types, discovery/activation, bi-directional sync.
- `sync/markdown.ts` — debounced export of `worklist.md` / `open-tickets.md`.
- `terminals/` — embedded terminal backend (see `docs/22-terminal.md`):
  - `config.ts` — `TerminalConfig` type, `listTerminalConfigs` (reads `settings.terminals`, migrates legacy `terminal_command`/`terminal_cwd`), `findTerminalConfig`.
  - `eagerSpawn.ts` — `eagerSpawnTerminals(secret, dataDir)` spawns every `lazy:false` configured terminal via `ensureSpawned`. Called from `cli.ts` at project registration and from `/file-settings` PATCH when `terminals` changes.
  - `resolveCommand.ts` — resolves the chosen terminal's command template (`{{claudeCommand}}` substitution) + cwd; accepts optional `terminalId` and a `configOverride` for dynamic terminals.
  - `ringBuffer.ts` — FIFO byte buffer capped at a max size for scrollback.
  - `registry.ts` — `TerminalRegistry` keyed by `${secret}::${terminalId}`; lazy node-pty spawn, subscriber broadcast, restart / kill / destroy lifecycle, `ensureSpawned` (no-subscriber spawn for eager mode), `listProjectTerminalIds`, `destroyProjectTerminals`. Each session has a `hasBeenAttached` flag (HS-6799): on the first real attach to an eager-spawned PTY that provides client dims, `attach()` resizes the PTY to those dims, clears the scrollback ring buffer, and writes `\x0c` (Ctrl-L) to the PTY so the shell redraws its prompt at the right geometry — the 80×24 startup output is otherwise replayed into a wider pane and leaves stray glyphs at the top. Session also carries a `bellPending` flag (HS-6638 §24.2): the PTY `onData` handler runs an OSC-aware `scanForRealBell(session, chunk)` that tracks OSC/DCS/APC/PM/SOS string state across chunks so `\x1b]0;TITLE\x07` title updates, OSC 7 cwd updates, etc. don't trip the bell (HS-6766). Helpers `getBellPending`, `clearBellPending`, `listBellPendingForProject` expose it to the route layer; `restartTerminal` resets both the flag and the OSC-scan state. `setPtyFactory` for tests.
  - `websocket.ts` — `wireTerminalWebSocket(httpServer)` attaches a `ws.Server` (noServer mode) to the Node HTTP server; authenticates upgrade by project secret and parses `?terminal=<id>&cols=N&rows=M`; bridges ws ⇄ registry per terminalId. Client dims from the URL are forwarded into `attach()` so the PTY can be spawned/resized to match before the history frame is sent (HS-6799).
  - Registered HTTP routes live in `src/routes/terminal.ts` (`/api/terminal/list` — now includes `bellPending` per entry, `/status`, `/restart`, `/kill`, `/create`, `/destroy`, `/clear-bell`). WebSocket endpoint is `/api/terminal/ws?project=<secret>&terminal=<id>`. Cross-project bell aggregation is exposed via `/api/projects/bell-state` (long-poll) in `src/routes/projects.ts`.
- `components/layout.tsx` — the server HTML shell.
- `utils/{escapeHtml.ts, errorMessage.ts}` — small shared helpers.

### Out-of-src

- `plugins/{github-issues,demo-plugin}/` — bundled plugins (each has `src/` + `manifest.json`).
- `e2e/` — Playwright specs (lifecycle, plugins, sync-*, channel, columns, keyboard, etc.) + `coverage-fixture.ts`.
- `src-tauri/` — Rust Tauri v2 wrapper: `src/{main.rs,lib.rs}`, `capabilities/{default,remote-localhost}.json`, `icons/`, `resources/` (CLI launchers), `binaries/` (Node sidecar), `server/` (bundled app).
- `docs/` — requirements (see `docs/ai/requirements-summary.md` for a synthesized view).
- `dist/` — build output (`cli.js`, `channel.js`, `client/{app.global.js,styles.css,assets/}`, `plugins/*`).

---

## 4. API routes catalog

All API calls require header `X-Hotsheet-Secret: <settings.secret>` for non-localhost or mutating requests. Mutation requests may include `X-Hotsheet-User-Action: true` to bump `last_read_at` (controls the unread dot).

**Tickets:** `GET /api/tickets` (filters: category, priority, status, up_next, search, sort_by, sort_dir; composite status: `open`, `non_verified`, `active`); `POST /api/tickets`; `GET|PATCH|DELETE /api/tickets/:id`; `DELETE /api/tickets/:id/hard`; `POST /:id/restore`; `POST /:id/up-next`; `POST /api/tickets/batch`; `POST /api/tickets/duplicate`; `POST /api/tickets/query` (custom views).

**Notes:** `PUT /api/tickets/:id/notes-bulk`, `PATCH|DELETE /api/tickets/:id/notes/:noteId`.

**Attachments:** `POST /api/tickets/:id/attachments`; `DELETE /api/attachments/:id`; `POST /api/attachments/:id/reveal`; `GET /api/attachments/file/*`.

**Settings:** `GET|PUT /api/categories`, `GET /api/category-presets`, `GET /api/tags`, `GET|PATCH /api/settings` (DB, plugin-only), `GET|PATCH /api/file-settings`.

**Dashboard/poll:** `GET /api/poll` (long-poll), `/api/stats`, `/api/dashboard`, `/api/worklist-info`, `/api/browse`, `/api/global-config`.

**Channel / MCP:** `GET /api/channel/status`, `POST /api/channel/trigger`, `GET /api/channel/heartbeat`, `GET /api/channel/claude-check`, `GET /api/channel/permission`, `POST /api/channel/permission/{respond,dismiss,notify}`, `POST /api/channel/done`.

**Command log:** `GET|DELETE /api/command-log`, `GET /api/command-log/count`.

**Shell:** `POST /api/shell/exec`, `POST /api/shell/kill`, `GET /api/shell/running`.

**Terminal:** `GET /api/terminal/list`, `GET /api/terminal/status`, `POST /api/terminal/restart`, `POST /api/terminal/kill` (body `{ signal?, terminalId? }`), `POST /api/terminal/create`, `POST /api/terminal/destroy`. WebSocket upgrade at `/api/terminal/ws?project=<secret>&terminal=<id>`.

**Plugins:** `GET /api/plugins`, `GET /api/plugins/ui`, `POST /api/plugins/:id/{action,validate,config,test}`, `PATCH /api/plugins/:id/config`, `POST /api/plugins/sync/manual`, `GET /api/plugins/:id/conflicts`, `POST /api/plugins/:id/conflicts/:cid/resolve`, `PATCH /api/plugins/global-config`, `GET|POST|DELETE /api/plugins/schedules[...]`, `POST /api/plugins/bundled/:id/install`, `GET /api/plugins/:id/image-proxy`.

**Backups:** `GET /api/backups`, `POST /api/backups/restore/:id` (with preview flow).

**Projects (multi-project):** `GET|POST /api/projects`, `DELETE /api/projects/:secret`, `GET /api/projects/:secret`, reorder.

**Server control:** `POST /api/shutdown`.

**Static/HTML:** `GET /` (page), `GET /static/app.js`, `GET /static/styles.css`, `GET /static/assets/*`.

---

## 5. Database schema

Schema lives in one place: `src/db/connection.ts` `initSchema()` function — all `CREATE TABLE` + additive `ALTER TABLE IF NOT EXISTS` migrations go there.

| Table | Key columns | Notes |
|---|---|---|
| `tickets` | `id SERIAL PK`, `ticket_number TEXT UNIQUE`, `title`, `details`, `category`, `priority`, `status`, `up_next BOOL`, `created_at/updated_at/completed_at/deleted_at/verified_at TIMESTAMPTZ`, `notes TEXT` (JSON array), `tags TEXT` (JSON array), `last_read_at TIMESTAMPTZ` | `idx_tickets_status`, `idx_tickets_up_next` |
| `ticket_seq` | sequence starting 1 | Source of `HS-N` ticket numbers |
| `attachments` | `id`, `ticket_id (FK→tickets CASCADE)`, `original_filename`, `stored_path`, `created_at` | `idx_attachments_ticket` |
| `settings` | `key TEXT PK`, `value TEXT` | **Plugin-only.** Project/app config moved to `.hotsheet/settings.json`. Plugin keys: `plugin:{id}:{key}`, `plugin_enabled:{id}` |
| `stats_snapshots` | `date TEXT PK`, `data TEXT` (JSON) | Dashboard historical charts |
| `command_log` | `id`, `event_type`, `direction`, `summary`, `detail`, `created_at` | `idx_command_log_created`. Capped at ~1000 entries. Event types: `trigger`, `done`, `permission_request`, `shell_command` |
| `ticket_sync` | `ticket_id (FK)`, `plugin_id`, `remote_id`, `last_synced_at`, `remote_updated_at`, `local_updated_at`, `sync_status`, `conflict_data`. UNIQUE(ticket_id, plugin_id) | Indexes on plugin_id, sync_status, (plugin_id, remote_id) |
| `sync_outbox` | `ticket_id`, `plugin_id`, `action` (`create`/`delete`), `field_changes`, `attempts`, `last_error` | 5+ failed attempts → permanent removal |
| `note_sync` | `ticket_id`, `note_id`, `plugin_id`, `remote_comment_id`, `last_synced_at`, `last_synced_text`. UNIQUE(ticket_id, note_id, plugin_id) | `last_synced_text` = baseline for three-way merge |

All timestamp columns are `TIMESTAMPTZ` (older DBs migrated in place).

---

## 6. Client bundle & globals

- **Single IIFE:** `dist/client/app.global.js` built from `src/client/app.tsx`. IIFE format, ES2020 target, minified.
- **Styles:** `dist/client/styles.css` compiled from `src/client/styles.scss`.
- **Assets:** `dist/client/assets/*` (icons, lucide JSON).
- **Globals:** the client does not currently expose a stable `window.*` API. State is module-local in `src/client/state.tsx`; `window.__TAURI__` is used only in Tauri builds.
- **JSX in client:** always use `toElement(<…/>)` from `src/client/dom.ts` to get real DOM nodes. Never call `document.createElement` directly. For `innerHTML` strings, use `<…/>.toString()`.

---

## 7. Plugin system (`src/plugins/`)

- **Feature flag:** `PLUGINS_ENABLED` in `src/feature-flags.ts` (default true; browser-safe via global fallback).
- **Install location:** `~/.hotsheet/plugins/<id>/` (global, user-wide). Bundled plugins under `plugins/*` are copied there by `installBundledPlugins()` on startup if missing or outdated; dismissed plugins tracked in `~/.hotsheet/dismissed-plugins.json`.
- **Manifest:** `manifest.json` (or `package.json#hotsheet`). Fields: `id`, `name`, `version`, `description?`, `author?`, `entry?`, `icon?` (inline SVG), `preferences?`, `configLayout?`.
- **Preferences:** `{ key, label, type: string|boolean|number|select|dropdown|combo, default?, description?, required?, secret?, scope?: "global"|"project", options? }`. `secret:true` routes through the keychain (`src/keychain.ts`) with dual-write file fallback.
- **Entry exports:** `activate(ctx)`, `onAction(actionId, ctx)`, `validateField(key, value)`.
- **PluginContext:** `config`, `log(level,msg)`, `getSetting/setSetting`, `registerUI(elements)`, `updateConfigLabel(id, text, color?)`.
- **TicketingBackend:** `id`, `name`, `capabilities` (create/update/delete/incrementalPull/comments/syncableFields), `fieldMappings` (category/priority/status toRemote+toLocal), CRUD (`createRemote/updateRemote/deleteRemote`), sync (`pullChanges(since)`, `getRemoteTicket?`), status (`checkConnection`, `getRemoteUrl?`, `shouldAutoSync?`), comments (`getComments/createComment/updateComment/deleteComment`), attachments (`uploadAttachment?`).
- **UI extensions:** 8 locations — `toolbar`, `status_bar`, `sidebar_actions_top`, `sidebar_actions_bottom`, `detail_top`, `detail_bottom`, `batch_menu`, `context_menu`. Element types: `button`, `link` (rendered); `toggle`, `switch`, `segmented_control` (declared, not yet rendered).
- **Sync engine (`syncEngine.ts`):** push via direct-compare (`ticket.updated_at` vs `sync.local_updated_at`); pull via `pullChanges(since)`; comments via three-way merge using `note_sync.last_synced_text`; attachments uploaded, then posted as markdown link.
- **Bundled plugins:** `plugins/github-issues/` (real backend), `plugins/demo-plugin/` (exercises every surface — see `docs/19-demo-plugin.md`).
- **Plugin image proxy:** `GET /api/plugins/:id/image-proxy` — proxies private-repo images with stored PAT.

---

## 8. Channel / MCP (`src/channel.ts`)

- **Version:** `CHANNEL_VERSION = 3`. `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts` must match. Bump **both** when changing the channel HTTP surface or MCP behavior.
- **Launch paths:** production = `node dist/channel.js --data-dir <path>`; dev = `npx tsx src/channel.ts`. Both are registered in `.mcp.json` by `src/channel-config.ts`.
- **Transport:** stdio (MCP) to Claude Code + a local HTTP port (written to `.hotsheet/channel-port`).
- **Channel HTTP:** `/health`, `/permission` (120s expiry), `POST /permission/respond`, `POST /permission/dismiss`.
- **Hot Sheet ↔ Channel:** Hot Sheet `/api/channel/trigger` POSTs to the running channel; Hot Sheet polls `/api/channel/permission` (long-poll) for pending Claude tool-use approvals.
- **Status / auto mode:** sidebar play button (see `src/client/channelUI.tsx`). Heartbeat hooks installed into `~/.claude/settings.json` by `src/claude-hooks.ts` (PostToolUse/UserPromptSubmit/Stop).
- **Worklist file:** `src/sync/markdown.ts` builds `.hotsheet/worklist.md` with curl examples the AI session can run; `src/skills.ts` maintains the `.claude/skills/hotsheet` skill.

---

## 9. Tauri desktop (`src-tauri/`)

- **Layout:** `src/{main.rs,lib.rs}` (minimal stub + app setup), `tauri.conf.json`, `Cargo.toml`, `Entitlements.plist`, `capabilities/{default,remote-localhost}.json`, `icons/`, `resources/` (per-platform CLI launchers), `binaries/` (bundled Node), `server/` (bundled JS + assets).
- **Sidecar model:** Node.js is packaged as a sidecar because PGLite (WASM) needs filesystem access — single-binary compilation breaks it. Tauri either (a) connects to a pre-started server via `HOTSHEET_SERVER_URL` env, or (b) spawns the sidecar and waits for `running at` on stdout.
- **Commands exposed to JS:** `quicklook`, `open_folder`, `set_app_icon`, `install_cli`, `check_cli_installed`, `check_for_update`, `install_update`, `get_pending_update`, `request_attention[_once]`, `open_url`, `pick_folder`, `open_project`.
- **Icon variants:** 9 `.icns` files in `src-tauri/icons/variants/`; runtime change via `set_app_icon` using `NSApplication.setApplicationIconImage()` on macOS; `Window::set_icon()` on Windows/Linux.
- **Updates:** GitHub Releases, signed, verified against `plugins.updater.pubkey` in `tauri.conf.json`.

---

## 10. Build system

From `tsup.config.ts` + `package.json` scripts:

- `npm run build` → tsup builds three ESM outputs: server (`src/cli.ts` → `dist/cli.js`, externals: pglite, hono, @hono/node-server), channel (`src/channel.ts` → `dist/channel.js`, fully bundled), client (`src/client/app.tsx` → `dist/client/app.global.js` IIFE minified) + SCSS → `dist/client/styles.css` + asset copy + **append `node_modules/@xterm/xterm/css/xterm.css`** to `styles.css` (HS-6799: without this, the Tauri sidecar bundle ships a styles.css missing xterm's helper-textarea / viewport positioning rules).
- `npm run build:client` — client bundle + SCSS + assets only (used by `dev`). Also appends xterm.css to styles.css.
- `npm run build:plugins` — loops `plugins/*` and emits into `dist/plugins/*` with `manifest.json` copied.
- `npm run dev` — `build:client` + `build:plugins` + `tsx src/cli.ts`.
- `npm run tauri:dev` / `npm run tauri:build` — Tauri dev window / release package.

Env flags: `PLUGINS_ENABLED` (build/runtime toggle), `NO_WEB_SERVER` (E2E), `NODE_V8_COVERAGE` (coverage collection).

---

## 11. Testing

- **Unit tests** (`src/**/*.test.ts`): vitest, `pool: 'forks'`, coverage via `@vitest/coverage-v8`. Use `setupTestDb`/`cleanupTestDb` from `src/test-helpers.ts`.
- **E2E tests** (`e2e/*.spec.ts`): Playwright Chromium. Each spec spawns a real Hot Sheet server with a temp data dir. Coverage collected via `NODE_V8_COVERAGE` (server) + `page.coverage.startJSCoverage()` (browser), source-mapped back to `.tsx` sources. See `e2e/coverage-fixture.ts`.
- **Plugin tests** (`plugins/*/src/*.test.ts`): excluded from default `npm test`; run via `test:all-including-plugins` or directly.
- **CI scripts:** `test:fast` / `test:e2e:fast` exclude live GitHub integration tests. Full `test:e2e` requires local GitHub creds.
- **Manual test plan:** `docs/manual-test-plan.md` — anything not reliably automatable (drag-and-drop, platform specifics, Tauri, visual styling, Claude Channel UI).

---

## 12. Settings & config locations

**Per-project (`.hotsheet/`):**
- `settings.json` — reserved: `appName`, `appIcon`, `backupDir`, `ticketPrefix`, `secret`, `secretPathHash`, `port`. User: `categories`, `custom_views`, `custom_commands`, `auto_context`, `auto_order`, `terminals` (defaults to `[]` per HS-6337 — no implicit default terminal), `terminal_scrollback_bytes`, `drawer_open`, `drawer_active_tab`, layout/position/widths, etc. The legacy `terminal_enabled` key is ignored on read (removed in HS-6337 when terminals moved to a dedicated Tauri-only Settings tab). JSON-typed keys (e.g. `terminals`, `custom_views`, `custom_commands`, `auto_context`, `categories`) are stored as native JSON arrays/objects, not stringified — `/api/file-settings` PATCH uses `UpdateFileSettingsSchema = z.record(z.string(), z.unknown())` to accept native values.
- `db/` — PGLite database files.
- `attachments/` — uploaded files.
- `backups/{5min,hourly,daily}/` — tar.gz DB snapshots.
- `worklist.md`, `open-tickets.md` — AI-facing markdown exports (auto-generated; do not edit).
- `hotsheet.lock` — single-instance lock (pid/startedAt).
- `channel-port` — channel server's HTTP port (when running).

**Global (`~/.hotsheet/`):**
- `config.json` — `channelEnabled`, `shareTotalSeconds`, `shareLastPrompted`, `shareAccepted`.
- `instance.json` — running instance PID + port (for single-instance mode + multi-project join).
- `projects.json` — registered projects (secret → dataDir).
- `plugins/` — installed plugins.
- `dismissed-plugins.json` — plugins the user has dismissed.

**Claude/AI:** `~/.claude/settings.json` (heartbeat hooks managed by `src/claude-hooks.ts`), `.mcp.json` (channel registration managed by `src/channel-config.ts`), `.claude/skills/hotsheet/SKILL.md` + `.claude/skills/hs-{category}/SKILL.md` (generated by `src/skills.ts`; versioned via `<!-- hotsheet-skill-version: N -->`).

---

## 13. Where do I look for X — reverse index

| Want to… | Edit |
|---|---|
| Add a new HTTP endpoint | A file under `src/routes/`, register it in `src/routes/api.ts`; add a Zod schema in `src/routes/validation.ts` if it takes a body |
| Add/alter a DB column | `initSchema()` in `src/db/connection.ts` (use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for migrations); update `src/types.ts` `Ticket`; update the relevant query helper in `src/db/*.ts` |
| Add a ticket category preset | `DEFAULT_CATEGORIES` / `CATEGORY_PRESETS` in `src/types.ts` |
| Add a client UI module | New `src/client/foo.tsx`, import and wire from `src/client/app.tsx` |
| Add a keyboard shortcut | `src/client/shortcuts.tsx` |
| Add a filter or sort option | `TicketFilters` in `src/types.ts`, query param in `src/routes/tickets.ts`, UI in `src/client/sidebar.tsx` |
| Add a dashboard metric | `src/db/stats.ts` + `src/routes/dashboard.ts` + `src/client/dashboard.tsx` |
| Add a skill or change its text | `src/skills.ts` — bump the `hotsheet-skill-version` header so skills regenerate |
| Change the worklist export | `src/sync/markdown.ts` (debounced) |
| Add/change an MCP endpoint | `src/channel.ts` **and** bump `CHANNEL_VERSION` + `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts` |
| Add a Tauri native command | `src-tauri/src/lib.rs` (new `#[tauri::command]`), invoke from `src/client/tauriIntegration.tsx` |
| Add a plugin UI location or element type | Extend `PluginUILocation` / element types in `src/plugins/types.ts`; render in `src/client/pluginUI.tsx` |
| Add a plugin sync capability | Extend `TicketingBackend` in `src/plugins/types.ts`; handle in `src/plugins/syncEngine.ts`; add DB columns via `initSchema()` if needed |
| Add a channel event type | `src/channel.ts` (MCP), `src/routes/channel.ts` (HTTP), `src/db/commandLog.ts` (log), `src/client/commandLog.tsx` (UI) |
| Add a setting to `settings.json` | `src/file-settings.ts` (reserved-key filter if needed), read where you need it; for UI, `src/client/settingsDialog.tsx` tabs |
| Add a global config field | `src/global-config.ts` + `src/routes/dashboard.ts` (`/api/global-config`) |
| Add an auto-cleanup rule | `src/cleanup.ts` |
| Add a backup tier / policy | `src/backup.ts` |
| Add a Claude hook | `src/claude-hooks.ts` |
| Change the keychain fallback | `src/keychain.ts`; plugin integration in `src/plugins/loader.ts` |
| Add an E2E test | `e2e/<topic>.spec.ts` — start real server with a temp data dir, prefer real interactions over mocks |

---

## 14. Conventions that aren't obvious from the code

- **One primary export per file.** Private helpers live alongside.
- **`.js` extensions on imports** (TS ESM requirement).
- **No ORM** — raw PGLite `query()` with parameterized placeholders.
- **Server-rendered shell, client-enhanced UI.** Initial HTML comes from `pages.tsx`; the IIFE hydrates interactivity.
- **All styles in one SCSS entry** (`styles.scss`). Split into `_partial.scss` files by concern when it grows.
- **Never `document.createElement` in client code** — use `toElement(<…/>)`.
- **Never commit automatically** (see CLAUDE.md — non-negotiable).
- **`CHANNEL_VERSION` mismatch is a user-visible warning.** The server compares the running channel's version against `EXPECTED_CHANNEL_VERSION` and tells the user to reconnect via `/mcp`. Always bump both.
- **Ticket numbers never reuse** even after deletion (sequence-backed).
- **Debounces:** worklist 500 ms, open-tickets 5 s, detail panel auto-save 300 ms, command log search 300 ms.

---

## 15. Ticket categories (canonical)

`issue` / `bug` / `feature` / `requirement_change` / `task` / `investigation`. Priorities: `highest` / `high` / `default` / `low` / `lowest`. Statuses: `not_started` / `started` / `completed` / `verified` / `backlog` / `archive` / `deleted`. Composite filter values: `open` (= not_started+started), `non_verified` (= open+completed), `active` (excludes deleted/backlog/archive).

---

## 16. Related reading

- **Requirements synthesis:** `docs/ai/requirements-summary.md` (sibling file; read together).
- **Project-level conventions:** `/CLAUDE.md` (repo root).
- **Requirements docs:** `docs/1-overview.md` … `docs/21-feedback.md` + `docs/plugin-development-guide.md`, `docs/tauri-architecture.md`, `docs/tauri-setup.md`, `docs/manual-test-plan.md`, `docs/testing/*`.

---

## 17. Maintenance rules

**Update this document in the same change whenever any of these triggers fire:**

1. **New file or subdirectory under `src/`** — add it to §3.
2. **New route file or endpoint** — update §3 and §4.
3. **Schema change** (new table, column, or index in `src/db/connection.ts`) — update §5.
4. **New event type** in `command_log` or channel — update §5 / §8.
5. **New client module** under `src/client/` — add to §3.
6. **New bundle output** in `tsup.config.ts` — update §10.
7. **New plugin UI location, preference type, or `TicketingBackend` method** — update §7.
8. **Channel protocol change** (new endpoint / tool / capability) — update §8 and bump both `CHANNEL_VERSION` and `EXPECTED_CHANNEL_VERSION`.
9. **New Tauri `#[tauri::command]`** — update §9.
10. **New `.hotsheet/` or `~/.hotsheet/` file** — update §12.
11. **New setting key** exposed to plugins or users — update §12.

Prefer a *small, targeted* edit over a rewrite. The point of this document is that it stays approachable — keep it a map, not a replica of the code.
