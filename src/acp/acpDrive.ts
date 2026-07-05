// HS-9330 — the real-IO edge of the ACP drive transport (docs/114 §114.8 item 1).
//
// Where the Antigravity drive is a `--print` one-shot (`antigravityDrive.ts`), the
// ACP drive is a PERSISTENT JSON-RPC session over the child's stdio: it spawns the
// agent in ACP-server mode (`opencode acp`, validated §114.11), runs ONE play-button
// turn through the spike-validated `acpClient.ts` (`initialize` → `session/new` with
// the `hotsheet_*` MCP server → `session/prompt`), and tears the process down when
// the turn ends. Busy/done ride the SAME channel heartbeat/done POSTs Claude and
// Antigravity use, so the indicator behaves identically across transports.
//
// The child process + the three side effects (spawn / heartbeat / done) are all
// INJECTED so this whole wiring is unit-testable against a fake ChildProcess replaying
// real OpenCode messages — no spawn, no `opencode auth`, no LLM turn. A LIVE
// `session/prompt` → `stopReason` smoke test against a running agent stays the honest
// remaining boundary (needs `opencode auth`; a manual/paired step, HS-9330 note) — the
// protocol core + this wiring are proven headlessly, the real turn is not.
//
// The §47 permission overlay + the auto-allow gate are NOT wired here yet: the ACP
// `toolCall` shape a `session/request_permission` carries wasn't captured by the spike
// (it stopped at `session/new`, before any tool call), so mapping it onto the allow-rule
// gate would be guessing. Until a live turn pins that shape, `requestPermission` is an
// injected seam that defaults to deny-by-default (acpClient's own fallback). That is the
// one real client-surface change tracked as a follow-up.

import { type ChildProcess, spawn } from 'child_process';
import { dirname } from 'path';

import { readFileSettings } from '../file-settings.js';
import { getProjectSecret } from '../secret-file.js';
import { isAcpDrivenTool, resolveAcpAgentCommand } from './acpAgents.js';
import { type AcpClientCallbacks, type AcpTransport, createAcpClient } from './acpClient.js';

/** HS-9330 — does this project drive its play button over the ACP transport
 *  (docs/113 §113.2 A2)? True when `ai_tool` resolves to a known ACP entrypoint. */
export function isAcpDriven(dataDir: string): boolean {
  const tool = readFileSettings(dataDir).ai_tool;
  return typeof tool === 'string' && isAcpDrivenTool(tool);
}

type HeartbeatState = 'busy' | 'idle' | 'heartbeat';

/** How often the drive re-asserts "busy" while the turn runs — a backstop under the
 *  client's 60s busy fallback, so the indicator never lapses on a quiet stretch of a
 *  long turn even if `session/update` activity pauses (matches the agy drive). */
const ACP_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AcpDriveDeps {
  /** Injectable for tests. Defaults to `child_process.spawn`. */
  spawnFn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: readonly ['pipe', 'pipe', 'ignore'] },
  ) => ChildProcess;
  /** Injectable for tests. Defaults to the real `/channel/done` fallback POST. */
  signalDone?: (dataDir: string, serverPort: number) => void;
  /** Injectable for tests. Defaults to the real `/channel/heartbeat` POST. */
  postHeartbeat?: (serverPort: number, secret: string, state: HeartbeatState) => void;
  /** The permission resolver — the auto-allow gate + §47 overlay (docs/114 §114.5).
   *  Absent (the shipped default until the overlay lands), acpClient denies by default
   *  (never auto-approves a tool call with no resolver wired). */
  requestPermission?: AcpClientCallbacks['requestPermission'];
}

/**
 * Spawn `opencode acp` (or another ACP agent, per `resolveAcpAgentCommand`) for this
 * project's worklist and run ONE play-button turn. Returns false if the project isn't
 * ACP-driven or the spawn couldn't start; true once the turn is underway.
 *
 * While the turn runs the drive posts `busy` (immediately) then periodic `heartbeat`
 * beats — both on the 15s timer AND on each `session/update` activity — so the
 * indicator survives a long turn; the turn end (a `stopReason`), a process exit, or a
 * spawn error all post `idle` + signal `/channel/done` exactly ONCE and kill the child,
 * so busy can never stick.
 */
export function spawnAcpRun(dataDir: string, serverPort: number, content: string, deps: AcpDriveDeps = {}): boolean {
  const tool = readFileSettings(dataDir).ai_tool;
  const resolved = resolveAcpAgentCommand(typeof tool === 'string' ? tool : undefined);
  if (resolved === null) return false; // not an ACP-driven tool — caller shouldn't have routed here

  const doSpawn = deps.spawnFn ?? spawn;
  const done = deps.signalDone ?? fallbackSignalDone;
  const heartbeat = deps.postHeartbeat ?? fallbackHeartbeat;
  const projectDir = dirname(dataDir); // <root>/.hotsheet → <root>
  const secret = getProjectSecret(dataDir);

  let proc: ChildProcess;
  try {
    // stderr → ignore: OpenCode logs there (docs/114 §114.11); leaving it a live but
    // unread pipe could block the child on a full buffer. stdin/stdout stay pipes.
    proc = doSpawn(resolved.command, resolved.args, {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'ignore'] as const,
    });
  } catch {
    return false;
  }

  const transport: AcpTransport = {
    send: (line) => { proc.stdin?.write(line); },
    close: () => { try { proc.stdin?.end(); } catch { /* stdin already closed */ } },
  };

  heartbeat(serverPort, secret, 'busy'); // busy from the start
  const timer = setInterval(() => { heartbeat(serverPort, secret, 'heartbeat'); }, ACP_HEARTBEAT_INTERVAL_MS);
  timer.unref(); // don't hold the event loop open for the heartbeat

  let finished = false;
  const finish = (): void => {
    if (finished) return; // turn-end, 'error', and 'exit' can all fire — run once
    finished = true;
    clearInterval(timer);
    heartbeat(serverPort, secret, 'idle');
    done(dataDir, serverPort);
    try { proc.kill(); } catch { /* already gone */ }
  };

  const client = createAcpClient(transport, {
    onBusy: () => { heartbeat(serverPort, secret, 'heartbeat'); }, // activity-driven beat
    onTurnEnd: () => { finish(); },                                // stopReason ⇒ done
    requestPermission: deps.requestPermission,
  });

  // Attach the stdout pump BEFORE runPrompt sends `initialize`, so no reply is missed.
  proc.stdout?.on('data', (chunk: Buffer) => { client.receive(chunk.toString('utf-8')); });
  proc.on('error', finish); // couldn't launch / died mid-turn → don't leave it busy
  proc.on('exit', finish);  // process gone → clear busy even without a stopReason

  // A protocol/session failure inside runPrompt still fires onTurnEnd('error') first
  // (so finish already ran); the catch is a belt-and-suspenders against an unexpected
  // throw, and swallows the rejection so it can't surface as an unhandled rejection.
  void client.runPrompt(projectDir, content).catch(() => { finish(); });
  return true;
}

/** Best-effort `/channel/done` POST so busy clears when the turn ends (mirrors the agy
 *  drive's fallback; the agent may also call `hotsheet_signal_done` from the worklist). */
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
