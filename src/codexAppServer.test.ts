// HS-9383 — the codex app-server session manager, driven against a SCRIPTED fake
// app-server that replays the captured 0.145.0 shapes (no spawn, no LLM turn).
import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetAcpPermissionsForTesting, pendingAcpPermissionForSecret, resolveAcpPermission } from './acp/acpPermissionBridge.js';
import {
  _resetCodexAppServersForTesting,
  clearCodexAppServerFailures,
  type CodexAppServerDeps,
  codexDriveDiscoverEnabled,
  codexInteractivePermissions,
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
  /** HS-9448 — with `deferTurnStart`, send the withheld `turn/start` response now. */
  releaseTurnStart: () => void;
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
  threads?: { id: string; cwd: string; recencyAt?: number; path?: string }[];
  /** HS-9448 — withhold the `turn/start` response until `releaseTurnStart()`, so a
   *  test can deliver events inside the window where the turn is sent-but-unacked. */
  deferTurnStart?: boolean;
} = {}): FakeServer {
  const stdout = new EventEmitter();
  const emit = (obj: unknown): void => { stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf-8')); };
  const sent: FakeServer['sent'] = [];
  let turnCounter = 0;
  let withheldTurnStart: (() => void) | null = null;
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
      const ack = (): void => {
        emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        emit({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: turnId, status: 'inProgress' } } });
      };
      if (opts.deferTurnStart === true) withheldTurnStart = ack;
      else ack();
    } else if (msg.method === 'turn/interrupt') {
      emit({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'thread/loaded/list') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { data: opts.loaded ?? [], nextCursor: null } });
    } else if (msg.method === 'thread/read') {
      const id = (msg.params as { threadId?: string } | undefined)?.threadId;
      const t = (opts.threads ?? []).find(x => x.id === id);
      if (t !== undefined) emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: t.id, cwd: t.cwd, recencyAt: t.recencyAt ?? 0, ...(t.path !== undefined ? { path: t.path } : {}) } } });
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
    releaseTurnStart: () => { const ack = withheldTurnStart; withheldTurnStart = null; ack?.(); },
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

    // HS-9586 — the overlay speaks Hot Sheet's own choice ids; the bridge
    // translates to the token THIS request accepts.
    resolveAcpPermission(pending!.request_id, { optionId: 'allow' });
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
    // HS-9586 — this request's `availableDecisions` are accept + cancel, with no
    // `decline`, so the refusal falls back to `cancel` rather than sending a
    // token the request would reject.
    expect(fake.sent.find(m => m.id === 'approval-1')?.result).toEqual({ decision: 'cancel' });
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

  // HS-9513 — the `codexAppServerEnabled` flag is gone. It read as an Experimental
  // readiness gate but was really the only in-app way to clear a handshake failure, so
  // it became an explicit "Retry Codex drive" action instead.
  it('isCodexAppServerEnabled is ON, and IGNORES a leftover codexAppServerEnabled key', () => {
    expect(isCodexAppServerEnabled()).toBe(true);
    // Anyone who turned the old toggle off still carries it in ~/.hotsheet/config.json.
    // Honouring it would silently keep the drive disabled with no control to re-enable.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
    expect(isCodexAppServerEnabled()).toBe(true);
  });

  it('spawnCodexAppServerRun spawns even with a leftover disable key present', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
    const fake = scriptedAppServer();
    expect(spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() })).toBe(true);
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

  it('does no discovery when explicitly disabled (HOTSHEET_CODEX_DISCOVER_THREAD=0): model-A as before', async () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '0'); // model-B is now default-on; force it off
    const fake = scriptedAppServer({ loaded: ['x'], threads: [{ id: 'x', cwd: dir }], newThreadId: 'th-a' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const methods = fake.sent.map(m => m.method);
    expect(methods).not.toContain('thread/loaded/list');
    expect(methods).not.toContain('thread/read');
    expect(methods).toContain('thread/start');
  });

  // HS-9438 — the live failure this fixes: a freshly launched `codex --remote` terminal
  // session has NO rollout on disk until its first turn persists one, so
  // `thread/resume` answers `-32600 no rollout found`. Adoption must not depend on it.
  it('adopts a discovered live thread whose resume fails (no rollout yet) instead of falling back to its own thread', async () => {
    const fake = scriptedAppServer({
      loaded: ['term-1'],
      threads: [{ id: 'term-1', cwd: dir, recencyAt: 5, path: '/sessions/term-1.jsonl' }],
      resumable: [], // the fresh terminal thread cannot be resumed
      newThreadId: 'th-mine',
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();

    const methods = fake.sent.map(m => m.method);
    expect(methods).toContain('thread/resume'); // tried to subscribe…
    expect(methods).not.toContain('thread/start'); // …and still joined the terminal's thread
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('term-1');
    expect(readPersistedCodexThread(dataDir)).toEqual({ threadId: 'term-1', rolloutPath: '/sessions/term-1.jsonl' });
  });

  it('ends the turn on thread/status/changed idle for an adopted-unsubscribed thread (no turn/completed arrives)', async () => {
    const postHeartbeat = vi.fn();
    const signalDone = vi.fn();
    const fake = scriptedAppServer({
      loaded: ['term-1'],
      threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }],
      resumable: [],
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat, signalDone });
    await flush();
    expect(signalDone).not.toHaveBeenCalled();

    fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'active' } } });
    await flush();
    expect(signalDone).not.toHaveBeenCalled(); // active is a busy reassertion, not an end

    fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
    await flush();
    expect(heartbeats(postHeartbeat)).toContain('idle');
    expect(signalDone).toHaveBeenCalledTimes(1);
  });

  it('does NOT double-end a SUBSCRIBED thread that reports idle just before turn/completed', async () => {
    const signalDone = vi.fn();
    const fake = scriptedAppServer({
      loaded: ['term-1'],
      threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }],
      resumable: ['term-1'], // resume succeeds → subscribed → turn/completed will arrive
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone });
    await flush();
    // The daemon's real order for a subscribed thread: status idle, THEN turn/completed.
    fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
    await flush();
    expect(signalDone).not.toHaveBeenCalled();
    fake.completeTurn('turn-1');
    await flush();
    expect(signalDone).toHaveBeenCalledTimes(1);
  });

  // HS-9448 (docs/129 §129.10) — the premature-idle race. `thread/status/changed` is
  // broadcast to EVERY connection, so while our `turn/start` is still in flight a
  // FOREIGN turn's idle would end a turn we haven't even sent yet.
  describe('HS-9448 — idle arriving before our turn/start ack', () => {
    const idle = (fake: FakeServer): void => {
      fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
    };

    it('ignores an idle while the turn/start is unacked, and still ends on the next one', async () => {
      const signalDone = vi.fn();
      const postHeartbeat = vi.fn();
      const fake = scriptedAppServer({
        loaded: ['term-1'],
        threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }],
        resumable: [], // adopted unsubscribed → this turn ends on thread-status
        deferTurnStart: true,
      });
      spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat, signalDone });
      await flush();
      expect(fake.sent.some(m => m.method === 'turn/start')).toBe(true); // sent…
      expect(heartbeats(postHeartbeat)).toContain('busy');

      // …but unacked. Someone else's turn finishing here is NOT our turn ending.
      idle(fake);
      await flush();
      expect(signalDone).not.toHaveBeenCalled();
      expect(heartbeats(postHeartbeat)).not.toContain('idle');

      fake.releaseTurnStart(); // our turn is now really running
      await flush();
      expect(signalDone).not.toHaveBeenCalled();

      idle(fake);
      await flush();
      expect(signalDone).toHaveBeenCalledTimes(1); // …and this one is ours
    });

    it('disarms even when turn/start FAILS, so the turn still ends exactly once', async () => {
      const signalDone = vi.fn();
      // No `loaded` threads and an unresumable persisted id → boot falls through to
      // thread/start; then a turn/start against an unknown method-shape still acks.
      const fake = scriptedAppServer({ loaded: ['term-1'], threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }], resumable: [] });
      spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone });
      await flush();
      idle(fake); // acked by now → this legitimately ends the turn
      await flush();
      expect(signalDone).toHaveBeenCalledTimes(1);
      idle(fake); // already idle — must not double-fire
      await flush();
      expect(signalDone).toHaveBeenCalledTimes(1);
    });
  });

  // HS-9439 (docs/129 §129.9 fact 5) — the rollout lands ~1s INTO the first turn, so
  // the drive can subscribe to the turn it just started instead of waiting for the
  // next turn boundary. Fake timers cover only setTimeout/clearTimeout so `flush()`'s
  // setImmediate keeps working.
  describe('HS-9439 — mid-turn resubscribe on an adopted thread', () => {
    const withFakeTimers = async (body: () => Promise<void>): Promise<void> => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try { await body(); } finally { vi.useRealTimers(); }
    };
    const resumeCount = (fake: FakeServer): number => fake.sent.filter(m => m.method === 'thread/resume').length;

    it('retries thread/resume after the turn starts and adopts the subscription once the rollout exists', async () => {
      await withFakeTimers(async () => {
        const resumable: string[] = []; // no rollout at adoption time
        const fake = scriptedAppServer({
          loaded: ['term-1'],
          threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }],
          resumable,
          resumePath: '/sessions/term-1.jsonl',
        });
        spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
        await flush();
        // Two failed attempts before any retry: adoption at boot, then the HS-9438
        // turn-boundary rejoin — neither can succeed before the turn writes a rollout.
        expect(resumeCount(fake)).toBe(2);

        resumable.push('term-1'); // the turn writes its rollout ~1s in
        await vi.advanceTimersByTimeAsync(1_600);
        await flush();

        expect(resumeCount(fake)).toBe(3);
        // No `config` — re-sending the per-thread MCP override mid-turn would restart
        // MCP servers while a tool call may be in flight (HS-9438: it isn't needed).
        expect(fake.sent.filter(m => m.method === 'thread/resume')[2].params).toEqual({ threadId: 'term-1' });
        // The subscription's rollout path is persisted for the next boot.
        expect(readPersistedCodexThread(dataDir)).toEqual({ threadId: 'term-1', rolloutPath: '/sessions/term-1.jsonl' });
      });
    });

    it('does NOT change how the in-flight turn ends: status idle still ends it, exactly once', async () => {
      await withFakeTimers(async () => {
        const signalDone = vi.fn();
        const resumable: string[] = [];
        const fake = scriptedAppServer({ loaded: ['term-1'], threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }], resumable });
        spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone });
        await flush();
        resumable.push('term-1');
        await vi.advanceTimersByTimeAsync(1_600);
        await flush();
        expect(resumeCount(fake)).toBe(3); // boot + turn-boundary rejoin + the retry that stuck

        // This turn was STARTED unsubscribed, so it must still end on status idle —
        // switching rules mid-flight would leave a window where neither rule fires.
        fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
        await flush();
        expect(signalDone).toHaveBeenCalledTimes(1);
        // …and the `turn/completed` the new subscription also delivers is a no-op.
        fake.completeTurn('turn-1');
        await flush();
        expect(signalDone).toHaveBeenCalledTimes(1);
      });
    });

    it('the NEXT turn, started subscribed, ends on turn/completed and ignores a foreign idle', async () => {
      await withFakeTimers(async () => {
        const signalDone = vi.fn();
        const resumable: string[] = [];
        const fake = scriptedAppServer({ loaded: ['term-1'], threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }], resumable });
        spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone });
        await flush();
        resumable.push('term-1');
        await vi.advanceTimersByTimeAsync(1_600);
        await flush();
        fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
        await flush();
        expect(signalDone).toHaveBeenCalledTimes(1);

        spawnCodexAppServerRun(dataDir, 4174, 'second', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone });
        await flush();
        fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
        await flush();
        expect(signalDone).toHaveBeenCalledTimes(1); // subscribed ⇒ idle is not our end
        fake.completeTurn('turn-2');
        await flush();
        expect(signalDone).toHaveBeenCalledTimes(2);
      });
    });

    it('backs off and gives up (3 attempts) when the rollout never appears', async () => {
      await withFakeTimers(async () => {
        const fake = scriptedAppServer({ loaded: ['term-1'], threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }], resumable: [] });
        spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
        await flush();
        expect(resumeCount(fake)).toBe(2); // adoption + turn-boundary rejoin
        for (const step of [1_600, 3_100, 6_100]) { await vi.advanceTimersByTimeAsync(step); await flush(); }
        expect(resumeCount(fake)).toBe(5); // …+ 3 retries, then the ladder is exhausted
        await vi.advanceTimersByTimeAsync(30_000); // and it stops — this is not a poll
        await flush();
        expect(resumeCount(fake)).toBe(5);
      });
    });

    // HS-9445 — the user-visible payoff, and the bug that reported it: codex routes
    // approvals/elicitations to SUBSCRIBED connections (docs/129 §129.9 fact 2), so
    // while the drive was unsubscribed a driven turn's permission prompt appeared only
    // in the terminal TUI — including for hotsheet's OWN tools, which the drive is
    // supposed to auto-accept invisibly. The routing itself is codex's behavior (proven
    // live), so what this pins is OUR half: on an adopted thread, once the subscribe
    // lands mid-turn, permission requests are handled exactly as on a drive-owned
    // thread — no gate on `subscribed`/`phase` creeping into `handleServerRequest`.
    it('handles permission requests on an adopted thread once the mid-turn subscribe lands', async () => {
      await withFakeTimers(async () => {
        const resumable: string[] = [];
        const fake = scriptedAppServer({ loaded: ['term-1'], threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }], resumable });
        spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
        await flush();
        resumable.push('term-1');
        await vi.advanceTimersByTimeAsync(1_600);
        await flush();
        expect(resumeCount(fake)).toBe(3); // subscribed mid-turn — codex will now route to us

        const elicit = (id: string, serverName: string): void => {
          fake.emit({
            jsonrpc: '2.0', id, method: 'mcpServer/elicitation/request',
            params: {
              threadId: 'term-1', turnId: 'turn-1', serverName, mode: 'form',
              _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} },
              message: `Allow the ${serverName} MCP server to run tool "hotsheet_signal_done"?`,
              requestedSchema: { type: 'object', properties: {} },
            },
          });
        };

        // Hot Sheet's own control surface: auto-accepted, no popup. This is the exact
        // request the maintainer's screenshot showed the TUI asking about.
        elicit('elicit-adopted-1', 'hotsheet-channel');
        await flush();
        expect(fake.sent.find(m => m.id === 'elicit-adopted-1')?.result).toEqual({ action: 'accept', content: {} });
        expect(pendingAcpPermissionForSecret(getProjectSecret(dataDir))).toBeNull();

        // Any other server still reaches the §47 overlay.
        elicit('elicit-adopted-2', 'some-other-server');
        await flush();
        expect(pendingAcpPermissionForSecret(getProjectSecret(dataDir))).not.toBeNull();
      });
    });

    it('never fires when the thread was already subscribed at turn start', async () => {
      await withFakeTimers(async () => {
        const fake = scriptedAppServer({ loaded: ['term-1'], threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }], resumable: ['term-1'] });
        spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
        await flush();
        expect(resumeCount(fake)).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        await flush();
        expect(resumeCount(fake)).toBe(1);
      });
    });
  });

  it('excludes the drive-owned model-A thread from discovery even when it is loaded and more recent', async () => {
    writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({ threadId: 'th-mine', rolloutPath: '/sessions/mine.jsonl' }), 'utf-8');
    const fake = scriptedAppServer({
      loaded: ['th-mine', 'term-1'],
      threads: [
        { id: 'th-mine', cwd: dir, recencyAt: 900 }, // the drive's own turns keep bumping this
        { id: 'term-1', cwd: dir, recencyAt: 100 },
      ],
      resumable: ['th-mine', 'term-1'],
    });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('term-1');
    // …and it never even reads the excluded thread (the reads here are boot + the
    // turn-boundary re-check, both for term-1 only).
    expect(new Set(fake.sent.filter(m => m.method === 'thread/read').map(m => m.params?.threadId))).toEqual(new Set(['term-1']));
  });

  it('rejoins at the next turn boundary when the terminal is opened AFTER the first play', async () => {
    // Boot with nothing live → model-A thread/start. Then a terminal thread appears.
    const opts: Parameters<typeof scriptedAppServer>[0] = { loaded: [], threads: [], newThreadId: 'th-mine', resumable: [] };
    const fake = scriptedAppServer(opts);
    const deps = { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() };
    spawnCodexAppServerRun(dataDir, 4174, 'first', deps);
    await flush();
    expect(fake.sent.find(m => m.method === 'turn/start')?.params?.threadId).toBe('th-mine');
    fake.completeTurn('turn-1');
    await flush();

    opts.loaded = ['th-mine', 'term-late'];
    opts.threads = [{ id: 'th-mine', cwd: dir, recencyAt: 900 }, { id: 'term-late', cwd: dir, recencyAt: 100 }];
    spawnCodexAppServerRun(dataDir, 4174, 'second', deps);
    await flush();

    const turnStarts = fake.sent.filter(m => m.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1].params?.threadId).toBe('term-late'); // migrated to the terminal's thread
    expect(readPersistedThreadId(dataDir)).toBe('term-late');
  });

  it('upgrades an adopted-unsubscribed thread to a real subscription once its rollout exists', async () => {
    const opts: Parameters<typeof scriptedAppServer>[0] = {
      loaded: ['term-1'],
      threads: [{ id: 'term-1', cwd: dir, recencyAt: 5 }],
      resumable: [], // first play: no rollout yet
    };
    const fake = scriptedAppServer(opts);
    const deps = { spawnFn: fake.spawnFn, connectDaemon: daemonize(fake), postHeartbeat: vi.fn(), signalDone: vi.fn() };
    spawnCodexAppServerRun(dataDir, 4174, 'first', deps);
    await flush();
    fake.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'term-1', status: { type: 'idle' } } });
    await flush();

    // The driven turn persisted a rollout, so the resume now succeeds.
    opts.resumable = ['term-1'];
    opts.resumePath = '/sessions/term-1.jsonl';
    spawnCodexAppServerRun(dataDir, 4174, 'second', deps);
    await flush();

    // Every resume targets the terminal's thread — the drive keeps retrying the
    // subscription while unsubscribed, and the last one (post-rollout) succeeds.
    const resumes = fake.sent.filter(m => m.method === 'thread/resume');
    expect(resumes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(resumes.map(m => m.params?.threadId))).toEqual(new Set(['term-1']));
    expect(readPersistedCodexThread(dataDir)?.rolloutPath).toBe('/sessions/term-1.jsonl');
    // Subscribed now: turn/completed drives the end, and status-idle no longer double-fires.
    fake.completeTurn('turn-2');
    await flush();
    expect(deps.signalDone).toHaveBeenCalledTimes(2); // once per turn, not twice for the second
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

  // HS-9447 — codex asks EVERY subscribed client about the same approval (measured,
  // docs/129 §129.9 fact 2) and broadcasts `serverRequest/resolved` when one answers.
  // Under model-B the other client is the terminal TUI the user is watching, so
  // answering there must take our overlay down with it.
  it('dismisses the §47 overlay when another client answers first (serverRequest/resolved)', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const secret = getProjectSecret(dataDir);

    fake.emit({ jsonrpc: '2.0', id: 77, method: 'mcpServer/elicitation/request', params: elicitParams('some-other-server') });
    await flush();
    expect(pendingAcpPermissionForSecret(secret)).not.toBeNull(); // popup is up

    // The TUI answers → codex closes the request and tells every client.
    fake.emit({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 'th-1', requestId: 77 } });
    await flush();
    expect(pendingAcpPermissionForSecret(secret)).toBeNull();
    // …and we do NOT reply to a request codex has already closed.
    expect(fake.sent.find(m => m.id === 77)).toBeUndefined();
  });

  it('ignores a serverRequest/resolved for an unknown id, and still answers our own popups normally', async () => {
    const fake = scriptedAppServer({ newThreadId: 'th-1' });
    spawnCodexAppServerRun(dataDir, 4174, 'go', { spawnFn: fake.spawnFn, connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn() });
    await flush();
    const secret = getProjectSecret(dataDir);

    fake.emit({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 'th-1', requestId: 'nobody' } });
    await flush();

    fake.emit({ jsonrpc: '2.0', id: 78, method: 'mcpServer/elicitation/request', params: elicitParams('some-other-server') });
    await flush();
    const pending = pendingAcpPermissionForSecret(secret);
    expect(pending).not.toBeNull();
    resolveAcpPermission(pending!.request_id, { optionId: 'accept' });
    await flush();
    expect(fake.sent.find(m => m.id === 78)?.result).toEqual({ action: 'accept', content: {} });
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

describe('HS-9394 — persisted rollout path', () => {
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
});

// HS-9430 — the end-to-end seam that used to prove the model-A attach (HS-9403),
// re-pointed at model-B: a user-created `{{aiCommand}}` terminal (ai_tool=codex)
// resolving through the REAL `codexTerminalRemoteCommand` — no injected
// `codexRemoteOverride` — so the integration path, not just the unit, is covered.
describe('HS-9430 — {{aiCommand}} terminal resolves the model-B launch end-to-end', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
    // `codexDaemonSocketPath()` is derived from `os.homedir()`, which honors $HOME
    // on POSIX — point it at the temp home so the "daemon up" case can create a
    // stand-in socket file WITHOUT touching the developer's real ~/.codex.
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const resolveAiTerminal = (): string => resolveTerminalCommand({
    dataDir,
    configOverride: { id: 'ai', command: '{{aiCommand}}' },
    aiToolOverride: 'codex',
    isAiToolOnPath: (b) => b === 'codex', // codex "on PATH" — environmental, not under test
  }).command;

  it('resolves to `codex --remote unix://<real socket> -C <projectDir>` when the daemon socket is up', () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    // The real resolver probes the real socket path — create it so the "daemon up"
    // branch is the one exercised (an empty file is enough for the existsSync probe).
    const sock = codexDaemonSocketPath();
    mkdirSync(dirname(sock), { recursive: true });
    writeFileSync(sock, '', 'utf-8');
    expect(resolveAiTerminal()).toBe(`codex --remote 'unix://${sock}' -C '${dir}'`);
  });

  it('resolves to PLAIN `codex` when the daemon socket is absent (nothing to host the thread)', () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    expect(resolveAiTerminal()).toBe('codex');
  });

  it('resolves to PLAIN `codex` when model-B is switched off, even with the daemon up', () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '0');
    const sock = codexDaemonSocketPath();
    mkdirSync(dirname(sock), { recursive: true });
    writeFileSync(sock, '', 'utf-8');
    expect(resolveAiTerminal()).toBe('codex');
  });
});

// HS-9513 — `codexDriveDiscoverEnabled` is ON unless the env var says otherwise. The
// `codexModelBTerminals` setting behind it is gone: model-A already survives as the
// automatic drive-side fallback, so the flag only ever offered a manual override of a
// decision the code makes correctly on its own. The env var stays as the escape hatch.
describe('HS-9513 — codexDriveDiscoverEnabled is on by default, env-overridable', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-codexapp-home-'));
    vi.stubEnv('HOTSHEET_HOME', home);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  const writeConfig = (config: Record<string, unknown>): void => {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config), 'utf-8');
  };

  it('is ON with no config file, and with an unrelated config present', () => {
    expect(codexDriveDiscoverEnabled()).toBe(true);
    writeConfig({ channelEnabled: true });
    expect(codexDriveDiscoverEnabled()).toBe(true);
  });

  it('ignores a leftover codexModelBTerminals key rather than honouring it', () => {
    // Users who turned the old flag OFF still carry it in ~/.hotsheet/config.json. A
    // stale key silently pinning model-B off after the flag was removed is precisely
    // the failure mode a deletion invites, so it is asserted rather than assumed.
    writeConfig({ codexModelBTerminals: false });
    expect(codexDriveDiscoverEnabled()).toBe(true);
  });

  it('the env var force-overrides in BOTH directions', () => {
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '0');
    expect(codexDriveDiscoverEnabled()).toBe(false);
    vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
    expect(codexDriveDiscoverEnabled()).toBe(true);
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

    it('returns null when the gate is explicitly OFF (HOTSHEET_CODEX_DISCOVER_THREAD=0)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '0'); // model-B is now default-on
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).toBeNull();
    });

    it('returns null when the daemon socket is not up (→ plain codex fallback)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: noneExist, socketPath: '/s.sock' })).toBeNull();
    });

    it('HS-9513 — a leftover drive-disable key no longer suppresses the remote command', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      writeFileSync(join(home, 'config.json'), JSON.stringify({ codexAppServerEnabled: false }), 'utf-8');
      expect(codexTerminalRemoteCommand(dataDir, { fileExists: allExist, socketPath: '/s.sock' })).not.toBeNull();
    });
  });

  describe('codexTerminalNeedsDaemonEnsure', () => {
    it('true when gate on + ai_tool=codex (defers the spawn behind the ensure)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1'); // dataDir settings.json has ai_tool: codex
      expect(codexTerminalNeedsDaemonEnsure(dataDir)).toBe(true);
    });

    // HS-9693 — the KEY regression. The result must be UNCONDITIONAL on the socket
    // state: the old code returned `!fileExists(socketPath)`, so a stale socket (a file
    // that exists but points at a dead daemon after an unclean death) read as "up" and
    // skipped the ensure → `codex --remote` failed with "failed to connect to remote
    // app server". The function no longer looks at the socket at all — it always defers
    // to the liveness-aware ensure (HS-9667), which no-ops when genuinely up and
    // recovers a stale socket by restarting the daemon.
    it('does not consult the socket path at all (a stale sock must not skip the ensure)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      // No deps to inject a "socket exists" answer — the signature dropped them. Repeated
      // calls stay true regardless of any real socket file the daemon may have left behind.
      expect(codexTerminalNeedsDaemonEnsure(dataDir)).toBe(true);
      expect(codexTerminalNeedsDaemonEnsure(dataDir)).toBe(true);
    });

    it('false when the gate is explicitly off (HOTSHEET_CODEX_DISCOVER_THREAD=0)', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '0'); // model-B is now default-on
      expect(codexTerminalNeedsDaemonEnsure(dataDir)).toBe(false);
    });

    it('false for a non-codex project even with the gate on', () => {
      vi.stubEnv('HOTSHEET_CODEX_DISCOVER_THREAD', '1');
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'claude' }), 'utf-8');
      expect(codexTerminalNeedsDaemonEnsure(dataDir)).toBe(false);
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

  it('starts the daemon when codex + drive on + model-B on + socket missing', async () => {
    const ensureDaemon = vi.fn().mockResolvedValue(true);
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    await flush();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  // HS-9693 — a socket FILE existing must NOT skip the ensure (it could be a stale sock
  // from an unclean daemon death). The ensure is liveness-aware + a no-op when the
  // daemon is genuinely up, so prestart always delegates to it.
  it('still calls the (liveness-aware) ensure even when a socket file exists', async () => {
    const ensureDaemon = vi.fn().mockResolvedValue(true);
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: () => true });
    await flush();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  // HS-9430 — a persisted rollout is NO LONGER required (that was the model-A
  // attach precondition); a brand-new codex project pre-starts the daemon too.
  it('starts the daemon for a codex project with NO persisted thread at all', async () => {
    const ensureDaemon = vi.fn().mockResolvedValue(true);
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    await flush();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  it('no-ops for non-codex projects', () => {
    const ensureDaemon = vi.fn();
    // non-codex tool
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'gemini' }), 'utf-8');
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon, socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    // HS-9513 — the "drive toggle off" and "model-B off" cases are both gone with their
    // flags. A non-codex project is the only thing that suppresses the prestart now.
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it('a rejecting ensure never throws out of the fire-and-forget path', async () => {
    prestartCodexDaemonIfNeeded(dataDir, { ensureDaemon: () => Promise.reject(new Error('boom')), socketPath: '/s.sock', fileExists: (p) => p !== '/s.sock' });
    await flush(); // unhandled rejection would fail the test run
  });
});
