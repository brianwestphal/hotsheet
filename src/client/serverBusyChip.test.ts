/**
 * HS-8175 — Tests for the global server-busy chip.
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
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
