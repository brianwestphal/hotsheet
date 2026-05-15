// @vitest-environment happy-dom
/**
 * HS-8400 — regression coverage for the stale-ticket-closure bug in
 * `showTicketContextMenu`. Pre-fix the contextmenu listener in
 * `ticketRow.tsx` / `columnView.tsx` captured the ticket reference at
 * row-creation time. When a server-pushed `FEEDBACK NEEDED:` note
 * arrived mid-session, the per-ticket signal fired and the row's
 * purple-dot painted — but the contextmenu listener's stale `ticket`
 * closure still held the original `notes` value, so
 * `hasPendingFeedback(staleTicket)` returned false and the menu's
 * Provide Feedback item was dropped.
 *
 * Post-fix `showTicketContextMenu` reads the latest ticket from
 * `getTicketSignals(id)` on entry, so the menu's feedback check sees
 * the current notes regardless of how stale the caller's reference
 * is. This test asserts the menu's Provide Feedback item appears
 * even when called with a stale ticket value (the same shape the
 * pre-fix bug exhibited).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { showTicketContextMenu } from './contextMenu.js';
import type { Ticket } from './state.js';
import { state } from './state.js';
import {
  _clearPerTicketSignalsForTesting,
  _ticketsStoreForTesting,
  ticketsStore,
} from './ticketsStore.js';

function makeTicket(id: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    ticket_number: `HS-${id}`,
    title: `Ticket ${id}`,
    details: '',
    category: 'feature',
    priority: 'default',
    status: 'not_started',
    up_next: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    verified_at: null,
    deleted_at: null,
    notes: '',
    tags: '[]',
    last_read_at: null,
    ...overrides,
  };
}

function feedbackNote(text: string): string {
  return JSON.stringify([
    { id: 'n_1', text, created_at: '2026-05-15T00:00:00Z' },
  ]);
}

function makeContextMenuEvent(): MouseEvent {
  // happy-dom's MouseEvent constructor doesn't accept all init dict
  // fields, but `preventDefault` + `clientX/Y` are enough for the
  // contextmenu codepath.
  return new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
  });
}

function menuLabels(): string[] {
  const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-label');
  return Array.from(items).map((el) => el.textContent);
}

beforeEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  state.selectedIds.clear();
  // The Category submenu reads `state.categories`; seed with one entry
  // so the submenu doesn't crash on an empty array.
  state.categories = [
    { id: 'feature', label: 'Feature', shortLabel: 'F', color: '#3b82f6', shortcutKey: 'f', description: '' },
  ];
  document.body.innerHTML = '';
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  state.selectedIds.clear();
  state.categories = [];
  document.body.innerHTML = '';
  // The contextmenu installs a document-level click handler to close
  // the menu on outside-click. Triggering one clears any leftover
  // menus + listeners between cases.
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

describe('showTicketContextMenu — stale-ticket lookup (HS-8400)', () => {
  it('shows Provide Feedback when the store has a fresh FEEDBACK NEEDED note even if the caller\'s ticket ref is stale', () => {
    // Seed the store with the ticket in its pre-feedback state.
    const original = makeTicket(42, { notes: '' });
    ticketsStore.actions.setTickets([original]);
    state.selectedIds.add(42);
    state.tickets = [original];

    // Server pushes a FEEDBACK NEEDED note. The store's per-ticket
    // signal fires; downstream row effects would paint the purple dot.
    // The contextmenu listener in ticketRow / columnView still holds
    // a closure over `original`, which has `notes: ''`.
    const updated = { ...original, notes: feedbackNote('FEEDBACK NEEDED: please confirm') };
    ticketsStore.actions.applyServerUpdate(updated);
    state.tickets = [updated];

    // Call with the STALE reference — pre-fix this dropped the
    // Provide Feedback item; post-fix the function reads `updated`
    // from the store and includes the item.
    showTicketContextMenu(makeContextMenuEvent(), original);

    const labels = menuLabels();
    expect(labels).toContain('Provide Feedback');
  });

  it('still works when the store has no signal for the ticket (defensive fallback)', () => {
    // No `setTickets` — the per-ticket signal Map is empty. The
    // contextmenu must still honor the caller\'s ticket value.
    const t = makeTicket(7, { notes: feedbackNote('FEEDBACK NEEDED: ack?') });
    state.selectedIds.add(7);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);
    expect(menuLabels()).toContain('Provide Feedback');
  });

  it('omits Provide Feedback when neither store nor caller has a feedback note', () => {
    const t = makeTicket(99, { notes: '' });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(99);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);
    expect(menuLabels()).not.toContain('Provide Feedback');
  });
});

describe('showTicketContextMenu — Read Latest Note (HS-8401)', () => {
  function notesWith(...texts: string[]): string {
    return JSON.stringify(
      texts.map((text, i) => ({ id: `n_${i}`, text, created_at: `2026-05-15T0${i}:00:00Z` })),
    );
  }

  it('shows Read Latest Note item enabled when the ticket has at least one non-empty note', () => {
    const t = makeTicket(101, { notes: notesWith('## First note', '## Second note') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(101);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    expect(readItem).toBeDefined();
    expect(readItem!.classList.contains('disabled')).toBe(false);
  });

  it('shows Read Latest Note item disabled when the ticket has no notes', () => {
    const t = makeTicket(102, { notes: '' });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(102);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    expect(readItem).toBeDefined();
    expect(readItem!.classList.contains('disabled')).toBe(true);
  });

  it('shows Read Latest Note item disabled when every note has empty text (placeholder-only)', () => {
    // Notes with only whitespace text count as empty for the menu's
    // purposes — opening the §49 reader on a blank note would surface
    // the "(empty)" placeholder which surprises the user.
    const t = makeTicket(103, { notes: notesWith('', '   ', '\n') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(103);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    expect(readItem).toBeDefined();
    expect(readItem!.classList.contains('disabled')).toBe(true);
  });

  it('clicking the enabled item opens the reader overlay with the latest non-empty note', () => {
    // Latest note (index 2) is non-empty, so the overlay should
    // anchor on that one — confirms the iterate-from-end search
    // doesn't trip over earlier non-empty notes.
    const t = makeTicket(104, { notes: notesWith('## Older', '', '## Newer') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(104);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    expect(readItem).toBeDefined();
    readItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const overlay = document.querySelector('.reader-mode-overlay');
    expect(overlay).not.toBeNull();
    // The overlay's body should hold the markdown source for the
    // newest non-empty note.
    expect(overlay!.textContent).toContain('Newer');
    expect(overlay!.textContent).not.toContain('Older');
  });

  it('skips empty notes and finds the most recent non-empty one even when newer entries are blank', () => {
    // Most recent note is empty; the menu must walk back to find the
    // previous non-empty entry.
    const t = makeTicket(105, { notes: notesWith('## Earlier real note', '', '   ') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(105);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    expect(readItem).toBeDefined();
    expect(readItem!.classList.contains('disabled')).toBe(false);
    readItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const overlay = document.querySelector('.reader-mode-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('Earlier real note');
  });

  it('omits Read Latest Note when multiple tickets are selected (single-selection only)', () => {
    const t = makeTicket(106, { notes: notesWith('## a note') });
    const u = makeTicket(107);
    ticketsStore.actions.setTickets([t, u]);
    state.selectedIds.add(106);
    state.selectedIds.add(107);
    state.tickets = [t, u];

    showTicketContextMenu(makeContextMenuEvent(), t);
    expect(menuLabels()).not.toContain('Read Latest Note');
  });
});
