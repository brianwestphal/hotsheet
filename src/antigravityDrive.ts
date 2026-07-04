// HS-9321 — the play-button drive for Antigravity (`agy`). Unlike Claude, agy has
// no persistent channel session to notify; the HS-9310 spike settled the model as
// **`--print` one-shot**: each play SPAWNS `agy --print "<worklist prompt>"` in the
// project directory (cwd-resolving its MCP config, HS-9320). agy processes the
// worklist via the `hotsheet_*` MCP tools + the .agents/skills routine (HS-9326)
// and calls `hotsheet_signal_done` from the prompt — so "done" clears busy through
// the SAME path as Claude. As a backstop, a process exit that didn't signal done
// fires a fallback `/channel/done` so the busy state can't stick.
import { type ChildProcess, spawn } from 'child_process';
import { dirname } from 'path';

import { readFileSettings } from './file-settings.js';
import { getProjectSecret } from './secret-file.js';

/** HS-9321 — does this project drive its play button via Antigravity? */
export function isAntigravityDriven(dataDir: string): boolean {
  const tool = readFileSettings(dataDir).ai_tool;
  return typeof tool === 'string' && tool.trim().toLowerCase() === 'antigravity';
}

/**
 * Pure: the `agy` argv for a one-shot worklist run. `--dangerously-skip-permissions`
 * is required — `--print` is non-interactive and can't answer a permission prompt
 * (mid-run permission popups are a later, persistent-mode enhancement).
 */
export function buildAgyRunArgs(content: string, model?: string): string[] {
  const args = ['--print', content, '--dangerously-skip-permissions'];
  if (model !== undefined && model.trim() !== '') args.push('--model', model.trim());
  return args;
}

export interface AgyDriveDeps {
  /** Injectable for tests. Defaults to `child_process.spawn`. */
  spawnFn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'ignore' }) => ChildProcess;
  /** Injectable for tests. Defaults to the real `/channel/done` fallback POST. */
  signalDone?: (dataDir: string, serverPort: number) => void;
}

/**
 * Spawn a one-shot `agy --print` for this project's worklist. Fire-and-forget: the
 * agent's own `hotsheet_signal_done` (from the prompt) drives the UI; the exit
 * handler only backstops it. Returns false if the spawn couldn't be started.
 */
export function spawnAgyRun(dataDir: string, serverPort: number, content: string, deps: AgyDriveDeps = {}): boolean {
  const doSpawn = deps.spawnFn ?? spawn;
  const done = deps.signalDone ?? fallbackSignalDone;
  const projectDir = dirname(dataDir); // <root>/.hotsheet → <root>
  try {
    const proc = doSpawn('agy', buildAgyRunArgs(content), {
      cwd: projectDir,
      env: { ...process.env },
      stdio: 'ignore',
    });
    proc.on('error', () => { done(dataDir, serverPort); }); // couldn't launch → don't leave it "busy"
    proc.on('exit', () => { done(dataDir, serverPort); });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort `/channel/done` POST so busy clears if agy exits without signaling. */
function fallbackSignalDone(dataDir: string, serverPort: number): void {
  const secret = getProjectSecret(dataDir);
  void fetch(`http://localhost:${String(serverPort)}/api/channel/done`, {
    method: 'POST',
    headers: { 'X-Hotsheet-Secret': secret },
  }).catch(() => { /* best-effort — the agent likely already signaled done */ });
}
