import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { initBackupScheduler } from './backup.js';
import { cleanupAttachments } from './cleanup.js';
import { getDb, setDataDir } from './db/connection.js';
import { getCategories } from './db/queries.js';
import { DEMO_SCENARIOS, seedDemoData } from './demo.js';
import { ensureSecret } from './file-settings.js';
import { ensureGitignore } from './gitignore.js';
import { acquireLock } from './lock.js';
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
  --check-for-updates      Check for new versions now
  --help                   Show this help message

Examples:
  hotsheet
  hotsheet --port 8080
  hotsheet --data-dir ~/my-project/.hotsheet
`);
}

function parseArgs(argv: string[]): { port: number; dataDir: string; demo: number | null; forceUpdateCheck: boolean; noOpen: boolean; strictPort: boolean } | null {
  const args = argv.slice(2);
  let port = 4174;
  let dataDir = join(process.cwd(), '.hotsheet');
  let demo: number | null = null;
  let forceUpdateCheck = false;
  let noOpen = false;
  let strictPort = false;

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
      default:
        console.error(`Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return { port, dataDir, demo, forceUpdateCheck, noOpen, strictPort };
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { port, demo, forceUpdateCheck, noOpen, strictPort } = parsed;
  let { dataDir } = parsed;

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
  await getDb();

  if (demo !== null) {
    await seedDemoData(demo);
  }

  if (demo === null) {
    // Clean up old attachments only for real projects
    await cleanupAttachments();
  }

  console.log(`  Data directory: ${dataDir}`);

  const actualPort = await startServer(port, dataDir, { noOpen, strictPort });

  // Generate/validate the API secret and write port to settings.json for AI tool consumption
  ensureSecret(dataDir, actualPort);

  // Initialize markdown sync with the actual port (may differ if requested port was in use)
  initMarkdownSync(dataDir, actualPort);
  scheduleAllSync();

  // Initialize and sync AI tool skills/rules
  initSkills(actualPort, dataDir);
  setSkillCategories(await getCategories());
  const updatedPlatforms = ensureSkills();
  if (updatedPlatforms.length > 0) {
    console.log(`\n  AI tool skills created/updated for: ${updatedPlatforms.join(', ')}`);
    console.log('  Restart your AI tool to pick up the new ticket creation skills.\n');
  }

  // Record daily stats snapshot and backfill any missing days
  import('./db/stats.js').then(async ({ recordDailySnapshot, backfillSnapshots }) => {
    await backfillSnapshots();
    await recordDailySnapshot();
  }).catch(() => { /* non-critical */ });

  if (demo === null) {
    initBackupScheduler(dataDir);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
