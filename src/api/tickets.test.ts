/**
 * HS-8629 — ticket typed-API module. Verifies the callers hit the right
 * path + method through the injected transport, and that `TicketSchema`-based
 * response validation accepts a real ticket / rejects a malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TicketSchema } from '../schemas.js';
import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  batchTickets, createTicket, deleteTicket, deleteTicketNote, duplicateTickets, editTicketNote,
  emptyTrash, getTicketByNumber, getTicketDetail, getTicketPrefixes, getTicketSearchCounts,
  listTickets, putTicketNotesBulk, queryTickets, restoreTicket, toggleUpNext, updateTicket,
  updateTicketField,
} from './tickets.js';

const ticket = {
  id: 1, ticket_number: 'HS-1', title: 'T', details: '', category: 'task',
  priority: 'default', status: 'not_started', up_next: false,
  created_at: 'x', updated_at: 'x', completed_at: null, verified_at: null,
  deleted_at: null, notes: '[]', tags: '[]', last_read_at: null,
};

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('TicketSchema (HS-8629)', () => {
  it('accepts a valid ticket and rejects a wrong-typed field', () => {
    expect(TicketSchema.safeParse(ticket).success).toBe(true);
    expect(TicketSchema.safeParse({ ...ticket, id: 'x' }).success).toBe(false);
    expect(TicketSchema.safeParse({ ...ticket, priority: 'bogus' }).success).toBe(false);
  });
});

describe('ticket callers route to the right endpoint (HS-8629)', () => {
  it('listTickets → GET /tickets (+ query)', async () => {
    stub([ticket]);
    expect(await listTickets()).toEqual([ticket]);
    expect(lastCall?.path).toBe('/tickets');
    await listTickets('status=open&limit=5');
    expect(lastCall?.path).toBe('/tickets?status=open&limit=5');
  });

  it('queryTickets → POST /tickets/query', async () => {
    stub([ticket]);
    await queryTickets({ logic: 'all', conditions: [] });
    expect(lastCall).toEqual({ path: '/tickets/query', opts: { method: 'POST', body: { logic: 'all', conditions: [] } } });
  });

  it('getTicketSearchCounts → GET /tickets/search-counts?search=', async () => {
    stub({ backlog: 2, archive: 1 });
    expect(await getTicketSearchCounts('foo bar')).toEqual({ backlog: 2, archive: 1 });
    expect(lastCall?.path).toBe('/tickets/search-counts?search=foo+bar');
  });

  it('getTicketPrefixes → GET /tickets/prefixes, unwrapped', async () => {
    stub({ prefixes: ['HS', 'DM'] });
    expect(await getTicketPrefixes()).toEqual(['HS', 'DM']);
    expect(lastCall?.path).toBe('/tickets/prefixes');
  });

  it('createTicket → POST /tickets', async () => {
    stub(ticket);
    await createTicket({ title: 'New' });
    expect(lastCall).toEqual({ path: '/tickets', opts: { method: 'POST', body: { title: 'New' } } });
  });

  it('getTicketByNumber → GET /tickets/by-number/:number (encoded)', async () => {
    stub(ticket);
    await getTicketByNumber('HS-42');
    expect(lastCall?.path).toBe('/tickets/by-number/HS-42');
  });

  it('updateTicket → PATCH /tickets/:id, forwarding secret', async () => {
    stub(ticket);
    await updateTicket(7, { status: 'completed' }, { secret: 'sek' });
    expect(lastCall).toEqual({ path: '/tickets/7', opts: { method: 'PATCH', body: { status: 'completed' }, secret: 'sek' } });
  });

  it('deleteTicket → DELETE /tickets/:id', async () => {
    stub({ ok: true });
    await deleteTicket(7);
    expect(lastCall?.path).toBe('/tickets/7');
    expect(lastCall?.opts.method).toBe('DELETE');
  });

  it('updateTicketField → PATCH /tickets/:id with a single narrowed field (HS-8642)', async () => {
    stub(ticket);
    await updateTicketField(7, 'priority', 'high');
    expect(lastCall).toEqual({ path: '/tickets/7', opts: { method: 'PATCH', body: { priority: 'high' }, secret: undefined } });
    await updateTicketField(7, 'title', 'New title', { secret: 'sek' });
    expect(lastCall).toEqual({ path: '/tickets/7', opts: { method: 'PATCH', body: { title: 'New title' }, secret: 'sek' } });
  });

  it('getTicketDetail → GET /tickets/:id, validated against TicketDetailSchema (HS-8642)', async () => {
    stub({ ...ticket, attachments: [], syncInfo: [] });
    const detail = await getTicketDetail(7);
    expect(lastCall?.path).toBe('/tickets/7');
    expect(detail.attachments).toEqual([]);
    expect(detail.syncInfo).toEqual([]);
  });

  it('getTicketDetail rejects a detail payload missing attachments / syncInfo', async () => {
    stub(ticket); // no attachments / syncInfo
    await expect(getTicketDetail(7)).rejects.toThrow(/response shape mismatch/);
  });

  it('putTicketNotesBulk → PUT /tickets/:id/notes-bulk', async () => {
    stub([]);
    await putTicketNotesBulk(7, '[]');
    expect(lastCall).toEqual({ path: '/tickets/7/notes-bulk', opts: { method: 'PUT', body: { notes: '[]' } } });
  });

  it('editTicketNote / deleteTicketNote → /tickets/:id/notes/:noteId', async () => {
    stub([]);
    await editTicketNote(7, 'n1', 'hi');
    expect(lastCall).toEqual({ path: '/tickets/7/notes/n1', opts: { method: 'PATCH', body: { text: 'hi' } } });
    await deleteTicketNote(7, 'n1');
    expect(lastCall?.opts.method).toBe('DELETE');
  });

  it('batchTickets / duplicateTickets / restoreTicket / emptyTrash / toggleUpNext', async () => {
    stub({ ok: true });
    await batchTickets({ ids: [1, 2], action: 'delete' });
    expect(lastCall?.path).toBe('/tickets/batch');
    stub([ticket]);
    await duplicateTickets([1]);
    expect(lastCall).toEqual({ path: '/tickets/duplicate', opts: { method: 'POST', body: { ids: [1] } } });
    stub(ticket);
    await restoreTicket(7);
    expect(lastCall?.path).toBe('/tickets/7/restore');
    stub({ ok: true });
    await emptyTrash();
    expect(lastCall?.path).toBe('/trash/empty');
    stub(ticket);
    await toggleUpNext(7);
    expect(lastCall?.path).toBe('/tickets/7/up-next');
  });

  it('rejects a response that fails TicketSchema validation', async () => {
    stub({ ...ticket, status: 'bogus' });
    await expect(getTicketByNumber('HS-1')).rejects.toThrow(/response shape mismatch/);
  });
});
