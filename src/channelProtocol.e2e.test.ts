/**
 * HS-9437 — server-side Claude Channel protocol round-trip against a REAL
 * spawned Hot Sheet server. Automates the automatable half of the manual §3
 * plan: the trigger → busy(heartbeat) → done protocol (the permission POPUP
 * rendering stays a browser/e2e concern, partly covered by
 * `e2e/terminal-osc133-ask-claude.spec.ts`).
 *
 * The busy POSITIVE path needs a really-registered project (the heartbeat route
 * matches the POSTed secret against `getAllProjects()`), which the mocked
 * in-process harness in `routes/api.test.ts` can't provide — so it lives here,
 * where the spawned server has registered its project. The done-flag lifecycle's
 * fast branches are covered in `routes/api.test.ts` too.
 *
 * Gated by `canRunServerSpawnTests` like the other `*.e2e.test.ts` suites.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canRunServerSpawnTests, postJson, readSecret, type SpawnedHotSheet, spawnHotSheet } from './spawnTestServer.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!canRunServerSpawnTests)('Claude Channel protocol round-trip e2e (HS-9437) (skipped: no tsx child-spawn / inside a Hot Sheet terminal)', () => {
  let hs: SpawnedHotSheet | null = null;

  afterEach(async () => {
    if (hs !== null) {
      hs.proc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      hs = null;
    }
  });

  it('heartbeat busy is ingested + reported, and the done flag lifecycle (set / consume / trigger-clears) holds', async () => {
    hs = spawnHotSheet();
    await hs.ready;
    const secret = readSecret(hs.dataDir);
    const base = `http://localhost:${hs.port}`;
    const getJson = async (path: string): Promise<Record<string, unknown>> =>
      await (await fetch(`${base}${path}`, { headers: { 'X-Hotsheet-Secret': secret } })).json() as Record<string, unknown>;

    // --- busy heartbeat round-trip ---
    // Baseline cursor first, so we only observe our own busy update.
    const before = await getJson('/api/channel/heartbeat-status') as { seq: number };
    const hb = await (await postJson(`${base}/api/channel/heartbeat`, { secret, state: 'busy' }, secret)).json() as { ok: boolean };
    expect(hb.ok).toBe(true); // matched the spawned server's registered project

    const after = await getJson(`/api/channel/heartbeat-status?since=${before.seq}`) as {
      updates: { secret: string; state: string; seq: number }[];
      seq: number;
    };
    expect(after.updates.some((u) => u.state === 'busy')).toBe(true);
    expect(after.seq).toBeGreaterThan(before.seq);

    // --- done flag: set, then a single status read consumes it ---
    await postJson(`${base}/api/channel/done`, {}, secret);
    expect((await getJson('/api/channel/status')).done).toBe(true);
    expect((await getJson('/api/channel/status')).done).toBe(false);

    // --- a new trigger CLEARS a previously-set done flag (the manual §3 loop:
    // play resets "done" so the next completion is a fresh signal). No channel
    // server is attached, so trigger reports ok:false, but it still clears done. ---
    await postJson(`${base}/api/channel/done`, {}, secret);
    await postJson(`${base}/api/channel/trigger`, {}, secret);
    expect((await getJson('/api/channel/status')).done).toBe(false);
  });
});
