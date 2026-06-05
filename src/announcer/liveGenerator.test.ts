/**
 * §78 Announcer live mode (HS-8750 2a) — the live-listen lease registry. The
 * lease + its expiry are the "off unless listening" safety: generation only
 * runs for a project whose lease the client is renewing, so a closed/crashed
 * window can't silently keep spending the API key.
 */
import { afterEach, describe, expect, it } from 'vitest';

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
