import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelInfo } from './channelPortFile.js';
import { readChannelInfo, writeChannelInfo } from './channelPortFile.js';
import { installPortFileWatcher } from './channelPortFileWatcher.js';

/**
 * HS-8455 — self-heal watcher pins:
 *   - steady-state no-op when the file already matches our identity
 *   - rewrite when the file is missing
 *   - rewrite when the file's pid differs (a sibling-process overwrote)
 *   - notify callback fires alongside each rewrite
 *   - livelock guard kicks in after 5 rewrites in 60 s
 *   - dispose clears the interval handle
 *
 * Driven by a manual `setIntervalFn` so we control the tick instead of
 * fighting real timers — the watcher's contract is "do the right thing
 * each tick," not "have correct timing."
 */

interface CaptureLog { event: string; details: string | undefined }

function makeOurInfo(): ChannelInfo {
  return { port: 56721, pid: 12964, slug: 'hotsheet', startedAt: '2026-05-19T02:09:18.399Z' };
}

describe('installPortFileWatcher (HS-8455)', () => {
  let dir: string;
  let portFile: string;
  let tick: (() => void) | null;
  let logs: CaptureLog[];
  let notifyCount: number;
  let dispose: (() => void) | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotsheet-portheal-'));
    portFile = join(dir, 'channel-port');
    tick = null;
    logs = [];
    notifyCount = 0;
    dispose = null;
  });

  afterEach(() => {
    if (dispose !== null) dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function install(info: ChannelInfo = makeOurInfo()) {
    dispose = installPortFileWatcher({
      portFile,
      info,
      intervalMs: 1,
      log: (event, details) => logs.push({ event, details }),
      notify: () => { notifyCount++; },
      setIntervalFn: (cb) => { tick = cb; return 'handle'; },
      clearIntervalFn: () => { tick = null; },
    });
  }

  it('does not rewrite when the file already matches our identity', () => {
    const info = makeOurInfo();
    writeChannelInfo(portFile, info);
    install(info);
    tick!();
    expect(logs).toEqual([]);
    expect(notifyCount).toBe(0);
    // Contents unchanged.
    expect(readChannelInfo(portFile)).toEqual(info);
  });

  it('rewrites and notifies when the port file is missing (HS-8452 captured-trace recovery)', () => {
    install();
    tick!();
    expect(readChannelInfo(portFile)).toEqual(makeOurInfo());
    expect(notifyCount).toBe(1);
    expect(logs[0]?.event).toBe('port-file-heal-rewrite');
    expect(logs[0]?.details).toBe('vanished');
  });

  it('rewrites and notifies when the port file pid differs (sibling-process overwrote)', () => {
    writeChannelInfo(portFile, { port: 59590, pid: 83798, slug: 'hotsheet', startedAt: 'other' });
    install();
    tick!();
    expect(readChannelInfo(portFile)).toEqual(makeOurInfo());
    expect(notifyCount).toBe(1);
    expect(logs[0]?.event).toBe('port-file-heal-rewrite');
    expect(logs[0]?.details).toMatch(/pid-mismatch on-disk=83798 ours=12964/);
  });

  it('rewrites when a legacy bare-port file (pid=null) is found — back-compat path', () => {
    writeFileSync(portFile, '11111', 'utf-8');
    install();
    tick!();
    expect(readChannelInfo(portFile)).toEqual(makeOurInfo());
    expect(notifyCount).toBe(1);
    expect(logs[0]?.details).toMatch(/pid-mismatch on-disk=null/);
  });

  it('is idempotent across multiple ticks once the file matches', () => {
    install();
    tick!(); // rewrite 1 (file missing)
    tick!(); // no-op (now matches)
    tick!(); // no-op
    expect(notifyCount).toBe(1);
    expect(logs.filter(l => l.event === 'port-file-heal-rewrite')).toHaveLength(1);
  });

  it('stops rewriting after the livelock cap (5 rewrites in 60 s) and logs livelock', () => {
    install();
    // Force 6 consecutive rewrites by clearing the file each tick.
    for (let i = 0; i < 6; i++) {
      try { rmSync(portFile); } catch { /* ignore */ }
      tick!();
    }
    // 5 rewrites then the livelock event.
    expect(logs.filter(l => l.event === 'port-file-heal-rewrite')).toHaveLength(5);
    expect(logs.filter(l => l.event === 'port-file-heal-livelock')).toHaveLength(1);
    expect(notifyCount).toBe(5);
  });

  it('after livelock, subsequent ticks are silent (no further log noise)', () => {
    install();
    for (let i = 0; i < 6; i++) {
      try { rmSync(portFile); } catch { /* ignore */ }
      tick!();
    }
    const livelockLogCount = logs.length;
    // Many more ticks — nothing additional.
    for (let i = 0; i < 10; i++) {
      try { rmSync(portFile); } catch { /* ignore */ }
      tick!();
    }
    expect(logs.length).toBe(livelockLogCount);
  });

  it('dispose() clears the interval handle so the tick stops firing in production', () => {
    const clearFn = vi.fn();
    let scheduledHandle: unknown = null;
    const innerDispose = installPortFileWatcher({
      portFile,
      info: makeOurInfo(),
      intervalMs: 1,
      setIntervalFn: () => { scheduledHandle = 'X'; return scheduledHandle; },
      clearIntervalFn: clearFn,
    });
    innerDispose();
    expect(clearFn).toHaveBeenCalledTimes(1);
    expect(clearFn).toHaveBeenCalledWith('X');
  });
});
