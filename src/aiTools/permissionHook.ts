// HS-9506 (docs/132 §132.9.1) — the HOST side of the §47 permission bridge for
// hook-driven agents: read a tool call on stdin, surface it to the permission
// overlay through the channel server, wait for the user's decision, emit the
// agent's allow/deny.
//
// WHY THIS FILE EXISTS AT ALL. The flow was already generic and already shared —
// but it lived in `antigravityPermissionHook.ts`, so `codexPermissionHook.ts`
// imported its core logic from a module named after a DIFFERENT tool, and the
// generic defaults were one tool's behavior. That is the exact shape docs/132
// exists to remove: not missing abstraction, but abstraction filed under a tool.
// Moving it here changes no behavior; it changes who owns it.
//
// Two things are deliberately NOT defaulted (docs/132 §132.6 — no tool is the
// default): `agentLabel` and `emit` are REQUIRED. Previously they defaulted to
// Antigravity's label and Antigravity's stdout shape, which made agy the implicit
// baseline and codex the exception. Now both tools are symmetric adapters, and a
// third agent cannot accidentally inherit agy's wire format by omission.
//
// What a plugin supplies is the SHAPE (label, stdout format, exit code, and which
// tools skip the overlay). What the host owns is the BEHAVIOR — parse, inject,
// poll, fail-open vs fail-closed. Getting that split backwards is how the
// duplication started.

import { randomUUID } from 'crypto';
import { join } from 'path';

import { getChannelPort } from '../channel-config.js';

const POLL_INTERVAL_MS = 500;
/** No answer within this window → DENY (never let an unattended tool call proceed). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on waiting for a stdin that never ends, so a hook with nothing piped can't hang. */
const STDIN_CAP_MS = 2000;

export interface PermissionHookIO {
  /** The raw stdin payload the agent pipes in (its PreToolUse-shaped JSON). */
  readStdin: () => Promise<string>;
  /** `http://localhost:<channel-port>` for THIS project, or null if unresolved. */
  channelBaseUrl: () => string | null;
  writeStdout: (s: string) => void;
  fetchFn: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newRequestId: () => string;
}

/**
 * The per-agent half of the bridge. Everything here is a FORMAT or a policy the
 * agent's runner imposes — never a step in the flow.
 */
export interface PermissionHookAdapter {
  /** Overlay description prefix ("<label> wants to use <tool>"). */
  agentLabel: string;
  /**
   * Build the stdout JSON + process exit code for a decision, given the event name
   * from the payload.
   *
   * The exit code is genuinely per-agent, and the difference is not cosmetic:
   * agy treats exit 2 as "blocked", while **codex treats ANY non-zero exit as
   * "the hook failed, proceed"** — verified live on codex-cli 0.145.0, where a
   * deny with exit 2 did NOT block and the same deny with exit 0 did. An agent
   * that inherited the wrong one here would silently stop denying anything.
   */
  emit: (decision: 'allow' | 'deny', eventName: string) => { stdout: string; exitCode: number };
  /**
   * Tool names to ALLOW instantly without surfacing the overlay — e.g. Hot Sheet's
   * own `hotsheet_*` control-plane MCP calls, since gating our own machinery would
   * spam the user with permission popups they never asked to review.
   */
  autoAllow?: (toolName: string) => boolean;
}

/** The hook payload (only the fields we use). Claude-shaped — agy and codex both
 *  emit this; codex additionally sets `hook_event_name`. */
interface PreToolUsePayload { hook_event_name?: string; tool_name?: string; tool_input?: unknown }

/**
 * The `hookSpecificOutput.permissionDecision` stdout shape Claude defined and both
 * agy and codex adopted. In the toolkit because two adapters emit it; the exit code
 * that accompanies it is NOT shared (see `emit`).
 */
export function claudeStyleDecisionJson(decision: 'allow' | 'deny', eventName: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, permissionDecision: decision } });
}

function previewInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    const s = JSON.stringify(input);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return '';
  }
}

/** Read all of stdin. Resolves on `end`, on `error`, or after a short cap. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    stdin.setEncoding('utf-8');
    stdin.on('data', (c: string | Buffer) => { data += typeof c === 'string' ? c : c.toString('utf-8'); });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), STDIN_CAP_MS).unref();
  });
}

/**
 * The concrete IO every hook CLI needs, identically. This block was written out
 * TWICE verbatim — `antigravityPermissionHookCli.ts` and `codexPermissionHook.ts`
 * — including the same 2 s stdin cap, which is the toolkit rule's textbook case:
 * if two plugins would write the same code, it belongs to the host.
 *
 * Both agents run their hook with the PROJECT directory as cwd, which is what makes
 * a single implementation correct — the channel port is resolved from `./.hotsheet`.
 */
export function realPermissionHookIo(): PermissionHookIO {
  const dataDir = join(process.cwd(), '.hotsheet');
  return {
    readStdin,
    channelBaseUrl: () => {
      const port = getChannelPort(dataDir);
      return port !== null && port > 0 ? `http://localhost:${String(port)}` : null;
    },
    writeStdout: (s) => { process.stdout.write(s); },
    fetchFn: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newRequestId: () => randomUUID(),
  };
}

/**
 * Run the permission hook, returning the process exit code the adapter chose.
 *
 * The two failure directions are deliberately OPPOSITE, and this is the load-bearing
 * policy of the whole bridge:
 * - **Unreachable channel → fail OPEN (allow).** A missing or dead Hot Sheet must
 *   never wedge the agent; it degrades silently, like the Claude heartbeat hook.
 * - **Answered by nobody before the deadline → fail CLOSED (deny).** An unattended
 *   run must not silently proceed through a permission the user never saw.
 *
 * "We could not ask" and "we asked and got no answer" are different situations, and
 * collapsing them either way is a real bug: fail-closed on an unreachable channel
 * breaks every headless run, fail-open on a timeout defeats the feature.
 */
export async function runPermissionHook(
  io: PermissionHookIO,
  adapter: PermissionHookAdapter,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number> {
  const raw = await io.readStdin().catch(() => '');
  let payload: PreToolUsePayload = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) payload = parsed; // guarded above
  } catch { /* unparseable → treat as a bare tool */ }
  const toolName = typeof payload.tool_name === 'string' && payload.tool_name !== '' ? payload.tool_name : 'tool';
  const eventName = typeof payload.hook_event_name === 'string' && payload.hook_event_name !== '' ? payload.hook_event_name : 'PreToolUse';
  const emit = (decision: 'allow' | 'deny'): number => {
    const { stdout, exitCode } = adapter.emit(decision, eventName);
    io.writeStdout(stdout);
    return exitCode;
  };

  // Our own control-plane tools pass straight through (no overlay).
  if (adapter.autoAllow !== undefined && adapter.autoAllow(toolName)) return emit('allow');

  const base = io.channelBaseUrl();
  if (base === null) return emit('allow'); // no channel → fail-open

  const requestId = io.newRequestId();
  const injected = await io.fetchFn(`${base}/permission/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      tool_name: toolName,
      description: `${adapter.agentLabel} wants to use ${toolName}`,
      input_preview: previewInput(payload.tool_input),
    }),
  }).then(() => true).catch(() => false);
  if (!injected) return emit('allow'); // couldn't reach the channel → fail-open

  const deadline = io.now() + timeoutMs;
  while (io.now() < deadline) {
    const decision = await io.fetchFn(`${base}/permission/decision?request_id=${encodeURIComponent(requestId)}`)
      .then(async (r): Promise<{ decided?: boolean; behavior?: 'allow' | 'deny' | null } | null> => {
        const body: unknown = await r.json();
        return typeof body === 'object' && body !== null ? body : null;
      })
      .catch(() => null);
    if (decision?.decided === true) {
      return decision.behavior === 'deny' ? emit('deny') : emit('allow');
    }
    await io.sleep(POLL_INTERVAL_MS);
  }
  // HS-9618 — the hook has now made a final local decision, so its injected
  // request must stop being advertised by the channel. Before this cleanup the
  // hook denied at 2 minutes but a lone channel entry survived for 15 minutes;
  // the cross-project popup poll later replayed those abandoned requests in a
  // rapid burst as soon as another project's active popup closed.
  //
  // Best-effort preserves the existing failure policy: timeout still denies even
  // if the channel disappears between the last poll and this cleanup request.
  await io.fetchFn(`${base}/permission/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: requestId }),
  }).catch(() => null);
  return emit('deny'); // timed out unanswered → fail-closed
}
