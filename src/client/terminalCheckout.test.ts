// @vitest-environment happy-dom
/**
 * HS-8031 Phase 1 — unit tests for the global terminal-checkout module.
 *
 * Drives the module through happy-dom (no real WebSocket — the module
 * detects `typeof WebSocket === 'undefined'` and falls back to ws=null,
 * which is the right behaviour under happy-dom). Tests focus on the
 * stack semantics, the resize-skip rule, the placeholder rendering, the
 * cross-project independence, and the dispose-on-empty-stack invariant.
 *
 * Real-WebSocket round-trips + scrollback replay are covered by the
 * Phase 2 (HS-8032) Playwright e2e — Phase 1 ships infrastructure only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _getEntryForTesting,
  _inspectStackForTesting,
  _resetForTesting,
  applyHistoryReplay,
  checkout,
  entryCount,
} from './terminalCheckout.js';

beforeEach(() => {
  document.body.innerHTML = '';
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
  document.body.innerHTML = '';
});

function makeMount(id: string): HTMLDivElement {
  const div = document.createElement('div');
  div.id = id;
  div.style.width = '400px';
  div.style.height = '200px';
  document.body.appendChild(div);
  return div;
}

describe('checkout — single consumer (HS-8031)', () => {
  it('creates an entry on first checkout', () => {
    const m = makeMount('m1');
    const handle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: m,
    });
    expect(entryCount()).toBe(1);
    expect(handle.isTopOfStack()).toBe(true);
    expect(handle.term).toBeDefined();
    handle.release();
  });

  it('mounts the live xterm element into mountInto', () => {
    const m = makeMount('m1');
    const handle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: m,
    });
    // xterm always has an `element` once `term.open()` ran (the module
    // opens into the parking sink in the constructor, then reparents).
    expect(handle.term.element).toBeDefined();
    expect(handle.term.element?.parentElement).toBe(m);
    handle.release();
  });

  it('disposes the entry when the only consumer releases', () => {
    const m = makeMount('m1');
    const handle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: m,
    });
    expect(entryCount()).toBe(1);
    handle.release();
    expect(entryCount()).toBe(0);
  });

  it('release() is idempotent — calling twice doesnt throw', () => {
    const m = makeMount('m1');
    const handle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: m,
    });
    handle.release();
    expect(() => handle.release()).not.toThrow();
    expect(entryCount()).toBe(0);
  });
});

describe('checkout — LIFO stack (HS-8031)', () => {
  it('pushes a second checkout onto the stack — placeholder writes into the previous mountInto', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const onBumpedDown = vi.fn();
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      onBumpedDown,
    });
    expect(handleA.isTopOfStack()).toBe(true);
    expect(handleA.term.element?.parentElement).toBe(mA);

    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    expect(handleA.isTopOfStack()).toBe(false);
    expect(handleB.isTopOfStack()).toBe(true);
    // Live xterm reparented into B's mountInto.
    expect(handleA.term.element?.parentElement).toBe(mB);
    // A's mountInto now holds the placeholder.
    expect(mA.querySelector('.terminal-checkout-placeholder')).not.toBe(null);
    expect(mA.querySelector('.terminal-checkout-placeholder-text')?.textContent).toBe('Terminal in use elsewhere');
    // onBumpedDown fired exactly once for the bumped consumer.
    expect(onBumpedDown).toHaveBeenCalledTimes(1);
    // Only one entry, but stack depth is 2.
    expect(entryCount()).toBe(1);
    expect(_inspectStackForTesting()[0]?.stackDepth).toBe(2);
    handleB.release();
    handleA.release();
  });

  it('release() of the top restores the previous consumer + fires onRestoredToTop', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const onRestoredToTop = vi.fn();
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      onRestoredToTop,
    });
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    handleB.release();
    expect(handleA.isTopOfStack()).toBe(true);
    expect(handleA.term.element?.parentElement).toBe(mA);
    // A's placeholder cleared (live xterm replaced it).
    expect(mA.querySelector('.terminal-checkout-placeholder')).toBe(null);
    expect(onRestoredToTop).toHaveBeenCalledTimes(1);
    handleA.release();
  });

  it('release() of a non-top handle leaves the live xterm where it is', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const onRestoredToTopA = vi.fn();
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      onRestoredToTop: onRestoredToTopA,
    });
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    // Release A while B is on top — no DOM swap, no restore callback.
    handleA.release();
    expect(handleB.isTopOfStack()).toBe(true);
    expect(handleB.term.element?.parentElement).toBe(mB);
    expect(onRestoredToTopA).not.toHaveBeenCalled();
    expect(_inspectStackForTesting()[0]?.stackDepth).toBe(1);
    handleB.release();
  });

  it('disposes the entry only when the last consumer releases', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    handleB.release();
    expect(entryCount()).toBe(1);
    handleA.release();
    expect(entryCount()).toBe(0);
  });
});

describe('checkout — resize policy (HS-8031 §54.3.1)', () => {
  it('updates lastApplied dims when the new top requests a different size', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(80);
    expect(_inspectStackForTesting()[0]?.lastAppliedRows).toBe(24);
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 120,
      rows: 30,
      mountInto: mB,
    });
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(120);
    expect(_inspectStackForTesting()[0]?.lastAppliedRows).toBe(30);
    handleB.release();
    handleA.release();
  });

  it('skips the resize when the new top requests the same dims', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    // Spy on the xterm's resize after the entry was created. We can't
    // easily intercept the WS send under happy-dom (no WebSocket), but we
    // can verify the term.resize() call is NOT made on a same-size swap.
    const resizeSpy = vi.spyOn(handleA.term, 'resize');
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    expect(resizeSpy).not.toHaveBeenCalled();
    handleB.release();
    handleA.release();
  });

  it('fires the xterm resize when the new top requests different dims', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const resizeSpy = vi.spyOn(handleA.term, 'resize');
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 120,
      rows: 30,
      mountInto: mB,
    });
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenCalledWith(120, 30);
    handleB.release();
    handleA.release();
  });

  it('restoring a previous consumer applies their dims even if intermediate top was different', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 120,
      rows: 30,
      mountInto: mB,
    });
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(120);
    handleB.release();
    // A is back on top — its dims should be re-applied.
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(80);
    expect(_inspectStackForTesting()[0]?.lastAppliedRows).toBe(24);
    handleA.release();
  });
});

describe('checkout — cross-project independence (HS-8031 §54.3)', () => {
  it('two different secrets for the same terminalId get independent entries', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const handleB = checkout({
      projectSecret: 'secret-B',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    expect(entryCount()).toBe(2);
    expect(handleA.isTopOfStack()).toBe(true);
    expect(handleB.isTopOfStack()).toBe(true);
    expect(handleA.term).not.toBe(handleB.term);
    // Each xterm sits in its own mountInto — independent.
    expect(handleA.term.element?.parentElement).toBe(mA);
    expect(handleB.term.element?.parentElement).toBe(mB);
    handleB.release();
    handleA.release();
    expect(entryCount()).toBe(0);
  });

  it('releasing one project doesnt affect the other', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const handleB = checkout({
      projectSecret: 'secret-B',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    handleA.release();
    expect(entryCount()).toBe(1);
    expect(handleB.isTopOfStack()).toBe(true);
    expect(handleB.term.element?.parentElement).toBe(mB);
    handleB.release();
  });
});

describe('checkout — re-checkout after empty-stack dispose (HS-8031 §54.3.3)', () => {
  it('a fresh checkout after the entry was disposed creates a new xterm instance', () => {
    const mA = makeMount('mA');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const firstTerm = handleA.term;
    handleA.release();
    expect(entryCount()).toBe(0);
    // Re-checkout — should create a brand new entry + xterm (not reuse
    // the disposed one).
    const handleA2 = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    expect(entryCount()).toBe(1);
    expect(handleA2.term).not.toBe(firstTerm);
    handleA2.release();
  });
});

describe('checkout — _inspectStackForTesting helper', () => {
  it('returns an empty array when no entries exist', () => {
    expect(_inspectStackForTesting()).toEqual([]);
  });

  it('reports key, secret, terminalId, dims, depth, top mountInto', () => {
    const mA = makeMount('mA');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    const snap = _inspectStackForTesting();
    expect(snap).toHaveLength(1);
    const [entry] = snap;
    expect(entry.key).toBe('secret-A::default');
    expect(entry.secret).toBe('secret-A');
    expect(entry.terminalId).toBe('default');
    expect(entry.lastAppliedCols).toBe(80);
    expect(entry.lastAppliedRows).toBe(24);
    expect(entry.stackDepth).toBe(1);
    expect(entry.topMountInto).toBe(mA);
    handleA.release();
  });
});

/**
 * HS-8042 — Phase 2.2 of HS-8032 surfaced two new requirements that the
 * Phase-1 checkout module didn't satisfy:
 *
 * 1. `CheckoutHandle.fit` exposure — dedicated views run `fit.fit()` on
 *    every body resize and need direct access to the FitAddon already
 *    loaded by checkout's entry construction.
 * 2. `CheckoutHandle.resize(cols, rows)` — when `term.onResize` echoes
 *    fit-driven dim changes, the consumer must update the entry's
 *    `lastApplied` bookkeeping AND send a WS resize frame, without going
 *    through a stack swap. Same skip-on-same-size rule as the swap-time
 *    resize so TUI programs don't see SIGWINCH on idempotent fits.
 */
describe('checkout — HS-8042 handle.fit + handle.resize additions', () => {
  it('exposes the entry FitAddon on the handle', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    expect(h.fit).toBeDefined();
    // The same FitAddon is shared across consumers of the same entry —
    // a second checkout for the same key should expose the SAME instance.
    const m2 = makeMount('m2');
    const h2 = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m2 });
    expect(h2.fit).toBe(h.fit);
    h2.release();
    h.release();
  });

  it('handle.resize updates the entry lastApplied dims and skips on same-size', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const termResize = vi.spyOn(h.term, 'resize');

    // Same-size — must NOT call term.resize (skip-on-same-size guard).
    h.resize(80, 24);
    expect(termResize).not.toHaveBeenCalled();
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(80);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(24);

    // Different size — fires term.resize and updates lastApplied.
    h.resize(120, 40);
    expect(termResize).toHaveBeenCalledWith(120, 40);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(120);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(40);

    // Re-call with the new size — still skips because both term AND
    // lastApplied already match the target.
    termResize.mockClear();
    h.resize(120, 40);
    expect(termResize).not.toHaveBeenCalled();

    h.release();
  });

  /**
   * HS-8051 (2026-05-01) — `applyResizeIfChanged` must use `term.cols/rows`
   * as the source of truth, not `lastAppliedCols/Rows`. The history-frame
   * handler in `attachWebSocketToEntry` calls `entry.term.resize(...)`
   * directly without updating `lastApplied` (by design — it's bringing
   * term to match server-captured replay dims). If a consumer later asks
   * for a resize back to the dims `lastApplied` happens to hold, the
   * pre-fix skip would erroneously bail because `lastApplied === target`,
   * leaving term stuck at the history-frame's dims. This test pins the
   * fix by simulating the divergence directly.
   */
  it('handle.resize re-applies when term diverged from lastApplied (HS-8051)', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });

    // Drive the entry to the post-convergence state: lastApplied = (61, 48),
    // term = (61, 48). This mirrors the tile's `handleTileRender` first
    // converging to native cell-metric dims.
    h.resize(61, 48);
    expect(h.term.cols).toBe(61);
    expect(h.term.rows).toBe(48);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(61);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(48);

    // Now simulate the history-frame path: it calls `term.resize` directly
    // and explicitly does NOT touch `lastApplied`. Term diverges.
    h.term.resize(80, 60);
    expect(h.term.cols).toBe(80);
    expect(h.term.rows).toBe(60);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(61); // bookkeeping unchanged
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(48);

    // The next consumer-driven resize asks for the converged dims again.
    // Pre-fix this would skip because lastApplied (61, 48) === target,
    // leaving term stuck at (80, 60). Post-fix it must re-apply because
    // term doesn't match target.
    const termResize = vi.spyOn(h.term, 'resize');
    h.resize(61, 48);
    expect(termResize).toHaveBeenCalledWith(61, 48);
    expect(h.term.cols).toBe(61);
    expect(h.term.rows).toBe(48);

    h.release();
  });

  /**
   * HS-8051 — same scenario as the divergence test above, but verifies
   * the WS-frame side of the gate. When term is already at target but
   * lastApplied isn't (the consumer's prior call mutated term silently
   * via the history-frame path), `applyResizeIfChanged` should still
   * send a WS frame to bring the server PTY in sync — but NOT call
   * `term.resize` again (term is already where we want it). This is
   * the asymmetric-skip case the new gate handles.
   */
  it('handle.resize syncs server PTY without re-resizing term when only lastApplied diverged (HS-8051)', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });

    // Mutate term directly (mirrors history-frame path) to (61, 48).
    h.term.resize(61, 48);
    // lastApplied is still 80, 24.
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(80);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(24);

    // Now consumer asks for (61, 48). Term already matches → no
    // term.resize. lastApplied differs → server PTY needs the WS frame
    // (and lastApplied bookkeeping needs updating).
    const termResize = vi.spyOn(h.term, 'resize');
    h.resize(61, 48);
    expect(termResize).not.toHaveBeenCalled();
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(61);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(48);

    h.release();
  });
});

/**
 * HS-8064 — server-side scrollback replay (`history` control message)
 * resizes the term to the capture-time dims so xterm wraps the bytes
 * correctly, but pre-fix never restored the term to the consumer's
 * intended dims afterwards. The original HS-8042 design relied on the
 * consumer's `term.onResize → handle.resize` echo to bounce the term
 * back, but xterm's onResize fires with the SYNTHETIC capture-time
 * dims, not the consumer's intended dims, so the echo just acknowledged
 * the capture-time resize and never restored the pane size — the term
 * stayed stuck at capture-time dims (e.g. 80×24 from a server-side
 * scrollback snapshot) inside a drawer pane that fit (100×30), the
 * scrollback never reflowed to fit, leaving the bottom-and-right of
 * the pane empty until the user manually dragged the drawer to
 * re-trigger fit.
 *
 * Fix: capture `lastAppliedCols/Rows` (the consumer's intended dims)
 * BEFORE the synthetic resize, and re-apply AFTER the bytes write so
 * xterm reflows the just-replayed scrollback to fit the consumer's
 * pane.
 */
describe('applyHistoryReplay — restores consumer dims after replay (HS-8064)', () => {
  it('writes capture-time bytes then snaps back to the consumer pane dims', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });

    // Consumer fits the pane and resizes to (120, 40). lastApplied
    // tracks the consumer's intended dims.
    h.resize(120, 40);
    expect(h.term.cols).toBe(120);
    expect(h.term.rows).toBe(40);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(120);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(40);

    // Wire the drawer-style `term.onResize → handle.resize` echo so
    // synthetic resizes inside applyHistoryReplay flow through the
    // same `applyResizeIfChanged` gate the production code uses.
    h.term.onResize(({ cols, rows }) => h.resize(cols, rows));

    // Server emits `history` carrying capture-time dims (80×24) and a
    // base64-encoded payload — simulate via a single space character
    // to keep the test surface minimal (real bytes can be anything).
    const entry = _getEntryForTesting('s', 't');
    expect(entry).not.toBeNull();
    applyHistoryReplay(entry!, { bytes: btoa(' '), cols: 80, rows: 24 });

    // Post-replay: term is back at consumer dims (120×40) — xterm
    // reflowed the just-written scrollback to fit. lastApplied also
    // back at consumer dims via the second onResize echo.
    expect(h.term.cols).toBe(120);
    expect(h.term.rows).toBe(40);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(120);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(40);

    h.release();
  });

  it('no-ops on malformed history (missing bytes)', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    h.resize(120, 40);

    const termResize = vi.spyOn(h.term, 'resize');
    const entry = _getEntryForTesting('s', 't');
    applyHistoryReplay(entry!, { cols: 80, rows: 24 } as { bytes?: string; cols?: number; rows?: number });
    expect(termResize).not.toHaveBeenCalled();
    expect(h.term.cols).toBe(120);
    expect(h.term.rows).toBe(40);

    h.release();
  });

  it('skips the synthetic capture resize when cols/rows are missing or zero', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    h.resize(120, 40);
    h.term.onResize(({ cols, rows }) => h.resize(cols, rows));

    const termResize = vi.spyOn(h.term, 'resize');
    const entry = _getEntryForTesting('s', 't');
    // Only bytes, no dims — write at current term dims, no resize.
    applyHistoryReplay(entry!, { bytes: btoa(' ') });
    expect(termResize).not.toHaveBeenCalled();
    // Term stays at consumer dims; lastApplied unchanged.
    expect(h.term.cols).toBe(120);
    expect(h.term.rows).toBe(40);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(120);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(40);

    h.release();
  });

  it('captures the snapshot BEFORE the synthetic resize so the onResize echo cannot poison it', () => {
    // Pin the timing contract: even though the synthetic
    // `term.resize(captureCols)` fires onResize → handle.resize →
    // applyResizeIfChanged → mutates `lastAppliedCols`, the restore
    // step at the end of applyHistoryReplay uses the snapshot taken
    // BEFORE that mutation, so the term snaps back to the consumer's
    // dims, not to the capture-time dims.
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    h.resize(120, 40);
    h.term.onResize(({ cols, rows }) => h.resize(cols, rows));

    const entry = _getEntryForTesting('s', 't');
    applyHistoryReplay(entry!, { bytes: btoa(' '), cols: 60, rows: 20 });

    // Sanity: term + lastApplied both back at consumer dims, NOT at
    // 60×20 (which is what they'd be if the snapshot had been taken
    // AFTER the synthetic resize).
    expect(h.term.cols).toBe(120);
    expect(h.term.rows).toBe(40);
    expect(_inspectStackForTesting()[0].lastAppliedCols).toBe(120);
    expect(_inspectStackForTesting()[0].lastAppliedRows).toBe(40);

    h.release();
  });
});
