// @vitest-environment happy-dom
/**
 * HS-8663 — cross-project ticket transfer (copy / move).
 *
 * `transferTicketsToProject` powers the drag-onto-tab and drag-onto-"+"-button
 * flows. These tests pin its API choreography: create-in-target (with the
 * target secret), carry notes, and — for a move — soft-delete the originals
 * from the source project (with the source secret, not the active one).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copyTicketAttachments, createTicket, putTicketNotesBulk, updateTicket } from '../api/index.js';
import type { Ticket } from './state.js';
import { transferTicketsToProject } from './ticketTransfer.js';

vi.mock('../api/index.js', () => ({
  createTicket: vi.fn(),
  putTicketNotesBulk: vi.fn(),
  updateTicket: vi.fn(),
  copyTicketAttachments: vi.fn(),
}));

const createTicketMock = vi.mocked(createTicket);
const putNotesMock = vi.mocked(putTicketNotesBulk);
const updateTicketMock = vi.mocked(updateTicket);
const copyAttachmentsMock = vi.mocked(copyTicketAttachments);

function makeTicket(over: Partial<Ticket> & { id: number }): Ticket {
  return {
    ticket_number: `HS-${String(over.id)}`,
    title: `Ticket ${String(over.id)}`,
    details: '',
    category: 'task',
    priority: 'default',
    status: 'not_started',
    up_next: false,
    created_at: '',
    updated_at: '',
    completed_at: null,
    verified_at: null,
    deleted_at: null,
    notes: '',
    tags: '[]',
    last_read_at: null,
    ...over,
  };
}

// The typed callers resolve the validated `TicketSchema` shape (enum-narrowed
// priority/status); transfer only reads `created.id`, so a minimal id-bearing
// stub through `as unknown as` is enough and keeps the test off the schema.
type CreatedTicket = Awaited<ReturnType<typeof createTicket>>;
const created = (id: number): CreatedTicket => ({ id } as unknown as CreatedTicket);

beforeEach(() => {
  createTicketMock.mockReset().mockImplementation(() =>
    Promise.resolve(created(9000 + createTicketMock.mock.calls.length)),
  );
  putNotesMock.mockReset().mockResolvedValue({ ok: true });
  updateTicketMock.mockReset().mockResolvedValue(created(0));
  copyAttachmentsMock.mockReset().mockResolvedValue({ copied: 0, attachments: [] });
});

describe('transferTicketsToProject (HS-8663)', () => {
  it('copy creates in the TARGET project and does not delete the source', async () => {
    const tickets = [makeTicket({ id: 1, title: 'Alpha', category: 'bug', priority: 'high' })];
    const ids = await transferTicketsToProject(tickets, 'target-secret', { move: false, sourceSecret: 'src-secret' });

    expect(createTicketMock).toHaveBeenCalledTimes(1);
    const [req, opts] = createTicketMock.mock.calls[0];
    expect(req).toMatchObject({ title: 'Alpha', defaults: { category: 'bug', priority: 'high' } });
    expect(opts).toEqual({ secret: 'target-secret' });
    // No move → no delete.
    expect(updateTicketMock).not.toHaveBeenCalled();
    expect(ids).toEqual([9001]);
    // HS-8739 — attachments carried to the created ticket, with the source
    // ticket id + source secret, authed against the target project.
    expect(copyAttachmentsMock).toHaveBeenCalledExactlyOnceWith(
      9001,
      { sourceSecret: 'src-secret', sourceTicketId: 1 },
      { secret: 'target-secret' },
    );
  });

  it('skips attachment copy when no sourceSecret is available', async () => {
    await transferTicketsToProject([makeTicket({ id: 1 })], 'target-secret', { move: false });
    expect(copyAttachmentsMock).not.toHaveBeenCalled();
  });

  it('move creates in the target AND soft-deletes the source with the SOURCE secret', async () => {
    const tickets = [makeTicket({ id: 5 }), makeTicket({ id: 6 })];
    await transferTicketsToProject(tickets, 'target-secret', { move: true, sourceSecret: 'src-secret' });

    expect(createTicketMock).toHaveBeenCalledTimes(2);
    expect(updateTicketMock).toHaveBeenCalledTimes(2);
    // Deletes target the source ids, routed to the source project's secret.
    expect(updateTicketMock).toHaveBeenNthCalledWith(1, 5, { status: 'deleted' }, { secret: 'src-secret' });
    expect(updateTicketMock).toHaveBeenNthCalledWith(2, 6, { status: 'deleted' }, { secret: 'src-secret' });
  });

  it('carries non-empty notes to the new ticket, skips empty / "[]" notes', async () => {
    const tickets = [
      makeTicket({ id: 1, notes: '[{"id":"n1","text":"hi","created_at":""}]' }),
      makeTicket({ id: 2, notes: '[]' }),
      makeTicket({ id: 3, notes: '' }),
    ];
    await transferTicketsToProject(tickets, 'target-secret', { move: false });

    // Only ticket 1 had real notes → exactly one bulk-notes call, on its
    // created id, with the target secret.
    expect(putNotesMock).toHaveBeenCalledTimes(1);
    const [createdId, notesJson, opts] = putNotesMock.mock.calls[0];
    expect(createdId).toBe(9001);
    expect(notesJson).toContain('hi');
    expect(opts).toEqual({ secret: 'target-secret' });
  });

  it('a trashed source ticket is re-created as not_started', async () => {
    const tickets = [makeTicket({ id: 1, status: 'deleted' })];
    await transferTicketsToProject(tickets, 'target-secret', { move: false });
    const [req] = createTicketMock.mock.calls[0];
    expect(req.defaults?.status).toBe('not_started');
  });

  it('move without a sourceSecret falls back to the active-project delete', async () => {
    const tickets = [makeTicket({ id: 7 })];
    await transferTicketsToProject(tickets, 'target-secret', { move: true });
    expect(updateTicketMock).toHaveBeenCalledWith(7, { status: 'deleted' });
  });
});
