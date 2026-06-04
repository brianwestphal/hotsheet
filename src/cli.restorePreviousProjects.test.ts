import { mkdirSync, rmSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Load resilience (epic HS-8722, docs/75 — startup restore path) — `restorePreviousProjects` registers the
 * previous session's projects through the central background scheduler instead
 * of a bare serial `await` loop. The old loop fanned PGLite WASM init + the §73
 * snapshot probe + per-project schedulers/watchers back-to-back onto the single
 * event loop; with a real list (the reporter had 9 projects) it saturated the
 * loop for ~3 minutes on launch, so the already-listening server never became
 * responsive. These tests pin the three invariants the fix relies on:
 *
 *   1. Concurrency is bounded by the scheduler cap (so the fan-out can't
 *      saturate the loop again).
 *   2. The surviving project list keeps ORIGINAL list order even though restore
 *      jobs complete out of order (tab order must be deterministic).
 *   3. The primary project is not re-registered and missing dirs are dropped.
 */

const tempBase = join(os.tmpdir(), `hs-restore-test-${String(Date.now())}`);
const primary = join(tempBase, 'primary');
const dirA = join(tempBase, 'a');
const dirB = join(tempBase, 'b');
const dirC = join(tempBase, 'c');
const dirD = join(tempBase, 'd');
const missing = join(tempBase, 'missing'); // intentionally never created

// Per-test mutable list returned by the readProjectList mock.
let projectList: string[] = [];
// Per-dir artificial registration delay (ms) to force out-of-order completion.
const delays: Record<string, number> = {};
// Concurrency tracking for the bounded-fan-out assertion.
let inFlight = 0;
let maxInFlight = 0;
const registerCalls: string[] = [];
const reorderListCalls: string[][] = [];
let notifyCount = 0;

vi.mock('./project-list.js', () => ({
  readProjectList: () => projectList,
  reorderProjectList: (dirs: string[]) => { reorderListCalls.push([...dirs]); },
}));

vi.mock('./projects.js', () => ({
  registerExistingProject: vi.fn(),
  registerProject: async (dataDir: string) => {
    registerCalls.push(dataDir);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, delays[dataDir] ?? 5));
    inFlight -= 1;
    return { secret: `secret-${dataDir}`, dataDir, name: dataDir };
  },
  getProjectByDataDir: (dir: string) => ({ secret: `secret-${dir}` }),
  reorderProjects: vi.fn(),
}));

vi.mock('./terminals/eagerSpawn.js', () => ({
  eagerSpawnTerminals: vi.fn(),
}));

vi.mock('./routes/notify.js', () => ({
  notifyChange: () => { notifyCount += 1; },
}));

const { restorePreviousProjects } = await import('./cli.js');
const { _resetDefaultSchedulerForTests } = await import('./scheduler/backgroundScheduler.js');

beforeEach(() => {
  for (const d of [primary, dirA, dirB, dirC, dirD]) mkdirSync(d, { recursive: true });
  projectList = [primary, dirA, dirB, dirC, missing, dirD];
  // Reverse-of-list-order delays so completion order != list order.
  delays[dirA] = 50; delays[dirB] = 40; delays[dirC] = 20; delays[dirD] = 5;
  inFlight = 0;
  maxInFlight = 0;
  registerCalls.length = 0;
  reorderListCalls.length = 0;
  notifyCount = 0;
  _resetDefaultSchedulerForTests(); // fresh singleton (default concurrency = 2)
});

afterAll(() => {
  try { rmSync(tempBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('restorePreviousProjects — scheduler-bounded restore (HS-8722)', () => {
  it('registers every existing non-primary project, skipping the primary and missing dirs', async () => {
    await restorePreviousProjects(primary, 4174);
    // a, b, c, d registered; primary (already registered) and missing (gone) skipped.
    expect(new Set(registerCalls)).toEqual(new Set([dirA, dirB, dirC, dirD]));
    expect(registerCalls).not.toContain(primary);
    expect(registerCalls).not.toContain(missing);
  });

  it('bounds concurrency to the scheduler cap (never fans the whole list onto the loop at once)', async () => {
    await restorePreviousProjects(primary, 4174);
    // The default scheduler cap is 2 — the regression was unbounded serial blast.
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('rebuilds the surviving list in ORIGINAL order despite out-of-order completion', async () => {
    await restorePreviousProjects(primary, 4174);
    // The list changed (missing dropped), so reorderProjectList is called once
    // with original order minus the missing dir — NOT completion order.
    expect(reorderListCalls).toHaveLength(1);
    expect(reorderListCalls[0]).toEqual([primary, dirA, dirB, dirC, dirD]);
  });

  it('surfaces tabs progressively via notifyChange as each project lands', async () => {
    await restorePreviousProjects(primary, 4174);
    // One notify per restored project (4) + the final reorder notify.
    expect(notifyCount).toBeGreaterThanOrEqual(4);
  });
});
