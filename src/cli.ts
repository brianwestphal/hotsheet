import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { initBackupScheduler } from './backup.js';
import { cleanupAttachments } from './cleanup.js';
import { getDb, setDataDir } from './db/connection.js';
import { getCategories } from './db/queries.js';
import { DEMO_SCENARIOS, seedDemoData } from './demo.js';
import { ensureSecret } from './file-settings.js';
import { ensureGitignore } from './gitignore.js';
import { isInstanceRunning, readInstanceFile, removeInstanceFile, writeInstanceFile } from './instance.js';
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

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { port, demo, forceUpdateCheck, noOpen, strictPort, close, list } = parsed;
  let { dataDir } = parsed;

  // Handle --close: unregister current project from running instance and exit
  if (close) {
    await handleClose(dataDir);
    process.exit(0);
  }

  // Handle --list: list projects registered with running instance and exit
  if (list) {
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
    dataDir = join(tmpdir(), `hotsheet-demo-${demo}-${Date.now()}`);
    console.log(`\n  DEMO MODE: ${scenario.label}\n`);
  }

  // Multi-project: check for an already-running instance (skip in demo mode)
  if (demo === null) {
    const instance = readInstanceFile();
    if (instance !== null) {
      const running = await isInstanceRunning(instance.port);
      if (running) {
        // Another instance is already running — register this project and open browser
        if (!noOpen) {
          await joinRunningInstance(instance.port, dataDir);
        } else {
          // --no-open: just register, don't open browser
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

  // Ensure data directory exists
  mkdirSync(dataDir, { recursive: true });

  if (demo === null) {
    // Prevent multiple instances from corrupting the database
    acquireLock(dataDir);
    // Check .gitignore only for real projects
    ensureGitignore(process.cwd());
  }

  // Initialize database
  setDataDir(dataDir);
  const db = await getDb();

  if (demo !== null) {
    await seedDemoData(demo);
  }

  if (demo === null) {
    // Clean up old attachments only for real projects
    await cleanupAttachments();
  }

  console.log(`  Data directory: ${dataDir}`);

  // Start the server without opening the browser — we open it after all projects are restored
  const actualPort = await startServer(port, dataDir, { noOpen: true, strictPort });

  // Generate/validate the API secret and write port to settings.json for AI tool consumption
  const secret = ensureSecret(dataDir, actualPort);

  // Initialize markdown sync with the actual port (may differ if requested port was in use)
  initMarkdownSync(dataDir, actualPort);
  scheduleAllSync(dataDir);

  // Initialize and sync AI tool skills/rules
  initSkills(actualPort, dataDir);
  setSkillCategories(await getCategories());
  const updatedPlatforms = ensureSkills();
  if (updatedPlatforms.length > 0) {
    console.log(`\n  AI tool skills created/updated for: ${updatedPlatforms.join(', ')}`);
    console.log('  Restart your AI tool to pick up the new ticket creation skills.\n');
  }

  // Prune command log to keep it manageable
  import('./db/commandLog.js').then(({ pruneLog }) => pruneLog(1000)).catch(() => { /* non-critical */ });

  // Record daily stats snapshot and backfill any missing days
  import('./db/stats.js').then(async ({ recordDailySnapshot, backfillSnapshots }) => {
    await backfillSnapshots();
    await recordDailySnapshot();
  }).catch(() => { /* non-critical */ });

  if (demo === null) {
    initBackupScheduler(dataDir);
  }

  // Register this project in the multi-project registry so the server
  // middleware can resolve it by secret for API requests.
  registerExistingProject(dataDir, secret, db);

  // Write instance file so subsequent invocations can join this instance
  if (demo === null) {
    // Persist this project in the project list
    addToProjectList(dataDir);

    // Restore previously registered projects (other tabs from last session)
    const previousProjects = readProjectList();
    const absDataDir = resolve(dataDir);
    const validProjects = [absDataDir];
    for (const prevDir of previousProjects) {
      if (prevDir === absDataDir) continue; // Already registered above
      if (!existsSync(prevDir)) continue;   // Directory no longer exists
      try {
        await registerProject(prevDir, actualPort);
        validProjects.push(prevDir);
      } catch {
        // Non-critical — skip projects that fail to register
      }
    }
    // Clean up stale entries from the project list
    if (validProjects.length !== previousProjects.length) {
      const { reorderProjectList } = await import('./project-list.js');
      reorderProjectList(validProjects);
    }

    // Notify long-poll so the UI discovers restored tabs
    if (validProjects.length > 1) {
      const { notifyChange } = await import('./routes/notify.js');
      notifyChange();
    }

    // One-time migration: if no global channelEnabled, read from first project's DB
    const { readGlobalConfig, writeGlobalConfig } = await import('./global-config.js');
    const globalConfig = readGlobalConfig();
    if (globalConfig.channelEnabled === undefined) {
      const { getSettings } = await import('./db/queries.js');
      const settings = await getSettings();
      const legacy = settings.channel_enabled === 'true';
      writeGlobalConfig({ channelEnabled: legacy });
    }

    // If channel is globally enabled, ensure .mcp.json exists for all projects
    if (readGlobalConfig().channelEnabled === true) {
      const { registerChannelForAll } = await import('./channel-config.js');
      const { getAllProjects } = await import('./projects.js');
      registerChannelForAll(getAllProjects().map(p => p.dataDir));
    }

    writeInstanceFile(actualPort);

    // Clean up instance file on exit
    const cleanupInstance = () => removeInstanceFile();
    process.on('exit', cleanupInstance);
    process.on('SIGINT', () => { cleanupInstance(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupInstance(); process.exit(0); });
  }

  // Open browser AFTER all projects are restored (so tabs are ready when the page loads)
  if (!noOpen) {
    const url = `http://localhost:${actualPort}`;
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execFile(openCmd, [url]);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
