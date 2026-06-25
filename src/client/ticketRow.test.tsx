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

import { applyClaims } from './claimsStore.js';
import { copyTickets } from './clipboard.js';
import { setupColumnCardEffects } from './columnView.js';
import { toElement } from './dom.js';
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
  // Clear any distributed-execution claims leaked from a prior test file — the
  // claimed-by/merge-pending row effect reads `claimsByTicketId`, so a stray claim
  // for a reused ticket id would render the claim chip instead of the badge.
  applyClaims([]);
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
  // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
  row.replaceChildren(
    toElement(<input type="checkbox" className="ticket-checkbox" />),
    toElement(<span className="ticket-category-badge" style="background-color:#abc" title={t.category}>CAT</span>),
    toElement(<span className="ticket-number">{t.ticket_number}</span>),
    toElement(<button className="ticket-status-btn" title={t.status}></button>),
    toElement(<input type="text" className="ticket-title-input" value={t.title} />),
    toElement(<span className="ticket-priority-indicator" style="color:#def" title={t.priority}></span>),
    toElement(<button className={`ticket-star${t.up_next ? ' active' : ''}`} title="x">{t.up_next ? '★' : '☆'}</button>),
  );
  return row;
}

function buildMinimalColumnCard(t: Ticket): HTMLElement {
  const card = document.createElement('div');
  card.className = `column-card${t.up_next ? ' up-next' : ''} status-${t.status}`;
  card.dataset.id = String(t.id);
  // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
  card.replaceChildren(
    toElement(
      <div className="column-card-header">
        <span className="ticket-category-badge" style="background-color:#abc">CAT</span>
        <span className="ticket-number">{t.ticket_number}</span>
        <span className="ticket-priority-indicator" style="color:#def"></span>
        <button className={`ticket-star${t.up_next ? ' active' : ''}`} title="x">{t.up_next ? '★' : '☆'}</button>
      </div>
    ),
    toElement(<div className="column-card-title">{t.title}</div>),
    toElement(<div className="column-card-claimed-slot"></div>), // HS-9035
  );
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

  // HS-9045 — a completed-but-unmerged ticket gets the .pending-merge class + a
  // "merge pending" badge in the claimed slot; both clear once the owner integrates.
  it('shows the pending-merge class + badge for a completed, unmerged ticket', () => {
    const t = makeTicket(1, { status: 'started', pending_integration: false });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    row.appendChild(toElement(<span className="ticket-claimed-slot"></span>));
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    // Worker completes the ticket on its own branch (not yet merged).
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed', pending_integration: true }));
    expect(row.classList.contains('pending-merge')).toBe(true);
    expect(row.querySelector('.ticket-pending-merge')).not.toBeNull();

    // Owner integrates the branch → flag cleared → indicator gone.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed', pending_integration: false }));
    expect(row.classList.contains('pending-merge')).toBe(false);
    expect(row.querySelector('.ticket-pending-merge')).toBeNull();

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

  it('tags appear on list rows after the title input and react to changes (HS-8307)', () => {
    // HS-8307 flipped this from "not rendered by design" to "rendered
    // after the title". The JSX-literal in `createTicketRow` emits a
    // `.ticket-row-tags` container with `.ticket-row-tag` chips, and
    // the combined effect's tags-sync branch keeps it aligned with the
    // store's `tags` field on every change.
    const t = makeTicket(1, { tags: '["alpha","beta","gamma"]' });
    ticketsStore.actions.setTickets([t]);
    // Seed the row's DOM with the same shape `createTicketRow` produces
    // so the test exercises the effect's update path, not the initial
    // JSX-literal render. The minimal builder doesn't include the tag
    // container; we mount the seed manually here to match production.
    const row = buildMinimalListRow(t);
    const seedTags = document.createElement('div');
    seedTags.className = 'ticket-row-tags';
    // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
    seedTags.replaceChildren(
      toElement(<span className="ticket-row-tag">alpha</span>),
      toElement(<span className="ticket-row-tag">beta</span>),
      toElement(<span className="ticket-row-tag">gamma</span>),
    );
    const priIndicator = row.querySelector<HTMLElement>('.ticket-priority-indicator')!;
    row.insertBefore(seedTags, priIndicator);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    // Same tags → effect's dirty check skips the rebuild; the seeded
    // chips are still present.
    expect(row.querySelectorAll('.ticket-row-tag')).toHaveLength(3);
    expect(Array.from(row.querySelectorAll('.ticket-row-tag')).map(el => el.textContent)).toEqual(['alpha', 'beta', 'gamma']);

    // Replace the tag list — container stays, children rebuild in place.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { tags: '["delta","echo"]' }));
    const after = row.querySelector<HTMLElement>('.ticket-row-tags')!;
    expect(after).not.toBeNull();
    expect(Array.from(after.querySelectorAll('.ticket-row-tag')).map(el => el.textContent)).toEqual(['delta', 'echo']);

    // Empty tags → container removed entirely.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { tags: '[]' }));
    expect(row.querySelector('.ticket-row-tags')).toBeNull();

    // Re-add a tag → container reinserted before the priority indicator.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { tags: '["zeta"]' }));
    const reinserted = row.querySelector<HTMLElement>('.ticket-row-tags');
    expect(reinserted).not.toBeNull();
    expect(reinserted!.nextElementSibling).toBe(priIndicator);
    expect(reinserted!.querySelector('.ticket-row-tag')?.textContent).toBe('zeta');

    dispose();
  });

  it('tag-container preserves element identity across in-place rebuilds (HS-8307)', () => {
    // Mirrors the HS-8409 column-card "rebuild in place preserves
    // container identity" test — important for any future hover anchor
    // / animation that captures the container ref.
    const t = makeTicket(1, { tags: '["a","b"]' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    const seed = document.createElement('div');
    seed.className = 'ticket-row-tags';
    seed.replaceChildren(
      toElement(<span className="ticket-row-tag">a</span>),
      toElement(<span className="ticket-row-tag">b</span>),
    );
    const priIndicator = row.querySelector<HTMLElement>('.ticket-priority-indicator')!;
    row.insertBefore(seed, priIndicator);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const originalContainer = row.querySelector<HTMLElement>('.ticket-row-tags')!;
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { tags: '["c"]' }));
    expect(row.querySelector<HTMLElement>('.ticket-row-tags')).toBe(originalContainer);
    expect(Array.from(originalContainer.querySelectorAll('.ticket-row-tag')).map(el => el.textContent)).toEqual(['c']);

    dispose();
  });
});

describe('per-ticket signal fires when route through the store (HS-8367 regression guard)', () => {
  // HS-8367 — the bug: `cycleStatus` / `setTicketField` / category +
  // priority menu callbacks were doing `Object.assign(ticket, updated)`
  // WITHOUT routing through `ticketsStore.actions.applyServerUpdate`.
  // The store's per-ticket signal value is the SAME object reference
  // as the closure's `ticket` (the store stores the live reference).
  // After `Object.assign`, the structural-equal check in
  // `applyServerUpdate` (and the later `reconcilePerTicketSignals`
  // walk on `loadTickets`'s `setTickets`) sees `signal.value` ===
  // updated and SKIPS firing — so the per-row reactive effect from
  // HS-8335 never re-paints. The fix orders applyServerUpdate BEFORE
  // `Object.assign` so the signal sees the OLD ticket (still in
  // `signal.value`) ≠ updated and fires.

  it('applyServerUpdate(updated) FIRES the per-ticket signal when current value differs', () => {
    const t = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const btn = row.querySelector<HTMLElement>('.ticket-status-btn')!;
    // The stub row uses `title="${t.status}"` (underscore) — initial.
    expect(btn.getAttribute('title')).toBe('not_started');

    // Production-equivalent flow: applyServerUpdate FIRST (signal
    // fires because store's signal value is still the OLD ticket),
    // THEN Object.assign the closure for subsequent reads.
    const updated = makeTicket(1, { status: 'started' });
    ticketsStore.actions.applyServerUpdate(updated);
    Object.assign(t, updated);

    // The effect fired → button title flipped in place.
    expect(btn.getAttribute('title')).toBe('started');

    dispose();
  });

  it('Object.assign BEFORE applyServerUpdate does NOT fire the signal (pinning the bug shape so a future refactor that re-introduces it fails this test)', () => {
    const t = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const row = buildMinimalListRow(t);
    document.body.appendChild(row);
    const dispose = setupTicketRowEffects(row, t);

    const btn = row.querySelector<HTMLElement>('.ticket-status-btn')!;
    expect(btn.getAttribute('title')).toBe('not_started');

    // BUG SHAPE — mutate the closure (which is the same reference
    // held by the signal) BEFORE calling applyServerUpdate. The
    // signal sees its value === updated (structurally equal) and
    // skips firing.
    const updated = makeTicket(1, { status: 'started' });
    Object.assign(t, updated);
    ticketsStore.actions.applyServerUpdate(updated);

    // Title attr stays at 'not_started' — the bug shape doesn't fire
    // the signal. This assertion pins the bug so a future refactor
    // that flips the order back will be caught by this regression.
    expect(btn.getAttribute('title')).toBe('not_started');

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

  // HS-9035 — list view showed the claimed-by worker chip but column view didn't.
  it('shows the claimed-by chip in the column card while claimed, and clears on release', () => {
    const t = makeTicket(1, { status: 'started' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    applyClaims([{
      ticketId: 1, ticketNumber: 'HS-1', title: 'T', claimedBy: 'worker-1',
      workerLabel: 'worker-1', leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    }]);
    expect(card.querySelector('.column-card-claimed-slot .claimed-by-chip')).not.toBeNull();

    applyClaims([]);
    expect(card.querySelector('.column-card-claimed-slot .claimed-by-chip')).toBeNull();

    dispose();
  });

  it('shows the merge-pending badge in the column card for a completed, unmerged ticket', () => {
    const t = makeTicket(1, { status: 'started', pending_integration: false });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed', pending_integration: true }));
    expect(card.querySelector('.column-card-claimed-slot .ticket-pending-merge')).not.toBeNull();

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'completed', pending_integration: false }));
    expect(card.querySelector('.column-card-claimed-slot .ticket-pending-merge')).toBeNull();

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

describe('setupColumnCardEffects (HS-8409) — tag chips stay in sync with ticket.tags', () => {
  // Pre-fix the per-card effect updated category / priority / up_next / title
  // but not tags, so a tag add / remove in the detail panel left the column
  // card's chip row stale until the next column-view rebuild (e.g. column
  // configuration change or project switch).

  it('adds the .column-card-tags container when going from no tags to some tags', () => {
    const t = makeTicket(1, { tags: '[]' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    expect(card.querySelector('.column-card-tags')).toBeNull();

    ticketsStore.actions.optimisticUpdate(1, { tags: JSON.stringify(['admin', 'dashboard']) });

    const tagsEl = card.querySelector<HTMLElement>('.column-card-tags');
    expect(tagsEl).not.toBeNull();
    const chips = tagsEl!.querySelectorAll<HTMLElement>('.column-card-tag');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('admin');
    expect(chips[1].textContent).toBe('dashboard');

    dispose();
  });

  it('removes the .column-card-tags container when the last tag is removed', () => {
    const t = makeTicket(1, { tags: JSON.stringify(['only-tag']) });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    // Seed the card with the tags container so the test starts in the
    // post-render state (the live JSX would have rendered it; the
    // minimal-card helper omits it intentionally).
    const seededTags1 = document.createElement('div');
    seededTags1.className = 'column-card-tags';
    seededTags1.replaceChildren(toElement(<span className="column-card-tag">only-tag</span>));
    card.appendChild(seededTags1);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    ticketsStore.actions.optimisticUpdate(1, { tags: '[]' });

    expect(card.querySelector('.column-card-tags')).toBeNull();

    dispose();
  });

  it('rebuilds the chips in place when the tag set changes (container element identity preserved)', () => {
    const t = makeTicket(1, { tags: JSON.stringify(['a', 'b']) });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    const seededTags2 = document.createElement('div');
    seededTags2.className = 'column-card-tags';
    seededTags2.replaceChildren(
      toElement(<span className="column-card-tag">a</span>),
      toElement(<span className="column-card-tag">b</span>),
    );
    card.appendChild(seededTags2);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    const originalContainer = card.querySelector<HTMLElement>('.column-card-tags')!;

    ticketsStore.actions.optimisticUpdate(1, { tags: JSON.stringify(['c']) });

    // Container element identity preserved across the rebuild.
    expect(card.querySelector<HTMLElement>('.column-card-tags')).toBe(originalContainer);
    const chips = originalContainer.querySelectorAll<HTMLElement>('.column-card-tag');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('c');

    dispose();
  });

  it('inserts the container immediately after .column-card-title (matches JSX-literal order)', () => {
    const t = makeTicket(1, { tags: '[]' });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    ticketsStore.actions.optimisticUpdate(1, { tags: JSON.stringify(['x']) });

    const titleHost = card.querySelector<HTMLElement>('.column-card-title');
    const tagsEl = card.querySelector<HTMLElement>('.column-card-tags');
    expect(titleHost).not.toBeNull();
    expect(tagsEl).not.toBeNull();
    expect(titleHost!.nextElementSibling).toBe(tagsEl);

    dispose();
  });

  it('server update with same tags string is a no-op (no DOM thrash)', () => {
    const t = makeTicket(1, { tags: JSON.stringify(['stable']) });
    ticketsStore.actions.setTickets([t]);
    const card = buildMinimalColumnCard(t);
    const seededTags3 = document.createElement('div');
    seededTags3.className = 'column-card-tags';
    seededTags3.replaceChildren(toElement(<span className="column-card-tag">stable</span>));
    card.appendChild(seededTags3);
    document.body.appendChild(card);
    const dispose = setupColumnCardEffects(card, t);

    const originalContainer = card.querySelector<HTMLElement>('.column-card-tags')!;
    const originalChip = originalContainer.querySelector<HTMLElement>('.column-card-tag')!;

    // Server pushes an update that doesn't change the tags — flip a
    // different field. The dirty-check on the raw string should skip
    // the tag-sync branch entirely; the chip element identity should
    // be preserved.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, {
      title: 'New title',
      tags: JSON.stringify(['stable']),
    }));

    expect(card.querySelector<HTMLElement>('.column-card-tag')).toBe(originalChip);

    dispose();
  });
});
