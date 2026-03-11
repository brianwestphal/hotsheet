import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { cleanupAttachments } from './cleanup.js';
import { getDb, setDataDir } from './db/connection.js';
import { DEMO_SCENARIOS, seedDemoData } from './demo.js';
import { ensureGitignore } from './gitignore.js';
import { startServer } from './server.js';
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
  --check-for-updates      Check for new versions now
  --help                   Show this help message

Examples:
  hotsheet
  hotsheet --port 8080
  hotsheet --data-dir ~/my-project/.hotsheet
`);
}

function parseArgs(argv: string[]): { port: number; dataDir: string; demo: number | null; forceUpdateCheck: boolean } | null {
  const args = argv.slice(2);
  let port = 4174;
  let dataDir = join(process.cwd(), '.hotsheet');
  let demo: number | null = null;
  let forceUpdateCheck = false;

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
      default:
        console.error(`Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return { port, dataDir, demo, forceUpdateCheck };
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { port, demo, forceUpdateCheck } = parsed;
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

  const actualPort = await startServer(port, dataDir);

  // Initialize markdown sync with the actual port (may differ if requested port was in use)
  initMarkdownSync(dataDir, actualPort);
  scheduleAllSync();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
