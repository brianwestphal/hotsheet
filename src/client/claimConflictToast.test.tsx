// @vitest-environment happy-dom
/**
 * HS-9287 — the claim-conflict toast shown when a write hits a 409
 * `claimed_by_other` (a ticket a DIFFERENT actor actively holds). Replaces the
 * generic Connection-Error overlay with a clean message + a Force-release action.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ticketIdFromPath } from './api.js';

const releaseTicket = vi.fn<(id: number, worker?: string) => Promise<{ ok: true }>>(() => Promise.resolve({ ok: true as const }));
vi.mock('../api/tickets.js', () => ({ releaseTicket: (id: number, worker?: string) => releaseTicket(id, worker) }));

const { showClaimConflictToast } = await import('./claimConflictToast.js');

describe('ticketIdFromPath (HS-9287)', () => {
  it('extracts the id from single-ticket routes (enables the Force-release action)', () => {
    expect(ticketIdFromPath('/tickets/42')).toBe(42);
    expect(ticketIdFromPath('/tickets/42/notes-bulk')).toBe(42);
    expect(ticketIdFromPath('/tickets/7/notes/abc-id')).toBe(7);
    expect(ticketIdFromPath('/tickets/123/blocked-by')).toBe(123);
  });

  it('returns null for batch / non-single-ticket paths (no Force-release action)', () => {
    expect(ticketIdFromPath('/tickets/batch')).toBeNull();
    expect(ticketIdFromPath('/tickets')).toBeNull();
    expect(ticketIdFromPath('/tickets/claims')).toBeNull();
    expect(ticketIdFromPath('/settings')).toBeNull();
  });
});

const toast = (): HTMLElement | null => document.querySelector('.hs-toast');

describe('showClaimConflictToast (HS-9287)', () => {
  afterEach(() => { document.querySelectorAll('.hs-toast').forEach(t => t.remove()); vi.clearAllMocks(); });

  it('single conflict → "Held by <label>" with a Force-release action', () => {
    showClaimConflictToast({ claimedBy: 'worker-1', workerLabel: 'worker-1' }, 42);
    const t = toast();
    expect(t?.textContent).toContain('Held by worker-1');
    expect(t?.textContent).toContain('force-release to take it');
    expect(t?.querySelector('.hs-toast-action')?.textContent).toBe('Force-release');
  });

  it('prefers workerLabel, falls back to claimedBy then "another worker"', () => {
    showClaimConflictToast({ claimedBy: 'owner' }, null);
    expect(toast()?.textContent).toContain('Held by owner');
    toast()?.remove();
    showClaimConflictToast({}, null);
    expect(toast()?.textContent).toContain('another worker');
  });

  it('omits the Force-release action when there is no ticket id (e.g. batch path)', () => {
    showClaimConflictToast({ workerLabel: 'w' }, null);
    expect(toast()?.querySelector('.hs-toast-action')).toBeNull();
  });

  it('batch conflict → lists the count + distinct holders, no action', () => {
    showClaimConflictToast({ conflicts: [
      { id: 1, claimed_by: 'worker-1', worker_label: 'worker-1' },
      { id: 2, claimed_by: 'worker-2', worker_label: null }, // falls back to claimed_by
    ] }, null);
    const t = toast();
    expect(t?.textContent).toContain('2 tickets held by worker-1, worker-2');
    expect(t?.querySelector('.hs-toast-action')).toBeNull();
  });

  it('Force-release action force-releases the ticket (no worker arg) + confirms', async () => {
    showClaimConflictToast({ workerLabel: 'worker-1' }, 7);
    (toast()?.querySelector('.hs-toast-action') as HTMLElement).click();
    expect(releaseTicket).toHaveBeenCalledWith(7, undefined);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.hs-toast')?.textContent).toContain('Released');
  });
});
