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

/** HS-9327 — opt-in: route agy's tool calls through the §47 permission overlay
 *  (drop `--dangerously-skip-permissions`; a `.agents/hooks.json` PreToolUse hook
 *  gates each call). Default false = the shipped `--print` + auto-approve path. */
export function antigravityInteractivePermissions(dataDir: string): boolean {
  return readFileSettings(dataDir).antigravity_interactive_permissions === true;
}

/**
 * Pure: the `agy` argv for a one-shot worklist run. By default it passes
 * `--dangerously-skip-permissions` (`--print` is non-interactive, so a tool call
 * would otherwise hang). When `skipPermissions` is false (interactive-permissions
 * mode, HS-9327) it's omitted — the `.agents/hooks.json` PreToolUse hook resolves
 * each permission via the §47 overlay instead.
 */
export function buildAgyRunArgs(content: string, opts: { skipPermissions?: boolean; model?: string } = {}): string[] {
  const args = ['--print', content];
  if (opts.skipPermissions !== false) args.push('--dangerously-skip-permissions');
  if (opts.model !== undefined && opts.model.trim() !== '') args.push('--model', opts.model.trim());
  return args;
}

type HeartbeatState = 'busy' | 'idle' | 'heartbeat';

/** HS-9327 — how often the drive re-asserts "busy" while agy runs. Well under the
 *  client's 60s busy fallback so the indicator never lapses on a long run. */
const AGY_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AgyDriveDeps {
  /** Injectable for tests. Defaults to `child_process.spawn`. */
  spawnFn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'ignore' }) => ChildProcess;
  /** Injectable for tests. Defaults to the real `/channel/done` fallback POST. */
  signalDone?: (dataDir: string, serverPort: number) => void;
  /** Injectable for tests. Defaults to the real `/channel/heartbeat` POST. */
  postHeartbeat?: (serverPort: number, secret: string, state: HeartbeatState) => void;
}

/**
 * Spawn a one-shot `agy --print` for this project's worklist. agy's own
 * `hotsheet_signal_done` (from the prompt) drives the UI; the exit handler backstops
 * it. HS-9327 — while the process is alive we also post periodic `busy` heartbeats
 * (the client's long-poll reflects them independent of its 60s fallback), so the
 * indicator survives a long run; the exit posts `idle`. Returns false if the spawn
 * couldn't be started.
 */
export function spawnAgyRun(dataDir: string, serverPort: number, content: string, deps: AgyDriveDeps = {}): boolean {
  const doSpawn = deps.spawnFn ?? spawn;
  const done = deps.signalDone ?? fallbackSignalDone;
  const heartbeat = deps.postHeartbeat ?? fallbackHeartbeat;
  const projectDir = dirname(dataDir); // <root>/.hotsheet → <root>
  const secret = getProjectSecret(dataDir);
  const skipPermissions = !antigravityInteractivePermissions(dataDir);
  try {
    const proc = doSpawn('agy', buildAgyRunArgs(content, { skipPermissions }), {
      cwd: projectDir,
      env: { ...process.env },
      stdio: 'ignore',
    });
    heartbeat(serverPort, secret, 'busy'); // keep the indicator busy from the start
    const timer = setInterval(() => { heartbeat(serverPort, secret, 'heartbeat'); }, AGY_HEARTBEAT_INTERVAL_MS);
    timer.unref(); // don't hold the event loop open for the heartbeat
    let finished = false;
    const finish = (): void => {
      if (finished) return; // 'error' + 'exit' can both fire — run once
      finished = true;
      clearInterval(timer);
      heartbeat(serverPort, secret, 'idle');
      done(dataDir, serverPort);
    };
    proc.on('error', finish); // couldn't launch → don't leave it "busy"
    proc.on('exit', finish);
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

/** Best-effort `/channel/heartbeat` POST — the project is matched by `secret`. */
function fallbackHeartbeat(serverPort: number, secret: string, state: HeartbeatState): void {
  void fetch(`http://localhost:${String(serverPort)}/api/channel/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, secret }),
  }).catch(() => { /* best-effort */ });
}
