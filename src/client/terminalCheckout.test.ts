// @vitest-environment happy-dom
/**
 * HS-8031 Phase 1 — unit tests for the global terminal-checkout module.
 *
 * Drives the module through happy-dom (no real WebSocket — the module
 * detects `typeof WebSocket === 'undefined'` and falls back to ws=null,
 * which is the right behavior under happy-dom). Tests focus on the
 * stack semantics, the resize-skip rule, the placeholder rendering, the
 * cross-project independence, and the dispose-on-empty-stack invariant.
 *
 * Real-WebSocket round-trips + scrollback replay are covered by the
 * Phase 2 (HS-8032) Playwright e2e — Phase 1 ships infrastructure only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _setDiagnosticsEnabledForTesting } from './globalDiagnostics.js';
import {
  _inspectServerBusyForTesting,
  _resetServerBusyChipForTesting,
} from './serverBusyChip.js';
import {
  _getEntryForTesting,
  _inspectStackForTesting,
  _resetForTesting,
  applyHistoryReplay,
  checkout,
  entryCount,
  parseControlMessage,
} from './terminalCheckout.js';

beforeEach(() => {
  document.body.innerHTML = '';
  _resetForTesting();
  _resetServerBusyChipForTesting();
  // HS-8446 — the per-entry stall watcher feeds the slow-server banner
  // via `trackPersistentSlowEvent`; the banner now requires the global
  // diagnostics opt-in to actually paint. Enable for this file so the
  // existing chipVisible assertions stay valid; the off-state is pinned
  // by the dedicated HS-8446 cases in `serverBusyChip.test.ts`.
  _setDiagnosticsEnabledForTesting(true);
});

afterEach(() => {
  _resetForTesting();
  _resetServerBusyChipForTesting();
  _setDiagnosticsEnabledForTesting(false);
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

describe('readOnly mode (HS-8301)', () => {
  it('sets disableStdin = true on the shared term while a readOnly consumer is on top', () => {
    const mA = makeMount('mA');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      readOnly: true,
    });
    expect(handleA.term.options.disableStdin).toBe(true);
    handleA.release();
  });

  it('defaults to disableStdin = false when readOnly is unset', () => {
    const mA = makeMount('mA');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    expect(handleA.term.options.disableStdin).toBe(false);
    handleA.release();
  });

  it('a readOnly checkout pushed on top of a writable consumer toggles stdin off, then back on after release', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      // writable
    });
    expect(handleA.term.options.disableStdin).toBe(false);
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
      readOnly: true,
    });
    // Both handles point at the same shared term; readOnly flag now applied.
    expect(handleB.term.options.disableStdin).toBe(true);
    expect(handleA.term.options.disableStdin).toBe(true);
    // Releasing the readOnly top restores writable underneath.
    handleB.release();
    expect(handleA.term.options.disableStdin).toBe(false);
    handleA.release();
  });

  it('a writable checkout pushed on top of a readOnly consumer toggles stdin on, then back off after release', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      readOnly: true,
    });
    expect(handleA.term.options.disableStdin).toBe(true);
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
      // writable
    });
    expect(handleA.term.options.disableStdin).toBe(false);
    handleB.release();
    expect(handleA.term.options.disableStdin).toBe(true);
    handleA.release();
  });
});

describe('placeholder background (HS-8295)', () => {
  it('paints the bumped-down placeholder with the consumer-provided background color', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      placeholderBackground: 'rgb(40, 42, 54)', // Dracula bg
    });
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    const placeholder = mA.querySelector<HTMLElement>('.terminal-checkout-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.style.backgroundColor).toBe('rgb(40, 42, 54)');
    handleB.release();
    handleA.release();
  });

  it('falls back to the SCSS default (no inline style) when no placeholderBackground is supplied', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const handleA = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
      // intentionally no placeholderBackground
    });
    const handleB = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mB,
    });
    const placeholder = mA.querySelector<HTMLElement>('.terminal-checkout-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.style.backgroundColor).toBe('');
    handleB.release();
    handleA.release();
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

describe('handle.resize — top-of-stack gate (HS-8619)', () => {
  it('a bumped-down consumer cannot resize the shared term', () => {
    // Reproduces the dashboard "resize weirdly" oscillation: the drawer pane
    // (handleA) is bumped down when a dashboard tile (handleB) borrows the
    // same terminal. The drawer's fit/onResize wiring keeps calling
    // handle.resize — which must be a no-op while it isn't the top of stack,
    // otherwise it drags the shared term to the drawer's dims and fights the
    // tile's own sizing.
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const drawer = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 178,
      rows: 42,
      mountInto: mA,
    });
    const tile = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 61,
      rows: 48,
      mountInto: mB,
    });
    // Tile is on top → term is at the tile's dims.
    expect(tile.isTopOfStack()).toBe(true);
    expect(drawer.isTopOfStack()).toBe(false);
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(61);

    const resizeSpy = vi.spyOn(tile.term, 'resize');
    // The bumped-down drawer pane tries to re-impose its fit dims.
    drawer.resize(178, 42);
    // Gate holds: no term.resize, dims unchanged.
    expect(resizeSpy).not.toHaveBeenCalled();
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(61);
    expect(_inspectStackForTesting()[0]?.lastAppliedRows).toBe(48);

    tile.release();
    drawer.release();
  });

  it('the top-of-stack consumer can still resize the shared term', () => {
    const mA = makeMount('mA');
    const handle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: mA,
    });
    expect(handle.isTopOfStack()).toBe(true);
    const resizeSpy = vi.spyOn(handle.term, 'resize');
    handle.resize(100, 30);
    expect(resizeSpy).toHaveBeenCalledWith(100, 30);
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(100);
    expect(_inspectStackForTesting()[0]?.lastAppliedRows).toBe(30);
    handle.release();
  });

  it('a bumped-down consumer can resize again once restored to the top', () => {
    const mA = makeMount('mA');
    const mB = makeMount('mB');
    const drawer = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 178,
      rows: 42,
      mountInto: mA,
    });
    const tile = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 61,
      rows: 48,
      mountInto: mB,
    });
    // While bumped down the drawer's resize is ignored.
    drawer.resize(100, 30);
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(61);
    // Tile releases → drawer is restored to top (its checkout-time dims are
    // re-applied by releaseInternal).
    tile.release();
    expect(drawer.isTopOfStack()).toBe(true);
    // Now the drawer can drive a fresh size again.
    drawer.resize(100, 30);
    expect(_inspectStackForTesting()[0]?.lastAppliedCols).toBe(100);
    expect(_inspectStackForTesting()[0]?.lastAppliedRows).toBe(30);
    drawer.release();
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

/**
 * HS-8287 — `attachWebSocketToEntry` reuses the same `entry.term` on a
 * WebSocket reconnect (network blip, suspend, etc.). Pre-fix, the server's
 * history-frame replay was just `term.write(bytes)` against a term still
 * carrying its pre-disconnect content — the bytes appended instead of
 * replacing, doubling the visible scrollback. Fix calls `term.reset()` at
 * the top of `applyHistoryReplay` so the replay is authoritative.
 */
describe('applyHistoryReplay — clears buffer before replay (HS-8287)', () => {
  it('resets the term so a reconnect replay does not double existing content', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });

    const entry = _getEntryForTesting('s', 't');
    expect(entry).not.toBeNull();

    // Simulate the pre-disconnect state: PTY has emitted some content
    // and the term still holds it on-screen.
    h.term.write('alpha\r\nbeta\r\ngamma\r\n');

    const resetSpy = vi.spyOn(h.term, 'reset');
    applyHistoryReplay(entry!, { bytes: btoa('replay-bytes'), cols: 80, rows: 24 });

    // Reset must have fired exactly once before the bytes were written.
    expect(resetSpy).toHaveBeenCalledTimes(1);

    h.release();
  });

  it('reset runs BEFORE the capture-time resize so HS-8064 reflow lands on a clean buffer', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    h.resize(120, 40);

    const order: string[] = [];
    const entry = _getEntryForTesting('s', 't');
    expect(entry).not.toBeNull();
    vi.spyOn(h.term, 'reset').mockImplementation(() => { order.push('reset'); });
    vi.spyOn(h.term, 'resize').mockImplementation(() => { order.push('resize'); });
    vi.spyOn(h.term, 'write').mockImplementation(() => { order.push('write'); });

    applyHistoryReplay(entry!, { bytes: btoa(' '), cols: 60, rows: 20 });

    // reset → capture-time resize → bytes write → snap-back resize
    expect(order[0]).toBe('reset');
    expect(order[1]).toBe('resize');
    expect(order[2]).toBe('write');

    h.release();
  });

  it('still no-ops on malformed history (missing bytes) — no reset, no resize', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    h.resize(120, 40);

    const resetSpy = vi.spyOn(h.term, 'reset');
    const resizeSpy = vi.spyOn(h.term, 'resize');
    const entry = _getEntryForTesting('s', 't');
    applyHistoryReplay(entry!, { cols: 80, rows: 24 } as { bytes?: string; cols?: number; rows?: number });
    expect(resetSpy).not.toHaveBeenCalled();
    expect(resizeSpy).not.toHaveBeenCalled();

    h.release();
  });

  /**
   * HS-8287 follow-up #2 — the user reported the doubled-scrollback symptom
   * persisted in WKWebView even after the reset+clear pairing landed; their
   * `__hs8287_dump()` showed `reset.ok` firing on every history frame yet
   * the screenshot still showed 5 stacked Claude Code banners. This test
   * pins the *content* invariant (not just the call-order invariant the
   * three tests above already cover): if the server replays a buffer of N
   * banners onto a term that already has K banners, the term ends up with
   * exactly N banners (NOT N+K). That isolates the question of "is the
   * client doubling content?" from "is the server's ring buffer accumulating
   * content?". A green here proves the client side is correct; a green +
   * a real-app bug points at the server-side ring buffer or the upstream
   * shell process emitting duplicate content.
   */
  it('replays a 5-banner history onto a term with 1 pre-existing banner without doubling (HS-8287 user repro)', async () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't');
    expect(entry).not.toBeNull();

    // Pre-disconnect state: term has one banner on screen. xterm.js
    // processes `write()` asynchronously (microtask-queued); use the
    // callback form to wait for the parser to commit the bytes to the
    // buffer before continuing.
    await new Promise<void>(resolve => h.term.write('Claude Code v6.1.132\r\n', resolve));

    // 5 banner copies — what the user's screenshot showed.
    const fiveBanners = Array.from({ length: 5 }, () => 'Claude Code v6.1.132\r\n').join('');
    applyHistoryReplay(entry!, { bytes: btoa(fiveBanners), cols: 80, rows: 24 });
    // Drain the post-replay write before reading the buffer.
    await new Promise<void>(resolve => h.term.write('', resolve));

    // Walk the buffer and count occurrences of the banner string. Without
    // the reset+clear pairing this would be 6 (1 pre + 5 replay).
    let totalBanners = 0;
    const buf = h.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line === undefined) continue;
      const text = line.translateToString(true);
      if (text.includes('Claude Code v6.1.132')) totalBanners++;
    }

    expect(totalBanners).toBe(5);

    h.release();
  });

  /**
   * HS-8287 follow-up #3 — the user reported the doubled-content symptom
   * persists *even without a WS reconnect or replay*: simply resizing the
   * drawer/dashboard tile causes content already in the buffer to appear
   * duplicated in the visible viewport. They confirmed it happens with
   * "any content in the terminal", not just Claude's TUI banner.
   *
   * This test isolates the resize path from every other code path:
   *   - No WS attach, no `applyHistoryReplay`, no second consumer.
   *   - Plain numbered lines (no ANSI cursor positioning, no SIGWINCH redraw).
   *   - Drive `handle.resize(cols, rows)` directly through the same range
   *     of dims a user dragging the drawer would produce.
   *
   * Reads the FULL term buffer (active screen + scrollback) and asserts
   * each `LINE_N` token appears exactly once. A failure here proves the
   * bug lives in xterm.js's reflow OR in our resize wiring; a green pins
   * the symptom to a different code path (TUI redraw, server ring buffer,
   * or some interaction we haven't isolated yet).
   */
  it('drawer-style resize cycles do NOT duplicate plain content in the term buffer (HS-8287 follow-up #3)', async () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });

    // Write 30 unique numbered lines + drain the parser. xterm.js's write
    // is microtask-queued; the callback form waits for the parser to
    // commit each chunk to the buffer. Pad each line to ~120 chars so
    // narrow-width resizes (cols=60, cols=36) FORCE the reflow path that
    // unwraps + rewraps long lines — that's the exact algorithm complexity
    // a plain `LINE_N\n` test would skip.
    let payload = '';
    for (let i = 1; i <= 30; i++) payload += `LINE_${i}_PADX_${'X'.repeat(120)}\r\n`;
    await new Promise<void>(resolve => h.term.write(payload, resolve));

    // Sanity — each token appears exactly once before any resize.
    const countToken = (n: number): number => {
      let count = 0;
      const buf = h.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const text = buf.getLine(i)?.translateToString(true) ?? '';
        if (text.includes(`LINE_${n}_PADX_`)) count++;
      }
      return count;
    };
    for (let i = 1; i <= 30; i++) {
      expect(countToken(i), `pre-resize: LINE_${i} should appear exactly once`).toBe(1);
    }

    // Same range a user dragging the drawer between max and min height
    // produces. Each call goes through `applyResizeIfChanged` →
    // `term.resize(cols, rows)`. Width changes here (60→100 cycles) trigger
    // xterm's reflow on the existing buffer content — exactly the path the
    // user reported as buggy.
    for (const [cols, rows] of [[100, 30], [60, 10], [120, 50], [70, 18], [90, 36]]) {
      h.resize(cols, rows);
      // Drain any post-resize parser activity.
      await new Promise<void>(resolve => h.term.write('', resolve));
    }

    // Per-line assertion makes failures easy to read.
    for (let i = 1; i <= 30; i++) {
      expect(
        countToken(i),
        `post-resize: LINE_${i} should appear exactly once (theory B duplication if > 1)`,
      ).toBe(1);
    }

    h.release();
  });

  it('also calls clear() after reset() so xterm 6.0.0 scrollback is dropped explicitly (HS-8287 follow-up)', () => {
    // The user reported the doubled-scrollback symptom persisted after
    // the initial reset()-only fix landed in WKWebView. xterm.js 6.0.0's
    // `reset()` runs the ESC c sequence but the visible buffer +
    // scrollback handling varies by version + renderer; pairing reset()
    // with clear() (which drops scrollback explicitly) closes that gap.
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't');
    expect(entry).not.toBeNull();

    const order: string[] = [];
    vi.spyOn(h.term, 'reset').mockImplementation(() => { order.push('reset'); });
    vi.spyOn(h.term, 'clear').mockImplementation(() => { order.push('clear'); });
    vi.spyOn(h.term, 'write').mockImplementation(() => { order.push('write'); });

    applyHistoryReplay(entry!, { bytes: btoa('payload'), cols: 80, rows: 24 });

    // Both reset and clear must have fired before write, in that order.
    expect(order.indexOf('reset')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('clear')).toBeGreaterThan(order.indexOf('reset'));
    expect(order.indexOf('write')).toBeGreaterThan(order.indexOf('clear'));

    h.release();
  });
});

/**
 * HS-8285 — when a consumer's `mountInto` is detached from the document
 * (e.g. a popup whose DOM was torn down by an outer error path, a tile
 * whose section was re-rendered without flushing the per-tile dispose,
 * a project tab reorder that rebuilt the strip without releasing every
 * stale handle), the next legitimate consumer must NOT see the stale
 * handle as the top of the stack — otherwise the placeholder pins onto
 * the visible surface and the user reads "Terminal in use elsewhere"
 * with nothing actually using it. The fix prunes detached-mountInto
 * handles before evaluating bump-down + before reparenting on release.
 */
describe('detached-mountInto pruning (HS-8285)', () => {
  it('checkout with a detached previous top does NOT write a placeholder onto the new mountInto', () => {
    const detached = document.createElement('div');
    // detached: never appended to document.body
    const stale = checkout({
      projectSecret: 's',
      terminalId: 't',
      cols: 80,
      rows: 24,
      mountInto: detached,
    });
    expect(stale.isTopOfStack()).toBe(true);

    // Now a fresh consumer mounts. The stale handle's mountInto is
    // detached → pruned out. The new consumer is the only top and sees
    // the live xterm (NO placeholder).
    const m = makeMount('m1');
    const fresh = checkout({
      projectSecret: 's',
      terminalId: 't',
      cols: 80,
      rows: 24,
      mountInto: m,
    });
    expect(fresh.isTopOfStack()).toBe(true);
    expect(stale.isTopOfStack()).toBe(false);
    // Live xterm element is in the fresh mount, not in the detached node.
    expect(fresh.term.element?.parentElement).toBe(m);
    // Fresh mount carries the xterm DOM, not the placeholder text.
    expect(m.querySelector('.terminal-checkout-placeholder')).toBeNull();

    fresh.release();
    // stale.release() is a noop — the prune already marked it released.
    stale.release();
  });

  it('release-the-top with a detached underlying handle reparents to the next CONNECTED handle', () => {
    const m1 = makeMount('m1');
    const h1 = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m1 });

    // Second consumer's container is in the DOM at checkout time …
    const m2 = makeMount('m2');
    const h2 = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m2 });

    // … but then gets removed without h2.release() running (the bug
    // class HS-8285 protects against).
    m2.remove();

    // m1 mounts a new top. It should NOT see h2 as the previous top
    // (h2's mountInto is detached). m1 was already in the stack at
    // index 0; checkout for the same handle isn't typical, so we
    // simulate the next legitimate-consumer path with a fresh mount.
    const m3 = makeMount('m3');
    const h3 = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m3 });

    // h2 should be pruned; h1 should be bumped down (placeholder), h3 is top.
    expect(h3.isTopOfStack()).toBe(true);
    expect(h1.isTopOfStack()).toBe(false);
    // m1 (the still-attached pre-existing consumer) should now show the
    // placeholder, NOT m2 (which is detached anyway).
    expect(m1.querySelector('.terminal-checkout-placeholder')).not.toBeNull();
    // h3's mount carries the live xterm.
    expect(h3.term.element?.parentElement).toBe(m3);

    h3.release();
    // After h3 release, the live xterm reparents to h1 (the only
    // remaining connected consumer). h2 was pruned earlier.
    expect(h1.term.element?.parentElement).toBe(m1);
    h1.release();
    h2.release();
  });

  it('release with ONLY detached handles below disposes the entry', () => {
    const detached1 = document.createElement('div');
    const stale1 = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: detached1 });

    const m1 = makeMount('m1');
    const h1 = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m1 });
    // stale1 was pruned during checkout for h1. Releasing h1 leaves no
    // consumers → entry disposes + map cleared.
    h1.release();
    expect(entryCount()).toBe(0);
    stale1.release();
  });
});

/**
 * HS-8286 — per-pane / per-tile stall chip removed; the per-entry watcher
 * inside `createEntry` now feeds the global server-slow banner via
 * `trackPersistentSlowEvent` instead. When a terminal types past the
 * 1.5 s no-echo threshold the global banner shows; when echo returns it
 * hides. Disposal releases the token + the timer.
 */
describe('per-entry global stall watcher (HS-8286)', () => {
  function mountBanner(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'server-slow-banner';
    el.className = 'server-slow-banner';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  it('opens a global slow-event token while the entry is stalled and releases on echo', () => {
    mountBanner();
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't');
    expect(entry).not.toBeNull();

    // Simulate a keystroke 2 s ago with no echo since — past the 1.5 s
    // stall threshold. The watcher fires on the next 250 ms tick OR on
    // the next subscriber notification, both of which we simulate by
    // calling the subscribers directly.
    entry!.lastTypeTs = Date.now() - 2000;
    entry!.lastEchoTs = 0;
    for (const sub of entry!.stallSubscribers) sub();

    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);

    // Echo arrives. Subscriber re-evaluates → token released.
    entry!.lastEchoTs = Date.now();
    for (const sub of entry!.stallSubscribers) sub();

    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);

    h.release();
  });

  it('releases the token on entry dispose so a stalled-then-closed terminal does not pin the banner', () => {
    mountBanner();
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't');

    entry!.lastTypeTs = Date.now() - 2000;
    entry!.lastEchoTs = 0;
    for (const sub of entry!.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);

    // Last consumer releases → entry disposes → token released.
    h.release();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(entryCount()).toBe(0);
  });

  it('HS-8309 — dropped keystrokes (WS not OPEN) do NOT bump lastTypeTs and do NOT acquire the global token', () => {
    // Regression for HS-8309 ("slow server notice shows up and doesn't go
    // away automatically sometimes, even though I can see everything is
    // processing quickly"). Pre-fix, `term.onData` updated `lastTypeTs`
    // unconditionally, even when the keystroke was silently dropped
    // because `entry.ws` was null / not OPEN. Combined with the per-entry
    // stall watcher, a single dropped keystroke opened a
    // `trackPersistentSlowEvent` token that could never resolve (no echo
    // can come back for a keystroke the PTY never received). The token's
    // synthetic `startTs = now - SERVER_BUSY_THRESHOLD_MS - 1` guaranteed
    // the global-banner evaluator kept showing the banner until the entry
    // was disposed — i.e. project switch or terminal close.
    //
    // happy-dom 20.9.0 ships a WebSocket constructor (the in-source
    // comment about `typeof WebSocket === 'undefined'` is happy-dom-version
    // -dependent and no longer holds). Force `entry.ws = null` after
    // checkout so we deterministically exercise the production "WS
    // down-window" shape — the same condition users hit during a real
    // network blip OR when typing into a `noSpawn` entry that has no live
    // PTY. Driving `term.paste('x')` fires the registered `onData`
    // handler, which under the fix gates the `lastTypeTs` write on a
    // successful `ws.send`.
    mountBanner();
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't')!;
    entry.ws = null;
    expect(entry.lastTypeTs).toBe(0);

    // Fire a keystroke through the real onData handler.
    entry.term.paste('x');

    // Post-fix: lastTypeTs stays 0 because the keystroke was dropped.
    expect(entry.lastTypeTs).toBe(0);

    // Even after threshold elapses (simulated by directly invoking the
    // 250 ms watcher), no token is acquired because the stall predicate
    // requires `lastTypeTs > 0`.
    for (const sub of entry.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);

    h.release();
  });

  it('HS-8309 — once the stall token is acquired, dispose-via-release tears it down (defense-in-depth)', () => {
    // Belt-and-braces check that `disposeEntry` releases an outstanding
    // token even if the stall watcher never gets to see the resolving
    // echo. Ensures the leak surface is one path (the keystroke gate)
    // and not two (a missed-dispose path).
    mountBanner();
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't')!;

    entry.lastTypeTs = Date.now() - 2000;
    entry.lastEchoTs = 0;
    for (const sub of entry.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    expect(entry.globalStallToken).not.toBeNull();

    // Release without ever feeding an echo. dispose path must clear
    // the global token AND the 250 ms tick handle, otherwise the token
    // would outlive the entry and pin the banner forever.
    h.release();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
    expect(entryCount()).toBe(0);
  });

  it('two entries each track independently — banner stays up while either is stalled', () => {
    mountBanner();
    const m1 = makeMount('m1');
    const m2 = makeMount('m2');
    const h1 = checkout({ projectSecret: 's', terminalId: 't1', cols: 80, rows: 24, mountInto: m1 });
    const h2 = checkout({ projectSecret: 's', terminalId: 't2', cols: 80, rows: 24, mountInto: m2 });
    const e1 = _getEntryForTesting('s', 't1')!;
    const e2 = _getEntryForTesting('s', 't2')!;

    e1.lastTypeTs = Date.now() - 2000;
    for (const sub of e1.stallSubscribers) sub();
    e2.lastTypeTs = Date.now() - 2000;
    for (const sub of e2.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(2);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);

    // Only e1 unstalls — banner stays up.
    e1.lastEchoTs = Date.now();
    for (const sub of e1.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);

    // Now e2 — banner clears.
    e2.lastEchoTs = Date.now();
    for (const sub of e2.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);

    h1.release();
    h2.release();
  });

  it('HS-8379 — WS close clears stall timestamps so the banner does not stick across a reconnect', () => {
    // Regression for "slow service notice sometimes not hiding until I
    // switch projects". The path: keystroke sent successfully (sent=true,
    // lastTypeTs bumped). WS closes before the echo binary frame arrives
    // back at the client. Server-side `history` replay on reconnect writes
    // the echoed bytes via `applyHistoryReplay` BUT that path only fires
    // `term.write` — it does NOT bump `lastEchoTs` (which only updates in
    // the binary-frame branch of `ws.message`). The per-entry stall
    // watcher therefore keeps `lastTypeTs > lastEchoTs` indefinitely and
    // the global server-slow banner stays pinned until the entry is
    // disposed (typically on project switch via `disposeAllInstances`,
    // matching the user's symptom). Fix: reset both timestamps on every
    // WS close so the next type-echo cycle on the fresh socket starts
    // clean, releasing the token immediately.
    mountBanner();
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 't')!;

    // Pre-stage the stalled state: a keystroke 2 s ago, no echo since.
    entry.lastTypeTs = Date.now() - 2000;
    entry.lastEchoTs = 0;
    for (const sub of entry.stallSubscribers) sub();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
    expect(entry.globalStallToken).not.toBeNull();

    // Simulate the WS close event. happy-dom's WebSocket exposes
    // `dispatchEvent` so we can fire a real `close` event through the
    // listener attached in `attachWebSocketToEntry`.
    const ws = entry.ws;
    expect(ws).not.toBeNull();
    ws!.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));

    // Post-fix: the close handler reset lastTypeTs / lastEchoTs to 0 and
    // notified subscribers, so the watcher saw `stalled = false` on the
    // synchronous re-evaluation and released the token. The banner is
    // gone without requiring a project switch.
    expect(entry.lastTypeTs).toBe(0);
    expect(entry.lastEchoTs).toBe(0);
    expect(entry.globalStallToken).toBeNull();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);

    h.release();
  });
});

/**
 * HS-8597 — the client dropped the server's `history` control frame for every
 * ALIVE terminal, so scrollback was never replayed and switching project tabs
 * lost the prior output on any terminal whose xterm got recreated. Root cause:
 * the server sends `exitCode: result.exitCode`, which is `null` for an alive
 * session, but the client's `ControlMessageSchema` declared
 * `exitCode: z.number().optional()` — accepting `number | undefined` but NOT
 * `null`. `safeParse` failed → the message handler's `if (msg === null) return`
 * silently swallowed the frame → `applyHistoryReplay` never ran.
 *
 * These guard the parse contract directly (the seam the live message handler
 * uses). The existing `applyHistoryReplay` tests above sit BELOW this gate, so
 * they never exercised it — which is exactly why the regression slipped in.
 */
describe('parseControlMessage — server frame contract (HS-8597)', () => {
  it('accepts the history frame for an ALIVE terminal (exitCode: null)', () => {
    // Mirrors src/terminals/websocket.ts handleConnection's first frame for a
    // live session: alive true, exitCode null.
    const frame = {
      type: 'history',
      bytes: btoa('hello world\r\n'),
      alive: true,
      exitCode: null,
      cols: 80,
      rows: 24,
      command: 'zsh',
    };
    const msg = parseControlMessage(frame);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe('history');
    expect(msg?.bytes).toBe(frame.bytes);
    // exitCode null must survive parsing (not be the reason the frame drops).
    expect(msg?.exitCode).toBeNull();
  });

  it('still accepts the history frame for an EXITED terminal (numeric exitCode)', () => {
    const msg = parseControlMessage({
      type: 'history', bytes: btoa('done\r\n'), alive: false, exitCode: 0, cols: 80, rows: 24, command: 'zsh',
    });
    expect(msg).not.toBeNull();
    expect(msg?.exitCode).toBe(0);
  });

  it('accepts the noSession frame the §47 popup relies on', () => {
    const msg = parseControlMessage({
      type: 'history', bytes: '', alive: false, exitCode: null, cols: 80, rows: 24, noSession: true,
    });
    expect(msg).not.toBeNull();
    expect(msg?.noSession).toBe(true);
  });

  it('rejects a non-object payload', () => {
    expect(parseControlMessage('not an object')).toBeNull();
    expect(parseControlMessage(null)).toBeNull();
    expect(parseControlMessage(42)).toBeNull();
  });

  it('tolerates unknown forward-compat fields (.loose)', () => {
    const msg = parseControlMessage({
      type: 'history', bytes: '', exitCode: null, futureField: { nested: true },
    });
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe('history');
  });
});

/**
 * HS-8597 end-to-end through the live WS message handler: a history frame
 * carrying `exitCode: null` must actually drive `applyHistoryReplay` (i.e.
 * call `term.reset()` and write the bytes). Pre-fix this frame was dropped at
 * the schema gate so reset never fired. happy-dom's WebSocket lets us dispatch
 * a real `message` event through the listener `attachWebSocketToEntry` wires.
 */
describe('history-frame replay through the WS message handler (HS-8597)', () => {
  it('replays scrollback when the alive-terminal history frame (exitCode: null) arrives', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 'dyn-x', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 'dyn-x');
    expect(entry).not.toBeNull();
    expect(entry!.ws).not.toBeNull();

    const resetSpy = vi.spyOn(h.term, 'reset');
    const writeSpy = vi.spyOn(h.term, 'write');

    entry!.ws!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'history',
        bytes: btoa('echo hello world\r\nhello world\r\n'),
        alive: true,
        exitCode: null,
        cols: 80,
        rows: 24,
        command: 'zsh',
      }),
    }));

    // The frame passed the schema → applyHistoryReplay ran → reset + write.
    expect(resetSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();

    h.release();
  });
});

/**
 * HS-8610 — switching tabs surfaced garbage like `?49;86R` / `3R3R` in the
 * foreground program's input. Root cause: the replayed scrollback contains
 * device-status QUERIES the program emitted before the disconnect (e.g.
 * `\x1b[?6n` DECXCPR); xterm parses them on replay and auto-emits the REPLY
 * via `term.onData`, which the keystroke pipe sent to the PTY as input. The
 * fix gates `term.onData` behind `entry.replaying`, set around the replay
 * write.
 */
describe('device-status reply suppression during replay (HS-8610)', () => {
  /** A fake OPEN socket so the `term.onData` keystroke pipe is observable
   *  (happy-dom's real WebSocket stays CONNECTING and never reports OPEN). */
  function fakeOpenWs(): { readyState: number; send: ReturnType<typeof vi.fn> } {
    return { readyState: WebSocket.OPEN, send: vi.fn() };
  }

  it('drops term.onData while entry.replaying is true, and pipes it otherwise', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 'dyn-x', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 'dyn-x')!;
    const ws = fakeOpenWs();
    entry.ws = ws as unknown as WebSocket;

    // Not replaying → a typed byte reaches the socket.
    entry.replaying = false;
    h.term.input('x');
    expect(ws.send).toHaveBeenCalledTimes(1);

    // Replaying → onData (e.g. an auto-reply to a device-status query in the
    // replayed bytes) is dropped, NOT sent to the PTY.
    ws.send.mockClear();
    entry.replaying = true;
    h.term.input('\x1b[?49;86R'); // shaped like the DECXCPR reply from the bug
    expect(ws.send).not.toHaveBeenCalled();

    entry.replaying = false;
    h.release();
  });

  it('applyHistoryReplay holds replaying across the write and clears it after', () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 'dyn-y', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 'dyn-y')!;

    let replayingDuringWrite: boolean | null = null;
    const writeSpy = vi.spyOn(entry.term, 'write').mockImplementation(((data: string | Uint8Array, cb?: () => void) => {
      replayingDuringWrite = entry.replaying;
      if (typeof cb === 'function') cb();
      return true;
    }) as typeof entry.term.write);

    applyHistoryReplay(entry, { bytes: btoa('\x1b[?6n'), cols: 80, rows: 24 });

    expect(writeSpy).toHaveBeenCalled();
    expect(replayingDuringWrite).toBe(true);   // flag set while the bytes are parsed
    expect(entry.replaying).toBe(false);       // cleared by the write callback

    writeSpy.mockRestore();
    h.release();
  });

  it('does not pipe any data to the PTY when replaying scrollback that contains a device-status query', async () => {
    const m = makeMount('m1');
    const h = checkout({ projectSecret: 's', terminalId: 'dyn-z', cols: 80, rows: 24, mountInto: m });
    const entry = _getEntryForTesting('s', 'dyn-z')!;
    const ws = fakeOpenWs();
    entry.ws = ws as unknown as WebSocket;

    // Replay a buffer whose tail is a cursor-position query. Any reply xterm
    // generates fires while `replaying` is true → must be suppressed.
    applyHistoryReplay(entry, { bytes: btoa('done\r\n\x1b[6n'), cols: 80, rows: 24 });
    // Let the async write flush + the (suppressed) reply fire.
    await new Promise<void>(res => setTimeout(res, 0));

    expect(ws.send).not.toHaveBeenCalled();
    h.release();
  });
});
