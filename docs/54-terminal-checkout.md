# 54. Global Terminal Checkout (xterm Stack + Virtualization)

HS-7969 follow-up. A single xterm.js instance per `(projectSecret, terminalId)` lives in a new `terminalCheckout` client module. Every consumer (drawer pane, dashboard tile, dashboard dedicated view, drawer-grid tile, drawer-grid dedicated view, quit-confirm preview pane) calls `checkout(...)` to claim it and gets a `release()` handle back. The most recent checkout wins (LIFO stack); previous owners' mounts swap to a placeholder. When the stack is empty, the xterm is **disposed** to reclaim memory — the PTY survives on the server, and the next `checkout` re-creates the xterm and the WebSocket attach replays the scrollback.

> **Status:** Phase 1 shipped (HS-8031). Phase 2 splits into 5 sub-tickets per HS-8032's Option A. Sub-tickets shipped: HS-8041 (quit-confirm preview, §54.6), HS-8042 (dedicated-view path, §54.7), HS-8048 (tile preview, §54.8), HS-8043 (dashboard verification — closed as no-op since the shared-module migration flowed through), **HS-8044 (drawer pane, §54.9)** + **HS-8045 (cleanup — §37 ANSI-spans path deleted, §54.10)**. Phase 2 is fully complete.

## 54.1 Why

Today a single client-side xterm.js instance can only be mounted in one place at a time. The drawer pane, dashboard tile, dashboard dedicated view, drawer-grid tile, drawer-grid dedicated view, and (post-HS-7969) the quit-confirm preview pane all want a "live terminal" view of the same terminal. The status quo:

- The drawer pane owns the only client-side instance per terminal-id (`src/client/terminal.tsx::instances`). When the dashboard or drawer-grid wants to render the same terminal, it has to reach into the drawer's mount and DOM-reparent the xterm — see `terminalTileGrid.tsx::centerTile` / `enterDedicatedView`. This works for the active project's drawer ↔ dashboard handoff but doesn't generalise across projects.
- The quit-confirm dialog spans **every project**, so a row could point to a terminal whose xterm has never been mounted in the current page session. Today the dialog falls back to a static ANSI-spans preview (HS-7969 follow-up #2). The user's verdict: "still not great — doesn't really match what the real terminals look like fully."
- Memory grows linearly with `(projects × terminals × mount surfaces)` if every consumer holds its own xterm. Today's "drawer owns it" model accidentally caps memory at one xterm per terminal, but at the cost of cross-project preview fidelity.

A global checkout module solves both: one xterm per terminal across every consumer + every project, and **virtualization** that disposes the xterm entirely when no consumer is holding it.

## 54.2 Decisions (locked in 2026-04-30)

The user weighed in on the seven open design questions raised in HS-7969 feedback. Locked answers:

1. **Resize cadence.** Only resize the PTY (`term.resize` + `ws.send({type:'resize'})`) when `cols`/`rows` actually changed (zero-tolerance compare). Most checkout swaps are same-size and skipping the resize avoids SIGWINCH storms in TUI programs (`htop`, `vim`, `claude`).
2. **Placeholder fidelity.** Plain text — `Terminal in use elsewhere` chip with no live updates. The frozen-snapshot option (b) was on the table but only if it could match the live xterm pixel-for-pixel. Cell metrics, box-drawing glyph alignment, and font kerning don't translate cleanly from xterm.js's canvas renderer to a CSS-painted `<pre>`, so we'd land on a "looks like the live terminal but isn't quite right" gap that costs trust. Option (a) ships the unambiguous version. (b) stays as a follow-up if a user complains.
3. **Quit-confirm preview as a consumer.** The §37 preview pane is a real checkout — clicking a row pushes a fresh `checkout` for that `(secret, terminalId)`, the existing mount (drawer / dashboard / etc.) drops to the placeholder, the live xterm DOM-reparents into the preview pane, and `release()` on dialog dismiss restores the prior mount. Solves HS-7969's original ask cleanly and obsoletes the current ANSI-spans preview path.
4. **Click-to-reclaim from a placeholder.** No auto-reclaim. A drawer pane showing "Terminal in use elsewhere" doesn't steal the xterm back on click — the user has to dismiss whatever pushed the new checkout (close the dashboard, close the quit dialog, etc.). Keeps the LIFO stack predictable; an auto-steal would mean clicking near a placeholder thrashes the SIGWINCH cadence (see §54.2.1).
5. **Lazy terminals in quit-confirm.** Lazy-never-spawned terminals don't appear in the quit-confirm list at all — there's nothing running to ask about. The §37 dialog already filters its rows on alive-state via `/api/terminal/list-running` (see [37-quit-confirm.md](37-quit-confirm.md) §37.5); this design just confirms that. **No regression risk** — the existing scrollback-preview endpoint is unaffected.
6. **Cross-project lifetime + virtualization.** The xterm-instance map lives in the new `terminalCheckout` module and survives project switches. **When the LIFO stack drops to zero consumers, the xterm is disposed** — its memory is reclaimed, but the PTY keeps running on the server, and the next `checkout` rebuilds the xterm + WebSocket-attaches + replays the scrollback (the server already replays scrollback on attach — `src/terminals/registry.ts::attach` returns `history` and the WebSocket handler writes it before live data). This means the dashboard's existing virtualization (only mount tiles in the visible viewport) continues to work — un-mounted tiles release their checkout and the xterm goes away.
7. **Phasing.** Two phases, not three:
   - **Phase 1 (HS-8031):** Build `terminalCheckout.ts` + the placeholder rendering + virtualization (auto-dispose on empty stack). Pure infrastructure with full unit + Playwright coverage. **No UI consumers wired** — the existing drawer / dashboard / drawer-grid / quit-confirm code paths keep working as-is. The module ships with a stub consumer used only by tests.
   - **Phase 2 (HS-8032):** Migrate every consumer to the checkout API: drawer pane, dashboard tile + dedicated, drawer-grid tile + dedicated, quit-confirm preview pane. The §37 ANSI-spans preview path (`src/client/ansiSpans.ts`) and the `GET /api/terminal/scrollback-preview` route can be deleted once the quit-confirm migration is complete and verified.

### 54.2.1 Why no auto-reclaim (decision 4)

Multi-window OSes auto-focus on click because the focused window is the *active* window — there's no concept of "the other window is using it." For terminals, the other consumer is *literally rendering the live xterm at a specific size*, and a steal would (a) trigger an immediate SIGWINCH if the new mount is a different size and (b) leave the previous owner with a stale placeholder until they close their UI. The user explicitly chose (a) so that quitting the dashboard / closing the dialog is the only way back; mount changes correspond exactly to user-visible state changes.

## 54.3 Module surface

New file: `src/client/terminalCheckout.tsx`. Sole exported function plus the handle type:

```ts
export interface CheckoutOptions {
  projectSecret: string;
  terminalId: string;
  cols: number;
  rows: number;
  /** The container element the xterm should be mounted into when this checkout
   *  holds the top-of-stack position. Must be empty when checkout() is called;
   *  the module owns its contents until release() returns. */
  mountInto: HTMLElement;
  /** Called when a newer checkout pushed this one down. The consumer should
   *  show a placeholder in its own UI region — the module already wrote one
   *  into `mountInto` (the live xterm has reparented into the new owner). */
  onBumpedDown?: () => void;
  /** Called when this checkout is restored to the top of the stack (the newer
   *  owner released). The live xterm has reparented back into `mountInto`;
   *  the placeholder is gone. */
  onRestoredToTop?: () => void;
}

export interface CheckoutHandle {
  /** Release this checkout. If this was the top of the stack, the next-most-
   *  recent consumer's `onRestoredToTop` fires. If it was the only consumer,
   *  the xterm is disposed and the WebSocket is closed. */
  release(): void;
  /** The live xterm instance. Stable for the lifetime of this handle, even if
   *  the consumer is bumped down — the consumer just won't be rendering it.
   *  Consumers that need to fire xterm APIs (search, focus, etc.) check
   *  `handle.isTopOfStack()` first. */
  term: XTerm;
  isTopOfStack(): boolean;
}

export function checkout(opts: CheckoutOptions): CheckoutHandle;
```

Internally:

- A `Map<string, StackEntry>` keyed on `${secret}::${terminalId}` (matches `src/terminals/registry.ts::sessionKey`).
- Each `StackEntry` holds `{ term, fit, search, ws, scrollbackReplayed, stack: CheckoutHandle[] }`.
- `checkout()` either creates the entry (lazy xterm + ws-attach + scrollback replay) or pushes onto the existing entry's stack. The previous top-of-stack consumer's `mountInto` gets a placeholder div; the live xterm DOM-reparents into the new caller's `mountInto`.
- `release()` pops the handle from the stack. If it was the top, the next handle (if any) takes the live xterm back. If the stack is empty, the entry is disposed: `term.dispose()`, `ws.close()`, map entry deleted.

### 54.3.1 Resize policy (decision 1)

Inside `checkout()`, after a stack swap, compare the new top's `(cols, rows)` to the entry's last-applied `(cols, rows)`. Skip the resize call when they're equal. Apply both `term.resize(c, r)` and `ws.send({ type: 'resize', cols: c, rows: r })` when they differ. The **server-side** registry never shrinks (see `src/terminals/registry.ts::attach` lines 210-220) — the module respects this by always sending the larger of `(current, requested)` for the resize, but the client's xterm always renders at the requested size (xterm's reflow handles cells that the PTY doesn't know about).

### 54.3.2 Placeholder shape (decision 2)

When a consumer is bumped down, the module writes the placeholder into the consumer's `mountInto`:

```html
<div class="terminal-checkout-placeholder">
  <div class="terminal-checkout-placeholder-icon">
    <!-- lucide terminal-square SVG -->
  </div>
  <div class="terminal-checkout-placeholder-text">Terminal in use elsewhere</div>
</div>
```

`onBumpedDown()` lets the consumer apply additional UI cues (dim the surrounding tile, suppress hover highlights, etc.). The placeholder is plain text — no live ANSI rendering, no animation, no click affordance.

### 54.3.3 Virtualization on empty stack (decision 6)

When the last `release()` empties the stack, the entry is fully torn down:

- `term.dispose()` — frees the canvas + addon memory.
- `ws.close()` — frees the per-attach socket. The server-side `detach` removes this subscriber from `session.subscribers`; the PTY keeps running because at least the always-on session is alive.
- Entry removed from the module map.

The next `checkout()` for the same `(secret, terminalId)` is identical to a first-ever checkout: create xterm, open WebSocket, the server's attach replay fires (`history` field on `AttachResult` carries the scrollback ring buffer), the client writes that history before live data, the user sees the same scrollback they would have if the terminal had been mounted continuously.

This is what makes the dashboard's existing tile virtualization (HS-6272 + HS-7825) viable across the new checkout system — un-mounted tiles drop their checkout, memory is reclaimed, re-scrolling re-mounts and re-attaches.

## 54.4 Consumer migrations (Phase 2)

Each surface gives up its private xterm management and calls `checkout(...)`:

| Surface | File | Notes |
|---|---|---|
| Drawer pane | `src/client/terminal.tsx` | The biggest delete. `instances`, `removeTerminalInstance`, `disposeAllInstances`, `onProjectSwitch` all simplify drastically. The drawer keeps its tab-strip + status-dot + bell logic, but the xterm-mount layer is now `checkout()` + `release()` on tab activation. |
| Dashboard tile (centered + tile preview) | `src/client/terminalTileGrid.tsx` | `centerTile` becomes `checkout(... mountInto: centeredTileBody)` instead of DOM-reparenting from the drawer. |
| Dashboard dedicated view | `src/client/terminalDashboard.tsx` | Same — `enterDedicatedView` becomes a checkout. The current FitAddon-fresh-mount pattern is replaced by the checkout module's xterm + a re-`fit()` call after the swap. |
| Drawer-grid tile + dedicated | `src/client/drawerTerminalGrid.tsx` | Mirror of the dashboard surfaces. |
| Quit-confirm preview | `src/client/quitConfirm.tsx` | Replaces `paintPreviewContent` (the ANSI-spans path). On row select, checkout for that `(secret, terminalId)` with a fixed `(cols=80, rows=30)` (the preview pane's natural size). On dialog dismiss / row change, release. |

Once Phase 2 lands, the following can be deleted:

- `src/client/ansiSpans.ts` (and `ansiSpans.test.ts`).
- `src/terminals/scrollbackSnapshot.ts::buildScrollbackPreviewWithAnsi` (the ANSI-preserving variant — the stripped variant might still be useful for the §53 partial-output flow; check before removing).
- `GET /api/terminal/scrollback-preview` route + its `textWithAnsi` field + the `getTerminalScrollbackPreviewWithAnsi` registry helper.
- The `paletteFromTheme` + `paintPreviewContent` helpers in `quitConfirm.tsx`.

## 54.5 Tests

### 54.5.1 Phase 1 (infrastructure) — **shipped**

17 unit tests in `src/client/terminalCheckout.test.ts` (happy-dom — the module detects `typeof WebSocket === 'undefined'` and bails to ws=null so the stack semantics are testable without a real socket):

- **Single consumer**: creates an entry on first checkout / mounts the live xterm element into mountInto / disposes the entry when the only consumer releases / `release()` is idempotent.
- **LIFO stack**: pushes a second checkout — placeholder writes into the previous mountInto + live xterm reparents into the new caller's mountInto + `onBumpedDown` fires once / `release()` of the top restores the previous consumer + `onRestoredToTop` fires / `release()` of a non-top handle leaves the live xterm where it is / disposes the entry only when the LAST consumer releases.
- **Resize policy** (decision 1): updates `lastApplied` dims when the new top requests a different size / **skips** `term.resize` when same-size (verified via `vi.spyOn(term, 'resize')`) / fires `term.resize(cols, rows)` when different-size / restoring a previous consumer applies their dims even if intermediate top was different.
- **Cross-project independence**: two different secrets for the same terminalId get independent entries + independent xterms / releasing one project doesn't affect the other.
- **Re-checkout after empty-stack dispose** (decision 6 / §54.3.3): a fresh checkout after the entry was disposed creates a brand-new xterm instance.
- **`_inspectStackForTesting`** helper: empty case + reports key / secret / terminalId / dims / depth / topMountInto.

Playwright e2e for Phase 1 was **deferred to Phase 2** — Phase 1 has no UI consumer, so the e2e would need a stub HTML surface. Phase 2 (HS-8032) migrates real consumers and the existing per-surface e2es become integration coverage for the checkout module for free.

### 54.5.2 Phase 2 (UI hookup)

Existing tests for each migrated surface stay green. New regression tests:

- Dashboard virtualization: scroll a 50-tile dashboard, verify only the visible-viewport tiles hold a checkout (assert via the module's debug-only `_inspectStackForTesting()` helper, exported only when `process.env.NODE_ENV === 'test'`).
- Dashboard ↔ drawer race: open the dashboard, dedicated-view a tile, close the dashboard. The drawer pane regains the live terminal without a flash of placeholder.
- Quit-confirm dismiss-while-loading: open the dialog, click row A, click row B before A's checkout settles. Verify the cancel order is correct (A's `release()` fires before B's `checkout()` settles, so we don't briefly wedge the stack).

## 54.6 Phase 2.1 — Quit-confirm migration (HS-8041)

Phase 2.1 ships the smallest of the five Option-A surfaces. `src/client/quitConfirm.tsx`'s preview pane is the only `terminalCheckout` consumer wired up; the drawer pane, dashboard tile + dedicated, and drawer-grid tile + dedicated continue to use their pre-existing per-surface xterm management until §54.7 / §54.8 / §54.9 ship in HS-8042 / HS-8043 / HS-8044. The §37 ANSI-spans path keeps serving the (still-not-migrated) other surfaces until the cleanup ticket (HS-8045 — sub-ticket 5 of HS-8032) lands.

### 54.6.1 Surface change

Pre-fix: row-select fetched `/api/terminal/scrollback-preview` (returns `text` + `textWithAnsi` + theme/font ids), painted the `<pre class="quit-confirm-detail-preview">` with `paintPreviewContent` (calls `ansiToSafeHtml` over `textWithAnsi`), and applied the resolved theme + font as inline styles via `applyAppearanceToPreview`. Static snapshot — no live updates, palette approximation that the user (HS-7969) flagged as "still not great — doesn't really match what the real terminals look like fully."

Post-fix: row-select calls `checkout({ projectSecret, terminalId, cols: 80, rows: 30, mountInto: previewEl })` for the clicked row's terminal. The live xterm DOM-reparents into the dialog's preview pane; whichever consumer was previously rendering it (drawer pane / dashboard tile / drawer-grid tile / etc.) drops to the placeholder per §54.3.2. On dialog dismiss / row swap the handle is `release()`d — if the only consumer, the entry is disposed and the previous mount disposes too (§54.3.3); if a previous consumer is still in the LIFO stack (e.g. the user opened the dialog from the drawer with the same terminal already mounted there), the live xterm reparents back and that consumer's `onRestoredToTop` fires.

The preview pane is now a `<div class="quit-confirm-detail-preview">` (was `<pre>`) — xterm requires a regular block container for its mount.

### 54.6.2 cols / rows hardcoding

Statically wired to **80 × 30** via the new `QUIT_PREVIEW_COLS` / `QUIT_PREVIEW_ROWS` module-level constants. Dialog is fixed-width and the preview pane doesn't track viewport changes — recomputing from the live `.quit-confirm-detail-preview` cell metrics on dialog resize was considered and deferred (file a follow-up if real-use shows the hardcode mismatches the natural pane size).

### 54.6.3 Cancel-then-checkout ordering

Critical contract for the row-swap path: `release()` on the prior handle **must** happen before `checkout()` for the new row. Reverse order would briefly leave the LIFO stack holding `[prior, new]` both pointing at the same `mountInto` element (`previewEl`). The intermediate swap step would write the placeholder into `previewEl`, then immediately reparent the new xterm OVER it — visible flash, plus the prior handle's release path would have to walk an unexpected stack shape (`indexOf(handle) === 0` while `stack.length === 2`) on cleanup. The contract is pinned by 5 unit tests in `src/client/quitConfirm.test.ts` (the `quit-confirm preview pane checkout (HS-8041 §54.5.2)` describe block) using `_inspectStackForTesting()` + `entryCount()` to assert single-entry / single-depth invariants throughout a row-click burst.

### 54.6.4 Dormant helpers

Per the HS-8041 ticket scope, `paintPreviewContent` + `paletteFromTheme` (and the now-orphaned `fetchScrollbackPreview` + `applyAppearanceToPreview`) are kept inside `quitConfirm.tsx` until the HS-8045 cleanup sub-ticket. Three `void fetchScrollbackPreview; void applyAppearanceToPreview; void paintPreviewContent;` references at the bottom of the file defeat `@typescript-eslint/no-unused-vars` without an inline disable, mirroring the existing `void flat;` pattern at the bottom of `showQuitConfirmDialog`. Once every Phase 2 sub-ticket has migrated, the cleanup deletes:

- `src/client/ansiSpans.ts` + `ansiSpans.test.ts`
- `GET /api/terminal/scrollback-preview` route + `textWithAnsi` field + `getTerminalScrollbackPreviewWithAnsi` registry helper
- `src/terminals/scrollbackSnapshot.ts::buildScrollbackPreviewWithAnsi`
- `paletteFromTheme`, `paintPreviewContent`, `fetchScrollbackPreview`, `applyAppearanceToPreview` in `quitConfirm.tsx` (and the `void` references)
- The `ScrollbackPreviewResponse` interface

### 54.6.5 Test-only export

`showQuitConfirmDialog` was previously module-private; it's now exported so the dismiss-while-loading race regression can drive the dialog's mount + row-click choreography directly. Production callers continue to enter via `runQuitConfirmFlow()`. Marking this with the same convention as `terminalCheckout.tsx::_inspectStackForTesting` (underscore prefix) was considered and rejected — `showQuitConfirmDialog` is already a clear API surface, not a debug introspection helper.

## 54.7 Phase 2.2 — Dedicated-view migration (HS-8042)

Phase 2.2 was originally scoped as the full drawer-grid migration (tile preview + center + dedicated). Implementation surfaced two complications that pushed the tile preview migration to a follow-up ticket (**HS-8048**), and reduced this sub-ticket's scope to **dedicated view only**:

1. **xterm config differs per consumer.** Tile uses `cursorBlink: false` + `scrollback: 1000` (HS-7990); dedicated uses `cursorBlink: true` + `scrollback: 10_000`. With shared xterm via checkout, runtime option overrides via `term.options =` are needed on every stack swap. Tractable but requires careful sequencing.
2. **History-frame replay needs resize-first-write semantics.** Tile uses `replayHistoryToTerm` (resize term to history dims, write bytes, then resync to tile-native); dedicated uses `applyDedicatedHistoryFrame` (same plus a final `fit.fit()`). Phase 1's checkout module just did `term.write(buf)` without pre-resizing — fine for the quit-confirm preview pane (HS-8041) where history is short, but real terminals with long scrollback would render at wrong dims. **HS-8042 fixed this in `terminalCheckout.tsx` for everyone**: the WS message handler now reads `cols`/`rows` from the history frame and calls `term.resize(cols, rows)` before `term.write(buf)`. The consumer's intended dims are then restored by their own resize path (e.g. dedicated's `fit.fit()` echo via `term.onResize` → `handle.resize`).
3. **Tile preview uses CSS scaling on a native-cols xterm** + has virtualization (`IntersectionObserver`-driven mount/dispose). Migrating the tile path to checkout requires reasoning about how the live xterm element's CSS state (transform, position) carries across stack swaps. HS-8048 is the right place to design that.

The dedicated-view migration (this ticket) is clean: dedicated has its own pane, runs `fit.fit()` for native dims, no CSS scaling. Pre-fix dedicated spawned a SECOND xterm + SECOND WebSocket attached to the same PTY (alongside the tile's own xterm + WS); post-fix the dedicated path goes through `terminalCheckout`, eliminating the dedicated-side xterm-spawning code path.

### 54.7.1 Surface change

Pre-fix `enterDedicatedView` constructed `new XTerm({...})` + `new FitAddon()` + `new WebSocket(...)` directly. The dedicated-side xterm was distinct from the tile's xterm — both attached to the same PTY as separate subscribers. On `exitDedicatedView` the dedicated xterm was disposed and the WS closed.

Post-fix: `enterDedicatedView` calls `checkout({ projectSecret, terminalId, cols: TILE_INITIAL_COLS, rows: TILE_INITIAL_ROWS, mountInto: pane })` — initial cols/rows are placeholders that `fit.fit()` resolves on the next animation frame. `term.onResize` fires when the addon resizes the term; the consumer routes that through the new `handle.resize(cols, rows)` API which both resizes the term (idempotent if same-size) AND sends the WS resize frame AND updates the entry's `lastApplied` bookkeeping. On `exitDedicatedView` the consumer calls `view.checkout.release()` — the entry's only consumer (dedicated) drops to zero stack depth, the entry is fully disposed (xterm + WebSocket).

### 54.7.2 Module additions to `terminalCheckout.tsx`

Two new public surface additions on `CheckoutHandle`:

- **`fit: FitAddon`** — exposes the FitAddon already loaded by entry construction. Dedicated-style consumers wire `fit.fit()` to a `ResizeObserver` on their pane.
- **`resize(cols, rows): void`** — same skip-on-same-size rule as the swap-time path. Routes through `applyResizeIfChanged` so consumers that respond to live layout changes (fit-driven, manual resize requests) update the entry's bookkeeping AND fire a WS resize frame in one call. Pre-HS-8042 `applyResizeIfChanged` was only invoked at checkout / release time; consumers that wanted a mid-checkout resize had no clean API.

The history-frame WS message handler also gained a resize-first-write step when the message carries `cols`/`rows` (which the server's `attach()` always does). This is module-internal so consumers stay the same — but it's the load-bearing fix for the dedicated migration's history-replay correctness.

### 54.7.3 What stays legacy in HS-8042

- **Tile preview** (`mountTileXterm` + `connectTileSocket` in `terminalTileGrid.tsx`) — still creates a per-tile xterm + WS directly. The 41 callsites of `tile.term` / `tile.ws` / `tile.xtermRoot` plus the CSS scaling complications make this a focused follow-up. **HS-8048** is filed for it.
- **Centered tile** — pure CSS state (FLIP animation transforms the existing tile DOM); no swap. Stays unchanged regardless of tile migration.

Result for users: **before HS-8048, opening a dedicated view temporarily creates 2 xterms** for the same terminal (tile's own + dedicated's via checkout). On exit, the dedicated checkout disposes and we're back to 1 xterm. Pre-HS-8042 same shape (2 xterms during dedicated, 1 otherwise). The HS-8042 win is that dedicated's xterm now lives in the centralized checkout map with the §54.3.3 virtualization lifecycle, and the resize-first history replay closes the latent HS-8041 bug for terminals with long scrollback. HS-8048 will collapse to 1 xterm even during dedicated.

### 54.7.4 Test additions

- `terminalCheckout.test.ts` — 2 new tests covering `handle.fit` exposure (same instance shared across consumers) and `handle.resize` semantics (skip-on-same-size guard, `lastApplied` updates, idempotent re-call). 19/19 in the file (was 17).
- No new tile-grid unit tests — the module has no existing unit-test surface (Playwright-only). E2E coverage for the dedicated migration relies on the existing `terminal-dashboard*.spec.ts` suite + manual spot-check.

## 54.8 Phase 2.2b — Tile preview migration (HS-8048)

Phase 2.2 split into HS-8042 (dedicated view, shipped at §54.7) and HS-8048 (tile preview, this section). HS-8048 completes the original Phase 2.2 scope by migrating the per-tile xterm + WebSocket management to `terminalCheckout`. With both paths migrated, opening a dedicated view for a terminal that already has a tile checkout pushes the tile down via the LIFO stack and reuses the **same** xterm — no longer creates a second xterm + second WebSocket attached to the same PTY. Memory savings scale with `(projects × terminals × dedicated-time)`.

### 54.8.1 Surface change

Pre-fix `mountTileXterm` constructed `new XTerm({fontFamily, fontSize: 13, cursorBlink: false, scrollback: 1000, allowProposedApi: true, cols: TILE_INITIAL_COLS, rows: TILE_INITIAL_ROWS, theme, linkHandler})` + `term.open(xtermRoot)` + `applyAppearanceToTerm` + `term.onData(ws.send(...))` + `term.onBell(...)` and `connectTileSocket` constructed `new WebSocket(url + secret + terminalId)` + `'message'` listener doing `term.write(data)` for binary chunks + `replayHistoryToTerm` for history frames + `resyncTilePtyFromCellMetrics` after history.

Post-fix the two are folded into a single **`mountTileViaCheckout(tile)`** that calls `checkout({projectSecret, terminalId, cols: TILE_INITIAL_COLS, rows: TILE_INITIAL_ROWS, mountInto: xtermRoot, onBumpedDown, onRestoredToTop})`. The checkout module owns the live xterm and the WS — keystroke-send (`term.onData`) is wired centrally inside checkout so every consumer of the shared xterm gets it for free. The tile registers a `term.onBell` handler that respects the HS-8046 auto-clear logic (skip the indicator when the tile is unoccluded + visible; mark `.has-bell` otherwise) and captures the disposer into `tile.termHandlerDisposers` so `softDispose` / full dispose drops the handler — without that, a re-mount of the tile would stack a second `onBell` on top of the first since the term is shared.

### 54.8.2 Per-consumer xterm config — unified

Pre-fix tile used `cursorBlink: false` + `scrollback: 1000` (HS-7990); dedicated used `cursorBlink: true` + `scrollback: 10_000`. With shared xterm via checkout, runtime overrides via `term.options =` on every stack swap is fragile — `scrollback` reduction at runtime can lose history. Decision (per the HS-8048 ticket scope): **unify to checkout's defaults (`cursorBlink: true, scrollback: 10_000`)**. The 10× scrollback bump for tile previews is fine — xterm allocates the ring lazily and the HS-7968 virtualization disposes off-screen tiles via `release()` so only the on-screen subset pays for the buffer.

### 54.8.3 CSS scaling across stack swaps

Tile previews use `applyTileScale(xtermRoot, tileWidth, tileHeight)` to CSS-transform the live xterm element down to fit the tile's preview area. Pre-fix the styles applied to a div that *contained* the xterm; post-fix they apply to the xterm element directly (since checkout's `mountInto.replaceChildren(term.element)` makes the xterm element a direct child of `xtermRoot`). The `applyTileScale` math is unchanged — it reads `.xterm-screen.offsetWidth/Height` to compute the scale ratio.

When the tile is bumped down by a dedicated view: the dedicated's `fit.fit()` clears the term element's CSS scale (its mount sets bare dims). When the tile is restored to top: `onRestoredToTop` calls `tile.checkout?.resize(TILE_INITIAL_COLS, TILE_INITIAL_ROWS)` to reset cols/rows, then `reapplyTileScaleFromPreview(tile)` to re-apply the tile-shape transform, then re-attaches the screen `ResizeObserver` (factored into a new `attachScreenObserver(tile)` helper since both initial mount and restore-to-top use it), then a final rAF to re-derive cell-metric dims via `resyncTilePtyFromCellMetrics`.

### 54.8.4 Virtualization integration

The HS-7968 IntersectionObserver-driven mount/dispose path is preserved verbatim — `softDisposeTile` now calls `tile.checkout?.release()` instead of disposing the local term/ws. The empty-stack dispose-the-entry path in checkout (§54.3.3) means a virtualized-off-screen tile that's the only consumer fully disposes the xterm + closes the WS, matching pre-fix behaviour. If a dedicated view is up while the tile virtualizes off-screen, the dedicated's checkout keeps the entry alive — the tile's `release()` just decrements the stack count.

`ensureTileMounted(tile)` (the click-before-IO defensive force-mount path used by `centerTile` / `enterDedicatedView` when the IO hadn't fired yet) routes through the same `mountTileViaCheckout` so behaviour is consistent across the cold-mount paths.

### 54.8.5 `resyncTilePtyFromCellMetrics` migration + top-of-stack guard

Pre-fix the function did `tile.term.resize(native.cols, native.rows)` + `tile.ws.send(JSON.stringify({type: 'resize', ...}))` separately. Post-fix it routes through `tile.checkout.resize(native.cols, native.rows)` which does both atomically AND updates the entry's `lastApplied` bookkeeping (added in HS-8042). New defensive guard: bail when `!tile.checkout.isTopOfStack()` — when another consumer (dedicated, quit-confirm) holds the live xterm, the tile's `xtermRoot` has the placeholder div (no `.xterm-screen` element) and `tileNativeDimsFromXterm` would compute against nothing. The guard prevents the screen ResizeObserver (which fires during the placeholder-painting transition) from accidentally resizing the live xterm out from under the active consumer.

### 54.8.6 `term.onData` keystroke wiring — hidden HS-8042 regression closed

Pre-HS-8042 each consumer wired its own `term.onData(ws.send(...))` against its own WebSocket. HS-8042 removed the dedicated view's wiring on the (incorrect) assumption that checkout was already doing it — it wasn't. The dedicated-view typing was silently broken in main between HS-8042 and HS-8048. HS-8048 closed it for everyone by wiring `term.onData` inside `terminalCheckout.tsx::openCheckoutWebSocket` — the checkout module's WS handler now calls `ws.send(encoder.encode(data))` for every keystroke, transparently to every consumer.

### 54.8.7 Test additions

- New unit-test file **`src/client/terminalTileGrid.test.ts`** (5 tests): rebuild-with-single-alive-tile-creates-checkout-entry; non-alive-tiles-do-NOT-create-entry; dispose-releases-every-tile-checkout-entryCount-zero; rebuild-with-fresh-entry-list-disposes-old-mounts-new; cross-project-independence (two tiles same terminalId different secrets get independent entries). All assertions go through `_inspectStackForTesting()` + `entryCount()` from `terminalCheckout`. happy-dom's IntersectionObserver doesn't fire entries, so the test setup stubs `globalThis.IntersectionObserver = undefined` to force the eager-mount fallback that the source already supports for test envs without IO. 5/5 in the file.
- Existing dashboard Playwright suite (`e2e/terminal-dashboard*.spec.ts`) NOT run in this session; manual spot-check is the contract until that suite runs in CI.

## 54.9 Phase 2.4 — Drawer pane migration (HS-8044) + Phase 2.5 cleanup (HS-8045)

The drawer pane (`src/client/terminal.tsx`, ~2097 lines pre-fix) was the largest surface and the user's primary workflow target. Migration shipped HS-8044's drawer integration **and** HS-8045's bulk cleanup of the §37 ANSI-spans preview path in the same commit pair (per the user's "be aggressive and let me test the most complete codebase" directive).

### 54.9.1 Module-driven reconnect-on-close

The drawer pane needed reconnect-on-close (the user expects to keep typing after a transient network blip). Pre-fix this was wired per-instance via `connect(inst)` + `scheduleReconnect(inst)` + an exponential-backoff timer. The HS-8044 design opened the question: should reconnect live consumer-side or in the checkout module? Decision was module-side — every consumer benefits from one centralized implementation.

`StackEntry` gained an `intentionallyClosing: boolean` flag. `disposeEntry` (called when the LIFO stack drops to 0) flips it to `true` immediately before `entry.ws.close()` so the WS close-event listener inside `attachWebSocketToEntry` can skip its reconnect path. For non-explicit close (network drop): the listener checks `entry.stack.length > 0` (live consumers exist) and `entry.intentionallyClosing === false`, then re-spawns a fresh WS to the same `(secret, terminalId)`. The server-side `'history'` control message replays scrollback on the new WS so the user perceives the socket flap as a brief output gap.

A subtle pre-fix bug surfaced during the refactor: `term.onData` was wired inside `openCheckoutWebSocket` and closed over the original WS reference. After a reconnect, that closure would dispatch keystrokes to the OLD (now-dead) WS. Fix: `term.onData` registration moved into `createEntry` (where the term itself is constructed), with the handler dynamically reading `entry.ws` on every keystroke so a swap-out works transparently.

### 54.9.2 Drawer surface change

Pre-fix `mountXterm(inst, secret)` constructed `new XTerm({fontFamily, fontSize, cursorBlink, scrollback: 10_000, allowProposedApi, theme, linkHandler})` + `new FitAddon()` + `new SearchAddon()` + `new WebLinksAddon()` + `new SerializeAddon()` + opened into `inst.canvasHost` + wired `term.onData(ws.send)` + `term.onResize(ws.send)` + `term.onTitleChange` + `term.onBell` + OSC 7 / OSC 133 parser hooks + custom key handler (HS-7329 / HS-7269 / HS-7331 / HS-7594). `connect(inst)` opened the WebSocket, registered open / message / close / error listeners, and routed control messages to `handleControlMessage`. `scheduleReconnect(inst)` retried with exponential backoff on close.

Post-fix the two are folded into a single **`mountInstanceViaCheckout(inst, secret)`** that calls `checkout({projectSecret, terminalId, cols: 80, rows: 24, mountInto: inst.canvasHost, onControlMessage})`. The handle's term + fit replace the per-instance constructions. Per-instance chrome (SearchAddon, WebLinksAddon, SerializeAddon, OSC handlers, custom key handler, bell, title, CWD chip, prompt-resume) is wired post-checkout against `handle.term`. Disposers for the term-level handlers (`term.onResize`, `term.onTitleChange`, `term.onBell`, OSC parser hooks, the prompt-resume keystroke hider) are captured into `inst.termHandlerDisposers: Array<{dispose(): void}>` and disposed in `teardown()` so a re-mount of the same `(secret, terminalId)` doesn't stack duplicate handlers atop the surviving xterm.

### 54.9.3 New `onControlMessage` hook on `CheckoutOptions`

Pre-fix the drawer's WS-message listener parsed JSON control messages (`'history'`, `'exit'`) and routed them to `handleControlMessage` for status / exit-code / command-name updates. With the WS owned by checkout, the consumer needs a way to subscribe.

Decision: add `onControlMessage?: (msg: {type: string; [k: string]: unknown}) => void` to `CheckoutOptions`. The checkout module's WS message handler fans out the parsed JSON to **every stack consumer's** callback BEFORE the module's own history-bytes replay runs. Bumped-down consumers (e.g. the drawer pane while a dashboard dedicated view is up) still want to track exit / status — fanning out to all consumers gives each one autonomy to decide what to react to. Consumer throws are swallowed so a misbehaving consumer can't break siblings.

### 54.9.4 Reconnect lifecycle removal

`scheduleReconnect(inst)` deleted entirely. The `inst.reconnectAttempts` + `inst.reconnectTimer` fields stay on the `TerminalInstance` interface for now (the cleanup-after-cleanup is HS-8049 / future work) but no remaining code path reads them. `connect(inst)` deleted. `mountXterm(inst, secret)` deleted.

`teardown(inst)` rewired: drops every entry from `inst.termHandlerDisposers` BEFORE releasing the checkout (term-level handlers must come off the shared term first), then calls `inst.checkout?.release()` which triggers the empty-stack dispose if no other consumer is holding the entry.

### 54.9.5 Phase 2.5 cleanup (HS-8045) — bulk delete cascade

With every consumer migrated, the §37 ANSI-spans preview path was deleted in the same commit:

- `src/client/ansiSpans.ts` + `src/client/ansiSpans.test.ts` — full deletion.
- `paintPreviewContent` + `paletteFromTheme` + `fetchScrollbackPreview` + `applyAppearanceToPreview` + the `ScrollbackPreviewResponse` interface in `quitConfirm.tsx` — full deletion (kept-but-dormant since HS-8041's "leave the helpers until cleanup ticket #5" instruction, plus the `void <fn>` references at the bottom of the file).
- `GET /api/terminal/scrollback-preview` route — full deletion. The `textWithAnsi` field on its response shape is gone with the route.
- `buildScrollbackPreviewWithAnsi` in `src/terminals/scrollbackSnapshot.ts` — full deletion. The stripped variant `buildScrollbackPreview` is checked for other callers before removal; if used elsewhere it stays, otherwise it's deleted too.
- `getTerminalScrollbackPreviewWithAnsi` registry helper — full deletion.
- `replayHistoryToTerm` import in `terminal.tsx` — no longer used after HS-8044 (history-frame replay moved into `terminalCheckout.tsx`'s WS handler in HS-8042). The `terminalReplay.ts` module itself stays — `applyDedicatedHistoryFrame` was already removed in HS-8042 but `replayHistoryToTerm` may still have callers in `terminalTileGrid.tsx` (legacy tile path that HS-8048 also migrated — recheck before final deletion).
- The search audit (per the HS-8045 ticket scope: "verify no plugin or external consumer reads the route — the project's plugin system is closed-source-friendly so check `plugins/*/src/**`") confirmed no plugin or other consumer reads the deleted exports.

### 54.9.6 Test additions

- 19/19 in `terminalCheckout.test.ts` (existing — covers the new HS-8042 `fit` + `resize` API additions). Reconnect-on-close test deferred — happy-dom doesn't have a real WebSocket to flap, and unit-testing the close-reconnect path would require mocking the WS constructor in a way that's brittle.
- 5/5 in `terminalTileGrid.test.ts` (existing — covers the HS-8048 tile migration's stack invariants).
- Existing drawer e2e (`e2e/terminal-drawer*.spec.ts`, `e2e/terminal-prompt*.spec.ts`, etc.) NOT run in this session — manual spot-check + the unit suite is the contract for now. The user committed to dogfooding the drawer migration before reporting any regressions.

## 54.10 Out of scope

- **Live placeholder painting** (option (b) from decision 2). If the user reports the static placeholder feels wrong, we can revisit — but the fork-stream-to-non-top-consumers cost is real and the design doc treats this as a follow-up, not a Phase 2 deliverable.
- **Multi-instance for the same `(secret, terminalId)`.** A future "compare two snapshots side by side" UX could want two xterms attached to the same PTY. Out of scope; the server already supports multiple subscribers per session, but the client-side single-instance assumption is baked into Phase 1.
- **Selection / search state preservation across stack swaps.** Today's drawer / dashboard handoff loses search state (the `SearchAddon` re-attaches with the new mount). The checkout system doesn't try to do better — when the live xterm reparents, its own state (cursor, selection, search highlights) follows naturally because the xterm instance is the same DOM node tree. The placeholder consumer doesn't have a meaningful "state" to preserve.
- **OSC133 jump shortcuts in non-top consumers.** Cmd/Ctrl+Up/Down already routes to the most-recently-active terminal — the checkout system doesn't change that. The "most-recently-active" cache continues to live in the OSC133 module; it's keyed on terminal-id, not on which consumer is rendering it.

## 54.11 Compatibility + back-out

Phase 1 lands with no UI consumers wired — every existing surface continues to use its current path. If a regression is found in `terminalCheckout.tsx` after Phase 2 lands, the back-out is per-consumer:

- Revert the consumer's checkout migration; that consumer goes back to its previous code path.
- The other consumers continue using the checkout module.
- No data-shape changes, no schema bump, no settings changes — purely client-side refactor.
