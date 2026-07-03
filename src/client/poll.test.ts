// HS-9301 — the active-device resync gate on the /api/poll fallback (docs/109 §109.5).
import { describe, expect, it } from 'vitest';

import { ACTIVE_DEVICE_POLL_THROTTLE_MS, shouldResyncActiveDeviceOnPoll } from './poll.js';

describe('shouldResyncActiveDeviceOnPoll', () => {
  const T = ACTIVE_DEVICE_POLL_THROTTLE_MS;

  it('never resyncs while the WS is the live transport (it delivers the event)', () => {
    expect(shouldResyncActiveDeviceOnPoll(true, 1_000_000, 0)).toBe(false);
    // even past the throttle window, WS-active suppresses the poll-read
    expect(shouldResyncActiveDeviceOnPoll(true, 1_000_000, 1_000_000 - T - 1)).toBe(false);
  });

  it('resyncs on the fallback once the throttle window has elapsed', () => {
    const now = 1_000_000;
    expect(shouldResyncActiveDeviceOnPoll(false, now, now - T)).toBe(true);
    expect(shouldResyncActiveDeviceOnPoll(false, now, now - T - 1)).toBe(true);
  });

  it('throttles rapid poll ticks on the fallback (loop runs ~10x/s)', () => {
    const last = 1_000_000;
    expect(shouldResyncActiveDeviceOnPoll(false, last + 100, last)).toBe(false); // 100ms later — within window
    expect(shouldResyncActiveDeviceOnPoll(false, last + T - 1, last)).toBe(false);
    expect(shouldResyncActiveDeviceOnPoll(false, last + T, last)).toBe(true); // window elapsed
  });

  it('first call (lastAt = 0) resyncs immediately on the fallback', () => {
    expect(shouldResyncActiveDeviceOnPoll(false, T, 0)).toBe(true);
  });
});
