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

A new iconic toggle button sits **before the first project tab** in the top toolbar, using the Lucide `square-terminal` glyph (HS-7030 — replaced `layout-panel-left` because the square-terminal glyph signals "this is the terminal feature" far more clearly in a toolbar shared with layout toggles). It is identified as `#terminal-dashboard-toggle`. The button:

- Shows only when Hot Sheet is running inside Tauri (same gate as the embedded-terminal feature, §22.11). In a plain browser context the button is not rendered at all.
- Has a pressed/active visual state when the dashboard is open, matching the existing toolbar-toggle style (accent-border, accent-tinted background).
- Toggles the dashboard on and off.

**Chrome visibility while dashboard mode is active.** Three elements in the top toolbar remain visible:

1. The `#terminal-dashboard-toggle` button (so the user can exit).
2. The project-tab strip (so the user can navigate to a specific project's ticket view).
3. The tile-size slider (HS-7031) — at the far right of the header, a lucide `scaling` icon followed by a ~200 px range input. See §25.4.

Everything else in the top toolbar — search, layout toggles, Settings button, help icon, any plugin-contributed toolbar extensions (see [18-plugins.md](18-plugins.md) §18 `toolbar` location), and the Claude-channel play/status cluster — is hidden. The footer status bar, ticket sidebar, list/column/kanban ticket area, right-side detail panel, and per-project bottom drawer (Commands Log + terminal tabs) are all hidden as well. The dashboard owns the entire content area below the slim header.

**No active project tab while the dashboard is open (HS-6868).** The dashboard is a global cross-project view, so the normal `.active` tab highlight (background / border / bold) is suppressed while `body.terminal-dashboard-active` is set — every tab renders in its unselected state. Status dots (feedback, attention, busy) and the cross-project bell indicator (§24) are left untouched; only the "which project am I currently viewing" styling is muted.

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
- An outlined lucide `plus` button (HS-7064) immediately after the name. Clicking it creates a dynamic terminal in that project via the existing `POST /api/terminal/create` endpoint (default shell, no prompt) and refreshes the dashboard so the new tile appears in the grid. Unlike the drawer's `+` button, the dashboard's `+` button passes `{ spawn: true }` on the create call so the server starts the PTY immediately (HS-7228) — the drawer's `+` gets eager-spawn for free because it `selectDrawerTab`s the new tab (which attaches a WS and triggers the spawn), but the dashboard has no equivalent follow-up attach. Without `spawn: true` the new tile would render as a cold `not_spawned` placeholder and the user would have to click it to get a running shell; with it the tile lands as a live preview that matches the drawer's "I pressed + and got a shell" mental model. This is the one documented exception to the "cold tiles stay cold" rule (§25.9) — every other tile on the dashboard is cold until the user enlarges it.

The heading is left-aligned and does not participate in the grid sizing calculation — its height is additive to the grid.

**Grid.** Each project's terminals are laid out in a flex-wrap row. Every tile is identically sized and strictly 4:3 (see §25.5). Tiles wrap to the next visual row when they exceed the viewport width.

**Terminal title centered below each tile.** Each tile is a composite `[preview area][title label]` stack. The title row sits **below** the preview area, center-aligned, and resolves to the same name the drawer tab would show (configured `name`, else derived basename — see `effectiveTabLabel` in §22 / §23). The runtime title from an OSC 0/2 title escape is _not_ used here — terminal-set titles can be long and per-cwd noisy, and the dashboard wants stable labels for recognition. The label row adds its own fixed height (e.g. 20 px + small margin) on top of the tile's preview area.

**Global tile sizing (HS-7031).** The layout picks one size that applies to every tile in every project, driven by a manual **size slider** in the header — not an auto-fit algorithm:

- The tile's **preview area** (the xterm canvas region) is strictly `4:3`.
- The **minimum preview-area height is 100 px** (HS-6272 feedback B). Below that, the content becomes unreadable. That floor sets the minimum tile width at ~133 px (100 × 4/3).
- A range slider (0..100) at the far right of the header maps linearly to tile width: `0` → `SLIDER_MIN_TILE_WIDTH` (~133 px), `100` → the full available width minus root padding (`root.clientWidth - 2 × ROOT_PADDING`), `50` → midpoint. Example: in a root with 1000 px of usable width, the slider at 50 picks a 567 px tile. Implementation: `tileWidthFromSlider(value, rootWidth)` in `src/client/terminalDashboardSizing.ts` (pure, unit-tested).
- The slider defaults to `33` on dashboard entry (HS-7129) and persists in memory for the session (reset on page reload; not saved to settings.json in v1). The earlier `50` default left tiles large enough that only 1–2 fit per row on a typical laptop root width, undercutting the dashboard's "see every terminal at a glance" purpose; `33` lines up with three tiles across the common root width while still keeping xterm text readable.
- If the chosen tile height overflows the viewport height, **the content area vertical-scrolls** — same behaviour as before, just always driven by the slider instead of the auto-fit algorithm. This is the only scroll direction; horizontal overflow wraps tiles to new rows within the same project section.
- The sizing recomputes on slider `input` events, on window resize (throttled via rAF), and on project list / terminals list changes.

The older auto-fit `computeTileWidth()` routine (HS-6833) is retained in `terminalDashboardSizing.ts` for its unit tests but is no longer called at runtime — the slider is the sole input. Users tuning in between projects with very different row / col counts can pick the tile size that matches what they want to see at a glance rather than being locked into whatever the algorithm picked.

All tile preview areas share one computed size — users can compare terminals across projects at a glance.

## 25.5 Tile contents and the scale-transform trick

Each live (alive) terminal tile renders an xterm.js canvas grid whose cols × rows match the PTY's current geometry. A CSS `transform: scale(s)` is applied to the xterm root so the grid visually fits the 4:3 preview area. The scale is uniform and computed as `s = min(tilePreviewWidthPx / xtermNaturalWidthPx, tilePreviewHeightPx / xtermNaturalHeightPx)` so text keeps its natural metrics.

**Cols × rows pinned to tile-native 4:3 — the PTY itself follows (HS-7097 follow-up).** The tile's xterm stays at a tile-native 4:3 cols × rows derived from measured cell metrics (`tileNativeGridFromCellMetrics` → `computeTileGridDims` in `terminalDashboardSizing.ts`). On attach the server sends a `history` frame with the PTY's current cols × rows; the client runs `replayHistoryToTerm` at the PTY's dims (required so the history bytes render in the geometry they were formatted for), then resizes the tile's xterm to tile-native 4:3 **and** sends a `'resize'` message back to the server with the same cols × rows. That second step is the load-bearing one — it pushes the PTY to tile-native dims so any running TUI (`nano`, `vim`, `less`) gets `SIGWINCH` and redraws to fill the new geometry. Without the PTY resize, the tile xterm has 60 rows of buffer but the script keeps drawing for the drawer's 14 rows, so rows 15-60 stay empty white (the user-visible regression on the HS-7097 screenshots).
> **Why drive the PTY at all (the symptom that finally pinned the bug):** the previous HS-7097 attempt resized only the local xterm buffer and trusted the bytes to reflow. They don't — `nano`'s footer at row 14 stays at row 14 even after the buffer grows to 60 rows; nothing in the byte stream knows the buffer is now taller until the PTY itself is resized and the program receives `SIGWINCH`. The dedicated view (§25.8) has always driven the PTY via `fit()` for exactly this reason, which is why "works in the full screen mode but not for the grid preview" — the grid tile was missing the same step. Tile and dedicated view now use the same approach: resize the local xterm and the remote PTY together. When the user switches back to the drawer, the drawer's own `fit()` resizes the PTY back to drawer dims; the resize war converges via whichever view is currently primary. The e2e regression test for this lives at `e2e/terminal-dashboard-tile-rendering.spec.ts` — three view-mode screenshots assert the BOTTOM marker sits within 10 % of the preview bottom.

**Rescale is driven by a `.xterm-screen` ResizeObserver, not a rAF chain (HS-7097).** `term.resize(cols, rows)` updates xterm's internal buffer synchronously, but xterm renders on a rAF tick — `.xterm-screen`'s inline `width` / `height` only land on the NEXT animation frame. `reapplyTileScaleFromPreview` reads `.xterm-screen.offsetWidth / offsetHeight` as the natural size for the uniform-fit scale pass, so calling it synchronously after resize reads the PRE-resize natural dims and the tile's scale stays pinned to the previous grid. An earlier HS-7097 iteration wrapped the rescale in two `requestAnimationFrame`s after the history replay, but that still raced xterm's own render scheduler — on first-history-after-mount, both rAFs could land before xterm had committed the new `.xterm-screen` dims, and the grid / centered tile rendered PTY bytes scaled as if still at 80 × 60 (visible symptom in the 10:25 bug screenshot: content formatted for the PTY's new cols but scaled off the old grid, leaving weird horizontal dead space). The fix is to observe `.xterm-screen` directly with a `ResizeObserver`: `mountTileXterm` installs the observer once per tile, and every render that changes the screen's natural pixel size (initial mount, post-`term.resize()`, font-load reflow, anything else) triggers the rescale pass exactly when the dims are authoritative. The per-tile observer is tracked on `DashboardTile.screenObserver` and disconnected in `disposeTile`.

**Earlier iterations (HS-6931 follow-up, HS-6965 — both superseded).** HS-6931's follow-up sized the tile's xterm from measured cell metrics right after `term.open()` so the natural pixel size landed on a 4:3 target. That produced a visually-clean grid BUT broke rendering correctness once the PTY's real cols × rows differed from the 4:3 target: subsequent live bytes, formatted for the PTY's geometry, wrapped at the wrong column inside the xterm on replay (HS-6965's screenshot). HS-6965 reverted to adopting the PTY's cols × rows verbatim, which in turn left the 4:3 tile frame with large vertical dead-space bands (HS-7097's screenshot). The current HS-7097 follow-up keeps replay correct (at PTY dims) AND the tile's natural aspect at 4:3 — by resizing the tile back to tile-native dims **after** the PTY-dimensioned replay writes its bytes.

**Uniform scale — never two-axis (HS-6931).** An earlier iteration (HS-6898) applied `scale(scaleX, scaleY)` to eliminate dead space by stretching the canvas anisotropically, at which point the stretched text was visibly distorted (`scale(3.478, 0.375)` in the bug report). HS-6931 reverted to a single uniform `s` and HS-6931's follow-up then sized the grid so uniform scaling fills the tile without needing the stretch. Uniform scale remains the policy so small pixel mismatches (the xterm's natural aspect is ~4:3 ±1 cell depending on cell metrics rounding) fall back to a ≤1-cell letterbox rather than re-introducing stretching.

**Top-aligned letterbox (HS-6997).** Since the HS-7097 follow-up pins the tile's xterm to tile-native 4:3 dims, uniform scale typically fills both axes of the 4:3 tile without leaving dead space. The top-align policy is retained as a safety net for edge cases where cell metrics drift enough from 4:3 to leave a tiny letterbox (font loads, exotic DPIs): the scaled xterm is **top-aligned** inside the tile so any dead space falls below the content rather than splitting top and bottom. The tile preview's background (HS-6866) matches xterm's theme background (both `--bg`), so the letterbox is visually seamless with the xterm canvas. Horizontal remains centered. Encoded in `computeTileScale` as `top: 0, left: Math.max(0, (tileWidth - scaledWidth) / 2)` in `src/client/terminalDashboardSizing.ts`.

**Natural dims come from `.xterm-screen`, not the outer xterm root.** xterm.js explicitly sizes the `.xterm-screen` child (`cols × cellW`, `rows × cellH`) but leaves the outer `.xterm` / the root element we pass to `Terminal.open()` as block-level wrappers that fill their parent horizontally. Reading `offsetWidth` off the outer root therefore returns the tile's content width, not xterm's natural grid width — HS-6931 traced a user-reported `scale(3.478, 0.375)` to exactly this mismatch. The client always measures `.xterm-screen`'s `offsetWidth` / `offsetHeight` as the authoritative natural size.

**Why a fixed-aspect grid (and the PTY-resize trade-off this implies — HS-7097).** The tile's xterm has a fixed 4:3 cols × rows derived from measured cell metrics rather than a `fit()` to the live tile pixel size, so the slider / window-resize / project-swap flows don't generate a cascade of PTY `resize` messages. The PTY is resized **once** on attach (and again on dedicated-view exit) to match the tile's pre-computed 4:3 dims. The earlier "leave the PTY at whatever size another subscriber set, treat the tile as a pure visual mirror" approach was simpler but regressed the user's screenshot test — see HS-7097 for the full back-and-forth. The accepted trade-off:

1. **Other attachers may briefly see reflow.** The drawer / other Tauri windows have their own `fit()` and re-resize the PTY back to their dims when the user switches focus to them. There's a one-redraw blink while a TUI like `nano` re-lays-out for the new geometry. Acceptable, because the resize only fires on dashboard enter / exit and dedicated view enter / exit — not on every window drag.
2. **Tile bytes during a dedicated-view session are formatted for the dedicated pane, not the tile.** The dedicated view's `fit()` drives the PTY while it's open; the tile shows those bytes wrapped inside its narrower buffer. On dedicated-view exit, `exitDedicatedView` re-sends the tile's `targetCols × targetRows` so the PTY snaps back to tile geometry and the visible TUI redraws to fit the tile. Brief mid-transition mismatch is accepted in exchange for an aspect-correct preview when the user is actually looking at the grid.
3. **Eager-spawn defaults still apply on first attach.** When the tile is the first subscriber to a never-attached PTY, `?cols=&rows=` is omitted from the WebSocket URL so HS-6799's first-attach cleanup doesn't fire — the resize message arrives via JSON after the history frame, hitting `resizeTerminal` directly (which bypasses the `attach` path's never-shrink rule the same way the dedicated view's resize does).

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

Single-clicking a live tile smoothly transforms it to a centered overlay at roughly **70 % of the viewport** (both dimensions), keeping the 4:3 ratio. Implementation-wise this is still a uniform `transform: scale(s)` on the same xterm root — the scale is larger, the xterm is letterbox-centered inside the enlarged preview, and the tile's container element is positioned absolutely in the viewport center with a fade-in dim backdrop behind it.

**Grow-from-slot animation (HS-6867).** When a tile is clicked, a grey placeholder of the tile's current grid size is inserted into the tile's slot before the tile is promoted to the fixed-position overlay. The surrounding tiles therefore do **not** reflow. The tile itself runs a FLIP (First, Last, Invert, Play) transform animation: it is placed at its final centered geometry, given an inverse `translate(dx, dy) scale(sx, sy)` that visually pins it at the original slot, then in the next frame that transform is removed with a `transform` transition — the browser interpolates the transform so the tile appears to grow out of its grid slot toward the center. Uncentering runs the same animation in reverse against the placeholder's current bounding box, then removes the placeholder and returns the tile to the grid flow.

**Centered-tile width invariant (HS-6964).** The tile is a `display: flex; flex-direction: column; align-items: center` container, so if `tile.style.width` stays at the grid-slot value when `centerTile` writes the larger `preview.style.width`, flex-centering slides the preview around the smaller tile box and the preview's visual centre ends up off to the left of the viewport centre (visible as "scaling not quite right" in HS-6964). The fix: `centerTile` sets `tile.style.width = previewWidth` too — flex-centering becomes a no-op and the preview sits exactly where `targetLeft = (vw - previewWidth) / 2` puts it. `applyTileSizing` skips centered tiles on window resize (otherwise the resize would snap the inline width back to the grid-slot value), and the dashboard's resize handler calls `recenterTile` to recompute the centered tile's left / top / width / height for the new viewport so it tracks the viewport centre on resize instead of staying anchored to its initial geometry.

**No preview width / height transition (HS-7096).** The preview element has **no CSS `transition` on `width` / `height`** — slider drags and window resizes must snap instantly, not animate, or the tile visibly ripples through intermediate sizes and the xterm's `transform: scale(..)` chases the animating box instead of matching it. The only size-change animation the dashboard runs is the FLIP `transform` animation on the **tile root** during center / uncenter (centerTile / finishUncenterTile), which runs independently of the preview's own width / height. Earlier iterations carried a `transition: width 0.25s ease, height 0.25s ease` for the center / uncenter grow, which centerTile / recenterTile / finishUncenterTile then had to temporarily disable with inline `transition: none` + reflow + restore — removing the CSS transition eliminated both the ripple regression and the transition-dance in JS.

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

**Post-replay refit (HS-7063).** `fit()` has to run a second time *after* the server's `history` frame is replayed. The replay does `term.resize(historyCols, historyRows)` so the scrollback bytes render at the dims they were formatted for — but that resize fires xterm's `onResize`, which the dedicated view relays to the server, which shrinks the PTY to the history dims (typically the drawer's narrower/shorter geometry). The dedicated view is a full workspace, not a peek, so the post-replay fit restores the xterm to the pane size and (via the same relay) grows the PTY back. Without this, TUIs like `nano` / `vim` / `less` stay at the prior attacher's dims and leave the bottom of the pane empty. The helper is `applyDedicatedHistoryFrame(term, fit, frame)` in `src/client/terminalReplay.ts` and is unit-tested in `terminalReplay.test.ts`.

**Dismissal (returns to the dashboard grid, _not_ to the normal ticket view):**
- Click **Back**.
- Press **Esc**.
- Click the dashboard toggle button — this path exits dashboard mode entirely (per §25.3 rule 1). The dedicated view closes along with the dashboard.
- Click any project tab — exits dashboard mode and switches to that project's ticket view (per §25.3 rule 3). The dedicated view closes along with the dashboard.

**Tile xterm stays at tile-native dims across dedicated-view transitions; PTY snaps back on exit (HS-7097 follow-up).** The dedicated view's `fit()` resizes the PTY to the dedicated pane geometry as soon as the user double-clicks, and the server broadcasts bytes formatted for those dims to every subscriber including the grid tile's WebSocket. The grid tile's xterm stays at its own tile-native 4:3 cols × rows during the dedicated session, so live PTY bytes wrap inside the tile's narrower buffer — this is the brief mid-transition mismatch §25.5's trade-off list calls out. On `Back` / `Esc`, `exitDedicatedView` sends a `'resize'` message with the tile's stored `targetCols × targetRows` so the PTY snaps back to tile-native dims and the running TUI gets a `SIGWINCH` and redraws to fit the tile again. Without that exit-path resend, the tile would be stuck displaying bytes formatted for the dedicated pane's geometry until the user switched terminals or the drawer's `fit()` ran. Earlier iterations (HS-7099 and its follow-up) instead kept the tile's xterm in lockstep with the dedicated view's geometry on every `onResize`; that was reverted because mirroring locked the tile's natural aspect to the (typically non-4:3) dedicated-pane geometry and defeated the aspect-correct-preview goal.

**Symmetric body padding + inner pane wrapper (HS-7098).** `.terminal-dashboard-dedicated-body` uses `padding: 16px` on all four sides (previously `8px 12px 12px` — asymmetric top vs bottom, and a tight 8 px gap against the back-bar border that read as "no top margin"). The xterm is NOT opened directly inside `-body` — it opens inside an inner `.terminal-dashboard-dedicated-pane` flex child that has no padding. Why: FitAddon reads `getComputedStyle(xterm.element.parentElement).height / width` to decide cols × rows, and with the app-wide `box-sizing: border-box` reset those values include the parent's own padding. Opening xterm directly in the padded `-body` therefore made fit overcount the available rows by `padding * 2 / cellHeight` and the bottom of the content (e.g. nano / pico key-hint rows) got clipped below the viewport edge — exactly the regression from the HS-7098 "still not good" screenshot. Splitting the visual frame (`-body` padding) from the fit target (`-pane`, unpadded) fixes it cleanly: the user still sees a 16 px frame on all four sides, and fit sees the real available space.

**Center the xterm inside the pane so the frame is even on all sides (HS-7098 follow-up).** After the body-padding + inner-pane split fixed the "bottom clipped off" regression, a smaller "implied right margin" remained: FitAddon picks integer cols × rows and xterm inline-sizes `.xterm-screen` to `cols * cellW × rows * cellH`, which is necessarily ≤ the pane (slop of up to one cell on the right / bottom). The outer `.xterm` root is a block-level wrapper that fills the pane, so that slop shows through as an asymmetric right-side gap inside `.xterm` but outside `.xterm-screen`. Fix: `.terminal-dashboard-dedicated-pane` is now a flex container with `align-items: center; justify-content: center`, and the direct `.xterm` child is set to `flex: 0 0 auto` so it shrinks to its content width (`.xterm-viewport` / `.xterm-helpers` are absolutely positioned and don't contribute to intrinsic width — only `.xterm-screen` does). The sub-cell slop becomes symmetric left/right padding inside the pane, and the visible frame around the rendered terminal reads as even on all four sides. FitAddon still reads the full pane dims (it uses `parent.clientWidth / clientHeight`, unaffected by children), so the cols × rows chosen are the same as before — only the rendering is visually centered.

**Transitions between center and dedicated:**
- Double-click on a centered tile → slides into the dedicated view.
- Double-click on a grid tile → goes straight to the dedicated view (skipping the center overlay).
- Back from the dedicated view → returns to whichever of grid / centered the user was in before entering dedicated view.

**Bell clearing.** Entering the dedicated view on a tile with `has-bell` clears the outline and fires `/api/terminal/clear-bell`.

**Tile-size slider is hidden in dedicated view (HS-7195).** The header slider from §25.4 only controls grid-tile dims; it's meaningless in a single full-viewport terminal. `enterDedicatedView` hides `#terminal-dashboard-sizer` and `exitDedicatedView` restores it (the dashboard must still be active on exit — the dedicated view is only reachable from the grid). Regression covered by `terminal-dashboard.spec.ts` "tile-size slider is hidden while the dedicated view is open".

**Focus.** Keyboard focus moves to the xterm helper textarea on enter so users can immediately type.

**Only one dedicated view at a time.** Switching to a different tile closes the first one.

## 25.8.5 Tile context menu (HS-7065)

Right-clicking any tile — live, lazy, or exited — opens a small context menu positioned at the pointer with two entries, matching the drawer terminal tab menu (§22 / HS-6668, HS-6701) minus the linear-order actions that don't fit a 2D grid:

1. **Close Tab.** Destroys the terminal via `POST /api/terminal/destroy`. Enabled only for dynamic terminals (created via the drawer's `+` or the dashboard's §25.4 plus button). Configured terminals from `settings.json` are intentionally not closable here — the Settings → Terminal panel is the source of truth for those, and a one-click destroy in the dashboard would silently diverge from the saved config. Alive dynamic terminals route through the same in-app confirm dialog the drawer uses (`confirmDialog` with "Close terminal?" message); exited / never-spawned tabs close silently. After destroy, the dashboard refreshes via `refreshDashboardGrid()` so the tile disappears.
2. **Rename...** Opens the same transient rename dialog the drawer uses (HS-6668) — updates the tile's label in place without persisting to `settings.json`. A dashboard refresh (manual `+` button, context-menu close, project list change) OR a page reload restores the original configured / server-derived name.

**Why no "Close Tabs to the Left / Right".** The drawer tab strip is a single linear sequence; the dashboard is a wrapping 2D flex grid where "left" and "right" aren't well-defined across row breaks. Dropping those two menu items was an explicit HS-7065 call-out.

Menu dismissal follows the same pattern as the drawer tab context menu: capture-phase document click/contextmenu listener dismisses when the pointer lands outside the menu; the menu clamps to the viewport on open so it doesn't overflow bottom-right.

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

- The project heading + its `+` button (§25.4 HS-7064).
- A single muted row in place of the grid: `No terminals configured.` (The old "open Settings → Terminal to add one." text was removed in HS-7064 now that the inline `+` button offers a one-click path.)

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

1. **Enter / exit.** Click the `square-terminal` button before the project tabs — the ticket area disappears, the grid appears. Click again → back to tickets. Press Esc on the bare grid → back to tickets.
2. **Project-tab navigation from dashboard.** Click another project's tab while the dashboard is active — dashboard closes and that project's ticket view activates.
3. **Grid sizing (slider).** With several projects each containing 2–4 terminals, slide the size slider from left to right. Every tile should resize uniformly and stay 4:3. At slider = 0 the tile collapses to the ~133 × 100 floor; at 100 the tile fills the full root width on a single column. Shrink the window vertically until content vertical-scrolls even at the floor.
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
- **Tickets:** HS-6272 (this doc), HS-6867 (grow-from-slot animation), HS-6868 (no active tab while open), HS-6898 (non-uniform tile scale — superseded), HS-6931 (uniform scale + cols × rows computed from measured cell metrics so natural aspect ≈ 4:3 — superseded by HS-6965, partially re-adopted by HS-7097 follow-up), HS-6964 (centered tile width = preview width so flex-centering doesn't slide the preview off-centre; re-centre on window resize), HS-6965 (adopt the PTY's cols × rows from the history frame — superseded by HS-7097 follow-up which keeps PTY dims only during replay and resizes back to tile-native 4:3 after), HS-6997 (top-align the scaled xterm inside the tile so dead vertical space falls below the content, not sandwiching it top and bottom), HS-7030 (lucide `square-terminal` glyph on the toggle button), HS-7031 (manual size slider replaces the auto-fit algorithm), HS-7063 (post-replay refit in dedicated view so TUIs like nano fill the full pane instead of staying at the prior attacher's dims), HS-7064 (per-project `+` button in the heading row creates a dynamic terminal inline), HS-7065 (right-click tile context menu with Close Tab + Rename, no close-left / close-right variants), HS-7096 (no CSS transition on preview width / height — slider and window resize snap instead of animating), HS-7097 (post-history rescale via `.xterm-screen` ResizeObserver; follow-up pins the tile's xterm to tile-native 4:3 dims; final follow-up pushes a `'resize'` message to the PTY itself so a running TUI like `nano` redraws to fill the tile-native geometry — the previous local-only buffer resize left rows past the PTY's row count empty), HS-7098 (symmetric 16 px padding in the dedicated view body + flex-centered `.xterm` child so the frame around the rendered terminal reads as even on all four sides), HS-7099 (grid tile xterm resyncs to the dedicated view's final cols × rows on exit — superseded by HS-7097 follow-up which keeps the tile at tile-native dims across dedicated-view transitions), HS-7129 (slider default dropped from 50 → 33 so the dashboard opens with ~three tiles per row instead of one big tile).
