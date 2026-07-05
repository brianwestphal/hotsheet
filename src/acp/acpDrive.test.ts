// HS-9330 — the ACP play-button drive (spawn `opencode acp`, run one turn over stdio).
// Driven against a SCRIPTED fake ACP agent that replays the real OpenCode message
// shapes (from the §114.11 spike) — no spawn, no `opencode auth`, no LLM turn.
import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AcpDriveDeps, isAcpDriven, spawnAcpRun } from './acpDrive.js';

type SpawnFn = NonNullable<AcpDriveDeps['spawnFn']>;

/** Flush the microtask + immediate queues so the async `runPrompt` chain settles. */
const flush = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/**
 * A fake ChildProcess whose stdin auto-responds like a real ACP agent: `initialize`
 * → protocolVersion 1, `session/new` → a sessionId (plus a streamed `session/update`),
 * `session/prompt` → a `session/update` then a terminal `stopReason`. Captures the
 * argv the drive spawned it with.
 */
function scriptedAgent(stopReason = 'end_turn'): {
  proc: EventEmitter & { stdin: unknown; stdout: EventEmitter; kill: () => void };
  spawnFn: SpawnFn;
  spawned: { command?: string; args?: string[]; cwd?: string };
} {
  const stdout = new EventEmitter();
  const emit = (obj: unknown): void => { stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf-8')); };

  const respond = (line: string): void => {
    let msg: { id?: unknown; method?: string };
    try { msg = JSON.parse(line) as typeof msg; } catch { return; }
    if (msg.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.17.9' } } });
    } else if (msg.method === 'session/new') {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update' } } });
      emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    } else if (msg.method === 'session/prompt') {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } });
      emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason } });
    }
  };

  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: (s: string) => { respond(s); }, end: () => {} },
    stdout,
    kill: vi.fn(),
  });
  const spawned: { command?: string; args?: string[]; cwd?: string } = {};
  const spawnFn = vi.fn<SpawnFn>((command, args, options) => {
    spawned.command = command;
    spawned.args = args;
    spawned.cwd = options.cwd;
    return proc as unknown as ChildProcess;
  });
  return { proc, spawnFn, spawned };
}

describe('isAcpDriven', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-acpdrive-'));
    dataDir = join(dir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const setTool = (t?: string): void =>
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(t === undefined ? {} : { ai_tool: t }), 'utf-8');

  it('is true when ai_tool=opencode (case-insensitive)', () => {
    setTool('OpenCode');
    expect(isAcpDriven(dataDir)).toBe(true);
  });
  it('is false for a non-ACP tool, and when unset', () => {
    setTool('claude');
    expect(isAcpDriven(dataDir)).toBe(false);
    setTool('antigravity');
    expect(isAcpDriven(dataDir)).toBe(false);
    setTool(undefined);
    expect(isAcpDriven(dataDir)).toBe(false);
  });
});

describe('spawnAcpRun', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-acprun-'));
    dataDir = join(dir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const setTool = (t: string): void =>
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: t }), 'utf-8');

  it('returns false and does not spawn when the project is not ACP-driven', () => {
    setTool('claude');
    const spawnFn = vi.fn();
    expect(spawnAcpRun(dataDir, 4174, 'x', { spawnFn })).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns `opencode acp` in the project dir', () => {
    setTool('opencode');
    const { spawnFn, spawned } = scriptedAgent();
    expect(spawnAcpRun(dataDir, 4174, 'process the worklist', { spawnFn, signalDone: vi.fn(), postHeartbeat: vi.fn() })).toBe(true);
    expect(spawned.command).toBe('opencode');
    expect(spawned.args).toEqual(['acp']);
    expect(spawned.cwd).toBe(dir); // <root>/.hotsheet → <root>
  });

  it('drives one full turn: busy on start, activity heartbeats, idle + done on stopReason', async () => {
    setTool('opencode');
    const { spawnFn } = scriptedAgent('end_turn');
    const signalDone = vi.fn();
    const postHeartbeat = vi.fn();
    spawnAcpRun(dataDir, 4174, 'go', { spawnFn, signalDone, postHeartbeat });

    expect(postHeartbeat.mock.calls.at(0)?.[2]).toBe('busy'); // immediate
    await flush(); // let initialize → session/new → session/prompt → stopReason settle

    // Each streamed `session/update` produced an activity heartbeat.
    expect(postHeartbeat.mock.calls.filter((c) => c[2] === 'heartbeat').length).toBeGreaterThanOrEqual(2);
    // The terminal stopReason cleared busy + signaled done.
    expect(postHeartbeat.mock.calls.at(-1)?.[2]).toBe('idle');
    expect(signalDone).toHaveBeenCalledWith(dataDir, 4174);
  });

  it('signals done + idle ONCE even if the process also exits', async () => {
    setTool('opencode');
    const { proc, spawnFn } = scriptedAgent('end_turn');
    const signalDone = vi.fn();
    const postHeartbeat = vi.fn();
    spawnAcpRun(dataDir, 4174, 'go', { spawnFn, signalDone, postHeartbeat });
    await flush(); // turn completes via stopReason
    proc.emit('exit', 0, null); // late exit must not double-fire
    expect(signalDone).toHaveBeenCalledTimes(1);
    expect(postHeartbeat.mock.calls.filter((c) => c[2] === 'idle')).toHaveLength(1);
  });

  it('clears busy on a process exit even without a stopReason', () => {
    setTool('opencode');
    const stdout = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), {
      stdin: { write: () => {}, end: () => {} }, // never responds → no turn end
      stdout,
      kill: vi.fn(),
    });
    const spawnFn = vi.fn<SpawnFn>(() => proc as unknown as ChildProcess);
    const signalDone = vi.fn();
    const postHeartbeat = vi.fn();
    spawnAcpRun(dataDir, 4174, 'go', { spawnFn, signalDone, postHeartbeat });
    expect(signalDone).not.toHaveBeenCalled();
    proc.emit('exit', 1, null);
    expect(signalDone).toHaveBeenCalledWith(dataDir, 4174);
    expect(postHeartbeat.mock.calls.at(-1)?.[2]).toBe('idle');
  });

  it('re-asserts `heartbeat` on the periodic timer and stops it on finish', () => {
    vi.useFakeTimers();
    try {
      setTool('opencode');
      const stdout = new EventEmitter();
      const proc = Object.assign(new EventEmitter(), {
        stdin: { write: () => {}, end: () => {} }, // no turn end → only timer beats
        stdout,
        kill: vi.fn(),
      });
      const spawnFn = vi.fn<SpawnFn>(() => proc as unknown as ChildProcess);
      const postHeartbeat = vi.fn();
      spawnAcpRun(dataDir, 4174, 'go', { spawnFn, signalDone: vi.fn(), postHeartbeat });
      const beats = (): number => postHeartbeat.mock.calls.filter((c) => c[2] === 'heartbeat').length;
      expect(beats()).toBe(0);
      vi.advanceTimersByTime(31_000); // ~2 intervals (15s each)
      expect(beats()).toBe(2);
      proc.emit('exit', 0, null);
      vi.advanceTimersByTime(60_000); // no more beats after finish
      expect(beats()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when the spawn itself throws', () => {
    setTool('opencode');
    const spawnFn = vi.fn<SpawnFn>(() => { throw new Error("ENOENT"); });
    expect(spawnAcpRun(dataDir, 4174, 'go', { spawnFn, signalDone: vi.fn() })).toBe(false);
  });
});
