// HS-9383 — the codex app-server session manager, driven against a SCRIPTED fake
// app-server that replays the captured 0.145.0 shapes (no spawn, no LLM turn).
import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetAcpPermissionsForTesting, pendingAcpPermissionForSecret, resolveAcpPermission } from './acp/acpPermissionBridge.js';
import {
  _resetCodexAppServersForTesting,
  clearCodexAppServerFailures,
  type CodexAppServerDeps,
  codexInteractivePermissions,
  hasCodexAppServerHandshakeFailed,
  interruptCodexAppServerTurn,
  isCodexAppServerEnabled,
  readPersistedThreadId,
  spawnCodexAppServerRun,
} from './codexAppServer.js';
import { getProjectSecret } from './secret-file.js';

type SpawnFn = NonNullable<CodexAppServerDeps['spawnFn']>;

/** Flush microtasks so the async boot/turn chains settle. */
const flush = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

interface FakeServer {
  proc: EventEmitter & { stdin: { write: (s: string) => void }; stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  spawnFn: SpawnFn;
  spawned: { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  /** Every parsed line the drive wrote to the child's stdin, in order. */
  sent: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown }[];
  /** Emit a notification/server-request from the fake server. */
  emit: (obj: unknown) => void;
  /** Complete the CURRENT turn (turn/started must have been emitted by the script). */
  completeTurn: (turnId: string, status?: string) => void;
}

/**
 * A fake `codex app-server`: initialize → `{}`; `thread/resume` → ok when the id is in
 * `resumable`, else a "no rollout found" error; `thread/start` → `{thread:{id: newThreadId}}`;
 * `turn/start` → immediate inProgress ack + a scripted `turn/started` notification
 * (turnId = `turn-<n>`). Turn COMPLETION is manual (`completeTurn`) so tests control
 * queue/coalesce timing.
 */
function scriptedAppServer(opts: { resumable?: string[]; newThreadId?: string } = {}): FakeServer {
  const stdout = new EventEmitter();
  const emit = (obj: unknown): void => { stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf-8')); };
  const sent: FakeServer['sent'] = [];
  let turnCounter = 0;
  const respond = (line: string): void => {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown };
    try { msg = JSON.parse(line) as typeof msg; } catch { return; }
    sent.push(msg);
    if (msg.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake/0.145.0', codexHome: '/tmp/.codex' } });
    } else if (msg.method === 'thread/resume') {
      const id = (msg.params as { threadId?: string } | undefined)?.threadId;
      if (id !== undefined && (opts.resumable ?? []).includes(id)) {
        emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id } } });
      } else {
        emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${String(id)}` } });
      }
    } else if (msg.method === 'thread/start') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: opts.newThreadId ?? 'th-new' } } });
    } else if (msg.method === 'turn/start') {
      turnCounter += 1;
      const turnId = `turn-${String(turnCounter)}`;
      emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      emit({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: turnId, status: 'inProgress' } } });
    } else if (msg.method === 'turn/interrupt') {
      emit({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  };
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: (s: string) => { respond(s); } },
    stdout,
    kill: vi.fn(),
  });
  const spawned: FakeServer['spawned'] = {};
  const spawnFn = vi.fn<SpawnFn>((command, args, options) => {
    spawned.command = command; spawned.args = args; spawned.cwd = options.cwd; spawned.env = options.env;
    return proc as unknown as ChildProcess;
  });
  return {
    proc, spawnFn, spawned, sent, emit,
    completeTurn: (turnId, status = 'completed') => {
      emit({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: turnId, status } } });
    },
  };
}

let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hs-codexapp-'));
  dataDir = join(dir, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'codex' }), 'utf-8');
});

afterEach(() => {
  _resetCodexAppServersForTesting();
  _resetAcpPermissionsForTesting();
  rmSync(dir, { recursive: true, force: true });
});

const heartbeats = (postHeartbeat: ReturnType<typeof vi.fn>): string[] => postHeartbeat.mock.calls.map(c => c[2] as string);

describe('codexInteractivePermissions (O4 default flip)', () => {
  it('defaults ON when the setting is absent; explicit false opts out', () => {
    expect(codexInteractivePermissions(dataDir)).toBe(true);
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ codex_interactive_permissions: false }), 'utf-8');
    expect(codexInteractivePermissions(dataDir)).toBe(false);
  });
});

describe('spawnCodexAppServerRun — boot + first turn', () => {
  it('spawns `codex app-server` in the project dir with the HS-9380 drive marker, starts a thread, persists it, runs the turn, and goes idle+done on completion', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const postHeartbeat = vi.fn();
    const signalDone = vi.fn();
    expect(spawnCodexAppServerRun(dataDir, 4174, 'process the worklist', { spawnFn: fake.spawnFn, postHeartbeat, signalDone })).toBe(true);
    await flush();

    expect(fake.spawned.command).toBe('codex');
    expect(fake.spawned.args).toEqual(['app-server']);
    expect(fake.spawned.cwd).toBe(dir); // <root>/.hotsheet → <root>
    expect(fake.spawned.env?.HOTSHEET_DRIVE_SPAWNED).toBe('1');

    // Handshake: initialize → initialized notification → thread/start (no persisted id).
    expect(fake.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(readPersistedThreadId(dataDir)).toBe('th-1');
    const turnStart = fake.sent.find(m => m.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({ threadId: 'th-1', input: [{ type: 'text', text: 'process the worklist' }] });

    // Busy from the click; done only after turn/completed.
    expect(heartbeats(postHeartbeat)).toContain('busy');
    expect(signalDone).not.toHaveBeenCalled();
    fake.completeTurn('turn-1');
    await flush();
    expect(heartbeats(postHeartbeat)).toContain('idle');
    expect(signalDone).toHaveBeenCalledWith(dataDir, 4174);
  });

  it('resumes the persisted thread (no thread/start) when the rollout exists', async () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-old' }), 'utf-8');
    const fake = scriptedAppServer({ resumable: ['th-old'] });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(fake.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('th-old');
  });

  it('O3 — falls back to a fresh thread/start when resume fails (missing rollout) and re-persists', async () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-gone' }), 'utf-8');
    const fake = scriptedAppServer({ resumable: [], newThreadId: 'th-fresh' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(fake.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/start', 'turn/start']);
    expect(readPersistedThreadId(dataDir)).toBe('th-fresh');
  });
});

describe('O1 — queue + coalesce', () => {
  it('coalesces identical prompts while a turn runs; distinct prompts run FIFO; done fires only when the queue drains', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const postHeartbeat = vi.fn();
    const signalDone = vi.fn();
    const deps = { spawnFn: fake.spawnFn, postHeartbeat, signalDone };
    spawnCodexAppServerRun(dataDir, 4174, 'worklist trigger', deps);
    await flush(); // turn 1 running

    // Two more identical plays + one distinct custom prompt while busy.
    spawnCodexAppServerRun(dataDir, 4174, 'worklist trigger', deps);
    spawnCodexAppServerRun(dataDir, 4174, 'worklist trigger', deps);
    spawnCodexAppServerRun(dataDir, 4174, 'custom: fix the tests', deps);
    await flush();
    expect(fake.sent.filter(m => m.method === 'turn/start')).toHaveLength(1); // still just turn 1

    fake.completeTurn('turn-1');
    await flush();
    // The coalesced worklist trigger runs ONCE as turn 2, done not yet signaled.
    const turnStarts = fake.sent.filter(m => m.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect((turnStarts[1].params as { input: { text: string }[] }).input[0].text).toBe('worklist trigger');
    expect(signalDone).not.toHaveBeenCalled();

    fake.completeTurn('turn-2');
    await flush();
    // The distinct custom prompt runs as turn 3.
    const turnStarts3 = fake.sent.filter(m => m.method === 'turn/start');
    expect(turnStarts3).toHaveLength(3);
    expect((turnStarts3[2].params as { input: { text: string }[] }).input[0].text).toBe('custom: fix the tests');
    expect(signalDone).not.toHaveBeenCalled();

    fake.completeTurn('turn-3');
    await flush();
    expect(signalDone).toHaveBeenCalledTimes(1); // only after the queue drained
  });
});

describe('approvals → §47 overlay bridge', () => {
  const CAPTURED_APPROVAL = {
    jsonrpc: '2.0',
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'th-1', turnId: 'turn-1', itemId: 'exec-1',
      command: "/bin/zsh -lc 'touch ~/.escape && echo ok'",
      cwd: '/tmp/p',
      availableDecisions: ['accept', 'cancel'],
    },
  };

  it('surfaces the captured approval in the bridge and forwards the chosen decision', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();

    fake.emit(CAPTURED_APPROVAL);
    await flush();
    const secret = getProjectSecret(dataDir);
    const pending = pendingAcpPermissionForSecret(secret);
    expect(pending).not.toBeNull();
    expect(pending?.tool_name).toBe('Codex: Shell command');
    expect(pending?.input_preview).toContain('touch ~/.escape');

    resolveAcpPermission(pending!.request_id, { optionId: 'accept' });
    await flush();
    const reply = fake.sent.find(m => m.id === 'approval-1');
    expect(reply?.result).toEqual({ decision: 'accept' });
  });

  it('a dismissed popup declines', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit(CAPTURED_APPROVAL);
    await flush();
    const pending = pendingAcpPermissionForSecret(getProjectSecret(dataDir));
    resolveAcpPermission(pending!.request_id, { cancelled: true });
    await flush();
    expect(fake.sent.find(m => m.id === 'approval-1')?.result).toEqual({ decision: 'decline' });
  });

  it('O4 opt-out (`codex_interactive_permissions: false`) auto-approves without a popup', async () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'codex', codex_interactive_permissions: false }), 'utf-8');
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit(CAPTURED_APPROVAL);
    await flush();
    expect(pendingAcpPermissionForSecret(getProjectSecret(dataDir))).toBeNull();
    expect(fake.sent.find(m => m.id === 'approval-1')?.result).toEqual({ decision: 'accept' });
  });

  it('a matching permission_allow_rules rule auto-allows without a popup (HS-9346 parity)', async () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      ai_tool: 'codex',
      permission_allow_rules: [{ id: 'r1', tool: 'Bash', pattern: '/bin/zsh -lc .*', added_at: '2026-07-23T00:00:00.000Z' }],
    }), 'utf-8');
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit(CAPTURED_APPROVAL);
    await flush();
    expect(pendingAcpPermissionForSecret(getProjectSecret(dataDir))).toBeNull();
    expect(fake.sent.find(m => m.id === 'approval-1')?.result).toEqual({ decision: 'accept' });
  });

  it('answers non-approval server requests with an empty result so the agent never hangs', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit({ jsonrpc: '2.0', id: 'other-1', method: 'item/tool/requestUserInput', params: {} });
    await flush();
    expect(fake.sent.find(m => m.id === 'other-1')?.result).toEqual({});
  });
});

describe('interrupt + crash', () => {
  it('interruptCodexAppServerTurn sends turn/interrupt {threadId, turnId} and clears the queue', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const deps = { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() };
    spawnCodexAppServerRun(dataDir, 4174, 'go', deps);
    await flush(); // turn-1 active
    spawnCodexAppServerRun(dataDir, 4174, 'queued extra', deps);

    expect(interruptCodexAppServerTurn(dataDir)).toBe(true);
    await flush();
    const intr = fake.sent.find(m => m.method === 'turn/interrupt');
    expect(intr?.params).toEqual({ threadId: 'th-1', turnId: 'turn-1' });

    // The interrupted turn ends; the cleared queue means idle + done, no extra turn.
    fake.completeTurn('turn-1', 'interrupted');
    await flush();
    expect(fake.sent.filter(m => m.method === 'turn/start')).toHaveLength(1);
    expect(deps.signalDone).toHaveBeenCalledTimes(1);
  });

  it('returns false with no active turn', () => {
    expect(interruptCodexAppServerTurn(dataDir)).toBe(false);
  });

  it('a crash mid-turn clears busy + signals done, and the next play respawns', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const postHeartbeat = vi.fn();
    const signalDone = vi.fn();
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat, signalDone });
    await flush(); // turn active

    fake.proc.emit('exit', 1, null);
    await flush();
    expect(heartbeats(postHeartbeat)).toContain('idle');
    expect(signalDone).toHaveBeenCalledTimes(1);

    // Lazy respawn on the next play — a NEW child (resume of the persisted thread).
    const fake2 = scriptedAppServer({ resumable: ['th-1'] });
    expect(spawnCodexAppServerRun(dataDir, 4174, 'again', { spawnFn: fake2.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() })).toBe(true);
    await flush();
    expect(fake2.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
  });

  it('readPersistedThreadId returns null on a corrupt state file', () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), 'not json', 'utf-8');
    expect(readPersistedThreadId(dataDir)).toBeNull();
  });
});

describe('HS-9384 — Experimental toggle + handshake-failure degradation', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
    clearCodexAppServerFailures();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('isCodexAppServerEnabled defaults ON (absent) and honors an explicit false', () => {
    expect(isCodexAppServerEnabled()).toBe(true);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
    expect(isCodexAppServerEnabled()).toBe(false);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: true }), 'utf-8');
    expect(isCodexAppServerEnabled()).toBe(true);
  });

  it('spawnCodexAppServerRun refuses to spawn when the toggle is off (no one-shot fallback)', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
    const fake = scriptedAppServer();
    expect(spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() })).toBe(false);
    expect(fake.spawnFn).not.toHaveBeenCalled();
  });

  it('a failed initialize marks the project handshake-failed, clears busy; clearing the flag retries fresh', async () => {
    // A fake that ERRORS the initialize handshake.
    const stdout = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), {
      stdin: {
        write: (s: string) => {
          const msg = JSON.parse(s) as { id?: unknown; method?: string };
          if (msg.method === 'initialize') {
            stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'unsupported protocol' } }) + '\n'));
          }
        },
      },
      stdout,
      kill: vi.fn(),
    });
    const spawnFn = vi.fn<SpawnFn>(() => proc as unknown as ChildProcess);
    const postHeartbeat = vi.fn();
    const signalDone = vi.fn();
    expect(spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn, postHeartbeat, signalDone })).toBe(true);
    await flush();
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(true);
    expect(heartbeats(postHeartbeat)).toContain('idle'); // busy can't stick
    expect(signalDone).toHaveBeenCalled();

    clearCodexAppServerFailures(); // the toggle re-enable path
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(false);
  });

  it('a healthy boot clears a stale handshake-failure flag', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    // Simulate a prior failure, then a successful boot.
    const stdoutFail = new EventEmitter();
    const failProc = Object.assign(new EventEmitter(), {
      stdin: { write: (s: string) => {
        const msg = JSON.parse(s) as { id?: unknown; method?: string };
        if (msg.method === 'initialize') stdoutFail.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'nope' } }) + '\n'));
      } },
      stdout: stdoutFail, kill: vi.fn(),
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: vi.fn<SpawnFn>(() => failProc as unknown as ChildProcess), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(true);

    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(false);
  });
});
