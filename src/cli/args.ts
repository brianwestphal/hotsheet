/**
 * HS-8089 — CLI argument parsing extracted from `src/cli.ts`. Pure module:
 * no side effects on import, no shared state. The only cross-call effect
 * is the `process.exit(...)` calls inside `parseArgs` for invalid input
 * and inside `printUsage`'s `--help` exit path — both intentional, since
 * we want the error message + non-zero status to land before any startup
 * work begins.
 */
import { homedir } from 'os';
import { join, resolve } from 'path';

import { globalHotsheetDir } from '../global-dir.js';
import { setTestMode } from '../test-mode.js';

/** HS-8921 — default port for the isolated `--test` instance, chosen so a test
 *  instance and the prod instance (4174) can run side by side. */
export const TEST_MODE_PORT = 4274;

/** HS-8921 — the stable isolated global dir for `--test` (kept across runs so
 *  the test instance's registry/config/telemetry stays inspectable, unlike a
 *  random temp dir). */
export function testModeGlobalDir(): string {
  return join(homedir(), '.hotsheet-test');
}

/** HS-8921 — point `HOTSHEET_HOME` at the isolated test dir when `--test` is in
 *  argv and the user hasn't already set it. Idempotent and safe to call more
 *  than once. Must run BEFORE any `globalHotsheetDir()` consumer — `cli.ts`
 *  calls it at the very top of `main()` so even the startup log + event-loop
 *  watchdog (which run before `parseArgs`) land under the test home. `parseArgs`
 *  also calls it, so a non-`cli.ts` caller still gets the isolation. */
export function maybeApplyTestModeHome(argv: string[]): void {
  if (!argv.slice(2).includes('--test')) return;
  const cur = process.env.HOTSHEET_HOME;
  if (cur === undefined || cur.trim() === '') {
    process.env.HOTSHEET_HOME = testModeGlobalDir();
  }
}

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
  /** HS-8921 — `--test`: run a fully-isolated test instance (own
   *  `HOTSHEET_HOME`, sandbox data-dir, alt default port, TEST badge). */
  test: boolean;
  /** HS-7940 — `--bind <address>`: interface the HTTP server listens on.
   *  Undefined → fall back to `config.json:bind` → default `127.0.0.1`
   *  (loopback). Pass `0.0.0.0` or a specific IP to expose the server off-box
   *  (then the GET-secret enforcement + `trustedOrigins` allow-list apply). */
  bind: string | undefined;
}

export function printUsage(): void {
  console.log(`
hotsheet - Lightweight local project management

Usage:
  hotsheet [options]

Options:
  --port <number>          Port to run on (default: 4174)
  --bind <address>         Interface to listen on (default: 127.0.0.1, loopback only).
                           Use 0.0.0.0 or a specific IP to expose off-box — then GET
                           requests from untrusted origins require the secret and you
                           must list remote origins in config.json:trustedOrigins.
  --data-dir <path>        Store data in an alternative location (default: .hotsheet/)
  --no-open                Don't open the browser on startup
  --strict-port            Fail if the requested port is in use (don't auto-select)
  --replace                Shut down any running Hot Sheet instance before starting
  --close                  Unregister the current project from the running instance
  --force                  Skip interactive confirmations (use with --close in CI / scripts)
  --list                   List all projects registered with the running instance
  --test                   Run an isolated test instance: own ~/.hotsheet-test global
                           state, a sandbox project data-dir, default port ${TEST_MODE_PORT},
                           and a TEST badge — never touches your real instance/projects
  --check-for-updates      Check for new versions now
  --help                   Show this help message

Examples:
  hotsheet
  hotsheet --port 8080
  hotsheet --data-dir ~/my-project/.hotsheet
  hotsheet --list
  hotsheet --close
  hotsheet --replace
  hotsheet --test
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
  let test = false;
  let bind: string | undefined;
  // HS-8921 — track whether the user passed these explicitly so `--test`'s
  // defaults only apply when the user didn't (order-independent: `--test --port`
  // and `--port --test` behave identically).
  let portExplicit = false;
  let dataDirExplicit = false;

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
        portExplicit = true;
        break;
      case '--data-dir':
        dataDir = resolve(args[++i]);
        dataDirExplicit = true;
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
      case '--test':
        test = true;
        break;
      case '--bind':
        if (i + 1 >= args.length || args[i + 1] === '' || args[i + 1].startsWith('--')) {
          console.error('--bind requires an address (e.g. 127.0.0.1, 0.0.0.0, or a specific interface IP)');
          process.exit(1);
        }
        bind = args[++i];
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  if (test) {
    // HS-8921 — turnkey isolation. Order matters: set HOTSHEET_HOME FIRST (when
    // the user hasn't already pointed it somewhere) so the sandbox data-dir
    // below — and every later `globalHotsheetDir()` consumer — resolves under
    // the isolated home. Usually already applied by `maybeApplyTestModeHome`
    // at the top of `main()`; repeated here (idempotent) so a direct
    // `parseArgs` caller still gets the isolation.
    maybeApplyTestModeHome(argv);
    // Different default port so a test instance and prod (4174) coexist.
    if (!portExplicit) port = TEST_MODE_PORT;
    // Sandbox data-dir under the isolated home — so launching `--test` from
    // inside a real project never writes `.hotsheet/` into that real project.
    if (!dataDirExplicit) dataDir = join(globalHotsheetDir(), 'sandbox-project', '.hotsheet');
    // Process-global flag read by the page shell to render the TEST badge.
    setTestMode(true);
  }

  return { port, dataDir, demo, forceUpdateCheck, noOpen, strictPort, replace, close, force, list, test, bind };
}
