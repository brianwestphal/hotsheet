// HS-9077 (docs/100 §100.2.2) — server-owned worker terminal lifecycle. Uses the
// `setPtyFactory` seam with a fake PTY (pid 0 ⇒ the `teardownPty` `rootPid > 0`
// guard skips any real kill) + an injected git runner, so NO real processes or
// git run. See `terminals/registry.test.ts` for the same safe pattern.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDynamicTerminalConfig } from '../routes/terminal.js';
import { type PtyFactory, type PtyLike, setPtyFactory, type SpawnArgs } from '../terminals/registry.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { GitRunner } from '../worktrees.js';
import type { WorkerLaunchSpec } from './launchWorker.js';
import { _resetPoolsForTesting, getPoolState, registerWorker } from './poolManager.js';
import { reapWorker, spawnWorkerTerminal } from './serverWorkerLifecycle.js';

/** Minimal in-memory PTY (pid 0 ⇒ no real kill). */
class FakePty implements PtyLike {
  static lastSpawned: FakePty | null = null;
  pid = 0;
  cols: number;
  rows: number;
  command: string;
  constructor(args: SpawnArgs) {
    this.cols = args.cols; this.rows = args.rows; this.command = args.command;
    FakePty.lastSpawned = this;
  }
  onData(): { dispose(): void } { return { dispose: () => { /* noop */ } }; }
  onExit(): { dispose(): void } { return { dispose: () => { /* noop */ } }; }
  write(): void { /* noop */ }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
  kill(): void { /* noop — pid 0 means teardownPty never tree-kills */ }
}

const factory: PtyFactory = (args) => new FakePty(args);
const SECRET = 'sek';
const SPEC: WorkerLaunchSpec = {
  worker: 'w1', label: 'worker-1', cwd: '/wt/w1',
  command: 'claude "/hotsheet-worker"', worktreeCreated: true,
};

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'hs-swl-'));
  const dataDir = join(root, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), '{}');
  return dataDir;
}

describe('spawnWorkerTerminal (HS-9077)', () => {
  let restore: PtyFactory | undefined;
  let dataDir: string;
  beforeEach(() => { restore = setPtyFactory(factory); FakePty.lastSpawned = null; dataDir = makeDataDir(); });
  afterEach(() => { if (restore !== undefined) setPtyFactory(restore); rmSync(join(dataDir, '..'), { recursive: true, force: true }); });

  it('spawns a server-tracked PTY in the worktree cwd and returns its terminalId', () => {
    const id = spawnWorkerTerminal(SECRET, dataDir, SPEC);
    expect(id).toMatch(/^dyn-/);
    // The dynamic config is registered server-side (no client involved).
    const config = getDynamicTerminalConfig(SECRET, id);
    expect(config).not.toBeNull();
    expect(config?.cwd).toBe('/wt/w1');
    expect(config?.name).toBe('worker-1');
    // A PTY was actually spawned server-side.
    expect(FakePty.lastSpawned).not.toBeNull();
  });
});

describe('reapWorker (HS-9077)', () => {
  let restore: PtyFactory | undefined;
  let dataDir: string;
  const repoRoot = '/repo';

  beforeEach(async () => {
    restore = setPtyFactory(factory);
    _resetPoolsForTesting();
    dataDir = await setupTestDb(); // the DB-backed dataDir (claims live here)
  });
  afterEach(async () => { if (restore !== undefined) setPtyFactory(restore); await cleanupTestDb(dataDir); });

  /** A git runner that records its calls and (by default) succeeds. */
  function gitSpy(impl?: GitRunner): { fn: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const fn: GitRunner = (root, args) => { calls.push(args); return impl ? impl(root, args) : Promise.resolve(''); };
    return { fn, calls };
  }

  it('closes the PTY, removes the worktree, drops the slot, and force-releases its claims', async () => {
    // Spawn a server PTY + register the slot with its id.
    const terminalId = spawnWorkerTerminal(SECRET, dataDir, SPEC);
    registerWorker(dataDir, { worker: 'w1', label: 'worker-1', worktreePath: '/wt/w1', terminalId });
    // The worker holds a live claim.
    const db = (await import('../db/connection.js')).getDb;
    await (await db()).query(
      `INSERT INTO tickets (ticket_number, title, claimed_by, claim_lease_expires_at)
       VALUES ('HS-1', 'held', 'w1', NOW() + INTERVAL '30 minutes')`,
    );

    const git = gitSpy();
    await reapWorker(SECRET, dataDir, repoRoot, { worker: 'w1', worktreePath: '/wt/w1', terminalId }, git.fn);

    // PTY closed (config gone).
    expect(getDynamicTerminalConfig(SECRET, terminalId)).toBeNull();
    // Worktree removed (one guarded `git worktree remove --force <path>`).
    expect(git.calls.some(a => a[0] === 'worktree' && a.includes('remove') && a.includes('--force'))).toBe(true);
    // Slot dropped.
    expect(getPoolState(dataDir).workers.find(w => w.worker === 'w1')).toBeUndefined();
    // Claim force-released (reclaimable now).
    const claimed = (await (await db()).query<{ claimed_by: string | null }>(`SELECT claimed_by FROM tickets WHERE ticket_number = 'HS-1'`)).rows[0];
    expect(claimed.claimed_by).toBeNull();
  });

  it('is best-effort — a failing removeWorktree still drops the slot', async () => {
    registerWorker(dataDir, { worker: 'w1', label: 'worker-1', worktreePath: '/wt/w1', terminalId: null });
    const git = gitSpy(() => Promise.reject(new Error('git boom')));
    await reapWorker(SECRET, dataDir, repoRoot, { worker: 'w1', worktreePath: '/wt/w1', terminalId: null }, git.fn);
    expect(getPoolState(dataDir).workers.find(w => w.worker === 'w1')).toBeUndefined();
  });
});
