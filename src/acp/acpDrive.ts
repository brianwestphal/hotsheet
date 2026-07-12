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
// HS-9330 item 2 — the §47 permission overlay IS wired here now that a live OpenCode turn
// pinned the `session/request_permission` `toolCall` shape (docs/114 §114.11). The default
// `requestPermission` maps the toolCall to display fields (`acpToolCall.ts`) and injects it
// into the main-server bridge (`acpPermissionBridge.ts`) → the SAME option-driven overlay
// the Claude popup uses → the user's chosen `optionId` flows back as the ACP reply. A
// pending request is dismissed (→ cancelled) if the turn ends first, so an abandoned
// prompt can never leave the agent waiting. (The auto-allow gate — mapping the ACP `kind`
// onto `permission_allow_rules` — is a follow-up.)

import { type ChildProcess, spawn } from 'child_process';
import { dirname } from 'path';

import { readFileSettings } from '../file-settings.js';
import { getProjectSecret } from '../secret-file.js';
import { isAcpDrivenTool, resolveAcpAgentCommand } from './acpAgents.js';
import { type AcpClientCallbacks, type AcpTransport, createAcpClient } from './acpClient.js';
import { dismissAcpPermission, injectAcpPermission } from './acpPermissionBridge.js';
import { extractToolCallDisplay } from './acpToolCall.js';

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
  /** Override the permission resolver (tests). Absent → the default bridge resolver
   *  (`makeBridgeResolver`) that surfaces the request in the §47 overlay. */
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

  // HS-9330 — track request_ids we've surfaced in the overlay so a turn that ends while
  // one is still pending can dismiss it (→ cancelled) rather than leave the agent waiting.
  const pendingPermissionIds = new Set<string>();
  const requestPermission = deps.requestPermission ?? makeBridgeResolver(secret, pendingPermissionIds);

  let finished = false;
  const finish = (): void => {
    if (finished) return; // turn-end, 'error', and 'exit' can all fire — run once
    finished = true;
    clearInterval(timer);
    // Dismiss any still-open permission popup for this turn so it can't hang the agent.
    for (const id of pendingPermissionIds) dismissAcpPermission(id);
    pendingPermissionIds.clear();
    heartbeat(serverPort, secret, 'idle');
    done(dataDir, serverPort);
    try { proc.kill(); } catch { /* already gone */ }
  };

  const client = createAcpClient(transport, {
    onBusy: () => { heartbeat(serverPort, secret, 'heartbeat'); }, // activity-driven beat
    onTurnEnd: () => { finish(); },                                // stopReason ⇒ done
    requestPermission,
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

/**
 * The default permission resolver: surface the agent's `session/request_permission` in
 * the §47 overlay (via the main-server bridge) and resolve with the user's choice. Maps
 * the ACP `toolCall` → display fields (`extractToolCallDisplay`) and passes the agent's
 * own `options` straight through (they're already `{ optionId, name, kind }`). Tracks the
 * request_id in `pending` so `finish()` can dismiss it if the turn ends first.
 */
function makeBridgeResolver(
  secret: string,
  pending: Set<string>,
): NonNullable<AcpClientCallbacks['requestPermission']> {
  return async (req) => {
    const display = extractToolCallDisplay(req.toolCall);
    const { request_id, promise } = injectAcpPermission({
      secret,
      tool_name: display.tool_name,
      description: display.description,
      input_preview: display.input_preview,
      options: req.options,
    });
    pending.add(request_id);
    try {
      return await promise;
    } finally {
      pending.delete(request_id);
    }
  };
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
