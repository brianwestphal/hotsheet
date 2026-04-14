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
  --close                  Unregister the current project from the running instance
  --list                   List all projects registered with the running instance
  --check-for-updates      Check for new versions now
  --help                   Show this help message

Examples:
  hotsheet
  hotsheet --port 8080
  hotsheet --data-dir ~/my-project/.hotsheet
  hotsheet --list
  hotsheet --close
`);
}

interface ParsedArgs {
  port: number;
  dataDir: string;
  demo: number | null;
  forceUpdateCheck: boolean;
  noOpen: boolean;
  strictPort: boolean;
  close: boolean;
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
  let close = false;
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
      case '--close':
        close = true;
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

  return { port, dataDir, demo, forceUpdateCheck, noOpen, strictPort, close, list };
}

/**
 * Handle --close: unregister the current project from a running instance.
 */
async function handleClose(dataDir: string): Promise<void> {
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
    await handleClose(args.dataDir);
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

  setDataDir(dataDir);
  const db = await getDb();

  if (demo !== null) {
    await seedDemoData(demo);
  }

  if (demo === null) {
    const { runWithDataDir } = await import('./db/connection.js');
    await runWithDataDir(dataDir, () => cleanupAttachments());
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
  if (PLUGINS_ENABLED || process.env.PLUGINS_ENABLED === 'true') {
    import('./plugins/loader.js').then(({ loadAllPlugins }) => loadAllPlugins())
      .catch((e: unknown) => console.warn(`[plugins] Failed to load plugins: ${e instanceof Error ? e.message : String(e)}`));
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
    addToProjectList(dataDir);
    await restorePreviousProjects(dataDir, actualPort);
    await migrateGlobalConfig();
    await cleanupStaleChannels();
    await setupSkillsAndChannels();
    setupInstanceLifecycle(actualPort);
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

  for (const prevDir of previousProjects) {
    if (prevDir === absDataDir) { validProjects.push(prevDir); continue; }
    if (!existsSync(prevDir)) continue;
    try {
      await registerProject(prevDir, actualPort);
      validProjects.push(prevDir);
    } catch (e: unknown) {
      console.warn(`[startup] Failed to restore project ${prevDir}: ${e instanceof Error ? e.message : String(e)}`);
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
async function setupSkillsAndChannels(): Promise<void> {
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
  }
}

/** Write instance file and register exit cleanup handlers. */
function setupInstanceLifecycle(actualPort: number): void {
  writeInstanceFile(actualPort);
  const cleanupInstance = () => removeInstanceFile();
  process.on('exit', cleanupInstance);
  process.on('SIGINT', () => { cleanupInstance(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupInstance(); process.exit(0); });
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { port, demo, forceUpdateCheck, noOpen, strictPort } = parsed;
  let { dataDir } = parsed;

  await handleEarlyFlags(parsed);

  await checkForUpdates(forceUpdateCheck);

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
    await cleanupStaleInstance();

    const instance = readInstanceFile();
    if (instance !== null) {
      const running = await isInstanceRunning(instance.port);
      if (running) {
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

  const db = await initializeProject(dataDir, demo);
  if (demo !== null) {
    writeFileSettings(dataDir, { appName: 'Hot Sheet Demo' });
  }
  const { actualPort, secret } = await startAndConfigure(port, dataDir, strictPort);
  registerExistingProject(dataDir, secret, db);
  await postStartup(dataDir, actualPort, demo, noOpen);

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
