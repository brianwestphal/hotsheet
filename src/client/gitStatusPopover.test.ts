// @vitest-environment happy-dom
/**
 * HS-7956 — pure-helper tests for the Phase 3 expanded popover. The
 * DOM-mounting / fetch-flow paths are exercised at e2e; these tests pin
 * the branch-line + ahead/behind-line formatting math.
 */
import { describe, expect, it } from 'vitest';

import { buildAheadBehindLine, buildBranchLine, paintPopover } from './gitStatusPopover.js';

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

// HS-7975 follow-up — the bare horizontal separator the user reported was the
// `border-top` on `.git-popover-buckets` showing through whenever the working
// tree was clean (no staged / unstaged / untracked / conflicted files). The
// fix skips appending the buckets element when none of the bucket rows would
// render, so the separator only appears when there's actually file content to
// separate.
describe('paintPopover bucket-strip suppression (HS-7975 follow-up)', () => {
  function mountPopover(): HTMLElement {
    const popover = document.createElement('div');
    popover.className = 'git-popover';
    popover.innerHTML = `
      <div class="git-popover-header">
        <div class="git-popover-title"></div>
      </div>
      <div class="git-popover-body"></div>
    `;
    document.body.appendChild(popover);
    return popover;
  }

  it('omits the .git-popover-buckets strip when all four counts are zero', () => {
    const popover = mountPopover();
    paintPopover(popover, status({ upstream: 'origin/main', ahead: 1 }));
    expect(popover.querySelector('.git-popover-buckets')).toBeNull();
    document.body.innerHTML = '';
  });

  it('renders the .git-popover-buckets strip when at least one count is non-zero', () => {
    const popover = mountPopover();
    paintPopover(popover, status({ upstream: 'origin/main', staged: 2 }));
    expect(popover.querySelector('.git-popover-buckets')).not.toBeNull();
    document.body.innerHTML = '';
  });

  it('omits the strip for a clean up-to-date branch (every count zero, no ahead/behind)', () => {
    const popover = mountPopover();
    paintPopover(popover, status({ upstream: 'origin/main' }));
    expect(popover.querySelector('.git-popover-buckets')).toBeNull();
    document.body.innerHTML = '';
  });
});
