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

import {
  TicketPrioritySchema,
  TicketStatusSchema,
} from './routes/validation.js';

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

/** Read + parse `<dataDir>/settings.json`. Returns null on any error
 *  (missing file, invalid JSON, missing port). The caller surfaces a
 *  user-readable error message via `errorResult`. Pure (modulo fs read)
 *  for testability — the test passes a tmpdir-rooted path. */
export function loadChannelSettings(dataDir: string): ChannelSettings | null {
  try {
    const raw = readFileSync(join(dataDir, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { port?: number; secret?: string };
    if (typeof parsed.port !== 'number' || parsed.port <= 0) return null;
    if (typeof parsed.secret !== 'string' || parsed.secret === '') return null;
    return { port: parsed.port, secret: parsed.secret };
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
  notes: z.string().optional().describe('Replace the ticket\'s notes JSON. Pass the full notes array as a JSON string.'),
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
];

/** The MCP `tools/list` response payload. Each tool is exposed with
 *  its JSON Schema input shape derived from the Zod schema via
 *  `z.toJSONSchema`. */
export function listTools(): ToolListEntry[] {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
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
  fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ToolCallResult> {
  const tool = TOOLS.find(t => t.name === name);
  if (tool === undefined) {
    return errorResult(`Unknown MCP tool: ${name}. Known: ${TOOLS.map(t => t.name).join(', ')}.`);
  }
  const settings = loadChannelSettings(dataDir);
  if (settings === null) {
    return errorResult(`Channel tool — could not read ${join(dataDir, 'settings.json')}. Is the main Hot Sheet server running?`);
  }
  return await tool.call(args, settings, fetchFn);
}

/** Test-only — exposes the tool catalog for assertion. */
export const _toolsForTesting = TOOLS;
