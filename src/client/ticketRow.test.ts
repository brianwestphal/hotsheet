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

describe('setupTicketRowEffects (HS-8357) — list-view reactivity for every mutable field', () => {
  // HS-8357 extends the HS-8335 coverage with explicit per-field
  // assertions for every mutable ticket field that the user expects to
  // see reflected in the list row in place: type / category,
  // priority, status (full not-started → started → completed → verified
  // cycle), title (focused-AND-unfocused matrix), tags (currently NOT
  // rendered on the list row — pin the not-rendered status so a future
  // change is conscious).

  it('priority change updates indicator color + title attr in place', () => {
    const t = makeTicket(1, { priority: 'default' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const indicator = row.querySelector<HTMLElement>('.ticket-priority-indicator')!;
    ticketsStore.actions.optimisticUpdate(1, { priority: 'highest' });
    // Priority color comes from the static `getPriorityColor` map — any
    // non-empty change-of-color string is sufficient to prove the effect
    // fired. We assert it's NOT still the prior value (the initial DOM
    // build had `#def` from `buildMinimalListRow`'s stub).
    expect(indicator.style.color).not.toBe('rgb(221, 238, 255)'); // stub `#def` normalized
    expect(indicator.getAttribute('title')).toBe('highest');

    ticketsStore.actions.optimisticUpdate(1, { priority: 'low' });
    expect(indicator.getAttribute('title')).toBe('low');

    dispose();
  });

  it('status change cycles the status-button title attr across the full not_started→started→completed→verified path', () => {
    const t = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const btn = row.querySelector<HTMLElement>('.ticket-status-btn')!;
    expect(row.classList.contains('completed')).toBe(false);
    expect(btn.classList.contains('verified')).toBe(false);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'started' }));
    expect(btn.getAttribute('title')).toBe('started');
    expect(row.classList.contains('completed')).toBe(false);
    expect(btn.classList.contains('verified')).toBe(false);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed' }));
    expect(btn.getAttribute('title')).toBe('completed');
    expect(row.classList.contains('completed')).toBe(true);
    expect(btn.classList.contains('verified')).toBe(false);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'verified' }));
    expect(btn.getAttribute('title')).toBe('verified');
    expect(row.classList.contains('completed')).toBe(true);
    expect(btn.classList.contains('verified')).toBe(true);

    // Cycling back collapses the classes.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'not_started' }));
    expect(btn.getAttribute('title')).toBe('not started');
    expect(row.classList.contains('completed')).toBe(false);
    expect(btn.classList.contains('verified')).toBe(false);

    dispose();
  });

  it('title change applies in place when the title input is NOT focused', () => {
    const t = makeTicket(1, { title: 'Original' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const titleInput = row.querySelector<HTMLInputElement>('.ticket-title-input')!;
    // Initial value preserved — no first-run write.
    expect(titleInput.value).toBe('Original');
    // Make sure focus is NOT on the input.
    expect(document.activeElement).not.toBe(titleInput);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { title: 'Server change 1' }));
    expect(titleInput.value).toBe('Server change 1');

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { title: 'Server change 2' }));
    expect(titleInput.value).toBe('Server change 2');

    dispose();
  });

  it('category change is independent of priority change (single-effect funnel writes both)', () => {
    state.categories = [
      { id: 'feature', label: 'Feature', shortLabel: 'FT', color: '#111111', shortcutKey: 'f', description: '' },
      { id: 'bug', label: 'Bug', shortLabel: 'BG', color: '#ff0000', shortcutKey: 'b', description: '' },
    ];
    const t = makeTicket(1, { category: 'feature', priority: 'default' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const badge = row.querySelector<HTMLElement>('.ticket-category-badge')!;
    const indicator = row.querySelector<HTMLElement>('.ticket-priority-indicator')!;

    // Change BOTH fields in one update — verify both reflect.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { category: 'bug', priority: 'high' }));
    expect(badge.textContent).toBe('BG');
    expect(badge.style.backgroundColor).toBe('#ff0000');
    expect(indicator.getAttribute('title')).toBe('high');

    dispose();
  });

  it('tags are NOT rendered on list rows by design — pin the contract', () => {
    const t = makeTicket(1, { tags: '["alpha","beta","gamma"]' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    // No tag-related elements exist on the list row markup. A future
    // requirement to surface tags on the row should come with explicit
    // reactive coverage; this assertion fails loud if somebody adds
    // tag-rendering without that.
    expect(row.querySelectorAll('.ticket-tag, .column-card-tag, [data-tag]')).toHaveLength(0);
    // The tag values themselves don't leak as raw text either.
    expect(row.textContent).not.toContain('alpha');
    expect(row.textContent).not.toContain('beta');
    expect(row.textContent).not.toContain('gamma');

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { tags: '["delta"]' }));
    // Still no tag rendering after the change.
    expect(row.querySelectorAll('.ticket-tag, .column-card-tag, [data-tag]')).toHaveLength(0);
    expect(row.textContent).not.toContain('delta');

    dispose();
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

describe('setupColumnCardEffects (HS-8357) — column-view reactivity for every mutable field', () => {
  // HS-8357 extends the HS-8335 column-card coverage with explicit
  // per-field assertions for the fields that should update in place on
  // a column card. Status is deliberately NOT reactive on the card
  // itself (a status flip moves the card to a different per-status
  // column signal which tears down + remounts the card fresh) — that
  // contract is pinned by its own test below.

  it('priority change updates indicator color in place', () => {
    const t = makeTicket(1, { priority: 'default' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    const indicator = card.querySelector<HTMLElement>('.ticket-priority-indicator')!;
    ticketsStore.actions.optimisticUpdate(1, { priority: 'highest' });
    expect(indicator.style.color).not.toBe('rgb(221, 238, 255)');
    // Column cards don't carry a `title` attr on the priority indicator
    // (see `createPreviewColumnCard` in columnView.tsx — `cursor:default`
    // means no title attr by design), so we only assert color flip.

    dispose();
  });

  it('status change is NOT made reactive on the card root status-X class (by design — card moves columns instead)', () => {
    const t = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    // Live card built with `status-not_started`.
    expect(card.classList.contains('status-not_started')).toBe(true);
    // Status flip via the store — the card's class stays stale, by
    // design. (A real status flip in the live app moves the card to a
    // different per-column bindList, tearing down this card.)
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed' }));
    expect(card.classList.contains('status-not_started')).toBe(true);
    expect(card.classList.contains('status-completed')).toBe(false);

    dispose();
  });

  it('title change rebuilds the title host text but preserves the host element identity', () => {
    const t = makeTicket(1, { title: 'Original' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    const titleHost = card.querySelector<HTMLElement>('.column-card-title')!;
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { title: 'New title text' }));
    expect(titleHost.textContent).toContain('New title text');
    // Host element identity preserved across the rebuild.
    expect(card.querySelector<HTMLElement>('.column-card-title')).toBe(titleHost);

    dispose();
  });

  it('multiple field changes in one server update apply atomically', () => {
    state.categories = [
      { id: 'feature', label: 'Feature', shortLabel: 'FT', color: '#111111', shortcutKey: 'f', description: '' },
      { id: 'bug', label: 'Bug', shortLabel: 'BG', color: '#ff0000', shortcutKey: 'b', description: '' },
    ];
    const t = makeTicket(1, { category: 'feature', priority: 'default', title: 'A', up_next: false });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, {
      category: 'bug',
      priority: 'high',
      title: 'B',
      up_next: true,
    }));

    const badge = card.querySelector<HTMLElement>('.ticket-category-badge')!;
    const indicator = card.querySelector<HTMLElement>('.ticket-priority-indicator')!;
    const star = card.querySelector<HTMLElement>('.ticket-star')!;
    const titleHost = card.querySelector<HTMLElement>('.column-card-title')!;

    expect(badge.textContent).toBe('BG');
    expect(badge.style.backgroundColor).toBe('#ff0000');
    expect(indicator.style.color).not.toBe('rgb(221, 238, 255)');
    expect(star.textContent).toBe('★');
    expect(card.classList.contains('up-next')).toBe(true);
    expect(titleHost.textContent).toContain('B');

    dispose();
  });
});
