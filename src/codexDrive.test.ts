// HS-9369 — the Codex play-button drive (spawn `codex exec --json` one-shot).
import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { buildCodexExecArgs, parseCodexEventType, spawnCodexRun } from './codexDrive.js';

describe('buildCodexExecArgs', () => {
  it('builds the non-interactive JSONL run with sandbox/approvals bypassed (the agy analog)', () => {
    expect(buildCodexExecArgs('do the thing')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'do the thing',
    ]);
  });

  it('interactive-permissions mode (HS-9359) swaps the bypass for sandbox + hooks', () => {
    expect(buildCodexExecArgs('x', { interactivePermissions: true })).toEqual([
      'exec', '--json', '--skip-git-repo-check',
      '--enable', 'hooks', '--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write', 'x',
    ]);
    // The dangerous approvals/sandbox bypass is gone in interactive mode.
    expect(buildCodexExecArgs('x', { interactivePermissions: true })).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('parseCodexEventType', () => {
  it('extracts the type from the captured codex-cli 0.145.0 event shapes', () => {
    expect(parseCodexEventType('{"type":"thread.started","thread_id":"019f"}')).toBe('thread.started');
    expect(parseCodexEventType('{"type":"turn.started"}')).toBe('turn.started');
    expect(parseCodexEventType('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}')).toBe('item.completed');
    expect(parseCodexEventType('{"type":"turn.completed","usage":{"input_tokens":1}}')).toBe('turn.completed');
  });

  it('returns null for blank, non-JSON, and shape-less lines', () => {
    expect(parseCodexEventType('')).toBeNull();
    expect(parseCodexEventType('   ')).toBeNull();
    expect(parseCodexEventType('WARNING: proceeding, even though …')).toBeNull();
    expect(parseCodexEventType('{"no_type":true}')).toBeNull();
    expect(parseCodexEventType('null')).toBeNull();
    expect(parseCodexEventType('[1,2]')).toBeNull();
  });
});

/** A fake ChildProcess with a pipeable stdout. */
function makeProc(): EventEmitter & { stdout: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
  proc.stdout = new EventEmitter();
  return proc;
}

describe('spawnCodexRun', () => {
  const makeSpawn = (proc: EventEmitter) =>
    vi.fn((_command: string, _args: string[], _options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'ignore'] }) => proc as unknown as ChildProcess);

  it('spawns `codex exec --json …` in the project dir and signals done on exit', () => {
    const proc = makeProc();
    const spawnFn = makeSpawn(proc);
    const signalDone = vi.fn();
    const dataDir = join('/proj', '.hotsheet');

    expect(spawnCodexRun(dataDir, 4174, 'process the worklist', { spawnFn, signalDone })).toBe(true);

    const call = spawnFn.mock.calls.at(-1);
    expect(call?.[0]).toBe('codex');
    expect(call?.[1]).toEqual(buildCodexExecArgs('process the worklist'));
    expect(call?.[2].cwd).toBe('/proj'); // <root>/.hotsheet → <root>
    expect(call?.[2].stdio).toEqual(['ignore', 'pipe', 'ignore']); // JSONL consumed

    expect(signalDone).not.toHaveBeenCalled();
    proc.emit('exit', 0, null);
    expect(signalDone).toHaveBeenCalledWith(dataDir, 4174);
  });

  it('posts `busy` on spawn, event-driven `heartbeat`s for structured lines, and `idle` on exit', () => {
    const proc = makeProc();
    const postHeartbeat = vi.fn();
    spawnCodexRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone: vi.fn(), postHeartbeat });
    expect(postHeartbeat.mock.calls.at(0)?.[2]).toBe('busy'); // immediate

    const beats = () => postHeartbeat.mock.calls.filter(c => c[2] === 'heartbeat').length;
    // Two structured events split across chunks + one plain-text warning line.
    proc.stdout.emit('data', '{"type":"turn.started"}\nWARNING: something\n{"type":"item.comp');
    expect(beats()).toBe(1); // warning line ignored; partial line buffered
    proc.stdout.emit('data', 'leted","item":{"id":"i","type":"agent_message","text":"hi"}}\n');
    expect(beats()).toBe(2);

    proc.emit('exit', 0, null);
    expect(postHeartbeat.mock.calls.at(-1)?.[2]).toBe('idle'); // on finish
  });

  it('re-asserts `heartbeat` on the 15s interval floor, and stops it on exit', () => {
    vi.useFakeTimers();
    try {
      const proc = makeProc();
      const postHeartbeat = vi.fn();
      spawnCodexRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone: vi.fn(), postHeartbeat });
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
    const proc = makeProc();
    const signalDone = vi.fn();
    const postHeartbeat = vi.fn();
    spawnCodexRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn: makeSpawn(proc), signalDone, postHeartbeat });
    proc.emit('error', new Error('ENOENT'));
    proc.emit('exit', 1, null);
    expect(signalDone).toHaveBeenCalledTimes(1);
    expect(postHeartbeat.mock.calls.filter(c => c[2] === 'idle')).toHaveLength(1);
  });

  it('returns false when the spawn itself throws', () => {
    const spawnFn = vi.fn(() => { throw new Error('boom'); });
    expect(spawnCodexRun(join('/proj', '.hotsheet'), 4174, 'x', { spawnFn, signalDone: vi.fn() })).toBe(false);
  });
});
