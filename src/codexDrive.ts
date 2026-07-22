// HS-9369 (docs/115 §115.7) — the play-button drive for Codex (`codex`). Codex is
// MCP-native (no ACP mode in codex-cli; `app-server` is its own protocol), so per the
// HS-9310 principle it rides the A1 MCP+hooks transport — the same spawn-per-play
// rails as Antigravity (`antigravityDrive.ts`), with one improvement: `codex exec
// --json` streams structured JSONL events, so busy heartbeats can be event-driven on
// top of the interval floor.
//
// Captured event contract (codex-cli 0.145.0, live probe 2026-07-22):
//   {"type":"thread.started","thread_id":"…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"…","type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{…}}
// (Other item types — command_execution, mcp_tool_call, reasoning — arrive the same
// way; any well-formed event line counts as liveness.)
//
// Codex processes the worklist via the `hotsheet_*` MCP tools (registered by
// `src/codex.ts`) and calls `hotsheet_signal_done` from the prompt — so "done"
// clears busy through the SAME path as Claude. A process exit that didn't signal
// done fires a fallback `/channel/done` so the busy state can't stick.
import { type ChildProcess, spawn } from 'child_process';
import { dirname } from 'path';

import { getProjectSecret } from './secret-file.js';

/**
 * Pure: the `codex` argv for a one-shot worklist run.
 * - `exec` — non-interactive (the `agy --print` analog); prompt as the final arg.
 * - `--json` — structured JSONL events on stdout (busy liveness + observability).
 * - `--dangerously-bypass-approvals-and-sandbox` — the agy
 *   `--dangerously-skip-permissions` analog: `exec` can't prompt, so an approval
 *   or sandbox-escalation request would otherwise hang the run; and Codex's
 *   sandbox would block the MCP channel server's localhost HTTP calls to the Hot
 *   Sheet API. Auto-approve is the accepted Tier-A default (docs/113 footnote ¹);
 *   the §47 interactive-permission overlay for Codex is the HS-9359 follow-up on
 *   its hooks surface.
 * - `--skip-git-repo-check` — the drive always runs with an explicit project cwd,
 *   so the accidental-homedir guard the check exists for doesn't apply, and a
 *   non-git project must still be drivable.
 */
export function buildCodexExecArgs(content: string): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', content];
}

/** Pure: classify one stdout line from `codex exec --json`. Returns the event type
 *  for a well-formed event line, or null for blank/non-JSON/shape-less lines
 *  (codex prints occasional plain-text warnings to stdout/stderr). */
export function parseCodexEventType(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const t = (parsed as { type?: unknown }).type;
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}

type HeartbeatState = 'busy' | 'idle' | 'heartbeat';

/** Interval floor for "busy" re-assertion — identical to the agy drive: well under
 *  the client's 60s busy fallback. Events additionally heartbeat as they arrive
 *  (an active turn can go minutes between item completions, so the floor stays). */
const CODEX_HEARTBEAT_INTERVAL_MS = 15_000;

export interface CodexDriveDeps {
  /** Injectable for tests. Defaults to `child_process.spawn`. */
  spawnFn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'ignore'] }) => ChildProcess;
  /** Injectable for tests. Defaults to the real `/channel/done` fallback POST. */
  signalDone?: (dataDir: string, serverPort: number) => void;
  /** Injectable for tests. Defaults to the real `/channel/heartbeat` POST. */
  postHeartbeat?: (serverPort: number, secret: string, state: HeartbeatState) => void;
}

/**
 * Spawn a one-shot `codex exec --json` for this project's worklist. Codex's own
 * `hotsheet_signal_done` (from the prompt) drives the UI; the exit handler
 * backstops it. Busy is asserted immediately, re-asserted on a 15s interval AND on
 * every structured event line, and cleared (+ fallback done) on exit/error.
 * Returns false if the spawn couldn't be started.
 */
export function spawnCodexRun(dataDir: string, serverPort: number, content: string, deps: CodexDriveDeps = {}): boolean {
  const doSpawn = deps.spawnFn ?? spawn;
  const done = deps.signalDone ?? fallbackSignalDone;
  const heartbeat = deps.postHeartbeat ?? fallbackHeartbeat;
  const projectDir = dirname(dataDir); // <root>/.hotsheet → <root>
  const secret = getProjectSecret(dataDir);
  try {
    const proc = doSpawn('codex', buildCodexExecArgs(content), {
      cwd: projectDir,
      env: { ...process.env },
      // stdout is piped for the JSONL event stream; it MUST be consumed (below)
      // so a chatty run can't fill the pipe and stall codex.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    heartbeat(serverPort, secret, 'busy'); // keep the indicator busy from the start
    const timer = setInterval(() => { heartbeat(serverPort, secret, 'heartbeat'); }, CODEX_HEARTBEAT_INTERVAL_MS);
    timer.unref(); // don't hold the event loop open for the heartbeat

    // Event-driven liveness: each structured event re-asserts busy immediately
    // (the interval remains the floor during long silent stretches of a turn).
    let buffered = '';
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let nl = buffered.indexOf('\n');
      while (nl !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (parseCodexEventType(line) !== null) heartbeat(serverPort, secret, 'heartbeat');
        nl = buffered.indexOf('\n');
      }
    });

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

/** Best-effort `/channel/done` POST so busy clears if codex exits without signaling. */
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
