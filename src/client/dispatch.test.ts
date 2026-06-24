// HS-8964 — coordinator-dispatch helper (docs/92 §92.3).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimTicket } from '../api/index.js';
import { dispatchSummary, dispatchTicketsToWorker } from './dispatch.js';

vi.mock('../api/index.js', () => ({ claimTicket: vi.fn() }));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));

const mockClaim = vi.mocked(claimTicket);
afterEach(() => vi.clearAllMocks());

describe('dispatchTicketsToWorker (HS-8964)', () => {
  it('claims each ticket for the target worker and counts successes', async () => {
    mockClaim.mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof claimTicket>>);
    const r = await dispatchTicketsToWorker('w1', 'worker-1', [1, 2, 3]);
    expect(r.dispatched).toBe(3);
    expect(r.failures).toEqual([]);
    expect(mockClaim).toHaveBeenCalledWith(1, { worker: 'w1', label: 'worker-1' });
    expect(mockClaim).toHaveBeenCalledTimes(3);
  });

  it('collects per-ticket failures (e.g. a 409 conflict) without aborting the batch', async () => {
    mockClaim
      .mockResolvedValueOnce({ ok: true } as Awaited<ReturnType<typeof claimTicket>>)
      .mockRejectedValueOnce(new Error('already claimed by worker-2'))
      .mockResolvedValueOnce({ ok: true } as Awaited<ReturnType<typeof claimTicket>>);
    const r = await dispatchTicketsToWorker('w1', 'worker-1', [1, 2, 3]);
    expect(r.dispatched).toBe(2);
    expect(r.failures).toEqual(['already claimed by worker-2']);
  });
});

describe('dispatchSummary (HS-8964)', () => {
  it('summarizes a clean dispatch', () => {
    expect(dispatchSummary({ dispatched: 2, failures: [] }, 'worker-1')).toBe('Dispatched 2 tickets to worker-1');
    expect(dispatchSummary({ dispatched: 1, failures: [] }, 'worker-1')).toBe('Dispatched 1 ticket to worker-1');
  });

  it('reports + de-dups failures', () => {
    const s = dispatchSummary({ dispatched: 1, failures: ['already claimed by worker-2', 'already claimed by worker-2'] }, 'worker-1');
    expect(s).toContain('Dispatched 1 ticket to worker-1');
    expect(s).toContain('2 not dispatched (already claimed by worker-2)');
  });

  it('handles an all-failed dispatch', () => {
    expect(dispatchSummary({ dispatched: 0, failures: ['already claimed by worker-2'] }, 'worker-1'))
      .toBe('1 not dispatched (already claimed by worker-2)');
  });
});
