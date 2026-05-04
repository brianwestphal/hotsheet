import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as XTerm } from '@xterm/xterm';

import {
  _getEntryForTesting,
  pauseEntryWrites,
  resumeEntryWritesAndDrain,
  sendPtyResize,
  takePausedBytes,
} from './terminalCheckout.js';

// HS-8139 v3 (2026-05-04) — `captureTerminalSnapshot` now tries
// `serializeLiveTerm` FIRST, only falling back to the resize-based
// dance when the live xterm buffer is itself blank. The user reported
// that the resize path was mounting a mirror xterm showing only the
// input-box / status-bar bytes Claude emitted during the resize wait,
// because the offscreen xterm starts blank and only sees the bytes
// since pause — when Claude has settled into a permission dialog and
// only redraws the input box on SIGWINCH, the offscreen result loses
// the dialog/diff context entirely. The live xterm is what the user
// is actually looking at, with full scrollback available — serialize
// it unchanged so the popup mirrors the real terminal state.
//
// HS-8159 — `serializeLiveTerm` was originally introduced as a
// resize-bail fallback. It now serves as the primary path; the resize
// dance survives only as a last-resort when the live term is blank.

/**
 * HS-7999 — capture a snapshot of the terminal-backed Claude's
 * current rendering for use as the body of the §47 permission popup.
 *
 * **Primary path (HS-8139 v3, 2026-05-04):** `serializeLiveTerm` reads
 * the live `xterm.js` buffer (visible region + scrollback) for the
 * `(secret, terminalId)` entry. The popup mirror xterm is mounted at
 * the live geometry with the captured stream — picture-perfect
 * mirror of what the user is actually looking at, with mouse-wheel
 * scrollback.
 *
 * **Fallback path (legacy HS-7999):** when the live term has no
 * visible content (rare — fresh launch, no Claude output yet), we
 * fall back to the resize-and-capture orchestration: freeze + temp-
 * resize + serialize + restore + replay dance against the per-
 * `(secret, terminalId)` `terminalCheckout` entry's PTY:
 *
 *   1. **Freeze** — `pauseEntryWrites` diverts incoming WS-binary
 *      bytes into an entry-side buffer. The live term keeps its
 *      pre-snapshot display unchanged for the duration of the swap.
 *   2. **Resize PTY up** — `sendPtyResize` sends a `{type:'resize', cols:200, rows:80}`
 *      frame so Claude's TUI redraws at the wider
 *      geometry. Bytes accumulate in the paused buffer.
 *   3. **Serialize** — `takePausedBytes` drains the accumulated bytes,
 *      writes them into an OFFSCREEN `XTerm` at the wider geometry
 *      (loaded with `SerializeAddon`), and `serialize()` produces the
 *      escape-sequence string the popup will render.
 *   4. **Resize PTY back** — second `sendPtyResize` frame restores the
 *      original geometry. Claude redraws at the original cols. Bytes
 *      accumulate in the paused buffer (now post-resize-back only).
 *   5. **Unfreeze** — `resumeEntryWritesAndDrain` writes the accumulated
 *      bytes (post-resize-back redraw) to the LIVE term and clears the
 *      pause flag. The live view goes from pre-snapshot state directly
 *      to the post-resize-back state with no intermediate rendering of
 *      the wider geometry. No visible flicker on the live terminal.
 *
 * Pre-fix `permissionOverlay.tsx` showed the channel-truncated
 * `input_preview` (Claude's MCP channel cuts at ~2000 chars, appending
 * a `…` marker via `permissionPreview.ts::extractStringField`). Long
 * prompts were rendered as bare `…` since the channel data was cut off
 * before `formatInputPreview`'s primary-field extractor could find a
 * value. With this snapshot, the popup body shows a mirror xterm
 * rendering of the actual Claude TUI at 200x80 — picture-perfect
 * colour / cursor / wrap regardless of how truncated the channel
 * preview was.
 *
 * Caller-perceived cost: ~500 ms total (default `redrawWaitMs` of
 * 250 × 2 phases). The user is looking at the popup during this window
 * so the live terminal pause is invisible. If the terminal is mid-
 * keystroke when the snapshot starts, the user's typed bytes still
 * reach the PTY (only the inbound stream is paused) but echo is
 * delayed until unfreeze; in practice the popup-mount path means the
 * user is looking at the popup, not typing. If a user-keystroke
 * race becomes a real problem we can add a "skip snapshot if
 * `term.onData` fired in the last 200ms" guard.
 */

export interface CaptureSnapshotOptions {
  /** Temporary cols to resize the PTY to during the snapshot. 200 is the
   *  width Claude's Ink renders prompts at when run in a tmux pane the
   *  user explicitly widened — the spec value from HS-7999's design
   *  note. */
  tempCols: number;
  /** Temporary rows. 80 gives Claude enough vertical space to render
   *  multi-line prompts (file diffs, long Bash command-line previews,
   *  etc.) without the trailing context scrolling out of the buffer. */
  tempRows: number;
  /** ms to wait after each PTY resize for Claude's TUI to finish
   *  redrawing. Default 250 ms — empirically the time Claude takes to
   *  emit the full redraw on a SIGWINCH. Lower values risk capturing
   *  a half-rendered TUI; higher values increase total snapshot time
   *  proportionally. */
  redrawWaitMs?: number;
}

export interface SnapshotResult {
  /** The serialized escape-sequence stream the consumer can `term.write()`
   *  into a fresh `XTerm`. Includes colours, cursor positioning, line
   *  wrapping — picture-perfect reproduction of the captured frame. */
  stream: string;
  /** The cols the snapshot was captured at. Mirror xterm should mount at
   *  these dims so the wrap matches the captured stream. */
  cols: number;
  /** The rows the snapshot was captured at. */
  rows: number;
}

/**
 * Capture a snapshot of the terminal-backed Claude's current rendering
 * at the requested temp geometry. Returns null when no entry exists for
 * `(secret, terminalId)` or no WebSocket is open (the only viable
 * fallback paths are then "show the channel-truncated preview verbatim"
 * — caller's responsibility).
 *
 * Idempotent across same-key calls — but DON'T overlap calls for the
 * same entry concurrently. The pause flag is module-level state on the
 * entry; a second concurrent call would see `paused: true` already and
 * its `takePausedBytes` would race the first call's. The natural
 * single-popup serialisation in `permissionOverlay.tsx` (one popup at
 * a time per `activePopupRequestId`) keeps this safe.
 */
export async function captureTerminalSnapshot(
  secret: string,
  terminalId: string,
  opts: CaptureSnapshotOptions,
): Promise<SnapshotResult | null> {
  // HS-8139 v3 — primary path: serialize the live xterm as-is. The
  // user wants the popup body to mirror what the actual terminal is
  // showing. `serializeLiveTerm` returns the full visible region +
  // 1000-row scrollback at the live geometry, which the popup mirror
  // xterm renders with native mouse-wheel scrollback so the user can
  // scroll up to see content beyond the visible region.
  const live = serializeLiveTerm(secret, terminalId);
  if (live !== null) return live;

  // Fallback (rare) — the live xterm buffer is blank (or no entry).
  // In that case, try to coax Claude into a fresh redraw by briefly
  // resizing the PTY and capturing the bytes Claude emits in
  // response. Returns null when no entry / no WebSocket.
  const entry = _getEntryForTesting(secret, terminalId);
  if (entry === null) return null;
  if (entry.ws === null || entry.ws.readyState !== WebSocket.OPEN) return null;

  const origCols = entry.term.cols;
  const origRows = entry.term.rows;
  const targetCols = opts.tempCols;
  const targetRows = opts.tempRows;
  const waitMs = opts.redrawWaitMs ?? 250;

  // Step 1 — pause writes. The live term will not see any of the
  // PTY bytes that arrive between now and `resumeEntryWritesAndDrain`.
  pauseEntryWrites(secret, terminalId);

  try {
    // Step 2 — resize PTY up. Claude redraws at the wider geometry
    // and emits the redraw bytes back over the WS; they accumulate in
    // the entry's pausedBytes buffer.
    sendPtyResize(secret, terminalId, targetCols, targetRows);
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // Step 3 — serialize. Drain the buffered bytes, write them to an
    // offscreen `XTerm` at the temp geometry, capture state via
    // `SerializeAddon`. The offscreen term is disposed before return.
    const wideRedraw = takePausedBytes(secret, terminalId);
    if (wideRedraw.byteLength === 0) {
      // No bytes — Claude wasn't redrawing. Bail; the popup keeps
      // the (truncated) flat preview.
      await restoreAndUnpause(secret, terminalId, origCols, origRows, waitMs);
      return null;
    }
    const stream = serializeOffscreen(wideRedraw, targetCols, targetRows);

    // HS-8158 — even when the resize redraw produced bytes, those bytes
    // can be 100% ANSI control sequences (cursor positioning, attribute
    // resets, clear-screen) with no printable content. Bail to avoid
    // mounting a fully-black mirror xterm.
    if (!streamHasVisibleContent(stream)) {
      await restoreAndUnpause(secret, terminalId, origCols, origRows, waitMs);
      return null;
    }

    // Step 4 — resize PTY back to original. Claude redraws at the
    // original geometry. Bytes accumulate in the (now-emptied)
    // pausedBytes buffer for the next phase.
    sendPtyResize(secret, terminalId, origCols, origRows);
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // Step 5 — unfreeze. The accumulated bytes (post-resize-back
    // redraw + any other live output during the snapshot window) are
    // written to the live term in one batch, then the pause flag
    // clears so future bytes flow normally.
    resumeEntryWritesAndDrain(secret, terminalId);

    return { stream, cols: targetCols, rows: targetRows };
  } catch {
    // Defensive — if anything throws between pause and resume the live
    // term would be stuck paused forever. Always restore the pause
    // flag + drain the buffer on the failure path.
    try { resumeEntryWritesAndDrain(secret, terminalId); } catch { /* */ }
    return null;
  }
}

/**
 * HS-8159 / HS-8139 v3 — primary path for `captureTerminalSnapshot`:
 * serialize the LIVE entry's `xterm.js` buffer (visible region +
 * scrollback) and return it as a `SnapshotResult` at the live
 * geometry. The popup mirror xterm renders the captured stream
 * unchanged, with native mouse-wheel scrollback so the user can
 * scroll up through every row Claude has written (including the
 * diff content scrolled out of the visible region) — strictly more
 * content than the MCP-truncated `input_preview` could carry.
 *
 * Returns null when:
 * - No entry exists for `(secret, terminalId)`.
 * - `SerializeAddon` throws (malformed buffer state — defensive).
 * - The serialized stream has no visible content (the live term is
 *   blank, e.g. user just connected — nothing to show in the popup).
 *   In that case `captureTerminalSnapshot` falls back to its legacy
 *   resize-based capture path.
 */
export function serializeLiveTerm(secret: string, terminalId: string): SnapshotResult | null {
  const entry = _getEntryForTesting(secret, terminalId);
  if (entry === null) return null;
  const term = entry.term;
  let stream = '';
  try {
    const ser = new SerializeAddon();
    term.loadAddon(ser);
    stream = ser.serialize();
    try { ser.dispose(); } catch { /* */ }
  } catch {
    return null;
  }
  if (!streamHasVisibleContent(stream)) return null;
  return { stream, cols: term.cols, rows: term.rows };
}

/**
 * HS-8158 — pure helper that returns true when `stream` contains at
 * least one printable, non-whitespace character once ANSI control
 * sequences are stripped. Used by the snapshot orchestrator to bail
 * out instead of mounting a fully-black mirror xterm for a redraw
 * that produced only structural escape sequences.
 *
 * Stripped sequence shapes:
 * - CSI:  `ESC [` … final byte in `0x40-0x7E`
 * - OSC:  `ESC ]` … `BEL` or `ESC \`
 * - DCS / SOS / PM / APC: `ESC P|X|^|_` … `ESC \`
 * - Single-byte ESC sequences (`ESC =`, `ESC >`, charset selectors, …)
 * - Remaining C0 / DEL control chars
 * - All whitespace (space, tab, newline, NBSP, etc.)
 *
 * Anything left over is "visible content" and we proceed to mount
 * the mirror xterm.
 */
export function streamHasVisibleContent(stream: string): boolean {
  if (stream === '') return false;
  const visible = stream
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')   // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')           // OSC (BEL or ST terminator)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')                    // DCS / SOS / PM / APC
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b./g, '')                                        // remaining 2-char ESC
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')                              // remaining C0 / DEL
    .replace(/\s/g, '');                                          // any unicode whitespace
  return visible.length > 0;
}

/**
 * HS-8158 — shared post-bail-out cleanup: send the geometry-restore
 * resize, wait for Claude's redraw, drain the buffered bytes through
 * to the live term, and clear the pause flag. Used by both bail
 * paths (no bytes received / serialized stream has no visible content).
 */
async function restoreAndUnpause(
  secret: string,
  terminalId: string,
  origCols: number,
  origRows: number,
  waitMs: number,
): Promise<void> {
  sendPtyResize(secret, terminalId, origCols, origRows);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  resumeEntryWritesAndDrain(secret, terminalId);
}

/**
 * Build a one-shot offscreen `XTerm` at `(cols, rows)`, write the
 * captured bytes to it, serialize via `SerializeAddon`, then dispose.
 * Mounted into a hidden parking sink so `term.open()` has somewhere
 * to live (xterm requires a parent for its initial layout pass even
 * for non-rendering serialize work).
 */
function serializeOffscreen(bytes: Uint8Array, cols: number, rows: number): string {
  const sink = getOrCreateOffscreenSink();
  const term = new XTerm({ cols, rows, scrollback: 1000, allowProposedApi: true });
  const ser = new SerializeAddon();
  term.loadAddon(ser);
  try {
    term.open(sink);
    if (bytes.byteLength > 0) {
      term.write(bytes);
    }
    return ser.serialize();
  } finally {
    try { term.dispose(); } catch { /* */ }
  }
}

/** Module-level offscreen sink — created lazily once and reused so we
 *  don't churn DOM nodes per snapshot. Hidden via inline styles so it
 *  doesn't affect layout. */
let offscreenSink: HTMLElement | null = null;
function getOrCreateOffscreenSink(): HTMLElement {
  if (offscreenSink !== null && offscreenSink.isConnected) return offscreenSink;
  // HS-8098 — direct `document.createElement` is intentional here: the
  // sink is a capture target for the offscreen serialiser xterm and
  // never serves as JSX content. Same exception rationale as
  // `terminalCheckout.tsx::getOrCreateParkingSink`. (File is `.ts`,
  // not `.tsx`, so even if we wanted to use `toElement(<jsx/>)` here
  // the JSX runtime isn't enabled for this module — separately
  // tracked for future migration.)
  const sink = document.createElement('div');
  sink.id = 'terminal-snapshot-offscreen-sink';
  sink.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  document.body.appendChild(sink);
  offscreenSink = sink;
  return sink;
}

/**
 * Mount a read-only mirror `XTerm` into `parent` and write the captured
 * `stream` into it. Returns `{ term, dispose }` so the caller can
 * tear down when the popup closes.
 *
 * Used by `permissionOverlay.tsx` — the dialog shell's `bodyElement`
 * slot accepts a pre-built DOM tree, and the mirror xterm renders
 * picture-perfect colour / cursor / wrap of Claude's TUI at the
 * temp geometry.
 */
export function mountMirrorXterm(
  parent: HTMLElement,
  stream: string,
  cols: number,
  rows: number,
): { term: XTerm; dispose: () => void } {
  const term = new XTerm({
    cols,
    rows,
    scrollback: 1000,
    cursorBlink: false,
    disableStdin: true,
    allowProposedApi: true,
  });
  term.open(parent);
  if (stream !== '') term.write(stream);
  return {
    term,
    dispose: () => { try { term.dispose(); } catch { /* */ } },
  };
}

/**
 * Pure helper — find the second `\x1b[2J\x1b[H` clear-and-home sequence
 * inside `bytes` and return everything from that point onwards. Used
 * by callers that want to drop pre-second-clear noise from a
 * post-snapshot byte stream (e.g. when the snapshot orchestration is
 * single-pause-replay rather than the two-phase drain in
 * `captureTerminalSnapshot`). Exported for the unit test.
 *
 * Returns an empty array when the second clear isn't found — the
 * caller's "drop everything before the second clear" semantics imply
 * "drop everything if we never saw two clears at all".
 */
export function dropBeforeSecondClear(bytes: Uint8Array): Uint8Array {
  const seq = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x48]); // \x1b[2J\x1b[H
  const first = findSubarray(bytes, seq, 0);
  if (first === -1) return new Uint8Array();
  const second = findSubarray(bytes, seq, first + seq.byteLength);
  if (second === -1) return new Uint8Array();
  return bytes.subarray(second);
}

function findSubarray(haystack: Uint8Array, needle: Uint8Array, fromIndex: number): number {
  if (needle.byteLength === 0) return fromIndex;
  if (haystack.byteLength < needle.byteLength) return -1;
  outer: for (let i = fromIndex; i <= haystack.byteLength - needle.byteLength; i += 1) {
    for (let j = 0; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
