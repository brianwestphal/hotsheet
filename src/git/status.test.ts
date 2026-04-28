/**
 * HS-7954 — pure-helper tests for `bucketPorcelain`. The full `getGitStatus`
 * spawn-shell-out path is covered at the integration level (the live spawn
 * uses real `git`); these tests pin the porcelain-format parsing math.
 */
import { describe, expect, it } from 'vitest';

import { bucketPorcelain } from './status.js';

describe('bucketPorcelain (HS-7954)', () => {
  it('returns all-zero for empty input', () => {
    expect(bucketPorcelain('')).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  });

  it('counts a single staged file (added in index)', () => {
    expect(bucketPorcelain('A  src/foo.ts\n')).toEqual({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0 });
  });

  it('counts a single unstaged file (worktree-modified)', () => {
    expect(bucketPorcelain(' M src/foo.ts\n')).toEqual({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
  });

  it('counts a single untracked file', () => {
    expect(bucketPorcelain('?? new-file.txt\n')).toEqual({ staged: 0, unstaged: 0, untracked: 1, conflicted: 0 });
  });

  it('counts a partially-staged file as BOTH staged and unstaged (split-stage scenario)', () => {
    // "MM" means "modified in index AND modified in worktree" — git status
    // shows this when the user staged some but not all of their hunks.
    expect(bucketPorcelain('MM src/foo.ts\n')).toEqual({ staged: 1, unstaged: 1, untracked: 0, conflicted: 0 });
  });

  it('counts every conflicted code (UU AA DD AU UA DU UD)', () => {
    const lines = ['UU a', 'AA b', 'DD c', 'AU d', 'UA e', 'DU f', 'UD g'].join('\n') + '\n';
    expect(bucketPorcelain(lines)).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 7 });
  });

  it('handles a real-world mix', () => {
    const lines = [
      'M  src/staged.ts',
      ' M src/unstaged.ts',
      'MM src/partial.ts',
      'A  src/added.ts',
      '?? src/untracked.ts',
      'UU src/conflict.ts',
    ].join('\n') + '\n';
    expect(bucketPorcelain(lines)).toEqual({ staged: 3, unstaged: 2, untracked: 1, conflicted: 1 });
  });

  it('skips short / blank lines (defensive)', () => {
    expect(bucketPorcelain('\n\n\n')).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(bucketPorcelain('?')).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  });

  it('treats deleted files in worktree as unstaged', () => {
    expect(bucketPorcelain(' D src/gone.ts\n')).toEqual({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
  });

  it('ignores leading whitespace in the path portion of a line', () => {
    // The X+Y are columns 0-1; column 2 is a space; the path starts at 3.
    // The path can contain trailing whitespace which should be irrelevant
    // to the count.
    expect(bucketPorcelain('?? path with trailing space   \n')).toEqual({ staged: 0, unstaged: 0, untracked: 1, conflicted: 0 });
  });
});
