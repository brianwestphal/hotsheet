// @vitest-environment happy-dom
/**
 * §61 / HS-8238 — coverage for the trial migration of attention-dot
 * state to a kerf `defineStore`. The store-level wiring is exercised
 * via the public mark / clear helpers exported from `channelUI.tsx`,
 * so the test pins the production contract not the internal store
 * shape.
 *
 * `_projectAttentionStoreForTesting.reset()` is called in `beforeEach`
 * to isolate cases — the in-module `Set`-backed store would otherwise
 * leak state across tests since `defineStore` registers globally.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Ticket } from '../types.js';
import {
  _projectAttentionStoreForTesting,
  _testing as _channelUiTesting,
  clearProjectAttention,
  getProjectAttentionSecrets,
  markProjectAttention,
} from './channelUI.js';
import { resetAllStores } from './reactive.js';
import { state } from './state.js';

beforeEach(() => {
  // Mount a no-op `.project-tab-dot` so the lazy-imported `syncDots`
  // path inside mark/clearAttention finds a target to write to (even
  // though we don't assert dot styling here — that's projectTabs.tsx
  // territory). Without it, syncDots short-circuits cleanly anyway.
  document.body.innerHTML = '';
  _projectAttentionStoreForTesting.reset();
});

afterEach(() => {
  _projectAttentionStoreForTesting.reset();
  document.body.innerHTML = '';
});

describe('channelUI attention store (HS-8238 / §61 Phase 1 trial)', () => {
  it('initial state — no projects flagged', () => {
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('markProjectAttention adds the secret + clearProjectAttention removes it', () => {
    markProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().has('sec-a')).toBe(true);

    markProjectAttention('sec-b');
    expect(getProjectAttentionSecrets().size).toBe(2);

    clearProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().has('sec-a')).toBe(false);
    expect(getProjectAttentionSecrets().has('sec-b')).toBe(true);
  });

  it('marking an already-flagged project is a no-op (no duplicate, no throw)', () => {
    markProjectAttention('sec-a');
    markProjectAttention('sec-a');
    markProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().size).toBe(1);
  });

  it('clearing an unflagged project is a no-op (no throw)', () => {
    expect(() => clearProjectAttention('never-flagged')).not.toThrow();
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('store reset() returns to the initial empty Set', () => {
    markProjectAttention('sec-a');
    markProjectAttention('sec-b');
    expect(getProjectAttentionSecrets().size).toBe(2);
    _projectAttentionStoreForTesting.reset();
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('global resetAllStores() also resets the attention store (registry membership)', () => {
    markProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().size).toBe(1);
    resetAllStores();
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('store mutations produce a new Set reference each time (immutable update — required for downstream signal-driven consumers)', () => {
    const before = getProjectAttentionSecrets();
    markProjectAttention('sec-a');
    const after = getProjectAttentionSecrets();
    expect(after).not.toBe(before);
    expect(before.size).toBe(0);
    expect(after.size).toBe(1);
  });
});

// HS-8537 — the per-ticket cost rollup (§67.10.7 / HS-8152) only works
// when the `<!-- hotsheet:ticket=HS-NNNN -->` marker reaches the prompt
// body Claude Code captures in `claude_code.user_prompt`. The marker is
// injected client-side at channel-trigger time; this suite pins the
// injection contract so the marker doesn't silently regress to "only
// added when the caller passes a non-empty message."
describe('tagMessageWithActiveTicket (HS-8537 / HS-8152 marker injection)', () => {
  const { tagMessageWithActiveTicket } = _channelUiTesting;
  // Only `id` and `ticket_number` are read by `tagMessageWithActiveTicket`;
  // the rest of the Ticket shape isn't exercised here.
  const fakeTicket = (id: number, ticket_number: string): Ticket =>
    ({ id, ticket_number } as Ticket);

  beforeEach(() => {
    state.tickets = [];
    state.activeTicketId = null;
  });

  it('returns the caller message unchanged when there is no active ticket', () => {
    expect(tagMessageWithActiveTicket('hello')).toBe('hello');
  });

  it('returns undefined when there is no message AND no active ticket (genuinely contextless trigger)', () => {
    expect(tagMessageWithActiveTicket(undefined)).toBeUndefined();
  });

  it('prepends the marker to the caller message when there is an active ticket', () => {
    state.tickets = [fakeTicket(42, 'HS-42')];
    state.activeTicketId = 42;
    expect(tagMessageWithActiveTicket('hello')).toBe('<!-- hotsheet:ticket=HS-42 -->\n\nhello');
  });

  // The regression this test pins: pre-HS-8537 the helper short-circuited
  // on `message === undefined`, so the play-button flow (which calls
  // `triggerChannelAndMarkBusy()` with no args) never injected the marker,
  // and the per-ticket rollup never attributed anything.
  it('returns the bare marker when the caller passed no message but there IS an active ticket', () => {
    state.tickets = [fakeTicket(42, 'HS-42')];
    state.activeTicketId = 42;
    expect(tagMessageWithActiveTicket(undefined)).toBe('<!-- hotsheet:ticket=HS-42 -->');
    expect(tagMessageWithActiveTicket('')).toBe('<!-- hotsheet:ticket=HS-42 -->');
  });

  it('returns the message unchanged when the active ticket id does not match any loaded ticket', () => {
    state.tickets = [fakeTicket(42, 'HS-42')];
    state.activeTicketId = 9999;
    expect(tagMessageWithActiveTicket('hello')).toBe('hello');
    expect(tagMessageWithActiveTicket(undefined)).toBeUndefined();
  });
});
