# 25. Terminal dashboard view (HS-6272)

## 25.1 Overview

The **Terminal Dashboard** is a second top-level view for Hot Sheet (the first being the normal per-project ticket view). When active, the ticketing UI is hidden and the entire content area becomes a read-and-peek grid of every configured terminal across every registered project — all scaled down to fit, color-accurate, live. Click a tile to enlarge it in place; double-click to enter a dedicated full-viewport terminal view. The dashboard is an interaction shortcut on top of the existing embedded-terminal feature (see [22-terminal.md](22-terminal.md)) — it does not spawn, persist, or own any terminal state. Every terminal is the same `TerminalSession` that the normal drawer tabs attach to.

**Core promises:**

1. One glanceable screen that surfaces _what every terminal is currently showing_, across every registered project.
2. No new server-side state and no duplicate PTYs. Attachments are just additional `TerminalSubscriber`s against the existing registry.
3. Lazy terminals stay cold — the dashboard never forces a spawn on its own; spawns only happen when the user enlarges a tile.
4. Bell indicators from [24-cross-project-bell.md](24-cross-project-bell.md) surface here too, with a more prominent tile-level affordance (bounce + outline) that persists until the user actually looks at the terminal.
5. Tauri-only (like §22).

## 25.2 Entry point and app-header chrome

A new iconic toggle button sits **before the first project tab** in the top toolbar, using the Lucide `layout-panel-left` glyph. It is identified as `#terminal-dashboard-toggle`. The button:

- Shows only when Hot Sheet is running inside Tauri (same gate as the embedded-terminal feature, §22.11). In a plain browser context the button is not rendered at all.
- Has a pressed/active visual state when the dashboard is open, matching the existing toolbar-toggle style (accent-border, accent-tinted background).
- Toggles the dashboard on and off.

**Chrome visibility while dashboard mode is active.** Exactly two elements in the top toolbar remain visible:

1. The `#terminal-dashboard-toggle` button (so the user can exit).
2. The project-tab strip (so the user can navigate to a specific project's ticket view).

Everything else in the top toolbar — search, layout toggles, Settings button, help icon, any plugin-contributed toolbar extensions (see [18-plugins.md](18-plugins.md) §18 `toolbar` location), and the Claude-channel play/status cluster — is hidden. The footer status bar, ticket sidebar, list/column/kanban ticket area, right-side detail panel, and per-project bottom drawer (Commands Log + terminal tabs) are all hidden as well. The dashboard owns the entire content area below the slim header.

**State scope.** "Dashboard active" is a single global UI flag (module-level in the client, not persisted to settings in v1). It survives in-session navigation but resets to off on page reload / Tauri window reopen. No per-project state.

## 25.3 Exit paths

The dashboard can be dismissed four ways — each route closes the dashboard and restores whatever view the user was looking at before:

1. **Click the toggle button again.** The button's pressed state clears; the normal ticket view re-appears.
2. **Press Esc** anywhere except inside an enlarged (centered or dedicated) terminal view — those consume Esc first to collapse back to the grid (see §25.7 and §25.8). Esc on the bare grid exits the dashboard.
3. **Click any project tab.** This automatically exits the dashboard **and** activates the clicked project's normal ticket view — a single-click shortcut to "jump to project X's tickets". The currently-active project before entering the dashboard is preserved; clicking that project's tab is equivalent to #1 above.
4. **Future follow-up:** a keyboard shortcut to toggle the dashboard directly is deliberately out of scope for v1 (HS-6272 feedback J). Re-open in a follow-up if it becomes missed in practice.

There is no "lingering dashboard" state — every exit path fully dismisses it.

## 25.4 Layout: per-project sections in a scrollable column

The dashboard content area is a single vertically-scrolling flex column. For every registered project (in the same left-to-right order as the project-tab strip):

```
[Project Heading: "My App"]
[ [tile] [tile] [tile] [tile] ]
[ [tile] [tile]               ]

[Project Heading: "Other Project"]
[ [tile] [tile] [tile]         ]
```

**Project heading.** A row above each project's grid, showing:
- The project's `appName` (falls back to the project folder name — same resolution as the project tab's label).
- Optionally, a small count suffix like `(3 terminals)` when the project has ≥ 1 terminal.

The heading is text-only, left-aligned, and does not participate in the grid sizing calculation — its height is additive to the grid.

**Grid.** Each project's terminals are laid out in a flex-wrap row. Every tile is identically sized and strictly 4:3 (see §25.5). Tiles wrap to the next visual row when they exceed the viewport width.

**Terminal title centered below each tile.** Each tile is a composite `[preview area][title label]` stack. The title row sits **below** the preview area, center-aligned, and resolves to the same name the drawer tab would show (configured `name`, else derived basename — see `effectiveTabLabel` in §22 / §23). The runtime title from an OSC 0/2 title escape is _not_ used here — terminal-set titles can be long and per-cwd noisy, and the dashboard wants stable labels for recognition. The label row adds its own fixed height (e.g. 20 px + small margin) on top of the tile's preview area.

**Global tile sizing.** The layout picks one size that applies to every tile in every project:

- The tile's **preview area** (the xterm canvas region) is strictly `4:3`.
- The **minimum preview-area height is 100 px** (HS-6272 feedback B). Below that, the content becomes unreadable.
- The tile's preview-area height is chosen as the largest multiple of the 4:3 constraint such that **every tile in every project fits within the current viewport height** (minus the slim header, project headings, label rows, and inter-section gaps) and **the tile preview width fits within the viewport width for the narrowest project row**. In practice the sizer iterates candidate widths from largest to smallest, respecting the 100 px floor.
- If even at 100 px the full content does not fit the viewport height, **the content area vertical-scrolls**. This is the only scroll direction; horizontal overflow wraps tiles to new rows within the same project section.
- The sizing recomputes on window resize (throttled) and on project list / terminals list changes.

All tile preview areas share one computed size — users can compare terminals across projects at a glance.

## 25.5 Tile contents and the scale-transform trick

Each live (alive) terminal tile renders an xterm.js canvas grid set to a **fixed 80 columns × 60 rows** (HS-6272 feedback C — 4:3). These dimensions never change in dashboard mode regardless of the tile's on-screen size — only a CSS `transform: scale(s)` is applied to the xterm root so the 80×60 grid visually fits the preview area. The `scale` factor is computed as `tilePreviewWidthPx / xtermNaturalWidthPx` (equivalently, `tilePreviewHeightPx / xtermNaturalHeightPx` — the 4:3 constraint keeps both equal).

**Why 80×60 and not `fit()` to the pixel size of the tile?** The dashboard is a _peek_ view. Resizing the PTY to the tile's actual cell count would:

1. Cause a cascade of PTY `resize` messages whenever the user dragged the window or swapped projects, polluting scrollback.
2. Break the shared-session guarantee — other attachers (the normal drawer, other Tauri windows) would see their terminals reflow whenever the dashboard opened.
3. Leave eager-spawned terminals at a tiny geometry that would clobber their subsequent first-attach cleanup (HS-6799).

Instead: the xterm instance is kept at 80×60, the PTY is kept at whatever size the primary drawer attachment set (or the eager default, or the first-attach cleanup size), and the dashboard tile is a pure visual mirror. The PTY bytes are replayed from scrollback on attach, then flow live. If the PTY is 120 cols wide and xterm in the tile is 80 cols wide, lines wrap inside xterm — acceptable for the peek use case; users open the dedicated view (§25.8) for proper inspection.

**Focus, input, and interaction in grid view.** Tiles in grid view are **non-interactive** — they do not accept keyboard input and do not show a cursor-focus ring. Pointer events on the tile only trigger the click / double-click handlers in §25.7 and §25.8.

**Scrollback on attach.** Because this is a fresh xterm instance per tile, the first attach receives the standard `history` frame (see §22.7) and replays it. Replay uses `replayHistoryToTerm` from `src/client/terminalReplay.ts` (HS-6799). No new server-side code is required.

**Attach lifecycle.**
- Opening the dashboard: for every terminal that is `alive` on the server, open a WebSocket from the tile and attach. Render the first-attach `history` and stream live.
- Closing the dashboard: tear down every tile WebSocket. The PTY is left alone — other attachers (the drawer) keep it alive; if there are no other attachers, the PTY simply sits idle the way any other no-subscriber session does.
- Project removal or terminal removal while the dashboard is open: remove that project section / tile, tear down its socket, recompute global sizing.

**Scrollback ring-buffer clearing does _not_ fire** on dashboard tile attaches. The first-attach cleanup (HS-6799) is gated on `!session.hasBeenAttached` — by the time the dashboard opens, the session has in the common case already been attached by the eager-spawn flow or the drawer, so `hasBeenAttached` is true and no cleanup runs.

## 25.6 Bell indicators on tiles

When a terminal's bell fires (the server-side `bellPending` flag flips true via [24-cross-project-bell.md](24-cross-project-bell.md), or the client's own `term.onBell` handler fires on live bytes), and the dashboard is currently open:

1. **Bounce animation.** A one-shot CSS keyframe scales the tile from 1 → 1.08 → 1 over ~350 ms (accent color tinted shadow pulse, same easing as the existing drawer-tab bell wiggle in §23.3). The bounce fires exactly once per bell event.
2. **Persistent outline.** The tile gains a `has-bell` class which paints a 2 px accent-colored outline (inset `box-shadow`, like the terminal focus ring in §22.6) **until the user views the terminal more closely.**
3. **Bell count badge (future).** v1 just shows the outline; a small counter is deferred until someone asks for it.

**Clearing the outline.** "Viewing more closely" means one of these actions on the specific tile:
- Click-to-center (§25.7) on that tile.
- Double-click-to-enter-dedicated-view (§25.8) on that tile.
- Exit the dashboard and subsequently activate that terminal's drawer tab in the normal ticket view (handled by the existing §24 / §22 activation path).

Any of those actions fires the same `POST /api/terminal/clear-bell` that the drawer's `activateTerminal` fires today — the server-side `bellPending` flag drops, and the cross-project project-tab indicator on other Hot Sheet windows or the normal view updates via the existing bell-state long-poll.

**Dashboard-mode specific:** the project-tab `.has-bell` indicator (§24) is still rendered while the dashboard is active (the project-tab strip is visible). But since the tile-level outline is more precise, users will typically clear bells by interacting with the tile directly — the project-tab indicator drops along with the underlying flag.

## 25.7 Click-to-center (zoom-in overlay)

Single-clicking a live tile smoothly transforms it to a centered overlay at roughly **70 % of the viewport** (both dimensions), keeping the 4:3 ratio. Implementation-wise this is still `transform: scale(s)` on the same xterm root — the scale factor is larger, and the tile's container element is positioned absolutely in the viewport center with a fade-in dim backdrop behind it.

While one tile is centered:

- The centered tile is the only interactive terminal: its xterm helper textarea accepts keyboard input, and the focus ring from §22.6 applies. Users can type into the terminal without first entering dedicated view.
- The backdrop dims every other tile to ~40 % opacity.
- Clicking **outside the centered tile** (on the dim backdrop) returns the tile to its grid slot (reverse transform animation, ~200 ms). Clicking the **same centered tile** returns to the grid too, so users can toggle-zoom with a single click.
- Clicking **a different tile** animates the current one back to its slot and zooms the new one in — the animations can overlap.
- **Esc** collapses back to the grid (does _not_ exit dashboard mode; Esc on the bare grid exits the dashboard — see §25.3).
- **Double-clicking** on either an already-centered tile or a still-in-grid tile enters the dedicated view (§25.8) directly; the center overlay is just a lightweight waypoint.

**Bell clearing on center.** Entering the centered overlay on a tile that has `has-bell` clears the outline and fires `/api/terminal/clear-bell` (see §25.6).

**Lazy / exited tile click.** See §25.9 — clicking a placeholder tile does not transition to the center overlay in v1; it spawns the PTY first and then lands in the centered overlay once the first history frame arrives. (This keeps the animation from firing against an empty pane.)

## 25.8 Dedicated terminal view (double-click)

Double-clicking any tile opens a **dedicated terminal view** — the entire dashboard content area is replaced with one large pane showing just that terminal. This is functionally a full-screen single-terminal workspace, still inside dashboard mode.

**Layout:**

- A slim top bar inside the dashboard content area (the toolbar project-tab row stays intact above) shows a **Back** button (lucide `arrow-left`) on the left and the project name + terminal label on the right (`My App › Claude`).
- Below the slim bar, the entire remaining space is the xterm pane. Unlike the grid tile, the dedicated view **does** call `fit()` on its xterm instance so the cells scale to real cols/rows at the current size — because this is a proper workspace, not a peek. The PTY is resized to match (honoring the existing "never shrink below another subscriber's size" rule, §22.2).

**Dismissal (returns to the dashboard grid, _not_ to the normal ticket view):**
- Click **Back**.
- Press **Esc**.
- Click the dashboard toggle button — this path exits dashboard mode entirely (per §25.3 rule 1). The dedicated view closes along with the dashboard.
- Click any project tab — exits dashboard mode and switches to that project's ticket view (per §25.3 rule 3). The dedicated view closes along with the dashboard.

**Transitions between center and dedicated:**
- Double-click on a centered tile → slides into the dedicated view.
- Double-click on a grid tile → goes straight to the dedicated view (skipping the center overlay).
- Back from the dedicated view → returns to whichever of grid / centered the user was in before entering dedicated view.

**Bell clearing.** Entering the dedicated view on a tile with `has-bell` clears the outline and fires `/api/terminal/clear-bell`.

**Focus.** Keyboard focus moves to the xterm helper textarea on enter so users can immediately type.

**Only one dedicated view at a time.** Switching to a different tile closes the first one.

## 25.9 Lazy and exited tiles (placeholders)

Some terminals should not spawn just because the dashboard opened:

- **Lazy-spawn terminals** (configured with `lazy: true`) that have never been attached — these are cold on purpose (§22.17.8).
- **Exited terminals** (`pty === null && exitCode !== null`) — the user closed the shell intentionally; respawning on peek would hide the exit.

For both cases, the tile renders a **placeholder box** instead of an xterm canvas:

- Same 4:3 preview area at the globally-computed tile size (no scaling — the placeholder is just a CSS box).
- Muted background, a centered lucide `play` glyph, and a small status string: `Not yet started` for lazy-unspawned; `Exited (code N)` for exited.
- Terminal title label below the preview area, same as live tiles (§25.4).

**Interaction:**

- **Single click on a placeholder.** Spawn the PTY (via the existing spawn-on-attach path — open the WebSocket from the tile, same as live tiles) _and_ transition straight to the centered overlay (§25.7) once the first history frame lands. This matches the feedback instruction "spawn when viewed at a larger size" and avoids the surprise of a placeholder suddenly running in the background at grid size.
- **Double click on a placeholder.** Spawn and go directly to the dedicated view (§25.8).
- **While spawning:** the center overlay / dedicated view shows a brief "Starting…" state until the WebSocket's `history` or first bytes arrive.

**Eager-spawn note.** An eager-spawn terminal (`lazy: false`) that is alive will of course render as a live tile, not a placeholder — its PTY was spawned at project boot (§22.17.8). The placeholder rule is specifically for cold terminals.

## 25.10 Projects with zero terminals

Every registered project gets a section, even when it has zero terminals configured. The section shows:

- The project heading.
- A single muted row in place of the grid: `No terminals configured — open Settings → Terminal to add one.` (The text links directly to opening that project's Settings dialog on the Terminal tab is _not_ required in v1; prose-only is fine.)

This makes the dashboard a faithful catalog of "your projects, at a glance" without silently omitting projects that happen to have no terminals yet.

## 25.11 Tauri-only feature gating

The whole dashboard is off in plain-browser sessions:

- The `#terminal-dashboard-toggle` toolbar button is not rendered when `window.__TAURI__` is absent (same detector used by `applyTerminalTabVisibility` in §22.11).
- No state, no keybindings, no server-side awareness. The feature is purely client-side.

Server-side, no new endpoints or config keys are needed — all attach / clear-bell flows already exist.

## 25.12 Client module layout (non-normative)

- **`src/client/terminalDashboard.tsx`** (new) — the dashboard shell. Owns:
  - The dashboard-active flag and the enter / exit transitions.
  - The project list → grid layout rendering.
  - The global tile-size computation (resize-observer / window resize throttled).
  - Click / double-click handlers → center overlay + dedicated view components.
  - Per-tile `TerminalInstance` management (mount xterm at 80×60, open WS, render history).
  - Bell subscription via `subscribeToBellState` (from `bellPoll.tsx`, §24) to paint / clear the per-tile `.has-bell` outline.
- **`src/client/terminal.tsx`** — unchanged. The dashboard instantiates its own `TerminalInstance`s; it shares the transport helpers (`connect`, `replayHistoryToTerm`, `doFit` for dedicated view) but does not reuse drawer-tab instances.
- **`src/client/projectTabs.tsx`** — gains an "on click handler" hook so clicking a project tab while the dashboard is open exits the dashboard **before** activating the clicked project.
- **`src/client/styles.scss`** — new `.terminal-dashboard`, `.terminal-dashboard-section`, `.terminal-dashboard-tile`, `.terminal-dashboard-tile .preview`, `.terminal-dashboard-tile .label`, `.terminal-dashboard-tile.has-bell`, `.terminal-dashboard-center-overlay`, `.terminal-dashboard-dedicated`, and a bounce keyframe reusing the easing curve of the existing drawer-tab bell shake.

No server-side changes required.

## 25.13 Out of scope (v1)

Deliberately not in the first iteration — revisit when the feature lands and users request them:

- **Keyboard shortcut to toggle the dashboard** (HS-6272 feedback J). Follow-up ticket if missed.
- **Drag-to-reorder tiles / pin favorites.** Order is strictly `project index, then terminal index within the project`.
- **Per-tile close / stop buttons.** Dashboard is a peek view; use the drawer for lifecycle control.
- **Input into grid tiles.** Only the centered overlay and the dedicated view accept keystrokes.
- **Resize the centered overlay.** Fixed at ~70 % viewport; deliberate constraint to keep the back-to-grid animation predictable.
- **Persist "dashboard-open" across reloads.** Fresh reload returns to the ticket view.
- **Multi-select tiles / bulk actions.** Not needed for the peek use case.
- **Audio ping on bell.** §24's v1 deferral stands — bells are visual-only.

## 25.14 Manual test plan

See [manual-test-plan.md §12](manual-test-plan.md#12-embedded-terminal) — add these entries:

1. **Enter / exit.** Click the `layout-panel-left` button before the project tabs — the ticket area disappears, the grid appears. Click again → back to tickets. Press Esc on the bare grid → back to tickets.
2. **Project-tab navigation from dashboard.** Click another project's tab while the dashboard is active — dashboard closes and that project's ticket view activates.
3. **Grid sizing.** With several projects each containing 2–4 terminals, confirm every tile is the same size and 4:3. Shrink the window vertically until content vertical-scrolls and the 100 px minimum tile height holds.
4. **Center overlay.** Single-click a live tile — it animates to ~70 % viewport. Type into it — the text hits the underlying shell. Click outside (on the dim backdrop) — it returns to its grid slot. Click it again, Esc — same return.
5. **Dedicated view.** Double-click any tile — full-viewport pane, `fit()` resizes the PTY. Back button / Esc returns to the grid (or to the center overlay if that was the prior state).
6. **Bell surfacing.** `printf '\007'` in a background terminal. The tile bounces once and keeps a colored outline. Click it (center overlay) — outline clears, server-side `bellPending` flips.
7. **Lazy / exited placeholder.** Mark a terminal `lazy: true`, never attach it, open the dashboard — it renders as a placeholder. Single-click — it spawns and transitions to the center overlay once the first history frame lands. `exit` a running shell, reopen dashboard — same flow with the exit-code placeholder.
8. **Zero-terminal project.** Open the dashboard with a project whose `terminals` is `[]` — its section shows the empty-state row, not a blank grid.
9. **Web gating.** In a plain browser (no Tauri), confirm the dashboard toggle button is absent from the toolbar.

## 25.15 Cross-references

- [22-terminal.md](22-terminal.md) — base embedded-terminal feature; the dashboard is an alternate rendering, not a new subsystem.
- [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) §23.3 — bell Phase 1 (drawer-tab indicator); the dashboard tile outline is the same concept at tile granularity.
- [24-cross-project-bell.md](24-cross-project-bell.md) — cross-project bell long-poll; the dashboard reuses `subscribeToBellState` and the `POST /api/terminal/clear-bell` flow. No new server endpoints.
- [4-user-interface.md](4-user-interface.md) §4.1 — top toolbar; the dashboard hides everything there except the toggle button and the project-tab strip.
- [10-desktop-app.md](10-desktop-app.md) — Tauri-only gating pattern (matches §22.11).
- **Tickets:** HS-6272 (this doc).
