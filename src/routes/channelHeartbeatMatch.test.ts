// HS-9260 — the Claude-working heartbeat must attribute a session's
// `$CLAUDE_PROJECT_DIR` to the MOST-SPECIFIC registered project (longest rootDir
// prefix), so a session in a subdir / nested / worktree project doesn't bleed
// its busy state onto the wrong (outer) project.
import { describe, expect, it } from 'vitest';

import { heartbeatUpdatesSince, matchProjectDirToProject } from './channel.js';

const proj = (name: string, root: string) => ({ name, secret: `sec-${name}`, dataDir: `${root}/.hotsheet` });

describe('matchProjectDirToProject (HS-9260)', () => {
  it('matches an exact project root', () => {
    const projects = [proj('a', '/home/me/a'), proj('b', '/home/me/b')];
    expect(matchProjectDirToProject(projects, '/home/me/b')?.name).toBe('b');
  });

  it('matches a session running in a subdirectory of a project', () => {
    const projects = [proj('a', '/home/me/a')];
    expect(matchProjectDirToProject(projects, '/home/me/a/src/deep')?.name).toBe('a');
  });

  it('picks the MOST-SPECIFIC (innermost) of nested projects — not the first', () => {
    // `outer` is registered first and its root is a prefix of `inner`'s. The old
    // Array.find picked `outer` (first prefix match); longest-prefix picks `inner`.
    const projects = [proj('outer', '/home/me/mono'), proj('inner', '/home/me/mono/packages/app')];
    expect(matchProjectDirToProject(projects, '/home/me/mono/packages/app/src')?.name).toBe('inner');
    // A session in the outer project (but not the inner subtree) still maps to outer.
    expect(matchProjectDirToProject(projects, '/home/me/mono/tools')?.name).toBe('outer');
  });

  it('is independent of project registration order', () => {
    const inner = proj('inner', '/home/me/mono/packages/app');
    const outer = proj('outer', '/home/me/mono');
    expect(matchProjectDirToProject([inner, outer], '/home/me/mono/packages/app/x')?.name).toBe('inner');
    expect(matchProjectDirToProject([outer, inner], '/home/me/mono/packages/app/x')?.name).toBe('inner');
  });

  it('returns undefined when no project owns the dir (do NOT misattribute)', () => {
    const projects = [proj('a', '/home/me/a')];
    expect(matchProjectDirToProject(projects, '/home/me/other')).toBeUndefined();
    expect(matchProjectDirToProject(projects, '/home/me/ab')).toBeUndefined(); // sibling prefix, not a subdir
  });

  it('does not treat a sibling with a shared name prefix as a subdir', () => {
    // `/home/me/a` must NOT match `/home/me/apple` (would-be `startsWith('/home/me/a')`
    // bug); the `+ '/'` boundary in the matcher prevents it.
    const projects = [proj('a', '/home/me/a')];
    expect(matchProjectDirToProject(projects, '/home/me/apple/src')).toBeUndefined();
  });
});

describe('heartbeatUpdatesSince (HS-9261) — per-client cursor over the ring', () => {
  const ring = [
    { seq: 1, secret: 'A', state: 'busy' },
    { seq: 2, secret: 'A', state: 'heartbeat' },
    { seq: 3, secret: 'A', state: 'idle' },
  ];

  it('a fresh client (no cursor) syncs to latest WITHOUT replaying history', () => {
    expect(heartbeatUpdatesSince(ring, undefined)).toEqual([]);
  });

  it('returns only updates AFTER the client cursor', () => {
    expect(heartbeatUpdatesSince(ring, 1).map(u => u.seq)).toEqual([2, 3]);
    expect(heartbeatUpdatesSince(ring, 2).map(u => u.seq)).toEqual([3]);
    expect(heartbeatUpdatesSince(ring, 3)).toEqual([]);
  });

  it('TWO independent cursors each see the full busy→idle sequence (the stuck-on bug)', () => {
    // The old destructive drain let the first poller consume everyone's updates.
    // With per-client cursors, both clients — starting from the same cursor —
    // independently observe seq 2 and 3 (the `idle` that clears busy).
    const tab1 = heartbeatUpdatesSince(ring, 1);
    const tab2 = heartbeatUpdatesSince(ring, 1);
    expect(tab1.map(u => u.state)).toEqual(['heartbeat', 'idle']);
    expect(tab2.map(u => u.state)).toEqual(['heartbeat', 'idle']); // NOT drained by tab1
    expect(tab1.some(u => u.state === 'idle')).toBe(true);
    expect(tab2.some(u => u.state === 'idle')).toBe(true);
  });
});
