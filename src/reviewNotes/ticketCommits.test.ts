// HS-9392 — ticket-commit discovery + linear grouping: pure core tests plus
// real-temp-git fixture tests (mirrors `workers/integrate.test.ts`).
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetTicketCommitsCacheForTesting,
  type CommitEntry,
  discoverTicketCommits,
  groupLinearCommits,
  matchTicketCommits,
  parseLogOutput,
  spanForGroups,
} from './ticketCommits.js';

const e = (sha: string, subject: string, date = '2026-07-23T00:00:00Z'): CommitEntry => ({ sha, subject, date });

describe('matchTicketCommits (subject-line, word-boundary)', () => {
  const entries = [
    e('a', 'HS-1234: fix the thing'),
    e('b', 'HS-12345: different ticket'),
    e('c', 'Follow-up cleanup for HS-1234 edge cases'),
    e('d', 'XHS-1234 unrelated prefix'),
    e('e', 'hs-1234: case-insensitive'),
    e('f', 'nothing here'),
  ];
  it('matches the ref with word boundaries, case-insensitively; never a longer number or attached prefix', () => {
    expect(matchTicketCommits(entries, 'HS-1234').map(m => m.sha)).toEqual(['a', 'c', 'e']);
  });
});

describe('groupLinearCommits + spanForGroups', () => {
  // History newest-first: t3, x2, t2, t1, x1, t0  (t* = ticket commits)
  const log = [e('t3', 'HS-1: three'), e('x2', 'other'), e('t2', 'HS-1: two'), e('t1', 'HS-1: one'), e('x1', 'other'), e('t0', 'HS-1: zero')];
  const matched = matchTicketCommits(log, 'HS-1');

  it('clusters consecutive positions into linear groups (newest first), from = oldest^', () => {
    const groups = groupLinearCommits(log, matched);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ from: 't3^', to: 't3', count: 1 });
    expect(groups[1]).toMatchObject({ from: 't1^', to: 't2', count: 2, subjects: ['HS-1: two', 'HS-1: one'] });
    expect(groups[2]).toMatchObject({ from: 't0^', to: 't0', count: 1 });
  });

  it('a contiguous run is ONE group and needs no span', () => {
    const contiguous = [e('c', 'HS-2: c'), e('b', 'HS-2: b'), e('a', 'HS-2: a'), e('x', 'other')];
    const m = matchTicketCommits(contiguous, 'HS-2');
    const groups = groupLinearCommits(contiguous, m);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ from: 'a^', to: 'c', count: 3 });
    expect(spanForGroups(contiguous, m)).toBeNull();
  });

  it('interleaved groups produce the earliest→latest span with the unrelated count', () => {
    const span = spanForGroups(log, matched);
    expect(span).toEqual({ from: 't0^', to: 't3', unrelatedCount: 2 }); // x2 + x1 inside the span
  });

  it('ref labels branch groups', () => {
    const groups = groupLinearCommits(log, matched, 'hotsheet/w1');
    expect(groups.every(g => g.ref === 'hotsheet/w1')).toBe(true);
  });
});

describe('parseLogOutput', () => {
  it('parses %H\\x1f%s\\x1f%cI lines and skips blanks/malformed', () => {
    const out = 'sha1\x1fSubject one\x1f2026-07-23T01:00:00Z\n\nsha2\x1fSubject: with \x1f-free text\x1f2026-07-23T02:00:00Z\nnot-a-line\n';
    const entries = parseLogOutput(out);
    expect(entries[0]).toEqual({ sha: 'sha1', subject: 'Subject one', date: '2026-07-23T01:00:00Z' });
    expect(entries).toHaveLength(2); // the bare 'not-a-line' (no separators) is dropped
  });
});

describe('discoverTicketCommits — real git', () => {
  let repo: string;
  const git = (args: string[]): string => execFileSync('git', args, { timeout: 60_000, killSignal: 'SIGKILL', cwd: repo, encoding: 'utf-8' });
  const commit = (file: string, msg: string): void => {
    writeFileSync(join(repo, file), `${msg}\n${String(Math.random())}`);
    git(['add', file]);
    git(['commit', '-q', '-m', msg]);
  };

  beforeEach(() => {
    _resetTicketCommitsCacheForTesting();
    repo = mkdtempSync(join(tmpdir(), 'hs-tcommits-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 'Test']);
    commit('README.md', 'init');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('contiguous ticket commits → one group; body-only mention excluded', async () => {
    commit('a.txt', 'HS-7: part one');
    commit('b.txt', 'HS-7: part two');
    writeFileSync(join(repo, 'c.txt'), 'x');
    git(['add', 'c.txt']);
    git(['commit', '-q', '-m', 'unrelated subject', '-m', 'Body mentions HS-7 as a cross-reference.']);
    const r = await discoverTicketCommits(repo, 'HS-7');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].count).toBe(2);
    expect(r.span).toBeNull();
    expect(r.dirty).toBe(false);
  });

  it('interleaved commits → two groups + span; dirty tree flagged', async () => {
    commit('a.txt', 'HS-8: first');
    commit('b.txt', 'other work');
    commit('c.txt', 'HS-8: second');
    writeFileSync(join(repo, 'a.txt'), 'uncommitted change');
    const r = await discoverTicketCommits(repo, 'HS-8');
    expect(r.groups).toHaveLength(2);
    expect(r.span?.unrelatedCount).toBe(1);
    expect(r.dirty).toBe(true);
  });

  it('integration-branch-only commits form a ref-labeled group', async () => {
    git(['checkout', '-q', '-b', 'hotsheet/w1']);
    commit('w.txt', 'HS-9: worker change');
    git(['checkout', '-q', 'main']);
    const r = await discoverTicketCommits(repo, 'HS-9', { integrationBranch: 'hotsheet/w1' });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].ref).toBe('hotsheet/w1');
    // A missing branch is tolerated (no throw, no group).
    const r2 = await discoverTicketCommits(repo, 'HS-9', { integrationBranch: 'nope/gone' });
    expect(r2.groups).toHaveLength(0);
  });

  it('caches per tip: unmoved HEAD skips the log spawn; a new commit invalidates', async () => {
    commit('a.txt', 'HS-10: one');
    const calls: string[][] = [];
    const spyGit = vi.fn((root: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve(execFileSync('git', args, { timeout: 60_000, killSignal: 'SIGKILL', cwd: root, encoding: 'utf-8' }));
    });
    await discoverTicketCommits(repo, 'HS-10', { git: spyGit });
    const logCalls = (): number => calls.filter(a => a[0] === 'log').length;
    expect(logCalls()).toBe(1);
    await discoverTicketCommits(repo, 'HS-10', { git: spyGit });
    expect(logCalls()).toBe(1); // cache hit — only rev-parse + status re-ran
    commit('b.txt', 'HS-10: two');
    await discoverTicketCommits(repo, 'HS-10', { git: spyGit });
    expect(logCalls()).toBe(2); // tip moved — re-discovered
  });

  it('a non-repo directory returns the empty result (no throw)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-tcommits-norepo-'));
    try {
      const r = await discoverTicketCommits(dir, 'HS-1');
      expect(r).toEqual({ groups: [], span: null, dirty: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
