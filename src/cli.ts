import type { PGlite } from '@electric-sql/pglite';
import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { initBackupScheduler } from './backup.js';
import { cleanupAttachments } from './cleanup.js';
import { parseArgs, type ParsedArgs, printUsage } from './cli/args.js';
import { handleClose, handleList, joinRunningInstance, shutdownRunningInstance } from './cli/close.js';
import { getDb, setDataDir } from './db/connection.js';
import { getCategories } from './db/queries.js';
import { DEMO_SCENARIOS, seedDemoData } from './demo.js';
import { PLUGINS_ENABLED } from './feature-flags.js';
import { ensureSecret, writeFileSettings } from './file-settings.js';
import { ensureGitignore } from './gitignore.js';
import { cleanupStaleInstance, isInstanceRunning, readInstanceFile, removeInstanceFile, writeInstanceFile } from './instance.js';
import { acquireLock } from './lock.js';
import { addToProjectList, readProjectList } from './project-list.js';
import { registerExistingProject, registerProject } from './projects.js';
import { startServer } from './server.js';
import { ensureSkills, initSkills, setSkillCategories } from './skills.js';
import { initMarkdownSync, scheduleAllSync } from './sync/markdown.js';
import { checkForUpdates } from './update-check.js';
import { getErrorMessage } from './utils/errorMessage.js';

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
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  mkdirSync(dataDir, { recursive: true });

  if (demo === null) {
    acquireLock(dataDir);
    ensureGitignore(process.cwd());
  }

  console.error(`[init-project ${elapsed()}] initializing DB...`);
  setDataDir(dataDir);
  const db = await getDb();
  console.error(`[init-project ${elapsed()}] DB ready`);

  if (demo !== null) {
    await seedDemoData(demo);
  }

  if (demo === null) {
    const { runWithDataDir } = await import('./db/connection.js');
    // Migrate project settings from DB to settings.json (idempotent)
    console.error(`[init-project ${elapsed()}] migrating settings...`);
    const { migrateDbSettingsToFile } = await import('./migrate-settings.js');
    await runWithDataDir(dataDir, () => migrateDbSettingsToFile(dataDir));
    console.error(`[init-project ${elapsed()}] cleaning up attachments...`);
    await runWithDataDir(dataDir, () => cleanupAttachments());
    console.error(`[init-project ${elapsed()}] done`);
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
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  if (demo === null) {
    initBackupScheduler(dataDir);
    addToProjectList(dataDir);
    console.error(`[post-startup ${elapsed()}] restoring previous projects...`);
    await restorePreviousProjects(dataDir, actualPort);
    console.error(`[post-startup ${elapsed()}] migrating global config...`);
    await migrateGlobalConfig();
    console.error(`[post-startup ${elapsed()}] cleaning up stale channels...`);
    await cleanupStaleChannels();
    console.error(`[post-startup ${elapsed()}] setting up skills and channels...`);
    await setupSkillsAndChannels(actualPort);
    console.error(`[post-startup ${elapsed()}] setting up instance lifecycle...`);
    await setupInstanceLifecycle(actualPort);
    console.error(`[post-startup ${elapsed()}] done`);
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

/** One-time migration: read channelEnabled from first project's DB if not set globally. */
async function migrateGlobalConfig(): Promise<void> {
  const { readGlobalConfig, writeGlobalConfig } = await import('./global-config.js');
  const globalConfig = readGlobalConfig();
  if (globalConfig.channelEnabled === undefined) {
    const { getSettings } = await import('./db/queries.js');
    const settings = await getSettings();
    const legacy = settings.channel_enabled === 'true';
    writeGlobalConfig({ channelEnabled: legacy });
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
 *  isn't recognised. */
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
  elapsed: () => string,
): Promise<boolean> {
  console.error(`[startup ${elapsed()}] cleaning up stale instances...`);
  await cleanupStaleInstance();
  console.error(`[startup ${elapsed()}] stale cleanup done`);

  const instance = readInstanceFile();
  if (instance === null) return false;

  console.error(`[startup ${elapsed()}] checking if instance on port ${instance.port} is running...`);
  const running = await isInstanceRunning(instance.port);
  console.error(`[startup ${elapsed()}] instance check: running=${running}`);
  if (!running) return false;

  if (replace) {
    console.error(`[startup ${elapsed()}] --replace: shutting down instance on port ${instance.port}...`);
    await shutdownRunningInstance(instance.port);
    console.error(`[startup ${elapsed()}] --replace: previous instance shut down`);
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
      const project = await res.json() as { name: string };
      console.log(`  Registered project "${project.name}" with running instance on port ${instance.port}`);
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      console.error(`  Failed to register with running instance: ${body.error ?? 'Unknown error'}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

async function main() {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  // HS-8096: install signal handlers before any HTTP listener can respond,
  // so a SIGINT arriving between `tryServe`'s listen-callback firing and
  // `setupInstanceLifecycle` completing still routes through gracefulShutdown
  // instead of hitting Node's default-handler exit-with-130.
  registerSignalHandlersEarly();

  // Watchdog: dump diagnostic if startup takes too long
  const watchdog = setTimeout(() => {
    console.error(`[startup] WARNING: startup has taken ${elapsed()} — still not ready`);
    console.error('[startup] This may indicate a hang in DB init, network check, or project restore.');
    console.error('[startup] Check the timing logs above to identify the stuck phase.');
  }, 10_000);

  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { port, demo, forceUpdateCheck, noOpen, strictPort, replace } = parsed;
  let { dataDir } = parsed;

  console.error(`[startup ${elapsed()}] parsed args`);

  await handleEarlyFlags(parsed);

  console.error(`[startup ${elapsed()}] checking for updates...`);
  await checkForUpdates(forceUpdateCheck);
  console.error(`[startup ${elapsed()}] update check done`);

  if (demo !== null) {
    dataDir = resolveDemoDataDir(demo);
  } else {
    await handleExistingInstance(dataDir, noOpen, replace, elapsed);
  }

  console.error(`[startup ${elapsed()}] initializing project...`);
  const db = await initializeProject(dataDir, demo);
  console.error(`[startup ${elapsed()}] project initialized`);
  if (demo !== null) {
    writeFileSettings(dataDir, { appName: 'Hot Sheet Demo' });
  }
  console.error(`[startup ${elapsed()}] starting server...`);
  const { actualPort, secret } = await startAndConfigure(port, dataDir, strictPort);
  console.error(`[startup ${elapsed()}] server started on port ${actualPort}`);
  registerExistingProject(dataDir, secret, db);
  // Eager-spawn non-lazy terminals for the primary project (HS-6310).
  const { eagerSpawnTerminals } = await import('./terminals/eagerSpawn.js');
  eagerSpawnTerminals(secret, dataDir);
  console.error(`[startup ${elapsed()}] running post-startup tasks...`);
  await postStartup(dataDir, actualPort, demo, noOpen);
  console.error(`[startup ${elapsed()}] post-startup complete`);

  clearTimeout(watchdog);
  console.error(`[startup ${elapsed()}] startup finished`);

  // Multi-project demo: register additional projects after server is running
  if (demo !== null) {
    const { seedDemoExtraProjects } = await import('./demo.js');
    await seedDemoExtraProjects(demo, dataDir, actualPort);
  }
}

// HS-7934 — only run `main()` when this file is the actual entry point.
// Without the guard, importing `cli.js` from a unit test (e.g. to grab
// `createSignalHandler`) triggers the full Hot Sheet startup + a process
// exit from inside the vitest worker. The check matches both raw `node`
// invocation and `tsx` (which preserves `process.argv[1]`).
const isEntryPoint = (() => {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry === '') return false;
    const url = import.meta.url;
    if (url === `file://${entry}`) return true;
    // tsx normalises paths but keeps the .ts extension; allow basename match.
    return url.endsWith('/cli.ts') && entry.endsWith('/cli.ts');
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
