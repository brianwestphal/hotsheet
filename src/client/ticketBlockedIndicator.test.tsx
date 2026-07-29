// @vitest-environment happy-dom
/**
 * HS-9487 — regression guard for the blocked / feedback-needed ROW INDICATORS
 * (docs/116 §116.3).
 *
 * The bug: the borders shipped in HS-9336 were wired into the list row only.
 * The column-view card (`createColumnCard`) and both preview factories still
 * emitted just `.up-next`, so on the board a blocked ticket looked exactly like
 * an unblocked one. Nothing failed, because the only existing coverage was the
 * pure `isTicketBlocked` predicate (`ticketRowHelpers.test.ts`) — which by
 * construction can't notice that a renderer never calls it.
 *
 * So these tests deliberately run the SAME expectations against EVERY ticket
 * renderer, driving the real factories rather than a hand-built DOM: a new
 * renderer (or a new indicator) is one row in `RENDERERS` away from being
 * covered, and a renderer that forgets an indicator fails here instead of going
 * visually unnoticed.
 *
 * The reactive half matters just as much: `blocked_reason` is typically set by
 * an AI through the MCP tool while the user is looking at the list, so the class
 * has to re-toggle off the per-ticket signal, not only at create time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createColumnCard, createPreviewColumnCard, setupColumnCardEffects } from './columnView.js';
import type { Ticket } from './state.js';
import { state } from './state.js';
import { registerCallbacks } from './ticketListState.js';
import { createPreviewRow, createTicketRow, setupTicketRowEffects } from './ticketRow.js';
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

/** A notes payload whose LAST note trips `hasPendingFeedback`. */
function feedbackNotes(): string {
  return JSON.stringify([
    { id: 'n1', text: 'ordinary progress note', created_at: '2026-01-01T00:00:00Z' },
    { id: 'n2', text: 'FEEDBACK NEEDED: which option should I build?', created_at: '2026-01-02T00:00:00Z' },
  ]);
}

/**
 * Every renderer that produces a user-visible ticket element. The indicator
 * expectations below run against all of them — ADD A ROW HERE when you add a
 * renderer, and the whole suite covers it.
 */
const RENDERERS: { name: string; render: (t: Ticket) => HTMLElement }[] = [
  { name: 'createTicketRow (list view)', render: createTicketRow },
  { name: 'createColumnCard (column view)', render: createColumnCard },
  { name: 'createPreviewRow (list preview)', render: createPreviewRow },
  { name: 'createPreviewColumnCard (column preview)', render: createPreviewColumnCard },
];

beforeEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  // ticketList.tsx registers these at boot; the row/card factories bind handlers
  // that call through them, so tests need no-ops rather than a `!` NPE.
  registerCallbacks({
    renderTicketList: () => { /* no-op */ },
    loadTickets: () => Promise.resolve(),
    updateSelectionClasses: () => { /* no-op */ },
    updateBatchToolbar: () => { /* no-op */ },
    updateColumnSelectionClasses: () => { /* no-op */ },
    focusDraftInput: () => { /* no-op */ },
  });
  state.selectedIds = new Set();
  document.body.innerHTML = '';
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  document.body.innerHTML = '';
});

describe.each(RENDERERS)('blocked / feedback indicators — $name (HS-9487)', ({ render }) => {
  it('marks a ticket with a non-empty blocked_reason .blocked', () => {
    const t = makeTicket(1, { blocked_reason: 'waiting on HS-1234 to land the API' });
    ticketsStore.actions.setTickets([t]);
    expect(render(t).classList.contains('blocked')).toBe(true);
  });

  it('leaves a ticket with no blocked_reason unmarked', () => {
    const t = makeTicket(2);
    ticketsStore.actions.setTickets([t]);
    const el = render(t);
    expect(el.classList.contains('blocked')).toBe(false);
    expect(el.classList.contains('feedback-needed')).toBe(false);
  });

  it('treats a whitespace-only blocked_reason as cleared', () => {
    const t = makeTicket(3, { blocked_reason: '   \n\t ' });
    ticketsStore.actions.setTickets([t]);
    expect(render(t).classList.contains('blocked')).toBe(false);
  });

  it('marks a ticket whose last note is FEEDBACK NEEDED .feedback-needed', () => {
    const t = makeTicket(4, { notes: feedbackNotes() });
    ticketsStore.actions.setTickets([t]);
    expect(render(t).classList.contains('feedback-needed')).toBe(true);
  });

  it('keeps up-next AND blocked on the same element (CSS source order picks the winner)', () => {
    // docs/116 §116.3 resolves precedence in CSS at equal specificity, NOT by
    // dropping a class — so both must be present for the cascade to decide.
    const t = makeTicket(5, { up_next: true, blocked_reason: 'waiting on a decision' });
    ticketsStore.actions.setTickets([t]);
    const el = render(t);
    expect(el.classList.contains('up-next')).toBe(true);
    expect(el.classList.contains('blocked')).toBe(true);
  });

  it('carries all three classes when a ticket is up-next, blocked, and feedback-needed', () => {
    const t = makeTicket(6, {
      up_next: true,
      blocked_reason: 'waiting on HS-1234',
      notes: feedbackNotes(),
    });
    ticketsStore.actions.setTickets([t]);
    const el = render(t);
    expect(el.classList.contains('up-next')).toBe(true);
    expect(el.classList.contains('blocked')).toBe(true);
    expect(el.classList.contains('feedback-needed')).toBe(true);
  });
});

/**
 * The live half: `blocked_reason` is usually set by an AI through
 * `hotsheet_update_ticket` while the user is watching the list, so the border
 * has to appear (and disappear) off the per-ticket signal without a re-render.
 * `bindList` preserves an existing row across data changes, so without this the
 * class would only ever be right at create time.
 */
const EFFECT_TARGETS: {
  name: string;
  create: (t: Ticket) => HTMLElement;
  setup: (el: HTMLElement, t: Ticket) => () => void;
}[] = [
  { name: 'setupTicketRowEffects (list view)', create: createTicketRow, setup: setupTicketRowEffects },
  { name: 'setupColumnCardEffects (column view)', create: createColumnCard, setup: setupColumnCardEffects },
];

describe.each(EFFECT_TARGETS)('external updates re-toggle the indicators — $name (HS-9487)', ({ create, setup }) => {
  // NOTE: `makeTicket` keeps `updated_at` fixed, so these updates change
  // `blocked_reason` and NOTHING else. That isolation is the point — it's what
  // caught HS-9487's second half: `ticketEqualForRender` (ticketsStore.ts) never
  // listed `blocked_reason`, and only passed in practice because a server
  // round-trip also bumps `updated_at`. An `optimisticUpdate` with a bare
  // `{ blocked_reason }` patch has no such cover.
  it('adds .blocked when an external update sets blocked_reason', () => {
    const t = makeTicket(10);
    ticketsStore.actions.setTickets([t]);
    const el = create(t);
    document.body.appendChild(el);
    const dispose = setup(el, t);

    expect(el.classList.contains('blocked')).toBe(false);
    ticketsStore.actions.applyServerUpdate(makeTicket(10, { blocked_reason: 'waiting on HS-1234' }));
    expect(el.classList.contains('blocked')).toBe(true);

    dispose();
  });

  it('removes .blocked when the reason is cleared', () => {
    const t = makeTicket(11, { blocked_reason: 'waiting on a decision' });
    ticketsStore.actions.setTickets([t]);
    const el = create(t);
    document.body.appendChild(el);
    const dispose = setup(el, t);

    expect(el.classList.contains('blocked')).toBe(true);
    ticketsStore.actions.applyServerUpdate(makeTicket(11, { blocked_reason: null }));
    expect(el.classList.contains('blocked')).toBe(false);

    dispose();
  });

  it('adds .feedback-needed when a FEEDBACK NEEDED note arrives, and drops it once answered', () => {
    const t = makeTicket(12);
    ticketsStore.actions.setTickets([t]);
    const el = create(t);
    document.body.appendChild(el);
    const dispose = setup(el, t);

    expect(el.classList.contains('feedback-needed')).toBe(false);
    ticketsStore.actions.applyServerUpdate(makeTicket(12, { notes: feedbackNotes() }));
    expect(el.classList.contains('feedback-needed')).toBe(true);

    // The user answers: a later note supersedes the question (only the LAST
    // note is checked), so the border clears.
    ticketsStore.actions.applyServerUpdate(makeTicket(12, {
      notes: JSON.stringify([
        { id: 'n2', text: 'FEEDBACK NEEDED: which option?', created_at: '2026-01-02T00:00:00Z' },
        { id: 'n3', text: 'option 3', created_at: '2026-01-03T00:00:00Z' },
      ]),
    }));
    expect(el.classList.contains('feedback-needed')).toBe(false);

    dispose();
  });

  it('stops updating after dispose', () => {
    const t = makeTicket(13);
    ticketsStore.actions.setTickets([t]);
    const el = create(t);
    document.body.appendChild(el);
    setup(el, t)();

    ticketsStore.actions.applyServerUpdate(makeTicket(13, { blocked_reason: 'waiting on HS-1234' }));
    expect(el.classList.contains('blocked')).toBe(false);
  });
});
