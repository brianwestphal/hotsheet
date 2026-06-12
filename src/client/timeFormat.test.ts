/**
 * HS-8677 — the consolidated client relative-time formatter. It replaced four
 * divergent implementations, so its unit boundaries, pluralization, fallbacks,
 * and the absolute-threshold escape hatch are worth pinning. `now` is injectable
 * so every assertion is deterministic.
 */
import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './timeFormat.js';

const NOW = new Date('2026-06-13T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('returns "just now" within the sub-minute window', () => {
    expect(formatRelativeTime(ago(0), { now: NOW })).toBe('just now');
    expect(formatRelativeTime(ago(59_999), { now: NOW })).toBe('just now');
  });

  it('formats minutes with correct pluralization', () => {
    expect(formatRelativeTime(ago(MIN), { now: NOW })).toBe('1 minute ago');
    expect(formatRelativeTime(ago(5 * MIN), { now: NOW })).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(59 * MIN), { now: NOW })).toBe('59 minutes ago');
  });

  it('formats hours with correct pluralization', () => {
    expect(formatRelativeTime(ago(HOUR), { now: NOW })).toBe('1 hour ago');
    expect(formatRelativeTime(ago(23 * HOUR), { now: NOW })).toBe('23 hours ago');
  });

  it('formats days with correct pluralization', () => {
    expect(formatRelativeTime(ago(DAY), { now: NOW })).toBe('1 day ago');
    expect(formatRelativeTime(ago(3 * DAY), { now: NOW })).toBe('3 days ago');
  });

  it('accepts number, Date, and ISO-string inputs equivalently', () => {
    const t = NOW.getTime() - 5 * MIN;
    expect(formatRelativeTime(t, { now: NOW })).toBe('5 minutes ago');
    expect(formatRelativeTime(new Date(t), { now: NOW })).toBe('5 minutes ago');
    expect(formatRelativeTime(new Date(t).toISOString(), { now: NOW })).toBe('5 minutes ago');
  });

  it('returns the fallback for null / undefined / empty / NaN inputs', () => {
    expect(formatRelativeTime(null, { now: NOW })).toBe('—');
    expect(formatRelativeTime(undefined, { now: NOW })).toBe('—');
    expect(formatRelativeTime('', { now: NOW })).toBe('—');
    expect(formatRelativeTime('not a date', { now: NOW })).toBe('—');
  });

  it('honors a custom fallback string', () => {
    expect(formatRelativeTime(null, { now: NOW, fallback: 'never' })).toBe('never');
  });

  it('returns an absolute date once past the absoluteThresholdMs', () => {
    const old = ago(8 * DAY);
    const out = formatRelativeTime(old, { now: NOW, absoluteThresholdMs: 7 * DAY });
    expect(out).toBe(new Date(old).toLocaleDateString());
    // Just under the threshold still uses the relative form.
    expect(formatRelativeTime(ago(6 * DAY), { now: NOW, absoluteThresholdMs: 7 * DAY }))
      .toBe('6 days ago');
  });
});
