import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTaskpolicyArgs,
  bumpProcessPriorityBestEffort,
  shouldBumpProcessPriority,
  TASKPOLICY_QOS_CLASS,
} from './processPriority.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawnSync: spawnSyncMock }));

describe('shouldBumpProcessPriority — pure platform gate', () => {
  it('returns true on darwin', () => {
    expect(shouldBumpProcessPriority('darwin')).toBe(true);
  });

  it('returns false on linux', () => {
    expect(shouldBumpProcessPriority('linux')).toBe(false);
  });

  it('returns false on win32', () => {
    expect(shouldBumpProcessPriority('win32')).toBe(false);
  });

  it('returns false on freebsd / openbsd / aix / sunos / android', () => {
    for (const platform of ['freebsd', 'openbsd', 'aix', 'sunos', 'android'] as const) {
      expect(shouldBumpProcessPriority(platform)).toBe(false);
    }
  });
});

describe('buildTaskpolicyArgs — argv builder (HS-8358 form-2 maximum-priority)', () => {
  it('produces the form-2 maximum-priority combination `-B -t 0 -l 0 -p <pid>`', () => {
    // HS-8358 regression guard. Pre-fix this was
    // `['-p', '12345', '-c', 'user-interactive']` which produced a
    // taskpolicy parse error on every boot. The man page restricts the
    // `-p <pid>` form to `[-b|-B] [-t <tier>] [-l <tier>]` — `-c` is a
    // form-1 (new-program) clamp only, and `-c` never accepts QoS class
    // names (only `utility` / `background`).
    expect(buildTaskpolicyArgs(12345)).toEqual(['-B', '-t', '0', '-l', '0', '-p', '12345']);
  });

  it('stringifies the pid (last positional arg)', () => {
    const args = buildTaskpolicyArgs(7);
    const pidIdx = args.indexOf('-p') + 1;
    expect(args[pidIdx]).toBe('7');
    expect(typeof args[pidIdx]).toBe('string');
  });

  it('never includes the invalid `-c` flag', () => {
    // HS-8358 — `-c` with `-p` is the exact bug we are guarding against;
    // a future "tweak" that re-adds it would re-introduce the parse
    // error and the slow-server banner risk that flagged the bug.
    expect(buildTaskpolicyArgs(42)).not.toContain('-c');
  });

  it('never passes a QoS class name as an argument value', () => {
    // HS-8358 — same regression guard from the opposite direction. If a
    // future refactor reintroduces a QoS class string anywhere in the
    // argv (e.g. as part of an experimental flag), it would re-trigger
    // the taskpolicy "Could not parse … as a QoS clamp" error.
    const args = buildTaskpolicyArgs(99);
    expect(args).not.toContain('user-interactive');
    expect(args).not.toContain('user-initiated');
    expect(args).not.toContain('default');
    expect(args).not.toContain('utility');
    expect(args).not.toContain('background');
  });

  it('TASKPOLICY_QOS_CLASS constant is preserved as documentation of intent', () => {
    // HS-8358 — the constant no longer drives argv but still names the
    // QoS class the bump is TARGETING, so the success-log message stays
    // accurate ("targeting user-interactive equivalent").
    expect(TASKPOLICY_QOS_CLASS).toBe('user-interactive');
  });
});

// HS-9133 — the actual best-effort bump (spawnSync gated on darwin).
describe('bumpProcessPriorityBestEffort', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value: p, configurable: true }); };
  beforeEach(() => { spawnSyncMock.mockReset(); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });

  it('returns false without spawning on a non-darwin platform', () => {
    setPlatform('linux');
    expect(bumpProcessPriorityBestEffort()).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns true on darwin when taskpolicy exits 0', () => {
    setPlatform('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stderr: '', error: undefined });
    expect(bumpProcessPriorityBestEffort()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith('taskpolicy', buildTaskpolicyArgs(process.pid), expect.objectContaining({ timeout: 2000 }));
  });

  it('returns false on a non-zero taskpolicy exit', () => {
    setPlatform('darwin');
    spawnSyncMock.mockReturnValue({ status: 1, stderr: 'nope', error: undefined });
    expect(bumpProcessPriorityBestEffort()).toBe(false);
  });

  it('returns false when spawnSync reports an error (binary missing)', () => {
    setPlatform('darwin');
    spawnSyncMock.mockReturnValue({ status: null, stderr: '', error: new Error('ENOENT') });
    expect(bumpProcessPriorityBestEffort()).toBe(false);
  });

  it('returns false when spawnSync throws', () => {
    setPlatform('darwin');
    spawnSyncMock.mockImplementation(() => { throw new Error('boom'); });
    expect(bumpProcessPriorityBestEffort()).toBe(false);
  });
});
