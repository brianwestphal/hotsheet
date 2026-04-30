# 54. Global Terminal Checkout (xterm Stack + Virtualization)

HS-7969 follow-up. A single xterm.js instance per `(projectSecret, terminalId)` lives in a new `terminalCheckout` client module. Every consumer (drawer pane, dashboard tile, dashboard dedicated view, drawer-grid tile, drawer-grid dedicated view, quit-confirm preview pane) calls `checkout(...)` to claim it and gets a `release()` handle back. The most recent checkout wins (LIFO stack); previous owners' mounts swap to a placeholder. When the stack is empty, the xterm is **disposed** to reclaim memory — the PTY survives on the server, and the next `checkout` re-creates the xterm and the WebSocket attach replays the scrollback.

> **Status:** Phase 1 shipped (HS-8031). Phase 2 (HS-8032) deferred — wires the existing drawer / dashboard / drawer-grid / quit-confirm surfaces to the new module + deletes the §37 ANSI-spans preview path.

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

## 54.6 Out of scope

- **Live placeholder painting** (option (b) from decision 2). If the user reports the static placeholder feels wrong, we can revisit — but the fork-stream-to-non-top-consumers cost is real and the design doc treats this as a follow-up, not a Phase 2 deliverable.
- **Multi-instance for the same `(secret, terminalId)`.** A future "compare two snapshots side by side" UX could want two xterms attached to the same PTY. Out of scope; the server already supports multiple subscribers per session, but the client-side single-instance assumption is baked into Phase 1.
- **Selection / search state preservation across stack swaps.** Today's drawer / dashboard handoff loses search state (the `SearchAddon` re-attaches with the new mount). The checkout system doesn't try to do better — when the live xterm reparents, its own state (cursor, selection, search highlights) follows naturally because the xterm instance is the same DOM node tree. The placeholder consumer doesn't have a meaningful "state" to preserve.
- **OSC133 jump shortcuts in non-top consumers.** Cmd/Ctrl+Up/Down already routes to the most-recently-active terminal — the checkout system doesn't change that. The "most-recently-active" cache continues to live in the OSC133 module; it's keyed on terminal-id, not on which consumer is rendering it.

## 54.7 Compatibility + back-out

Phase 1 lands with no UI consumers wired — every existing surface continues to use its current path. If a regression is found in `terminalCheckout.tsx` after Phase 2 lands, the back-out is per-consumer:

- Revert the consumer's checkout migration; that consumer goes back to its previous code path.
- The other consumers continue using the checkout module.
- No data-shape changes, no schema bump, no settings changes — purely client-side refactor.
