/**
 * HS-9089 (docs/105 §105.3) — a configurable per-project setup hook that
 * `createWorktree` runs AFTER `node_modules` provisioning, for repos that need
 * more than an install to be buildable (`.env` files, codegen, a build step).
 * Two sources, either or both:
 *
 *   1. The **`worktreeSetup`** setting — a shell command string. §95-classified
 *      SHARED (a project build contract; lives in the committed `settings.json`).
 *   2. The **`.hotsheet/worktree-setup.sh`** convention — a script in the owner's
 *      gitignored data dir (machine-local), run if present. A unix-shell
 *      convention (`sh <path>`); on Windows it needs `sh` on PATH (git-bash).
 *
 * Both run with the **worktree root as cwd**, and the whole thing is **best-effort
 * + logged** — a setup hiccup must never fail worktree creation (the same
 * contract as the channel/skills wiring + the `node_modules` provisioning). The
 * command runner + logger are injectable for tests.
 */
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

import { readFileSettings } from '../file-settings.js';
import { getErrorMessage } from '../utils/errorMessage.js';

const execAsync = promisify(exec);

/** The gitignored, machine-local convention script in the owner's data dir. */
const SETUP_SCRIPT = 'worktree-setup.sh';

export interface WorktreeSetupResult {
  /** Which hooks ran, in order (`setting` before `script`). */
  ran: Array<'setting' | 'script'>;
  /** True when every hook that ran succeeded (or nothing ran). */
  ok: boolean;
}

/** Injectable shell-command runner (resolves `{ ok }` from the exit code). */
export type SetupRunner = (cwd: string, command: string) => Promise<{ ok: boolean; output: string }>;

export const defaultSetupRunner: SetupRunner = async (cwd, command) => {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, output: stdout + stderr };
  } catch (e) {
    return { ok: false, output: getErrorMessage(e) };
  }
};

export interface WorktreeSetupOptions {
  run?: SetupRunner;
  /** Best-effort log sink for failures (defaults to `console.warn`). */
  log?: (message: string) => void;
}

/**
 * Run the configured per-project setup hook(s) in `worktreeRoot`. Reads the
 * `worktreeSetup` setting + the `worktree-setup.sh` convention from `ownerDataDir`
 * (the authoritative `.hotsheet`). Never throws — failures are logged and folded
 * into `ok: false`, so the caller (createWorktree) can ignore the outcome.
 */
export async function runWorktreeSetup(
  worktreeRoot: string, ownerDataDir: string, opts: WorktreeSetupOptions = {},
): Promise<WorktreeSetupResult> {
  const run = opts.run ?? defaultSetupRunner;
  const log = opts.log ?? ((m: string) => { console.warn(m); });
  const ran: Array<'setting' | 'script'> = [];
  let ok = true;

  // 1) The shared `worktreeSetup` command string.
  let settingCmd: string | undefined;
  try { settingCmd = readFileSettings(ownerDataDir).worktreeSetup?.trim(); } catch { settingCmd = undefined; }
  if (settingCmd !== undefined && settingCmd !== '') {
    ran.push('setting');
    const r = await run(worktreeRoot, settingCmd);
    if (!r.ok) { ok = false; log(`[worktree-setup] the worktreeSetup command failed in ${worktreeRoot}: ${r.output}`); }
  }

  // 2) The gitignored-local `.hotsheet/worktree-setup.sh` convention, if present.
  const scriptPath = join(ownerDataDir, SETUP_SCRIPT);
  if (existsSync(scriptPath)) {
    ran.push('script');
    const r = await run(worktreeRoot, `sh ${JSON.stringify(scriptPath)}`);
    if (!r.ok) { ok = false; log(`[worktree-setup] ${SETUP_SCRIPT} failed in ${worktreeRoot}: ${r.output}`); }
  }

  return { ran, ok };
}
