/**
 * HS-7956 — pure-helper tests for the Phase 3 expanded popover. The
 * DOM-mounting / fetch-flow paths are exercised at e2e; these tests pin
 * the branch-line + ahead/behind-line formatting math.
 */
import { describe, expect, it } from 'vitest';

import { buildAheadBehindLine, buildBranchLine } from './gitStatusPopover.js';

function status(o: Partial<{
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
    ...o,
  };
}

describe('buildBranchLine (HS-7956)', () => {
  it('renders the upstream arrow form when upstream is set', () => {
    expect(buildBranchLine(status({ branch: 'main', upstream: 'origin/main' })))
      .toBe('main → origin/main');
  });

  it('renders the no-upstream form when upstream is null and not detached', () => {
    expect(buildBranchLine(status({ branch: 'feat/x', upstream: null })))
      .toBe('feat/x (no upstream)');
  });

  it('renders the detached form (parens around the SHA-stand-in branch label)', () => {
    expect(buildBranchLine(status({ branch: 'a1b2c3d', detached: true })))
      .toBe('(detached: a1b2c3d)');
  });
});

describe('buildAheadBehindLine (HS-7956)', () => {
  it('returns null when no upstream is set', () => {
    expect(buildAheadBehindLine(status({}))).toBeNull();
  });

  it('returns "up to date" when upstream is set but ahead+behind are zero', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main' }))).toBe('up to date');
  });

  it('returns "N ahead" when only ahead', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main', ahead: 3 }))).toBe('3 ahead');
  });

  it('returns "M behind" when only behind', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main', behind: 1 }))).toBe('1 behind');
  });

  it('joins both with a bullet when both are non-zero', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main', ahead: 3, behind: 1 })))
      .toBe('3 ahead • 1 behind');
  });
});
