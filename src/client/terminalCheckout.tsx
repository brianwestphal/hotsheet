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
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';
import { z } from 'zod';

import type { SafeHtml } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { trackPersistentSlowEvent } from './serverBusyChip.js';
import { shouldShowStallIndicator } from './terminal/stallIndicator.js';
import { shouldUseWebglRenderer, webglWantedForConsumer } from './terminalWebgl.js';

// HS-8567 — schema for the JSON control message the server-side
// terminal WebSocket sends ('history' frame, 'exit' frame, future kinds).
// `.loose()` lets the server add fields without breaking older clients.
//
// HS-8597 — `exitCode` MUST be `.nullable()`. The server sends
// `exitCode: result.exitCode` (src/terminals/registry/attach.ts), which is
// `null` for every ALIVE terminal — i.e. every normal history frame. A bare
// `z.number().optional()` accepts `number | undefined` but NOT `null`, so the
// schema rejected the history frame for every live session; `safeParse`
// failed, the handler's `if (!parsed.success) return` silently dropped the
// frame, and `applyHistoryReplay` never ran. The visible symptom was lost
// scrollback whenever the client xterm was recreated on a project-tab
// switch-back (the replay is the only thing that repaints a fresh xterm).
const ControlMessageSchema = z.object({
  type: z.string().optional(),
  bytes: z.string().optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  noSession: z.boolean().optional(),
  alive: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
  command: z.string().optional(),
}).loose();

/** Parsed control-message shape after schema validation. */
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

/**
 * Validate a decoded JSON control frame against {@link ControlMessageSchema}.
 * Returns the parsed message, or `null` when the payload doesn't match (the
 * caller drops malformed frames). Exported so the HS-8597 regression test can
 * assert the exact server-emitted `history` frame — including `exitCode: null`
 * for an alive terminal — parses without going through a live WebSocket.
 */
export function parseControlMessage(raw: unknown): ControlMessage | null {
  const parsed = ControlMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Anchor element where the live xterm parks while no consumer is mounting
 *  it. xterm.js requires `term.open(container)` once at construction; we
 *  open into this offscreen sink so the first `checkout()` can DOM-
 *  reparent the xterm element into its `mountInto` without dealing with
 *  "open() not yet called" race. The sink is created lazily on first
 *  module use. */
let xtermParkingSink: HTMLDivElement | null = null;

function getOrCreateParkingSink(): HTMLDivElement {
  if (xtermParkingSink !== null) return xtermParkingSink;
  // HS-8098 — direct `document.createElement` is intentional here: the
  // sink is a pure capture target xterm uses for its required first
  // `term.open()` call before the consumer reparents the term element
  // into the visible mountInto. Routing through `toElement(<jsx />)`
  // would build an element that's then never read as JSX content,
  // adding ceremony with no benefit.
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
  /** HS-8044 — every JSON control message that arrives on the
   *  per-entry WebSocket is dispatched to every consumer's
   *  `onControlMessage` callback, including the `history` frame whose
   *  bytes the module also replays internally (consumers may want the
   *  message's metadata: `alive`, `exitCode`, `command`, etc.). The
   *  module fires this for ALL stack consumers, not just the top —
   *  bumped-down consumers (e.g. the drawer pane while a dashboard
   *  dedicated view is up) still want to track exit / status. Throws
   *  inside the callback are swallowed so a misbehaving consumer can't
   *  break sibling consumers' delivery. */
  onControlMessage?: (msg: { type: string; [k: string]: unknown }) => void;
  /** HS-8218 — when true, the WebSocket attach passes `?noSpawn=1`. The
   *  server returns a `history` frame with `noSession: true` (no PTY
   *  was spawned) and closes the socket cleanly with code 1000 instead
   *  of attempting to attach a subscriber. The §47 popup uses this so
   *  its `terminalId: 'default'` checkout doesn't inadvertently spawn
   *  a new claude that disrupts an existing MCP-connected claude
   *  running under a non-`'default'` terminal id. The flag is recorded
   *  on the entry itself so a subsequent live-checkout from a different
   *  consumer (drawer pane / dashboard tile, which want to spawn) gets
   *  a fresh session as before. */
  noSpawn?: boolean;
  /** HS-8218 — fires when the server's `history` frame for this entry
   *  carried `noSession: true`, signalling the consumer that no live
   *  session exists and the requested `noSpawn` mode prevented a fresh
   *  spawn. The consumer should `release()` and fall back to a
   *  non-live UI (the §47 popup swaps its body to the flat / diff
   *  preview). The callback fires AFTER the `onControlMessage` history
   *  dispatch so a consumer that wires both can rely on
   *  `onNoLiveSession` being the late signal. Module-level: only fires
   *  when `noSpawn: true` was passed at checkout. */
  onNoLiveSession?: () => void;
  /** HS-8295 — CSS color string painted as the placeholder's background
   *  when this consumer is bumped down and its `mountInto` is filled
   *  with the "Terminal in use elsewhere" placeholder. Pass the
   *  terminal's resolved theme background (via
   *  {@link resolveAppearanceBackground}) so the placeholder visually
   *  reads as part of the terminal frame instead of jumping to the
   *  app's `--bg-secondary` gray. Falls back to `--bg-secondary` when
   *  unset. */
  placeholderBackground?: string;
  /** HS-8301 — when true, the live xterm has `disableStdin = true`
   *  applied while this consumer is the top of the stack. The user can
   *  still scroll the buffer + select text + use copy/paste, but typed
   *  characters are NOT delivered to the PTY. Used by the §47
   *  permission popup so the user can't accidentally inject keystrokes
   *  into Claude's prompt while answering the dialog. The flag is
   *  scoped to this consumer's stack frame: when this consumer is
   *  bumped down or releases, the new top's `readOnly` value is
   *  re-applied (so a non-readOnly consumer underneath gets typing
   *  back). Defaults to false. */
  readOnly?: boolean;
  /** HS-8619 — when true, this consumer renders the live xterm inside a
   *  CSS `transform: scale(...)` box (the §25 dashboard / §36 drawer-grid
   *  tiles + the centered/magnified overlay). The WebGL renderer draws to a
   *  fixed-resolution `<canvas>` that raster-scales badly under a CSS
   *  transform (blurry / mis-sized on magnify), whereas the DOM renderer's
   *  `<span>` cells scale crisply. So while a `scaled` consumer is on top,
   *  the WebGL addon (if loaded) is disposed and the terminal falls back to
   *  the DOM renderer; when a non-scaled consumer (drawer pane / dedicated
   *  view — both real-`fit()`, not CSS-scaled) returns to the top, WebGL is
   *  reloaded. Follows the top-of-stack exactly like `readOnly`. Defaults to
   *  false. No effect when WebGL was never desired for this entry (user
   *  opt-out / no WebGL2 / e2e force-disable). */
  scaled?: boolean;
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
  /** HS-8044 — set true by `disposeEntry` immediately before
   *  `entry.ws.close()` so the close-event listener inside
   *  `openCheckoutWebSocket` can skip the auto-reconnect path. Without
   *  this guard, an explicit final-release would race the reconnect
   *  loop and re-spawn a WS we just intentionally tore down. */
  intentionallyClosing: boolean;
  /** HS-8218 — true when the entry was created with `noSpawn: true`.
   *  Carried through to `attachWebSocketToEntry` so the WS query string
   *  includes `noSpawn=1`. Also gates the `onNoLiveSession` dispatch
   *  inside the history-frame handler — non-noSpawn entries never see
   *  `noSession: true` and shouldn't pay attention to the field. */
  noSpawn: boolean;
  /** HS-8619 — whether the WebGL renderer is allowed for this entry, captured
   *  once at creation from `shouldUseWebglRenderer()` (false = user opt-out /
   *  no WebGL2 / e2e force-disable → always DOM, the renderer reconcile is a
   *  no-op). */
  webglDesired: boolean;
  /** HS-8619 — the currently-loaded WebGL addon, or null when the DOM renderer
   *  is active. `reconcileRenderer` toggles this as the top-of-stack consumer's
   *  `scaled` flag changes: disposed (→ null) under a CSS-scaled tile consumer,
   *  reloaded under a full-size (drawer / dedicated) consumer. */
  webglAddon: WebglAddon | null;
  /** HS-8610 — true while `applyHistoryReplay` is writing the server's
   *  scrollback into xterm. The replayed bytes can contain device-status
   *  QUERIES the foreground program emitted before the disconnect
   *  (`\x1b[?6n` DECXCPR, `\x1b[6n` CPR, `\x1b[c` DA, `\x1b]11;?` OSC color,
   *  …); xterm parses them and auto-emits the REPLY via `term.onData`,
   *  which the keystroke pipe below would send to the PTY — landing as
   *  garbage like `?49;86R` / `3R3R` in the foreground program's input on
   *  every tab switch. While this flag is set, `term.onData` drops the
   *  data (the user isn't typing during a programmatic replay, so nothing
   *  real is lost). */
  replaying: boolean;
  /** HS-8175 — `Date.now()` at the most recent keystroke send (`term.onData`).
   *  0 means no keystroke has been sent on this entry. */
  lastTypeTs: number;
  /** HS-8175 — `Date.now()` at the most recent PTY echo (`ws.message`
   *  binary frame). 0 means no echo has been received yet. */
  lastEchoTs: number;
  /** HS-8175 — subscribers fire on every type / echo update so consumers
   *  (drawer pane, dashboard tile) can re-evaluate their stall chip. */
  stallSubscribers: Set<() => void>;
  /** HS-8286 — release token returned by `trackPersistentSlowEvent` while
   *  this entry is currently stalled. `null` when not stalled. The
   *  per-entry stall watcher (set up in `createEntry`) flips this on/off
   *  so the global server-slow banner surfaces a stalled terminal. */
  globalStallToken: (() => void) | null;
  /** HS-8286 — handle returned by `setInterval` for the per-entry stall
   *  watcher. Cleared on `disposeEntry` so the timer doesn't outlive the
   *  entry. */
  globalStallTickHandle: number | null;
}

const entries = new Map<string, StackEntry>();

function entryKey(secret: string, terminalId: string): string {
  return `${secret}::${terminalId}`;
}

/** Lucide `terminal-square` SVG path, inlined so the placeholder doesn't
 *  pull in `icons.ts` (which would create an awkward import cycle for the
 *  rare paths that don't need icons). */
const TERMINAL_SQUARE_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>;

function buildPlaceholder(background?: string): HTMLElement {
  const el = toElement(
    <div className="terminal-checkout-placeholder">
      <div className="terminal-checkout-placeholder-icon">{TERMINAL_SQUARE_ICON}</div>
      <div className="terminal-checkout-placeholder-text">Terminal in use elsewhere</div>
    </div>,
  );
  // HS-8295 — inline-paint the bumped consumer's terminal-theme background
  // so the placeholder reads as a faded continuation of the terminal frame
  // rather than the jarring `--bg-secondary` gray. Falls through to the
  // SCSS default when the consumer didn't supply a color.
  if (background !== undefined && background !== '') {
    el.style.backgroundColor = background;
  }
  return el;
}

/** Replace `mountInto`'s contents with a fresh placeholder div. */
function writePlaceholderInto(mountInto: HTMLElement, background?: string): void {
  mountInto.replaceChildren(buildPlaceholder(background));
}

/** Construct the xterm + open the WebSocket. The xterm is `term.open()`'d
 *  into the offscreen parking sink so the caller can immediately
 *  reparent its DOM node into `mountInto` via `appendChild`. */
function createEntry(secret: string, terminalId: string, cols: number, rows: number, noSpawn: boolean): StackEntry {
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

  const entry: StackEntry = {
    secret,
    terminalId,
    term,
    fit,
    ws: null,
    lastAppliedCols: cols,
    lastAppliedRows: rows,
    stack: [],
    intentionallyClosing: false,
    replaying: false,
    noSpawn,
    // HS-8488 / HS-8619 — `shouldUseWebglRenderer()` is false when the user
    // opted out, WebGL2 is unavailable, or WebGL is force-disabled for e2e.
    // The addon itself is loaded lazily by `reconcileRenderer` (called from
    // `checkout` right after the xterm is mounted) so the renderer can follow
    // the top-of-stack consumer's `scaled` flag — WebGL for full-size
    // (drawer / dedicated), DOM for CSS-scaled tiles. (No `@xterm/addon-canvas`
    // — DOM is the universal fallback so the planned domotion-svg demo capture
    // always has the live `<span>` tree.)
    webglDesired: shouldUseWebglRenderer(),
    webglAddon: null,
    lastTypeTs: 0,
    lastEchoTs: 0,
    stallSubscribers: new Set(),
    globalStallToken: null,
    globalStallTickHandle: null,
  };

  // HS-8048 — wire `term.onData` ONCE at term construction. The handler
  // looks up `entry.ws` dynamically so a reconnect-on-close swap-out
  // (HS-8044) keeps keystroke-send working transparently — the closure
  // doesn't capture the original WS reference.
  const encoder = new TextEncoder();
  term.onData((data) => {
    // HS-8610 — drop xterm's automatic replies to device-status queries
    // (CPR / DECXCPR / DA / OSC color, …) that the foreground program
    // emitted before a disconnect and that ride back in the replayed
    // scrollback. During `applyHistoryReplay` these would otherwise be
    // piped to the PTY as if typed, surfacing as `?49;86R` / `3R3R`
    // garbage in the input line on tab switches. The user can't be typing
    // during a synchronous programmatic replay, so nothing real is lost.
    if (entry.replaying) return;
    const ws = entry.ws;
    let sent = false;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(encoder.encode(data));
        sent = true;
      } catch { /* socket may have closed mid-send */ }
    }
    // HS-8175 / HS-8309 — only treat the keystroke as "typed" when the
    // bytes actually left the client. Pre-HS-8309, `lastTypeTs` updated
    // unconditionally; combined with the per-entry stall watcher below
    // and `trackPersistentSlowEvent`, a single keystroke during a WS
    // down-window (or into a noSpawn entry that has no live PTY) opened
    // a global-banner token that could never resolve — no echo can come
    // back for a keystroke the PTY never received — and the slow-server
    // banner stayed on indefinitely. Gating on `sent` is the root-cause
    // fix: dropped keystrokes never bump `lastTypeTs` so the watcher
    // never fires for them.
    if (sent) {
      entry.lastTypeTs = Date.now();
      notifyStallSubscribers(entry);
    }
  });

  attachWebSocketToEntry(entry);

  // HS-8286 — wire the per-entry global-banner watcher. When this terminal
  // crosses the typed-but-no-echo threshold (`shouldShowStallIndicator`),
  // open a `trackPersistentSlowEvent` token so the global server-slow
  // banner surfaces. Release the token when echo returns. Pre-fix the
  // drawer header / dashboard tile painted a per-pane / per-tile chip
  // instead — but the user reported that as confusing because the chip
  // "looked like a single terminal had a problem" when the underlying
  // cause is server-side (event-loop block, slow PTY echo, etc.). Routing
  // through the global banner reuses the §HS-8226 banner UX and matches
  // the user's mental model: "server slow" is global, not per-terminal.
  const evaluateGlobalStall = (): void => {
    const stalled = shouldShowStallIndicator(entry.lastTypeTs, entry.lastEchoTs, Date.now());
    if (stalled && entry.globalStallToken === null) {
      // HS-8425 — pass a label so the freeze-log activation entry can
      // name *which* terminal stalled. Don't include the project secret
      // (it's a secret); the terminal id alone is sufficient to grep
      // back through `freeze.log` and find every banner activation
      // caused by this terminal.
      entry.globalStallToken = trackPersistentSlowEvent(`terminal-stall:${entry.terminalId}`);
    } else if (!stalled && entry.globalStallToken !== null) {
      try { entry.globalStallToken(); } catch { /* swallow */ }
      entry.globalStallToken = null;
    }
  };
  entry.stallSubscribers.add(evaluateGlobalStall);
  // 250 ms tick so the stall threshold crosses without a fresh keystroke /
  // echo event firing — same cadence the per-pane chip used pre-fix.
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    entry.globalStallTickHandle = window.setInterval(evaluateGlobalStall, 250);
  }

  return entry;
}

/**
 * HS-8044 — open a WebSocket for `entry` and wire its lifecycle. Called
 * once at `createEntry` time and again from the close-event reconnect
 * path. Module-private because consumers route everything through
 * `checkout()` / `release()` / `handle.resize()`.
 *
 * The reconnect contract: when the WS closes AND the entry's stack is
 * non-empty (live consumers exist) AND `entry.intentionallyClosing` is
 * false (the user didn't release it), call `attachWebSocketToEntry`
 * to spin up a fresh socket. The server-side scrollback replay
 * (`'history'` control message on attach) re-paints whatever was on
 * screen so transient network blips don't lose state. Pre-HS-8044 each
 * consumer of `terminalCheckout` would have had to wire its own
 * reconnect — making the module the natural home centralizes the
 * concern AND lets the drawer pane (HS-8044 / §22) drop its own
 * reconnect-on-close path entirely.
 */
function attachWebSocketToEntry(entry: StackEntry): void {
  // happy-dom in unit tests doesn't have WebSocket — bail with null so the
  // module is testable without a real socket.
  if (typeof WebSocket === 'undefined') {
    entry.ws = null;
    return;
  }
  // HS-8369 followup — defensive guard for the `window`-is-gone case.
  // The WS close-event handler queues a `attachWebSocketToEntry` retry
  // via `queueMicrotask` (line ~608). When happy-dom tears down at end-
  // of-test, the microtask may still be queued; by the time it runs,
  // `window` is undefined and accessing `window.location.protocol`
  // throws `ReferenceError: window is not defined` as an unhandled
  // rejection in the test report (originally surfaced from
  // `permissionOverlay.test.ts`'s teardown). The `intentionallyClosing`
  // + `stack.length === 0` guards in the close handler don't cover the
  // happy-dom-disposal case because the entry's state machine looks
  // alive — only the global environment is gone.
  if (typeof window === 'undefined') {
    entry.ws = null;
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // HS-8218 — append `&noSpawn=1` when the entry was created with
  // `noSpawn: true` (e.g. the §47 popup's defensive checkout). Server
  // responds with `history` frame `noSession: true` + close-1000 if no
  // live session exists, so no fresh PTY is spawned.
  const noSpawnQuery = entry.noSpawn ? '&noSpawn=1' : '';
  const url = `${protocol}//${window.location.host}/api/terminal/ws?project=${encodeURIComponent(entry.secret)}&terminal=${encodeURIComponent(entry.terminalId)}&cols=${entry.lastAppliedCols}&rows=${entry.lastAppliedRows}${noSpawnQuery}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    entry.ws = null;
    return;
  }
  ws.binaryType = 'arraybuffer';
  entry.ws = ws;

  ws.addEventListener('open', () => {
    try { ws.send(JSON.stringify({ type: 'resize', cols: entry.lastAppliedCols, rows: entry.lastAppliedRows })); } catch { /* socket may have closed already */ }
  });

  ws.addEventListener('message', (ev) => {
    const data: unknown = ev.data;
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      try { entry.term.write(bytes); } catch { /* term disposed mid-message */ }
      // HS-8175 — record the PTY echo so `shouldShowStallIndicator` can
      // hide the chip the moment output comes back. Subscribers re-evaluate.
      entry.lastEchoTs = Date.now();
      notifyStallSubscribers(entry);
      return;
    }
    if (typeof data === 'string') {
      try {
        // HS-8567 — zod-validate the WebSocket control message at the parse
        // boundary. Unknown fields are tolerated (`.loose()`) so the server
        // can extend the protocol without breaking older clients.
        const rawJson: unknown = JSON.parse(data);
        const msg = parseControlMessage(rawJson);
        if (msg === null) return;
        // HS-8044 — fan out the parsed control message to every stack
        // consumer's `onControlMessage` callback BEFORE the module's
        // own history-bytes replay runs. Consumers that need the
        // history frame's metadata (alive, exitCode, command — the
        // drawer pane in §22) read those fields here; the module's
        // history-replay logic below is independent.
        if (typeof msg.type === 'string') {
          const dispatchMsg = msg as { type: string; [k: string]: unknown };
          for (const handle of entry.stack) {
            try { handle._options.onControlMessage?.(dispatchMsg); } catch { /* swallow */ }
          }
        }
        if (msg.type === 'history' && typeof msg.bytes === 'string') {
          applyHistoryReplay(entry, msg);
        }
        // HS-8218 — server signalled "no session, didn't spawn". Mark
        // the entry intentionally-closing so the close-event listener
        // skips its auto-reconnect path (the server would just say
        // noSession again — looping wastes round-trips), then fire
        // every stack consumer's `onNoLiveSession` so each can release
        // and fall back. The `noSpawn` gate keeps the dispatch tight:
        // a consumer that never asked for noSpawn shouldn't be
        // surprised by a no-session signal (the server only emits it
        // when ?noSpawn=1 was set).
        if (msg.type === 'history' && msg.noSession === true && entry.noSpawn) {
          entry.intentionallyClosing = true;
          for (const handle of entry.stack) {
            try { handle._options.onNoLiveSession?.(); } catch { /* swallow */ }
          }
        }
      } catch { /* malformed JSON — ignore */ }
    }
  });

  ws.addEventListener('close', () => {
    // HS-8379 — reset the keystroke / echo timestamps on every WS close
    // event so a stalled `(lastTypeTs > lastEchoTs)` state doesn't pin the
    // global server-slow banner across the close-reconnect window. Pre-fix
    // a keystroke whose bytes left the client but whose echo never came
    // back (TCP frame in flight at close time, OR echo dropped in close,
    // OR server-side scrollback replay rendered the bytes via the
    // string-typed `history` JSON frame which does NOT bump `lastEchoTs`)
    // left the per-entry stall watcher firing every 250 ms even after the
    // reconnect succeeded — the banner stayed visible until the user
    // switched projects (which tears down every entry via `disposeEntry`
    // and releases the token). Resetting both timestamps on close means
    // the next type-echo cycle on the fresh socket starts clean.
    // `notifyStallSubscribers` flushes the watcher so the release happens
    // synchronously rather than waiting for the 250 ms tick.
    entry.lastTypeTs = 0;
    entry.lastEchoTs = 0;
    notifyStallSubscribers(entry);
    // HS-8044 — module-driven reconnect. Skip when (a) the user
    // explicitly released the entry (the dispose path flips the flag
    // before close) or (b) the stack is empty (no consumer needs the
    // socket). Otherwise re-spawn — the server-side `'history'` replay
    // on the new WS re-paints scrollback so the user perceives the
    // socket flap as a brief output gap, not as a lost terminal.
    if (entry.intentionallyClosing) return;
    if (entry.stack.length === 0) return;
    if (entry.ws !== ws) return; // a newer reconnect already kicked in
    entry.ws = null;
    // Schedule the reconnect on a microtask so the close-event handler
    // returns first; avoids re-entrancy on hot socket-flap loops.
    queueMicrotask(() => {
      // Re-check guards — the entry may have been disposed in the gap.
      if (entry.intentionallyClosing) return;
      if (entry.stack.length === 0) return;
      attachWebSocketToEntry(entry);
    });
  });
}

/**
 * HS-8064 — server-side scrollback replay. Resize the term to the
 * capture-time dims (so xterm word-wraps the bytes correctly), write
 * the bytes, then snap the term back to the consumer's intended dims
 * (`lastAppliedCols/Rows`, which tracked the consumer's last fit-to-pane
 * resize before this history replay started).
 *
 * The capture-time `term.resize(...)` fires xterm's `onResize` event,
 * which in the drawer's wiring (`terminal.tsx` line 1051) echoes
 * through `handle.resize` → `applyResizeIfChanged`. That echo updates
 * `lastApplied` to the capture-time dims and sends a WS resize frame
 * for them — fine while we're synchronous-mid-replay, because the
 * second `term.resize(targetCols, targetRows)` below restores the
 * pre-replay snapshot dims AND fires another onResize echo that brings
 * `lastApplied` and the server PTY back to the consumer's intended
 * dims. So we capture the snapshot BEFORE any resize fires.
 *
 * Pre-HS-8064 design assumed the consumer's `term.onResize → handle.resize`
 * echo would bounce the term back automatically after the synthetic
 * resize — but xterm's onResize fires with the SYNTHETIC capture-time
 * dims, not the consumer's intended dims, so the echo just acknowledges
 * the capture-time resize and never restores the pane size. Result:
 * term stuck at capture-time dims inside the drawer pane (e.g. 80×24
 * inside a pane that fit 100×30), the visible scrollback never reflowed
 * to fit, leaving a band of empty pane outside xterm's canvas until the
 * user manually dragged the drawer to re-trigger fit.
 *
 * Exported for the regression test.
 */
export function applyHistoryReplay(
  entry: StackEntry,
  msg: { bytes?: string; cols?: number; rows?: number },
): void {
  if (typeof msg.bytes !== 'string') return;
  try {
    const targetCols = entry.lastAppliedCols;
    const targetRows = entry.lastAppliedRows;
    // HS-8287 — clear buffer + scrollback + cursor + alt-screen state before
    // replaying. The server's history frame carries the entire ring buffer,
    // so writing it onto a term that already has the pre-disconnect content
    // would APPEND, doubling the visible scrollback after a WS reconnect.
    // `reset()` makes the replay authoritative: term ends up showing only
    // what the server says was on screen. Must run BEFORE the capture-time
    // resize so HS-8064's reflow logic operates on a clean buffer.
    //
    // HS-8287 follow-up — also call `clear()` after `reset()`. xterm.js
    // 6.0.0's `reset()` runs the ESC c sequence which resets terminal
    // state (cursor, attributes, alt-screen), but the visible buffer +
    // scrollback handling varies by version + renderer (DOM vs canvas vs
    // WebGL). The user reported the doubled-scrollback symptom persisted
    // after the initial reset()-only fix landed in WKWebView; pairing
    // reset() with clear() (which explicitly drops scrollback and makes
    // the prompt line the new first line) closes that gap regardless of
    // xterm internal behavior.
    try {
      entry.term.reset();
      entry.term.clear();
    } catch { /* term disposed mid-reset */ }
    if (typeof msg.cols === 'number' && typeof msg.rows === 'number'
        && msg.cols > 0 && msg.rows > 0) {
      try { entry.term.resize(msg.cols, msg.rows); } catch { /* term disposed */ }
    }
    const binary = atob(msg.bytes);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    // HS-8610 — gate the keystroke pipe across the write. xterm emits its
    // auto-replies to any device-status queries in `buf` via `term.onData`
    // DURING the write's parse pass (synchronously, before the write
    // callback), so holding `replaying` true from just before the write
    // until the write callback reliably suppresses every reply regardless
    // of how many chunks xterm splits the buffer into. (The preceding
    // `reset()` / `clear()` / `resize()` calls don't generate `onData`.)
    entry.replaying = true;
    entry.term.write(buf, () => { entry.replaying = false; });
    // Snap term back to the consumer's intended dims. xterm reflows the
    // just-written scrollback to the consumer's pane width. The
    // synthetic `term.onResize` echo this fires also brings `lastApplied`
    // and the server PTY back to the consumer's dims via the asymmetric
    // gate in `applyResizeIfChanged`.
    if (entry.term.cols !== targetCols || entry.term.rows !== targetRows) {
      try { entry.term.resize(targetCols, targetRows); } catch { /* term disposed */ }
    }
  } catch { /* term disposed mid-replay */ }
}

/** **TEST ONLY** — return the entry for `(secret, terminalId)` so the
 *  HS-8064 history-replay test can drive `applyHistoryReplay` against
 *  a real entry without standing up a WebSocket. */
export function _getEntryForTesting(secret: string, terminalId: string): StackEntry | null {
  return entries.get(entryKey(secret, terminalId)) ?? null;
}

/** If `(cols, rows)` differs from the term's actual current dims, fire
 *  `term.resize` and send the WS resize frame. Skip the work when the
 *  dims match (decision 1, §54.3.1) so TUI programs don't see SIGWINCH
 *  on every same-size handoff.
 *
 *  HS-8051 (2026-05-01) — the source of truth is `entry.term.cols/rows`,
 *  NOT the bookkeeping `entry.lastAppliedCols/Rows`. The history-frame
 *  handler in `attachWebSocketToEntry` calls `entry.term.resize(...)`
 *  directly and explicitly DOES NOT update `lastApplied` (so consumers'
 *  resize calls aren't spuriously skipped after replay). Pre-fix this
 *  function compared `cols === lastApplied`, which created a backwards
 *  bug: when a tile's render loop converged to native dims (lastApplied
 *  = (61, 48)) and the history-frame handler then mutated term to its
 *  capture-time dims (term.cols = 80) without touching lastApplied, the
 *  next `handle.resize(61, 48)` call saw lastApplied = (61, 48) and
 *  bailed — leaving term stuck at (80, 60) instead of converging back
 *  to (61, 48). User's HS-8051 logs (4 attempts) showed a larger-font
 *  Domotion tile with `screenW: 841, screenH: 1200` (≈ cols=40, rows=60
 *  with cellW=21.025) — non-converging because every onRender-driven
 *  `resize(61, 48)` was being skipped. The fix compares against the
 *  term's ACTUAL dims so external mutations don't fool the skip.
 *
 *  WS frame is also gated on `lastApplied` (not term) since it tracks
 *  what the server PTY thinks its size is — sending an idempotent WS
 *  resize is wasteful. */
function applyResizeIfChanged(entry: StackEntry, cols: number, rows: number): void {
  const termAtTarget = entry.term.cols === cols && entry.term.rows === rows;
  const ptyAtTarget = entry.lastAppliedCols === cols && entry.lastAppliedRows === rows;
  if (termAtTarget && ptyAtTarget) return;
  if (!termAtTarget) {
    try { entry.term.resize(cols, rows); } catch { /* term disposed */ }
  }
  if (!ptyAtTarget && entry.ws !== null && entry.ws.readyState === WebSocket.OPEN) {
    try { entry.ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* swallow */ }
  }
  entry.lastAppliedCols = cols;
  entry.lastAppliedRows = rows;
}

/** Move the live xterm element from its current parent into `mountInto`.
 *  Idempotent — re-mounting into the same container is a no-op. */
function reparentXtermInto(entry: StackEntry, mountInto: HTMLElement): void {
  const el = entry.term.element;
  if (el === undefined) {
    // HS-8288 — guard: a term with no element (disposed / never opened)
    // would leave `mountInto` childless (no xterm, no placeholder). Bail
    // rather than reparent nothing.
    return;
  }
  if (el.parentElement === mountInto) return;
  mountInto.replaceChildren(el);
}

/**
 * HS-8285 — release any handles in `entry.stack` whose `mountInto` element
 * is no longer attached to the document. Such handles are stale — their
 * consumer's container was torn down without `release()` running (e.g. a
 * popup whose DOM was removed by an outer error path, a dashboard tile
 * whose section was re-rendered before its dispose hook fired, a project
 * tab reorder that rebuilt the tab strip without flushing every per-tab
 * tear-down). Pre-fix these stale handles stayed at the top of the stack,
 * so the next legitimate consumer's checkout fired the
 * `writePlaceholderInto(previousTop.mountInto)` branch (writing a
 * placeholder into a detached node nobody sees) AND the new consumer's
 * own mountInto remained detached from the live xterm because the live
 * xterm was reparenting into the SAME stale top's mountInto on every
 * release attempt — producing the "Terminal in use elsewhere" symptom on
 * the surface the user actually has on screen.
 *
 * Splicing detached handles out of the stack lets `checkout()` see the
 * stack as empty (or the previous LIVE top) and proceed correctly.
 * `_released` is flipped first so a late `release()` from the stale
 * handle's owner is a no-op.
 */
function pruneDetachedHandles(entry: StackEntry): void {
  for (let i = entry.stack.length - 1; i >= 0; i--) {
    const handle = entry.stack[i];
    if (!handle._options.mountInto.isConnected) {
      handle._released = true;
      entry.stack.splice(i, 1);
    }
  }
}

/** Tear down an entry that has no remaining consumers. */
function disposeEntry(entry: StackEntry): void {
  // HS-8044 — flag intentional close BEFORE `entry.ws.close()` fires so
  // the WS close-event listener inside `attachWebSocketToEntry` sees the
  // flag and skips its reconnect path. Without this, the dispose-when-
  // empty path would race against the auto-reconnect and re-spawn a
  // socket we just intentionally tore down.
  entry.intentionallyClosing = true;
  // HS-8286 — release the global-banner token + clear the watcher's tick
  // before tearing down the term. Otherwise an entry whose stall is
  // currently active would leave the banner stuck on after dispose.
  if (entry.globalStallToken !== null) {
    try { entry.globalStallToken(); } catch { /* swallow */ }
    entry.globalStallToken = null;
  }
  if (entry.globalStallTickHandle !== null) {
    try { window.clearInterval(entry.globalStallTickHandle); } catch { /* swallow */ }
    entry.globalStallTickHandle = null;
  }
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
 * matching the existing drawer-pane behavior during a fresh attach.
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
    // HS-8218 — propagate `noSpawn` to the new entry so the WS URL
    // carries `?noSpawn=1`. When an entry already exists we ignore the
    // caller's `noSpawn` because the WS is already attached and a
    // session is already alive (otherwise the existing entry would
    // have torn itself down on the prior `noSession: true` history
    // frame).
    entry = createEntry(opts.projectSecret, opts.terminalId, opts.cols, opts.rows, opts.noSpawn === true);
    entries.set(key, entry);
  } else {
    // HS-8285 — drop any stale handles whose mountInto is detached
    // before evaluating "should we bump down the previous top?". A
    // popup / tile / pane whose container was destroyed without
    // release() running would otherwise pin the placeholder onto the
    // surface the user is actually looking at.
    pruneDetachedHandles(entry);
    if (entry.stack.length > 0) {
      const previousTop = entry.stack[entry.stack.length - 1];
      writePlaceholderInto(previousTop._options.mountInto, previousTop._options.placeholderBackground);
      try { previousTop._options.onBumpedDown?.(); } catch { /* consumer error doesn't break the swap */ }
    }
  }

  reparentXtermInto(entry, opts.mountInto);
  applyResizeIfChanged(entry, opts.cols, opts.rows);
  // HS-8301 — apply this consumer's readOnly flag now that the term is
  // mounted into their `mountInto`. The flag follows the top-of-stack:
  // bumping down / releasing re-runs this against the new top's options.
  applyTopReadOnly(entry, opts.readOnly === true);
  // HS-8619 — sync the renderer to this consumer's `scaled` flag (DOM for
  // CSS-scaled tiles, WebGL for full-size). Follows the top-of-stack too.
  reconcileRenderer(entry, opts.scaled === true);

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

  // HS-8285 — drop any stale handles whose mountInto is detached so the
  // restore-on-release path lands on a consumer that actually has a
  // visible container. Without this, releasing the live top while a
  // detached handle sits at index 0 would reparent the xterm into a
  // detached node, leaving every visible surface stuck on the
  // placeholder.
  pruneDetachedHandles(entry);

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
  // HS-8301 — re-apply the new top's readOnly flag. A read-only popup
  // releasing must hand typing back to a non-readOnly underlying
  // consumer (drawer pane / dashboard tile).
  applyTopReadOnly(entry, newTop._options.readOnly === true);
  // HS-8619 — re-sync the renderer to the new top. E.g. closing the dashboard
  // restores the drawer pane (non-scaled) → WebGL reloads; bumping a drawer
  // down under a grid tile (scaled) → WebGL disposes for DOM.
  reconcileRenderer(entry, newTop._options.scaled === true);
  try { newTop._options.onRestoredToTop?.(); } catch { /* consumer error doesn't break the restore */ }
}

/** HS-8301 — toggle the live xterm's stdin gate to match the current top
 *  consumer's `readOnly` flag. xterm.js honours `term.options.disableStdin`
 *  for typed input (the buffer scroll + selection + copy/paste paths are
 *  not affected). Idempotent — assigning the same value is a no-op. */
function applyTopReadOnly(entry: StackEntry, readOnly: boolean): void {
  entry.term.options.disableStdin = readOnly;
}

/**
 * HS-8619 — keep the active renderer in sync with the top-of-stack consumer's
 * `scaled` flag. A CSS-`transform: scale(...)` tile consumer (§25 dashboard /
 * §36 drawer-grid grid + magnified overlay) wants the DOM renderer — the WebGL
 * canvas raster-scales badly under a CSS transform. A full-size consumer
 * (drawer pane / dedicated view, both real-`fit()`) wants WebGL. Mirrors
 * `applyTopReadOnly`: called on every stack-shape change (checkout push +
 * release-restore) with the new top's flag, and toggles only on an actual
 * change so drawer↔dashboard transitions don't churn the addon needlessly.
 * No-op when WebGL was never desired for this entry.
 */
function reconcileRenderer(entry: StackEntry, scaled: boolean): void {
  const wantWebgl = webglWantedForConsumer(entry.webglDesired, scaled);
  const haveWebgl = entry.webglAddon !== null;
  if (wantWebgl === haveWebgl) return;

  if (wantWebgl) {
    // Load AFTER `term.open()` (done in createEntry) — the addon attaches to
    // the opened renderer. The constructor can still throw on a blacklisted
    // GPU even when the WebGL2 probe passed; on throw, leave the DOM renderer
    // (xterm uses DOM whenever no renderer addon is loaded).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch { /* already disposed */ }
        entry.webglAddon = null;
        // No client-side command-log append API exists; a console warning is
        // the diagnostic channel for this rare GPU event.
        console.warn(`[terminal] WebGL context lost for ${entry.secret.slice(0, 8)}::${entry.terminalId} — falling back to the DOM renderer for this terminal.`);
      });
      entry.term.loadAddon(webgl);
      entry.webglAddon = webgl;
    } catch {
      entry.webglAddon = null;
    }
  } else {
    try { entry.webglAddon?.dispose(); } catch { /* already disposed */ }
    entry.webglAddon = null;
  }
}

/** Number of currently-mounted entries. Useful for tests + sanity checks. */
export function entryCount(): number {
  return entries.size;
}

/**
 * HS-8207 — read the live `(cols, rows)` an entry is currently sized to,
 * or `null` when no entry exists for `(secret, terminalId)`. Lets a
 * consumer that's about to call `checkout()` pre-pick the existing dims
 * so the swap-time `applyResizeIfChanged` is a no-op (no SIGWINCH, no
 * TUI redraw). The popup's live-checkout flow uses this to avoid the
 * "shows some content → shows completely different content" multi-phase
 * symptom: pre-fix, the popup hardcoded `cols: 100, rows: 30` which
 * fired one redraw, then the fit-retry resized to popup-fit dims firing
 * a second one back-to-back. With the existing-dims pass-through, only
 * the fit-retry's resize is visible to claude / the shell.
 *
 * Returns the term's CURRENT dims (not the bookkeeping `lastApplied*`),
 * matching the source-of-truth choice in `applyResizeIfChanged` per
 * HS-8051.
 */
export function peekEntryDims(secret: string, terminalId: string): { cols: number; rows: number } | null {
  const entry = entries.get(entryKey(secret, terminalId));
  if (entry === undefined) return null;
  return { cols: entry.term.cols, rows: entry.term.rows };
}

// HS-8286 — `peekStallTimestamps` / `subscribeStallState` exports
// removed. Both were public helpers for the per-pane / per-tile stall
// chip, which has been replaced by the global server-slow banner. The
// per-entry `stallSubscribers` set survives because the in-module
// `evaluateGlobalStall` watcher inside `createEntry` consumes it.

function notifyStallSubscribers(entry: StackEntry): void {
  for (const handler of entry.stallSubscribers) {
    try { handler(); } catch { /* swallow — subscriber callbacks are advisory */ }
  }
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
  /** HS-8218 — `true` when the entry was created via `checkout({ noSpawn: true })`. */
  noSpawn: boolean;
}> {
  const out: Array<{
    key: string;
    secret: string;
    terminalId: string;
    lastAppliedCols: number;
    lastAppliedRows: number;
    stackDepth: number;
    topMountInto: HTMLElement | null;
    noSpawn: boolean;
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
      noSpawn: entry.noSpawn,
    });
  }
  return out;
}

/** **TEST ONLY** — return the live `XTerm` for a `(secret, terminalId)`
 *  pair, or `null` if no entry exists. Lets unit tests poke
 *  `term.options.theme` directly to exercise downstream consumers (e.g.
 *  the HS-8058 quit-confirm theme-bg-cascade) without needing to wire a
 *  real WebSocket / appearance-loader pipeline. */
export function _getTermForTesting(secret: string, terminalId: string): XTerm | null {
  return entries.get(entryKey(secret, terminalId))?.term ?? null;
}

/** **TEST ONLY** — fire each stack consumer's `onNoLiveSession` callback
 *  for the entry at `(secret, terminalId)`, mirroring what the real
 *  WebSocket message handler does when it receives a `history` frame
 *  with `noSession: true`. The entry must have been created with
 *  `noSpawn: true`; otherwise the helper is a no-op (matching the prod
 *  gate). Marks `entry.intentionallyClosing` so the close-event listener
 *  skips its auto-reconnect path, the same way the prod code does.
 *  Used by HS-8218 popup tests to exercise the fallback-to-flat-preview
 *  path without standing up a real WebSocket. */
export function _simulateNoSessionForTesting(secret: string, terminalId: string): void {
  const entry = entries.get(entryKey(secret, terminalId));
  if (entry === undefined) return;
  if (!entry.noSpawn) return;
  entry.intentionallyClosing = true;
  for (const handle of entry.stack) {
    try { handle._options.onNoLiveSession?.(); } catch { /* swallow */ }
  }
}

/** **TEST ONLY** — drop every entry without going through dispose. Used
 *  by unit-test cleanup so a stray entry from one test doesn't bleed
 *  into the next. Real consumers use `release()`. */
export function _resetForTesting(): void {
  for (const entry of entries.values()) {
    if (entry.globalStallToken !== null) {
      try { entry.globalStallToken(); } catch { /* ignore */ }
      entry.globalStallToken = null;
    }
    if (entry.globalStallTickHandle !== null) {
      try { window.clearInterval(entry.globalStallTickHandle); } catch { /* ignore */ }
      entry.globalStallTickHandle = null;
    }
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
