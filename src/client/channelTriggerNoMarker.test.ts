// @vitest-environment happy-dom
/**
 * HS-9248 — regression guard: a channel trigger must NOT carry a
 * selection-derived `<!-- hotsheet:ticket=HS-N -->` marker.
 *
 * The old `tagMessageWithActiveTicket` prepended that marker off
 * `state.activeTicketId` — "whatever the detail panel shows" — so a merely
 * selected (or just-created) ticket rode into the prompt and, on the no-message
 * play-button flow, became the entire prompt and read like a "work this ticket"
 * directive. This pins that `triggerChannelAndMarkBusy` forwards the caller's
 * message VERBATIM regardless of which ticket is active, so per-ticket
 * attribution is time-window-only for new work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auto-mock the API module so `triggerChannel` (and `ensureSkills`) are vi.fn()s
// we can assert on instead of hitting the network.
vi.mock('../api/index.js');

// eslint-disable-next-line import/first
import { triggerChannel } from '../api/index.js';
// eslint-disable-next-line import/first
import type { Ticket } from '../types.js';
// eslint-disable-next-line import/first
import { triggerChannelAndMarkBusy } from './channelUI.js';
// eslint-disable-next-line import/first
import { state } from './state.js';

describe('HS-9248 — channel trigger carries no selection-derived ticket marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A ticket IS open in the detail panel — the exact state that used to leak a marker.
    state.tickets = [{ id: 42, ticket_number: 'HS-42' } as Ticket];
    state.activeTicketId = 42;
  });

  it('forwards an explicit message verbatim (no marker prepended)', () => {
    triggerChannelAndMarkBusy('do the thing');
    expect(triggerChannel).toHaveBeenCalledWith('do the thing', undefined);
  });

  it('forwards undefined for the no-message play-button flow (no bare marker becomes the prompt)', () => {
    triggerChannelAndMarkBusy();
    expect(triggerChannel).toHaveBeenCalledWith(undefined, undefined);
  });

  it('never injects a hotsheet:ticket marker even with an active ticket', () => {
    triggerChannelAndMarkBusy('hello');
    const forwarded = vi.mocked(triggerChannel).mock.calls[0][0] ?? '';
    expect(forwarded).not.toContain('hotsheet:ticket=');
  });

  it('passes an explicit target through unchanged', () => {
    triggerChannelAndMarkBusy('x', { kind: 'all-workers' });
    expect(triggerChannel).toHaveBeenCalledWith('x', { kind: 'all-workers' });
  });
});
