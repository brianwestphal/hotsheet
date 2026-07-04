// HS-9327 — the PreToolUse permission hook for Antigravity (`agy`), the interactive
// alternative to `--dangerously-skip-permissions`. agy runs this as a shell command
// before each tool call (installed via `.agents/hooks.json`, gated on the
// `antigravity_interactive_permissions` setting). It reads the tool call on stdin,
// surfaces it to Hot Sheet's §47 permission overlay through the channel server,
// WAITS for the user's decision, and emits agy's allow/deny.
//
// Claude gets its permission answer PUSHED over the MCP notification channel; this
// hook has no such back-channel, so it POLLs `/permission/decision` (HS-9327 added
// that endpoint + the decision retention it reads).
//
// The logic is IO-injected so it's fully unit-testable; `runPermissionHookCli`
// (the real entry, wired from `cli.ts`) supplies the concrete IO.

const POLL_INTERVAL_MS = 500;
/** No answer within this window → DENY (never let an unattended tool call proceed). */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface PermissionHookIO {
  /** The raw stdin payload agy pipes in (its PreToolUse JSON). */
  readStdin: () => Promise<string>;
  /** `http://localhost:<channel-port>` for THIS project, or null if unresolved. */
  channelBaseUrl: () => string | null;
  writeStdout: (s: string) => void;
  fetchFn: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newRequestId: () => string;
}

/** agy's PreToolUse payload (only the fields we use; shape assumed Claude-like). */
interface PreToolUsePayload { tool_name?: string; tool_input?: unknown }

/** agy/Claude PreToolUse permission-decision JSON emitted on stdout. */
export function decisionJson(decision: 'allow' | 'deny'): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } });
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

/**
 * Run the hook. Returns the process exit code: **0 = allow, 2 = deny/block** (both
 * also emit the decision JSON on stdout — belt-and-suspenders for whichever channel
 * agy honors). FAIL-OPEN (allow) when the channel can't be reached, so a missing or
 * dead Hot Sheet never wedges the agent — matching the Claude heartbeat hook's
 * silent-degrade. A TIMEOUT with no answer fails CLOSED (deny) — an unattended run
 * shouldn't silently proceed on an unanswered permission.
 */
export async function runPermissionHook(io: PermissionHookIO, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<number> {
  const raw = await io.readStdin().catch(() => '');
  let payload: PreToolUsePayload = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) payload = parsed; // guarded above
  } catch { /* unparseable → treat as a bare tool */ }
  const toolName = typeof payload.tool_name === 'string' && payload.tool_name !== '' ? payload.tool_name : 'tool';

  const base = io.channelBaseUrl();
  if (base === null) return allow(io); // no channel → fail-open

  const requestId = io.newRequestId();
  const injected = await io.fetchFn(`${base}/permission/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      tool_name: toolName,
      description: `Antigravity wants to use ${toolName}`,
      input_preview: previewInput(payload.tool_input),
    }),
  }).then(() => true).catch(() => false);
  if (!injected) return allow(io); // couldn't reach the channel → fail-open

  const deadline = io.now() + timeoutMs;
  while (io.now() < deadline) {
    const decision = await io.fetchFn(`${base}/permission/decision?request_id=${encodeURIComponent(requestId)}`)
      .then(async (r): Promise<{ decided?: boolean; behavior?: 'allow' | 'deny' | null } | null> => {
        const body: unknown = await r.json();
        return typeof body === 'object' && body !== null ? body : null;
      })
      .catch(() => null);
    if (decision?.decided === true) {
      return decision.behavior === 'deny' ? deny(io) : allow(io);
    }
    await io.sleep(POLL_INTERVAL_MS);
  }
  return deny(io); // timed out unanswered → fail-closed
}

function allow(io: PermissionHookIO): number { io.writeStdout(decisionJson('allow')); return 0; }
function deny(io: PermissionHookIO): number { io.writeStdout(decisionJson('deny')); return 2; }
