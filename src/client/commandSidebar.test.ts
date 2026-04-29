// @vitest-environment happy-dom
/**
 * HS-7983 — pure-helper tests for the streaming-shell-output polling
 * adapter exposed by `commandSidebar.tsx::decideShellPartialEvents`. The
 * adapter takes a `/api/shell/running` response + the per-id last-seen
 * length cache and returns the events to dispatch + the new cache state.
 * These tests pin the dedup-by-length, dropped-id, and missing-outputs
 * paths so a regression doesn't silently start dispatching identical
 * events on every 2 s tick.
 *
 * HS-7984 — also covers the first-use toast helper +
 * localStorage-sentinel logic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decideShellPartialEvents, maybeFireShellStreamFirstUseToast } from './commandSidebar.js';
import { state } from './state.js';

describe('decideShellPartialEvents (HS-7983)', () => {
  it('returns no events when no processes are running', () => {
    const result = decideShellPartialEvents({ ids: [], outputs: {} }, new Map());
    expect(result.events).toEqual([]);
    expect(result.nextCache.size).toBe(0);
  });

  it('dispatches an event for the first chunk of a newly-running id', () => {
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'first chunk\n' } },
      new Map(),
    );
    expect(result.events).toEqual([{ id: 42, partial: 'first chunk\n' }]);
    expect(result.nextCache.get(42)).toBe('first chunk\n'.length);
  });

  it('does NOT re-dispatch when the partial has not grown', () => {
    const cache = new Map<number, number>([[42, 'first chunk\n'.length]]);
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'first chunk\n' } },
      cache,
    );
    expect(result.events).toEqual([]);
    // Cache unchanged for this id.
    expect(result.nextCache.get(42)).toBe('first chunk\n'.length);
  });

  it('dispatches when the partial grew between ticks', () => {
    const cache = new Map<number, number>([[42, 5]]);
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'hello world' } },
      cache,
    );
    expect(result.events).toEqual([{ id: 42, partial: 'hello world' }]);
    expect(result.nextCache.get(42)).toBe('hello world'.length);
  });

  it('drops cache entries for ids that left the running list', () => {
    const cache = new Map<number, number>([[42, 50], [43, 100]]);
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'a'.repeat(60) } },
      cache,
    );
    expect(result.nextCache.has(42)).toBe(true);
    // 43 dropped from cache because it's not in the running ids list.
    expect(result.nextCache.has(43)).toBe(false);
  });

  it('preserves cache for an id that is running but has no output yet (pre-first-chunk)', () => {
    const cache = new Map<number, number>([[42, 10]]);
    const result = decideShellPartialEvents(
      // `outputs` missing the id — treat as "no new chunk this tick".
      { ids: [42], outputs: {} },
      cache,
    );
    expect(result.events).toEqual([]);
    // Carry forward the prior length so a later chunk emits the delta
    // correctly rather than re-emitting the whole buffer.
    expect(result.nextCache.get(42)).toBe(10);
  });

  it('handles a missing `outputs` field (older server, backward compat)', () => {
    const result = decideShellPartialEvents(
      { ids: [42] },
      new Map(),
    );
    expect(result.events).toEqual([]);
    // Cache is empty — nothing to preserve, nothing to drop, nothing to add.
    expect(result.nextCache.size).toBe(0);
  });

  it('dispatches for multiple concurrent running commands', () => {
    const result = decideShellPartialEvents(
      { ids: [42, 43], outputs: { 42: 'one', 43: 'two\nlines\n' } },
      new Map(),
    );
    expect(result.events).toContainEqual({ id: 42, partial: 'one' });
    expect(result.events).toContainEqual({ id: 43, partial: 'two\nlines\n' });
    expect(result.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HS-7984 — first-use toast (Phase 4)
// ---------------------------------------------------------------------------

describe('maybeFireShellStreamFirstUseToast (HS-7984)', () => {
  const KEY = 'hotsheet:shell-stream-toast-dismissed';
  const originalSetting = state.settings.shell_streaming_enabled;

  beforeEach(() => {
    window.localStorage.removeItem(KEY);
    document.querySelectorAll('.hs-toast').forEach(t => t.remove());
    state.settings.shell_streaming_enabled = true;
  });

  afterEach(() => {
    state.settings.shell_streaming_enabled = originalSetting;
    window.localStorage.removeItem(KEY);
    document.querySelectorAll('.hs-toast').forEach(t => t.remove());
  });

  it('shows the discoverability toast on the first call after enable', () => {
    maybeFireShellStreamFirstUseToast();
    const toast = document.querySelector('.hs-toast');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('streams as it arrives');
    // localStorage sentinel is set so subsequent calls skip.
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it('does NOT re-fire on a subsequent call (idempotent via the localStorage sentinel)', () => {
    maybeFireShellStreamFirstUseToast();
    document.querySelectorAll('.hs-toast').forEach(t => t.remove());
    maybeFireShellStreamFirstUseToast();
    expect(document.querySelector('.hs-toast')).toBeNull();
  });

  it('respects an existing localStorage sentinel from a prior session', () => {
    window.localStorage.setItem(KEY, '1700000000000');
    maybeFireShellStreamFirstUseToast();
    expect(document.querySelector('.hs-toast')).toBeNull();
  });

  it('no-ops when the streaming setting is disabled — no toast and no sentinel mutation', () => {
    state.settings.shell_streaming_enabled = false;
    maybeFireShellStreamFirstUseToast();
    expect(document.querySelector('.hs-toast')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
