// HS-9336 (docs/116) — the free-text `blocked_reason` column round-trips through
// createTicket/updateTicket/getTicket and clears cleanly. Distinct from the structured
// `ticket_blocked_by` gate (see blockedBy.test.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { createTicket, getTicket, getTicketStatusesByNumbers, updateTicket } from './tickets.js';

let dataDir: string;
beforeEach(async () => { dataDir = await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(dataDir); });

describe('blocked_reason (HS-9336)', () => {
  it('defaults to null/undefined on a fresh ticket', async () => {
    const t = await createTicket('fresh', {});
    const read = await getTicket(t.id);
    // Nullable column with no default — absent reads as null.
    expect(read?.blocked_reason ?? null).toBeNull();
  });

  it('persists a set reason and reads it back', async () => {
    const t = await createTicket('blocked one', {});
    const updated = await updateTicket(t.id, { blocked_reason: 'waiting on HS-1234 to land the API' });
    expect(updated?.blocked_reason).toBe('waiting on HS-1234 to land the API');
    const read = await getTicket(t.id);
    expect(read?.blocked_reason).toBe('waiting on HS-1234 to land the API');
  });

  it('clears the reason when set back to null', async () => {
    const t = await createTicket('temporarily blocked', {});
    await updateTicket(t.id, { blocked_reason: 'needs design sign-off' });
    const cleared = await updateTicket(t.id, { blocked_reason: null });
    expect(cleared?.blocked_reason ?? null).toBeNull();
    const read = await getTicket(t.id);
    expect(read?.blocked_reason ?? null).toBeNull();
  });

  it('is independent of other field updates (a status change leaves it intact)', async () => {
    const t = await createTicket('still blocked', {});
    await updateTicket(t.id, { blocked_reason: 'waiting on an external service' });
    const afterStatus = await updateTicket(t.id, { status: 'started' });
    expect(afterStatus?.blocked_reason).toBe('waiting on an external service');
  });
});

describe('getTicketStatusesByNumbers (HS-9337)', () => {
  it('batch-resolves statuses keyed by uppercased ticket_number; absent numbers omitted', async () => {
    const a = await createTicket('done one', {});
    await updateTicket(a.id, { status: 'completed' });
    const b = await createTicket('open one', {}); // not_started

    const map = await getTicketStatusesByNumbers([a.ticket_number.toLowerCase(), b.ticket_number, 'HS-999999']);
    expect(map.get(a.ticket_number.toUpperCase())).toBe('completed');
    expect(map.get(b.ticket_number.toUpperCase())).toBe('not_started');
    expect(map.has('HS-999999')).toBe(false); // no such ticket → absent
  });

  it('returns an empty map (no query) for an empty input', async () => {
    const map = await getTicketStatusesByNumbers([]);
    expect(map.size).toBe(0);
  });
});
