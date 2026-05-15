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

  it('renders chevron-up / chevron-down nav buttons when the ticket has multiple non-empty notes (HS-8415)', () => {
    // Pre-fix the menu opened the reader overlay without a `navigation`
    // slot, so the user landed on the latest note with no way to step
    // back to earlier ones. Post-fix the menu builds navEntries from
    // every non-empty note and sets initialIndex to the latest, matching
    // the per-note book-icon trigger in `noteRenderer.tsx`.
    const t = makeTicket(108, { notes: notesWith('## First', '## Second', '## Third') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(108);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    expect(readItem).toBeDefined();
    readItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const overlay = document.querySelector('.reader-mode-overlay');
    expect(overlay).not.toBeNull();
    // Chevron buttons present means the navigation slot was passed.
    const prev = overlay!.querySelector<HTMLButtonElement>('.reader-mode-prev');
    const next = overlay!.querySelector<HTMLButtonElement>('.reader-mode-next');
    expect(prev).not.toBeNull();
    expect(next).not.toBeNull();
    // Latest note is the initial entry; next-button disabled at end of
    // list, prev-button enabled so the user can walk back.
    expect(next!.disabled).toBe(true);
    expect(prev!.disabled).toBe(false);
    expect(overlay!.textContent).toContain('Third');
  });

  it('skips chevron nav buttons when only one non-empty note exists (HS-8415)', () => {
    // Single-entry shape matches the `navEntries.length > 1` guard in
    // `noteRenderer.tsx`. With one note there's nowhere to navigate, so
    // the chevrons would be permanently disabled — omit them entirely.
    const t = makeTicket(109, { notes: notesWith('## Only one') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(109);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    readItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const overlay = document.querySelector('.reader-mode-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.reader-mode-prev')).toBeNull();
    expect(overlay!.querySelector('.reader-mode-next')).toBeNull();
  });

  it('navigation entries skip empty notes so chevron walk stays on real content (HS-8415)', () => {
    // Three notes with the middle one blank — the reader's navigation
    // list should contain only the two non-empty entries.
    const t = makeTicket(110, { notes: notesWith('## Earlier', '', '## Later') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(110);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item');
    const readItem = Array.from(items).find((el) => el.querySelector('.context-menu-label')?.textContent === 'Read Latest Note');
    readItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const overlay = document.querySelector('.reader-mode-overlay');
    const prev = overlay!.querySelector<HTMLButtonElement>('.reader-mode-prev');
    // Start on the latest non-empty note ("Later"). One click back
    // should land on "Earlier" (skipping the blank middle entry).
    expect(overlay!.textContent).toContain('Later');
    prev!.click();
    expect(overlay!.textContent).toContain('Earlier');
    expect(overlay!.textContent).not.toContain('Later');
    // Now at the first entry — prev disabled.
    expect(prev!.disabled).toBe(true);
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

/**
 * HS-8414 — separator under the Provide Feedback / Read Latest Note
 * inspection block. Pre-change the menu flowed straight from Read Latest
 * Note into Category submenu which looked cluttered; post-change a
 * separator visually groups the two top items away from the
 * configuration submenus below.
 */
describe('showTicketContextMenu — HS-8414 separator under inspection block', () => {
  function notesWith(...texts: string[]): string {
    return JSON.stringify(
      texts.map((text, i) => ({ id: `n_${i}`, text, created_at: `2026-05-15T0${i}:00:00Z` })),
    );
  }

  function indexOfLabel(labels: string[], label: string): number {
    return labels.indexOf(label);
  }

  it('places a separator between Read Latest Note and Category submenu (single-selection)', () => {
    const t = makeTicket(201, { notes: notesWith('## a note') });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(201);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    // Find Read Latest Note + Category positions inside the top-level
    // menu (excluding submenu items). Asserting the separator sits
    // between them proves the HS-8414 placement.
    const topLevel = document.querySelectorAll<HTMLElement>('.context-menu > .context-menu-item, .context-menu > .context-menu-separator');
    const labels = Array.from(topLevel).map(el =>
      el.classList.contains('context-menu-separator')
        ? '__SEP__'
        : el.querySelector('.context-menu-label')?.textContent ?? '',
    );
    const readIdx = indexOfLabel(labels, 'Read Latest Note');
    const categoryIdx = indexOfLabel(labels, 'Category');
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(categoryIdx).toBeGreaterThan(readIdx);
    // Every slot between Read Latest Note and Category should be a
    // separator (there's nothing else between them in the single-
    // selection-non-completed shape).
    for (let i = readIdx + 1; i < categoryIdx; i++) {
      expect(labels[i]).toBe('__SEP__');
    }
    // At least one separator exists in that gap.
    expect(categoryIdx - readIdx).toBeGreaterThanOrEqual(2);
  });

  it('places a separator above Provide Feedback + Read Latest Note for feedback tickets (single-selection)', () => {
    const t = makeTicket(202, { notes: JSON.stringify([
      { id: 'n_1', text: '## older', created_at: '2026-05-15T00:00:00Z' },
      { id: 'n_2', text: 'FEEDBACK NEEDED: ack?', created_at: '2026-05-15T01:00:00Z' },
    ]) });
    ticketsStore.actions.setTickets([t]);
    state.selectedIds.add(202);
    state.tickets = [t];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const topLevel = document.querySelectorAll<HTMLElement>('.context-menu > .context-menu-item, .context-menu > .context-menu-separator');
    const labels = Array.from(topLevel).map(el =>
      el.classList.contains('context-menu-separator')
        ? '__SEP__'
        : el.querySelector('.context-menu-label')?.textContent ?? '',
    );
    const provideIdx = labels.indexOf('Provide Feedback');
    const readIdx = labels.indexOf('Read Latest Note');
    const categoryIdx = labels.indexOf('Category');
    // Provide Feedback comes first, then Read Latest Note, then sep, then Category.
    expect(provideIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBe(provideIdx + 1);
    // Sep between Read Latest Note and Category — same shape as the
    // baseline single-selection case, no extra separator between the
    // two top items.
    expect(labels[readIdx + 1]).toBe('__SEP__');
    expect(categoryIdx).toBeGreaterThan(readIdx);
  });

  it('omits the HS-8414 separator on multi-select (no top inspection items, no extra sep)', () => {
    // Multi-select skips both Provide Feedback and Read Latest Note, so
    // there's nothing to "separate from below" — the menu opens
    // straight on Category submenu.
    const t = makeTicket(203, { notes: notesWith('## one') });
    const u = makeTicket(204);
    ticketsStore.actions.setTickets([t, u]);
    state.selectedIds.add(203);
    state.selectedIds.add(204);
    state.tickets = [t, u];

    showTicketContextMenu(makeContextMenuEvent(), t);

    const topLevel = document.querySelectorAll<HTMLElement>('.context-menu > .context-menu-item, .context-menu > .context-menu-separator');
    const labels = Array.from(topLevel).map(el =>
      el.classList.contains('context-menu-separator')
        ? '__SEP__'
        : el.querySelector('.context-menu-label')?.textContent ?? '',
    );
    const categoryIdx = labels.indexOf('Category');
    expect(categoryIdx).toBe(0); // First top-level item is Category submenu.
  });
});
