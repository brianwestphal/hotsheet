/**
 * HS-7954 — pure-helper tests for `bucketPorcelain`. The full `getGitStatus`
 * spawn-shell-out path is covered at the integration level (the live spawn
 * uses real `git`); these tests pin the porcelain-format parsing math.
 */
import { describe, expect, it } from 'vitest';

import { bucketPorcelain, bucketPorcelainFiles, getGitStatus, getGitStatusFiles, getPendingCommits, getRecentCommits, parsePendingCommits, parseStatusV2 } from './status.js';

const US = '\x1f';
const RS = '\x1e';
/** Build one `git log --pretty` record in the `%H\x1f%h\x1f%s\x1f%b\x1e` shape. */
function rec(hash: string, short: string, subject: string, body: string): string {
  return `${hash}${US}${short}${US}${subject}${US}${body}${RS}`;
}

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

/**
 * HS-7956 — `bucketPorcelainFiles` parses `git status --porcelain=v1 -z`
 * output into per-bucket file path lists with a 200-cap per bucket and
 * truncation flags. The `-z` format is NUL-separated (no LF / no quoting)
 * so paths with spaces / embedded newlines round-trip.
 */
describe('bucketPorcelainFiles (HS-7956)', () => {
  it('returns empty arrays for empty input', () => {
    const out = bucketPorcelainFiles('');
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([]);
    expect(out.untracked).toEqual([]);
    expect(out.conflicted).toEqual([]);
    expect(out.truncated).toEqual({ staged: false, unstaged: false, untracked: false, conflicted: false });
  });

  it('parses NUL-separated records into the right buckets', () => {
    const records = ['A  src/added.ts', ' M src/modified.ts', '?? new.txt', 'UU conflict.ts', 'MM partial.ts'];
    const out = bucketPorcelainFiles(records.join('\0') + '\0');
    expect(out.staged).toEqual(['src/added.ts', 'partial.ts']);
    expect(out.unstaged).toEqual(['src/modified.ts', 'partial.ts']);
    expect(out.untracked).toEqual(['new.txt']);
    expect(out.conflicted).toEqual(['conflict.ts']);
  });

  it('handles paths with spaces (the whole point of the -z format)', () => {
    const out = bucketPorcelainFiles(['?? new file with spaces.ts'].join('\0') + '\0');
    expect(out.untracked).toEqual(['new file with spaces.ts']);
  });

  it('flags truncation per bucket when the cap is exceeded', () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(`?? new${i}.ts`);
    const out = bucketPorcelainFiles(lines.join('\0') + '\0');
    expect(out.untracked.length).toBe(200);
    expect(out.truncated.untracked).toBe(true);
    // Other buckets aren't truncated.
    expect(out.truncated.staged).toBe(false);
  });

  it('skips short / blank records (defensive)', () => {
    const out = bucketPorcelainFiles('\0\0??' + '\0' + '\0');
    expect(out.untracked).toEqual([]);
  });
});

describe('parsePendingCommits (HS-8472)', () => {
  it('parses multiple commits, preserving multi-line bodies', () => {
    const out = parsePendingCommits(
      rec('a'.repeat(40), 'aaaaaaa', 'Subject one', 'body line 1\nbody line 2')
      + '\n' + rec('b'.repeat(40), 'bbbbbbb', 'Subject two', ''),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Subject one', body: 'body line 1\nbody line 2' });
    expect(out[1].subject).toBe('Subject two');
    expect(out[1].body).toBe('');
  });

  it('returns [] for empty output and ignores blank trailing records', () => {
    expect(parsePendingCommits('')).toEqual([]);
    expect(parsePendingCommits(rec('c'.repeat(40), 'ccccccc', 'S', '') + '\n')).toHaveLength(1);
  });
});

describe('getPendingCommits (HS-8472)', () => {
  // Use the repo root (a real git repo so `isGitRepo` passes) + an injected
  // invoker returning canned output, so the slicing/truncation logic is tested
  // without depending on the real commit graph.
  it('caps at 50 commits and flags truncation', async () => {
    let stdout = '';
    for (let i = 0; i < 51; i++) stdout += rec(String(i).padStart(40, '0'), `h${String(i)}`, `subj ${String(i)}`, '');
    const res = await getPendingCommits(process.cwd(), () => Promise.resolve({ stdout, status: 0 }));
    expect(res).not.toBeNull();
    expect(res!.commits).toHaveLength(50);
    expect(res!.truncated).toBe(true);
  });

  it('returns empty (not null) when git fails — e.g. no upstream', async () => {
    const res = await getPendingCommits(process.cwd(), () => Promise.resolve({ stdout: '', status: 128 }));
    expect(res).toEqual({ commits: [], truncated: false });
  });
});

describe('getRecentCommits (HS-8860)', () => {
  it('returns `limit` commits + hasMore=true when an extra row comes back', async () => {
    let stdout = '';
    for (let i = 0; i < 6; i++) stdout += rec(String(i).padStart(40, '0'), `h${String(i)}`, `subj ${String(i)}`, '');
    const res = await getRecentCommits(process.cwd(), 5, 0, () => Promise.resolve({ stdout, status: 0 }));
    expect(res!.commits).toHaveLength(5);
    expect(res!.hasMore).toBe(true);
  });

  it('hasMore=false when fewer than limit+1 rows come back', async () => {
    const stdout = rec('a'.repeat(40), 'aaaaaaa', 'only one', '');
    const res = await getRecentCommits(process.cwd(), 5, 0, () => Promise.resolve({ stdout, status: 0 }));
    expect(res!.commits).toHaveLength(1);
    expect(res!.hasMore).toBe(false);
  });

  it('passes --skip + --max-count=(limit+1) and clamps limit to 1..50', async () => {
    const calls: string[][] = [];
    const invoker = (args: string[]): Promise<{ stdout: string; status: number }> => { calls.push(args); return Promise.resolve({ stdout: '', status: 0 }); };
    await getRecentCommits(process.cwd(), 5, 10, invoker);
    expect(calls[0]).toContain('--skip=10');
    expect(calls[0]).toContain('--max-count=6'); // limit(5) + 1
    // limit clamped: 0 → 1 (max-count 2), 999 → 50 (max-count 51); skip floored at 0.
    await getRecentCommits(process.cwd(), 0, -3, invoker);
    expect(calls[1]).toContain('--skip=0');
    expect(calls[1]).toContain('--max-count=2');
    await getRecentCommits(process.cwd(), 999, 0, invoker);
    expect(calls[2]).toContain('--max-count=51');
  });

  it('returns empty (not null) when git fails — e.g. an empty repo with no commits', async () => {
    const res = await getRecentCommits(process.cwd(), 5, 0, () => Promise.resolve({ stdout: '', status: 128 }));
    expect(res).toEqual({ commits: [], hasMore: false });
  });
});

describe('untracked-files=all (HS-8895)', () => {
  // Regression guard: without `--untracked-files=all`, `git status --porcelain`
  // collapses a newly-added directory into one `?? dir/` entry, so the chip's
  // count under-reports and the popover lists the directory instead of its
  // files. Both status invocations must request `all`. Uses the repo root (a
  // real git repo so `isGitRepo` passes) + a recording invoker.
  function recordingInvoker(calls: string[][]): (args: string[], cwd: string) => Promise<{ stdout: string; status: number }> {
    return (args: string[]): Promise<{ stdout: string; status: number }> => {
      calls.push(args);
      // A branch for `symbolic-ref`; canned-empty success for everything else.
      if (args[0] === 'symbolic-ref') return Promise.resolve({ stdout: 'main\n', status: 0 });
      return Promise.resolve({ stdout: '', status: 0 });
    };
  }

  it('getGitStatus passes --untracked-files=all on its single v2 invocation (HS-9238)', async () => {
    const calls: string[][] = [];
    await getGitStatus(process.cwd(), recordingInvoker(calls));
    // HS-9238 — the 5-call chain collapsed to ONE `status --porcelain=v2 --branch`.
    const statusCalls = calls.filter(a => a.includes('status'));
    expect(statusCalls).toHaveLength(1);
    const statusCall = statusCalls[0];
    expect(statusCall).toContain('--porcelain=v2');
    expect(statusCall).toContain('--branch');
    expect(statusCall).toContain('--untracked-files=all');
    // No more symbolic-ref / rev-parse / rev-list sub-spawns.
    expect(calls.some(a => a[0] === 'symbolic-ref' || a[0] === 'rev-list' || a[0] === 'rev-parse')).toBe(false);
  });

  it('getGitStatusFiles passes --untracked-files=all so new directories expand', async () => {
    const calls: string[][] = [];
    await getGitStatusFiles(process.cwd(), recordingInvoker(calls));
    const statusCall = calls.find(a => a.includes('status') && a.includes('--porcelain=v1'));
    expect(statusCall).toBeDefined();
    expect(statusCall).toContain('--untracked-files=all');
  });
});

describe('parseStatusV2 (HS-9238)', () => {
  it('parses a clean tree on a branch with an in-sync upstream', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n') + '\n';
    expect(parseStatusV2(out)).toEqual({
      branch: 'main', detached: false, upstream: 'origin/main',
      ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
    });
  });

  it('counts staged / unstaged / partially-staged via the v2 XY field (`.` = unchanged)', () => {
    const out = [
      '# branch.head main',
      '1 A. N... 000000 100644 100644 aaa bbb staged.txt',   // X=A staged only
      '1 .M N... 100644 100644 100644 ccc ccc unstaged.txt', // Y=M unstaged only
      '1 MM N... 100644 100644 100644 ddd eee both.txt',     // X=M,Y=M both
    ].join('\n') + '\n';
    const r = parseStatusV2(out);
    expect(r.staged).toBe(2);   // staged.txt + both.txt
    expect(r.unstaged).toBe(2); // unstaged.txt + both.txt
  });

  it('counts untracked (`?`) and skips ignored (`!`)', () => {
    const out = ['# branch.head main', '? new.txt', '? other.txt', '! ignored.txt'].join('\n') + '\n';
    const r = parseStatusV2(out);
    expect(r.untracked).toBe(2);
  });

  it('counts unmerged (`u`) lines as conflicted', () => {
    const out = [
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 a b c d conflict.txt',
    ].join('\n') + '\n';
    expect(parseStatusV2(out).conflicted).toBe(1);
  });

  it('reads ahead / behind from branch.ab', () => {
    const out = ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'].join('\n') + '\n';
    const r = parseStatusV2(out);
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(3);
  });

  it('leaves upstream null + ahead/behind 0 when no upstream is configured', () => {
    const out = ['# branch.oid 2222222222222222222222222222222222222222', '# branch.head feature'].join('\n') + '\n';
    const r = parseStatusV2(out);
    expect(r.upstream).toBeNull();
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.branch).toBe('feature');
    expect(r.detached).toBe(false);
  });

  it('reports detached HEAD as the short oid', () => {
    const out = ['# branch.oid deadbeefcafe0000000000000000000000000000', '# branch.head (detached)'].join('\n') + '\n';
    const r = parseStatusV2(out);
    expect(r.detached).toBe(true);
    expect(r.branch).toBe('deadbee'); // first 7 chars of the oid
  });

  it('falls back to (detached) when the oid is (initial)', () => {
    const out = ['# branch.oid (initial)', '# branch.head (detached)'].join('\n') + '\n';
    expect(parseStatusV2(out).branch).toBe('(detached)');
  });

  it('handles a real-world mix in one pass', () => {
    const out = [
      '# branch.oid 3333333333333333333333333333333333333333',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +1 -0',
      '1 M. N... 100644 100644 100644 a b indexed.ts',
      '1 .D N... 100644 100644 000000 c c removed.ts',
      'u UU N... 100644 100644 100644 100644 a b c d merge.ts',
      '? scratch.tmp',
    ].join('\n') + '\n';
    expect(parseStatusV2(out)).toEqual({
      branch: 'main', detached: false, upstream: 'origin/main',
      ahead: 1, behind: 0, staged: 1, unstaged: 1, untracked: 1, conflicted: 1,
    });
  });

  it('returns safe defaults for empty output', () => {
    expect(parseStatusV2('')).toEqual({
      branch: '', detached: false, upstream: null,
      ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
    });
  });
});
