// HS-9519 — the breadcrumb a wedged main thread leaves behind.
//
// The point of the SharedArrayBuffer is that reading it does NOT require the main
// thread to cooperate. These tests pin the semantics the watchdog worker relies on,
// including the nesting rule, which is the one that decides whether the FATAL line
// names the slow caller or a fast helper inside it.

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetCurrentOperationForTesting,
  enterOperation,
  exitOperation,
  getOperationSab,
  OPERATION_LABEL_BYTES,
  readCurrentOperation,
} from './currentOperation.js';

afterEach(() => { _resetCurrentOperationForTesting(); });

/** Decode the way the watchdog worker does — straight out of shared memory, with no
 *  help from this module, so the worker's inlined logic is what is actually verified. */
function readLikeTheWorker(sab: SharedArrayBuffer): string | null {
  const len = Atomics.load(new Int32Array(sab, 0, 1), 0);
  if (len <= 0) return null;
  return new TextDecoder().decode(new Uint8Array(sab, 4, len));
}

describe('currentOperation breadcrumb', () => {
  it('is empty before anything runs', () => {
    expect(readCurrentOperation()).toBeNull();
  });

  it('publishes the label, and the WORKER decode agrees', () => {
    const sab = getOperationSab();
    enterOperation('pglite.dumpDataDir: gzip');
    expect(readCurrentOperation()).toBe('pglite.dumpDataDir: gzip');
    // The assertion that matters: the worker reads bytes, not this module.
    expect(readLikeTheWorker(sab)).toBe('pglite.dumpDataDir: gzip');
  });

  it('clears on exit', () => {
    enterOperation('git.getStatus');
    exitOperation();
    expect(readCurrentOperation()).toBeNull();
  });

  it('keeps the OUTERMOST label when nested', () => {
    // The outer operation is the one whose duration contains the wedge. Letting an
    // inner call overwrite it would name a fast helper while the slow caller — the
    // thing actually worth knowing — went unrecorded.
    enterOperation('backup.writeTarball:5min');
    enterOperation('fsyncDbDir');
    expect(readCurrentOperation()).toBe('backup.writeTarball:5min');
    exitOperation(); // inner
    expect(readCurrentOperation()).toBe('backup.writeTarball:5min'); // still inside the outer
    exitOperation(); // outer
    expect(readCurrentOperation()).toBeNull();
  });

  it('truncates an over-long label instead of overrunning the buffer', () => {
    const long = 'pglite.query: ' + 'x'.repeat(OPERATION_LABEL_BYTES * 2);
    enterOperation(long);
    const got = readCurrentOperation();
    expect(got).not.toBeNull();
    expect(new TextEncoder().encode(got ?? '').length).toBeLessThanOrEqual(OPERATION_LABEL_BYTES);
    expect(got?.startsWith('pglite.query: ')).toBe(true); // the useful prefix survives
  });

  it('survives an unbalanced exit without going negative', () => {
    // A throw inside an instrumented block could otherwise leave depth negative, after
    // which the NEXT operation would never publish — the breadcrumb would silently die.
    exitOperation();
    exitOperation();
    enterOperation('after-unbalanced');
    expect(readCurrentOperation()).toBe('after-unbalanced');
  });

  it("reuses one buffer, so the worker's handle stays valid", () => {
    expect(getOperationSab()).toBe(getOperationSab());
  });
});
