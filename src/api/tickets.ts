/**
 * HS-8629 (HS-8522 typed-API layer) — typed callers for the ticket domain
 * (`src/routes/tickets.ts`): list / query / search-counts / prefixes, CRUD,
 * notes (bulk / edit / delete), batch, duplicate, restore, trash-empty,
 * toggle-up-next.
 *
 * Response shapes build on `TicketSchema` (the SSOT in `src/schemas.ts`, from
 * which `Ticket` itself is inferred) + `NotesArraySchema`. Request shapes reuse
 * the existing server-side request schemas in `src/routes/validation.ts`
 * (zod-only, so importing them client-side is safe) so there's a single
 * definition per wire body.
 *
 * HS-8642 finished the stragglers: the `GET /tickets/:id` detail response
 * (`TicketDetailSchema` / `getTicketDetail` below — Ticket + attachments +
 * syncInfo) and the `updateTicketField` helper for dynamic-key single-field
 * updates (detail auto-save + dropdowns). The `/tickets/:id/feedback-drafts*`
 * endpoints (§21) moved to their own module — see `src/api/feedbackDrafts.ts`.
 */
import { z } from 'zod';

import {
  BatchActionSchema, type CreateTicketSchema,
  type NotesBulkSchema, type QueryTicketsSchema, UpdateTicketSchema} from '../routes/validation.js';
import { NotesArraySchema, TicketSchema } from '../schemas.js';
import { apiCall, type ApiCallOpts, OkResponseSchema, qs } from './_runner.js';

// HS-8642 — re-export the request schemas (values) so client callers that need
// to validate + narrow a loosely-typed body at the trust boundary (the undo
// helpers, which still accept dynamic field bags from ticketRow / contextMenu)
// import them from the typed-API layer rather than reaching into `routes/`.
export { BatchActionSchema, UpdateTicketSchema };

// --- Response schemas (built on the shared TicketSchema SSOT) ---
const TicketListRespSchema = z.array(TicketSchema);
const SearchCountsRespSchema = z.object({ backlog: z.number(), archive: z.number() });
const PrefixesRespSchema = z.object({ prefixes: z.array(z.string()) });

// --- Ticket detail (`GET /tickets/:id`) — HS-8642 ---
// The detail response is the core ticket PLUS hydrated attachments + sync
// metadata. `.loose()` on the attachment row tolerates the extra DB columns
// the server's `SELECT *` returns (e.g. `draft_id`), which we don't surface.
const TicketAttachmentSchema = z.object({
  id: z.number(),
  ticket_id: z.number(),
  original_filename: z.string(),
  stored_path: z.string(),
  created_at: z.string(),
}).loose();

const TicketSyncInfoSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  pluginIcon: z.string().nullable(),
  remoteId: z.string(),
  remoteUrl: z.string().nullable(),
  syncStatus: z.string(),
});

export const TicketDetailSchema = TicketSchema.extend({
  attachments: z.array(TicketAttachmentSchema),
  syncInfo: z.array(TicketSyncInfoSchema),
});
export type TicketDetail = z.infer<typeof TicketDetailSchema>;

// --- Request input types (inferred from the shared request schemas) ---
export type CreateTicketReq = z.infer<typeof CreateTicketSchema>;
export type UpdateTicketReq = z.infer<typeof UpdateTicketSchema>;
export type BatchActionReq = z.infer<typeof BatchActionSchema>;
export type QueryTicketsReq = z.infer<typeof QueryTicketsSchema>;
export type NotesBulkReq = z.infer<typeof NotesBulkSchema>;

export type SearchCounts = z.infer<typeof SearchCountsRespSchema>;

/** GET `/tickets[?<filters>]` → the active project's tickets. `queryString` is
 *  the already-built `URLSearchParams` string (filter construction is
 *  view/state-specific and stays at the call site). */
export async function listTickets(queryString?: string): Promise<z.infer<typeof TicketSchema>[]> {
  const suffix = queryString !== undefined && queryString !== '' ? `?${queryString}` : '';
  return apiCall(TicketListRespSchema, `/tickets${suffix}`);
}

/** POST `/tickets/query` → custom-view condition query. */
export async function queryTickets(req: QueryTicketsReq): Promise<z.infer<typeof TicketSchema>[]> {
  return apiCall(TicketListRespSchema, '/tickets/query', { method: 'POST', body: req });
}

/** GET `/tickets/search-counts?search=` → match counts in normally-hidden buckets. */
export async function getTicketSearchCounts(search: string): Promise<SearchCounts> {
  return apiCall(SearchCountsRespSchema, `/tickets/search-counts${qs({ search })}`);
}

/** GET `/tickets/prefixes` → distinct `HS`-style ticket-number prefixes. */
export async function getTicketPrefixes(): Promise<string[]> {
  const r = await apiCall(PrefixesRespSchema, '/tickets/prefixes');
  return r.prefixes;
}

/** POST `/tickets` → create a ticket. `opts.secret` routes cross-project
 *  (HS-8663 — drag-copy/move a ticket into another project's tab). */
export async function createTicket(req: CreateTicketReq, opts: Pick<ApiCallOpts, 'secret'> = {}): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, '/tickets', { method: 'POST', body: req, secret: opts.secret });
}

/** GET `/tickets/by-number/:number` → look up a ticket by its `HS-NNNN` number. */
export async function getTicketByNumber(ticketNumber: string): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, `/tickets/by-number/${encodeURIComponent(ticketNumber)}`);
}

/** GET `/tickets/:id` → the full detail payload (ticket + attachments + syncInfo). */
export async function getTicketDetail(id: number): Promise<TicketDetail> {
  return apiCall(TicketDetailSchema, `/tickets/${id}`);
}

/** PATCH `/tickets/:id` → update fields. `opts.secret` routes cross-project. */
export async function updateTicket(id: number, body: UpdateTicketReq, opts: Pick<ApiCallOpts, 'secret'> = {}): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, `/tickets/${id}`, { method: 'PATCH', body, secret: opts.secret });
}

/** PATCH `/tickets/:id` with a single dynamically-keyed field. The detail
 *  auto-save (title / details) and the category / priority / status dropdowns
 *  build their update from a computed key; this narrows that `(field, value)`
 *  pair to the matching `UpdateTicketReq` slot so those call sites no longer
 *  fall back to raw `api()` (HS-8642 item 2). */
export async function updateTicketField<K extends keyof UpdateTicketReq>(
  id: number,
  field: K,
  value: UpdateTicketReq[K],
  opts: Pick<ApiCallOpts, 'secret'> = {},
): Promise<z.infer<typeof TicketSchema>> {
  // `field` is constrained to `keyof UpdateTicketReq` and `value` to its
  // matching value type, so this object IS a valid one-key UpdateTicketReq.
  // The assertion only re-expresses that — TS widens a computed-key literal to
  // `{ [k: string]: ... }` and can't infer the narrower partial on its own.
  const body = { [field]: value } as UpdateTicketReq;
  return updateTicket(id, body, opts);
}

/** DELETE `/tickets/:id` → soft-delete (move to trash). `opts.secret` routes cross-project. */
export async function deleteTicket(id: number, opts: Pick<ApiCallOpts, 'secret'> = {}): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, `/tickets/${id}`, { method: 'DELETE', secret: opts.secret });
}

/** PUT `/tickets/:id/notes-bulk` → replace the whole notes array (JSON string).
 *  The server responds `{ ok: true }` (not the updated notes array — unlike the
 *  single-note PATCH/DELETE siblings); no caller consumes a return value here.
 *  HS-8629's migration mistakenly validated the response against
 *  `NotesArraySchema`, which threw `response shape mismatch` at runtime and
 *  tripped the strict-error e2e gate (detail.spec). */
export async function putTicketNotesBulk(id: number, notes: string, opts: Pick<ApiCallOpts, 'secret'> = {}): Promise<{ ok: true }> {
  const body: NotesBulkReq = { notes };
  return apiCall(OkResponseSchema, `/tickets/${id}/notes-bulk`, { method: 'PUT', body, secret: opts.secret });
}

/** PATCH `/tickets/:id/notes/:noteId` → edit a single note's text. */
export async function editTicketNote(id: number, noteId: string, text: string): Promise<z.infer<typeof NotesArraySchema>> {
  return apiCall(NotesArraySchema, `/tickets/${id}/notes/${encodeURIComponent(noteId)}`, { method: 'PATCH', body: { text } });
}

/** DELETE `/tickets/:id/notes/:noteId` → delete a single note. */
export async function deleteTicketNote(id: number, noteId: string): Promise<z.infer<typeof NotesArraySchema>> {
  return apiCall(NotesArraySchema, `/tickets/${id}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
}

/** POST `/tickets/batch` → bulk action over many ids. */
export async function batchTickets(req: BatchActionReq): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/tickets/batch', { method: 'POST', body: req });
}

/** POST `/tickets/duplicate` → duplicate the given ids; returns the new tickets. */
export async function duplicateTickets(ids: number[]): Promise<z.infer<typeof TicketSchema>[]> {
  return apiCall(TicketListRespSchema, '/tickets/duplicate', { method: 'POST', body: { ids } });
}

/** POST `/tickets/:id/restore` → restore a soft-deleted ticket. */
export async function restoreTicket(id: number): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, `/tickets/${id}/restore`, { method: 'POST' });
}

/** POST `/trash/empty` → permanently delete every trashed ticket. */
export async function emptyTrash(): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/trash/empty', { method: 'POST' });
}

/** POST `/tickets/:id/up-next` → toggle the Up Next flag; returns the ticket. */
export async function toggleUpNext(id: number): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, `/tickets/${id}/up-next`, { method: 'POST' });
}

// --- HS-8862 — distributed-execution claim/lease (docs/90 §90.3) ---

/** A worker's claim of a ticket: who holds it, optional display label, and TTL. */
export interface ClaimReq { worker: string; label?: string | null; ttlSeconds?: number; force?: boolean }

// HS-8962 — `drain` is set when a pool worker marked draining pulls: the server
// returns no ticket and tells it to stop (docs/91 §91.4).
const ClaimNextRespSchema = z.object({ ticket: TicketSchema.nullable(), drain: z.boolean().optional() });
const ClaimRespSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ticket: TicketSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'conflict']), claimedBy: z.string().optional(), workerLabel: z.string().nullable().optional() }),
]);
const RenewRespSchema = z.object({ ok: z.boolean(), leaseExpiresAt: z.string().optional() });
const ClaimRowSchema = z.object({
  ticketId: z.number(), ticketNumber: z.string(), title: z.string(),
  claimedBy: z.string(), workerLabel: z.string().nullable(), leaseExpiresAt: z.string(),
});
const ClaimsRespSchema = z.object({ claims: z.array(ClaimRowSchema) });
export type ClaimRow = z.infer<typeof ClaimRowSchema>;

/** POST `/tickets/claim-next` → atomically claim the top claimable Up Next ticket. */
export async function claimNextTicket(req: ClaimReq): Promise<z.infer<typeof TicketSchema> | null> {
  const r = await apiCall(ClaimNextRespSchema, '/tickets/claim-next', { method: 'POST', body: req });
  return r.ticket;
}

/** POST `/tickets/:id/claim` → claim a specific ticket (dispatch); conflict on a live foreign lease. */
export async function claimTicket(id: number, req: ClaimReq): Promise<z.infer<typeof ClaimRespSchema>> {
  return apiCall(ClaimRespSchema, `/tickets/${id}/claim`, { method: 'POST', body: req });
}

/** POST `/tickets/:id/renew-lease` → worker heartbeat; ok:false ⇒ re-claim needed. */
export async function renewTicketLease(id: number, req: ClaimReq): Promise<z.infer<typeof RenewRespSchema>> {
  return apiCall(RenewRespSchema, `/tickets/${id}/renew-lease`, { method: 'POST', body: req });
}

/** POST `/tickets/:id/release` → drop the claim (idempotent). Omit `worker` to force-release. */
export async function releaseTicket(id: number, worker?: string): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, `/tickets/${id}/release`, { method: 'POST', body: { worker } });
}

/** GET `/tickets/claims` → currently live-claimed tickets (for the pool / chip UI). */
export async function getTicketClaims(): Promise<ClaimRow[]> {
  const r = await apiCall(ClaimsRespSchema, '/tickets/claims');
  return r.claims;
}

// --- HS-8865 — flat blocked_by dependency gate (docs/90 §90.6) ---

const BlockedByRespSchema = z.object({ blockedBy: z.array(z.number()), blocked: z.boolean() });
const SetBlockedByRespSchema = z.object({ ok: z.literal(true), blockedBy: z.array(z.number()) });

/** GET `/tickets/:id/blocked-by` → the ticket's blockers + whether it's blocked. */
export async function getTicketBlockedBy(id: number): Promise<z.infer<typeof BlockedByRespSchema>> {
  return apiCall(BlockedByRespSchema, `/tickets/${id}/blocked-by`);
}

/** PUT `/tickets/:id/blocked-by` → replace the blocker set (400 on self/cycle/unknown). */
export async function setTicketBlockedBy(id: number, blockerIds: number[]): Promise<z.infer<typeof SetBlockedByRespSchema>> {
  return apiCall(SetBlockedByRespSchema, `/tickets/${id}/blocked-by`, { method: 'PUT', body: { blockerIds } });
}
