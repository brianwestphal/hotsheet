// @vitest-environment happy-dom
// HS-8864 — in-flight work overlay rendering (docs/90 §90.8).
import { describe, expect, it, vi } from 'vitest';

import type { ClaimRow } from '../api/index.js';
import { renderInflightList, renderInflightRow } from './inflightPanel.js';

const NOW = 1_000_000_000_000;
const iso = (msFromNow: number): string => new Date(NOW + msFromNow).toISOString();
const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  ticketId: 7, ticketNumber: 'HS-7', title: 'ship it',
  claimedBy: 'w-abc', workerLabel: 'worker-2', leaseExpiresAt: iso(60_000), ...over,
});

describe('in-flight overlay rows (HS-8864)', () => {
  it('renders a row with number, title, and the claimed-by chip; click opens the ticket', () => {
    const onOpen = vi.fn();
    const row = renderInflightRow(claim(), NOW, onOpen);
    expect(row.querySelector('.inflight-row-number')?.textContent).toBe('HS-7');
    expect(row.querySelector('.inflight-row-title')?.textContent).toBe('ship it');
    expect(row.querySelector('.claimed-by-chip')).not.toBeNull();
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it('renders an empty state when nothing is claimed', () => {
    const body = document.createElement('div');
    renderInflightList(body, [], NOW, vi.fn());
    expect(body.querySelector('.inflight-empty')).not.toBeNull();
    expect(body.querySelectorAll('.inflight-row')).toHaveLength(0);
  });

  it('renders one row per claim', () => {
    const body = document.createElement('div');
    renderInflightList(body, [claim({ ticketId: 1, ticketNumber: 'HS-1' }), claim({ ticketId: 2, ticketNumber: 'HS-2' })], NOW, vi.fn());
    expect(body.querySelectorAll('.inflight-row')).toHaveLength(2);
  });
});
