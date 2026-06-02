import type { PGlite } from '@electric-sql/pglite';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { initBackupScheduler } from './backup.js';
import { cleanupAllProjectsTelemetry, cleanupAttachments } from './cleanup.js';
import { parseArgs, type ParsedArgs, printUsage } from './cli/args.js';
import { handleClose, handleList, joinRunningInstance, shutdownRunningInstance } from './cli/close.js';
import { getDb, setDataDir } from './db/connection.js';
import { getCategories } from './db/queries.js';
import { initSnapshotScheduler } from './db/snapshot.js';
import { DEMO_SCENARIOS, seedDemoData } from './demo.js';
import { setDemoMode } from './demo-mode.js';
import { enrichProcessPath } from './enrich-path.js';
import { PLUGINS_ENABLED } from './feature-flags.js';
import { ensureSecret, writeFileSettings } from './file-settings.js';
import { ensureGitignore } from './gitignore.js';
import { cleanupStaleInstance, isInstanceRunning, readInstanceFile, removeInstanceFile, writeInstanceFile } from './instance.js';
import { acquireLock } from './lock.js';
import { addToProjectList, readProjectList } from './project-list.js';
import { registerExistingProject, registerProject } from './projects.js';
import { ErrorBodySchema, ProjectNameOnlySchema } from './schemas.js';
import { startServer } from './server.js';
import { ensureSkills, initSkills, setSkillCategories } from './skills.js';
import { createStartupWatchdog, getCurrentPhase, getElapsedMs, initStartupLog, startupLog, startupMark } from './startup-log.js';
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
    acquireLock(dataDir);
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
    await runWithDataDir(dataDir, () => cleanupAttachments());
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
async function startAndConfigure(port: number, dataDir: string, strictPort: boolean): Promise<{ actualPort: number; secret: string }> {
  const actualPort = await startServer(port, dataDir, { noOpen: true, strictPort });
  const secret = ensureSecret(dataDir, actualPort);

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
  const { startServerEventLoopHeartbeat } = await import('./diagnostics/freezeLogger.js');
  startServerEventLoopHeartbeat(dataDir);

  initMarkdownSync(dataDir, actualPort);
  scheduleAllSync(dataDir);

  const { runWithDataDir: runWith } = await import('./db/connection.js');
  initSkills(actualPort);
  setSkillCategories(await runWith(dataDir, () => getCategories()));
  const updatedPlatforms = ensureSkills();
  if (updatedPlatforms.length > 0) {
    console.log(`\n  AI tool skills created/updated for: ${updatedPlatforms.join(', ')}`);
    console.log('  Restart your AI tool to pick up the new ticket creation skills.\n');
  }

  // Load plugins (non-critical, feature-flagged)
  if (PLUGINS_ENABLED) {
    import('./plugins/loader.js').then(({ loadAllPlugins }) => loadAllPlugins())
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
    initBackupScheduler(dataDir);
    initSnapshotScheduler(dataDir);
    addToProjectList(dataDir);
    startupMark('post-startup: restoring previous projects');
    await restorePreviousProjects(dataDir, actualPort);
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

/** Restore projects from the previous session's project list. */
async function restorePreviousProjects(dataDir: string, actualPort: number): Promise<void> {
  const previousProjects = readProjectList();
  const absDataDir = resolve(dataDir);
  const validProjects: string[] = [];

  const { eagerSpawnTerminals } = await import('./terminals/eagerSpawn.js');
  for (const prevDir of previousProjects) {
    if (prevDir === absDataDir) { validProjects.push(prevDir); continue; }
    if (!existsSync(prevDir)) continue;
    try {
      const ctx = await registerProject(prevDir, actualPort);
      validProjects.push(prevDir);
      // Eager-spawn non-lazy terminals for each restored project (HS-6310).
      eagerSpawnTerminals(ctx.secret, prevDir);
    } catch (e: unknown) {
      console.warn(`[startup] Failed to restore project ${prevDir}: ${getErrorMessage(e)}`);
    }
  }

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
    const { notifyChange } = await import('./routes/notify.js');
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
  const { getAllProjects } = await import('./projects.js');
  const { ensureSkillsForDir } = await import('./skills.js');
  for (const p of getAllProjects()) {
    const root = p.dataDir.replace(/\/.hotsheet\/?$/, '');
    ensureSkillsForDir(root);
  }
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
  const handler = createSignalHandler({
    runShutdown: async (signal) => {
      const { gracefulShutdown } = await import('./lifecycle.js');
      await gracefulShutdown(signal);
    },
    exit: (code) => process.exit(code),
    setImmediate: (fn) => { setImmediate(fn); },
    log: (m) => { console.error(m); },
  });
  process.on('SIGINT', () => { void handler('SIGINT'); });
  process.on('SIGTERM', () => { void handler('SIGTERM'); });
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
  // HS-8704 — open the persisted startup log FIRST so every phase marker below
  // survives a GUI launch (Dock / Spotlight), which has no terminal to print
  // to. See `src/startup-log.ts` for the full rationale.
  initStartupLog();
  startupMark('main: entered');

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

  const { port, demo, forceUpdateCheck, noOpen, strictPort, replace } = parsed;
  let { dataDir } = parsed;

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
  const { actualPort, secret } = await startAndConfigure(port, dataDir, strictPort);
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
