// @vitest-environment happy-dom
/**
 * HS-9129 — unit coverage for the live-terminal §54-checkout choreography
 * (`permissionLiveCheckout.ts`). Pure module: the only dependency is the
 * `CheckoutHandle` *type*, so the tests drive it with a hand-built fake handle
 * + fake ResizeObserver and exercise the release/disconnect/retry branches the
 * `permissionOverlay.test.ts` suite doesn't reach (the 61% branch gap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _inspectLiveCheckoutForTesting,
  _resetLiveCheckoutStateForTesting,
  clearLiveTermFitRetryTimer,
  disconnectActiveLiveTermResizeObserver,
  getActiveCheckout,
  releaseActiveCheckoutIfAny,
  runLiveTermFitWithRetry,
  setActiveCheckout,
  setActiveLiveTermResizeObserver,
} from './permissionLiveCheckout.js';
import type { CheckoutHandle } from './terminalCheckout.js';

interface FakeHandle {
  released: number;
  cols: number;
  rows: number;
  resized: Array<{ cols: number; rows: number }>;
  propose: () => { cols: number; rows: number } | undefined;
  proposeThrows: boolean;
  resizeThrows: boolean;
}

function makeHandle(over: Partial<FakeHandle> = {}): { handle: CheckoutHandle; spy: FakeHandle } {
  const spy: FakeHandle = {
    released: 0, cols: 80, rows: 24, resized: [],
    propose: () => ({ cols: 100, rows: 30 }), proposeThrows: false, resizeThrows: false,
    ...over,
  };
  // A test fake — only the fields the module touches are implemented.
  const handle = {
    term: { get cols() { return spy.cols; }, get rows() { return spy.rows; } },
    fit: { proposeDimensions: () => { if (spy.proposeThrows) throw new Error('disposed'); return spy.propose(); } },
    resize: (cols: number, rows: number) => { if (spy.resizeThrows) throw new Error('disposed'); spy.resized.push({ cols, rows }); },
    release: () => { spy.released++; },
  } as unknown as CheckoutHandle;
  return { handle, spy };
}

beforeEach(() => { _resetLiveCheckoutStateForTesting(); });
afterEach(() => { _resetLiveCheckoutStateForTesting(); vi.useRealTimers(); });

describe('getActiveCheckout / setActiveCheckout / release', () => {
  it('starts null, reflects a set handle, and clears on release', () => {
    expect(getActiveCheckout()).toBeNull();
    const { handle, spy } = makeHandle();
    setActiveCheckout(handle);
    expect(getActiveCheckout()).toBe(handle);
    releaseActiveCheckoutIfAny();
    expect(spy.released).toBe(1);
    expect(getActiveCheckout()).toBeNull();
  });

  it('releaseActiveCheckoutIfAny is a no-op when nothing is held', () => {
    expect(() => releaseActiveCheckoutIfAny()).not.toThrow();
    expect(getActiveCheckout()).toBeNull();
  });

  it('swallows a throw from handle.release()', () => {
    const handle = { release: () => { throw new Error('already torn down'); } } as unknown as CheckoutHandle;
    setActiveCheckout(handle);
    expect(() => releaseActiveCheckoutIfAny()).not.toThrow();
    expect(getActiveCheckout()).toBeNull();
  });
});

describe('ResizeObserver + fit-timer slots', () => {
  it('disconnects the observer (and swallows a throwing disconnect)', () => {
    let disconnects = 0;
    const ok = { disconnect: () => { disconnects++; } } as unknown as ResizeObserver;
    setActiveLiveTermResizeObserver(ok);
    expect(_inspectLiveCheckoutForTesting().activeLiveTermResizeObserver).toBe(true);
    disconnectActiveLiveTermResizeObserver();
    expect(disconnects).toBe(1);
    expect(_inspectLiveCheckoutForTesting().activeLiveTermResizeObserver).toBe(false);
    disconnectActiveLiveTermResizeObserver(); // idempotent no-op

    const bad = { disconnect: () => { throw new Error('boom'); } } as unknown as ResizeObserver;
    setActiveLiveTermResizeObserver(bad);
    expect(() => disconnectActiveLiveTermResizeObserver()).not.toThrow();
    expect(_inspectLiveCheckoutForTesting().activeLiveTermResizeObserver).toBe(false);
  });

  it('clearLiveTermFitRetryTimer is a no-op when no timer is pending', () => {
    expect(() => clearLiveTermFitRetryTimer()).not.toThrow();
  });
});

describe('runLiveTermFitWithRetry', () => {
  it('resizes once proposeDimensions returns dims that differ from the term', async () => {
    vi.useFakeTimers();
    const { handle, spy } = makeHandle({ cols: 80, rows: 24, propose: () => ({ cols: 100, rows: 30 }) });
    setActiveCheckout(handle);
    runLiveTermFitWithRetry(handle);
    await vi.advanceTimersByTimeAsync(50); // flush the rAF/timeout first attempt
    expect(spy.resized).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('does NOT resize when proposed dims already match the term', async () => {
    vi.useFakeTimers();
    const { handle, spy } = makeHandle({ cols: 100, rows: 30, propose: () => ({ cols: 100, rows: 30 }) });
    setActiveCheckout(handle);
    runLiveTermFitWithRetry(handle);
    await vi.advanceTimersByTimeAsync(50);
    expect(spy.resized).toEqual([]);
  });

  it('retries while proposeDimensions returns undefined, up to the max attempts', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { handle, spy } = makeHandle({ propose: () => { calls++; return undefined; } });
    setActiveCheckout(handle);
    runLiveTermFitWithRetry(handle);
    await vi.advanceTimersByTimeAsync(16 * 35); // past 30 attempts * 16ms
    expect(calls).toBe(30); // LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS
    expect(spy.resized).toEqual([]);
  });

  it('bails immediately if the active handle changed before the first attempt', async () => {
    vi.useFakeTimers();
    const a = makeHandle();
    const b = makeHandle();
    setActiveCheckout(a.handle);
    runLiveTermFitWithRetry(a.handle);
    setActiveCheckout(b.handle); // popup re-checked-out a different handle
    await vi.advanceTimersByTimeAsync(50);
    expect(a.spy.resized).toEqual([]);
  });

  it('swallows a throw from proposeDimensions (term disposed mid-flight)', async () => {
    vi.useFakeTimers();
    const { handle, spy } = makeHandle({ proposeThrows: true });
    setActiveCheckout(handle);
    expect(() => { runLiveTermFitWithRetry(handle); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    expect(spy.resized).toEqual([]);
  });

  it('swallows a throw from resize (term disposed)', async () => {
    vi.useFakeTimers();
    const { handle } = makeHandle({ cols: 80, rows: 24, resizeThrows: true, propose: () => ({ cols: 100, rows: 30 }) });
    setActiveCheckout(handle);
    expect(() => { runLiveTermFitWithRetry(handle); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);
  });

  it('uses the setTimeout fallback when requestAnimationFrame is unavailable', async () => {
    vi.useFakeTimers();
    const origRaf = globalThis.requestAnimationFrame;
    // @ts-expect-error — exercise the no-rAF branch (e.g. a non-browser host).
    delete globalThis.requestAnimationFrame;
    try {
      const { handle, spy } = makeHandle({ cols: 80, rows: 24, propose: () => ({ cols: 120, rows: 40 }) });
      setActiveCheckout(handle);
      runLiveTermFitWithRetry(handle);
      await vi.advanceTimersByTimeAsync(50);
      expect(spy.resized).toEqual([{ cols: 120, rows: 40 }]);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });
});
