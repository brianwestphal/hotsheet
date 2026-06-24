// @vitest-environment happy-dom
// HS-8864 — claimed-by chip logic + render (docs/90 §90.8).
import { describe, expect, it } from 'vitest';

import type { ClaimRow } from '../api/index.js';
import {
  chipWorkerName, formatLeaseCountdown, leaseRemainingMs, leaseState,
  renderClaimedByChip, STALE_LEASE_MS,
} from './claimedByChip.js';

const NOW = 1_000_000_000_000;
const iso = (msFromNow: number): string => new Date(NOW + msFromNow).toISOString();

const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  ticketId: 1, ticketNumber: 'HS-1', title: 'do it',
  claimedBy: 'worker-abc', workerLabel: 'worker-1', leaseExpiresAt: iso(90_000), ...over,
});

describe('lease helpers (HS-8864)', () => {
  it('leaseRemainingMs is positive before expiry, negative after', () => {
    expect(leaseRemainingMs(iso(90_000), NOW)).toBe(90_000);
    expect(leaseRemainingMs(iso(-5_000), NOW)).toBe(-5_000);
  });

  it('formatLeaseCountdown renders m:ss, and "expired" once past', () => {
    expect(formatLeaseCountdown(iso(90_000), NOW)).toBe('1:30');
    expect(formatLeaseCountdown(iso(5_000), NOW)).toBe('0:05');
    expect(formatLeaseCountdown(iso(0), NOW)).toBe('expired');
    expect(formatLeaseCountdown(iso(-1), NOW)).toBe('expired');
  });

  it('leaseState is stale within STALE_LEASE_MS of expiry or past it', () => {
    expect(leaseState(iso(STALE_LEASE_MS + 1_000), NOW)).toBe('live');
    expect(leaseState(iso(STALE_LEASE_MS), NOW)).toBe('stale');
    expect(leaseState(iso(-10_000), NOW)).toBe('stale');
  });

  it('chipWorkerName prefers the label, falls back to the claimed_by id', () => {
    expect(chipWorkerName(claim({ workerLabel: 'worker-1' }))).toBe('worker-1');
    expect(chipWorkerName(claim({ workerLabel: null }))).toBe('worker-abc');
    expect(chipWorkerName(claim({ workerLabel: '' }))).toBe('worker-abc');
  });
});

describe('renderClaimedByChip (HS-8864)', () => {
  it('renders a live chip with the worker name + countdown', () => {
    const el = renderClaimedByChip(claim({ leaseExpiresAt: iso(90_000) }), NOW);
    expect(el.classList.contains('claimed-by-chip-live')).toBe(true);
    expect(el.querySelector('.claimed-by-chip-worker')?.textContent).toBe('worker-1');
    expect(el.querySelector('.claimed-by-chip-lease')?.textContent).toBe('1:30');
    expect(el.getAttribute('title')).toContain('worker-abc'); // the raw identity in the tooltip
  });

  it('renders a stale chip near/past expiry', () => {
    const el = renderClaimedByChip(claim({ leaseExpiresAt: iso(-2_000) }), NOW);
    expect(el.classList.contains('claimed-by-chip-stale')).toBe(true);
    expect(el.querySelector('.claimed-by-chip-lease')?.textContent).toBe('expired');
    expect(el.getAttribute('title')).toMatch(/stale/i);
  });
});
