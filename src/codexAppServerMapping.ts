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
