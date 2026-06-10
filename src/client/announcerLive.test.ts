/**
 * §78 Announcer live mode 2b (HS-8767) — the client live session: lease
 * renewal, entry tailing with dedup, presence, and the backgrounded pause.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveSession, type LiveSessionDeps } from './announcerLive.js';
import type { ReelEntry } from './announcerPip.js';

function reel(secret: string, id: number, ts: string): ReelEntry {
  return { id, created_at: ts, covers_from: null, covers_to: null, title: `t${String(id)}`, script: 's', emphasis: [], visuals: [], position: id, dismissed: false, listened_at: null, projectSecret: secret, projectName: 'P' };
}

interface Harness {
  deps: LiveSessionDeps;
  setLiveCalls: [boolean, string][];
  newBatches: ReelEntry[][];
  presence: boolean[];
  entries: Record<string, ReelEntry[]>;
  visible: { value: boolean };
  busy: { value: boolean };
}

function harness(projectSecrets: string[]): Harness {
  const setLiveCalls: [boolean, string][] = [];
  const newBatches: ReelEntry[][] = [];
  const presence: boolean[] = [];
  const entries: Record<string, ReelEntry[]> = {};
  const visible = { value: true };
  const busy = { value: false };
  const deps: LiveSessionDeps = {
    projectSecrets,
    fetchEntries: (secret) => Promise.resolve(entries[secret] ?? []),
    setLive: (enabled, secret) => { setLiveCalls.push([enabled, secret]); return Promise.resolve({ ok: true }); },
    isBusy: () => busy.value,
    onNewEntries: (es) => newBatches.push(es),
    onPresence: (b) => presence.push(b),
    isVisible: () => visible.value,
    // Capture-but-don't-fire timers: the test drives poll()/stop() directly.
    setTimer: () => 1,
    clearTimer: vi.fn(),
  };
  return { deps, setLiveCalls, newBatches, presence, entries, visible, busy };
}

describe('LiveSession (HS-8767)', () => {
  it('start registers the lease and an initial poll seeds presence', async () => {
    const h = harness(['secA']);
    h.entries['secA'] = [reel('secA', 1, 't1')];
    h.busy.value = true;
    const s = new LiveSession(h.deps);
    s.seed([reel('secA', 1, 't1')]); // entry 1 already shown
    await s.start();
    expect(h.setLiveCalls).toContainEqual([true, 'secA']);
    expect(h.newBatches).toEqual([]);     // seeded entry not re-delivered
    expect(h.presence).toEqual([true]);   // initial poll read presence
  });

  it('tails new entries, deduped and oldest-first', async () => {
    const h = harness(['secA']);
    h.entries['secA'] = [reel('secA', 1, 't1')];
    const s = new LiveSession(h.deps);
    s.seed([reel('secA', 1, 't1')]);
    await s.start();

    // Generator produced 2 and 3 (out of order in the response).
    h.entries['secA'] = [reel('secA', 3, 't3'), reel('secA', 1, 't1'), reel('secA', 2, 't2')];
    await s.poll();
    expect(h.newBatches.at(-1)?.map(e => e.id)).toEqual([2, 3]); // 1 deduped, sorted by ts

    // A repeat poll with nothing new delivers nothing (start poll was empty too).
    await s.poll();
    expect(h.newBatches).toHaveLength(1);
  });

  it('stop drops the lease', async () => {
    const h = harness(['secA']);
    const s = new LiveSession(h.deps);
    await s.start();
    h.setLiveCalls.length = 0;
    await s.stop();
    expect(h.setLiveCalls).toEqual([[false, 'secA']]);
  });

  it('pauses tailing + renewal while the window is hidden', async () => {
    const h = harness(['secA']);
    const s = new LiveSession(h.deps);
    h.visible.value = false;
    h.entries['secA'] = [reel('secA', 1, 't1')];
    await s.start();
    await s.poll();
    expect(h.setLiveCalls).toEqual([]); // renew skipped while hidden
    expect(h.newBatches).toEqual([]);   // no fetch while hidden
  });

  it('renews leases for every live project', async () => {
    const h = harness(['secA', 'secB']);
    const s = new LiveSession(h.deps);
    await s.start();
    expect(h.setLiveCalls).toContainEqual([true, 'secA']);
    expect(h.setLiveCalls).toContainEqual([true, 'secB']);
  });
});
