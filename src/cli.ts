import type { PGlite } from '@electric-sql/pglite';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { initBackupScheduler } from './backup.js';
import { cleanupAllProjectsTelemetry, cleanupAttachments } from './cleanup.js';
import { maybeApplyTestModeHome, parseArgs, type ParsedArgs, printUsage } from './cli/args.js';
import { handleClose, handleList, joinRunningInstance, shutdownRunningInstance } from './cli/close.js';
import { getDb, setDataDir } from './db/connection.js';
import { getCategories } from './db/queries.js';
import { initSnapshotScheduler } from './db/snapshot.js';
import { DEMO_SCENARIOS, seedDemoData } from './demo.js';
import { setDemoMode } from './demo-mode.js';
import { startEventLoopWatchdog } from './diagnostics/watchdog.js';
import { enrichProcessPath } from './enrich-path.js';
import { PLUGINS_ENABLED } from './feature-flags.js';
import { ensureSecret, migrateLocalScopedKeys, resolveAuthoritativeDataDir, writeFileSettings } from './file-settings.js';
import { ensureGitignore } from './gitignore.js';
import { cleanupStaleInstance, isInstanceRunning, readInstanceFile, removeInstanceFile, writeInstanceFile } from './instance.js';
import { acquireLockWaitingForShutdown } from './lock.js';
import { addToProjectList, readProjectList } from './project-list.js';
import { registerExistingProject, registerProject } from './projects.js';
import { ErrorBodySchema, ProjectNameOnlySchema } from './schemas.js';
import { startServer } from './server.js';
import { ensureSkillsForDir, initSkills, setSkillCategories } from './skills.js';
import { createStartupWatchdog, getCurrentPhase, getElapsedMs, getStartupLogPath, initStartupLog, startupLog, startupMark } from './startup-log.js';
import { initMarkdownSync, scheduleAllSync } from './sync/markdown.js';
import { checkForUpdates } from './update-check.js';
import { getErrorMessage } from './utils/errorMessage.js';

// HS-8361 — bump libuv's threadpool cap from the default 4 to 16. libuv
// reads UV_THREADPOOL_SIZE lazily on the FIRST `uv_queue_work` call
// (every `fs.promises` syscall, plus DNS / zlib / crypto async ops); it
// then allocates threads up to the cap on demand, so the cost is zero
// until threads are actually needed. Lifts the queueing wall for
// concurrent fs operations across N registered projects' backup trains
// (HS-8351 async fsync + HS-8353 instrumented attachment pipeline) — the
// 5th + concurrent operation no longer waits behind the 4th. ESM module
// imports do not themselves invoke libuv async work (they load modules
// synchronously), so setting the env var at the top of cli.ts's body —
// AFTER imports per ESLint `import/first` but BEFORE any function call —
// is sufficient. Honors a user override if the env var is already set.
if (process.env.UV_THREADPOOL_SIZE === undefined || process.env.UV_THREADPOOL_SIZE === '') {
  process.env.UV_THREADPOOL_SIZE = '16';
}

// macOS / Linux GUI launches (Dock, Spotlight, Finder) hand the Tauri app
// a minimal PATH like `/usr/bin:/bin:/usr/sbin:/sbin`. That hides
// user-installed binaries (`claude`, Homebrew, ~/.local/bin, asdf shims),
// which then breaks `resolveTerminalCommand`'s `{{claudeCommand}}`
// substitution — it can't find `claude` and falls back to a bare shell.
// Enrich PATH from the user's login shell once, before anything reads PATH.
// See `src/enrich-path.ts` for the full rationale + implementation.
enrichProcessPath();

/**
 * Handle early exit flags: --close, --list, --version, --help.
 * Returns true if the process should exit.
 */
async function handleEarlyFlags(args: ParsedArgs): Promise<boolean> {
  if (args.close) {
    await handleClose(args.dataDir, args.force);
    process.exit(0);
  }

  if (args.list) {
    const instance = readInstanceFile();
    if (instance === null) {
      console.error('No running Hot Sheet instance found.');
      process.exit(1);
    }

    const running = await isInstanceRunning(instance.port);
    if (!running) {
      console.error('Hot Sheet instance is not responding. It may have exited unexpectedly.');
      process.exit(1);
    }

    await handleList(instance.port);
    process.exit(0);
  }

  return false;
}

/**
 * Initialize the project: data directory, gitignore, DB, cleanup, lock.
 * Returns the initialized database instance.
 */
async function initializeProject(dataDir: string, demo: number | null): Promise<PGlite> {
  mkdirSync(dataDir, { recursive: true });

  if (demo === null) {
    // HS-8706 — reaching here means `main` → `handleExistingInstance` already
    // proved no live, responsive Hot Sheet instance exists (a real one holds
    // the global instance file + answers its port, and finding one makes this
    // process JOIN it and exit before we get here). So any leftover
    // `hotsheet.lock` is orphaned (a SIGKILL'd instance whose PID the OS
    // recycled). `reclaimUnverified` reclaims it instead of letting `acquireLock`
    // mistake the recycled PID for a live instance and silently `process.exit(1)`
    // — the GUI-splash hang traced in HS-8704. The phase marker pins a lock-exit
    // to this exact step in the durable startup log.
    // HS-8706 — wait for a previous instance that is mid-shutdown to release
    // the lock instead of FATAL-exiting instantly. Quitting Hot Sheet runs a
    // graceful shutdown whose snapshot + DB-close phases block for seconds and
    // only release `hotsheet.lock` at the very end; a relaunch landing in that
    // window used to die here (lock held by the still-alive draining process)
    // and hang the splash — the "every other launch fails" the user saw. Safe:
    // the holder only frees the lock AFTER closing the DB, so we never open the
    // cluster concurrently. See `acquireLockWaitingForShutdown`.
    startupMark('init-project: acquiring lock');
    await acquireLockWaitingForShutdown(dataDir, { reclaimUnverified: true });
    ensureGitignore(process.cwd());
  }

  // HS-8704 — the DB init below is the only UNBOUNDED await on the pre-server
  // path (PGLite open / integrity-probe / §73 snapshot auto-restore), so it's
  // the prime hang suspect. Marking it on either side pins the stall to this
  // phase in the persisted startup log.
  startupMark('init-project: initializing DB');
  setDataDir(dataDir);
  const db = await getDb();
  startupMark('init-project: DB ready');

  if (demo !== null) {
    await seedDemoData(demo);
  }

  if (demo === null) {
    const { runWithDataDir } = await import('./db/connection.js');
    // Migrate project settings from DB to settings.json (idempotent)
    startupMark('init-project: migrating settings');
    const { migrateDbSettingsToFile } = await import('./migrate-settings.js');
    await runWithDataDir(dataDir, () => migrateDbSettingsToFile(dataDir));
    startupMark('init-project: cleaning up attachments');
    await runWithDataDir(dataDir, () => cleanupAttachments(dataDir));
    // HS-8154 — telemetry retention sweep. No-op when telemetry hasn't
    // been used (the tables exist but stay empty). HS-8607 — sweep every
    // registered project, not just the launched one: all telemetry shares
    // the primary DB keyed by `project_secret`, so each project's rows are
    // pruned by its own secret + retention window. No `runWithDataDir`
    // wrapper — `cleanupAllProjectsTelemetry` resolves the shared DB via
    // `getTelemetryDb()` itself.
    await cleanupAllProjectsTelemetry(dataDir);
    startupMark('init-project: done');
  }

  console.log(`  Data directory: ${dataDir}`);
  return db;
}

/**
 * Start the server and configure secrets, markdown sync, skills.
 * Returns the actual port and secret.
 */
async function startAndConfigure(port: number, dataDir: string, strictPort: boolean, bind?: string): Promise<{ actualPort: number; secret: string }> {
  const actualPort = await startServer(port, dataDir, { noOpen: true, strictPort, bind });
  const secret = ensureSecret(dataDir, actualPort);
  // HS-9002 — relocate machine-local keys (backupDir, port, allow-rules, …) from
  // a committed settings.json into the gitignored settings.local.json. Idempotent.
  migrateLocalScopedKeys(dataDir);

  // HS-8308 — best-effort macOS QoS bump so keystroke handling stays
  // responsive while heavy work (e.g. tests inside the embedded terminal)
  // competes for CPU. macOS-only; no-op on Linux/Windows. See
  // src/processPriority.ts for rationale + cross-platform notes.
  const { bumpProcessPriorityBestEffort } = await import('./processPriority.js');
  bumpProcessPriorityBestEffort();

  // HS-8054 v3 — server-side event-loop heartbeat. Detects Node-process
  // blocks ≥ 100 ms and appends them to `<dataDir>/freeze.log` next to the
  // client-detected entries POSTed via `/api/diagnostics/freeze`. Single
  // file, paste-ready, lets us see whether the freeze the user reports
  // is in the browser, the Node process, or neither (which would point
  // at the WS / PTY layer the user suspected on 2026-05-04).
  const { startServerEventLoopHeartbeat, onServerWake } = await import('./diagnostics/freezeLogger.js');
  startServerEventLoopHeartbeat(dataDir);
  // HS-8726 (load resilience, docs/75 §75.6 Phase 4) — on resume from a system
  // suspend, open the scheduler's post-wake stagger window so every project's
  // overdue periodic timers (backups / snapshots / GC) drain gently instead of
  // firing as a thundering herd into a just-woken machine.
  const { getBackgroundScheduler } = await import('./scheduler/backgroundScheduler.js');
  onServerWake(() => { getBackgroundScheduler().noteWake(); });

  initMarkdownSync(dataDir, actualPort);
  scheduleAllSync(dataDir);

  const { runWithDataDir: runWith } = await import('./db/connection.js');
  initSkills(actualPort);
  // HS-8910 — capture the launched project's categories and pass them explicitly
  // to `ensureSkillsForDir` below, so generation can't fall back to a stale global.
  const launchedCategories = await runWith(dataDir, () => getCategories());
  setSkillCategories(launchedCategories);
  // HS-8706 — derive the project root from `dataDir` instead of the old
  // cwd-keyed skill installer. On a GUI launch the
  // Tauri shell spawns this sidecar with `cwd = /`, so `process.cwd()` pointed
  // at the filesystem root: `ensureClaudeSkills` then tried `mkdirSync('/.claude')`,
  // which throws `ENOENT` and the unhandled rejection FATAL-exited the server
  // right after `starting server` — wedging the "Starting Hot Sheet…" splash
  // forever. A direct-from-terminal launch happened to work only because its
  // cwd was the project root. `registerProject` was already fixed the same way
  // under HS-8486; this is the matching fix for the PRIMARY startup path.
  const projectRoot = resolve(dataDir).replace(/\/\.hotsheet\/?$/, '');
  // HS-8706 — best-effort. Skill-file installation must never be able to abort
  // startup: a write failure here (bad path, read-only fs, permissions) is a
  // missing convenience, not a reason to kill an already-listening server.
  try {
    const updatedPlatforms = ensureSkillsForDir(projectRoot, launchedCategories);
    if (updatedPlatforms.length > 0) {
      console.log(`\n  AI tool skills created/updated for: ${updatedPlatforms.join(', ')}`);
      console.log('  Restart your AI tool to pick up the new ticket creation skills.\n');
    }
  } catch (e: unknown) {
    console.warn(`  [skills] Failed to install AI tool skills: ${getErrorMessage(e)}`);
  }

  // Load plugins (non-critical, feature-flagged)
  if (PLUGINS_ENABLED) {
    import('./plugins/loader.js').then(({ loadAllPlugins }) => loadAllPlugins())
      // HS-8933 — once plugins are loaded, start scheduled auto-sync for every
      // registered project per its configured interval (default 15 min). Runs
      // server-side so it doesn't depend on a client being connected.
      .then(() => import('./plugins/syncEngine.js').then(({ scheduleSyncsForAllProjects }) => scheduleSyncsForAllProjects()))
      .catch((e: unknown) => console.warn(`[plugins] Failed to load plugins: ${getErrorMessage(e)}`));
  }

  // Non-critical background tasks
  runWith(dataDir, () => import('./db/commandLog.js').then(({ pruneLog }) => pruneLog(1000))).catch(() => { /* non-critical */ });
  runWith(dataDir, () => import('./db/stats.js').then(async ({ recordDailySnapshot, backfillSnapshots }) => {
    await backfillSnapshots();
    await recordDailySnapshot();
  })).catch(() => { /* non-critical */ });

  return { actualPort, secret };
}

/**
 * Post-startup tasks: backup scheduling, project restore, instance file, browser open.
 */
async function postStartup(dataDir: string, actualPort: number, demo: number | null, noOpen: boolean): Promise<void> {
  if (demo === null) {
    startupMark('post-startup: init backup scheduler');
    initBackupScheduler(dataDir);
    startupMark('post-startup: init snapshot scheduler');
    initSnapshotScheduler(dataDir);
    startupMark('post-startup: add to project list');
    addToProjectList(dataDir);
    startupMark('post-startup: restoring previous projects');
    await restorePreviousProjects(dataDir, actualPort);
    // HS-8874 — one-time, non-destructive per-project telemetry migration. Runs
    // AFTER projects are registered (so the secret→dataDir map is complete) but
    // before serving heavy traffic. Best-effort + self-guarded by the
    // `telemetryMigratedV1` config flag — a failure must never block startup.
    startupMark('post-startup: migrating per-project telemetry');
    try {
      const { migratePerProjectTelemetry } = await import('./db/telemetryMigration.js');
      await migratePerProjectTelemetry();
    } catch (e: unknown) {
      console.warn(`[startup] Per-project telemetry migration failed (non-fatal): ${getErrorMessage(e)}`);
    }
    // HS-8884 — reclaim telemetry-DB disk left bloated by retention deletes
    // (§67.6) + the migration's source-deletes (HS-8885). PGLite doesn't return
    // disk on DELETE, so a VACUUM pass is needed. This only SUBMITS jobs to the
    // §75 scheduler (off the main loop, GC priority, deferred under lag,
    // size-gated + throttled) — it must never run VACUUM FULL synchronously here,
    // which would wedge startup. Fire-and-forget: the jobs drain in the
    // background while the server serves.
    startupMark('post-startup: scheduling telemetry vacuum');
    try {
      const { scheduleTelemetryMaintenance } = await import('./db/telemetryVacuum.js');
      // Fire-and-forget: the jobs drain in the background; we don't await them.
      void scheduleTelemetryMaintenance(dataDir);
    } catch (e: unknown) {
      console.warn(`[startup] Scheduling telemetry vacuum failed (non-fatal): ${getErrorMessage(e)}`);
    }
    // HS-8888 (§85.2.4) — log a per-table row+size breakdown for each telemetry
    // DB so we can confirm which table dominates (HS-8882 suspected spans). Also
    // off-loop via the §75 scheduler (the DBs were just opened by the retention
    // sweep, so the COUNTs are cache-cheap); never blocks startup.
    startupMark('post-startup: scheduling telemetry breakdown log');
    try {
      const { scheduleTelemetryBreakdownLog } = await import('./db/telemetryDiagnostics.js');
      void scheduleTelemetryBreakdownLog(dataDir);
    } catch (e: unknown) {
      console.warn(`[startup] Scheduling telemetry breakdown log failed (non-fatal): ${getErrorMessage(e)}`);
    }
    // HS-8889 (§85.2.1) — periodic 24h retention sweep so a long-lived session
    // doesn't accumulate telemetry rows unbounded between restarts. Off-loop via
    // the §75 scheduler; the timer is `unref`'d and cleared on shutdown.
    startupMark('post-startup: starting telemetry retention timer');
    try {
      const { startTelemetryRetentionTimer } = await import('./telemetryRetentionTimer.js');
      startTelemetryRetentionTimer(dataDir);
    } catch (e: unknown) {
      console.warn(`[startup] Starting telemetry retention timer failed (non-fatal): ${getErrorMessage(e)}`);
    }
    // HS-8862 — periodic claim-lease expiry sweep (docs/90 §90.2.2). Surfaces +
    // tidies dead-worker claims; correctness already holds via lazy reclaim.
    try {
      const { startLeaseSweepTimer } = await import('./claims/leaseSweepTimer.js');
      startLeaseSweepTimer(dataDir);
    } catch (e: unknown) {
      console.warn(`[startup] Starting claim-lease sweep timer failed (non-fatal): ${getErrorMessage(e)}`);
    }
    startupMark('post-startup: migrating global config');
    await migrateGlobalConfig();
    startupMark('post-startup: cleaning up stale channels');
    await cleanupStaleChannels();
    startupMark('post-startup: setting up skills and channels');
    await setupSkillsAndChannels(actualPort);
    startupMark('post-startup: setting up instance lifecycle');
    await setupInstanceLifecycle(actualPort);
    startupMark('post-startup: done');
  }

  if (!noOpen) {
    const url = `http://localhost:${actualPort}`;
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execFile(openCmd, [url]);
  }
}

/** Restore projects from the previous session's project list.
 *
 * Load resilience (epic HS-8722, docs/75) — each prior project is registered through
 * the central background scheduler instead of a bare serial `await` loop. The
 * old loop fanned PGLite WASM init + the §73 snapshot integrity probe +
 * backup/snapshot schedulers + git watchers + eager terminals back-to-back onto
 * the single event loop; with a real-world list (the reporter had 9 projects)
 * that saturated the loop for ~3 minutes on every launch, so the already-
 * listening server never became responsive — the HS-8721 freeze, on the one
 * code path the load-resilience epic never migrated onto the scheduler. The
 * scheduler caps concurrency (2) and honors event-loop-lag backpressure
 * (`deferUnderLag`), so the loop keeps breathing and the UI is reachable while
 * projects fill in progressively; each tab surfaces (`notifyChange`) the moment
 * its registration lands. We still await all registrations before returning so
 * the downstream post-startup steps (channel + skills setup) see every project.
 */
export async function restorePreviousProjects(dataDir: string, actualPort: number): Promise<void> {
  const previousProjects = readProjectList();
  const absDataDir = resolve(dataDir);

  const { eagerSpawnTerminals } = await import('./terminals/eagerSpawn.js');
  const { getBackgroundScheduler, PRIORITY } = await import('./scheduler/backgroundScheduler.js');
  const { notifyChange } = await import('./routes/notify.js');
  const scheduler = getBackgroundScheduler();

  // Track which dirs registered successfully so the surviving list can be
  // rebuilt in the ORIGINAL list order — restore jobs complete out of order, so
  // we must not derive tab order from completion order.
  const registeredOk = new Set<string>();

  await Promise.all(previousProjects.map(prevDir => {
    if (prevDir === absDataDir) return Promise.resolve(); // primary already registered
    if (!existsSync(prevDir)) return Promise.resolve();   // dropped from the list below
    return scheduler.submit({
      key: `project-restore:${prevDir}`,
      projectKey: prevDir,
      priority: PRIORITY.PROJECT_RESTORE,
      // deferUnderLag MUST be false: restore is user-visible work that has to
      // make progress. Deferring it under lag starves it — and each restore job
      // itself spikes lag (PGLite WASM init), so a true `deferUnderLag` makes
      // the whole restore crawl (observed: 403s for 8 projects).
      deferUnderLag: false,
      run: async () => {
        const t0 = Date.now();
        startupLog(`[restore-timing] START ${prevDir}`);
        try {
          const ctx = await registerProject(prevDir, actualPort);
          registeredOk.add(prevDir);
          // Eager-spawn non-lazy terminals for each restored project (HS-6310).
          eagerSpawnTerminals(ctx.secret, prevDir);
          // Surface the newly-restored project's tab as soon as it lands.
          notifyChange();
          startupLog(`[restore-timing] ${prevDir} registered in ${String(Date.now() - t0)}ms`);
        } catch (e: unknown) {
          console.warn(`[startup] Failed to restore project ${prevDir}: ${getErrorMessage(e)}`);
        }
      },
    });
  }));

  // Rebuild the surviving project list in original order (primary always kept).
  const validProjects = previousProjects.filter(
    prevDir => prevDir === absDataDir || registeredOk.has(prevDir),
  );

  if (validProjects.length !== previousProjects.length) {
    const { reorderProjectList } = await import('./project-list.js');
    reorderProjectList(validProjects);
  }

  // Reorder in-memory Map to match persisted list order
  if (validProjects.length > 1) {
    const { getProjectByDataDir: getByDir, reorderProjects: reorder } = await import('./projects.js');
    const secrets = validProjects
      .map(dir => getByDir(dir)?.secret)
      .filter((s): s is string => s !== undefined);
    if (secrets.length > 1) reorder(secrets);
    notifyChange();
  }
}

/** One-time migration: read channelEnabled from first project's DB if not set globally.
 *
 * **HS-8492 (2026-05-22) — new-install default flipped to `true`.** Pre-fix the
 * fallback when neither the global config nor the legacy per-project DB had
 * an explicit value was `false` (channel disabled by default for new
 * installs). Post-fix the fallback is `true` — for genuinely first-run users
 * (no legacy `channel_enabled` value in the DB at all) the channel is on by
 * default. Existing users who had previously booted with the pre-HS-8492
 * migration ARE NOT AFFECTED: they already have a value persisted in their
 * global `~/.hotsheet/config.json` (the migration ran once at first boot
 * with the old code), so the `if (channelEnabled === undefined)` guard
 * above skips them. Only genuinely first-run installs hit this new
 * default. Existing users with `channel_enabled = 'false'` in the legacy
 * DB still have that value preserved through the migration. */
export async function migrateGlobalConfig(): Promise<void> {
  const { readGlobalConfig, writeGlobalConfig } = await import('./global-config.js');
  const globalConfig = readGlobalConfig();
  if (globalConfig.channelEnabled === undefined) {
    const { getSettings } = await import('./db/queries.js');
    const settings = await getSettings();
    const legacy = settings.channel_enabled;
    let channelEnabled: boolean;
    if (legacy === 'true') channelEnabled = true;
    else if (legacy === 'false') channelEnabled = false;
    else channelEnabled = true; // HS-8492 — new install default (no legacy value at all)
    writeGlobalConfig({ channelEnabled });
  }
}

/** Clean up stale channel servers from previous sessions. */
async function cleanupStaleChannels(): Promise<void> {
  const { cleanupStaleChannel } = await import('./channel-config.js');
  const { getAllProjects } = await import('./projects.js');
  for (const p of getAllProjects()) {
    await cleanupStaleChannel(p.dataDir);
  }
}

/** Ensure skills and .mcp.json are set up for all projects. */
async function setupSkillsAndChannels(port: number): Promise<void> {
  const { getAllProjects, ensureSkillsForAllProjects } = await import('./projects.js');
  // HS-8910 — generate each project's skills against its OWN categories, not the
  // process-global (which would leak one project's custom categories everywhere).
  await ensureSkillsForAllProjects();
  const { readGlobalConfig } = await import('./global-config.js');
  if (readGlobalConfig().channelEnabled === true) {
    const { registerChannelForAll } = await import('./channel-config.js');
    registerChannelForAll(getAllProjects().map(p => p.dataDir));
    // Install/update Claude Code heartbeat hook for busy state detection
    const { installHeartbeatHook } = await import('./claude-hooks.js');
    installHeartbeatHook(port);
  }
}

/** Ensure Claude Code hooks are installed when joining a running instance.
 *  The full hook installation only runs during primary startup (setupSkillsAndChannels),
 *  so this lightweight check covers the join path. */
async function ensureHooksForRunningInstance(port: number): Promise<void> {
  try {
    const { readGlobalConfig } = await import('./global-config.js');
    if (readGlobalConfig().channelEnabled === true) {
      const { installHeartbeatHook } = await import('./claude-hooks.js');
      installHeartbeatHook(port);
    }
  } catch { /* non-critical */ }
}

/**
 * HS-7934 — pure factory for the SIGINT/SIGTERM handler used by
 * `setupInstanceLifecycle` below. Exported so a unit test can prove the
 * single-signal happy path + double-signal escalation contract without
 * spawning a real child process. The runtime hooks are passed in
 * (`runShutdown`, `exit`, `setImmediate`, `log`) so a test can substitute
 * synchronous doubles + count calls.
 *
 * Contract:
 *   1. First signal → `runShutdown(signal)`. After it resolves, schedule
 *      `exit(0)` via `setImmediate` so any pending signal-handler queue
 *      drains first (the SECOND signal might be one of those).
 *   2. Second signal observed before exit(0) fires → `exit(1)` immediately.
 */
export interface SignalHandlerHooks {
  runShutdown: (signal: 'SIGINT' | 'SIGTERM') => Promise<void>;
  exit: (code: number) => void;
  setImmediate: (fn: () => void) => void;
  log: (msg: string) => void;
}

export function createSignalHandler(hooks: SignalHandlerHooks): (signal: 'SIGINT' | 'SIGTERM') => Promise<void> {
  let signalCount = 0;
  return async (signal): Promise<void> => {
    signalCount += 1;
    if (signalCount > 1) {
      hooks.log(`[cli] received second ${signal} during shutdown — forcing exit(1)`);
      hooks.exit(1);
      return;
    }
    await hooks.runShutdown(signal);
    hooks.setImmediate(() => hooks.exit(0));
  };
}

/**
 * HS-8096: register SIGINT/SIGTERM handlers at the top of `main()`, BEFORE
 * the HTTP server starts listening. Pre-fix the handlers were installed
 * deep in `setupInstanceLifecycle` after the server was already serving
 * `/api/stats` — `lifecycle.e2e.test.ts`'s SIGINT test polls `/api/stats`
 * to detect readiness, then sends SIGINT, but the handler hadn't been
 * registered yet, so Node's default handler kicked in and the child
 * exited with 130 instead of 0. Calling `gracefulShutdown` before the
 * HTTP server is wired is safe — `lifecycle.ts::closeHttpServer` no-ops
 * when `httpServer === null`, and the rest of the pipeline is similarly
 * tolerant of half-initialised state.
 */
function registerSignalHandlersEarly(): void {
  // HS-8828 — the Tauri parent closes our stdout/stderr pipe ~300ms after it
  // SIGTERMs us on quit; a graceful shutdown that's still logging past that
  // point would otherwise hit an uncaught EPIPE and crash mid-checkpoint.
  // Swallow EPIPE so the pipeline finishes and the lockfile-removal exit
  // handler runs; re-surface any other stream error.
  ignoreBrokenPipe(process.stdout);
  ignoreBrokenPipe(process.stderr);

  const handler = createSignalHandler({
    runShutdown: async (signal) => {
      // HS-8828 — bracket the whole graceful pipeline with timing so a stuck
      // quit shows exactly how far it got. Pairs with `lifecycle.ts`'s
      // per-step trail (see `runStep`).
      console.error(`[cli] ${signal} received — starting graceful shutdown`);
      const startedAt = Date.now();
      const { gracefulShutdown } = await import('./lifecycle.js');
      await gracefulShutdown(signal);
      console.error(`[cli] graceful shutdown finished in ${String(Date.now() - startedAt)}ms — scheduling exit(0)`);
    },
    exit: (code) => {
      console.error(`[cli] process.exit(${String(code)})`);
      process.exit(code);
    },
    setImmediate: (fn) => { setImmediate(fn); },
    log: (m) => { console.error(m); },
  });
  process.on('SIGINT', () => { void handler('SIGINT'); });
  process.on('SIGTERM', () => { void handler('SIGTERM'); });
}

/** HS-8828 — swallow EPIPE on a writable std stream (broken pipe when the
 *  Tauri parent goes away during quit) so it doesn't crash an in-flight
 *  graceful shutdown. Any non-EPIPE stream error is re-surfaced. */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    console.error('[cli] stream error:', err);
  });
}

/** Write instance file and register exit cleanup handlers. */
async function setupInstanceLifecycle(actualPort: number): Promise<void> {
  writeInstanceFile(actualPort);
  // HS-7528: pre-import the registry so the synchronous `process.on('exit')`
  // handler can kill PTYs without waiting on an async import. Covers the
  // `process.exit()` path (e.g. `/api/shutdown`, stale-instance cleanup,
  // crashes). HS-8096 — the signal handlers themselves are registered
  // earlier in `main()` via `registerSignalHandlersEarly()` so a SIGINT
  // arriving between server-listening and post-startup completion still
  // hits the graceful pipeline.
  const { destroyAllTerminals } = await import('./terminals/registry.js');
  const cleanupInstance = (): void => {
    try { destroyAllTerminals(); } catch { /* already torn down */ }
    removeInstanceFile();
  };
  // HS-7931: synchronous exit handler stays as the lockfile-removal safety
  // net for paths the async pipeline didn't get to (uncaught exceptions,
  // explicit `process.exit()` from elsewhere).
  process.on('exit', () => { cleanupInstance(); });
}

/** Resolve demo mode: validate the scenario id and switch the data dir to a
 *  fresh temp directory. Process-exits with status 1 if the scenario id
 *  isn't recognized. */
function resolveDemoDataDir(demo: number): string {
  const scenario = DEMO_SCENARIOS.find(s => s.id === demo);
  if (!scenario) {
    console.error(`Unknown demo scenario: ${demo}`);
    console.error('Available scenarios:');
    for (const s of DEMO_SCENARIOS) {
      console.error(`  --demo:${s.id}  ${s.label}`);
    }
    process.exit(1);
  }
  console.log(`\n  DEMO MODE: ${scenario.label}\n`);
  return join(tmpdir(), `hotsheet-demo-${Date.now()}`);
}

/** HS-8104 — multi-project: detect an already-running Hot Sheet instance and
 *  either replace it (`--replace`), join it (default), or just register the
 *  current dataDir against it (`--no-open`). Returns `true` if the caller
 *  should NOT continue to fresh-startup (we joined or registered and are
 *  about to `process.exit`); `false` if we replaced the previous instance
 *  and should fall through to a fresh startup. Skipped entirely in demo mode. */
async function handleExistingInstance(
  dataDir: string,
  noOpen: boolean,
  replace: boolean,
): Promise<boolean> {
  startupMark('existing-instance: cleaning up stale instances');
  await cleanupStaleInstance();
  startupMark('existing-instance: stale cleanup done');

  const instance = readInstanceFile();
  if (instance === null) return false;

  startupMark(`existing-instance: checking if instance on port ${instance.port} is running`);
  const running = await isInstanceRunning(instance.port);
  startupMark(`existing-instance: instance check running=${running}`);
  // HS-8706 — when the instance isn't serving its port we fall through to a
  // fresh start. If a previous instance is still mid-shutdown (alive, port
  // wedged, lock not yet released), `acquireLockWaitingForShutdown` on the
  // init path waits for it to release the lock rather than colliding.
  if (!running) return false;

  if (replace) {
    startupMark(`existing-instance: --replace shutting down instance on port ${instance.port}`);
    await shutdownRunningInstance(instance.port);
    startupMark('existing-instance: --replace previous instance shut down');
    return false;
  }

  // Ensure Claude Code hooks are installed even when joining an existing
  // instance, since hook installation normally only happens during primary
  // startup.
  await ensureHooksForRunningInstance(instance.port);

  if (!noOpen) {
    await joinRunningInstance(instance.port, dataDir);
  } else {
    const absDataDir = resolve(dataDir);
    const res = await fetch(`http://localhost:${instance.port}/api/projects/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir: absDataDir }),
    });
    if (res.ok) {
      // HS-8567 — validate at the wire boundary.
      const rawJson: unknown = await res.json();
      const parsed = ProjectNameOnlySchema.safeParse(rawJson);
      const name = parsed.success ? parsed.data.name : 'unknown';
      // HS-8704 — LOAD-BEARING log line. The Tauri shell (`src-tauri/src/lib.rs`)
      // greps sidecar stdout for the exact substring `running instance on port `
      // and slices the port out after it to navigate the WebView off the
      // "Starting Hot Sheet…" splash when this process joined an existing
      // instance instead of starting its own. Reword this and the installed app
      // hangs on the splash forever. Pinned by `src/launchReadinessContract.test.ts`.
      console.log(`  Registered project "${name}" with running instance on port ${instance.port}`);
    } else {
      const rawErr: unknown = await res.json().catch(() => ({}));
      const errParsed = ErrorBodySchema.safeParse(rawErr);
      const errMsg = errParsed.success ? errParsed.data.error : undefined;
      console.error(`  Failed to register with running instance: ${errMsg ?? 'Unknown error'}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

async function main() {
  // HS-8921 — if launched with `--test`, point HOTSHEET_HOME at the isolated
  // test dir BEFORE anything resolves a global path. This must precede
  // `initStartupLog()` + `startEventLoopWatchdog` below so even the startup log
  // lands under `~/.hotsheet-test` and the real `~/.hotsheet` stays untouched.
  // (`parseArgs` re-applies it idempotently and sets the rest of the defaults.)
  maybeApplyTestModeHome(process.argv);

  // HS-8704 — open the persisted startup log FIRST so every phase marker below
  // survives a GUI launch (Dock / Spotlight), which has no terminal to print
  // to. See `src/startup-log.ts` for the full rationale.
  initStartupLog();
  startupMark('main: entered');

  // FOLLOW-UP-1 (load resilience) — arm the thread-based event-loop watchdog
  // FIRST so it covers the entire startup (the most wedge-prone window). Unlike
  // the diagnostic `createStartupWatchdog` below (main-loop timers that can't
  // fire while the loop is pinned), this runs on a worker thread and SIGKILLs a
  // genuinely-wedged process so it can't hold the port + locks forever. It logs
  // its FATAL line to the same durable startup log.
  startEventLoopWatchdog({ logPath: getStartupLogPath() });

  // HS-8096: install signal handlers before any HTTP listener can respond,
  // so a SIGINT arriving between `tryServe`'s listen-callback firing and
  // `setupInstanceLifecycle` completing still routes through gracefulShutdown
  // instead of hitting Node's default-handler exit-with-130.
  registerSignalHandlersEarly();

  // HS-8704 — escalating watchdog that NAMES the stuck phase. Pre-fix this was
  // a single 10s one-shot with no phase info, invisible on a GUI launch. Now
  // it keeps stamping the durable startup log (10s / 20s / 30s / then every
  // 30s) so a wedged launch points straight at the culprit phase.
  const watchdog = createStartupWatchdog({
    getElapsedMs: () => getElapsedMs(),
    getCurrentPhase,
    log: (m) => startupLog(m),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => { clearTimeout(h); },
  });
  watchdog.start();

  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { port, demo, forceUpdateCheck, noOpen, strictPort, replace, bind } = parsed;
  let { dataDir } = parsed;

  // HS-8934 — git-worktree follower: if this `.hotsheet/` points at an
  // authoritative owner, redirect ALL project-data resolution to it so launching
  // Hot Sheet from a worktree shares the owner's one ticket DB / instance
  // (docs/89-git-worktrees.md §89.1). A bad pointer is fatal (clear error) rather
  // than silently creating a fresh DB. Skipped for demo (its dataDir is set below).
  if (demo === null) {
    try {
      dataDir = resolveAuthoritativeDataDir(dataDir);
    } catch (e: unknown) {
      startupLog(`[fatal] ${getErrorMessage(e)}`);
      process.exit(1);
    }
  }

  startupMark('parsed args');

  await handleEarlyFlags(parsed);

  startupMark('checking for updates');
  await checkForUpdates(forceUpdateCheck);
  startupMark('update check done');

  if (demo !== null) {
    // HS-8612 — flag the process as demo so the page shell can stamp
    // `window.__HOTSHEET_DEMO__` and force the DOM terminal renderer. Set
    // before the server starts serving any page.
    setDemoMode(true);
    dataDir = resolveDemoDataDir(demo);
  } else {
    await handleExistingInstance(dataDir, noOpen, replace);
  }

  startupMark('initializing project');
  const db = await initializeProject(dataDir, demo);
  startupMark('project initialized');
  if (demo !== null) {
    writeFileSettings(dataDir, { appName: 'Hot Sheet Demo' });
  }
  startupMark('starting server');
  const { actualPort, secret } = await startAndConfigure(port, dataDir, strictPort, bind);
  startupMark(`server started on port ${actualPort}`);
  registerExistingProject(dataDir, secret, db);
  // Eager-spawn non-lazy terminals for the primary project (HS-6310).
  const { eagerSpawnTerminals } = await import('./terminals/eagerSpawn.js');
  eagerSpawnTerminals(secret, dataDir);
  startupMark('running post-startup tasks');
  await postStartup(dataDir, actualPort, demo, noOpen);
  startupMark('post-startup complete');

  watchdog.stop();
  startupMark('startup finished');

  // Multi-project demo: register additional projects after server is running
  if (demo !== null) {
    const { seedDemoExtraProjects } = await import('./demo.js');
    await seedDemoExtraProjects(demo, dataDir, actualPort);
  }
}

// HS-7934 / HS-8457 — only run `main()` when this file is the actual entry
// point. Without the guard, importing `cli.js` from a unit test (e.g. to
// grab `createSignalHandler`) triggers the full Hot Sheet startup + a
// process exit from inside the vitest worker. The check matches three
// invocation shapes:
//   1. Raw `node /path/to/cli.js` — argv[1] equals import.meta.url.
//   2. tsx `tsx src/cli.ts` — paths preserved, basename .ts match.
//   3. npm-installed CLI symlink (`npm install -g hotsheet` → `hotsheet`).
//      argv[1] is `/usr/local/bin/hotsheet` but import.meta.url resolves
//      to the real path `/usr/local/lib/node_modules/hotsheet/dist/cli.js`.
//      Resolve argv[1] through realpath to compare against the real path.
//
// Three historical failure modes this guards against — all silent exit 0:
//   - URL-reserved characters in the path (`/Applications/Hot Sheet.app/`)
//     — fixed by routing both sides through `pathToFileURL` for consistent
//     percent-encoding.
//   - npm global install symlink — fixed by the realpath branch below.
//   - tsx invocation — basename `/cli.ts` match.
export function computeIsEntryPoint(
  argv1: string | undefined,
  importMetaUrl: string,
  resolveRealpath: (p: string) => string = realpathSync,
): boolean {
  try {
    if (typeof argv1 !== 'string' || argv1 === '') return false;
    if (importMetaUrl === pathToFileURL(argv1).href) return true;
    // npm install -g hotsheet creates a symlink at /usr/local/bin/hotsheet
    // → /usr/local/lib/node_modules/hotsheet/dist/cli.js. argv[1] is the
    // symlink path; import.meta.url is the resolved real path. Resolve
    // argv[1] through realpath and retry the URL comparison.
    try {
      const real = resolveRealpath(argv1);
      if (real !== argv1 && importMetaUrl === pathToFileURL(real).href) return true;
    } catch { /* realpath throws if the path doesn't exist — fall through */ }
    // tsx normalises paths but keeps the .ts extension; allow basename match.
    return importMetaUrl.endsWith('/cli.ts') && argv1.endsWith('/cli.ts');
  } catch {
    return false;
  }
}

const isEntryPoint = computeIsEntryPoint(process.argv[1], import.meta.url);

if (isEntryPoint) {
  main().catch((err: unknown) => {
    // HS-8704 — a thrown error is a crash, not a hang, but it's just as
    // invisible on a GUI launch. Record the message in the durable startup
    // log (right after the last phase marker, so the timeline shows exactly
    // where it died) before dumping the full stack to stderr.
    startupLog(`[startup] FATAL: ${getErrorMessage(err)}`);
    console.error(err);
    process.exit(1);
  });
}
