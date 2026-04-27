import type { PGlite } from '@electric-sql/pglite';
import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { initBackupScheduler } from './backup.js';
import { cleanupAttachments } from './cleanup.js';
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

function printUsage() {
  console.log(`
hotsheet - Lightweight local project management

Usage:
  hotsheet [options]

Options:
  --port <number>          Port to run on (default: 4174)
  --data-dir <path>        Store data in an alternative location (default: .hotsheet/)
  --no-open                Don't open the browser on startup
  --strict-port            Fail if the requested port is in use (don't auto-select)
  --replace                Shut down any running Hot Sheet instance before starting
  --close                  Unregister the current project from the running instance
  --force                  Skip interactive confirmations (use with --close in CI / scripts)
  --list                   List all projects registered with the running instance
  --check-for-updates      Check for new versions now
  --help                   Show this help message

Examples:
  hotsheet
  hotsheet --port 8080
  hotsheet --data-dir ~/my-project/.hotsheet
  hotsheet --list
  hotsheet --close
  hotsheet --replace
`);
}

interface ParsedArgs {
  port: number;
  dataDir: string;
  demo: number | null;
  forceUpdateCheck: boolean;
  noOpen: boolean;
  strictPort: boolean;
  replace: boolean;
  close: boolean;
  /** HS-7596 — skip interactive prompts (`--close` quit-confirm, etc.) for
   *  use in CI / scripts. */
  force: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2);
  let port = 4174;
  let dataDir = join(process.cwd(), '.hotsheet');
  let demo: number | null = null;
  let forceUpdateCheck = false;
  let noOpen = false;
  let strictPort = false;
  let replace = false;
  let close = false;
  let force = false;
  let list = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--demo:')) {
      demo = parseInt(arg.slice(7), 10);
      if (isNaN(demo) || demo < 1) {
        console.error(`Invalid demo scenario: ${arg}`);
        process.exit(1);
      }
      continue;
    }
    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--port':
        port = parseInt(args[++i], 10);
        if (isNaN(port)) {
          console.error('Invalid port number');
          process.exit(1);
        }
        break;
      case '--data-dir':
        dataDir = resolve(args[++i]);
        break;
      case '--check-for-updates':
        forceUpdateCheck = true;
        break;
      case '--no-open':
        noOpen = true;
        break;
      case '--strict-port':
        strictPort = true;
        break;
      case '--replace':
        replace = true;
        break;
      case '--close':
        close = true;
        break;
      case '--force':
        force = true;
        break;
      case '--list':
        list = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return { port, dataDir, demo, forceUpdateCheck, noOpen, strictPort, replace, close, force, list };
}

/**
 * Shut down any running Hot Sheet instance and wait for its port to become free.
 * Used by --replace. No-op if no instance is running.
 */
async function shutdownRunningInstance(instancePort: number): Promise<void> {
  try {
    // Origin header bypasses the secret-mutation guard (same-origin localhost exemption).
    await fetch(`http://localhost:${instancePort}/api/shutdown`, {
      method: 'POST',
      headers: { 'Origin': `http://localhost:${instancePort}` },
    });
  } catch {
    // Connection error means the server is already gone — fine.
    return;
  }

  // Poll until the port stops responding (server has ~500ms between response and exit).
  const deadlineMs = Date.now() + 10_000;
  while (Date.now() < deadlineMs) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!(await isInstanceRunning(instancePort))) return;
  }
  throw new Error(`Running Hot Sheet instance on port ${instancePort} did not exit within 10s`);
}

/**
 * Handle --close: unregister the current project from a running instance.
 *
 * HS-7596 / §37 — when this project has alive terminals running non-exempt
 * processes, prompt the user to confirm before destroying them. Pass
 * `--force` to skip the prompt for non-interactive use (CI / scripts).
 */
async function handleClose(dataDir: string, force: boolean): Promise<void> {
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

  // Read the secret for this project's dataDir so we can unregister by secret
  const { readFileSettings } = await import('./file-settings.js');
  const settings = readFileSettings(dataDir);
  if (settings.secret === undefined || settings.secret === '') {
    console.error(`No project secret found in ${dataDir}/settings.json. Is this a Hot Sheet project directory?`);
    process.exit(1);
  }

  // HS-7596 / §37 — prompt before destroying terminals running non-exempt
  // processes. Skipped on --force (CI / scripts).
  if (!force) {
    const proceed = await confirmCloseAgainstQuitSummary(instance.port, settings.secret);
    if (!proceed) {
      console.log('  Cancelled.');
      process.exit(0);
    }
  }

  const res = await fetch(`http://localhost:${instance.port}/api/projects/${settings.secret}`, {
    method: 'DELETE',
  });

  if (res.ok) {
    console.log(`  Project unregistered from running instance.`);
  } else {
    const body = await res.json() as { error?: string };
    console.error(`  Failed to unregister: ${body.error ?? 'Unknown error'}`);
    process.exit(1);
  }
}

/**
 * HS-7596 / §37 — fetch /api/projects/quit-summary, filter to the project
 * being closed, apply the §37.5 logic, and prompt the user via stdin if
 * the prompt should fire. Returns true to proceed, false to abort.
 *
 * Errors fetching the summary fall through to "no prompt needed" — the
 * server may not yet have the route (older instance), and we don't want
 * --close to start failing for users on older servers.
 */
async function confirmCloseAgainstQuitSummary(port: number, secret: string): Promise<boolean> {
  let summary: { projects: Array<{
    secret: string; name: string;
    confirmMode: 'always' | 'never' | 'with-non-exempt-processes';
    entries: Array<{ terminalId: string; label: string; foregroundCommand: string; isShell: boolean; isExempt: boolean }>;
  }> };
  try {
    const res = await fetch(`http://localhost:${port}/api/projects/quit-summary`);
    if (!res.ok) return true;
    summary = await res.json() as typeof summary;
  } catch {
    return true;
  }
  const project = summary.projects.find(p => p.secret === secret);
  if (project === undefined) return true;

  if (project.confirmMode === 'never') return true;
  let entriesToShow: typeof project.entries;
  if (project.confirmMode === 'always') {
    entriesToShow = project.entries;
    if (entriesToShow.length === 0) {
      // 'always' fires unconditionally. Prompt with no list.
      return promptYesNo(`  Close project "${project.name}"? Quit-confirm is set to 'always'.`);
    }
  } else {
    // 'with-non-exempt-processes': only fire when at least one is non-exempt.
    entriesToShow = project.entries.filter(e => !e.isExempt);
    if (entriesToShow.length === 0) return true;
  }

  console.log(`  Project "${project.name}" has the following terminals running:`);
  for (const e of entriesToShow) {
    console.log(`    • ${e.label} (${e.foregroundCommand})`);
  }
  return promptYesNo('  Close anyway?');
}

/** Minimal y/n stdin prompt for the CLI. Defaults to 'no' on EOF / blank. */
function promptYesNo(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    process.stdout.write(`${message} [y/N] `);
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newlineIdx = buffered.indexOf('\n');
      if (newlineIdx === -1) return;
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      const line = buffered.slice(0, newlineIdx).trim().toLowerCase();
      resolve(line === 'y' || line === 'yes');
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/**
 * Handle --list: list all projects registered with the running instance.
 */
async function handleList(port: number): Promise<void> {
  const res = await fetch(`http://localhost:${port}/api/projects`);
  if (!res.ok) {
    console.error('Failed to fetch project list from running instance.');
    process.exit(1);
  }

  const projects = await res.json() as Array<{ name: string; dataDir: string; ticketCount: number }>;
  if (projects.length === 0) {
    console.log('  No projects registered.');
    return;
  }

  console.log(`\n  Registered projects (${projects.length}):\n`);
  for (const p of projects) {
    console.log(`    ${p.name}`);
    console.log(`      ${p.dataDir}  (${p.ticketCount} tickets)`);
  }
  console.log('');
}

/**
 * Register with a running instance, open browser, and exit.
 */
async function joinRunningInstance(port: number, dataDir: string): Promise<void> {
  const absDataDir = resolve(dataDir);

  const res = await fetch(`http://localhost:${port}/api/projects/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataDir: absDataDir }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    console.error(`  Failed to register with running instance: ${body.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const project = await res.json() as { name: string; secret: string };
  const url = `http://localhost:${port}?project=${project.secret}`;
  console.log(`\n  Joined running Hot Sheet instance on port ${port}`);
  console.log(`  Project: ${project.name}`);
  console.log(`  ${url}\n`);

  const openCmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  execFile(openCmd, [url]);
}

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

/** Write instance file and register exit cleanup handlers. */
async function setupInstanceLifecycle(actualPort: number): Promise<void> {
  writeInstanceFile(actualPort);
  // HS-7528: pre-import the registry so the synchronous `process.on('exit')`
  // handler can kill PTYs without waiting on an async import. Covers the
  // `process.exit()` path (e.g. `/api/shutdown`, stale-instance cleanup,
  // crashes) — the SIGINT / SIGTERM handlers below route through the async
  // `gracefulShutdown` pipeline (HS-7931) so PGLite gets a chance to
  // CHECKPOINT and remove `postmaster.pid` instead of leaving it stale for
  // HS-7888 to mop up on relaunch.
  const { destroyAllTerminals } = await import('./terminals/registry.js');
  const { gracefulShutdown } = await import('./lifecycle.js');
  const cleanupInstance = (): void => {
    try { destroyAllTerminals(); } catch { /* already torn down */ }
    removeInstanceFile();
  };
  // HS-7931: synchronous exit handler stays as the lockfile-removal safety
  // net for paths the async pipeline didn't get to (uncaught exceptions,
  // explicit `process.exit()` from elsewhere).
  process.on('exit', () => { cleanupInstance(); });

  // HS-7931: signal handlers route through `gracefulShutdown`. A SECOND
  // identical signal during the await escalates to `process.exit(1)` so a
  // hung close can't trap the user — they can always Ctrl-C twice to bail.
  let signalCount = 0;
  const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    signalCount += 1;
    if (signalCount > 1) {
      console.error(`[cli] received second ${signal} during shutdown — forcing exit(1)`);
      process.exit(1);
    }
    void gracefulShutdown(signal).then(() => process.exit(0));
  };
  process.on('SIGINT', () => { handleSignal('SIGINT'); });
  process.on('SIGTERM', () => { handleSignal('SIGTERM'); });
}

async function main() {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

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

  // Demo mode: use a fresh temp directory
  if (demo !== null) {
    const scenario = DEMO_SCENARIOS.find(s => s.id === demo);
    if (!scenario) {
      console.error(`Unknown demo scenario: ${demo}`);
      console.error('Available scenarios:');
      for (const s of DEMO_SCENARIOS) {
        console.error(`  --demo:${s.id}  ${s.label}`);
      }
      process.exit(1);
    }
    dataDir = join(tmpdir(), `hotsheet-demo-${Date.now()}`);
    console.log(`\n  DEMO MODE: ${scenario.label}\n`);
  }

  // Multi-project: check for an already-running instance (skip in demo mode)
  if (demo === null) {
    // Clean up stale instances (dead PID but port still occupied)
    console.error(`[startup ${elapsed()}] cleaning up stale instances...`);
    await cleanupStaleInstance();
    console.error(`[startup ${elapsed()}] stale cleanup done`);

    const instance = readInstanceFile();
    if (instance !== null) {
      console.error(`[startup ${elapsed()}] checking if instance on port ${instance.port} is running...`);
      const running = await isInstanceRunning(instance.port);
      console.error(`[startup ${elapsed()}] instance check: running=${running}`);
      if (running && replace) {
        console.error(`[startup ${elapsed()}] --replace: shutting down instance on port ${instance.port}...`);
        await shutdownRunningInstance(instance.port);
        console.error(`[startup ${elapsed()}] --replace: previous instance shut down`);
        // Fall through to fresh startup below.
      } else if (running) {
        // Ensure Claude Code hooks are installed even when joining an existing instance,
        // since hook installation normally only happens during primary startup.
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
    }
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

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
