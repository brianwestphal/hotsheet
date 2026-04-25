# 36. Drawer terminal grid view (HS-6311)

## 36.1 Overview

The **drawer terminal grid** is an alternate rendering of the bottom drawer (see [22-terminal.md](22-terminal.md)) that shows every terminal in the **current project** as a grid of scaled-down, live tiles. It is conceptually a project-scoped version of the global Terminal Dashboard (see [25-terminal-dashboard.md](25-terminal-dashboard.md) §25): a peek-and-zoom surface that lets the user see what every terminal in this one project is doing without tabbing through each one, then click to enlarge or double-click to open a dedicated full-drawer view.

The feature is **Tauri-only** (same gate as §22.11) and sits next to the drawer's existing Commands Log + per-terminal tab stack rather than replacing them — the user toggles in and out of grid mode via a new button in the drawer toolbar.

**Core promises:**

1. One glanceable pane that shows every terminal in the current project at the same time, live, without switching tabs.
2. Interaction model mirrors the global Terminal Dashboard (§25.7 / §25.8): single-click = centered overlay, double-click = dedicated full-drawer view, Esc steps back out of each level in order.
3. Per-project mode (like the per-project drawer state in §22.12) — each project independently remembers whether it was last viewed in tabs mode or grid mode, and its own slider value.
4. Enabled only when the project has more than one terminal (a single-terminal project gets no benefit from the grid view).
5. Tile-level bell indicators with a bounce animation + persistent outline, mirroring §25.6.
6. No new server-side state and no duplicate PTYs. Tiles open their own WebSockets against the existing `TerminalSession` registry.

## 36.2 Entry point and drawer toolbar

A new toggle button sits in the drawer toolbar's `.drawer-tabs-end` cluster, **before** the `.drawer-expand-btn` (the "expand drawer to full height" button from HS-6312). Id: `#drawer-grid-toggle`. It uses the Lucide `layout-grid` glyph so the iconography reads as "grid of tiles" (distinct from the global `square-terminal` glyph used for §25's cross-project dashboard).

- Shows only when Hot Sheet is running inside Tauri (same detector as §22.11 / §25.2). In a plain browser context the button is not rendered.
- Is **disabled** (not hidden) when the current project has ≤1 terminal — the button still renders so the UI doesn't jump as the user adds / removes terminals, but `disabled` prevents accidental activation and shows a tooltip explaining why. As soon as a second terminal is created (via the drawer's `+` or the `/api/terminal/create` endpoint) the button enables.
- Gains a pressed/active visual state (`.active`) when grid mode is on, matching the rest of the drawer toolbar affordances.
- Clicking the button toggles grid mode on and off.

**Tile-size slider.** A second new element sits immediately before the toggle button: `#drawer-grid-sizer`, a small container with a Lucide `scaling` icon + a range input (`#drawer-grid-size-slider`, `min=0 max=100 step=1`, default `33`). Its visibility is tied to grid mode — shown only while grid mode is active. Styling, snap-point tick marks, and behaviour mirror the dashboard slider (§25.4 / HS-7031 / HS-7271) exactly; the underlying math is the same `tileWidthFromSlider` + `computeSliderSnapPoints` + `maybeSnapSliderValue` helpers in `terminalDashboardSizing.ts`.

## 36.3 Grid mode vs. tabs mode

Grid mode is a separate view inside the drawer — while it's on:

- The `.drawer-terminal-tabs-wrap` (per-terminal tab strip + `+` add button) and `.drawer-tabs-divider` stay visible so the user can see the list of terminals, but clicking a tab exits grid mode and activates that terminal in the normal tabs view (like clicking a project tab §25.3 rule 3).
- The drawer-expand button + grid-toggle button + tile-size slider in `.drawer-tabs-end` stay visible.
- The Commands Log tab button (`#drawer-tab-commands-log`) stays visible but inactive. Clicking it exits grid mode and activates the Commands Log pane.
- Every `.drawer-tab-content` panel (the Commands Log body and every per-terminal `.drawer-terminal-pane`) is hidden via `display:none`.
- A new `.drawer-terminal-grid` container becomes visible in the drawer body, hosting the tile grid.

Exiting grid mode restores the drawer to whatever tab was previously active — Commands Log or a specific terminal tab. Grid mode state is tracked per-project (§36.6) so switching projects while grid mode is on in one project leaves that state intact when the user comes back.

**Fresh `/terminal/list` on grid-mode entry (HS-7657).** Entering grid mode (`enterGridModeInternal`) triggers a `loadAndRenderTerminalTabs()` refresh in addition to building tiles from the cached `lastKnownEntries`. Without it, a dynamic terminal that was created via `+` and then activated in the tab strip — which spawns the PTY lazily on WS attach — would show as `not_spawned` in the grid because the previously-cached list response captured `state` BEFORE the WS-driven spawn. There's no server-side notify-mutation event on lazy spawn, so the only way to re-fetch fresh state is to call the list endpoint at toggle time. The refresh is fire-and-forget; the immediate rebuild from `lastKnownEntries` paints something usable, and the freshly-fetched response replaces it via `onTerminalListUpdated → rebuild` once the request lands.

## 36.4 Grid layout

A single vertically-scrolling flex-wrap grid fills the drawer body. Every tile is strictly 4:3 (preview area) + a centered label below, identical to the dashboard's tile shape (§25.4). Tiles wrap onto additional rows when they exceed the drawer width. The preview + xterm scale math is shared with the dashboard via `terminalDashboardSizing.ts`:

- `tileWidthFromSlider(sliderValue, drawerBodyWidth - 2 * padding)` picks the tile width.
- `computeTileScale(tileWidth, tileHeight, naturalWidth, naturalHeight)` computes the uniform scale for the xterm's natural pixel size.
- `tileNativeGridFromCellMetrics(cellW, cellH)` picks the tile-native 4:3 cols × rows from measured cell metrics (same HS-7097 follow-up behaviour as the dashboard).

**Unlike the dashboard, there is no per-project section heading.** All tiles in the grid belong to the same project, so the heading would be redundant. The grid is a single flex-wrap strip.

**Tile contents.** Each tile is the same `[preview area][centered label]` stack as the dashboard, with the same horizontal-center + top-align letterbox policy inside the preview (HS-6997). The label resolves to the configured `name` → derived basename fall-through (`tabDisplayName` in §22). The runtime OSC 0/2 title is **not** used — terminal-set titles are long and per-cwd noisy, and the grid wants stable labels for recognition (same rule as §25.4).

**CWD badge (follow-up).** The dashboard tile's §25.4 "CWD chip below the label" (HS-7278) is intentionally deferred for v1 of the drawer grid — the drawer is tall/short so screen real estate is at a premium; a CWD row would halve the preview height. Filed as a follow-up ticket.

**Focus, input, and interaction.** Tiles in grid view are **non-interactive** — they do not accept keyboard input and do not show a cursor-focus ring. Pointer events only trigger the click / double-click / contextmenu handlers in §36.5.

**Scrollback on attach.** Each tile mounts a fresh xterm and opens a WebSocket. First attach replays the server's `history` frame via `replayHistoryToTerm` at the PTY's dims, then resizes both the local xterm and the PTY to tile-native 4:3 via the `'resize'` message — identical to the dashboard's `connectTileSocket` flow (HS-7097 follow-up). This is the load-bearing step that makes TUIs like `nano` redraw to fill the tile geometry instead of leaving rows past the PTY's row count empty.

**Attach lifecycle.**
- Entering grid mode: for every live terminal in the current project, open a tile WebSocket + replay history + resize to tile-native 4:3.
- Leaving grid mode: tear down every tile WebSocket. Normal drawer-tab WebSockets are unaffected (a drawer terminal tab and its grid-mode tile are separate subscribers against the same underlying PTY session).
- Terminal removal while in grid mode: remove that tile, tear down its socket, recompute sizing.
- Terminal addition while in grid mode: render a new tile for it and attach.

## 36.5 Click, double-click, and dedicated view

Exactly mirrors §25.7 + §25.8 with the drawer's bounds as the "viewport":

- **Single-click on a live tile.** Animates the tile to a centered overlay at ~90 % of the drawer body's width / height (both dimensions, keeping 4:3). 90 % rather than the dashboard's 70 % because the drawer is already short; 70 % would leave a ~20 px border which doesn't add polish and costs readable text. A FLIP animation (HS-6867) keeps the tile visibly growing out of its grid slot — a grey placeholder is inserted in the tile's grid slot before the real tile is promoted to a fixed-position overlay, the outer transform interpolates from the placeholder's rect to the centered target rect, and the xterm scale is pinned to the final centered size so the whole thing grows together.

  While centered:
  - The centered tile is the only interactive terminal; its xterm helper textarea accepts keyboard input. Backdrop dims the rest of the grid.
  - Clicking the dim backdrop, clicking the same tile again, or pressing **Esc** returns the tile to its grid slot (reverse FLIP).
  - Clicking a different tile animates the current one back to its slot and zooms the new one in.
  - Double-clicking a centered tile (or a grid tile directly) enters the dedicated view below.

- **Double-click on any tile.** Opens a **dedicated view** — the drawer grid area is replaced with one large pane showing just that terminal, with a slim `Back` button at the top. The dedicated pane uses `FitAddon.fit()` so the cells scale to real cols × rows at the current drawer size (not the scale transform that the grid tiles use). A PTY resize message matches the pane dims, then a post-replay refit (HS-7063's `applyDedicatedHistoryFrame`) keeps the pane filled even after the history frame's own resize. Same HS-7098 inner-pane + symmetric-padding + flex-center structure as §25.8 to keep the visible frame even on all four sides.

  While in the dedicated view:
  - Clicking **Back** returns to the prior grid / centered state.
  - Pressing **Esc** does the same. If focus is inside the dedicated view's search input, the first Esc blurs the search input + re-focuses the xterm (mirroring HS-7526); a second Esc exits.
  - Clicking the grid toggle button exits grid mode entirely (and closes the dedicated view along with it).
  - Clicking a drawer terminal tab or the Commands Log button exits grid mode and activates that tab (same as §25.3 rule 3).

- **Placeholder tiles (lazy / exited).** For a lazy-unspawned terminal (`lazy:true`, never attached) or an exited terminal (`exitCode !== null`), the tile renders as a placeholder box — muted background, Lucide `play` glyph, status string (`Not yet started` or `Exited (code N)`). Single-click on a placeholder spawns the PTY via the existing WebSocket attach path (lazy) or a `POST /api/terminal/restart` (exited) and transitions to the centered overlay once the first history frame arrives. Double-click spawns and goes direct to dedicated. Mirrors §25.9.

**Bell clearing on enlarge.** Entering the centered overlay or the dedicated view on a tile with `.has-bell` clears the outline and fires `POST /api/terminal/clear-bell` (§25.6). Exiting grid mode and subsequently activating that terminal's drawer tab also clears the bell via the existing §22 activation path.

**App-level overlay on enlarge (HS-7659).** Single-click center and double-click dedicated both render the maximized terminal at an app-level overlay covering the entire viewport — NOT by expanding the drawer panel. The earlier implementation auto-expanded the drawer + hid the expand button while a tile was enlarged, but that had two problems: it visually conflated "you've maximized one terminal" with "your drawer is expanded," and the chrome flips meant the expand button could be left in a confusing state if the shrink path ever skipped restoration. The current model leaves the drawer entirely alone — the user's `.app.drawer-expanded` state, expand button, and size slider are all untouched throughout the enlarge → exit cycle. Mechanically: `mountTileGrid()` is configured with `centerScope: 'viewport'` and `centerReferenceEl: document.body`, so the centered tile positions against the visual viewport (matching §25's dashboard) and both the backdrop (`position: fixed; inset: 0`) and the dedicated overlay (`position: fixed; inset: 0; z-index: 600`) cover the full window. No body-class chrome flips, no `commandLog` imports, no state to restore. Regression covered by `drawer-terminal-grid.spec.ts` "enlarging a tile renders at viewport scope and leaves drawer chrome untouched (HS-7659)".

**Cursor ring / focus.** Only the centered tile and the dedicated view's xterm take keyboard input. Grid tiles set `pointer-events: none` on their xterm root so stray clicks don't leak into the scaled canvas.

## 36.6 Per-project grid-mode state

Grid mode is tracked per-project, not globally. Session-only (in-memory; resets on page reload) — not persisted to `settings.json`. This matches the existing per-project drawer state from §22.12 and the per-project search state from HS-7360.

Implementation: two new `Map<secret, …>` structures in `src/client/state.tsx`:
- `projectGridActive: Map<secret, boolean>` — true when the project is in grid mode.
- `projectGridSliderValue: Map<secret, number>` — the slider value last used in this project (0..100, default `33`).

`setActiveProject` saves the current project's grid state before switching and restores the destination project's grid state afterwards. `clearPerProjectSessionState(secret)` (HS-7360) also wipes these two maps so a removed project doesn't leak state.

## 36.6.5 Hide a terminal from the grid (HS-7661)

Mirrors §25.10.4 — a user can hide individual terminals from the drawer-grid view without affecting the underlying session or the drawer's tab strip. Two entry points:

**1. Right-click on a tile** → small context menu with one entry: "Hide in Dashboard". Click sets the terminal hidden via the shared `dashboardHiddenTerminals.ts` state, which in turn fires the change subscription that rebuilds the drawer-grid (filtering out the hidden terminal).

**2. Eye-icon button in the drawer toolbar** (`#drawer-grid-hide-btn`, Lucide `eye`). Sits to the right of the size slider per the user's HS-7661 feedback. Visibility tracks the slider — visible only while drawer-grid mode is active. Click opens the **Show / Hide Terminals** dialog in `single-project` mode (see §25.10.6) — only this project's terminals are listed. Toggle a row → the dashboard rebuilds immediately and the row treatment updates in-place.

**Hidden-count badge (HS-7823).** When N > 0 terminals are hidden in the active project, the eye icon shows a small numeric badge at its top-right (shared `.hide-btn-badge` style with the dashboard's badge — see §25.10.4). The drawer-grid scopes the count to the active project (`countHiddenForProject`); the dashboard's badge sums across every project. The badge updates from the same `subscribeToHiddenChanges` subscription that rebuilds the visible-tile list, plus a `refreshHideBtnBadge()` call on every `showGridChrome()` so a project switch repaints the count without a flicker.

**State** is shared with the global Terminal Dashboard (per the user's feedback answer #2: "both") — `dashboardHiddenTerminals.ts` keys by `(secret, terminalId)` so a hide operation in either surface filters the same tile out of both views. Session-only — clears on page reload.

**Disabled-state gate (§36.7) counts ALL terminals.** Per the user's feedback answer #6, the toggle's enable rule remains "≥2 terminals exist" — hiding terminals does NOT disable the toggle. So a 2-terminal project where the user hides one still has the toggle enabled, and the grid would render with one visible tile + the eye icon to toggle the other back.

**All-hidden empty state.** When every terminal in the project is hidden, the grid container renders a `.drawer-terminal-grid-all-hidden` placeholder ("All Terminals Hidden") in place of the tile list (per the user's feedback answer #5). Toggling any row back from the dialog rebuilds the grid normally.

## 36.7 Disabled-state logic

The grid toggle is **disabled** whenever the current project has ≤1 terminal. The count is taken from the most recent `/api/terminal/list` response (configured + dynamic buckets combined). The state is updated in three places:

1. On every successful `loadAndRenderTerminalTabs()` call in `terminal.tsx` (covers project switches, Settings → Terminal saves, add/remove dynamic terminals).
2. On every `refreshDrawerGrid()` call (covers in-grid-mode lifecycle changes).
3. On initial drawer open.

When the count drops from ≥2 to ≤1 while the user is *already* in grid mode, the mode exits automatically — showing a grid of one tile is strictly worse than the normal tabs view, and the alternative is an awkward "disabled mid-use" state. The auto-exit restores the previously-active drawer tab.

## 36.8 Tauri-only feature gating

Per §22.11, the embedded-terminal feature is desktop-only. The grid view is a rendering over those terminals, so it follows the same rule:

- `#drawer-grid-toggle` is not rendered when `getTauriInvoke()` returns `null`.
- `#drawer-grid-sizer` is also hidden in that case.
- No state, no keybindings, no server-side awareness.

Server-side, no new endpoints or config keys are needed. Every attach / clear-bell flow already exists.

## 36.9 Client module layout

- **`src/client/drawerTerminalGrid.tsx`** (new) — the grid-mode shell. Owns:
  - The per-project grid-active flag (reading/writing to `state.tsx`).
  - Enter / exit transitions (hide-tabs / show-grid / populate tiles).
  - The grid rendering + tile mount/teardown.
  - Click / double-click / contextmenu handlers → centered overlay + dedicated view (mostly delegating to shared helpers where possible — the animations and FLIP math are close enough to §25's that the initial implementation holds a copy inside this module; a future refactor may extract the shared parts to `terminalTileGrid.tsx`).
  - Bell subscription (`subscribeToBellState` from `bellPoll.tsx`) for tile-level bounce + outline.
- **`src/client/terminalDashboardSizing.ts`** — unchanged; shared helpers already generic enough.
- **`src/client/terminal.tsx`** — adds `isDrawerGridActive()` exports + calls into drawerTerminalGrid on toggle-button click + enable/disable the grid toggle on every list refresh.
- **`src/client/state.tsx`** — adds `projectGridActive` + `projectGridSliderValue` maps + save/restore in `setActiveProject`, + cleanup in `clearPerProjectSessionState`.
- **`src/client/styles.scss`** — new `.drawer-terminal-grid`, `.drawer-terminal-grid-tile`, `.drawer-grid-toggle`, `.drawer-grid-sizer`, and a bounce keyframe (reusing §25.6's pattern).
- **`src/routes/pages.tsx`** — adds the toggle button + slider markup to `.drawer-tabs-end`, and the grid container inside `#command-log-panel`.

## 36.10 Out of scope (v1)

Deliberately not in the first iteration — revisit if the feature lands and users request them:

- **CWD badge under the tile label.** The dashboard has one (HS-7278); the drawer's vertical real estate is too tight to justify it. Follow-up ticket if missed. (HS-7593 closed as won't-do.)
- **~~Keyboard shortcut to toggle grid mode.~~** Shipped via HS-7594 — `Cmd+`` `` (macOS) / `Ctrl+`` `` (Linux/Windows) toggles drawer grid view when focus is in a drawer terminal, or the global Terminal Dashboard otherwise. `Opt+Cmd+`` `` / `Alt+Ctrl+`` `` always toggles the global dashboard. Implementation lives in `src/client/terminalKeybindings.ts` (`isTerminalViewToggleShortcut`), dispatched from `shortcuts.tsx` and swallowed by every xterm `attachCustomKeyEventHandler` so the shell doesn't see a backtick. See [22-terminal.md §22.18](22-terminal.md#2218-terminal-focused-keyboard-shortcuts-hs-6472).
- **Drag-to-reorder tiles / pin favorites.** Order is strictly `configured terminals first, in config order; dynamic terminals after, in creation order`, mirroring the drawer tab strip.
- **Persist grid-mode state across reloads.** Fresh reload returns to tabs mode.
- **Multi-select tiles / bulk actions.** Not needed for the peek use case.
- **Inline `+` button in the grid heading.** The dashboard has per-project sections each with their own heading + `+` (§25.4 / HS-7064); the drawer grid is a single-project single-section view, so the drawer tab strip's existing `+` button is the canonical "add a terminal" affordance.
- **Dashboard tile gear popover for appearance (HS-6307).** Tiles are preview-only; users change appearance from the terminal's own drawer tab or dedicated view.
- **Zoom level picker / fit-to-drawer auto-sizer.** The manual slider is the sole sizing control (same decision as §25.4).

## 36.11 Manual test plan

See [manual-test-plan.md §12](manual-test-plan.md#12-embedded-terminal) — add:

1. **Enable / disable.** With one terminal in the project, the grid toggle shows but is disabled. Add a second terminal — the button enables. Remove back down to one — the button re-disables and (if currently active) auto-exits grid mode.
2. **Enter / exit.** Click the grid toggle button in a project with ≥2 terminals. The drawer body swaps to the tile grid. Click again → back to the prior drawer tab. Press Esc on the bare grid → back to the prior drawer tab.
3. **Tab click during grid mode.** Click a terminal drawer tab or the Commands Log button while grid mode is active — grid mode exits and that tab activates.
4. **Project switch persistence.** Project A in grid mode → switch to project B → project B opens in its last mode (tabs by default). Switch back to A — still in grid mode, same slider position.
5. **Slider.** Slide left / right while grid mode is active. Tiles resize uniformly, stay 4:3. Snap-point ticks render under the slider at "N per row" positions and the slider magnetically snaps within ~2.5 units.
6. **Centered overlay.** Single-click a tile — it animates to a ~90 % drawer-size overlay. Type into it — text reaches the shell. Click outside (dim backdrop) → returns to grid. Same click again, or Esc → returns.
7. **Dedicated view.** Double-click a tile — full-drawer pane, `fit()` runs. Back or Esc returns to the grid or centered overlay the user was in before.
8. **Placeholders.** Mark a terminal `lazy:true`, never attach it, enter grid mode — placeholder tile. Single-click → spawns → transitions to centered. Exit a terminal (`exit` inside the shell) → placeholder with `Exited (code N)`. Single-click → restart + centered.
9. **Bell.** `printf '\007'` in one terminal while another project is active — the project-tab bell indicator shows. Switch to that project, open grid mode — the tile has a bounce + persistent outline. Click the tile (centered) → outline clears + server bell pending flag drops.
10. **Mode-state + Tauri-only.** In a plain browser (no Tauri), confirm the grid toggle button is absent from the drawer toolbar. In Tauri, grid state survives a project switch but resets on page reload.

## 36.12 Cross-references

- [22-terminal.md](22-terminal.md) — base embedded-terminal feature; grid view is an alternate rendering over the same `TerminalSession` registry.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) — the global cross-project dashboard that this feature mirrors at per-project scope. Most tile-level design decisions (4:3 preview, HS-7097 PTY-resize follow-up, FLIP center animation, placeholders, bell bounce + outline, HS-7098 dedicated-view frame) carry over verbatim.
- [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) §23.3 — bell Phase 1 (drawer tab indicator); the grid tile outline is the same concept at tile granularity.
- [24-cross-project-bell.md](24-cross-project-bell.md) — cross-project bell long-poll; `subscribeToBellState` drives the tile-level bounce + outline.
- [4-user-interface.md](4-user-interface.md) §4.1 — top toolbar; the grid view intentionally does NOT touch the top toolbar (only the drawer toolbar), so the top-toolbar chrome remains visible throughout.
- [10-desktop-app.md](10-desktop-app.md) — Tauri-only gating pattern.
- **Tickets:** HS-6311 (this doc). Follow-ups to be filed alongside implementation: CWD badge on drawer-grid tiles, keyboard shortcut to toggle, extraction of shared tile-grid module from §25 + §36.
