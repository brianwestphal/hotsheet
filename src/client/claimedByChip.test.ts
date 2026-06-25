// @vitest-environment happy-dom
// HS-8864 — claimed-by chip logic + render (docs/90 §90.8).
import { describe, expect, it } from 'vitest';

import type { ClaimRow } from '../api/index.js';
import {
  chipWorkerName, formatLeaseCountdown, LEASE_COUNTDOWN_VISIBLE_MS, leaseRemainingMs, leaseState,
  renderClaimedByChip, shouldShowLeaseCountdown, STALE_LEASE_MS,
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

  it('leaseState tiers by time remaining: live > warn > stale (HS-9041)', () => {
    expect(leaseState(iso(LEASE_COUNTDOWN_VISIBLE_MS + 1_000), NOW)).toBe('live');
    expect(leaseState(iso(LEASE_COUNTDOWN_VISIBLE_MS), NOW)).toBe('warn');
    expect(leaseState(iso(STALE_LEASE_MS + 1_000), NOW)).toBe('warn');
    expect(leaseState(iso(STALE_LEASE_MS), NOW)).toBe('stale');
    expect(leaseState(iso(-10_000), NOW)).toBe('stale');
  });

  it('shouldShowLeaseCountdown only for warn/stale (HS-9041)', () => {
    expect(shouldShowLeaseCountdown('live')).toBe(false);
    expect(shouldShowLeaseCountdown('warn')).toBe(true);
    expect(shouldShowLeaseCountdown('stale')).toBe(true);
  });

  it('chipWorkerName prefers the label, falls back to the claimed_by id', () => {
    expect(chipWorkerName(claim({ workerLabel: 'worker-1' }))).toBe('worker-1');
    expect(chipWorkerName(claim({ workerLabel: null }))).toBe('worker-abc');
    expect(chipWorkerName(claim({ workerLabel: '' }))).toBe('worker-abc');
  });
});

describe('renderClaimedByChip (HS-8864 / HS-9041)', () => {
  it('a live chip (plenty of lease) hides the countdown but keeps it in the tooltip', () => {
    const el = renderClaimedByChip(claim({ leaseExpiresAt: iso(90_000) }), NOW);
    expect(el.classList.contains('claimed-by-chip-live')).toBe(true);
    expect(el.querySelector('.claimed-by-chip-worker')?.textContent).toBe('worker-1');
    // HS-9041 — the visible countdown is hidden while the lease is healthy…
    expect(el.querySelector('.claimed-by-chip-lease')).toBeNull();
    // …but the lease time is still available on hover, alongside the raw identity.
    expect(el.getAttribute('title')).toContain('worker-abc');
    expect(el.getAttribute('title')).toContain('1:30');
  });

  it('a warn chip (lease running low) reveals the countdown in the warning tier', () => {
    const el = renderClaimedByChip(claim({ leaseExpiresAt: iso(45_000) }), NOW);
    expect(el.classList.contains('claimed-by-chip-warn')).toBe(true);
    expect(el.querySelector('.claimed-by-chip-lease')?.textContent).toBe('0:45');
  });

  it('renders a stale chip near/past expiry', () => {
    const el = renderClaimedByChip(claim({ leaseExpiresAt: iso(-2_000) }), NOW);
    expect(el.classList.contains('claimed-by-chip-stale')).toBe(true);
    expect(el.querySelector('.claimed-by-chip-lease')?.textContent).toBe('expired');
    expect(el.getAttribute('title')).toMatch(/stale/i);
  });
});
