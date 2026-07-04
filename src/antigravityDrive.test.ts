// HS-9321 — the Antigravity play-button drive (spawn `agy --print` one-shot).
import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAgyRunArgs, isAntigravityDriven, spawnAgyRun } from './antigravityDrive.js';

describe('buildAgyRunArgs', () => {
  it('builds --print + the content + --dangerously-skip-permissions', () => {
    expect(buildAgyRunArgs('do the thing')).toEqual(['--print', 'do the thing', '--dangerously-skip-permissions']);
  });
  it('appends --model when supplied, omits it when blank', () => {
    expect(buildAgyRunArgs('x', 'gemini-3.1-pro')).toContain('--model');
    expect(buildAgyRunArgs('x', '   ')).not.toContain('--model');
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

    expect(signalDone).not.toHaveBeenCalled();
    proc.emit('exit', 0, null);
    expect(signalDone).toHaveBeenCalledWith(dataDir, 4174);
  });

  it('signals done when the process fails to launch (error event)', () => {
    const proc = new EventEmitter();
    const signalDone = vi.fn();
    spawnAgyRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone });
    proc.emit('error', new Error('ENOENT'));
    expect(signalDone).toHaveBeenCalledTimes(1);
  });

  it('returns false when the spawn itself throws', () => {
    const spawnFn = vi.fn(() => { throw new Error('boom'); });
    expect(spawnAgyRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn, signalDone: vi.fn() })).toBe(false);
  });
});
