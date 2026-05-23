// @vitest-environment happy-dom
/**
 * HS-8560 — coverage backfill for `src/client/ticketRefDialog.tsx`.
 *
 * The existing `ticketRefDialog.test.ts` is HS-8062 focused (the global
 * click handler's capture-phase interception). This sibling file picks
 * up the open / push / pop / stack / Escape / button / API-fallback
 * paths the existing suite doesn't exercise — pre-fix module coverage
 * was 24.69%.
 *
 * `api` + `detail.openDetail` + `toast.showToast` + `state` are mocked
 * here so the dialog open path is fully self-contained.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from './state.js';
import type * as TicketRefDialogNS from './ticketRefDialog.js';

const mockApi = vi.fn<(path: string) => Promise<unknown>>();
const mockOpenDetail = vi.fn<(id: number) => void>();
const mockShowToast = vi.fn<(msg: string, opts?: unknown) => void>();
const tickets: Ticket[] = [];

vi.mock('./api.js', () => ({
  api: (path: string): Promise<unknown> => mockApi(path),
}));

vi.mock('./detail.js', () => ({
  openDetail: (id: number): void => mockOpenDetail(id),
}));

vi.mock('./toast.js', () => ({
  showToast: (msg: string, opts?: unknown): void => mockShowToast(msg, opts),
}));

vi.mock('./state.js', () => ({
  state: { get tickets(): Ticket[] { return tickets; } },
}));

// linkify is heavy + project-specific; collapse to the input so we can
// assert dialog shape without pulling in the full prefix-detection path.
vi.mock('./ticketRefs.js', () => ({
  linkifyWithCachedPrefixes: (html: string): string => html,
}));

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    ticket_number: 'HS-1',
    title: 'First',
    details: 'Details body',
    category: 'task',
    priority: 'default',
    status: 'not_started',
    up_next: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    verified_at: null,
    deleted_at: null,
    notes: '',
    tags: '',
    last_read_at: null,
    ...overrides,
  };
}

async function fresh(): Promise<typeof TicketRefDialogNS> {
  vi.resetModules();
  return await import('./ticketRefDialog.js');
}

beforeEach(() => {
  mockApi.mockReset();
  mockOpenDetail.mockReset();
  mockShowToast.mockReset();
  tickets.length = 0;
  document.body.innerHTML = '';
});

afterEach(() => {
  document.querySelectorAll('.ticket-ref-dialog-overlay').forEach(el => el.remove());
});

describe('openTicketRefDialog — cache hit', () => {
  it('opens a dialog from the in-memory state cache without hitting the API', async () => {
    tickets.push(ticket({ id: 42, ticket_number: 'HS-42', title: 'Cached' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-42');

    expect(mockApi).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.ticket-ref-dialog-overlay').length).toBe(1);
    expect(document.querySelector('.ticket-ref-dialog-number')?.textContent).toBe('HS-42');
    expect(document.querySelector('.ticket-ref-dialog-title')?.textContent).toBe('Cached');
  });
});

describe('openTicketRefDialog — API fallback', () => {
  it('hits /tickets/by-number/... when the cache misses', async () => {
    mockApi.mockResolvedValue(ticket({ ticket_number: 'HS-99', title: 'From API' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-99');

    expect(mockApi).toHaveBeenCalledWith('/tickets/by-number/HS-99');
    expect(document.querySelector('.ticket-ref-dialog-title')?.textContent).toBe('From API');
  });

  it('URL-encodes the ticket number passed to the API', async () => {
    mockApi.mockResolvedValue(ticket());
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS/special');
    expect(mockApi).toHaveBeenCalledWith('/tickets/by-number/HS%2Fspecial');
  });

  it('toasts and skips dialog open on API rejection', async () => {
    mockApi.mockRejectedValue(new Error('404'));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-404');

    expect(mockShowToast).toHaveBeenCalledWith('Ticket HS-404 not found', { variant: 'warning' });
    expect(document.querySelectorAll('.ticket-ref-dialog-overlay').length).toBe(0);
  });
});

describe('dialog content', () => {
  it('renders the meta chips (status / priority / category)', async () => {
    tickets.push(ticket({
      ticket_number: 'HS-7',
      status: 'started',
      priority: 'high',
      category: 'bug',
    }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-7');

    expect(document.querySelector('.ticket-ref-dialog-chip-status')?.textContent).toBe('started');
    expect(document.querySelector('.ticket-ref-dialog-chip-priority')?.textContent).toBe('high');
    expect(document.querySelector('.ticket-ref-dialog-chip-category')?.textContent).toBe('bug');
  });

  it('shows "(no details)" placeholder when details is empty', async () => {
    tickets.push(ticket({ ticket_number: 'HS-8', details: '   ' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-8');

    const dialog = document.querySelector('.ticket-ref-dialog');
    expect(dialog?.innerHTML).toContain('(no details)');
  });

  it('shows "(no notes)" placeholder when notes is empty', async () => {
    tickets.push(ticket({ ticket_number: 'HS-9', notes: '' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-9');

    const dialog = document.querySelector('.ticket-ref-dialog');
    expect(dialog?.innerHTML).toContain('(no notes)');
  });

  it('renders note entries when notes JSON has rows', async () => {
    const notes = JSON.stringify([
      { text: 'first note', created_at: '2026-05-23T12:00:00Z' },
      { text: 'second note', created_at: '2026-05-23T13:00:00Z' },
    ]);
    tickets.push(ticket({ ticket_number: 'HS-10', notes }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-10');

    const noteEls = document.querySelectorAll('.ticket-ref-dialog-note');
    expect(noteEls.length).toBe(2);
    expect(noteEls[0].textContent).toContain('first note');
    expect(noteEls[1].textContent).toContain('second note');
  });

  it('falls back to a single placeholder-text note when notes is not valid JSON', async () => {
    tickets.push(ticket({ ticket_number: 'HS-11', notes: 'plain string, not JSON' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-11');

    const noteEls = document.querySelectorAll('.ticket-ref-dialog-note');
    expect(noteEls.length).toBe(1);
    expect(noteEls[0].textContent).toContain('plain string, not JSON');
  });

  it('shows "(empty note)" for whitespace-only note bodies', async () => {
    const notes = JSON.stringify([{ text: '   ', created_at: '2026-01-01T00:00:00Z' }]);
    tickets.push(ticket({ ticket_number: 'HS-12', notes }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-12');

    expect(document.querySelector('.ticket-ref-dialog-note')?.innerHTML).toContain('(empty note)');
  });
});

describe('stacking + dismissal', () => {
  it('stacks two dialogs offset by 30px each', async () => {
    tickets.push(ticket({ id: 1, ticket_number: 'HS-1' }));
    tickets.push(ticket({ id: 2, ticket_number: 'HS-2' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-1');
    await openTicketRefDialog('HS-2');

    const dialogs = document.querySelectorAll('.ticket-ref-dialog');
    expect(dialogs.length).toBe(2);
    expect((dialogs[0] as HTMLElement).style.transform).toBe('translate(0px, 0px)');
    expect((dialogs[1] as HTMLElement).style.transform).toBe('translate(30px, 30px)');
  });

  it('close button dismisses only the top dialog', async () => {
    tickets.push(ticket({ id: 1, ticket_number: 'HS-1' }));
    tickets.push(ticket({ id: 2, ticket_number: 'HS-2' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-1');
    await openTicketRefDialog('HS-2');

    const closes = document.querySelectorAll('.ticket-ref-dialog-close');
    (closes[closes.length - 1] as HTMLElement).click();

    const remaining = document.querySelectorAll('.ticket-ref-dialog');
    expect(remaining.length).toBe(1);
    expect(remaining[0].querySelector('.ticket-ref-dialog-number')?.textContent).toBe('HS-1');
  });

  it('backdrop click dismisses only the top dialog', async () => {
    tickets.push(ticket({ id: 1, ticket_number: 'HS-1' }));
    tickets.push(ticket({ id: 2, ticket_number: 'HS-2' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-1');
    await openTicketRefDialog('HS-2');

    const backdrops = document.querySelectorAll('.ticket-ref-dialog-backdrop');
    (backdrops[backdrops.length - 1] as HTMLElement).click();

    expect(document.querySelectorAll('.ticket-ref-dialog').length).toBe(1);
  });

  it('Escape pops one dialog at a time', async () => {
    tickets.push(ticket({ id: 1, ticket_number: 'HS-1' }));
    tickets.push(ticket({ id: 2, ticket_number: 'HS-2' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-1');
    await openTicketRefDialog('HS-2');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelectorAll('.ticket-ref-dialog').length).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelectorAll('.ticket-ref-dialog').length).toBe(0);
  });

  it('non-Escape keys are ignored', async () => {
    tickets.push(ticket({ id: 1, ticket_number: 'HS-1' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-1');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.querySelectorAll('.ticket-ref-dialog').length).toBe(1);
  });

  it('"Open in detail panel" button closes all dialogs + calls openDetail', async () => {
    tickets.push(ticket({ id: 11, ticket_number: 'HS-11' }));
    tickets.push(ticket({ id: 22, ticket_number: 'HS-22' }));
    const { openTicketRefDialog } = await fresh();
    await openTicketRefDialog('HS-11');
    await openTicketRefDialog('HS-22');

    const opens = document.querySelectorAll('.ticket-ref-dialog-open');
    (opens[opens.length - 1] as HTMLElement).click();

    expect(document.querySelectorAll('.ticket-ref-dialog').length).toBe(0);
    expect(mockOpenDetail).toHaveBeenCalledWith(22);
  });
});
