/**
 * HS-8921 — process-global "are we running under `--test`?" flag.
 *
 * Test mode is a launch-time concept (`src/cli/args.ts` resolves an isolated
 * `HOTSHEET_HOME`, a sandbox data-dir, and the non-prod default port), with no
 * per-request shape — once the process is launched with `--test`, every page it
 * serves belongs to the isolated test instance. So a single module-level
 * boolean, set once at startup before the server begins serving, is the right
 * model (mirrors `src/demo-mode.ts`).
 *
 * The page shell (`src/components/layout.tsx`) reads `isTestMode()` at render
 * time to render the unmistakable "TEST" badge (HS-8922) so the user can never
 * confuse the isolated test window with their real one.
 *
 * Kept in its own DB-free module so the page route can read it without pulling
 * in any heavier startup machinery.
 */

let testMode = false;

/** Mark the process as running in test mode. Called once from `src/cli/args.ts`
 *  when launched with `--test`, before the server starts serving. */
export function setTestMode(value: boolean): void {
  testMode = value;
}

/** Whether the process was launched in test mode (`--test`). Read by the page
 *  shell to render the "TEST" badge. */
export function isTestMode(): boolean {
  return testMode;
}
