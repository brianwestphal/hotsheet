/**
 * HS-8089 — CLI argument parsing extracted from `src/cli.ts`. Pure module:
 * no side effects on import, no shared state. The only cross-call effect
 * is the `process.exit(...)` calls inside `parseArgs` for invalid input
 * and inside `printUsage`'s `--help` exit path — both intentional, since
 * we want the error message + non-zero status to land before any startup
 * work begins.
 */
import { join, resolve } from 'path';

export interface ParsedArgs {
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

export function printUsage(): void {
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

export function parseArgs(argv: string[]): ParsedArgs | null {
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
