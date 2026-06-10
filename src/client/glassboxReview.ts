/**
 * HS-8784 — small pure helper backing the Glassbox toolbar button's "nothing to
 * review" guard. Glassbox reviews PENDING changes (the working-copy diff +
 * unpushed commits); when there's nothing pending, launching it opens an empty
 * review that looks like "the button did nothing". `bindGlassbox` in
 * `src/client/app.tsx` consults this before launching so it can surface a clear
 * message instead.
 */
import type { GitStatus } from '../api/git.js';

/**
 * Does the working copy have anything for Glassbox to review? True when there
 * are uncommitted changes (staged / unstaged / untracked / conflicted) OR
 * unpushed commits (`ahead`). A `null` status (not a git repo, or the probe
 * failed) returns `true` so we never wrongly suppress the launch — better to
 * open Glassbox than to block it on a bad signal.
 */
export function hasGlassboxReviewableChanges(status: GitStatus | null): boolean {
  if (status === null) return true;
  const dirty = status.staged + status.unstaged + status.untracked + status.conflicted;
  return dirty > 0 || status.ahead > 0;
}
