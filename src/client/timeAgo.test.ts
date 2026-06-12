/**
 * `timeAgo` — the short "Nm/h/d ago" label used by command-log rows + the
 * API-key provenance labels. It uses the real clock (no injectable `now`), so
 * the relative-bucket assertions construct timestamps relative to `Date.now()`
 * with comfortable margins; the timezone-handling + fallback branches are
 * clock-independent.
 */
import { describe, expect, it } from 'vitest';

import { timeAgo } from './timeAgo.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe('timeAgo', () => {
  it('returns "just now" for the sub-minute window and for clock skew (future)', () => {
    expect(timeAgo(isoAgo(10_000))).toBe('just now');
    expect(timeAgo(new Date(Date.now() + 60_000).toISOString())).toBe('just now');
  });

  it('formats minutes / hours / days with the short units', () => {
    expect(timeAgo(isoAgo(5 * MIN))).toBe('5m ago');
    expect(timeAgo(isoAgo(3 * HOUR))).toBe('3h ago');
    expect(timeAgo(isoAgo(2 * DAY))).toBe('2d ago');
  });

  it('treats a timezone-less timestamp as UTC (appends Z)', () => {
    // Build a UTC instant ~5 min ago, strip the trailing Z → should still read
    // as 5m, not be shifted by the local offset.
    const withZ = new Date(Date.now() - 5 * MIN).toISOString(); // ...Z
    const noZone = withZ.replace('Z', '');
    expect(timeAgo(noZone)).toBe('5m ago');
  });

  it('respects an explicit +00:00 offset', () => {
    const offsetForm = new Date(Date.now() - 2 * HOUR).toISOString().replace('Z', '+00:00');
    expect(timeAgo(offsetForm)).toBe('2h ago');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(timeAgo('clearly not a date')).toBe('clearly not a date');
  });
});
