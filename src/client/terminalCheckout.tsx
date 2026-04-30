/**
 * HS-8031 Phase 1 — global terminal checkout module.
 *
 * Per docs/54-terminal-checkout.md. One xterm.js instance per
 * `(projectSecret, terminalId)` pair lives in this module's `entries` map
 * and is shared across every consumer (drawer pane, dashboard tile,
 * dedicated view, drawer-grid tile, quit-confirm preview pane). Consumers
 * call `checkout(opts)` to claim the live xterm into their `mountInto`
 * container; the returned `CheckoutHandle` exposes a `release()` to give
 * it back. A LIFO stack tracks who's currently rendering: the most recent
 * checkout wins (live xterm reparents into their container; previous
 * owners get a `Terminal in use elsewhere` placeholder).
 *
 * **Phase 1 ships infrastructure only — no consumer is migrated yet.**
 * The drawer / dashboard / drawer-grid / quit-confirm surfaces continue
 * to use their existing per-surface xterm management. Phase 2 (HS-8032)
 * migrates every consumer + deletes the §37 ANSI-spans preview path.
 *
 * ### Resize policy (decision 1, §54.3.1)
 * Compare the new top's `(cols, rows)` to the entry's last-applied
 * `(cols, rows)` and skip the resize call when they're equal — TUI
 * programs running in the shell (`htop`, `vim`, `claude`) don't see
 * SIGWINCH on every same-size handoff.
 *
 * ### Placeholder shape (decision 2, §54.3.2)
 * Bumped consumers get a plain `Terminal in use elsewhere` div in their
 * `mountInto`. No live updates, no animation, no click affordance — the
 * placeholder is the unambiguous "you can't interact here right now"
 * signal. Frozen-snapshot rendering was on the table but rejected
 * because xterm's canvas glyph metrics + box-drawing alignment + font
 * kerning don't translate cleanly to a CSS-painted `<pre>` (locked
 * decision 2 in §54.2).
 *
 * ### Virtualization (decision 6, §54.3.3)
 * When the last `release()` empties the stack, the entry is fully torn
 * down: `term.dispose()` frees canvas memory, `ws.close()` closes the
 * WebSocket subscriber, the map entry is deleted. The PTY survives on
 * the server (other subscribers may exist; the per-project always-on
 * session is independent). The next `checkout()` for the same key
 * re-creates the xterm + re-attaches the WebSocket — the server-side
 * scrollback-replay-on-attach (`src/terminals/registry.ts::attach`
 * returns `history` and the WebSocket handler writes it before live
 * data) reproduces the previous visual state.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';

/** Anchor element where the live xterm parks while no consumer is mounting
 *  it. xterm.js requires `term.open(container)` once at construction; we
 *  open into this offscreen sink so the first `checkout()` can DOM-
 *  reparent the xterm element into its `mountInto` without dealing with
 *  "open() not yet called" race. The sink is created lazily on first
 *  module use. */
let xtermParkingSink: HTMLDivElement | null = null;

function getOrCreateParkingSink(): HTMLDivElement {
  if (xtermParkingSink !== null) return xtermParkingSink;
  const sink = document.createElement('div');
  sink.id = 'terminal-checkout-parking-sink';
  sink.style.position = 'absolute';
  sink.style.left = '-9999px';
  sink.style.top = '-9999px';
  sink.style.width = '1px';
  sink.style.height = '1px';
  sink.style.overflow = 'hidden';
  sink.setAttribute('aria-hidden', 'true');
  document.body.appendChild(sink);
  xtermParkingSink = sink;
  return sink;
}

export interface CheckoutOptions {
  /** Project secret the live PTY is bound to. */
  projectSecret: string;
  /** Terminal id within the project (e.g. `default`, `dyn-…`). */
  terminalId: string;
  /** Desired xterm cols at top-of-stack. The module honours this when
   *  applying the resize-skip-on-same-size rule. */
  cols: number;
  /** Desired xterm rows at top-of-stack. Same as `cols`. */
  rows: number;
  /** The container element the xterm should be DOM-reparented into when
   *  this checkout holds the top-of-stack position. Should be empty when
   *  `checkout()` is called; the module owns its contents until
   *  `release()` returns. */
  mountInto: HTMLElement;
  /** Called when a newer checkout pushed this one down. The consumer can
   *  apply additional UI cues (dim the surrounding tile, suppress hover
   *  highlights). The placeholder div has already been written into
   *  `mountInto` by the time this fires. */
  onBumpedDown?: () => void;
  /** Called when this checkout regains the top-of-stack position because
   *  the newer owner released. The live xterm has reparented back into
   *  `mountInto` and the placeholder is gone by the time this fires. */
  onRestoredToTop?: () => void;
}

export interface CheckoutHandle {
  /** Release this checkout. If this was the top of the stack, the next
   *  most-recent consumer's `onRestoredToTop` fires + the live xterm
   *  reparents back into their `mountInto`. If it was the only consumer,
   *  the xterm is disposed + the WebSocket is closed + the entry is
   *  deleted from the map. */
  release(): void;
  /** The live xterm instance. Stable for the lifetime of this handle even
   *  while the consumer is bumped down (it just isn't rendering it).
   *  Consumers that want to fire xterm APIs (search, focus, etc.) check
   *  `isTopOfStack()` first. */
  term: XTerm;
  /** HS-8042 — exposed FitAddon for consumers that want to fill their
   *  `mountInto` with the xterm's native cell-fit dims (e.g. dedicated
   *  views that run `fit.fit()` on every body resize). The addon is
   *  loaded once on entry construction, before `term.open()`, so it's
   *  ready to use as soon as the consumer's `mountInto` has measurable
   *  layout dims. */
  fit: FitAddon;
  /** HS-8042 — apply a new `(cols, rows)` shape mid-checkout (without
   *  going through a stack swap). Calls `term.resize` AND sends the WS
   *  resize frame, then updates the entry's `lastAppliedCols/Rows`
   *  bookkeeping. Used by consumers that respond to live layout changes
   *  (e.g. dedicated view's `fit.fit()` echoes via `term.onResize` and
   *  the consumer routes that here). Same skip-on-same-size rule as
   *  the swap-time resize. */
  resize(cols: number, rows: number): void;
  /** True iff this handle is the current top of the stack — i.e. the live
   *  xterm is currently DOM-mounted in this consumer's `mountInto`. */
  isTopOfStack(): boolean;
}

/** Internal extension of `CheckoutHandle` used by the module's stack
 *  bookkeeping. Consumers only see the public surface above. */
interface InternalCheckoutHandle extends CheckoutHandle {
  _entry: StackEntry;
  _options: CheckoutOptions;
  _released: boolean;
}

interface StackEntry {
  secret: string;
  terminalId: string;
  term: XTerm;
  fit: FitAddon;
  ws: WebSocket | null;
  /** Most recently applied dims — compared to the new top's `(cols, rows)`
   *  on every checkout swap to honour the resize-skip rule. */
  lastAppliedCols: number;
  lastAppliedRows: number;
  /** LIFO stack — the LAST element is the current top (the consumer
   *  rendering the live xterm). */
  stack: InternalCheckoutHandle[];
}

const entries = new Map<string, StackEntry>();

function entryKey(secret: string, terminalId: string): string {
  return `${secret}::${terminalId}`;
}

/** Lucide `terminal-square` SVG path, inlined so the placeholder doesn't
 *  pull in `icons.ts` (which would create an awkward import cycle for the
 *  rare paths that don't need icons). */
const TERMINAL_SQUARE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>';

function buildPlaceholder(): HTMLElement {
  return toElement(
    <div className="terminal-checkout-placeholder">
      <div className="terminal-checkout-placeholder-icon">{raw(TERMINAL_SQUARE_ICON)}</div>
      <div className="terminal-checkout-placeholder-text">Terminal in use elsewhere</div>
    </div>,
  );
}

/** Replace `mountInto`'s contents with a fresh placeholder div. */
function writePlaceholderInto(mountInto: HTMLElement): void {
  mountInto.replaceChildren(buildPlaceholder());
}

/** Construct the xterm + open the WebSocket. The xterm is `term.open()`'d
 *  into the offscreen parking sink so the caller can immediately
 *  reparent its DOM node into `mountInto` via `appendChild`. */
function createEntry(secret: string, terminalId: string, cols: number, rows: number): StackEntry {
  const term = new XTerm({
    cols,
    rows,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Open into the offscreen parking sink so xterm's required `term.open()`
  // call lands somewhere safe; the actual visual mount happens via
  // `mountInto.appendChild(term.element)` in the caller.
  term.open(getOrCreateParkingSink());

  const ws = openCheckoutWebSocket(secret, terminalId, cols, rows, term);

  return {
    secret,
    terminalId,
    term,
    fit,
    ws,
    lastAppliedCols: cols,
    lastAppliedRows: rows,
    stack: [],
  };
}

/** Open the per-checkout WebSocket subscriber. Mirrors
 *  `src/client/terminal.tsx::connect()` — sends the initial resize frame
 *  on open, writes binary chunks to xterm, applies scrollback replay
 *  from the server's `history` control message. Reconnect-on-close is
 *  intentionally NOT wired in Phase 1 — checkout entries are torn down
 *  on empty stack, so a fresh checkout already gets a fresh WebSocket. */
function openCheckoutWebSocket(secret: string, terminalId: string, cols: number, rows: number, term: XTerm): WebSocket | null {
  // happy-dom in unit tests doesn't have WebSocket — bail with null so the
  // module is testable without a real socket.
  if (typeof WebSocket === 'undefined') return null;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/terminal/ws?project=${encodeURIComponent(secret)}&terminal=${encodeURIComponent(terminalId)}&cols=${cols}&rows=${rows}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return null;
  }
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* socket may have closed already */ }
  });

  ws.addEventListener('message', (ev) => {
    const data: unknown = ev.data;
    if (data instanceof ArrayBuffer) {
      try { term.write(new Uint8Array(data)); } catch { /* term disposed mid-message */ }
      return;
    }
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as { type?: string; bytes?: string; cols?: number; rows?: number };
        if (msg.type === 'history' && typeof msg.bytes === 'string') {
          // Server-side scrollback replay (HS-8031 §54.3.3 — the server's
          // attach() returns `history` and the WebSocket handler emits a
          // `history` control message before live data). The bytes are
          // base64-encoded by the server.
          //
          // HS-8042 — when the message also carries the dims at which
          // the history was captured (`cols` + `rows`), resize the term
          // FIRST and write the bytes SECOND so the historical content
          // reflows correctly (otherwise xterm would word-wrap at the
          // current term dims, mangling box-drawing TUI output that was
          // captured at different dims). Mirrors what
          // `terminalReplay.ts::replayHistoryToTerm` did for the per-
          // tile WS handler before the migration. We don't update the
          // entry's `lastApplied` bookkeeping here — the consumer's own
          // resize path (e.g. dedicated's `fit.fit()` echo via
          // `term.onResize` → `handle.resize`) restores the consumer's
          // intended dims after the bytes land.
          try {
            if (typeof msg.cols === 'number' && typeof msg.rows === 'number'
                && msg.cols > 0 && msg.rows > 0) {
              try { term.resize(msg.cols, msg.rows); } catch { /* term disposed */ }
            }
            const binary = atob(msg.bytes);
            const buf = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
            term.write(buf);
          } catch { /* malformed history — drop */ }
        }
      } catch { /* malformed JSON — ignore */ }
    }
  });

  return ws;
}

/** If `(cols, rows)` differs from the entry's last-applied dims, fire
 *  `term.resize` AND send the WS resize frame; update the entry's
 *  bookkeeping. Skip both when the dims match (decision 1, §54.3.1) so
 *  TUI programs don't see SIGWINCH on every same-size handoff. */
function applyResizeIfChanged(entry: StackEntry, cols: number, rows: number): void {
  if (cols === entry.lastAppliedCols && rows === entry.lastAppliedRows) return;
  try { entry.term.resize(cols, rows); } catch { /* term disposed */ }
  if (entry.ws !== null && entry.ws.readyState === WebSocket.OPEN) {
    try { entry.ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* swallow */ }
  }
  entry.lastAppliedCols = cols;
  entry.lastAppliedRows = rows;
}

/** Move the live xterm element from its current parent into `mountInto`.
 *  Idempotent — re-mounting into the same container is a no-op. */
function reparentXtermInto(entry: StackEntry, mountInto: HTMLElement): void {
  const el = entry.term.element;
  if (el === undefined) return;
  if (el.parentElement === mountInto) return;
  mountInto.replaceChildren(el);
}

/** Tear down an entry that has no remaining consumers. */
function disposeEntry(entry: StackEntry): void {
  // Park the xterm element back in the sink before dispose so the user's
  // `mountInto` (which the consumer is about to release) doesn't end up
  // with an orphaned xterm node. The sink is hidden + offscreen, so the
  // intermediate parent change isn't visible to the user.
  try {
    const el = entry.term.element;
    if (el !== undefined) getOrCreateParkingSink().appendChild(el);
  } catch { /* ignore */ }
  try { entry.term.dispose(); } catch { /* ignore */ }
  if (entry.ws !== null) {
    try { entry.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Claim the live xterm for `(projectSecret, terminalId)` into the
 * caller's `mountInto`. Synchronously returns a `CheckoutHandle`. The
 * scrollback replay arrives asynchronously via the WebSocket's `history`
 * control message — the xterm shows nothing until the bytes land,
 * matching the existing drawer-pane behaviour during a fresh attach.
 *
 * Calling sequence per §54.3:
 * 1. Look up the entry (or create one — opens the xterm + WebSocket).
 * 2. If a previous consumer was on top, write the placeholder into their
 *    `mountInto` + fire `onBumpedDown`.
 * 3. Reparent the live xterm element into the new caller's `mountInto`.
 * 4. Apply the resize-if-changed gate (skip when dims match).
 * 5. Push the new handle onto the stack as the new top.
 */
export function checkout(opts: CheckoutOptions): CheckoutHandle {
  const key = entryKey(opts.projectSecret, opts.terminalId);
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = createEntry(opts.projectSecret, opts.terminalId, opts.cols, opts.rows);
    entries.set(key, entry);
  } else if (entry.stack.length > 0) {
    const previousTop = entry.stack[entry.stack.length - 1];
    writePlaceholderInto(previousTop._options.mountInto);
    try { previousTop._options.onBumpedDown?.(); } catch { /* consumer error doesn't break the swap */ }
  }

  reparentXtermInto(entry, opts.mountInto);
  applyResizeIfChanged(entry, opts.cols, opts.rows);

  const stableEntry = entry;
  const handle: InternalCheckoutHandle = {
    term: entry.term,
    fit: entry.fit,
    isTopOfStack(): boolean {
      const top = stableEntry.stack[stableEntry.stack.length - 1];
      return top === handle;
    },
    resize(cols: number, rows: number): void {
      // HS-8042 — same skip-on-same-size rule as swap-time resize so
      // TUI programs don't see SIGWINCH on idempotent fit() calls.
      applyResizeIfChanged(stableEntry, cols, rows);
    },
    release(): void {
      releaseInternal(handle);
    },
    _entry: stableEntry,
    _options: opts,
    _released: false,
  };
  entry.stack.push(handle);
  return handle;
}

function releaseInternal(handle: InternalCheckoutHandle): void {
  if (handle._released) return;
  handle._released = true;
  const entry = handle._entry;
  const idx = entry.stack.indexOf(handle);
  if (idx < 0) return;
  const wasTop = idx === entry.stack.length - 1;
  entry.stack.splice(idx, 1);

  if (entry.stack.length === 0) {
    // Last consumer — virtualization (§54.3.3) tears the entry down.
    disposeEntry(entry);
    entries.delete(entryKey(entry.secret, entry.terminalId));
    return;
  }

  if (!wasTop) {
    // Released a non-top handle — the live xterm stays where it is. No
    // DOM swap needed; the released consumer manages its own mountInto
    // teardown (it's about to unmount its parent UI anyway).
    return;
  }

  // Released the top — restore the next-most-recent caller. Stack length
  // is non-zero (we returned above when it hit zero) so the top is defined.
  const newTop = entry.stack[entry.stack.length - 1];
  reparentXtermInto(entry, newTop._options.mountInto);
  applyResizeIfChanged(entry, newTop._options.cols, newTop._options.rows);
  try { newTop._options.onRestoredToTop?.(); } catch { /* consumer error doesn't break the restore */ }
}

/** Number of currently-mounted entries. Useful for tests + sanity checks. */
export function entryCount(): number {
  return entries.size;
}

/** **TEST ONLY** — full snapshot of the current stack state for assertions.
 *  Returns a deep-cloned shape so callers can't mutate the live entries.
 *  Exported unconditionally so unit tests can assert internal state; the
 *  underscore prefix marks it as private-by-convention. */
export function _inspectStackForTesting(): Array<{
  key: string;
  secret: string;
  terminalId: string;
  lastAppliedCols: number;
  lastAppliedRows: number;
  stackDepth: number;
  topMountInto: HTMLElement | null;
}> {
  const out: Array<{
    key: string;
    secret: string;
    terminalId: string;
    lastAppliedCols: number;
    lastAppliedRows: number;
    stackDepth: number;
    topMountInto: HTMLElement | null;
  }> = [];
  for (const [key, entry] of entries.entries()) {
    const topMountInto = entry.stack.length === 0
      ? null
      : entry.stack[entry.stack.length - 1]._options.mountInto;
    out.push({
      key,
      secret: entry.secret,
      terminalId: entry.terminalId,
      lastAppliedCols: entry.lastAppliedCols,
      lastAppliedRows: entry.lastAppliedRows,
      stackDepth: entry.stack.length,
      topMountInto,
    });
  }
  return out;
}

/** **TEST ONLY** — drop every entry without going through dispose. Used
 *  by unit-test cleanup so a stray entry from one test doesn't bleed
 *  into the next. Real consumers use `release()`. */
export function _resetForTesting(): void {
  for (const entry of entries.values()) {
    try { entry.term.dispose(); } catch { /* ignore */ }
    if (entry.ws !== null) {
      try { entry.ws.close(); } catch { /* ignore */ }
    }
  }
  entries.clear();
  if (xtermParkingSink !== null) {
    try { xtermParkingSink.remove(); } catch { /* ignore */ }
    xtermParkingSink = null;
  }
}
