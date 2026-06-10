// HS-8784 — the Glassbox "nothing to review" guard. `bindGlassbox` (app.tsx)
// uses `hasGlassboxReviewableChanges` so clicking the button with a clean tree +
// no unpushed commits surfaces a clear message instead of opening an empty
// review that looked like the button did nothing.
import { describe, expect, it } from 'vitest';

import type { GitStatus } from '../api/git.js';
import { hasGlassboxReviewableChanges } from './glassboxReview.js';

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main', detached: false, upstream: 'origin/main',
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
    lastFetchedAt: null, ...over,
  };
}

describe('hasGlassboxReviewableChanges (HS-8784)', () => {
  it('is false for a clean tree with no unpushed commits', () => {
    expect(hasGlassboxReviewableChanges(status())).toBe(false);
  });

  it('is true when there are uncommitted changes', () => {
    expect(hasGlassboxReviewableChanges(status({ unstaged: 1 }))).toBe(true);
    expect(hasGlassboxReviewableChanges(status({ staged: 2 }))).toBe(true);
    expect(hasGlassboxReviewableChanges(status({ untracked: 1 }))).toBe(true);
    expect(hasGlassboxReviewableChanges(status({ conflicted: 1 }))).toBe(true);
  });

  it('is true when there are unpushed commits (ahead), even with a clean tree', () => {
    expect(hasGlassboxReviewableChanges(status({ ahead: 3 }))).toBe(true);
  });

  it('ignores behind-only (incoming, not reviewable locally)', () => {
    expect(hasGlassboxReviewableChanges(status({ behind: 5 }))).toBe(false);
  });

  it('returns true for a null status (not a git repo / probe failed) — never wrongly block', () => {
    expect(hasGlassboxReviewableChanges(null)).toBe(true);
  });
});
