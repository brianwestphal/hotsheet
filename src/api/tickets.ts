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
 * NOT covered here (deliberately out of HS-8629's stated scope — tracked
 * separately): the `/tickets/:id/feedback-drafts*` endpoints (§21 feedback
 * domain) and the `GET /tickets/:id` detail response (Ticket + attachments +
 * syncInfo); those call sites stay on raw `api()` for now.
 */
import { z } from 'zod';

import type {
  BatchActionSchema, CreateTicketSchema,
  NotesBulkSchema, QueryTicketsSchema, UpdateTicketSchema} from '../routes/validation.js';
import { NotesArraySchema, TicketSchema } from '../schemas.js';
import { apiCall, type ApiCallOpts, OkResponseSchema, qs } from './_runner.js';

// --- Response schemas (built on the shared TicketSchema SSOT) ---
const TicketListRespSchema = z.array(TicketSchema);
const SearchCountsRespSchema = z.object({ backlog: z.number(), archive: z.number() });
const PrefixesRespSchema = z.object({ prefixes: z.array(z.string()) });

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

/** POST `/tickets` → create a ticket. */
export async function createTicket(req: CreateTicketReq): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, '/tickets', { method: 'POST', body: req });
}

/** GET `/tickets/by-number/:number` → look up a ticket by its `HS-NNNN` number. */
export async function getTicketByNumber(ticketNumber: string): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, `/tickets/by-number/${encodeURIComponent(ticketNumber)}`);
}

/** PATCH `/tickets/:id` → update fields. `opts.secret` routes cross-project. */
export async function updateTicket(id: number, body: UpdateTicketReq, opts: Pick<ApiCallOpts, 'secret'> = {}): Promise<z.infer<typeof TicketSchema>> {
  return apiCall(TicketSchema, `/tickets/${id}`, { method: 'PATCH', body, secret: opts.secret });
}

/** DELETE `/tickets/:id` → soft-delete (move to trash). `opts.secret` routes cross-project. */
export async function deleteTicket(id: number, opts: Pick<ApiCallOpts, 'secret'> = {}): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, `/tickets/${id}`, { method: 'DELETE', secret: opts.secret });
}

/** PUT `/tickets/:id/notes-bulk` → replace the whole notes array (JSON string). */
export async function putTicketNotesBulk(id: number, notes: string): Promise<z.infer<typeof NotesArraySchema>> {
  const body: NotesBulkReq = { notes };
  return apiCall(NotesArraySchema, `/tickets/${id}/notes-bulk`, { method: 'PUT', body });
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
