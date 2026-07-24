// HS-9383 (docs/121 §121.4) — the PURE protocol core of the codex app-server drive:
// line classification, request/notification builders, drive-event mapping, and
// approval-request display mapping. No IO — `codexAppServer.ts` owns the child
// process and side effects; this module is unit-tested against the captured
// 0.145.0 contract (`docs/captured/codex-app-server-0.145.0/`).

import type { AcpPermissionOption } from './acp/acpMapping.js';

/** One parsed line off the app-server's stdout, classified by JSON-RPC role. */
export type AppServerIncoming =
  | { kind: 'response'; id: number | string; result?: unknown; error?: { code?: number; message?: string } }
  | { kind: 'server-request'; id: number | string; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> };

/** Parse + classify one stdout line. Returns null for blank / non-JSON / shapeless
 *  lines (codex may print plain-text warnings to stdout). */
export function classifyAppServerLine(line: string): AppServerIncoming | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  const id = msg.id;
  const method = msg.method;
  const hasId = typeof id === 'number' || typeof id === 'string';
  if (hasId && typeof method === 'string') {
    const params = typeof msg.params === 'object' && msg.params !== null ? msg.params as Record<string, unknown> : {};
    return { kind: 'server-request', id: id, method, params };
  }
  if (hasId) {
    const error = typeof msg.error === 'object' && msg.error !== null ? msg.error as { code?: number; message?: string } : undefined;
    return { kind: 'response', id: id, result: msg.result, error };
  }
  if (typeof method === 'string') {
    const params = typeof msg.params === 'object' && msg.params !== null ? msg.params as Record<string, unknown> : {};
    return { kind: 'notification', method, params };
  }
  return null;
}

/** Serialize one outgoing JSON-RPC message as a JSONL line (newline included). */
export function buildRequestLine(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}
export function buildNotificationLine(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}
export function buildResponseLine(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

/** The thread id out of a `thread/start` / `thread/resume` response (captured shape:
 *  `{ thread: { id } }`; tolerate flat variants). Null when absent. */
export function threadIdFromResponse(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const obj = result as Record<string, unknown>;
  const thread = obj.thread;
  if (typeof thread === 'object' && thread !== null) {
    const id = (thread as Record<string, unknown>).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  const flat = obj.threadId ?? obj.id;
  return typeof flat === 'string' && flat !== '' ? flat : null;
}

/** HS-9394 — the rollout file path out of a thread payload (`{ thread: { path } }` —
 *  the shape shared by `thread/start`/`thread/resume` results AND `thread/started`
 *  notification params). Null when absent. The rollout's on-disk existence gates the
 *  TUI attach command (`codex resume` fails "no rollout found" before it exists). */
export function rolloutPathFromThreadPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const thread = (value as Record<string, unknown>).thread;
  if (typeof thread !== 'object' || thread === null) return null;
  const path = (thread as Record<string, unknown>).path;
  return typeof path === 'string' && path !== '' ? path : null;
}

/**
 * HS-9428 (docs/121 model-B) — the LIVE (in-memory) thread ids from a
 * `thread/loaded/list` response. Captured shape: `{ data: string[] }`. Returns
 * `[]` for any other shape so a missing/older method degrades to "nothing live".
 */
export function loadedThreadIdsFromResponse(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.filter((x): x is string => typeof x === 'string' && x !== '');
}

/** One entry of a `thread/list` response's `data` array, narrowed to the fields
 *  model-B selection needs (captured 0.145.0 shape has these plus more). */
export interface ThreadListEntry {
  id: string;
  cwd: string | null;
  recencyAt: number;
}

function parseThreadListEntries(result: unknown): ThreadListEntry[] {
  if (typeof result !== 'object' || result === null) return [];
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: ThreadListEntry[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const id = obj.id ?? obj.sessionId;
    if (typeof id !== 'string' || id === '') continue;
    out.push({
      id,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
      // recencyAt / updatedAt are epoch-seconds in the captured shape; default 0
      // so an entry without one just sorts oldest.
      recencyAt: typeof obj.recencyAt === 'number' ? obj.recencyAt
        : (typeof obj.updatedAt === 'number' ? obj.updatedAt : 0),
    });
  }
  return out;
}

/**
 * HS-9428 (docs/121 model-B) — pick THE thread the drive should join for a
 * project, from a `thread/list` response, the set of currently-loaded thread ids,
 * and the project cwd. Decision (baked in): the **loaded** thread whose **cwd
 * matches**, tie-broken by most-recent `recencyAt`. Returns null when none
 * qualifies → the caller falls back to model-A (start/resume its own thread).
 *
 * Pure over its inputs so the selection policy is unit-tested without a daemon.
 */
export function pickThreadForCwd(listResult: unknown, loadedIds: readonly string[], cwd: string): string | null {
  const loaded = new Set(loadedIds);
  const candidates = parseThreadListEntries(listResult)
    .filter((e) => loaded.has(e.id) && e.cwd === cwd)
    .sort((a, b) => b.recencyAt - a.recencyAt);
  return candidates.length > 0 ? candidates[0].id : null;
}

/** What a server notification means for the drive's busy/turn lifecycle. */
export type DriveEvent =
  | { type: 'turn-started'; turnId: string | null }
  | { type: 'activity' } // any per-item progress — an event-driven heartbeat
  | { type: 'turn-ended'; status: string | null }
  | { type: 'thread-status'; active: boolean };

/**
 * Map one notification to a drive event (or null for ones the drive ignores).
 * Captured contract: `turn/started`/`turn/completed` carry `params.turn.{id,status}`;
 * `thread/status/changed` carries `params.status.type: 'active'|'idle'`;
 * `item/*` notifications are per-item progress.
 */
export function driveEventFromNotification(method: string, params: Record<string, unknown>): DriveEvent | null {
  if (method === 'turn/started' || method === 'turn/completed') {
    const turn = typeof params.turn === 'object' && params.turn !== null ? params.turn as Record<string, unknown> : {};
    const id = typeof turn.id === 'string' ? turn.id : null;
    if (method === 'turn/started') return { type: 'turn-started', turnId: id };
    return { type: 'turn-ended', status: typeof turn.status === 'string' ? turn.status : null };
  }
  if (method === 'thread/status/changed') {
    const status = typeof params.status === 'object' && params.status !== null ? params.status as Record<string, unknown> : {};
    return { type: 'thread-status', active: status.type === 'active' };
  }
  if (method.startsWith('item/')) return { type: 'activity' };
  return null;
}

/** Display fields + overlay options for an approval server-request; null when the
 *  request isn't an approval. Captured shape (`item/commandExecution/requestApproval`):
 *  params carry `command`, `cwd`, and `availableDecisions` (strings + structured
 *  variants — only the plain string decisions are offered as overlay options). */
export interface ApprovalDisplay {
  tool_name: string;
  description: string;
  input_preview: string;
  options: AcpPermissionOption[];
  /** The Bash-rule primary value for the auto-allow gate (the command), when present. */
  autoAllowCommand: string | null;
}

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

const DECISION_LABELS: Readonly<Record<string, { name: string; kind: AcpPermissionOption['kind'] }>> = {
  accept: { name: 'Allow', kind: 'allow_once' },
  acceptForSession: { name: 'Allow for session', kind: 'allow_always' },
  decline: { name: 'Deny', kind: 'reject_once' },
  cancel: { name: 'Cancel', kind: 'reject_once' },
};

export function approvalDisplayFromRequest(method: string, params: Record<string, unknown>): ApprovalDisplay | null {
  if (!APPROVAL_METHODS.has(method)) return null;
  const command = typeof params.command === 'string' ? params.command : null;
  const cwd = typeof params.cwd === 'string' ? params.cwd : null;
  const reason = typeof params.reason === 'string' ? params.reason : null;
  const kindLabel = method.includes('fileChange') ? 'File change'
    : method.includes('permissions') ? 'Permission'
    : 'Shell command';
  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
  const decisionIds = available.filter((d): d is string => typeof d === 'string' && d in DECISION_LABELS);
  // Always offer at least allow/deny even if availableDecisions was absent/structured-only.
  const ids = decisionIds.length >= 2 ? decisionIds : ['accept', 'decline'];
  const options: AcpPermissionOption[] = ids.map(id => ({
    optionId: id,
    name: DECISION_LABELS[id].name,
    kind: DECISION_LABELS[id].kind,
  }));
  return {
    tool_name: `Codex: ${kindLabel}`,
    description: reason ?? (command !== null ? 'Codex wants to run a command that needs approval' : 'Codex requests approval'),
    input_preview: [command, cwd !== null ? `cwd: ${cwd}` : null].filter((s): s is string => s !== null).join('\n'),
    options,
    autoAllowCommand: command,
  };
}

/** The decision payload for an overlay reply. A cancelled/dismissed popup declines. */
export function decisionFromReply(reply: { optionId: string } | { cancelled: true }): { decision: string } {
  if ('cancelled' in reply) return { decision: 'decline' };
  return { decision: reply.optionId };
}

/** HS-9395 — display fields for an MCP tool-call elicitation server-request
 *  (`mcpServer/elicitation/request`, `_meta.codex_approval_kind: 'mcp_tool_call'`);
 *  null for other methods. Captured shape: params carry `serverName`, a human
 *  `message` (`Allow the <server> MCP server to run tool "<name>"?`), and
 *  `_meta.tool_params`. NOTE the response shape differs from the requestApproval
 *  family — reply via `elicitationResponseFromReply`, not `decisionFromReply`. */
export interface ElicitationDisplay {
  /** The MCP server config key (e.g. `hotsheet-channel`) — the auto-accept gate. */
  serverName: string;
  tool_name: string;
  description: string;
  input_preview: string;
  options: AcpPermissionOption[];
}

export function elicitationDisplayFromRequest(method: string, params: Record<string, unknown>): ElicitationDisplay | null {
  if (method !== 'mcpServer/elicitation/request') return null;
  const serverName = typeof params.serverName === 'string' ? params.serverName : '';
  const message = typeof params.message === 'string' ? params.message : '';
  const meta = typeof params._meta === 'object' && params._meta !== null ? params._meta as Record<string, unknown> : {};
  const toolName = /tool "([^"]+)"/.exec(message)?.[1] ?? null;
  const toolParams = meta.tool_params;
  return {
    serverName,
    tool_name: `Codex: MCP tool${toolName !== null ? ` (${toolName})` : ''}`,
    description: message !== '' ? message : 'Codex wants to call an MCP tool',
    input_preview: toolParams !== undefined ? JSON.stringify(toolParams) : '',
    options: [
      { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
      { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
    ],
  };
}

/** HS-9395 — the `McpServerElicitationRequestResponse` payload for an overlay reply.
 *  `action` is REQUIRED (the shipped drive's generic `{}` reply read as a decline —
 *  the root cause of driven sessions' hotsheet tools failing); accepted elicitations
 *  carry empty `content` (the captured requestedSchema has no fields). */
export function elicitationResponseFromReply(reply: { optionId: string } | { cancelled: true }): { action: string; content?: Record<string, never> } {
  if ('cancelled' in reply || reply.optionId !== 'accept') return { action: 'decline' };
  return { action: 'accept', content: {} };
}

/**
 * HS-9388 — the per-thread `config` override for `thread/start`/`thread/resume`
 * in DAEMON mode: pins the hotsheet-channel MCP server to this project (absolute
 * `--data-dir` — the shared daemon's cwd is not the project's) and marks its env
 * so the channel server registers `drive: true` (HS-9380) no matter who started
 * the daemon or from where. Live-verified on 0.145.0: the override is honored
 * per-thread and the given env is MERGED into the child's (PATH survives).
 */
export function buildThreadMcpOverride(mcpKey: string, channel: { command: string; args: string[] }, dataDir: string): Record<string, unknown> {
  return {
    mcp_servers: {
      [mcpKey]: {
        command: channel.command,
        args: [...channel.args, '--data-dir', dataDir],
        env: { HOTSHEET_DRIVE_SPAWNED: '1' },
      },
    },
  };
}

/**
 * HS-9385 (docs/121 §121.6 phase 1) — one Commands Log transcript line from an
 * `item/completed` notification's params, or null for items the transcript skips
 * (empty/partial agent messages, reasoning, the user's own prompt — already logged
 * as the trigger). Captured item shapes: `agentMessage {text, phase}`,
 * `commandExecution {command, aggregatedOutput, exitCode}`.
 */
export function transcriptLineFromItem(params: Record<string, unknown>): string | null {
  const item = typeof params.item === 'object' && params.item !== null ? params.item as Record<string, unknown> : null;
  if (item === null) return null;
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    return text === '' ? null : text;
  }
  if (item.type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : '';
    if (command === '') return null;
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trimEnd() : '';
    const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
    const head = `$ ${command}${exit !== null && exit !== 0 ? `  (exit ${String(exit)})` : ''}`;
    return output === '' ? head : `${head}\n${output}`;
  }
  return null; // reasoning / userMessage / unknown — skipped
}

/** HS-9385 — append a transcript line to the accumulated detail under a size cap.
 *  Once over the cap, the detail is frozen with a single truncation marker (the
 *  Commands Log entry stays scannable; the full stream is phase-2 territory). */
export function appendTranscriptDetail(existing: string, line: string, cap: number): { detail: string; truncated: boolean } {
  if (existing.endsWith(TRANSCRIPT_TRUNCATION_MARKER)) return { detail: existing, truncated: true };
  const next = existing === '' ? line : `${existing}\n\n${line}`;
  if (next.length <= cap) return { detail: next, truncated: false };
  return { detail: `${next.slice(0, cap)}\n${TRANSCRIPT_TRUNCATION_MARKER}`, truncated: true };
}

export const TRANSCRIPT_TRUNCATION_MARKER = '…[transcript truncated]';
