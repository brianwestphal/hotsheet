/**
 * HS-8934 — git-worktree follower redirect, end to end. Launching Hot Sheet
 * with `--data-dir <worktree>/.hotsheet` where that settings.json carries an
 * `authoritativeDataDir` pointer must redirect ALL project data to the owner:
 * the owner's DB receives the data, the follower never gets its own DB, and the
 * data is visible when the owner is opened directly. See docs/89-git-worktrees.md.
 *
 * Gated by `canRunServerSpawnTests` like the other `*.e2e.test.ts` suites.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canRunServerSpawnTests, postJson, readSecret,
  type SpawnedHotSheet, spawnHotSheet, waitForExit,
} from './spawnTestServer.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let children: SpawnedHotSheet[] = [];
let dirs: string[] = [];

beforeEach(() => { children = []; dirs = []; });

afterEach(() => {
  for (const c of children) {
    if (!c.proc.killed && c.proc.exitCode === null) c.proc.kill('SIGKILL');
    try { rmSync(c.homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe.skipIf(!canRunServerSpawnTests)('git-worktree follower redirect e2e (HS-8934) (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  it('a follower .hotsheet redirects to the owner — owner DB gets the data, no follower DB', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hs-wt-base-'));
    dirs.push(base);
    const ownerData = join(base, 'owner', '.hotsheet');
    const followerData = join(base, 'worktree', '.hotsheet');
    mkdirSync(ownerData, { recursive: true });
    mkdirSync(followerData, { recursive: true });
    // The worktree's follower pointer → the owner's .hotsheet.
    writeFileSync(join(followerData, 'settings.json'), JSON.stringify({ authoritativeDataDir: ownerData }));

    // Launch AGAINST THE FOLLOWER dir; it must redirect to the owner.
    const follower = spawnHotSheet({ dataDir: followerData });
    children.push(follower);
    await follower.ready;

    // Redirect proof: the owner got the DB, the follower never did.
    expect(existsSync(join(ownerData, 'db'))).toBe(true);
    expect(existsSync(join(followerData, 'db'))).toBe(false);

    // Create a ticket through the follower-launched server. The secret was
    // written to the RESOLVED owner dir.
    const secret = readSecret(ownerData);
    const created = await postJson(`http://localhost:${follower.port}/api/tickets`, { title: 'Worktree redirect ticket' }, secret);
    expect(created.status).toBeLessThan(300);

    // Shut down, then open the OWNER directly and confirm the ticket landed there.
    await postJson(`http://localhost:${follower.port}/api/shutdown`, {}, secret).catch(() => { /* shutting down */ });
    await waitForExit(follower.proc, 15_000).catch(() => { /* ignore */ });

    const owner = spawnHotSheet({ dataDir: ownerData });
    children.push(owner);
    await owner.ready;
    const ownerSecret = readSecret(ownerData);
    const listed = await fetch(`http://localhost:${owner.port}/api/tickets`, { headers: { 'X-Hotsheet-Secret': ownerSecret } });
    const body = await listed.text();
    expect(body).toContain('Worktree redirect ticket');
  });

  it('a follower pointing at a missing owner fails fast instead of creating a DB', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hs-wt-bad-'));
    dirs.push(base);
    const followerData = join(base, 'worktree', '.hotsheet');
    mkdirSync(followerData, { recursive: true });
    writeFileSync(join(followerData, 'settings.json'), JSON.stringify({ authoritativeDataDir: join(base, 'does-not-exist', '.hotsheet') }));

    const follower = spawnHotSheet({ dataDir: followerData });
    children.push(follower);
    // The server must exit (fatal) rather than become ready; and no DB is created.
    const exit = await waitForExit(follower.proc, 20_000).catch(() => null);
    expect(exit?.code).toBe(1);
    expect(existsSync(join(followerData, 'db'))).toBe(false);
  });
});
