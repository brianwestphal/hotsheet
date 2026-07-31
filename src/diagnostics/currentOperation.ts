// HS-9519 — a breadcrumb naming the operation the main thread is currently inside,
// published where a WEDGED main thread cannot stop it being read.
//
// The watchdog worker can already report memory at the moment of a wedge, which is
// what distinguishes GC thrash from a genuine block. It cannot say what the loop was
// *doing*, because every log the main thread writes requires the main thread to run —
// and during a wedge it never does. A `SharedArrayBuffer` sidesteps that entirely:
// the main thread writes the label on entry, and the worker reads the bytes directly
// out of shared memory whether or not the main thread is alive to cooperate.
//
// **This covers instrumented call sites only**, which is a real limit worth stating:
// the 2026-07-31 wedge was in something not instrumented, so this alone would not have
// named it. That is why `stackCapture.ts` exists alongside it — the breadcrumb answers
// cheaply when it can, the native stack answers when nothing else does.
//
// Deliberately dependency-free so the SAB layout can be shared with the watchdog
// without dragging the freeze logger into it.

/** Bytes reserved for the label. Long enough for a SQL-prefixed `pglite.query: …`
 *  context; anything longer is truncated rather than allowed to overrun. */
export const OPERATION_LABEL_BYTES = 256;

/** Slot 0 holds the byte length; the label starts at byte 4. Length first means a
 *  reader never has to scan for a terminator in memory that is being written to. */
const LENGTH_BYTES = 4;
export const OPERATION_SAB_BYTES = LENGTH_BYTES + OPERATION_LABEL_BYTES;

let sab: SharedArrayBuffer | null = null;
let lengthView: Int32Array | null = null;
let labelView: Uint8Array | null = null;
const encoder = new TextEncoder();

/** Create (once) and return the buffer handed to the watchdog worker. */
export function getOperationSab(): SharedArrayBuffer {
  if (sab === null) {
    sab = new SharedArrayBuffer(OPERATION_SAB_BYTES);
    lengthView = new Int32Array(sab, 0, 1);
    labelView = new Uint8Array(sab, LENGTH_BYTES, OPERATION_LABEL_BYTES);
  }
  return sab;
}

/**
 * Record that the main thread has entered `label`.
 *
 * Nesting is handled by depth, not by a stack of labels: the OUTERMOST operation is
 * kept, because that is the one whose duration contains the wedge. An inner call that
 * overwrote it would leave the log naming a fast helper while the slow caller — the
 * thing worth knowing — went unrecorded.
 */
let depth = 0;
export function enterOperation(label: string): void {
  getOperationSab();
  if (lengthView === null || labelView === null) return;
  depth += 1;
  if (depth > 1) return; // keep the outermost
  const bytes = encoder.encode(label).subarray(0, OPERATION_LABEL_BYTES);
  labelView.set(bytes);
  // Length last: a reader that catches a torn write sees the OLD length with new
  // bytes, never a length longer than what has actually been written.
  Atomics.store(lengthView, 0, bytes.length);
}

/** Record that the outermost operation finished. */
export function exitOperation(): void {
  if (lengthView === null) return;
  depth -= 1;
  if (depth > 0) return;
  depth = 0; // never go negative on an unbalanced exit
  Atomics.store(lengthView, 0, 0);
}

/** Read the current label back — used by tests, and mirrored inline by the worker. */
export function readCurrentOperation(): string | null {
  if (lengthView === null || labelView === null) return null;
  const len = Atomics.load(lengthView, 0);
  if (len <= 0) return null;
  return new TextDecoder().decode(labelView.subarray(0, len));
}

/** Test-only reset. */
export function _resetCurrentOperationForTesting(): void {
  sab = null;
  lengthView = null;
  labelView = null;
  depth = 0;
}
