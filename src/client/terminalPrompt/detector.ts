/**
 * HS-7971 Phase 1 — debounced buffer scanner that hands matched prompts
 * to the overlay.
 *
 * One detector per terminal instance. The detector is stateful per-instance
 * so we can implement per-instance suppression (§52.3.3 — "Not a prompt"
 * dismissal turns off scans for this terminal until the user types into it
 * again). Module-level registry `detectors` keys instances by terminal id.
 *
 * Pure types + the debounce-and-dispatch logic; the actual "scan the xterm
 * buffer" callback is a function the caller passes in (terminal.tsx already
 * holds the xterm Terminal handle). Decouples this module from xterm so
 * unit tests can drive the detector with synthetic row arrays.
 */

import type { MatchResult } from './parsers.js';
import { runParserRegistry } from './parsers.js';

/** Debounce window — see §52.3.2. 100 ms is the design target. */
export const SCAN_DEBOUNCE_MS = 100;

/** How many rows from the bottom of the visible buffer to scan. Picked to
 *  cover Claude-Ink prompts (typically 4–8 rows of choices + the trailing
 *  footer) PLUS the inline diff Claude shows above an Edit-tool prompt
 *  (HS-7980 — diff up to ~25 rows). Larger windows risk false positives on
 *  docs / chatty output, but the footer-must-be-trailing rule (§52.3.3) is
 *  the dominant false-positive guard, so we can afford the larger window. */
export const SCAN_ROW_COUNT = 30;

export interface DetectorHooks {
  /** Read the last N visible rows from the terminal's buffer. Caller knows
   *  how to call `term.buffer.active.getLine(...)` etc. */
  readRows: (rowCount: number) => string[];
  /** True iff this terminal pane is the active drawer / dashboard pane.
   *  Inactive terminals don't surface overlays — we'd be answering for a
   *  pane the user can't see. */
  isActive: () => boolean;
  /** Fire when the parser registry returns a match. Caller mounts the
   *  overlay; an `onClose` callback inside the overlay should call
   *  `markDetectorClosed(detector)` to allow re-firing on the next chunk.
   *  Caller should NOT mount a second overlay if one is already open for
   *  the same instance — the detector will skip dispatching while the
   *  `overlayOpen` flag is set. */
  onMatch: (match: MatchResult) => void;
}

export interface Detector {
  hooks: DetectorHooks;
  /** Pending debounce timer — cleared by every `notifyChunk`. */
  pending: ReturnType<typeof setTimeout> | null;
  /** True while an overlay is mounted for this detector. The detector
   *  skips dispatching while this flag is true so the overlay doesn't
   *  thrash on subsequent chunks. */
  overlayOpen: boolean;
  /** True while the user has dismissed an overlay as "not a prompt".
   *  Cleared by `notifyUserKeystroke` so a subsequent prompt re-arms
   *  detection. */
  suppressed: boolean;
  /** Last match signature dispatched. Skip re-dispatching the same
   *  signature back-to-back so a static prompt that bumps the buffer (e.g.
   *  cursor blink) doesn't re-open the overlay every 100 ms. */
  lastDispatchedSignature: string | null;
}

/** Construct a detector. Call `notifyChunk()` from the caller's WebSocket
 *  message handler after each `term.write(...)`. */
export function createDetector(hooks: DetectorHooks): Detector {
  return {
    hooks,
    pending: null,
    overlayOpen: false,
    suppressed: false,
    lastDispatchedSignature: null,
  };
}

/** A new chunk has arrived from the PTY. Schedule a debounced scan. */
export function notifyChunk(detector: Detector): void {
  if (detector.pending !== null) clearTimeout(detector.pending);
  detector.pending = setTimeout(() => {
    detector.pending = null;
    runScan(detector);
  }, SCAN_DEBOUNCE_MS);
}

/** Cancel any pending scan and reset state. Call on terminal teardown. */
export function disposeDetector(detector: Detector): void {
  if (detector.pending !== null) clearTimeout(detector.pending);
  detector.pending = null;
  detector.overlayOpen = false;
  detector.suppressed = false;
  detector.lastDispatchedSignature = null;
}

/** Mark a detector's overlay as closed so the next chunk can dispatch
 *  again. The overlay caller wires this into its `onClose` handler. */
export function markDetectorClosed(detector: Detector): void {
  detector.overlayOpen = false;
}

/** Mark a detector as "user said this isn't a prompt". Suppresses further
 *  dispatches until `notifyUserKeystroke` or `clearDetectorSuppression` is
 *  called. */
export function markDetectorSuppressed(detector: Detector): void {
  detector.suppressed = true;
  detector.overlayOpen = false;
}

/** Pure check exported so the toolbar chip (HS-7986 Phase 2) can show /
 *  hide based on detector state without poking at the field directly. */
export function isDetectorSuppressed(detector: Detector): boolean {
  return detector.suppressed;
}

/** HS-7986 — explicit "user clicked Resume in the toolbar chip". Clears
 *  suppression so the next prompt fires again. Identical effect to
 *  `notifyUserKeystroke` but named after the user's intent so the call site
 *  reads cleanly. */
export function clearDetectorSuppression(detector: Detector): void {
  detector.suppressed = false;
}

/** The user typed something into this terminal. Clears suppression so a
 *  subsequent prompt (different shape, different question) re-arms
 *  detection. */
export function notifyUserKeystroke(detector: Detector): void {
  detector.suppressed = false;
  // Don't reset lastDispatchedSignature here — that protects against
  // re-firing on the same prompt; clearing it on every keystroke would
  // re-open the overlay if the user started typing then realised they
  // wanted the overlay back. The signature only matters for back-to-back
  // identical scans.
}

/** Pure helper, exported for tests. Runs the parser registry and decides
 *  whether the detector should dispatch. Returns the match (or null) and
 *  the next `lastDispatchedSignature` value. */
export function decideDispatch(
  rows: readonly string[],
  detector: Pick<Detector, 'overlayOpen' | 'suppressed' | 'lastDispatchedSignature'>,
): { match: MatchResult | null; nextLastSig: string | null } {
  if (detector.overlayOpen || detector.suppressed) {
    return { match: null, nextLastSig: detector.lastDispatchedSignature };
  }
  const match = runParserRegistry(rows);
  if (match === null) {
    // No prompt visible — clear lastDispatchedSignature so a freshly-
    // arriving identical prompt later still fires (the user might have
    // dismissed and the prompt redrawn).
    return { match: null, nextLastSig: null };
  }
  if (match.signature === detector.lastDispatchedSignature) {
    return { match: null, nextLastSig: detector.lastDispatchedSignature };
  }
  return { match, nextLastSig: match.signature };
}

function runScan(detector: Detector): void {
  if (!detector.hooks.isActive()) return;
  const rows = detector.hooks.readRows(SCAN_ROW_COUNT);
  const { match, nextLastSig } = decideDispatch(rows, detector);
  detector.lastDispatchedSignature = nextLastSig;
  if (match === null) return;
  detector.overlayOpen = true;
  detector.hooks.onMatch(match);
}
