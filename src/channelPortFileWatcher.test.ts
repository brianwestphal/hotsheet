import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelInfo } from './channelPortFile.js';
import { readChannelInfo, writeChannelInfo } from './channelPortFile.js';
import { installPortFileWatcher } from './channelPortFileWatcher.js';
import { listAliveEntries, registerSelf, unregisterSelf } from './channelRegistry.js';

/**
 * HS-8455 + HS-8460 — registry-backed self-heal watcher pins:
 *   - leader writes channel-port when missing / wrong
 *   - leader no-ops when channel-port already matches our identity
 *   - follower DOES NOT touch channel-port (no duel)
 *   - leader promotion happens when the previous leader's entry is GC'd
 *   - our registry entry is re-registered if it vanished mid-session
 *   - notify only fires on a leader-write
 *   - dispose clears the interval handle
 *
 * Driven by a manual `setIntervalFn` so we control the tick instead of
 * fighting real timers — the watcher's contract is "do the right thing
 * each tick," not "have correct timing."
 */

interface CaptureLog { event: string; details: string | undefined }

function makeInfo(pid: number, port: number, startedAt: string): ChannelInfo {
  return { port, pid, slug: 'hotsheet', startedAt };
}

let dataDir: string;
let portFile: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hs-watcher-'));
  portFile = join(dataDir, 'channel-port');
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('installPortFileWatcher (HS-8460 registry-backed)', () => {
  it('leader path — writes channel-port when file is missing and notifies', () => {
    const us = makeInfo(12964, 56721, '2026-05-19T07:00:00.000Z');
    registerSelf(dataDir, us);
    const ticks: Array<() => void> = [];
    const logs: CaptureLog[] = [];
    const notify = vi.fn();

    installPortFileWatcher({
      portFile,
      dataDir,
      info: us,
      log: (event, details) => logs.push({ event, details }),
      notify,
      setIntervalFn: (cb) => { ticks.push(cb); return 'h'; },
      clearIntervalFn: () => {},
      isPidAlive: () => true,
    });

    expect(readChannelInfo(portFile)).toBeNull();
    ticks[0]();
    const info = readChannelInfo(portFile);
    expect(info).toEqual({ port: 56721, pid: 12964, slug: 'hotsheet', startedAt: '2026-05-19T07:00:00.000Z' });
    expect(logs.some(l => l.event === 'port-file-leader-write')).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('leader path — steady-state no-op when channel-port already matches', () => {
    const us = makeInfo(12964, 56721, '2026-05-19T07:00:00.000Z');
    registerSelf(dataDir, us);
    writeChannelInfo(portFile, us);
    const ticks: Array<() => void> = [];
    const logs: CaptureLog[] = [];
    const notify = vi.fn();

    installPortFileWatcher({
      portFile,
      dataDir,
      info: us,
      log: (event, details) => logs.push({ event, details }),
      notify,
      setIntervalFn: (cb) => { ticks.push(cb); return 'h'; },
      clearIntervalFn: () => {},
      isPidAlive: () => true,
    });

    ticks[0](); ticks[0](); ticks[0]();
    expect(logs.filter(l => l.event === 'port-file-leader-write')).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('follower path — does NOT rewrite channel-port when another leader is registered', () => {
    const olderLeader = makeInfo(11111, 1111, '2026-05-19T07:00:00.000Z');
    const us = makeInfo(22222, 2222, '2026-05-19T07:00:05.000Z');
    registerSelf(dataDir, olderLeader);
    registerSelf(dataDir, us);
    writeChannelInfo(portFile, olderLeader);

    const ticks: Array<() => void> = [];
    const logs: CaptureLog[] = [];
    const notify = vi.fn();

    installPortFileWatcher({
      portFile,
      dataDir,
      info: us,
      log: (event, details) => logs.push({ event, details }),
      notify,
      setIntervalFn: (cb) => { ticks.push(cb); return 'h'; },
      clearIntervalFn: () => {},
      isPidAlive: () => true,
    });

    ticks[0](); ticks[0](); ticks[0]();
    expect(readChannelInfo(portFile)?.pid).toBe(11111);
    expect(logs.filter(l => l.event === 'port-file-leader-write')).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    // Follower-defer logged ONCE on the first tick (transition from
    // unknown → follower), not on every subsequent steady-state tick.
    expect(logs.filter(l => l.event === 'port-file-follower-defer')).toHaveLength(1);
  });

  it('leader promotion — when the older leader dies, we take over within one tick', () => {
    const olderLeader = makeInfo(11111, 1111, '2026-05-19T07:00:00.000Z');
    const us = makeInfo(22222, 2222, '2026-05-19T07:00:05.000Z');
    registerSelf(dataDir, olderLeader);
    registerSelf(dataDir, us);
    writeChannelInfo(portFile, olderLeader);

    const ticks: Array<() => void> = [];
    const logs: CaptureLog[] = [];
    const notify = vi.fn();
    const aliveSet = new Set<number>([11111, 22222]);

    installPortFileWatcher({
      portFile,
      dataDir,
      info: us,
      log: (event, details) => logs.push({ event, details }),
      notify,
      setIntervalFn: (cb) => { ticks.push(cb); return 'h'; },
      clearIntervalFn: () => {},
      isPidAlive: (pid) => aliveSet.has(pid),
    });

    // Tick 1 — we're the follower, channel-port stays pointing to the older leader.
    ticks[0]();
    expect(readChannelInfo(portFile)?.pid).toBe(11111);

    // Older leader dies — its registry entry will be GC'd by the next listAlive.
    aliveSet.delete(11111);
    ticks[0]();
    // We're now the leader; channel-port flipped to us; notify fired.
    expect(readChannelInfo(portFile)?.pid).toBe(22222);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logs.some(l => l.event === 'port-file-leader-write' && (l.details ?? '').includes('previous-leader-pid=11111'))).toBe(true);
  });

  it('registry self-heal — re-registers our entry if it vanished, then proceeds as leader', () => {
    const us = makeInfo(12964, 56721, '2026-05-19T07:00:00.000Z');
    registerSelf(dataDir, us);
    // Simulate a wipe of our entry (user `rm`'d the registry mid-session).
    unregisterSelf(dataDir, 12964);

    const ticks: Array<() => void> = [];
    const logs: CaptureLog[] = [];

    installPortFileWatcher({
      portFile,
      dataDir,
      info: us,
      log: (event, details) => logs.push({ event, details }),
      setIntervalFn: (cb) => { ticks.push(cb); return 'h'; },
      clearIntervalFn: () => {},
      isPidAlive: () => true,
    });

    ticks[0]();
    // Our entry is back.
    const entries = listAliveEntries(dataDir, () => true);
    expect(entries.map(e => e.pid)).toEqual([12964]);
    // channel-port written because we are the sole leader.
    expect(readChannelInfo(portFile)?.pid).toBe(12964);
    expect(logs.some(l => l.event === 'port-file-registry-heal')).toBe(true);
    expect(logs.some(l => l.event === 'port-file-leader-write')).toBe(true);
  });

  it('dispose clears the interval handle', () => {
    const us = makeInfo(12964, 56721, '2026-05-19T07:00:00.000Z');
    registerSelf(dataDir, us);
    const clearSpy = vi.fn();

    const dispose = installPortFileWatcher({
      portFile,
      dataDir,
      info: us,
      setIntervalFn: () => 'handle-token',
      clearIntervalFn: clearSpy,
      isPidAlive: () => true,
    });
    dispose();
    expect(clearSpy).toHaveBeenCalledWith('handle-token');
  });
});
