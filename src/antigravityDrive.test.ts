// HS-9321 — the Antigravity play-button drive (spawn `agy --print` one-shot).
import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAgyRunArgs, isAntigravityDriven, spawnAgyRun } from './antigravityDrive.js';

describe('buildAgyRunArgs', () => {
  it('defaults to --print + content + --dangerously-skip-permissions', () => {
    expect(buildAgyRunArgs('do the thing')).toEqual(['--print', 'do the thing', '--dangerously-skip-permissions']);
  });
  it('OMITS skip-permissions in interactive mode (HS-9327)', () => {
    expect(buildAgyRunArgs('x', { skipPermissions: false })).toEqual(['--print', 'x']);
  });
  it('appends --model when supplied, omits it when blank', () => {
    expect(buildAgyRunArgs('x', { model: 'gemini-3.1-pro' })).toContain('--model');
    expect(buildAgyRunArgs('x', { model: '   ' })).not.toContain('--model');
  });
});

describe('isAntigravityDriven', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-agydrive-'));
    dataDir = join(dir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const setTool = (t?: string): void =>
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(t === undefined ? {} : { ai_tool: t }), 'utf-8');

  it('is true when ai_tool=antigravity (case-insensitive)', () => {
    setTool('Antigravity');
    expect(isAntigravityDriven(dataDir)).toBe(true);
  });
  it('is false for another tool, and when unset', () => {
    setTool('claude');
    expect(isAntigravityDriven(dataDir)).toBe(false);
    setTool(undefined);
    expect(isAntigravityDriven(dataDir)).toBe(false);
  });
});

describe('spawnAgyRun', () => {
  const makeSpawn = (proc: EventEmitter) =>
    vi.fn((_command: string, _args: string[], _options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'ignore' }) => proc as unknown as ChildProcess);

  it('spawns `agy --print <content>` in the project dir and signals done on exit', () => {
    const proc = new EventEmitter();
    const spawnFn = makeSpawn(proc);
    const signalDone = vi.fn();
    const dataDir = join('/proj', '.hotsheet');

    expect(spawnAgyRun(dataDir, 4174, 'process the worklist', { spawnFn, signalDone })).toBe(true);

    const call = spawnFn.mock.calls.at(-1);
    expect(call?.[0]).toBe('agy');
    expect(call?.[1]).toEqual(['--print', 'process the worklist', '--dangerously-skip-permissions']);
    expect(call?.[2].cwd).toBe('/proj'); // <root>/.hotsheet → <root>
    // HS-9380 — the drive marker propagates to agy's MCP children so the run's
    // channel server registers as `drive: true` (not a duplicate main connection).
    expect(call?.[2].env.HOTSHEET_DRIVE_SPAWNED).toBe('1');

    expect(signalDone).not.toHaveBeenCalled();
    proc.emit('exit', 0, null);
    expect(signalDone).toHaveBeenCalledWith(dataDir, 4174);
  });

  it('posts a `busy` heartbeat on spawn and `idle` on exit (HS-9327)', () => {
    const proc = new EventEmitter();
    const postHeartbeat = vi.fn();
    spawnAgyRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone: vi.fn(), postHeartbeat });
    expect(postHeartbeat.mock.calls.at(0)?.[2]).toBe('busy'); // immediate
    proc.emit('exit', 0, null);
    expect(postHeartbeat.mock.calls.at(-1)?.[2]).toBe('idle'); // on finish
  });

  it('re-asserts `heartbeat` periodically while alive, and stops the interval on exit', () => {
    vi.useFakeTimers();
    try {
      const proc = new EventEmitter();
      const postHeartbeat = vi.fn();
      spawnAgyRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone: vi.fn(), postHeartbeat });
      const beats = () => postHeartbeat.mock.calls.filter(c => c[2] === 'heartbeat').length;
      expect(beats()).toBe(0);
      vi.advanceTimersByTime(31_000); // ~2 intervals (15s each)
      expect(beats()).toBe(2);
      proc.emit('exit', 0, null);
      vi.advanceTimersByTime(60_000); // no more heartbeats after exit
      expect(beats()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signals done + idle ONCE even if both error and exit fire', () => {
    const proc = new EventEmitter();
    const signalDone = vi.fn();
    const postHeartbeat = vi.fn();
    spawnAgyRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone, postHeartbeat });
    proc.emit('error', new Error('ENOENT'));
    proc.emit('exit', 1, null);
    expect(signalDone).toHaveBeenCalledTimes(1);
    expect(postHeartbeat.mock.calls.filter(c => c[2] === 'idle')).toHaveLength(1);
  });

  it('returns false when the spawn itself throws', () => {
    const spawnFn = vi.fn(() => { throw new Error('boom'); });
    expect(spawnAgyRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn, signalDone: vi.fn() })).toBe(false);
  });
});
