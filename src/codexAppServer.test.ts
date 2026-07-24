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
  codexTerminalAttachCommand,
  codexTerminalNeedsDaemonEnsure,
  codexTerminalRemoteCommand,
  hasCodexAppServerHandshakeFailed,
  interruptCodexAppServerTurn,
  isCodexAppServerEnabled,
  prestartCodexDaemonIfNeeded,
  readPersistedCodexThread,
  readPersistedThreadId,
  shutdownCodexAppServers,
  spawnCodexAppServerRun,
} from './codexAppServer.js';
import { codexDaemonSocketPath, type CodexTransportHandlers } from './codexDaemonTransport.js';
import { getProjectSecret } from './secret-file.js';
import { resolveTerminalCommand } from './terminals/resolveCommand.js';

type SpawnFn = NonNullable<CodexAppServerDeps['spawnFn']>;

/** HS-9388 — force the stdio fallback path (no daemon in unit tests). */
const noDaemon = (): Promise<null> => Promise.resolve(null);

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
function scriptedAppServer(opts: {
  resumable?: string[];
  newThreadId?: string;
  newThreadPath?: string;
  resumePath?: string;
  // HS-9428/HS-9431 — model-B discovery: live thread ids (thread/loaded/list) +
  // per-thread cwd/recency served by thread/read (keyed by id).
  loaded?: string[];
  threads?: { id: string; cwd: string; recencyAt?: number }[];
} = {}): FakeServer {
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
        emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id, ...(opts.resumePath !== undefined ? { path: opts.resumePath } : {}) } } });
      } else {
        emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${String(id)}` } });
      }
    } else if (msg.method === 'thread/start') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: opts.newThreadId ?? 'th-new', ...(opts.newThreadPath !== undefined ? { path: opts.newThreadPath } : {}) } } });
    } else if (msg.method === 'turn/start') {
      turnCounter += 1;
      const turnId = `turn-${String(turnCounter)}`;
      emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      emit({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: turnId, status: 'inProgress' } } });
    } else if (msg.method === 'turn/interrupt') {
      emit({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'thread/loaded/list') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { data: opts.loaded ?? [], nextCursor: null } });
    } else if (msg.method === 'thread/read') {
      const id = (msg.params as { threadId?: string } | undefined)?.threadId;
      const t = (opts.threads ?? []).find(x => x.id === id);
      if (t !== undefined) emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: t.id, cwd: t.cwd, recencyAt: t.recencyAt ?? 0 } } });
      else emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: `no such thread ${String(id)}` } });
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
    expect(spawnCodexAppServerRun(dataDir, 4174, 'process the worklist', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat, signalDone })).toBe(true);
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(fake.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('th-old');
  });

  it('O3 — falls back to a fresh thread/start when resume fails (missing rollout) and re-persists', async () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-gone' }), 'utf-8');
    const fake = scriptedAppServer({ resumable: [], newThreadId: 'th-fresh' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
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
    const deps = { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat, signalDone };
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit(CAPTURED_APPROVAL);
    await flush();
    expect(pendingAcpPermissionForSecret(getProjectSecret(dataDir))).toBeNull();
    expect(fake.sent.find(m => m.id === 'approval-1')?.result).toEqual({ decision: 'accept' });
  });

  it('answers non-approval server requests with an empty result so the agent never hangs', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit({ jsonrpc: '2.0', id: 'other-1', method: 'item/tool/requestUserInput', params: {} });
    await flush();
    expect(fake.sent.find(m => m.id === 'other-1')?.result).toEqual({});
  });
});

describe('interrupt + crash', () => {
  it('interruptCodexAppServerTurn sends turn/interrupt {threadId, turnId} and clears the queue', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const deps = { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() };
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat, signalDone });
    await flush(); // turn active

    fake.proc.emit('exit', 1, null);
    await flush();
    expect(heartbeats(postHeartbeat)).toContain('idle');
    expect(signalDone).toHaveBeenCalledTimes(1);

    // Lazy respawn on the next play — a NEW child (resume of the persisted thread).
    const fake2 = scriptedAppServer({ resumable: ['th-1'] });
    expect(spawnCodexAppServerRun(dataDir, 4174, 'again', { spawnFn: fake2.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() })).toBe(true);
    await flush();
    expect(fake2.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
  });

  it('readPersistedThreadId returns null on a corrupt state file', () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), 'not json', 'utf-8');
    expect(readPersistedThreadId(dataDir)).toBeNull();
  });
});

describe('HS-9385 — transcript events', () => {
  it('posts start on turn/started, item lines for completed items, and end with the terminal status', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const postTranscript = vi.fn();
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn(), postTranscript });
    await flush(); // turn-1 started

    fake.emit({ jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'agentMessage', text: 'working on it', phase: 'commentary' }, threadId: 'th-1' } });
    fake.emit({ jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'reasoning' }, threadId: 'th-1' } }); // skipped
    fake.completeTurn('turn-1', 'completed');
    await flush();

    const events = postTranscript.mock.calls.map(c => c[2] as { phase: string; turnId: string; text?: string; status?: string });
    expect(events[0]).toEqual({ phase: 'start', turnId: 'turn-1' });
    expect(events[1]).toEqual({ phase: 'item', turnId: 'turn-1', text: 'working on it' });
    expect(events[2]).toEqual({ phase: 'end', turnId: 'turn-1', status: 'completed' });
    expect(events).toHaveLength(3); // the reasoning item produced no event
    expect(postTranscript.mock.calls.every(c => c[0] === 4174 && c[1] === getProjectSecret(dataDir))).toBe(true);
  });

  it('an interrupted turn ends the transcript with its status', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    const postTranscript = vi.fn();
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn(), postTranscript });
    await flush();
    fake.completeTurn('turn-1', 'interrupted');
    await flush();
    const end = postTranscript.mock.calls.map(c => c[2] as { phase: string; status?: string }).find(e => e.phase === 'end');
    expect(end?.status).toBe('interrupted');
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
    expect(spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() })).toBe(false);
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
    expect(spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn, connectDaemon: noDaemon, postHeartbeat, signalDone })).toBe(true);
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
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: vi.fn<SpawnFn>(() => failProc as unknown as ChildProcess), connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(true);

    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(false);
  });
});

describe('HS-9388 — daemon transport', () => {
  /** Wrap a scripted fake app-server as a DAEMON transport (UDS-WS stand-in):
   *  same responder, no child process. `closeSpy` observes teardown. */
  function daemonize(fake: FakeServer): { connectDaemon: NonNullable<CodexAppServerDeps['connectDaemon']>; closeSpy: ReturnType<typeof vi.fn> } {
    const closeSpy = vi.fn();
    const connectDaemon = (h: CodexTransportHandlers): Promise<{ kind: 'daemon'; send: (json: string) => void; close: () => void }> => {
      fake.proc.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line.trim() !== '') h.onMessage(line);
      });
      return Promise.resolve({ kind: 'daemon' as const, send: (json: string) => { fake.proc.stdin.write(json); }, close: closeSpy });
    };
    return { connectDaemon, closeSpy };
  }

  it('prefers the daemon: no stdio child, and thread/start pins the project MCP server per-thread (abs --data-dir + drive marker)', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-d' });
    const { connectDaemon } = daemonize(fake);
    const postHeartbeat = vi.fn();
    const signalDone = vi.fn();
    expect(spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon, postHeartbeat, signalDone })).toBe(true);
    await flush();

    expect(fake.spawnFn).not.toHaveBeenCalled(); // daemon won — no private child
    const start = fake.sent.find(m => m.method === 'thread/start');
    expect(start?.params?.cwd).toBe(dir);
    const override = (start?.params?.config as { mcp_servers?: Record<string, { args?: string[]; env?: Record<string, string> }> } | undefined)?.mcp_servers?.['hotsheet-channel'];
    expect(override?.args?.slice(-2)).toEqual(['--data-dir', dataDir]);
    expect(override?.env).toEqual({ HOTSHEET_DRIVE_SPAWNED: '1' });

    fake.completeTurn('turn-1');
    await flush();
    expect(signalDone).toHaveBeenCalledTimes(1);
    expect(readPersistedThreadId(dataDir)).toBe('th-d');
  });

  it('thread/resume carries the per-thread override too', async () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-r' }), 'utf-8');
    const fake = scriptedAppServer({ resumable: ['th-r'] });
    const { connectDaemon } = daemonize(fake);
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const resume = fake.sent.find(m => m.method === 'thread/resume');
    const override = (resume?.params?.config as { mcp_servers?: Record<string, unknown> } | undefined)?.mcp_servers;
    expect(override).toHaveProperty('hotsheet-channel');
  });

  it('the stdio fallback does NOT send a config override (global codex config already applies)', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-s' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const start = fake.sent.find(m => m.method === 'thread/start');
    expect(start?.params).not.toHaveProperty('config');
  });

  it('ignores notifications about OTHER threads on the shared connection', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-d' });
    const { connectDaemon } = daemonize(fake);
    const signalDone = vi.fn();
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon, postHeartbeat: vi.fn(), signalDone });
    await flush(); // our turn-1 active

    // A broadcast about someone else's thread must not end OUR turn.
    fake.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-foreign', turn: { id: 'x', status: 'completed' } } });
    await flush();
    expect(signalDone).not.toHaveBeenCalled();

    fake.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-d', turn: { id: 'turn-1', status: 'completed' } } });
    await flush();
    expect(signalDone).toHaveBeenCalledTimes(1);
  });

  it("a shared-thread turn we did NOT start (an attached TUI's) streams to the transcript but never drives done", async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-d' });
    const { connectDaemon } = daemonize(fake);
    const signalDone = vi.fn();
    const postTranscript = vi.fn();
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon, postHeartbeat: vi.fn(), signalDone, postTranscript });
    await flush();
    fake.completeTurn('turn-1');
    await flush();
    expect(signalDone).toHaveBeenCalledTimes(1); // our own turn — baseline

    // HS-9394 scenario: a user-attached `codex --remote` TUI runs a turn on the SAME thread.
    fake.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th-d', turn: { id: 'tui-turn', status: 'inProgress' } } });
    fake.emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-d', item: { type: 'agentMessage', text: 'tui says hi' } } });
    fake.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-d', turn: { id: 'tui-turn', status: 'completed' } } });
    await flush();
    expect(postTranscript.mock.calls.map(c => (c[2] as { phase: string }).phase)).toContain('item');
    expect(postTranscript.mock.calls.some(c => (c[2] as { text?: string }).text === 'tui says hi')).toBe(true);
    expect(signalDone).toHaveBeenCalledTimes(1); // unchanged — not our turn
  });

  it('shutdown closes OUR daemon connection (the shared daemon itself is not killed)', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-d' });
    const { connectDaemon, closeSpy } = daemonize(fake);
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    shutdownCodexAppServers();
    expect(closeSpy).toHaveBeenCalled();
    expect(fake.proc.kill).not.toHaveBeenCalled();
  });

  it('a rejecting daemon connect marks the project handshake-failed (no zombie session)', async () => {
    const fake = scriptedAppServer();
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: () => Promise.reject(new Error('boom')), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(hasCodexAppServerHandshakeFailed(dataDir)).toBe(true);
  });
});

describe('HS-9428 — model-B: drive discovers + joins the terminal\'s live thread by cwd', () => {
  function daemonize(fake: FakeServer): NonNullable<CodexAppServerDeps['connectDaemon']> {
    return (h: CodexTransportHandlers): Promise<{ kind: 'daemon'; send: (json: string) => void; close: () => void }> => {
      fake.proc.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line.trim() !== '') h.onMessage(line);
      });
      return Promise.resolve({ kind: 'daemon' as const, send: (json: string) => { fake.proc.stdin.write(json); }, close: vi.fn() });
    };
  }
  afterEach(() => vi.unstubAllEnvs());

  it('joins the discovered live thread (thread/resume, no thread/start) when discovery is on + daemon + a loaded thread matches the cwd', async () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    const fake = scriptedAppServer({
      loaded: ['disc-1'],
      threads: [{ id: 'disc-1', cwd: dir, recencyAt: 5 }], // dir = dirname(dataDir), the project cwd
      resumable: ['disc-1'],
      resumePath: '/sessions/disc-1.jsonl',
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();

    const methods = fake.sent.map(m => m.method);
    expect(methods).toContain('thread/loaded/list');
    expect(methods).toContain('thread/read');
    expect(methods).toContain('thread/resume');
    expect(methods).not.toContain('thread/start'); // joined an existing thread — did NOT create one
    expect(fake.sent.find(m => m.method === 'thread/resume')?.params?.threadId).toBe('disc-1');
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('disc-1');
    expect(readPersistedThreadId(dataDir)).toBe('disc-1');
  });

  it('falls back to model-A (thread/start) when discovery is on but nothing is loaded — and short-circuits before thread/read', async () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    const fake = scriptedAppServer({ loaded: [], newThreadId: 'th-a' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();

    const methods = fake.sent.map(m => m.method);
    expect(methods).toContain('thread/loaded/list');
    expect(methods).not.toContain('thread/read'); // empty loaded set → no point reading
    expect(methods).toContain('thread/start');
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('th-a');
  });

  it('falls back to model-A when a loaded thread exists but none matches our cwd', async () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    const fake = scriptedAppServer({
      loaded: ['other'],
      threads: [{ id: 'other', cwd: '/some/other/project', recencyAt: 9 }],
      newThreadId: 'th-a',
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const methods = fake.sent.map(m => m.method);
    expect(methods).toContain('thread/read'); // read the loaded thread, saw a different cwd
    expect(methods).not.toContain('thread/resume');
    expect(methods).toContain('thread/start');
  });

  it('never attempts discovery on the stdio transport (no shared thread to join) even with the flag on', async () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    const fake = scriptedAppServer({ loaded: ['x'], threads: [{ id: 'x', cwd: dir }], newThreadId: 'th-a' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const methods = fake.sent.map(m => m.method);
    expect(methods).not.toContain('thread/loaded/list');
    expect(methods).toContain('thread/start');
  });

  it('does nothing new when the flag is off (default): no discovery calls, model-A as before', async () => {
    const fake = scriptedAppServer({ loaded: ['x'], threads: [{ id: 'x', cwd: dir }], newThreadId: 'th-a' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const methods = fake.sent.map(m => m.method);
    expect(methods).not.toContain('thread/loaded/list');
    expect(methods).not.toContain('thread/read');
    expect(methods).toContain('thread/start');
  });
});

describe('HS-9395 — MCP tool-call elicitations', () => {
  const elicitParams = (serverName: string): Record<string, unknown> => ({
    threadId: 'th-1',
    turnId: 'turn-1',
    serverName,
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { id: 9388 } },
    message: `Allow the ${serverName} MCP server to run tool "hotsheet_get_ticket"?`,
    requestedSchema: { type: 'object', properties: {} },
  });

  it("auto-accepts hotsheet's own MCP server with the REQUIRED {action, content} shape (the old {} reply read as a decline)", async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit({ jsonrpc: '2.0', id: 'elicit-1', method: 'mcpServer/elicitation/request', params: elicitParams('hotsheet-channel') });
    await flush();
    expect(fake.sent.find(m => m.id === 'elicit-1')?.result).toEqual({ action: 'accept', content: {} });
    // No popup was rendered for our own control surface.
    expect(pendingAcpPermissionForSecret(getProjectSecret(dataDir))).toBeNull();
  });

  it("routes OTHER servers' elicitations to the §47 overlay; an accepted popup accepts, a dismissed one declines", async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const secret = getProjectSecret(dataDir);

    fake.emit({ jsonrpc: '2.0', id: 'elicit-2', method: 'mcpServer/elicitation/request', params: elicitParams('some-other-server') });
    await flush();
    const pending = pendingAcpPermissionForSecret(secret);
    expect(pending).not.toBeNull();
    expect(pending?.tool_name).toBe('Codex: MCP tool (hotsheet_get_ticket)');
    resolveAcpPermission(pending!.request_id, { optionId: 'accept' });
    await flush();
    expect(fake.sent.find(m => m.id === 'elicit-2')?.result).toEqual({ action: 'accept', content: {} });

    fake.emit({ jsonrpc: '2.0', id: 'elicit-3', method: 'mcpServer/elicitation/request', params: elicitParams('some-other-server') });
    await flush();
    const pending3 = pendingAcpPermissionForSecret(secret);
    resolveAcpPermission(pending3!.request_id, { cancelled: true });
    await flush();
    expect(fake.sent.find(m => m.id === 'elicit-3')?.result).toEqual({ action: 'decline' });
  });

  it('auto-accepts ANY server when interactive permissions are explicitly off (O4 opt-out)', async () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'codex', codex_interactive_permissions: false }), 'utf-8');
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    fake.emit({ jsonrpc: '2.0', id: 'elicit-4', method: 'mcpServer/elicitation/request', params: elicitParams('some-other-server') });
    await flush();
    expect(fake.sent.find(m => m.id === 'elicit-4')?.result).toEqual({ action: 'accept', content: {} });
  });
});

describe('HS-9394 — persisted rollout path + terminal attach command', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('persists the rollout path from a thread/start response; readPersistedCodexThread reads both fields', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1', newThreadPath: '/sessions/rollout-th-1.jsonl' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(readPersistedCodexThread(dataDir)).toEqual({ threadId: 'th-1', rolloutPath: '/sessions/rollout-th-1.jsonl' });
    expect(readPersistedThreadId(dataDir)).toBe('th-1');
  });

  it('backfills the rollout path on resume (pre-9394 state files carry only the thread id)', async () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-old' }), 'utf-8');
    const fake = scriptedAppServer({ resumable: ['th-old'], resumePath: '/sessions/rollout-th-old.jsonl' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(readPersistedCodexThread(dataDir)).toEqual({ threadId: 'th-old', rolloutPath: '/sessions/rollout-th-old.jsonl' });
  });

  describe('codexTerminalAttachCommand', () => {
    const writeState = (rolloutPath?: string): void => {
      writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-a', ...(rolloutPath !== undefined ? { rolloutPath } : {}) }), 'utf-8');
    };
    const allExist = (): boolean => true;

    it('builds the resume --remote command (quoted socket URL) when drive on, rollout exists, and the daemon socket is up', () => {
      writeState('/sessions/r.jsonl');
      expect(codexTerminalAttachCommand(dataDir, { fileExists: allExist, socketPath: '/tmp/a b/s.sock' }))
        .toBe("codex resume th-a --remote 'unix:///tmp/a b/s.sock'");
    });

    it('returns null when the drive toggle is off', () => {
      writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
      writeState('/sessions/r.jsonl');
      expect(codexTerminalAttachCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
    });

    it('returns null with no persisted thread, no rollout path, or a rollout that does not exist yet', () => {
      expect(codexTerminalAttachCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
      writeState(); // thread id only (pre-9394 file)
      expect(codexTerminalAttachCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
      writeState('/sessions/r.jsonl'); // rollout persisted but not on disk (no turn yet)
      expect(codexTerminalAttachCommand(dataDir, { fileExists: (p) => p === '/s.sock', socketPath: '/s.sock' })).toBeNull();
    });

    it('returns null when no daemon socket exists and no live session is up', () => {
      writeState('/sessions/r.jsonl');
      expect(codexTerminalAttachCommand(dataDir, { fileExists: (p) => p !== '/s.sock', socketPath: '/s.sock' })).toBeNull();
    });

    it('a live STDIO session vetoes the attach (its private core owns the rollout)', async () => {
      const fake = scriptedAppServer({ newThreadId: 'th-a', newThreadPath: '/sessions/r.jsonl' });
      spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
      await flush();
      expect(codexTerminalAttachCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
    });

    it('a live DAEMON session allows the attach even if the socket-exists probe would fail', async () => {
      const fake = scriptedAppServer({ newThreadId: 'th-a', newThreadPath: '/sessions/r.jsonl' });
      const closeSpy = vi.fn();
      const connectDaemon = (h: CodexTransportHandlers): Promise<{ kind: 'daemon'; send: (json: string) => void; close: () => void }> => {
        fake.proc.stdout.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) if (line.trim() !== '') h.onMessage(line);
        });
        return Promise.resolve({ kind: 'daemon' as const, send: (json: string) => { fake.proc.stdin.write(json); }, close: closeSpy });
      };
      spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
      await flush();
      expect(codexTerminalAttachCommand(dataDir, { fileExists: (p) => p !== '/s.sock', socketPath: '/s.sock' }))
        .toBe("codex resume th-a --remote 'unix:///s.sock'");
    });
  });
});

// HS-9403 — the END-TO-END seam the maintainer hit: a user-created `{{aiCommand}}`
// terminal (ai_tool=codex) resolving through the REAL `codexTerminalAttachCommand`
// (no injected `codexAttachOverride` / `socketPath` / `fileExists`), driven by real
// on-disk state (persisted thread + a rollout file that actually exists) and a real
// codex app-server session. The prior HS-9394 tests all injected the attach
// resolver, so this integration path — where the bug actually lives — was untested.
describe('HS-9403 — {{aiCommand}} terminal resolves the codex attach end-to-end', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** Persist a real thread + on-disk rollout via a live session (the "attach will
   *  work" precondition). `connect` picks the transport: a daemon transport allows
   *  the attach, `noDaemon` forces the stdio fallback that vetoes it. */
  const seedLiveSession = async (mode: 'daemon' | 'stdio'): Promise<void> => {
    const rolloutPath = join(dir, 'rollout-th-a.jsonl');
    writeFileSync(rolloutPath, '{}', 'utf-8'); // on-disk existence = the attach signal
    const fake = scriptedAppServer({ newThreadId: 'th-a', newThreadPath: rolloutPath });
    const connect: CodexAppServerDeps['connectDaemon'] = mode === 'stdio'
      ? noDaemon
      : (h: CodexTransportHandlers) => {
          // Wire the scripted child's stdout into the daemon handlers so boot completes.
          fake.proc.stdout.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString().split('\n')) if (line.trim() !== '') h.onMessage(line);
          });
          return Promise.resolve({ kind: 'daemon' as const, send: (json: string) => { fake.proc.stdin.write(json); }, close: vi.fn() });
        };
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: connect, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    // Confirm the precondition the resolver depends on is really on disk.
    expect(readPersistedCodexThread(dataDir)).toEqual({ threadId: 'th-a', rolloutPath });
  };

  const resolveAiTerminal = (): string => resolveTerminalCommand({
    dataDir,
    configOverride: { id: 'ai', command: '{{aiCommand}}' },
    aiToolOverride: 'codex',
    isAiToolOnPath: (b) => b === 'codex', // codex "on PATH" — environmental, not the bug
  }).command;

  it('resolves to `codex resume … --remote unix://<real socket>` when the drive runs on the DAEMON', async () => {
    // A daemon-transport session is live → the attach is allowed even though the real
    // daemon socket file doesn't exist in the test (the live-daemon branch of
    // codexTerminalAttachCommand bypasses the socket-exists probe). This exercises
    // the REAL codexTerminalAttachCommand through resolveTerminalCommand — no
    // injected attach override — which is the seam the HS-9394 tests never covered.
    await seedLiveSession('daemon');
    expect(resolveAiTerminal()).toBe(`codex resume th-a --remote 'unix://${codexDaemonSocketPath()}'`);
  });

  it('resolves to PLAIN `codex` when the drive runs on STDIO — the attach is vetoed by design (two cores cannot share one rollout)', async () => {
    // The maintainer-visible symptom when the shared daemon is NOT available: the
    // drive falls back to a private stdio child that OWNS the rollout, so the terminal
    // correctly launches plain `codex` and driven work never appears in it. This is
    // intended behavior — the fix for that case is daemon availability, not the
    // resolution (see the completion note / docs/123 §123.7).
    await seedLiveSession('stdio');
    expect(resolveAiTerminal()).toBe('codex');
  });
});

describe('HS-9429 — codexTerminalRemoteCommand + codexTerminalNeedsDaemonEnsure (model-B)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  const allExist = (): boolean => true;
  const noneExist = (): boolean => false;

  describe('codexTerminalRemoteCommand', () => {
    it('builds `codex --remote unix://<sock> -C <projectDir>` when the gate is on + the daemon socket is up', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      // dataDir = <dir>/.hotsheet → projectDir = dir
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: allExist, socketPath: '/tmp/a b/s.sock' }))
        .toBe(`codex --remote 'unix:///tmp/a b/s.sock' -C '${dir}'`);
    });

    it('returns null when the gate is OFF (default — pre-Phase-3)', () => {
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
    });

    it('returns null when the daemon socket is not up (→ plain codex fallback)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: noneExist, socketPath: '/s.sock' })).toBeNull();
    });

    it('returns null when the drive toggle is off', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
    });
  });

  describe('codexTerminalNeedsDaemonEnsure', () => {
    it('true only when gate on + ai_tool=codex + socket NOT up (the cold case)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1'); // dataDir settings.json has ai_tool: codex
      expect(codexTerminalNeedsDaemonEnsure(dataDir, { fileExists: noneExist, socketPath: '/s.sock' })).toBe(true);
    });

    it('false when the daemon socket is already up (spawn stays synchronous)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      expect(codexTerminalNeedsDaemonEnsure(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBe(false);
    });

    it('false when the gate is off', () => {
      expect(codexTerminalNeedsDaemonEnsure(dataDir, { fileExists: noneExist, socketPath: '/s.sock' })).toBe(false);
    });

    it('false for a non-codex project even with the gate on', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'claude' }), 'utf-8');
      expect(codexTerminalNeedsDaemonEnsure(dataDir, { fileExists: noneExist, socketPath: '/s.sock' })).toBe(false);
    });
  });
});

describe('HS-9396 — prestartCodexDaemonIfNeeded', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const withRollout = (): void => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-a', rolloutPath: '/sessions/r.jsonl' }), 'utf-8');
  };

  it('starts the daemon when codex + drive on + rollout on disk + socket missing', async () => {
    withRollout();
    const ensureDaemon = vi.fn().mockResolvedValue(true);
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    await flush();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the socket is already up', () => {
    withRollout();
    const ensureDaemon = vi.fn();
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: () => true });
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it('no-ops for non-codex projects, when the drive is off, or without a resumable rollout', () => {
    const ensureDaemon = vi.fn();
    // no state file at all
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    // rollout persisted but missing on disk
    withRollout();
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: () => false });
    // non-codex tool
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'gemini' }), 'utf-8');
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    // drive toggle off
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'codex' }), 'utf-8');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it('a rejecting ensure never throws out of the fire-and-forget path', async () => {
    withRollout();
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon: () => Promise.reject(new Error('boom')), socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    await flush(); // unhandled rejection would fail the test run
  });
});
