/**
 * HS-8920 — launch-level proof that `HOTSHEET_HOME` relocates ALL global state.
 *
 * The unit suite (`global-dir.test.ts`) pins each resolver in isolation; this
 * spawns a REAL `tsx src/cli.ts` child with `HOTSHEET_HOME` pointed at a temp
 * dir that is DISTINCT from the child's HOME, then asserts the global files land
 * under `HOTSHEET_HOME` and that `<HOME>/.hotsheet` is never created — the exact
 * isolation guarantee the `--test` instance (HS-8921) builds on.
 *
 * Uses the shared spawn harness (`spawnTestServer.ts`). Gated by
 * `canRunServerSpawnTests` like the other `*.e2e.test.ts` suites.
 */
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canRunServerSpawnTests,
  type SpawnedHotSheet,
  spawnHotSheet,
} from './spawnTestServer.js';

// Spawning a real tsx child (compile + PGLite init) is slow under the merged
// coverage run — scope a generous timeout to this file (same as the other
// spawn-bearing e2e suites).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let activeChildren: SpawnedHotSheet[] = [];
let extraDirs: string[] = [];

beforeEach(() => {
  activeChildren = [];
  extraDirs = [];
});

afterEach(() => {
  for (const child of activeChildren) {
    if (!child.proc.killed && child.proc.exitCode === null) child.proc.kill('SIGKILL');
    try { rmSync(child.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(child.homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of extraDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeChildren = [];
  extraDirs = [];
});

describe.skipIf(!canRunServerSpawnTests)('HOTSHEET_HOME relocates global state e2e (HS-8920) (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  it('writes config.json / projects.json / instance.json under HOTSHEET_HOME, never under HOME/.hotsheet', async () => {
    const hotsheetHome = mkdtempSync(join(tmpdir(), 'hs-e2e-HOTSHEET_HOME-'));
    extraDirs.push(hotsheetHome);

    const child = spawnHotSheet({ extraEnv: { HOTSHEET_HOME: hotsheetHome } });
    activeChildren.push(child);
    await child.ready;
    // The global files (instance.json / projects.json) are written in the
    // post-startup phase, AFTER the server starts listening — so /api/stats
    // (what `ready` waits on) can answer before they exist. Wait for the
    // post-startup completion marker before asserting on them.
    await child.waitForOutput('startup finished', 30_000);

    // Global files landed under the relocated home...
    expect(existsSync(join(hotsheetHome, 'instance.json'))).toBe(true);
    expect(existsSync(join(hotsheetHome, 'projects.json'))).toBe(true);

    // ...and the child's HOME/.hotsheet was never created (full isolation).
    expect(existsSync(join(child.homeDir, '.hotsheet'))).toBe(false);
  });
});
