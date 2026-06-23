import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupExtraConnections,
  entryPath,
  listAliveEntries,
  pickLeader,
  registerSelf,
  registryDir,
  unregisterSelf,
} from './channelRegistry.js';

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `hs-registry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('channelRegistry — registerSelf / unregisterSelf', () => {
  it('writes an entry file at <dataDir>/channel-ports.d/<pid>.json', () => {
    registerSelf(dataDir, { port: 4174, pid: 12345, slug: 'demo', startedAt: '2026-05-19T07:00:00.000Z' });
    const path = entryPath(dataDir, 12345);
    const entries = readdirSync(registryDir(dataDir));
    expect(entries).toContain('12345.json');
    // Read it back via listAliveEntries with an always-alive probe.
    const all = listAliveEntries(dataDir, () => true);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ port: 4174, pid: 12345, slug: 'demo', startedAt: '2026-05-19T07:00:00.000Z' });
    // HS-8713 — build the expected suffix with `join` so the separator is
    // the platform's (`\` on Windows); a hardcoded `/channel-ports.d/...`
    // never matched the backslash path on Windows.
    expect(path.endsWith(join('channel-ports.d', '12345.json'))).toBe(true);
  });

  it('overwrites an existing entry (idempotent self-heal)', () => {
    registerSelf(dataDir, { port: 4174, pid: 77, slug: 'demo', startedAt: '2026-05-19T07:00:00.000Z' });
    registerSelf(dataDir, { port: 5555, pid: 77, slug: 'demo', startedAt: '2026-05-19T07:00:00.000Z' });
    const all = listAliveEntries(dataDir, () => true);
    expect(all).toHaveLength(1);
    expect(all[0].port).toBe(5555);
  });

  it('unregisterSelf removes the file; safe to call when missing', () => {
    registerSelf(dataDir, { port: 4174, pid: 12, slug: 'demo', startedAt: '2026-05-19T07:00:00.000Z' });
    unregisterSelf(dataDir, 12);
    expect(listAliveEntries(dataDir, () => true)).toEqual([]);
    expect(() => { unregisterSelf(dataDir, 12); }).not.toThrow();
  });

  it('does nothing when info.pid is null (legacy / pre-v0.17 info)', () => {
    registerSelf(dataDir, { port: 4174, pid: null, slug: 'demo', startedAt: '2026-05-19T07:00:00.000Z' });
    expect(listAliveEntries(dataDir, () => true)).toEqual([]);
  });
});

describe('channelRegistry — listAliveEntries', () => {
  it('returns [] when the registry directory is missing', () => {
    expect(listAliveEntries(dataDir, () => true)).toEqual([]);
  });

  it('returns [] when the directory is empty', () => {
    mkdirSync(registryDir(dataDir), { recursive: true });
    expect(listAliveEntries(dataDir, () => true)).toEqual([]);
  });

  it('orders by startedAt ascending (oldest leader at [0])', () => {
    registerSelf(dataDir, { port: 100, pid: 1, slug: 'x', startedAt: '2026-05-19T07:00:02.000Z' });
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    registerSelf(dataDir, { port: 300, pid: 3, slug: 'x', startedAt: '2026-05-19T07:00:01.000Z' });
    const ordered = listAliveEntries(dataDir, () => true);
    expect(ordered.map(e => e.pid)).toEqual([2, 3, 1]);
    expect(pickLeader(ordered)?.pid).toBe(2);
  });

  it('GCs entries whose pid is not alive (deletes the file)', () => {
    registerSelf(dataDir, { port: 100, pid: 1, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:01.000Z' });
    // pid 1 is dead.
    const isAlive = (pid: number): boolean => pid === 2;
    const alive = listAliveEntries(dataDir, isAlive);
    expect(alive.map(e => e.pid)).toEqual([2]);
    // The dead entry was removed from disk.
    const files = readdirSync(registryDir(dataDir));
    expect(files).toEqual(['2.json']);
  });

  it('GCs entries that are unparseable JSON', () => {
    mkdirSync(registryDir(dataDir), { recursive: true });
    writeFileSync(join(registryDir(dataDir), '99.json'), 'not valid json', 'utf-8');
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    const alive = listAliveEntries(dataDir, () => true);
    expect(alive.map(e => e.pid)).toEqual([2]);
    const files = readdirSync(registryDir(dataDir));
    expect(files).toEqual(['2.json']);
  });

  it('GCs entries with valid JSON but missing required fields', () => {
    mkdirSync(registryDir(dataDir), { recursive: true });
    writeFileSync(join(registryDir(dataDir), '99.json'), JSON.stringify({ port: 'not-a-number' }), 'utf-8');
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    const alive = listAliveEntries(dataDir, () => true);
    expect(alive.map(e => e.pid)).toEqual([2]);
  });

  it('skips non-JSON files in the registry directory (e.g. tmp files)', () => {
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    writeFileSync(join(registryDir(dataDir), 'README'), 'ignore me', 'utf-8');
    const alive = listAliveEntries(dataDir, () => true);
    expect(alive.map(e => e.pid)).toEqual([2]);
  });

  it('entries without startedAt sink to the end of the sort', () => {
    mkdirSync(registryDir(dataDir), { recursive: true });
    writeFileSync(join(registryDir(dataDir), '5.json'),
      JSON.stringify({ port: 100, pid: 5, slug: 'x' }), 'utf-8'); // no startedAt
    registerSelf(dataDir, { port: 200, pid: 6, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    const ordered = listAliveEntries(dataDir, () => true);
    expect(ordered.map(e => e.pid)).toEqual([6, 5]);
    expect(pickLeader(ordered)?.pid).toBe(6);
  });
});

describe('channelRegistry — pickLeader', () => {
  it('returns null on an empty list', () => {
    expect(pickLeader([])).toBeNull();
  });

  it('returns [0] (already-sorted leader)', () => {
    const entries = [
      { port: 100, pid: 1, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' },
      { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:01.000Z' },
    ];
    expect(pickLeader(entries)?.pid).toBe(1);
  });
});

describe('channelRegistry — failover end-to-end (captures HS-8460 FIFO semantics)', () => {
  it('leader flips to the next-oldest when the original leader becomes dead', () => {
    registerSelf(dataDir, { port: 100, pid: 1, slug: 'x', startedAt: '2026-05-19T07:00:00.000Z' });
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-05-19T07:00:01.000Z' });
    registerSelf(dataDir, { port: 300, pid: 3, slug: 'x', startedAt: '2026-05-19T07:00:02.000Z' });

    // Initially pid 1 is leader.
    let alive = listAliveEntries(dataDir, () => true);
    expect(pickLeader(alive)?.pid).toBe(1);

    // pid 1 dies — leader flips to pid 2.
    alive = listAliveEntries(dataDir, (pid) => pid !== 1);
    expect(pickLeader(alive)?.pid).toBe(2);

    // pid 2 also dies — leader flips to pid 3.
    alive = listAliveEntries(dataDir, (pid) => pid === 3);
    expect(pickLeader(alive)?.pid).toBe(3);

    // pid 3 dies too — no leader.
    alive = listAliveEntries(dataDir, () => false);
    expect(pickLeader(alive)).toBeNull();
  });
});

describe('cleanupExtraConnections (HS-8948)', () => {
  it('terminates every alive channel-server except the leader (oldest) + removes their entries', () => {
    registerSelf(dataDir, { port: 100, pid: 1, slug: 'x', startedAt: '2026-06-23T07:00:00.000Z' }); // leader (oldest)
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-06-23T07:00:05.000Z' });
    registerSelf(dataDir, { port: 300, pid: 3, slug: 'x', startedAt: '2026-06-23T07:00:10.000Z' });

    const killed: number[] = [];
    const result = cleanupExtraConnections(dataDir, { kill: (pid) => killed.push(pid), isPidAlive: () => true });

    expect(result.sort()).toEqual([2, 3]);   // non-leaders signaled
    expect(killed.sort()).toEqual([2, 3]);
    // The leader's entry remains; the duplicates' entries are gone.
    const remaining = listAliveEntries(dataDir, () => true);
    expect(remaining.map(e => e.pid)).toEqual([1]);
  });

  it('is a no-op when only the leader is alive', () => {
    registerSelf(dataDir, { port: 100, pid: 1, slug: 'x', startedAt: '2026-06-23T07:00:00.000Z' });
    const killed: number[] = [];
    const result = cleanupExtraConnections(dataDir, { kill: (pid) => killed.push(pid), isPidAlive: () => true });
    expect(result).toEqual([]);
    expect(killed).toEqual([]);
    expect(listAliveEntries(dataDir, () => true).map(e => e.pid)).toEqual([1]);
  });

  it('does not throw when a kill fails (process already gone)', () => {
    registerSelf(dataDir, { port: 100, pid: 1, slug: 'x', startedAt: '2026-06-23T07:00:00.000Z' });
    registerSelf(dataDir, { port: 200, pid: 2, slug: 'x', startedAt: '2026-06-23T07:00:05.000Z' });
    const result = cleanupExtraConnections(dataDir, {
      kill: () => { throw new Error('ESRCH'); },
      isPidAlive: () => true,
    });
    // The entry is still removed even though the signal threw — count drops.
    expect(result).toEqual([2]);
    expect(listAliveEntries(dataDir, () => true).map(e => e.pid)).toEqual([1]);
  });
});
