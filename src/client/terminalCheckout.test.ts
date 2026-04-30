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
  _inspectStackForTesting,
  _resetForTesting,
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

    // Re-call with the new size — still skips because lastApplied
    // already matches.
    termResize.mockClear();
    h.resize(120, 40);
    expect(termResize).not.toHaveBeenCalled();

    h.release();
  });
});
