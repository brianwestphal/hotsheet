/**
 * HS-9110 (docs/100 §100.2.1(a)) — the periodic SERVER-side worker-pool reconcile
 * loop. The deferred third trigger of docs/100: HS-9076 shipped the reconcile CORE
 * (`reconcilePool`) + the `POST /api/workers/pool/reconcile` endpoint + the
 * `hotsheet_set_worker_target` MCP-tool trigger (the explicit, no-UI scaling path).
 * This adds a lightweight interval that re-reconciles every ~N s so the pool keeps
 * **self-healing + scaling with NO UI and NO MCP call** — a crashed worker is
 * replaced and a headlessly-raised target actually launches.
 *
 * It mirrors `src/claims/leaseSweepTimer.ts` / `src/telemetryRetentionTimer.ts`:
 *   - the work runs OFF the main loop via the §75 background scheduler (GC
 *     priority, deferred under event-loop lag, coalesced) — never inline on the
 *     timer tick, so a slow reconcile can't wedge the loop;
 *   - the interval is `unref()`'d (never keeps the process alive) and cleared on
 *     shutdown (`lifecycle.ts`).
 *
 * **Safety gating** (§100.3) — a server loop that spawns `claude` processes with
 * no human present needs a clear enable. Each pass reconciles a project ONLY when
 * all hold:
 *   1. **Headless enabled** — `isHeadlessPoolEnabled` (the Auto switch wrote it).
 *   2. **`targetN > 0`** — the §91.7 empty-pool back-off: an idle pool is skipped
 *      entirely (no hammering when there's nothing to scale toward).
 *   3. **A connected worker-capable Claude** — `isChannelAlive` (workers need a
 *      live channel to do anything; mirrors the client's channel-visibility gate).
 * `reconcilePool` itself still clamps spawns to `poolMax()`.
 */
import { isChannelAlive } from '../channel-config.js';
import { isGitRepo } from '../gitignore.js';
import { readProjectList } from '../project-list.js';
import { projectRootFromDataDir } from '../routes/git.js';
import { type BackgroundScheduler, getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';
import { getProjectSecret } from '../secret-file.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { isHeadlessPoolEnabled } from './headlessPool.js';
import { getPoolState } from './poolManager.js';
import { reconcilePool } from './reconcilePool.js';

/** 10 s — responsive enough to replace a crashed worker / pick up a headless
 *  target change promptly, while staying off the hot path (work is off-loop). */
export const POOL_RECONCILE_INTERVAL_MS = 10 * 1000;

let timer: NodeJS.Timeout | null = null;

/** Injectable seams so a test drives one reconcile pass with no real git/PTYs. */
export interface ReconcileEnabledDeps {
  /** List the registered project data dirs (besides the launched one). */
  listProjects?: () => string[];
  /** Is headless scaling enabled for this project? */
  isEnabled?: (dataDir: string) => boolean;
  /** The pool's recorded target for this project. */
  poolTarget?: (dataDir: string) => number;
  /** Is a worker-capable Claude connected for this project? */
  channelAlive?: (dataDir: string) => Promise<boolean>;
  /** Is the project root a git repo (worktrees require one)? */
  gitRepo?: (repoRoot: string) => boolean;
  /** The project secret (for the reconcile's server-side proxying). */
  secretFor?: (dataDir: string) => string;
  /** Resolve the project repo root from its data dir. */
  repoRootFor?: (dataDir: string) => string;
  /** Run one reconcile for an enabled project. Defaults to `reconcilePool`. */
  reconcile?: (secret: string, dataDir: string, repoRoot: string) => Promise<unknown>;
}

/**
 * One reconcile pass over every enabled project. Walks the launched data dir plus
 * the registered project list, reconciling only the projects that pass the three
 * safety gates. Never throws — a per-project failure is logged and the pass
 * continues. Returns how many projects were reconciled (test signal).
 */
export async function reconcileEnabledHeadlessPools(
  launchedDataDir: string,
  deps: ReconcileEnabledDeps = {},
): Promise<number> {
  const listProjects = deps.listProjects ?? readProjectList;
  const isEnabled = deps.isEnabled ?? isHeadlessPoolEnabled;
  const poolTarget = deps.poolTarget ?? ((dir: string) => getPoolState(dir).targetN);
  const channelAlive = deps.channelAlive ?? isChannelAlive;
  const gitRepo = deps.gitRepo ?? isGitRepo;
  const secretFor = deps.secretFor ?? getProjectSecret;
  const repoRootFor = deps.repoRootFor ?? projectRootFromDataDir;
  const reconcile = deps.reconcile ?? reconcilePool;

  const dirs = new Set<string>([launchedDataDir, ...listProjects()]);
  let reconciled = 0;
  for (const dir of dirs) {
    try {
      if (!isEnabled(dir)) continue;                 // 1) explicit headless opt-in
      if (poolTarget(dir) <= 0) continue;            // 2) §91.7 empty-pool back-off
      const repoRoot = repoRootFor(dir);
      if (!gitRepo(repoRoot)) continue;              //    worktrees require a git repo
      if (!(await channelAlive(dir))) continue;      // 3) connected worker-capable Claude
      await reconcile(secretFor(dir), dir, repoRoot);
      reconciled++;
    } catch (e) {
      console.warn(`[workers] headless reconcile failed for ${dir}: ${getErrorMessage(e)}`);
    }
  }
  return reconciled;
}

export interface PoolReconcileTimerOptions {
  scheduler?: BackgroundScheduler;
  intervalMs?: number;
  /** Inject the reconcile pass (tests). Defaults to `reconcileEnabledHeadlessPools`. */
  pass?: (launchedDataDir: string) => Promise<unknown>;
  setIntervalFn?: (cb: () => void, ms: number) => NodeJS.Timeout;
}

/** Start (or restart) the periodic pool-reconcile loop for the launched project.
 *  Idempotent — a second call replaces the existing timer so there's never more
 *  than one. Each tick submits ONE coalesced pass to the §75 scheduler. */
export function startPoolReconcileTimer(launchedDataDir: string, opts: PoolReconcileTimerOptions = {}): void {
  stopPoolReconcileTimer();
  const intervalMs = opts.intervalMs ?? POOL_RECONCILE_INTERVAL_MS;
  const scheduler = opts.scheduler ?? getBackgroundScheduler();
  const pass = opts.pass ?? ((dir: string) => reconcileEnabledHeadlessPools(dir));
  const setIntervalFn = opts.setIntervalFn
    ?? ((cb: () => void, ms: number): NodeJS.Timeout => setInterval(cb, ms));

  timer = setIntervalFn(() => {
    void scheduler.submit({
      key: 'worker-pool-reconcile',
      projectKey: launchedDataDir,
      priority: PRIORITY.GC,
      deferUnderLag: true,
      run: async () => { await pass(launchedDataDir); },
    });
  }, intervalMs);
  timer.unref();
}

/** Stop the periodic timer (shutdown / tests). No-op when not running. */
export function stopPoolReconcileTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test seam — is the timer currently armed? */
export function isPoolReconcileTimerRunning(): boolean {
  return timer !== null;
}
