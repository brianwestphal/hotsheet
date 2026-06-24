/**
 * HS-8346 — MCP tools surface for the Claude Channel server.
 *
 * Each tool validates its input against a Zod schema, proxies the call
 * to the main Hot Sheet server's REST API (`http://localhost:<port>/api/...`)
 * using `port` + `secret` from `<dataDir>/settings.json`, and returns the
 * response body verbatim as the MCP tool result. On any failure —
 * Zod validation, missing settings.json, network error, non-2xx HTTP
 * response — the tool returns an `isError: true` MCP `CallToolResult`
 * with a human-readable message. See `docs/63-mcp-tools.md` for the
 * design + tool catalog.
 *
 * Why proxy-to-localhost-HTTP, not direct PGLite access? The channel
 * server runs as a separate process from the main Hot Sheet server
 * (spawned by Claude Code over stdio). Routing through the existing
 * REST API dedupes every piece of business logic (Zod validation,
 * markdown sync, change-version bumping, attachment-backup hashing) —
 * the only cost is a ~1 ms localhost hop dwarfed by the LLM round-trip
 * the tool call sits inside. See §63.3.
 */
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { z } from 'zod';

import { readFileSettings } from './file-settings.js';
import {
  TicketPrioritySchema,
  TicketStatusSchema,
} from './routes/validation.js';
import { getProjectSecret } from './secret-file.js';

/** Shape of the MCP `tools/list` response entry per the MCP spec. */
export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Shape of the MCP `tools/call` response — success or error. The MCP
 *  SDK normalizes `isError` into a structured-error result the agent
 *  sees as a tool-call failure with a readable message attached. */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface ChannelSettings {
  port: number;
  secret: string;
}

// HS-8567 — strict zod schema for the resolved file settings. Only `port` is
// validated here; the secret is sourced separately from the sidecar (HS-8999).
// `.loose()` keeps the rest of the (large) settings object intact.
const ChannelSettingsSchema = z.object({
  port: z.number().int().positive(),
}).loose();

/**
 * Resolve the channel's connection settings: the main server's `port` + the
 * project `secret`. Returns null on any error (missing/invalid files, missing
 * port, empty secret); the caller surfaces a user-readable error via
 * `errorResult`. Pure (modulo fs read) for testability — the test passes a
 * tmpdir-rooted path.
 *
 * HS-9007 — read the RESOLVED file settings (`settings.json` overlaid with the
 * gitignored `settings.local.json`, local winning) rather than `settings.json`
 * alone. HS-9002's `migrateLocalScopedKeys` relocated `port` (a LOCAL_SCOPE_KEY)
 * into `settings.local.json`, so the original settings.json-only read started
 * returning null on every migrated project — the "could not read settings.json"
 * failure. The secret already moved to the `secret.json` sidecar (HS-8999) and
 * is read via `getProjectSecret` (which falls back to a legacy inline secret).
 */
export function loadChannelSettings(dataDir: string): ChannelSettings | null {
  try {
    const resolved = readFileSettings(dataDir);
    const result = ChannelSettingsSchema.safeParse(resolved);
    if (!result.success) return null;
    const secret = getProjectSecret(dataDir);
    if (secret === '') return null;
    return { port: result.data.port, secret };
  } catch {
    return null;
  }
}

/** Helper — build a structured-error tool result with a readable
 *  message. Always sets `isError: true`. */
export function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Helper — build a happy-path tool result wrapping JSON-stringified
 *  response data. */
function okResult(data: unknown): ToolCallResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }] };
}

/** Issue a localhost HTTP request to the main Hot Sheet server.
 *  Returns the parsed response on success (HTTP 2xx), or an
 *  `errorResult` on failure. The `fetch` function is injected so tests
 *  can drive every branch (HTTP error, network error, JSON parse
 *  failure) without spinning up a server. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

async function proxyRequest(
  settings: ChannelSettings,
  path: string,
  init: { method?: string; body?: unknown } | undefined,
  fetchFn: FetchLike,
): Promise<ToolCallResult> {
  const url = `http://localhost:${String(settings.port)}${path}`;
  const headers: Record<string, string> = {
    'X-Hotsheet-Secret': settings.secret,
  };
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { method: init?.method ?? 'GET', headers, body });
  } catch (err) {
    return errorResult(`Channel tool — network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    return errorResult(`Channel tool — HTTP ${String(res.status)} from ${path}: ${text.slice(0, 500)}`);
  }
  return okResult(text);
}

// ---------------------------------------------------------------------------
// Per-tool Zod schemas. These are SEPARATE from the REST API's Zod
// schemas (`src/routes/validation.ts`) because the tool input shape is
// FLATTER for ergonomic agent prompting — e.g. `hotsheet_create_ticket`
// takes `{title, category, details, up_next, priority, tags}` directly
// instead of the REST API's nested `{title, defaults: {category, ...}}`
// shape. The tool dispatchers map between the two.
//
// `TicketPrioritySchema` and `TicketStatusSchema` are reused verbatim
// from `validation.ts` — the enum values are the source of truth for
// the REST API and re-using them keeps the two surfaces in lockstep.
// ---------------------------------------------------------------------------

const UpdateTicketInputSchema = z.object({
  id: z.number().int().describe('Ticket id (numeric, e.g. 42)'),
  status: TicketStatusSchema.optional(),
  notes: z.string().optional().describe('Append a new note. Pass the markdown body as a plain string (NOT a JSON array — the server wraps the text in `{id, text, created_at}` automatically). HS-8427 — if you mistakenly pass a JSON-stringified note array like `[{"text":"..."}]`, the server unwraps it defensively so the body renders correctly, but plain text is the documented + preferred shape.'),
  priority: TicketPrioritySchema.optional(),
  category: z.string().optional().describe('Category id (e.g. "bug", "feature", "task", "issue")'),
  up_next: z.boolean().optional(),
  tags: z.string().optional().describe('Tags JSON array as a string, e.g. \'["urgent","docs"]\''),
  title: z.string().optional(),
  details: z.string().optional(),
});

const CreateTicketInputSchema = z.object({
  title: z.string().min(1).describe('The ticket title (required, non-empty)'),
  category: z.string().optional().describe('Category id (e.g. "bug", "feature", "task", "issue"). Defaults server-side when omitted.'),
  details: z.string().optional(),
  up_next: z.boolean().optional().describe('Set true to mark the new ticket as Up Next immediately'),
  priority: TicketPrioritySchema.optional(),
  tags: z.string().optional(),
});

const SignalDoneInputSchema = z.object({}).describe('No arguments — signals the agent is idle on the current channel event.');

const AddAttachmentInputSchema = z.object({
  ticket_id: z.number().int().describe('The id of the ticket the attachment belongs to'),
  path: z.string().min(1).describe('Absolute path to the file on disk. The channel server reads the file and posts it multipart on the agent\'s behalf.'),
});

const RequestFeedbackInputSchema = z.object({
  ticket_id: z.number().int().describe('The id of the ticket to add the feedback prompt to'),
  question: z.string().min(1).describe('The question text. The tool prepends FEEDBACK NEEDED: / IMMEDIATE FEEDBACK NEEDED: depending on `urgent`.'),
  urgent: z.boolean().optional().describe('When true, uses the IMMEDIATE FEEDBACK NEEDED prefix (auto-selects the ticket in the UI). Defaults to false.'),
});

// HS-8347 — Phase 2 tools (9 more, bringing the surface to 14 total).
// Each tool reuses the proxy helper from Phase 1; the Zod schemas are
// per-tool (not reused verbatim from `src/routes/validation.ts`) because
// the tool input shape is FLAT and agent-ergonomic — e.g.
// `hotsheet_edit_note` takes `{ticket_id, note_id, text}` directly
// rather than splitting `id` + `noteId` into URL params and `{text}` into
// the body the way the REST API does.

const GetTicketInputSchema = z.object({
  id: z.number().int().describe('Ticket id (numeric)'),
});

const DeleteTicketInputSchema = z.object({
  id: z.number().int().describe('Ticket id to soft-delete (move to trash)'),
});

const RestoreTicketInputSchema = z.object({
  id: z.number().int().describe('Ticket id to restore from trash'),
});

const ToggleUpNextInputSchema = z.object({
  id: z.number().int().describe('Ticket id whose up_next flag to toggle'),
});

const DuplicateTicketsInputSchema = z.object({
  ids: z.array(z.number().int()).min(1).describe('Ticket ids to duplicate (one or more)'),
});

// HS-8862 — distributed-execution claim/lease tools (docs/90 §90.4).
const ClaimNextInputSchema = z.object({
  worker: z.string().min(1).describe('This worker\'s identity (stable per worker, e.g. "worker-2")'),
  label: z.string().nullish().describe('Optional human-friendly worker label shown in the UI'),
  ttlSeconds: z.number().int().positive().max(3600).optional().describe('Lease TTL in seconds (default 120)'),
});
const RenewLeaseInputSchema = z.object({
  id: z.number().int().describe('Ticket id whose lease to renew (heartbeat)'),
  worker: z.string().min(1).describe('The worker holding the claim (must match)'),
  ttlSeconds: z.number().int().positive().max(3600).optional().describe('New lease TTL in seconds (default 120)'),
});
const ReleaseInputSchema = z.object({
  id: z.number().int().describe('Ticket id to release'),
  worker: z.string().nullish().describe('The worker holding the claim; omit to force-release (owner)'),
});

// HS-8865 — flat blocked_by dependency gate (docs/90 §90.6).
const SetBlockedByInputSchema = z.object({
  ticket_id: z.number().int().describe('The dependent ticket whose blocker set to replace'),
  blocker_ids: z.array(z.number().int()).describe('Ticket ids this one waits on (flat, replaces the existing set; [] clears). Rejected on self/cycle/unknown ticket.'),
});

const BatchInputSchema = z.object({
  ids: z.array(z.number().int()).min(1).describe('Ticket ids to operate on (one or more)'),
  action: z.enum(['delete', 'restore', 'category', 'priority', 'status', 'up_next', 'mark_read', 'mark_unread']).describe('Batch action to apply'),
  value: z.union([z.string(), z.boolean()]).optional().describe('Required for category / priority / status / up_next; ignored otherwise'),
});

const EditNoteInputSchema = z.object({
  ticket_id: z.number().int().describe('The id of the ticket the note belongs to'),
  note_id: z.string().min(1).describe('The note id (client-generated, e.g. "cn_..." or server-assigned)'),
  text: z.string().describe('The new note text. Empty string clears the note body but keeps the entry; use `hotsheet_delete_note` to remove a note entirely.'),
});

const DeleteNoteInputSchema = z.object({
  ticket_id: z.number().int().describe('The id of the ticket the note belongs to'),
  note_id: z.string().min(1).describe('The note id to delete'),
});

const QueryTicketsInputSchema = z.object({
  logic: z.enum(['all', 'any']).describe('Combine conditions with AND (`all`) or OR (`any`)'),
  conditions: z.array(z.object({
    field: z.enum(['category', 'priority', 'status', 'title', 'details', 'up_next', 'tags']),
    operator: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'lt', 'lte', 'gt', 'gte']),
    value: z.string().describe('Comparison value as a string (the REST API parses based on field/operator)'),
  })).describe('One or more conditions to combine via `logic`'),
  sort_by: z.string().optional().describe('Field name to sort by (e.g. "created", "modified", "priority")'),
  sort_dir: z.enum(['asc', 'desc']).optional(),
  required_tag: z.string().optional().describe('When set, only tickets carrying this tag are included'),
  include_archived: z.boolean().optional(),
});

// HS-8771 — push a curated Announcer highlight (§80 hybrid generation).
// HS-8772 — optionally attach a code diff the PIP renders alongside the script.
const AnnounceInputSchema = z.object({
  title: z.string().min(1).describe('A few words naming the moment (e.g. "Fixed the data-loss bug").'),
  highlight: z.string().min(1).describe('One or two short sentences of natural spoken English to read aloud — what happened and why it matters.'),
  diff: z.object({
    oldStr: z.string().describe('The code BEFORE the change (the focused snippet you changed, not the whole file).'),
    newStr: z.string().describe('The code AFTER the change.'),
    filePath: z.string().optional().describe('Optional file path shown as the diff header.'),
  }).optional().describe('Optional code diff to display with this highlight — supply the before/after of the focused change you want to show off.'),
});

// ---------------------------------------------------------------------------
// Tool dispatcher. Each branch validates its input via the per-tool
// schema, maps to the appropriate REST endpoint shape, and proxies via
// `proxyRequest`. The settings + fetchFn arguments are injected so
// tests can drive every branch without a live HTTP server.
// ---------------------------------------------------------------------------

async function dispatchUpdateTicket(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = UpdateTicketInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_update_ticket — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { id, ...patch } = parsed.data;
  return await proxyRequest(settings, `/api/tickets/${String(id)}`, { method: 'PATCH', body: patch }, fetchFn);
}

async function dispatchCreateTicket(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = CreateTicketInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_create_ticket — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  // Map the flat tool input to the REST API's nested `{title, defaults: {...}}` shape.
  const { title, ...defaults } = parsed.data;
  const body: Record<string, unknown> = { title };
  if (Object.keys(defaults).length > 0) body.defaults = defaults;
  return await proxyRequest(settings, '/api/tickets', { method: 'POST', body }, fetchFn);
}

async function dispatchSignalDone(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = SignalDoneInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_signal_done — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, '/api/channel/done', { method: 'POST' }, fetchFn);
}

async function dispatchAddAttachment(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = AddAttachmentInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_add_attachment — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { ticket_id, path: filePath } = parsed.data;
  // Read the file from disk + post multipart. Wrapped in try / catch so
  // missing files / permission errors surface as readable errors instead
  // of unhandled rejections.
  let fileBytes: Buffer;
  let fileName: string;
  try {
    fileBytes = readFileSync(filePath);
    fileName = basename(filePath);
  } catch (err) {
    return errorResult(`hotsheet_add_attachment — could not read file at "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(fileBytes)]), fileName);
  // Multipart needs the FormData body — special-case the proxyRequest
  // path because the helper above sets Content-Type: application/json
  // for any non-undefined body, which conflicts with FormData's
  // auto-generated multipart boundary.
  const url = `http://localhost:${String(settings.port)}/api/tickets/${String(ticket_id)}/attachments`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'X-Hotsheet-Secret': settings.secret },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      return errorResult(`hotsheet_add_attachment — HTTP ${String(res.status)}: ${text.slice(0, 500)}`);
    }
    return okResult(text);
  } catch (err) {
    return errorResult(`hotsheet_add_attachment — network error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function dispatchRequestFeedback(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = RequestFeedbackInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_request_feedback — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { ticket_id, question, urgent } = parsed.data;
  const prefix = urgent === true ? 'IMMEDIATE FEEDBACK NEEDED:' : 'FEEDBACK NEEDED:';
  // PATCH the ticket with the prefixed note. The REST API treats the
  // `notes` field on update as the note BODY text (the server appends
  // it as a new note); the worklist documents this in the
  // `Requesting User Feedback` section.
  return await proxyRequest(settings, `/api/tickets/${String(ticket_id)}`, {
    method: 'PATCH',
    body: { notes: `${prefix} ${question}` },
  }, fetchFn);
}

// HS-8347 dispatchers — Phase 2 (9 new tools).

async function dispatchGetTicket(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = GetTicketInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_get_ticket — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, `/api/tickets/${String(parsed.data.id)}`, { method: 'GET' }, fetchFn);
}

async function dispatchDeleteTicket(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = DeleteTicketInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_delete_ticket — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, `/api/tickets/${String(parsed.data.id)}`, { method: 'DELETE' }, fetchFn);
}

async function dispatchRestoreTicket(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = RestoreTicketInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_restore_ticket — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, `/api/tickets/${String(parsed.data.id)}/restore`, { method: 'POST' }, fetchFn);
}

async function dispatchToggleUpNext(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = ToggleUpNextInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_toggle_up_next — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, `/api/tickets/${String(parsed.data.id)}/up-next`, { method: 'POST' }, fetchFn);
}

async function dispatchDuplicateTickets(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = DuplicateTicketsInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_duplicate_tickets — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, '/api/tickets/duplicate', { method: 'POST', body: { ids: parsed.data.ids } }, fetchFn);
}

async function dispatchBatch(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = BatchInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_batch — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, '/api/tickets/batch', { method: 'POST', body: parsed.data }, fetchFn);
}

async function dispatchEditNote(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = EditNoteInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_edit_note — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { ticket_id, note_id, text } = parsed.data;
  return await proxyRequest(settings, `/api/tickets/${String(ticket_id)}/notes/${encodeURIComponent(note_id)}`, {
    method: 'PATCH',
    body: { text },
  }, fetchFn);
}

async function dispatchDeleteNote(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = DeleteNoteInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_delete_note — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { ticket_id, note_id } = parsed.data;
  return await proxyRequest(settings, `/api/tickets/${String(ticket_id)}/notes/${encodeURIComponent(note_id)}`, { method: 'DELETE' }, fetchFn);
}

async function dispatchAnnounce(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = AnnounceInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_announce — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, '/api/announcer/announce', { method: 'POST', body: parsed.data }, fetchFn);
}

async function dispatchQueryTickets(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = QueryTicketsInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_query_tickets — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, '/api/tickets/query', { method: 'POST', body: parsed.data }, fetchFn);
}

async function dispatchClaimNext(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = ClaimNextInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_claim_next — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return await proxyRequest(settings, '/api/tickets/claim-next', { method: 'POST', body: parsed.data }, fetchFn);
}

async function dispatchRenewLease(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = RenewLeaseInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_renew_lease — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { id, worker, ttlSeconds } = parsed.data;
  return await proxyRequest(settings, `/api/tickets/${String(id)}/renew-lease`, { method: 'POST', body: { worker, ttlSeconds } }, fetchFn);
}

async function dispatchRelease(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = ReleaseInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_release — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { id, worker } = parsed.data;
  return await proxyRequest(settings, `/api/tickets/${String(id)}/release`, { method: 'POST', body: { worker } }, fetchFn);
}

async function dispatchSetBlockedBy(args: unknown, settings: ChannelSettings, fetchFn: FetchLike): Promise<ToolCallResult> {
  const parsed = SetBlockedByInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`hotsheet_set_blocked_by — validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { ticket_id, blocker_ids } = parsed.data;
  return await proxyRequest(settings, `/api/tickets/${String(ticket_id)}/blocked-by`, { method: 'PUT', body: { blockerIds: blocker_ids } }, fetchFn);
}

// ---------------------------------------------------------------------------
// Public tool catalog + top-level dispatcher.
// ---------------------------------------------------------------------------

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  call: (args: unknown, settings: ChannelSettings, fetchFn: FetchLike) => Promise<ToolCallResult>;
}

const TOOLS: ToolEntry[] = [
  {
    name: 'hotsheet_update_ticket',
    description: 'Update an existing ticket. Supports status / notes (replaces the JSON notes array) / priority / category / up_next / tags / title / details. Status updates trigger markdown sync and the standard ticket-update flow on the Hot Sheet UI.',
    inputSchema: UpdateTicketInputSchema,
    call: dispatchUpdateTicket,
  },
  {
    name: 'hotsheet_create_ticket',
    description: 'Create a new ticket. Title is required. Category / priority / up_next / details / tags default server-side when omitted.',
    inputSchema: CreateTicketInputSchema,
    call: dispatchCreateTicket,
  },
  {
    name: 'hotsheet_signal_done',
    description: 'Signal that the agent is idle on the current channel event. Replaces the trailing curl POST /api/channel/done at the bottom of every worklist event.',
    inputSchema: SignalDoneInputSchema,
    call: dispatchSignalDone,
  },
  {
    name: 'hotsheet_add_attachment',
    description: 'Attach a file to a ticket. The agent passes the absolute path on disk; the channel server reads the file and posts it multipart on the agent\'s behalf — the agent never deals with -F form syntax.',
    inputSchema: AddAttachmentInputSchema,
    call: dispatchAddAttachment,
  },
  {
    name: 'hotsheet_request_feedback',
    description: 'Add a FEEDBACK NEEDED note to a ticket. The tool prepends FEEDBACK NEEDED: (default) or IMMEDIATE FEEDBACK NEEDED: (when urgent=true) to the question text. Saves the agent from remembering the exact prefix syntax.',
    inputSchema: RequestFeedbackInputSchema,
    call: dispatchRequestFeedback,
  },
  // HS-8347 — Phase 2: 9 more tools (14 total).
  {
    name: 'hotsheet_get_ticket',
    description: 'Read a single ticket\'s current state by id. Returns the full ticket JSON including title, status, category, priority, up_next, tags, notes, details, and timestamps.',
    inputSchema: GetTicketInputSchema,
    call: dispatchGetTicket,
  },
  {
    name: 'hotsheet_delete_ticket',
    description: 'Soft-delete a ticket (move to trash). The ticket can be restored via hotsheet_restore_ticket. Use hotsheet_batch with action=delete to soft-delete many tickets at once.',
    inputSchema: DeleteTicketInputSchema,
    call: dispatchDeleteTicket,
  },
  {
    name: 'hotsheet_restore_ticket',
    description: 'Restore a soft-deleted ticket from trash back to its previous status.',
    inputSchema: RestoreTicketInputSchema,
    call: dispatchRestoreTicket,
  },
  {
    name: 'hotsheet_toggle_up_next',
    description: 'Toggle a ticket\'s up_next flag (the star in the UI). Marking up_next from a backlog/archive status also resets the status to not_started.',
    inputSchema: ToggleUpNextInputSchema,
    call: dispatchToggleUpNext,
  },
  {
    name: 'hotsheet_duplicate_tickets',
    description: 'Duplicate one or more tickets. The copies are created with the same fields as the originals but receive fresh ids and timestamps.',
    inputSchema: DuplicateTicketsInputSchema,
    call: dispatchDuplicateTickets,
  },
  {
    name: 'hotsheet_batch',
    description: 'Apply a batch action (delete / restore / category / priority / status / up_next / mark_read / mark_unread) to one or more tickets at once. `value` is required for category / priority / status / up_next; ignored for the others.',
    inputSchema: BatchInputSchema,
    call: dispatchBatch,
  },
  {
    name: 'hotsheet_edit_note',
    description: 'Edit an individual note on a ticket by note_id. The body of the note (note.text) is replaced with the provided text. To add a new note instead, use hotsheet_update_ticket with the `notes` field (which appends a new note).',
    inputSchema: EditNoteInputSchema,
    call: dispatchEditNote,
  },
  {
    name: 'hotsheet_delete_note',
    description: 'Delete an individual note from a ticket by note_id. The note is removed entirely; use hotsheet_edit_note with empty text to clear the body while keeping the entry.',
    inputSchema: DeleteNoteInputSchema,
    call: dispatchDeleteNote,
  },
  {
    name: 'hotsheet_query_tickets',
    description: 'Run a custom-view-style query: combine field/operator/value conditions via AND (logic="all") or OR (logic="any"), with optional sort_by / sort_dir / required_tag / include_archived. Returns the matching tickets. For agents that need to dig deeper than the worklist provides.',
    inputSchema: QueryTicketsInputSchema,
    call: dispatchQueryTickets,
  },
  // HS-8862 — distributed-execution claim/lease (§90.4). A worker agent drains
  // the Up Next pool: claim_next → work → (renew_lease while working) → release.
  {
    name: 'hotsheet_claim_next',
    description: 'Atomically claim the highest-priority Up Next ticket that is unclaimed (or whose lease expired) for this worker, so parallel workers never grab the same ticket. Returns {ticket} (the claimed ticket) or {ticket:null} when nothing is claimable. Work the returned ticket, then hotsheet_release it (and set status=completed via hotsheet_update_ticket).',
    inputSchema: ClaimNextInputSchema,
    call: dispatchClaimNext,
  },
  {
    name: 'hotsheet_renew_lease',
    description: 'Heartbeat: extend the claim lease on a ticket this worker is still working. Returns {ok:false} if the claim lapsed/was reclaimed (re-claim before continuing). Call periodically (well within the TTL) during long tickets.',
    inputSchema: RenewLeaseInputSchema,
    call: dispatchRenewLease,
  },
  {
    name: 'hotsheet_release',
    description: 'Release a claim on a ticket (on completion or to hand it back). Idempotent. Pass the same `worker` that claimed it; omit `worker` only for an owner force-release.',
    inputSchema: ReleaseInputSchema,
    call: dispatchRelease,
  },
  {
    name: 'hotsheet_set_blocked_by',
    description: 'Set a ticket\'s flat dependency gate: the list of ticket ids it waits on (replaces the existing set; [] clears). A blocked ticket is skipped by claim-next until every blocker is completed/verified. For a planning pass to express ordering. Rejected (400) on a self-block, an unknown ticket, or a dependency cycle. FLAT only — not a parent/child tree.',
    inputSchema: SetBlockedByInputSchema,
    call: dispatchSetBlockedBy,
  },
  // HS-8771 — hybrid Announcer generation (§80).
  {
    name: 'hotsheet_announce',
    description: 'Push a curated Announcer highlight for a genuinely notable moment ("fixed a data-loss bug", "shipped the export"). It pre-empts the derived narration queue with a low-latency, high-intent entry (no AI summarization). Use sparingly, only for moments worth interrupting for. No-op if the project hasn\'t enabled the Announcer.',
    inputSchema: AnnounceInputSchema,
    call: dispatchAnnounce,
  },
];

/** The MCP `tools/list` response payload. Each tool is exposed with
 *  its JSON Schema input shape derived from the Zod schema via
 *  `z.toJSONSchema`. */
export function listTools(): ToolListEntry[] {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema),
  }));
}

/** Dispatch a `tools/call` request to the named tool. Returns the
 *  structured-error result if the tool name is unknown OR settings.json
 *  is missing / invalid (the channel server can't reach the main
 *  server). The `fetchFn` parameter is injected for tests; production
 *  callers pass the global `fetch`. */
export async function callTool(
  name: string,
  args: unknown,
  dataDir: string,
  // HS-8567 — `FetchLike` is our narrowed signature for test-injection;
  // `globalThis.fetch` is directly assignable to it (no cast needed). Production
  // callers never pass `fetchFn`, so the narrowed signature only matters in
  // tests where the seam is honored. (HS-8602 dropped a former
  // `as unknown as FetchLike` cast here once a typescript-eslint bump confirmed
  // it was redundant.)
  fetchFn: FetchLike = globalThis.fetch,
): Promise<ToolCallResult> {
  const tool = TOOLS.find(t => t.name === name);
  if (tool === undefined) {
    return errorResult(`Unknown MCP tool: ${name}. Known: ${TOOLS.map(t => t.name).join(', ')}.`);
  }
  const settings = loadChannelSettings(dataDir);
  if (settings === null) {
    return errorResult(`Channel tool — could not resolve the project port + secret from ${join(dataDir, 'settings.json')} / settings.local.json / secret.json. Is the main Hot Sheet server running?`);
  }
  return await tool.call(args, settings, fetchFn);
}

/** Test-only — exposes the tool catalog for assertion. */
export const _toolsForTesting = TOOLS;
