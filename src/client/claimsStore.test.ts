// HS-8864 — claims store reactive lookups (docs/90 §90.8). The poll/tick timers
// are exercised via the live app; here we cover the pure data layer.
import { afterEach, describe, expect, it } from 'vitest';

import type { ClaimRow } from '../api/index.js';
import { _setClaimsForTesting, claimForTicket, claimsByTicketId, claimsListSignal } from './claimsStore.js';

const claim = (id: number): ClaimRow => ({
  ticketId: id, ticketNumber: `HS-${String(id)}`, title: `t${String(id)}`,
  claimedBy: `w-${String(id)}`, workerLabel: `worker-${String(id)}`, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
});

afterEach(() => _setClaimsForTesting([]));

describe('claimsStore (HS-8864)', () => {
  it('applyClaims drives the list + the by-ticket-id map + claimForTicket', () => {
    _setClaimsForTesting([claim(1), claim(2)]);
    expect(claimsListSignal.value.map(c => c.ticketId)).toEqual([1, 2]);
    expect(claimsByTicketId.value.get(2)?.claimedBy).toBe('w-2');
    expect(claimForTicket(1)?.ticketNumber).toBe('HS-1');
    expect(claimForTicket(99)).toBeUndefined();
  });

  it('replacing the claim set clears stale entries', () => {
    _setClaimsForTesting([claim(1), claim(2)]);
    _setClaimsForTesting([claim(2)]);
    expect(claimForTicket(1)).toBeUndefined();
    expect(claimForTicket(2)).toBeDefined();
    expect(claimsByTicketId.value.size).toBe(1);
  });
});
