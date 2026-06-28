/**
 * §78 Announcer live mode (HS-8750 2a) — the live-listen lease registry. The
 * lease + its expiry are the "off unless listening" safety: generation only
 * runs for a project whose lease the client is renewing, so a closed/crashed
 * window can't silently keep spending the API key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { notifyChange } from '../routes/notify.js';
import {
  _resetLiveGeneratorForTesting, getLiveProjects, isLive, LIVE_LEASE_MS,
  registerLiveListener, unregisterLiveListener,
} from './liveGenerator.js';

// Stub the generation pass so registering doesn't try to touch a DB / Anthropic.
afterEach(() => { _resetLiveGeneratorForTesting(() => Promise.resolve()); });

// Register internally prunes against the real clock (it starts the loop), so the
// test's reference `now` must be near real time, not a tiny synthetic value.
const NOW = Date.now();

describe('live-listen lease registry (HS-8750)', () => {
  it('registers a project as live and lists it', () => {
    _resetLiveGeneratorForTesting(() => Promise.resolve());
    registerLiveListener('secA', '/data/a', NOW);
    expect(isLive('secA', NOW)).toBe(true);
    expect(getLiveProjects(NOW)).toEqual([{ secret: 'secA', dataDir: '/data/a' }]);
  });

  it('a lease expires once the client stops renewing', () => {
    _resetLiveGeneratorForTesting(() => Promise.resolve());
    registerLiveListener('secA', '/data/a', NOW);
    expect(isLive('secA', NOW + LIVE_LEASE_MS - 1)).toBe(true);
    expect(isLive('secA', NOW + LIVE_LEASE_MS)).toBe(false);      // expiresAt is inclusive
    expect(getLiveProjects(NOW + LIVE_LEASE_MS)).toEqual([]);
  });

  it('renewing extends the lease', () => {
    _resetLiveGeneratorForTesting(() => Promise.resolve());
    registerLiveListener('secA', '/data/a', NOW);
    registerLiveListener('secA', '/data/a', NOW + LIVE_LEASE_MS - 1); // renew before expiry
    expect(isLive('secA', NOW + LIVE_LEASE_MS + 100)).toBe(true);     // still live past the original
  });

  it('unregister drops the lease immediately', () => {
    _resetLiveGeneratorForTesting(() => Promise.resolve());
    registerLiveListener('secA', '/data/a', NOW);
    unregisterLiveListener('secA');
    expect(isLive('secA', NOW)).toBe(false);
    expect(getLiveProjects(NOW)).toEqual([]);
  });

  it('tracks multiple live projects independently', () => {
    _resetLiveGeneratorForTesting(() => Promise.resolve());
    registerLiveListener('secA', '/data/a', NOW);
    registerLiveListener('secB', '/data/b', NOW);
    expect(getLiveProjects(NOW).map(p => p.secret).sort()).toEqual(['secA', 'secB']);
  });
});

// HS-9137 — the producer-loop wiring: a change-version wake pings the coalescing
// trigger, which fires the generation pass once the quiet window elapses; the
// loop stops itself when no project is live.
describe('live generation loop wiring (HS-8750 2a)', () => {
  const QUIET_MS = 15_000;

  afterEach(() => { vi.useRealTimers(); });

  it('fires the generation pass once after a coalesced change burst', async () => {
    vi.useFakeTimers();
    let passes = 0;
    _resetLiveGeneratorForTesting(() => { passes += 1; return Promise.resolve(); });
    registerLiveListener('secA', '/data/a'); // starts the loop + arms a poll waiter

    // Two changes inside the quiet window coalesce into a single pass.
    notifyChange();
    await vi.advanceTimersByTimeAsync(5_000);
    notifyChange();
    expect(passes).toBe(0); // not yet — still inside the quiet window
    await vi.advanceTimersByTimeAsync(QUIET_MS + 100);
    expect(passes).toBe(1);
  });

  it('stops the loop (no pass) once no project is live', async () => {
    vi.useFakeTimers();
    let passes = 0;
    _resetLiveGeneratorForTesting(() => { passes += 1; return Promise.resolve(); });
    registerLiveListener('secA', '/data/a');
    unregisterLiveListener('secA'); // lease gone before the next wake
    notifyChange();                 // waiter sees 0 live → stopLoop, no trigger ping
    await vi.advanceTimersByTimeAsync(QUIET_MS + 5_000);
    expect(passes).toBe(0);
  });
});
