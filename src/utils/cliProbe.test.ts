// HS-9522 — the cached, coalesced, async CLI probe.
//
// The point of the helper is that a `/glassbox/status` poll no longer spawns a child
// per request AND no longer blocks the event loop. The cases below pin the three
// properties that make that safe: the TTL still notices an install, concurrent callers
// share one spawn, and a transient failure is not pinned for the whole window.

import { describe, expect, it, vi } from 'vitest';

import { createCachedProbe, PROBE_TTL_MS, probeCli, type ProbeDeps } from './cliProbe.js';

/** A controllable clock so TTL behavior is deterministic rather than timing-dependent. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createCachedProbe', () => {
  it('computes once and reuses the value within the TTL', async () => {
    const c = clock();
    const compute = vi.fn(() => Promise.resolve('v1'));
    const probe = createCachedProbe(compute, { now: c.now });

    expect(await probe.get()).toBe('v1');
    expect(await probe.get()).toBe('v1');
    c.advance(PROBE_TTL_MS - 1);
    expect(await probe.get()).toBe('v1');
    expect(compute).toHaveBeenCalledTimes(1); // one spawn for a burst of polling
  });

  it('re-computes once the TTL expires, so an install is noticed without a restart', async () => {
    // HS-8786 removed a permanent cache precisely because a PATH/install fix needed a
    // server restart to take effect. The TTL keeps that property.
    const c = clock();
    let answer = 'not-installed';
    const probe = createCachedProbe(() => Promise.resolve(answer), { now: c.now });

    expect(await probe.get()).toBe('not-installed');
    answer = '/usr/local/bin/glassbox'; // the user installs it
    c.advance(PROBE_TTL_MS + 1);
    expect(await probe.get()).toBe('/usr/local/bin/glassbox');
  });

  it('COALESCES concurrent callers into a single compute', async () => {
    // N simultaneous requests must spawn one child, not N. Without this the fix trades
    // a blocked loop for a process storm.
    const c = clock();
    let release: (v: string) => void = () => { /* set below */ };
    const compute = vi.fn(() => new Promise<string>(r => { release = r; }));
    const probe = createCachedProbe(compute, { now: c.now });

    const all = Promise.all([probe.get(), probe.get(), probe.get()]);
    release('shared');
    expect(await all).toEqual(['shared', 'shared', 'shared']);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a rejection — a transient failure must not be pinned for the TTL', async () => {
    // A stalled mount or a momentarily missing binary would otherwise stick for the
    // whole window, which is the opposite of what a short TTL is for.
    const c = clock();
    const compute = vi.fn()
      .mockRejectedValueOnce(new Error('stalled mount'))
      .mockResolvedValueOnce('recovered');
    const probe = createCachedProbe(compute as () => Promise<string>, { now: c.now });

    await expect(probe.get()).rejects.toThrow('stalled mount');
    expect(await probe.get()).toBe('recovered'); // retried immediately, no TTL wait
  });

  it('recovers from a rejection even while callers were coalesced onto it', async () => {
    const c = clock();
    const compute = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const probe = createCachedProbe(compute as () => Promise<string>, { now: c.now });

    // Both share the failing in-flight promise; the slot must still be cleared after.
    const [a, b] = await Promise.allSettled([probe.get(), probe.get()]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(await probe.get()).toBe('ok');
  });

  it('reset() drops the cache', async () => {
    const c = clock();
    const compute = vi.fn(() => Promise.resolve('x'));
    const probe = createCachedProbe(compute, { now: c.now });
    await probe.get();
    probe.reset();
    await probe.get();
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe('probeCli', () => {
  const deps = (run: ProbeDeps['run']): Required<ProbeDeps> => ({ now: Date.now, run: run! });

  it('returns trimmed stdout', async () => {
    const d = deps(() => Promise.resolve('/usr/local/bin/glassbox'));
    expect(await probeCli(d, 'which', ['glassbox'], 1000)).toBe('/usr/local/bin/glassbox');
  });

  it('returns null rather than throwing when the CLI is missing', async () => {
    // "not installed" and "the probe broke" are the same answer to every caller here,
    // and a throw would surface as a 500 on a status endpoint.
    const d = deps(() => Promise.reject(new Error('ENOENT')));
    expect(await probeCli(d, 'which', ['nope'], 1000)).toBeNull();
  });

  it('treats empty output as not-found', async () => {
    const d = deps(() => Promise.resolve('   '));
    expect(await probeCli(d, 'which', ['glassbox'], 1000)).toBeNull();
  });

  it('passes the timeout AND any env through to the runner', async () => {
    // The augmented PATH is load-bearing for the glassbox probe: a Dock/Finder launch
    // gets a minimal PATH, so losing `env` would stop finding an installed CLI.
    const seen: unknown[] = [];
    const d = deps((file, args, timeoutMs, options) => {
      seen.push({ file, args, timeoutMs, env: options?.env?.PATH });
      return Promise.resolve('ok');
    });
    await probeCli(d, 'which', ['glassbox'], 3000, { env: { PATH: '/custom/bin' } });
    expect(seen).toEqual([{ file: 'which', args: ['glassbox'], timeoutMs: 3000, env: '/custom/bin' }]);
  });
});
