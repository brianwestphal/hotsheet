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

/** One loaded thread's identity for model-B selection, from a `thread/read`
 *  response (HS-9431). `cwd` is compared realpath-normalized by the caller.
 *  `rolloutPath` (HS-9438) is the thread's reported rollout JSONL — the daemon
 *  reports it before the file exists, so its ON-DISK existence (not this field)
 *  is what decides whether `thread/resume` can subscribe to the thread. */
export interface LoadedThreadEntry {
  id: string;
  cwd: string | null;
  recencyAt: number;
  rolloutPath: string | null;
}

/**
 * HS-9431 (docs/129 model-B) — extract `{cwd, recencyAt}` from a `thread/read`
 * response (`{ thread: { cwd, recencyAt|updatedAt } }`). Unlike `thread/list`,
 * `thread/read` resolves a **fresh in-memory** thread (a just-launched
 * `codex --remote` terminal with no turn yet) — which is exactly the model-B case
 * `thread/list` misses (it only lists persisted-to-disk sessions). Returns null for
 * a shapeless payload.
 */
export function threadReadEntry(id: string, result: unknown): LoadedThreadEntry | null {
  if (typeof result !== 'object' || result === null) return null;
  const thread = (result as Record<string, unknown>).thread;
  if (typeof thread !== 'object' || thread === null) return null;
  const t = thread as Record<string, unknown>;
  return {
    id,
    cwd: typeof t.cwd === 'string' ? t.cwd : null,
    // recencyAt / updatedAt are epoch-seconds in the captured shape; default 0
    // so an entry without one just sorts oldest.
    recencyAt: typeof t.recencyAt === 'number' ? t.recencyAt
      : (typeof t.updatedAt === 'number' ? t.updatedAt : 0),
    rolloutPath: typeof t.path === 'string' && t.path !== '' ? t.path : null,
  };
}

/**
 * HS-9428/HS-9431 (docs/129 model-B) — pick THE loaded thread the drive should join
 * for a project cwd. Decision (baked in): the loaded thread whose **cwd matches**,
 * tie-broken by most-recent `recencyAt`. Entries come from `thread/read` per
 * `thread/loaded/list` id; `cwd` and each `entry.cwd` are expected already
 * realpath-normalized by the caller (`discoverLiveThreadForCwd`). Returns null when
 * none qualifies → caller falls back to model-A. Pure — unit-tested without a daemon.
 *
 * HS-9438 — `excludeId` drops the drive's OWN model-A thread from the candidates.
 * Without it a drive-owned thread wins on recency as soon as it runs a turn (its
 * `recencyAt` is bumped by the driven turn itself), so the drive would keep
 * re-electing its own off-screen thread over the terminal's live one.
 */
export function pickThreadForCwd(
  entries: readonly LoadedThreadEntry[],
  cwd: string,
  excludeId: string | null = null,
): LoadedThreadEntry | null {
  const candidates = entries
    .filter((e) => e.cwd === cwd && e.id !== excludeId)
    .sort((a, b) => b.recencyAt - a.recencyAt);
  return candidates.length > 0 ? candidates[0] : null;
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
 *  request isn't an approval. */
export interface ApprovalDisplay {
  tool_name: string;
  description: string;
  input_preview: string;
  options: AcpPermissionOption[];
  /** The Bash-rule primary value for the auto-allow gate (the command), when present. */
  autoAllowCommand: string | null;
  /** HS-9586 — which response contract this method answers with. Carried on the
   *  display so the reply site cannot lose track of it between request and
   *  answer; see `APPROVAL_FAMILIES`. */
  family: ApprovalFamily;
}

/**
 * HS-9586 — codex's approval server-requests do NOT share one response shape.
 * There are three, and answering with the wrong one is silently read as a
 * refusal. Verified against `codex app-server generate-json-schema` on
 * codex-cli 0.146.0 (identical in 0.145.0, so this was never a regression — it
 * was wrong from the day the drive shipped):
 *
 * | method                                  | response type                            | `decision` values |
 * |-----------------------------------------|------------------------------------------|-------------------|
 * | `execCommandApproval` (v1)              | `ExecCommandApprovalResponse`            | `approved` / `approved_for_session` / `{denied:{rejection}}` / `abort` / `timed_out` |
 * | `applyPatchApproval` (v1)               | `ApplyPatchApprovalResponse`             | same (`ReviewDecision`) |
 * | `item/commandExecution/requestApproval` | `CommandExecutionRequestApprovalResponse`| `accept` / `acceptForSession` / `decline` / `cancel` |
 * | `item/fileChange/requestApproval`       | `FileChangeRequestApprovalResponse`      | same |
 * | `item/permissions/requestApproval`      | `PermissionsRequestApprovalResponse`     | **no `decision` at all** — requires `permissions` |
 *
 * The reported failure (`npm install motion` approved, codex ran nothing) is the
 * first row: the drive sent `{decision:'accept'}`, which is not a member of
 * `ReviewDecision`, so codex could not read it as an approval.
 */
export type ApprovalFamily = 'review-decision' | 'item-decision' | 'permissions';

const APPROVAL_FAMILIES: Readonly<Partial<Record<string, ApprovalFamily>>> = {
  execCommandApproval: 'review-decision',
  applyPatchApproval: 'review-decision',
  'item/commandExecution/requestApproval': 'item-decision',
  'item/fileChange/requestApproval': 'item-decision',
  'item/permissions/requestApproval': 'permissions',
};

/**
 * The overlay's own option ids. Deliberately NOT codex's wire tokens: the popup
 * is shared with every other agent, and the families spell the same intent
 * differently. Translating once at the reply boundary (`approvalResponseFromReply`)
 * means the UI cannot produce a value the wire rejects.
 */
export type ApprovalChoice = 'allow' | 'allow_session' | 'deny';

const CHOICE_LABELS: Readonly<Record<ApprovalChoice, { name: string; kind: AcpPermissionOption['kind'] }>> = {
  allow: { name: 'Allow', kind: 'allow_once' },
  allow_session: { name: 'Allow for session', kind: 'allow_always' },
  deny: { name: 'Deny', kind: 'reject_once' },
};

const CHOICE_ORDER: readonly ApprovalChoice[] = ['allow', 'allow_session', 'deny'];

/**
 * Choice → the wire tokens that express it, best first. The reply uses the first
 * token this particular request will accept (see `availableDecisions`), so a
 * request that offers no `decline` still gets a valid refusal via `cancel`
 * rather than an invalid one.
 *
 * `denied` is absent here because it is a STRUCT variant, not a bare string —
 * `{decision:'denied'}` would fail to deserialize exactly as `'accept'` did.
 * It is built in `approvalResponseFromReply`.
 */
const WIRE_TOKENS: Readonly<Record<'review-decision' | 'item-decision', Record<ApprovalChoice, readonly string[]>>> = {
  'review-decision': {
    allow: ['approved'],
    allow_session: ['approved_for_session', 'approved'],
    deny: ['abort'], // the structured `denied` is preferred and handled separately
  },
  'item-decision': {
    allow: ['accept'],
    allow_session: ['acceptForSession', 'accept'],
    deny: ['decline', 'cancel'],
  },
};

/**
 * The plain-string decisions this specific request says it accepts, or null when
 * the request doesn't say.
 *
 * ⚠ `availableDecisions` is REAL on the wire but **absent from
 * `codex app-server generate-json-schema`** — checked in both 0.145.0 and
 * 0.146.0. `docs/captured/codex-app-server-0.145.0/server-request-item_commandExecution_requestApproval-1.json`
 * has it. So the generated schema is authoritative for *response* shapes and
 * incomplete for *request* shapes; don't conclude a request field is fake just
 * because the schema omits it.
 *
 * The captured request offers `['accept', {acceptWithExecpolicyAmendment: …},
 * 'cancel']` — note **no `decline`**, which is why refusal has to fall back
 * rather than assume.
 */
function availableStringDecisions(params: Record<string, unknown>): Set<string> | null {
  if (!Array.isArray(params.availableDecisions)) return null;
  const strings = params.availableDecisions.filter((d): d is string => typeof d === 'string');
  return strings.length > 0 ? new Set(strings) : null;
}

/** The first token for `choice` that this request accepts, or null if none does. */
function pickWireToken(
  family: 'review-decision' | 'item-decision',
  choice: ApprovalChoice,
  available: Set<string> | null,
): string | null {
  const candidates = WIRE_TOKENS[family][choice];
  if (available === null) return candidates.length > 0 ? candidates[0] : null;
  return candidates.find(t => available.has(t)) ?? null;
}

/**
 * Whether to OFFER `choice` as a button — the request must accept its *primary*
 * token, not merely a fallback. The fallbacks in `WIRE_TOKENS` exist so a reply
 * is always valid, not so a button can be shown for something the request can't
 * do: "Allow for session" that silently allows only once is a worse lie than not
 * offering it.
 */
function supportsChoice(
  family: 'review-decision' | 'item-decision',
  choice: ApprovalChoice,
  available: Set<string> | null,
): boolean {
  if (available === null) return true;
  const candidates = WIRE_TOKENS[family][choice];
  return candidates.length > 0 && available.has(candidates[0]);
}

/** v1 `execCommandApproval` sends `command` as argv (`string[]`); the v2
 *  `item/*` methods send an already-joined string. Read both — before HS-9586
 *  only the string form was handled, so a v1 approval rendered with no command
 *  in the preview and no value for the auto-allow rule to match. */
function readCommand(params: Record<string, unknown>): string | null {
  if (typeof params.command === 'string') return params.command;
  if (Array.isArray(params.command)) {
    const parts = params.command.filter((p): p is string => typeof p === 'string');
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

export function approvalDisplayFromRequest(method: string, params: Record<string, unknown>): ApprovalDisplay | null {
  const family = APPROVAL_FAMILIES[method];
  if (family === undefined) return null;
  const command = readCommand(params);
  const cwd = typeof params.cwd === 'string' ? params.cwd : null;
  const reason = typeof params.reason === 'string' ? params.reason : null;
  const kindLabel = method.includes('fileChange') ? 'File change'
    : method.includes('permissions') ? 'Permission'
    : 'Shell command';
  // Offer only what this request can actually answer with. "Allow for session"
  // in particular is often unavailable, and offering a button whose token the
  // request rejects is how the original bug felt to the user.
  const available = availableStringDecisions(params);
  // `deny` is always offered: a refusal must always be reachable, and it has a
  // fallback token when the primary one is unavailable.
  const offered = family === 'permissions'
    ? CHOICE_ORDER
    : CHOICE_ORDER.filter(c => c === 'deny' || supportsChoice(family, c, available));
  const options: AcpPermissionOption[] = offered.map(id => ({
    optionId: id,
    name: CHOICE_LABELS[id].name,
    kind: CHOICE_LABELS[id].kind,
  }));
  return {
    tool_name: `Codex: ${kindLabel}`,
    description: reason ?? (command !== null ? 'Codex wants to run a command that needs approval' : 'Codex requests approval'),
    input_preview: [command, cwd !== null ? `cwd: ${cwd}` : null].filter((s): s is string => s !== null).join('\n'),
    options,
    autoAllowCommand: command,
    family,
  };
}

/** What the user chose, normalized. A cancelled/dismissed popup denies, and any
 *  unrecognized option id denies too — an approval must never be inferred from
 *  a value we don't understand. */
function choiceFromReply(reply: { optionId: string } | { cancelled: true }): ApprovalChoice {
  if ('cancelled' in reply) return 'deny';
  return reply.optionId === 'allow' || reply.optionId === 'allow_session' ? reply.optionId : 'deny';
}

/**
 * HS-9586 — the response payload for an approval, in the shape the ANSWERED
 * method actually accepts. This is the function the bug lived in: one payload
 * was sent for all three families.
 *
 * `request` is the original params, needed only by the `permissions` family,
 * whose grant echoes back what was asked for.
 */
export function approvalResponseFromReply(
  family: ApprovalFamily,
  reply: { optionId: string } | { cancelled: true },
  request: Record<string, unknown> = {},
): Record<string, unknown> {
  const choice = choiceFromReply(reply);
  if (family === 'review-decision' || family === 'item-decision') {
    const available = availableStringDecisions(request);
    // `denied` is a STRUCT variant carrying the rejection text, not a bare
    // string, so it is built rather than picked. It is the right refusal for the
    // v1 family: `abort` stops the whole turn, while `denied` lets the agent try
    // something else.
    if (choice === 'deny' && family === 'review-decision') {
      return { decision: { denied: { rejection: 'Denied in Hot Sheet' } } };
    }
    const token = pickWireToken(family, choice, available);
    // A request that accepts none of our tokens for this choice still has to be
    // answered with something valid; refuse rather than approve by accident.
    if (token === null) {
      return family === 'review-decision'
        ? { decision: { denied: { rejection: 'Denied in Hot Sheet' } } }
        : { decision: 'cancel' };
    }
    return { decision: token };
  }
  // `permissions`: there is no decision field. The response IS the grant, so
  // allowing echoes the permissions codex asked for and denying grants an empty
  // profile. `scope` follows the same allow-once / allow-for-session split.
  const requested = typeof request.permissions === 'object' && request.permissions !== null
    ? request.permissions as Record<string, unknown>
    : {};
  const granted = choice === 'allow' || choice === 'allow_session' ? requested : {};
  return { permissions: granted, scope: choice === 'allow_session' ? 'session' : 'turn' };
}

/** The auto-approve payload used when interactive permissions are switched OFF
 *  (docs/121 O4) — same translation, so the opt-out path cannot drift from the
 *  interactive one. That drift is precisely what HS-9586 was. */
export function approvalAutoAcceptResponse(family: ApprovalFamily, request: Record<string, unknown> = {}): Record<string, unknown> {
  return approvalResponseFromReply(family, { optionId: 'allow' }, request);
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
