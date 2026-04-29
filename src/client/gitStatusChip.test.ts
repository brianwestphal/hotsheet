/**
 * HS-7954 — pure-helper tests for the sidebar git status chip.
 * `tintForStatus`, `countsLabel`, `tooltipForStatus` are all pure given a
 * GitStatus. The DOM-mounting `initGitStatusChip` is straightforward
 * `document.getElementById` + textContent / classList manipulation;
 * regressions there would surface at e2e — these helpers are what a logic
 * regression would catch.
 */
import { describe, expect, it } from 'vitest';

import { aheadBehindLabel, countsLabel, formatRelativeTime, pickDisplayStatusOnProjectSwitch, tintForStatus, tooltipForStatus } from './gitStatusChip.js';

function s(overrides: Partial<{
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  lastFetchedAt: number | null;
}>): {
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  lastFetchedAt: number | null;
} {
  return {
    branch: 'main',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    lastFetchedAt: null,
    ...overrides,
  };
}

describe('tintForStatus (HS-7954)', () => {
  it('returns clean when everything is zero', () => {
    expect(tintForStatus(s({}))).toBe('clean');
  });

  it('returns dirty when any local-state counter is non-zero', () => {
    expect(tintForStatus(s({ staged: 1 }))).toBe('dirty');
    expect(tintForStatus(s({ unstaged: 2 }))).toBe('dirty');
    expect(tintForStatus(s({ untracked: 3 }))).toBe('dirty');
  });

  it('conflicted wins over dirty', () => {
    expect(tintForStatus(s({ conflicted: 1, staged: 5, unstaged: 5 }))).toBe('conflicted');
  });

  it('Phase 2 future-tints — behind wins over ahead, ahead wins over dirty', () => {
    expect(tintForStatus(s({ behind: 1, staged: 1 }))).toBe('behind');
    expect(tintForStatus(s({ ahead: 1, staged: 1 }))).toBe('ahead');
    // Conflicted still wins over remote tints.
    expect(tintForStatus(s({ conflicted: 1, behind: 1, ahead: 1 }))).toBe('conflicted');
  });
});

describe('countsLabel (HS-7954)', () => {
  it('returns empty string when everything is zero', () => {
    expect(countsLabel(s({}))).toBe('');
  });

  it('sums staged + unstaged + untracked + conflicted', () => {
    expect(countsLabel(s({ staged: 2, unstaged: 1 }))).toBe('3');
    expect(countsLabel(s({ staged: 1, unstaged: 1, untracked: 1, conflicted: 1 }))).toBe('4');
  });

  it('does NOT include ahead / behind in the local-count badge', () => {
    expect(countsLabel(s({ ahead: 5, behind: 2 }))).toBe('');
    expect(countsLabel(s({ staged: 1, ahead: 5 }))).toBe('1');
  });
});

describe('tooltipForStatus (HS-7954)', () => {
  it('lists "clean" when nothing is dirty', () => {
    expect(tooltipForStatus(s({ branch: 'feat/x' }))).toBe('feat/x: clean');
  });

  it('lists each non-zero bucket', () => {
    expect(tooltipForStatus(s({ branch: 'main', staged: 3, unstaged: 1, untracked: 1 })))
      .toBe('main: 3 staged, 1 unstaged, 1 untracked');
  });

  it('includes conflicted when present', () => {
    expect(tooltipForStatus(s({ branch: 'main', conflicted: 2 })))
      .toBe('main: 2 conflicted');
  });

  it('omits zero-count buckets', () => {
    expect(tooltipForStatus(s({ branch: 'main', staged: 1, untracked: 0 })))
      .toBe('main: 1 staged');
  });

  it('reflects detached HEAD branch label', () => {
    expect(tooltipForStatus(s({ branch: 'a1b2c3d', detached: true })))
      .toBe('a1b2c3d: clean');
  });
});

describe('aheadBehindLabel (HS-7955)', () => {
  it('returns empty when both are zero', () => {
    expect(aheadBehindLabel(s({}))).toBe('');
  });

  it('returns the up-arrow + count when only ahead', () => {
    expect(aheadBehindLabel(s({ ahead: 3 }))).toBe('↑3');
  });

  it('returns the down-arrow + count when only behind', () => {
    expect(aheadBehindLabel(s({ behind: 1 }))).toBe('↓1');
  });

  it('joins both with a space when both are non-zero', () => {
    expect(aheadBehindLabel(s({ ahead: 3, behind: 1 }))).toBe('↑3 ↓1');
  });
});

describe('formatRelativeTime (HS-7955)', () => {
  it('returns "just now" for sub-minute durations', () => {
    expect(formatRelativeTime(0)).toBe('just now');
    expect(formatRelativeTime(59_999)).toBe('just now');
  });

  it('returns minutes for sub-hour durations', () => {
    expect(formatRelativeTime(60_000)).toBe('1 minute ago');
    expect(formatRelativeTime(2 * 60_000)).toBe('2 minutes ago');
    expect(formatRelativeTime(59 * 60_000)).toBe('59 minutes ago');
  });

  it('returns hours for sub-day durations', () => {
    expect(formatRelativeTime(60 * 60_000)).toBe('1 hour ago');
    expect(formatRelativeTime(5 * 60 * 60_000)).toBe('5 hours ago');
  });

  it('returns days for >= 24h durations', () => {
    expect(formatRelativeTime(24 * 60 * 60_000)).toBe('1 day ago');
    expect(formatRelativeTime(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });
});

describe('tooltipForStatus extended (HS-7955)', () => {
  it('appends the upstream + ahead/behind line on a second row when upstream is set', () => {
    const status = s({ branch: 'main', upstream: 'origin/main', ahead: 3, behind: 1, lastFetchedAt: Date.now() - 5 * 60_000 });
    const out = tooltipForStatus(status, Date.now());
    expect(out).toContain('main: clean');
    expect(out).toContain('3 ahead');
    expect(out).toContain('1 behind');
    expect(out).toContain('last fetched 5 minutes ago');
    expect(out).toContain('(origin/main)');
  });

  it('says "up to date" when the upstream is set but ahead+behind are zero', () => {
    const status = s({ upstream: 'origin/main' });
    const out = tooltipForStatus(status, 1_000_000);
    expect(out).toContain('up to date');
  });

  it('omits "last fetched" when lastFetchedAt is null', () => {
    const status = s({ upstream: 'origin/main', ahead: 1 });
    const out = tooltipForStatus(status, 1_000_000);
    expect(out).not.toContain('last fetched');
  });

  it('falls through to the Phase-1 single-line tooltip when upstream is null', () => {
    const status = s({ upstream: null, staged: 1 });
    const out = tooltipForStatus(status, 1_000_000);
    expect(out).toBe('main: 1 staged');
    expect(out).not.toContain('up to date');
  });
});

// ---------------------------------------------------------------------------
// HS-7993 — per-project cache lookup helper
// ---------------------------------------------------------------------------

describe('pickDisplayStatusOnProjectSwitch (HS-7993)', () => {
  it('returns null when the new project secret is null', () => {
    expect(pickDisplayStatusOnProjectSwitch(null, new Map())).toBeNull();
  });

  it('returns null when no cache entry exists for the new secret', () => {
    const cache = new Map<string, ReturnType<typeof s> | null>([
      ['secretA', s({ branch: 'a', staged: 1 })],
    ]);
    expect(pickDisplayStatusOnProjectSwitch('secretB', cache)).toBeNull();
  });

  it('returns the cached value when the new secret is in the cache', () => {
    const aStatus = s({ branch: 'main', staged: 2 });
    const cache = new Map<string, ReturnType<typeof s> | null>([
      ['secretA', aStatus],
      ['secretB', s({ branch: 'feat/x' })],
    ]);
    expect(pickDisplayStatusOnProjectSwitch('secretA', cache)).toBe(aStatus);
  });

  it('returns null when the cached value is null (project visited but not a git repo)', () => {
    const cache = new Map<string, ReturnType<typeof s> | null>([
      ['nonGitProject', null],
    ]);
    expect(pickDisplayStatusOnProjectSwitch('nonGitProject', cache)).toBeNull();
  });

  it('distinguishes "no entry" from "null entry"', () => {
    // Both calls return null, but the design semantics differ — `has`
    // returning false means "fetch fresh + show empty"; `has` returning
    // true with a null value means "we already know there is no git for
    // this project". The pure helper collapses both to null because the
    // chip's render layer hides for either.
    const cache = new Map<string, ReturnType<typeof s> | null>([
      ['definitelyNotGit', null],
    ]);
    expect(pickDisplayStatusOnProjectSwitch('definitelyNotGit', cache)).toBeNull();
    expect(pickDisplayStatusOnProjectSwitch('neverFetched', cache)).toBeNull();
  });
});
