// @vitest-environment happy-dom
/**
 * HS-8335 — happy-dom integration tests for the per-row reactive
 * effects installed by `setupTicketRowEffects` (list view) and
 * `setupColumnCardEffects` (column view). The tests build a
 * minimal row DOM matching the JSX-literal shape that
 * `createTicketRow` / `createColumnCard` produce, register a
 * per-ticket signal via `setTickets`, install the effects, and
 * verify that mutations to the per-ticket signal (via
 * `applyServerUpdate` / `optimisticUpdate`) flow through to the
 * DOM slots in place — no re-creation, no DOM thrash on
 * surrounding siblings.
 *
 * Test goal: pin the HS-8335 contract so a regression in either
 * helper (a stale field, a missing dispose, a wrong-DOM-write)
 * fails loud rather than going visually unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyTickets } from './clipboard.js';
import { setupColumnCardEffects } from './columnView.js';
import type { Ticket } from './state.js';
import { state } from './state.js';
import { setupTicketRowEffects } from './ticketRow.js';
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

beforeEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  // Ensure the active project secret check in `cutTicketIdsSignal`
  // resolves to undefined so the cut tests don't accidentally pull
  // project state from a prior test. Clearing the clipboard is a
  // no-op when nothing was set.
  copyTickets([], false);
  document.body.innerHTML = '';
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  copyTickets([], false);
  document.body.innerHTML = '';
});

// Build a minimal `.ticket-row` DOM matching the JSX shape that
// `createTicketRow` produces. Skipping the click handlers etc. —
// `setupTicketRowEffects` only queries / writes specific child
// elements, so a hand-built skeleton is sufficient.
function buildMinimalListRow(t: Ticket): HTMLElement {
  const row = document.createElement('div');
  row.className = `ticket-row${t.up_next ? ' up-next' : ''}`;
  row.dataset.id = String(t.id);
  row.innerHTML = `
    <input type="checkbox" class="ticket-checkbox" />
    <span class="ticket-category-badge" style="background-color:#abc" title="${t.category}">CAT</span>
    <span class="ticket-number">${t.ticket_number}</span>
    <button class="ticket-status-btn" title="${t.status}"></button>
    <input type="text" class="ticket-title-input" value="${t.title}" />
    <span class="ticket-priority-indicator" style="color:#def" title="${t.priority}"></span>
    <button class="ticket-star${t.up_next ? ' active' : ''}" title="x">${t.up_next ? '★' : '☆'}</button>
  `;
  return row;
}

function buildMinimalColumnCard(t: Ticket): HTMLElement {
  const card = document.createElement('div');
  card.className = `column-card${t.up_next ? ' up-next' : ''} status-${t.status}`;
  card.dataset.id = String(t.id);
  card.innerHTML = `
    <div class="column-card-header">
      <span class="ticket-category-badge" style="background-color:#abc">CAT</span>
      <span class="ticket-number">${t.ticket_number}</span>
      <span class="ticket-priority-indicator" style="color:#def"></span>
      <button class="ticket-star${t.up_next ? ' active' : ''}" title="x">${t.up_next ? '★' : '☆'}</button>
    </div>
    <div class="column-card-title">${t.title}</div>
  `;
  return card;
}

describe('setupTicketRowEffects (HS-8335) — list-view reactivity', () => {
  it('toggles .completed class when status flips to completed/verified', () => {
    const t = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    expect(row.classList.contains('completed')).toBe(false);
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed' }));
    expect(row.classList.contains('completed')).toBe(true);
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'verified' }));
    expect(row.classList.contains('completed')).toBe(true);
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'started' }));
    expect(row.classList.contains('completed')).toBe(false);

    dispose();
  });

  it('toggles .up-next class and star symbol on up_next flip', () => {
    const t = makeTicket(1, { up_next: false });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const star = row.querySelector<HTMLElement>('.ticket-star')!;
    expect(row.classList.contains('up-next')).toBe(false);
    expect(star.textContent).toBe('☆');

    ticketsStore.actions.optimisticUpdate(1, { up_next: true });
    expect(row.classList.contains('up-next')).toBe(true);
    expect(star.classList.contains('active')).toBe(true);
    expect(star.textContent).toBe('★');
    expect(star.getAttribute('title')).toBe('Remove from Up Next');

    ticketsStore.actions.optimisticUpdate(1, { up_next: false });
    expect(row.classList.contains('up-next')).toBe(false);
    expect(star.classList.contains('active')).toBe(false);
    expect(star.textContent).toBe('☆');

    dispose();
  });

  it('updates category badge color + label when category changes', () => {
    state.categories = [
      { id: 'feature', label: 'Feature', shortLabel: 'FT', color: '#111111', shortcutKey: 'f', description: '' },
      { id: 'bug', label: 'Bug', shortLabel: 'BG', color: '#ff0000', shortcutKey: 'b', description: '' },
    ];
    const t = makeTicket(1, { category: 'feature' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const badge = row.querySelector<HTMLElement>('.ticket-category-badge')!;
    ticketsStore.actions.optimisticUpdate(1, { category: 'bug' });
    // happy-dom preserves the color string verbatim (some browsers normalise to rgb()).
    expect(badge.style.backgroundColor).toBe('#ff0000');
    expect(badge.textContent).toBe('BG');
    expect(badge.getAttribute('title')).toBe('bug');

    dispose();
  });

  it('does NOT clobber the title input while the user is focused', () => {
    const t = makeTicket(1, { title: 'Original' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const titleInput = row.querySelector<HTMLInputElement>('.ticket-title-input')!;
    titleInput.focus();
    titleInput.value = 'In-progress local edit';

    // Server-pushed title update while the input is focused.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { title: 'Server-pushed update' }));

    // The user's in-progress edit is preserved.
    expect(titleInput.value).toBe('In-progress local edit');

    // Blur the input; a subsequent server update should now apply.
    titleInput.blur();
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { title: 'Another server update' }));
    expect(titleInput.value).toBe('Another server update');

    dispose();
  });

  it('dispose() stops the effects from firing on subsequent updates', () => {
    const t = makeTicket(1, { up_next: false });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    dispose();
    ticketsStore.actions.optimisticUpdate(1, { up_next: true });
    // After dispose, the row's class shouldn't have flipped.
    expect(row.classList.contains('up-next')).toBe(false);
  });
});

describe('setupColumnCardEffects (HS-8335) — column-view reactivity', () => {
  it('toggles .up-next class and star symbol on up_next flip', () => {
    const t = makeTicket(1, { up_next: false });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    expect(card.classList.contains('up-next')).toBe(false);
    ticketsStore.actions.optimisticUpdate(1, { up_next: true });
    expect(card.classList.contains('up-next')).toBe(true);
    const star = card.querySelector<HTMLElement>('.ticket-star')!;
    expect(star.textContent).toBe('★');

    dispose();
  });

  it('updates category badge label + color when category changes', () => {
    state.categories = [
      { id: 'feature', label: 'Feature', shortLabel: 'FT', color: '#111111', shortcutKey: 'f', description: '' },
      { id: 'task', label: 'Task', shortLabel: 'TK', color: '#00ff00', shortcutKey: 't', description: '' },
    ];
    const t = makeTicket(1, { category: 'feature' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    const badge = card.querySelector<HTMLElement>('.ticket-category-badge')!;
    ticketsStore.actions.optimisticUpdate(1, { category: 'task' });
    expect(badge.textContent).toBe('TK');
    expect(badge.style.backgroundColor).toBe('#00ff00');

    dispose();
  });

  it('rebuilds the title host when the title text changes', () => {
    const t = makeTicket(1, { title: 'Original' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    const titleHost = card.querySelector<HTMLElement>('.column-card-title')!;
    ticketsStore.actions.optimisticUpdate(1, { title: 'Updated title' });
    // The title-host's text node should reflect the new value.
    expect(titleHost.textContent).toContain('Updated title');

    dispose();
  });
});
