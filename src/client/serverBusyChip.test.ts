/**
 * HS-8175 — Tests for the global server-busy chip.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _inspectActivationForTesting,
  _inspectServerBusyForTesting,
  _resetServerBusyChipForTesting,
  isLongPollUrl,
  SERVER_BUSY_THRESHOLD_MS,
  shouldShowServerBusyChip,
  trackPersistentSlowEvent,
  trackServerRequest,
} from './serverBusyChip.js';

afterEach(() => {
  _resetServerBusyChipForTesting();
});

describe('isLongPollUrl (HS-8175)', () => {
  it('matches the documented long-poll endpoints', () => {
    expect(isLongPollUrl('/api/poll?version=42')).toBe(true);
    expect(isLongPollUrl('/api/projects/permissions?v=1')).toBe(true);
    expect(isLongPollUrl('/api/projects/bell-state?v=2')).toBe(true);
  });

  it('returns false for normal endpoints', () => {
    expect(isLongPollUrl('/api/tickets')).toBe(false);
    expect(isLongPollUrl('/api/file-settings')).toBe(false);
    expect(isLongPollUrl('/api/terminal/list')).toBe(false);
    expect(isLongPollUrl('/api/projects')).toBe(false); // doesn't include `/permissions` or `/bell-state`
  });
});

describe('shouldShowServerBusyChip (HS-8175)', () => {
  it('returns false when no requests are in flight', () => {
    expect(shouldShowServerBusyChip([], 100_000)).toBe(false);
  });

  it('returns false when in-flight requests are within the threshold', () => {
    expect(shouldShowServerBusyChip([99_000], 100_000)).toBe(false); // 1 s old
    expect(shouldShowServerBusyChip([97_000, 99_500], 100_000)).toBe(false); // both within 3 s
  });

  it('returns true when any in-flight request has exceeded the threshold', () => {
    expect(shouldShowServerBusyChip([96_000], 100_000)).toBe(true); // 4 s old
    expect(shouldShowServerBusyChip([99_500, 96_000], 100_000)).toBe(true); // one fresh, one stale → still show
  });

  it('honours a custom thresholdMs', () => {
    expect(shouldShowServerBusyChip([99_500], 100_000, 1_000)).toBe(false); // 500ms <= 1s threshold
    expect(shouldShowServerBusyChip([98_500], 100_000, 1_000)).toBe(true);
  });

  it('the boundary at exactly thresholdMs stays hidden', () => {
    const start = 100_000 - SERVER_BUSY_THRESHOLD_MS;
    expect(shouldShowServerBusyChip([start], 100_000)).toBe(false); // exactly threshold
    expect(shouldShowServerBusyChip([start - 1], 100_000)).toBe(true); // 1 ms past
  });
});

describe('trackServerRequest (HS-8175)', () => {
  it('records an in-flight request and clears it on done()', () => {
    const done = trackServerRequest('/api/tickets');
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    done();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
  });

  it('skips long-poll URLs entirely (no tracking, done() is a noop)', () => {
    const done = trackServerRequest('/api/poll?version=1');
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    done();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
  });

  it('multiple concurrent requests are tracked independently', () => {
    const a = trackServerRequest('/api/tickets');
    const b = trackServerRequest('/api/file-settings');
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(2);
    a();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    b();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
  });

  it('chip stays hidden when requests resolve before the threshold', () => {
    const done = trackServerRequest('/api/tickets');
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
    done();
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
  });
});

describe('server-slow banner (HS-8226)', () => {
  /** HS-8226 — the indicator now toggles a layout-flow banner that
   *  `pages.tsx` renders server-side as `#server-slow-banner`. Tests
   *  that walk the visible state need to mount that element before
   *  asserting; without it, `_inspectServerBusyForTesting().chipVisible`
   *  reports false unconditionally (treated as "no banner to show"). */
  function mountBanner(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'server-slow-banner';
    el.className = 'server-slow-banner';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.getElementById('server-slow-banner')?.remove();
  });

  it('chipVisible reports false when the banner element is missing from the layout', () => {
    // No banner element mounted — happens in unit tests that bypass the
    // server-rendered page. The chip module treats that as a no-op.
    const done = trackServerRequest('/api/tickets');
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
    done();
  });

  it('chipVisible reports false when the banner element is mounted but hidden', () => {
    mountBanner();
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
  });

  it('chipVisible reports true once the banner is shown', () => {
    const banner = mountBanner();
    banner.style.display = '';
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
  });
});

describe('trackPersistentSlowEvent (HS-8286)', () => {
  /** HS-8286 — non-HTTP code paths (specifically: per-terminal stall in
   *  `terminalCheckout.tsx`) feed the global banner via this helper.
   *  The token registers a synthetic in-flight item with `startTs`
   *  already past the threshold, so the banner shows immediately
   *  without waiting another `SERVER_BUSY_THRESHOLD_MS` for the
   *  threshold to cross. The caller has already applied its own
   *  threshold (e.g. terminal stall = 1.5 s of no echo). */
  function mountBanner(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'server-slow-banner';
    el.className = 'server-slow-banner';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.getElementById('server-slow-banner')?.remove();
  });

  it('shows the banner immediately and hides on release', () => {
    mountBanner();
    const release = trackPersistentSlowEvent();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(1);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
    release();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
  });

  it('multiple persistent events stack — banner stays up until all are released', () => {
    mountBanner();
    const a = trackPersistentSlowEvent();
    const b = trackPersistentSlowEvent();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(2);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
    a();
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
    b();
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
  });

  it('release is idempotent — calling twice does not underflow the in-flight set', () => {
    mountBanner();
    const release = trackPersistentSlowEvent();
    release();
    release();
    expect(_inspectServerBusyForTesting().inFlightCount).toBe(0);
  });
});

// HS-8425 — module-level mock of `./api.js` so the chip's lazy
// `await import('./api.js')` in `postBannerActivation` lands on our
// stub. The dynamic-import cache is per-test-file, not per-test, so a
// per-test `vi.doMock` only intercepts the FIRST dynamic resolution —
// subsequent tests would see a stale closure. The fixed reference here
// captures every post for every test; we clear the array in beforeEach.
//
// The `mock` prefix is required: `vi.mock` calls are hoisted to the
// top of the file, and vitest only lets the factory close over outer
// variables whose names begin with `mock` (others would land in a
// temporal dead zone at hoist time).
const mockPostedActivations: Array<{ url: string; body: unknown }> = [];
vi.mock('./api.js', () => ({
  api: (path: string, opts: { method?: string; body?: unknown }) => {
    mockPostedActivations.push({ url: path, body: opts.body });
    return Promise.resolve({ ok: true });
  },
}));

describe('banner activation logging (HS-8425)', () => {
  // HS-8425 — every banner show→hide cycle posts one entry to
  // `/api/diagnostics/freeze` so the user can grep `freeze.log` for the
  // banner's recent activations + diagnose what was in flight.

  function mountBanner(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'server-slow-banner';
    el.className = 'server-slow-banner';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  const posted = mockPostedActivations;

  beforeEach(() => {
    posted.length = 0;
  });

  afterEach(() => {
    document.getElementById('server-slow-banner')?.remove();
    vi.useRealTimers();
  });

  /** Helper — wait for the lazy `postBannerActivation` to drain. The
   *  chain has `await import('./api.js')` (vitest's mock resolution
   *  takes multiple microtask hops) + `await api(...)`; a single
   *  `setTimeout(0)` defer past the next macrotask boundary is more
   *  reliable than counting individual microtask awaits. */
  function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  it('posts exactly one freeze.log entry per show→hide cycle', async () => {
    mountBanner();
    const release = trackPersistentSlowEvent('test-stall');
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
    release();
    await flushMicrotasks();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('/diagnostics/freeze');
    const body = posted[0].body as { source: string; durationMs: number; context: string };
    expect(body.source).toBe('client-server-busy-banner');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.context).toBe('string');
  });

  it('does not post when the banner never shows (request finishes under threshold)', async () => {
    mountBanner();
    const done = trackServerRequest('/api/tickets');
    done();
    await flushMicrotasks();
    expect(posted).toHaveLength(0);
  });

  it('records triggerKind=persistent + triggerLabel for terminal-stall path', async () => {
    mountBanner();
    const release = trackPersistentSlowEvent('terminal-stall:default');
    const snap = _inspectActivationForTesting();
    expect(snap).not.toBeNull();
    expect(snap!.firstTriggerKind).toBe('persistent');
    expect(snap!.firstTriggerLabel).toBe('terminal-stall:default');
    expect(snap!.firstTriggerUrl).toBeNull();
    release();
    await flushMicrotasks();
    const body = posted[0].body as { context: string };
    const ctx = JSON.parse(body.context) as { triggerKind: string; triggerLabel: string };
    expect(ctx.triggerKind).toBe('persistent');
    expect(ctx.triggerLabel).toBe('terminal-stall:default');
  });

  it('records triggerKind=http + stripped URL when an HTTP request crosses the threshold', async () => {
    mountBanner();
    // Use fake timers so we can advance Date.now() past the 3 s threshold
    // without the test taking 3 s of wall clock.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const done = trackServerRequest('/api/tickets?include_archive=1');
    // Banner not yet up — 0 ms elapsed.
    expect(_inspectServerBusyForTesting().chipVisible).toBe(false);
    // Advance past threshold and let the evaluate timer fire.
    vi.setSystemTime(1_000_000 + SERVER_BUSY_THRESHOLD_MS + 100);
    vi.advanceTimersByTime(250);
    expect(_inspectServerBusyForTesting().chipVisible).toBe(true);
    const snap = _inspectActivationForTesting();
    expect(snap!.firstTriggerKind).toBe('http');
    // Query string stripped from the recorded URL.
    expect(snap!.firstTriggerUrl).toBe('/api/tickets?include_archive=1');
    done();
    // Switch back to real timers so the dynamic-import microtask drain works.
    vi.useRealTimers();
    await flushMicrotasks();
    const body = posted[0].body as { context: string };
    const ctx = JSON.parse(body.context) as { urlsSeen: string[]; triggerUrl: string };
    // URL in urlsSeen has the query stripped (path-only).
    expect(ctx.urlsSeen).toContain('http:/api/tickets');
    expect(ctx.triggerUrl).toBe('/api/tickets?include_archive=1');
  });

  it('captures multiple distinct URLs in urlsSeen during a single activation', async () => {
    mountBanner();
    // Stall token holds the banner open; HTTP requests joining
    // mid-activation should be captured even though they finish < 250 ms.
    const release = trackPersistentSlowEvent('test-stall');
    const a = trackServerRequest('/api/tickets');
    const b = trackServerRequest('/api/file-settings');
    a();
    b();
    release();
    await flushMicrotasks();
    const body = posted[0].body as { context: string };
    const ctx = JSON.parse(body.context) as { urlsSeen: string[]; peakInFlightCount: number };
    expect(ctx.urlsSeen).toContain('persistent:test-stall');
    expect(ctx.urlsSeen).toContain('http:/api/tickets');
    expect(ctx.urlsSeen).toContain('http:/api/file-settings');
    expect(ctx.peakInFlightCount).toBeGreaterThanOrEqual(3);
  });

  it('records longestInFlightMs from the oldest in-flight item observed', async () => {
    mountBanner();
    const release = trackPersistentSlowEvent('test-stall');
    // Persistent tokens enter with `startTs = now - threshold - 1`, so the
    // longest-observed should be at least threshold + 1 ms.
    release();
    await flushMicrotasks();
    const body = posted[0].body as { context: string };
    const ctx = JSON.parse(body.context) as { longestInFlightMs: number };
    expect(ctx.longestInFlightMs).toBeGreaterThanOrEqual(SERVER_BUSY_THRESHOLD_MS);
  });

  it('opens a fresh activation on the next show after a hide', async () => {
    mountBanner();
    const r1 = trackPersistentSlowEvent('first');
    r1();
    await flushMicrotasks();
    const r2 = trackPersistentSlowEvent('second');
    r2();
    await flushMicrotasks();
    expect(posted).toHaveLength(2);
    const ctx1 = JSON.parse((posted[0].body as { context: string }).context) as { triggerLabel: string };
    const ctx2 = JSON.parse((posted[1].body as { context: string }).context) as { triggerLabel: string };
    expect(ctx1.triggerLabel).toBe('first');
    expect(ctx2.triggerLabel).toBe('second');
  });

  it('reset clears the activation so the next show is treated as a new one', () => {
    mountBanner();
    trackPersistentSlowEvent('leaked');
    expect(_inspectActivationForTesting()).not.toBeNull();
    _resetServerBusyChipForTesting();
    expect(_inspectActivationForTesting()).toBeNull();
  });
});
