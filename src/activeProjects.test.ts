/**
 * HS-8725 — unit coverage for active-project (foreground) tracking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetActiveProjectsForTests, isProjectActive, markProjectActive } from './activeProjects.js';

beforeEach(() => { _resetActiveProjectsForTests(); });
afterEach(() => { vi.useRealTimers(); _resetActiveProjectsForTests(); });

describe('isProjectActive', () => {
  it('returns true for every project when none has been marked (safe no-regression default)', () => {
    expect(isProjectActive('/a/.hotsheet')).toBe(true);
    expect(isProjectActive('/b/.hotsheet')).toBe(true);
  });

  it('returns true for a project marked active just now', () => {
    markProjectActive('/a/.hotsheet');
    expect(isProjectActive('/a/.hotsheet')).toBe(true);
  });

  it('returns false for an un-marked project once ANY project has been marked', () => {
    markProjectActive('/a/.hotsheet');
    expect(isProjectActive('/b/.hotsheet')).toBe(false);
  });

  it('lapses to false after the TTL elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));
    markProjectActive('/a/.hotsheet');
    expect(isProjectActive('/a/.hotsheet')).toBe(true);
    vi.advanceTimersByTime(89_000); // under the 90s TTL
    expect(isProjectActive('/a/.hotsheet')).toBe(true);
    vi.advanceTimersByTime(2_000); // now past 90s
    expect(isProjectActive('/a/.hotsheet')).toBe(false);
  });

  it('a fresh mark refreshes the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));
    markProjectActive('/a/.hotsheet');
    vi.advanceTimersByTime(60_000);
    markProjectActive('/a/.hotsheet'); // re-poll
    vi.advanceTimersByTime(60_000); // 120s since first mark, but 60s since refresh
    expect(isProjectActive('/a/.hotsheet')).toBe(true);
  });

  it('tracks multiple active projects independently (multi-client union)', () => {
    markProjectActive('/a/.hotsheet');
    markProjectActive('/b/.hotsheet');
    expect(isProjectActive('/a/.hotsheet')).toBe(true);
    expect(isProjectActive('/b/.hotsheet')).toBe(true);
    expect(isProjectActive('/c/.hotsheet')).toBe(false);
  });
});
