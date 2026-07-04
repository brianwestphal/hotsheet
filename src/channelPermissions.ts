/**
 * HS-8047 — pending-permission queue for the Hot Sheet channel server.
 *
 * Pre-fix `src/channel.ts` held a single nullable `pendingPermission`
 * slot. When Claude sent a second `permission_request` notification
 * while the user's first popup was still open, the second silently
 * overwrote the first — the popup the user was looking at vanished
 * (auto-dismissed by the main-server long-poll because the first
 * request was no longer in the channel server's `/permission` response)
 * and the first request could never be responded to from the UI.
 *
 * The queue here preserves every concurrently-pending request in arrival
 * order. The wire protocol on the channel server stays single-slot
 * (GET `/permission` returns `{ pending: head }`); once the head is
 * responded to, the next 100 ms poll surfaces the next queued request.
 * No client / main-server changes are needed for the queue to take
 * effect.
 *
 * Lives in its own module so the queue logic is unit-testable without
 * spawning the channel-server process — `src/channel.ts` is a process
 * entry-point with module-top-level `await mcp.connect(...)`.
 */

export interface PendingPermission {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  timestamp: number;
}

/** Two-minute auto-expire window for a stale head that is BLOCKING a newer
 *  request — cleared quickly so the newer request can surface (the single-slot
 *  wire returns only the head). See `peekPending`. */
export const PERMISSION_TTL_MS = 120_000;

/** HS-9299 — much longer backstop window for a LONE pending request (nothing
 *  queued behind it). A lone request is the popup the user may still be
 *  deliberating on, so the 2-minute window (the reported "it vanishes if I don't
 *  answer within a couple minutes" pain) was far too short. It still can't be
 *  `Infinity`: the channel is NOT told when the user answers in the TERMINAL (only
 *  a UI response, a channel disconnect, or this expiry clears an entry), nor when
 *  Claude abandons a request without disconnecting — so a lone stale entry needs a
 *  backstop or a terminal-answered popup would linger until manually dismissed. */
export const PERMISSION_LONE_TTL_MS = 900_000; // 15 minutes

const queue: PendingPermission[] = [];

/** Enqueue a fresh permission request. Duplicates of the same `request_id`
 *  are skipped — defensive against MCP retries that would otherwise show
 *  the same popup twice. */
export function enqueuePermission(perm: PendingPermission): void {
  if (queue.some(p => p.request_id === perm.request_id)) return;
  queue.push(perm);
}

/** Drop expired entries from the head of the queue, then return the head
 *  (or null if empty). The wire endpoint `GET /permission` returns this
 *  value verbatim — see module-top docs for the rationale.
 *
 *  HS-9299 — the head expires against the SHORT `PERMISSION_TTL_MS` only while
 *  it's BLOCKING a newer queued request (`queue.length > 1`); a LONE head gets
 *  the long `PERMISSION_LONE_TTL_MS` backstop, so a request the user is still
 *  deliberating on isn't torn down after a couple minutes, while a terminal-
 *  answered / abandoned lone request still eventually clears. A UI response
 *  (`completePermission`) or a channel disconnect (`clearAllPermissions`) clears
 *  entries immediately regardless.
 *
 *  `now` is injectable for deterministic time-based testing. */
export function peekPending(now: number = Date.now()): PendingPermission | null {
  while (queue.length > 0 && now - queue[0].timestamp > (queue.length > 1 ? PERMISSION_TTL_MS : PERMISSION_LONE_TTL_MS)) {
    queue.shift();
  }
  return queue[0] ?? null;
}

/** Remove the entry matching `request_id` (regardless of position).
 *  Returns true if a match was found + removed.
 *
 *  Position-agnostic so a delayed response to an earlier request still
 *  unblocks Claude properly even if the user has since responded to a
 *  later one (rare in practice — the wire protocol surfaces the head
 *  first — but cheap to handle correctly). */
export function completePermission(request_id: string): boolean {
  const idx = queue.findIndex(p => p.request_id === request_id);
  if (idx === -1) return false;
  queue.splice(idx, 1);
  return true;
}

// HS-9327 — decision retention. Claude gets its permission answer PUSHED back over
// the MCP notification channel; an Antigravity PreToolUse hook (a shell command)
// instead POLLS for the answer. So on `/permission/respond` we record the behavior
// keyed by request_id, and expose it via `getDecision` (the poll endpoint reads it).
interface RecordedDecision { behavior: 'allow' | 'deny'; at: number }
const decisions = new Map<string, RecordedDecision>();
/** Bounded so a long-lived server can't accumulate decisions without limit. */
const DECISION_CAP = 200;

/** Record a resolved permission decision so a polling hook can read it. */
export function recordDecision(request_id: string, behavior: 'allow' | 'deny', now: number = Date.now()): void {
  decisions.set(request_id, { behavior, at: now });
  // Evict the oldest entries once over the cap (insertion order = Map order).
  while (decisions.size > DECISION_CAP) {
    const oldest = decisions.keys().next().value;
    if (oldest === undefined) break;
    decisions.delete(oldest);
  }
}

/** The recorded decision for a request, or null if not yet answered / unknown. */
export function getDecision(request_id: string): 'allow' | 'deny' | null {
  return decisions.get(request_id)?.behavior ?? null;
}

/** Drop every queued permission. The channel server's
 *  `POST /permission/dismiss` endpoint calls this. Pre-HS-8047 dismiss
 *  also nuked the single slot, so this preserves observable behavior. */
export function clearAllPermissions(): void {
  queue.length = 0;
}

/** Test-only inspection of the queue length. Underscore prefix marks it
 *  as private-by-convention; exported unconditionally so the bundler
 *  doesn't need an env-gate. */
export function _pendingCountForTesting(): number {
  return queue.length;
}

/** Test-only deep snapshot of the queue contents (in head-first order),
 *  for assertions about ordering / position-independent removal. */
export function _snapshotForTesting(): PendingPermission[] {
  return queue.map(p => ({ ...p }));
}

/** Test-only reset between tests. */
export function _resetForTesting(): void {
  queue.length = 0;
}
