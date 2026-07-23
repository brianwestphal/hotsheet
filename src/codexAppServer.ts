// HS-9383 (docs/121 §121.4–§121.5) — the codex app-server PERSISTENT drive: the
// real-IO session manager over the pure protocol core (`codexAppServerMapping.ts`).
//
// One `codex app-server` child per project, spawned lazily on the first play and
// kept alive between plays so turn N+1 shares the thread's context. Play / custom
// prompt commands become `turn/start` on the persisted thread (`thread/resume`
// across restarts — the HS-9382 spike verified continuity). Busy/done ride the
// same channel heartbeat/done POSTs every other drive uses; approvals bridge to
// the §47 overlay through the ACP permission bridge (`acpPermissionBridge.ts`) —
// no hooks, no bypass flags (supersedes the §115.6a one-shot `codex exec` drive).
//
// Maintainer decisions (2026-07-23, docs/121 §121.10): O1 queue+coalesce (a play
// while a turn runs queues; identical queued content coalesces), O3 manual-only
// thread reset (auto-fresh only when `thread/resume` fails), O4 approvals surface
// in the overlay BY DEFAULT (`codex_interactive_permissions` absent ⇒ on;
// explicit false ⇒ auto-approve in the bridge).
//
// HS-9388 (docs/121 §121.6) — transport: the session prefers the SHARED daemon
// (UDS WebSocket via `codexDaemonTransport.ts`, started if absent) so external
// codex UIs — including a `codex resume <threadId> --remote`-attached TUI
// (HS-9394) — can watch the driven thread live; the private stdio child is the
// automatic fallback when the daemon can't be reached. Same JSON-RPC protocol
// either way, behind one `CodexTransport` interface.

import { type ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { z } from 'zod';

import { dismissAcpPermission, injectAcpPermission } from './acp/acpPermissionBridge.js';
import { getChannelServerPath } from './channel-config.js';
import { CODEX_MCP_KEY } from './codex.js';
import {
  approvalDisplayFromRequest,
  type AppServerIncoming,
  buildNotificationLine,
  buildRequestLine,
  buildResponseLine,
  buildThreadMcpOverride,
  classifyAppServerLine,
  decisionFromReply,
  driveEventFromNotification,
  elicitationDisplayFromRequest,
  elicitationResponseFromReply,
  rolloutPathFromThreadPayload,
  threadIdFromResponse,
  transcriptLineFromItem,
} from './codexAppServerMapping.js';
import {
  codexDaemonSocketPath,
  type CodexTransport,
  type CodexTransportHandlers,
  connectCodexDaemon,
} from './codexDaemonTransport.js';
import { readFileSettings } from './file-settings.js';
import { readGlobalConfig } from './global-config.js';
import { findMatchingAllowRule, parseAllowRules } from './permissionAllowRules.js';
import { getProjectSecret } from './secret-file.js';

/** HS-9359 / HS-9383 (O4) — route codex approvals through the §47 overlay. Default is
 *  now ON (absent ⇒ overlay); explicit `false` ⇒ auto-approve in the bridge. */
export function codexInteractivePermissions(dataDir: string): boolean {
  return readFileSettings(dataDir).codex_interactive_permissions !== false;
}

/** HS-9384 (docs/121 §121.7) — the machine-global Experimental toggle, DEFAULT ON
 *  (absent ⇒ enabled, like `channelEnabled`'s treatment of the Claude Channel). */
export function isCodexAppServerEnabled(): boolean {
  return readGlobalConfig().codexAppServerEnabled !== false;
}

/** HS-9384 — projects whose app-server HANDSHAKE failed (protocol/version drift).
 *  The status route surfaces this so the client hides the drive surface, and logs a
 *  Commands Log warning; cleared on re-enable / server restart. */
const handshakeFailed = new Set<string>();

export function hasCodexAppServerHandshakeFailed(dataDir: string): boolean {
  return handshakeFailed.has(dataDir);
}

/** Clear failure flags (all when `dataDir` omitted) — a toggle re-enable retries fresh. */
export function clearCodexAppServerFailures(dataDir?: string): void {
  if (dataDir === undefined) handshakeFailed.clear();
  else handshakeFailed.delete(dataDir);
}

type HeartbeatState = 'busy' | 'idle' | 'heartbeat';

/** Same interval floor as the other drives — well under the client's 60s fallback. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Per-(project, machine) persisted app-server state (`<dataDir>/codex-app-server.json`).
 *  Thread ids resolve against THIS machine's `~/.codex` rollouts, so the file is
 *  local state, not a shared setting. HS-9394 adds `rolloutPath` (from the thread
 *  payloads' `thread.path`) — its on-disk EXISTENCE is the "TUI attach will work"
 *  signal (`thread/resume` fails "no rollout found" until the first turn persists). */
const StateFileSchema = z.object({ threadId: z.string().min(1), rolloutPath: z.string().min(1).optional() });

export interface PersistedCodexThread {
  threadId: string;
  rolloutPath: string | null;
}

export function readPersistedCodexThread(dataDir: string): PersistedCodexThread | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'codex-app-server.json'), 'utf-8'));
    const parsed = StateFileSchema.safeParse(raw);
    return parsed.success ? { threadId: parsed.data.threadId, rolloutPath: parsed.data.rolloutPath ?? null } : null;
  } catch { return null; }
}

export function readPersistedThreadId(dataDir: string): string | null {
  return readPersistedCodexThread(dataDir)?.threadId ?? null;
}

function persistThreadState(dataDir: string, threadId: string, rolloutPath: string | null): void {
  const state = rolloutPath !== null ? { threadId, rolloutPath } : { threadId };
  try { writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify(state), 'utf-8'); }
  catch { /* best-effort — a failed persist just means a fresh thread next boot */ }
}

/** HS-9385 — one transcript event, self-POSTed to `/channel/codex-transcript` so the
 *  Commands Log write happens in project request context (same reasoning as the
 *  heartbeat/done fallbacks — the session manager runs outside any request). */
export interface CodexTranscriptEvent {
  phase: 'start' | 'item' | 'end';
  turnId: string;
  text?: string;
  status?: string;
}

export interface CodexAppServerDeps {
  /** Injectable for tests. Defaults to `child_process.spawn` (the stdio fallback child). */
  spawnFn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: readonly ['pipe', 'pipe', 'ignore'] }) => ChildProcess;
  /** HS-9388 — injectable for tests. Defaults to the real daemon connect (start-if-absent);
   *  `async () => null` forces the stdio fallback path. */
  connectDaemon?: (handlers: CodexTransportHandlers) => Promise<CodexTransport | null>;
  /** Injectable for tests. Defaults to the real `/channel/done` fallback POST. */
  signalDone?: (dataDir: string, serverPort: number) => void;
  /** Injectable for tests. Defaults to the real `/channel/heartbeat` POST. */
  postHeartbeat?: (serverPort: number, secret: string, state: HeartbeatState) => void;
  /** Injectable for tests. Defaults to the real `/channel/codex-transcript` POST. */
  postTranscript?: (serverPort: number, secret: string, event: CodexTranscriptEvent) => void;
}

interface Session {
  /** Null until `establishTransport` resolves (daemon connect or stdio spawn). */
  transport: CodexTransport | null;
  dataDir: string;
  serverPort: number;
  secret: string;
  deps: Required<Pick<CodexAppServerDeps, 'signalDone' | 'postHeartbeat' | 'postTranscript'>>;
  nextId: number;
  pending: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  buffered: string;
  threadId: string | null;
  currentTurnId: string | null;
  /** 'booting' until the handshake + thread setup completes; then idle/active. */
  phase: 'booting' | 'idle' | 'active';
  /** O1 — queued prompts; identical content coalesces (no duplicate entries). */
  queue: string[];
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Overlay request_ids currently pending for this session (dismissed on turn end / exit). */
  pendingPermissionIds: Set<string>;
  finished: boolean;
}

/** dataDir → live session. Module-level (one per project per process). */
const sessions = new Map<string, Session>();

/** HS-9394 — injectables for `codexTerminalAttachCommand` (tests use temp paths). */
export interface AttachCommandDeps {
  fileExists?: (path: string) => boolean;
  socketPath?: string;
}

/**
 * HS-9394 (docs/123) — the daemon-attached terminal command for a codex project,
 * or null when plain `codex` is the right launch. The attached form is only safe
 * when the DRIVE runs (or would run) on the shared daemon — a TUI-on-daemon
 * resuming a rollout that a private stdio child is actively writing would be two
 * cores fighting over one rollout. Conditions, all required:
 *  1. the app-server drive is enabled (HS-9384 toggle);
 *  2. a driven thread is persisted WITH a rollout path that exists on disk
 *     (`thread/resume` fails "no rollout found" before the first turn persists);
 *  3. the live session (if any) is on the daemon transport; with no live session,
 *     the daemon socket exists (the next session will prefer it). A live STDIO
 *     session vetoes the attach (see above).
 * Interplay is safe (live-verified, codex-cli 0.145.0): codex queues a `turn/start`
 * that arrives while another client's turn runs, and an unsubmitted TUI draft
 * survives a driven turn rendering above it.
 */
export function codexTerminalAttachCommand(dataDir: string, deps: AttachCommandDeps = {}): string | null {
  if (!isCodexAppServerEnabled()) return null;
  const persisted = readPersistedCodexThread(dataDir);
  if (persisted === null || persisted.rolloutPath === null) return null;
  const fileExists = deps.fileExists ?? existsSync;
  if (!fileExists(persisted.rolloutPath)) return null;
  const socketPath = deps.socketPath ?? codexDaemonSocketPath();
  const live = sessions.get(dataDir);
  if (live !== undefined && !live.finished && live.transport !== null) {
    if (live.transport.kind !== 'daemon') return null; // stdio session owns the rollout
  } else if (!fileExists(socketPath)) {
    return null; // no daemon to attach to (the drive would start one on next play)
  }
  // Single-quote the URL — home directories can contain spaces.
  return `codex resume ${persisted.threadId} --remote 'unix://${socketPath}'`;
}

/**
 * The play/custom-command entry point — the `McpHooksAgent.spawnRun` signature.
 * Ensures the per-project session (transport + handshake + thread resume/start on
 * first use), queues the prompt (O1: coalescing exact duplicates), and starts the
 * next turn when idle. Returns false only when the drive toggle is off; transport
 * failures surface asynchronously via the HS-9384 handshake-failed flag (HS-9388 —
 * establishing the daemon transport is async, so spawn errors can't be sync).
 */
export function spawnCodexAppServerRun(dataDir: string, serverPort: number, content: string, deps: CodexAppServerDeps = {}): boolean {
  // HS-9384 — the Experimental toggle gates the drive server-side too (the client
  // hides the buttons, but a stale client / direct trigger must not spawn either).
  if (!isCodexAppServerEnabled()) return false;
  const existing = sessions.get(dataDir);
  let session: Session;
  if (existing === undefined || existing.finished) {
    const created = createSession(dataDir, serverPort, deps);
    sessions.set(dataDir, created);
    session = created;
  } else {
    session = existing;
  }
  // O1 — queue + coalesce: an identical prompt already queued is not queued again
  // (repeated play clicks collapse to one pending trigger); distinct prompts FIFO.
  if (!session.queue.includes(content)) session.queue.push(content);
  session.deps.postHeartbeat(serverPort, session.secret, 'busy'); // busy from the click
  if (session.phase === 'idle') void startNextTurn(session);
  return true;
}

/** §57 stop affordance → `turn/interrupt {threadId, turnId}` (spike: turnId REQUIRED).
 *  Also clears the queue — stop means stop, not "run the backlog next". Returns
 *  whether an active turn was interrupted. */
export function interruptCodexAppServerTurn(dataDir: string): boolean {
  const session = sessions.get(dataDir);
  if (session === undefined || session.phase !== 'active' || session.threadId === null || session.currentTurnId === null) return false;
  session.queue = [];
  void request(session, 'turn/interrupt', { threadId: session.threadId, turnId: session.currentTurnId }, 30_000).catch(() => { /* turn may end first */ });
  return true;
}

/** O3 — manual thread reset: forget the persisted thread so the next play starts a
 *  fresh conversation. Kills a live session (its context is being discarded). */
export function resetCodexAppServerThread(dataDir: string): void {
  try { writeFileSync(join(dataDir, 'codex-app-server.json'), JSON.stringify({}), 'utf-8'); } catch { /* ignore */ }
  const session = sessions.get(dataDir);
  if (session !== undefined) teardown(session, 'thread-reset');
}

/** Kill every live session (server shutdown / toggle-off). Best-effort. */
export function shutdownCodexAppServers(): void {
  for (const session of [...sessions.values()]) teardown(session, 'shutdown');
}

/** Test-only: drop all session bookkeeping without side effects. */
export function _resetCodexAppServersForTesting(): void {
  for (const session of sessions.values()) {
    if (session.heartbeatTimer !== null) clearInterval(session.heartbeatTimer);
    for (const [, p] of session.pending) clearTimeout(p.timer);
  }
  sessions.clear();
}

function createSession(dataDir: string, serverPort: number, deps: CodexAppServerDeps): Session {
  const session: Session = {
    transport: null,
    dataDir,
    serverPort,
    secret: getProjectSecret(dataDir),
    deps: {
      signalDone: deps.signalDone ?? fallbackSignalDone,
      postHeartbeat: deps.postHeartbeat ?? fallbackHeartbeat,
      postTranscript: deps.postTranscript ?? fallbackTranscript,
    },
    nextId: 1,
    pending: new Map(),
    buffered: '',
    threadId: null,
    currentTurnId: null,
    phase: 'booting',
    queue: [],
    heartbeatTimer: null,
    pendingPermissionIds: new Set(),
    finished: false,
  };
  void establishTransport(session, deps)
    .then(() => bootSession(session))
    .catch(() => {
      // HS-9384 — a failed transport/handshake (connect/spawn/initialize/thread
      // setup) marks the project so the status route can surface it (client hides
      // the drive + a Commands Log warning is written there, in project context).
      // No one-shot fallback.
      handshakeFailed.add(dataDir);
      teardown(session, 'handshake-failed');
    });
  return session;
}

/** HS-9388 — prefer the shared daemon (external codex UIs can watch the driven
 *  thread); fall back to the private stdio child when it can't be reached. */
async function establishTransport(session: Session, deps: CodexAppServerDeps): Promise<void> {
  const handlers: CodexTransportHandlers = {
    onMessage: (text) => { onIncomingText(session, text); },
    onClose: () => { teardown(session, 'transport-closed'); },
  };
  const connect = deps.connectDaemon ?? connectCodexDaemon;
  const daemon = await connect(handlers);
  if (session.finished) { daemon?.close(); return; }
  if (daemon !== null) {
    session.transport = daemon;
    return;
  }
  session.transport = createStdioTransport(session, deps.spawnFn ?? ((command, args, options) => spawn(command, args, { ...options, stdio: [...options.stdio] })), handlers);
  if (session.transport === null) throw new Error('codex app-server: stdio spawn failed');
}

/** The private stdio child (pre-HS-9388 behavior), now behind the transport
 *  interface: newline framing on stdout, SIGTERM on close. Null on spawn failure. */
function createStdioTransport(session: Session, doSpawn: NonNullable<CodexAppServerDeps['spawnFn']>, handlers: CodexTransportHandlers): CodexTransport | null {
  const projectDir = dirname(session.dataDir); // <root>/.hotsheet → <root>
  let proc: ChildProcess;
  try {
    proc = doSpawn('codex', ['app-server'], {
      cwd: projectDir,
      // HS-9380 — the marker propagates to the MCP channel-server child the driven
      // session starts, so it registers `drive: true` (not a duplicate main).
      env: { ...process.env, HOTSHEET_DRIVE_SPAWNED: '1' },
      // stderr → ignore (codex logs there; an unread pipe could stall the child).
      stdio: ['pipe', 'pipe', 'ignore'] as const,
    });
  } catch {
    return null;
  }
  proc.stdout?.on('data', (chunk: Buffer | string) => {
    session.buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let nl = session.buffered.indexOf('\n');
    while (nl !== -1) {
      const line = session.buffered.slice(0, nl);
      session.buffered = session.buffered.slice(nl + 1);
      handlers.onMessage(line);
      nl = session.buffered.indexOf('\n');
    }
  });
  proc.on('error', () => { handlers.onClose(); });
  proc.on('exit', () => { handlers.onClose(); });
  return {
    kind: 'stdio',
    send: (json: string) => { try { proc.stdin?.write(json); } catch { /* dying process — exit handler cleans up */ } },
    close: () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}

/** initialize → initialized → thread/resume (persisted id) or thread/start → drain. */
async function bootSession(session: Session): Promise<void> {
  await request(session, 'initialize', { clientInfo: { name: 'hotsheet', version: '0.1.0' } }, 30_000);
  write(session, buildNotificationLine('initialized', {}));
  // HS-9388 — in daemon mode, pin the hotsheet-channel MCP server to THIS project
  // per-thread: the shared daemon's cwd/env are not ours, so the override carries an
  // absolute `--data-dir` + the HS-9380 drive marker (live-verified honored).
  const config = session.transport?.kind === 'daemon'
    ? buildThreadMcpOverride(CODEX_MCP_KEY, getChannelServerPath(), session.dataDir)
    : undefined;
  const persisted = readPersistedThreadId(session.dataDir);
  let threadId: string | null = null;
  if (persisted !== null) {
    // O3 — auto-fresh ONLY when resume fails (missing/corrupt rollout).
    const resumed = await request(session, 'thread/resume', { threadId: persisted, config }, 60_000).catch(() => null);
    if (resumed !== null) {
      threadId = persisted;
      // HS-9394 — backfill/refresh the rollout path (pre-9394 state files lack it).
      persistThreadState(session.dataDir, threadId, rolloutPathFromThreadPayload(resumed));
    }
  }
  if (threadId === null) {
    const started = await request(session, 'thread/start', {
      cwd: dirname(session.dataDir),
      // O4 — the overlay only sees genuine escalations under 'untrusted' (spike
      // finding: safe commands auto-run), so the sandbox stays on and approvals
      // route to the bridge instead of a bypass flag.
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      config,
    }, 60_000);
    threadId = threadIdFromResponse(started);
    if (threadId === null) throw new Error('thread/start returned no thread id');
    persistThreadState(session.dataDir, threadId, rolloutPathFromThreadPayload(started));
  }
  session.threadId = threadId;
  session.phase = 'idle';
  handshakeFailed.delete(session.dataDir); // a healthy boot clears any stale failure flag
  if (session.queue.length > 0) void startNextTurn(session);
}

async function startNextTurn(session: Session): Promise<void> {
  if (session.finished || session.phase !== 'idle' || session.threadId === null) return;
  const content = session.queue.shift();
  if (content === undefined) return;
  session.phase = 'active';
  session.deps.postHeartbeat(session.serverPort, session.secret, 'busy');
  if (session.heartbeatTimer === null) {
    session.heartbeatTimer = setInterval(() => {
      if (session.phase === 'active') session.deps.postHeartbeat(session.serverPort, session.secret, 'heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
    session.heartbeatTimer.unref();
  }
  // Spike finding: the response is an immediate ack (turn inProgress) — completion
  // arrives via `turn/completed`. A rejected turn/start (e.g. thread unloaded)
  // falls back to ending the "turn" so busy can't stick.
  await request(session, 'turn/start', {
    threadId: session.threadId,
    input: [{ type: 'text', text: content }],
  }, 120_000).catch(() => { onTurnEnded(session); });
}

function onTurnEnded(session: Session): void {
  session.currentTurnId = null;
  if (session.finished) return;
  session.phase = 'idle';
  // A turn that ends with a permission popup still open must not leave the agent
  // (or the popup) hanging.
  for (const id of session.pendingPermissionIds) dismissAcpPermission(id);
  session.pendingPermissionIds.clear();
  if (session.queue.length > 0) {
    void startNextTurn(session); // O1 — drain the queue before going idle
    return;
  }
  session.deps.postHeartbeat(session.serverPort, session.secret, 'idle');
  // Fallback done — the agent normally calls `hotsheet_signal_done` itself.
  session.deps.signalDone(session.dataDir, session.serverPort);
}

/** One incoming JSON-RPC message (a framed stdout line, or one daemon WS frame). */
function onIncomingText(session: Session, text: string): void {
  const msg = classifyAppServerLine(text);
  if (msg !== null) handleIncoming(session, msg);
}

/** HS-9388 — the thread id a notification names, when it names one. On the shared
 *  daemon a connection can also receive broadcasts about OTHER threads (e.g.
 *  `thread/started` from any client); lifecycle handling must ignore those. */
function notificationThreadId(params: Record<string, unknown>): string | null {
  if (typeof params.threadId === 'string') return params.threadId;
  const thread = params.thread;
  if (typeof thread === 'object' && thread !== null) {
    const id = (thread as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

function handleIncoming(session: Session, msg: AppServerIncoming): void {
  if (msg.kind === 'response') {
    const entry = typeof msg.id === 'number' ? session.pending.get(msg.id) : undefined;
    if (entry !== undefined) {
      session.pending.delete(msg.id as number);
      clearTimeout(entry.timer);
      if (msg.error !== undefined) entry.reject(new Error(msg.error.message ?? 'app-server error'));
      else entry.resolve(msg.result);
    }
    return;
  }
  if (msg.kind === 'server-request') {
    void handleServerRequest(session, msg.id, msg.method, msg.params);
    return;
  }
  // HS-9388 — on the shared daemon, ignore notifications about threads that aren't
  // ours (broadcasts like `thread/started`, or another subscription's events).
  const aboutThread = notificationThreadId(msg.params);
  if (aboutThread !== null && session.threadId !== null && aboutThread !== session.threadId) return;
  // HS-9385 — stream completed items into the Commands Log transcript.
  if (msg.method === 'item/completed') {
    const line = transcriptLineFromItem(msg.params);
    if (line !== null) {
      session.deps.postTranscript(session.serverPort, session.secret, { phase: 'item', turnId: session.currentTurnId ?? '', text: line });
    }
  }
  // Notification → drive lifecycle.
  const event = driveEventFromNotification(msg.method, msg.params);
  if (event === null) return;
  if (event.type === 'turn-started') {
    session.currentTurnId = event.turnId;
    session.deps.postTranscript(session.serverPort, session.secret, { phase: 'start', turnId: event.turnId ?? '' });
  } else if (event.type === 'activity') {
    if (session.phase === 'active') session.deps.postHeartbeat(session.serverPort, session.secret, 'heartbeat');
  } else if (event.type === 'turn-ended') {
    session.deps.postTranscript(session.serverPort, session.secret, { phase: 'end', turnId: session.currentTurnId ?? '', status: event.status ?? 'completed' });
    // HS-9388/HS-9394 — on a SHARED thread another client (an attached TUI) can run
    // turns too; those still stream to the transcript above, but only a turn WE
    // started (phase 'active') drives the busy/done lifecycle.
    if (session.phase === 'active') onTurnEnded(session);
    else session.currentTurnId = null;
  } else {
    // thread-status active/idle — event-driven busy reassertion (spike finding).
    if (event.active && session.phase === 'active') session.deps.postHeartbeat(session.serverPort, session.secret, 'heartbeat');
  }
}

/** Approvals → the §47 overlay via the ACP bridge; unknown server requests are
 *  declined-shaped empty results so the agent never hangs on us. */
async function handleServerRequest(session: Session, id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
  // HS-9395 — MCP tool-call elicitations have their OWN response shape ({action},
  // not {decision}); the old generic `{}` fallback read as a decline, silently
  // failing every hotsheet_* call in driven sessions.
  const elicitation = elicitationDisplayFromRequest(method, params);
  if (elicitation !== null) {
    // Hotsheet's own MCP server is the drive's control surface — auto-accept
    // (same reasoning as the HS-9359 hook's auto-allow). Also auto-accept when
    // interactive permissions are explicitly off (O4).
    if (elicitation.serverName === CODEX_MCP_KEY || !codexInteractivePermissions(session.dataDir)) {
      write(session, buildResponseLine(id, elicitationResponseFromReply({ optionId: 'accept' })));
      return;
    }
    const { request_id, promise } = injectAcpPermission({
      secret: session.secret,
      tool_name: elicitation.tool_name,
      description: elicitation.description,
      input_preview: elicitation.input_preview,
      options: elicitation.options,
    });
    session.pendingPermissionIds.add(request_id);
    try {
      const reply = await promise;
      write(session, buildResponseLine(id, elicitationResponseFromReply(reply)));
    } finally {
      session.pendingPermissionIds.delete(request_id);
    }
    return;
  }
  const display = approvalDisplayFromRequest(method, params);
  if (display === null) {
    // Not an approval (e.g. item/tool/requestUserInput) — answer with an empty
    // object so the agent isn't left waiting on a request we don't model yet.
    write(session, buildResponseLine(id, {}));
    return;
  }
  // O4 — explicit opt-OUT auto-approves in the bridge (no popup).
  if (!codexInteractivePermissions(session.dataDir)) {
    write(session, buildResponseLine(id, { decision: 'accept' }));
    return;
  }
  // HS-9346-equivalent auto-allow gate: a `permission_allow_rules` match resolves
  // without rendering the popup. Codex command approvals map to the Bash rule shape.
  if (display.autoAllowCommand !== null) {
    try {
      const rules = parseAllowRules(readFileSettings(session.dataDir).permission_allow_rules);
      // The captured approval params carry the raw command string — it IS the
      // Bash-rule primary value (no JSON input-preview to extract from).
      if (rules.length > 0 && findMatchingAllowRule('Bash', display.autoAllowCommand, rules) !== null) {
        write(session, buildResponseLine(id, { decision: 'accept' }));
        return;
      }
    } catch { /* fall through to the overlay */ }
  }
  const { request_id, promise } = injectAcpPermission({
    secret: session.secret,
    tool_name: display.tool_name,
    description: display.description,
    input_preview: display.input_preview,
    options: display.options,
  });
  session.pendingPermissionIds.add(request_id);
  try {
    const reply = await promise;
    write(session, buildResponseLine(id, decisionFromReply(reply)));
  } finally {
    session.pendingPermissionIds.delete(request_id);
  }
}

function request(session: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const id = session.nextId++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`codex app-server: timeout waiting for ${method}`));
    }, timeoutMs);
    timer.unref();
    session.pending.set(id, { resolve, reject, timer });
    write(session, buildRequestLine(id, method, params));
  });
}

function write(session: Session, line: string): void {
  session.transport?.send(line);
}

/** Tear the session down exactly once: clear timers, dismiss popups, reject pending
 *  requests, clear busy (+ fallback done if work was in flight), close the transport
 *  (stdio: SIGTERM the child; daemon: close OUR connection — the shared daemon and
 *  the thread keep running for other attached clients). */
function teardown(session: Session, _reason: string): void {
  if (session.finished) return;
  session.finished = true;
  if (session.heartbeatTimer !== null) { clearInterval(session.heartbeatTimer); session.heartbeatTimer = null; }
  for (const [, entry] of session.pending) { clearTimeout(entry.timer); entry.reject(new Error('codex app-server session ended')); }
  session.pending.clear();
  for (const id of session.pendingPermissionIds) dismissAcpPermission(id);
  session.pendingPermissionIds.clear();
  const hadWork = session.phase === 'active' || session.queue.length > 0;
  session.queue = [];
  if (hadWork) {
    session.deps.postHeartbeat(session.serverPort, session.secret, 'idle');
    session.deps.signalDone(session.dataDir, session.serverPort); // busy can't stick
  }
  session.transport?.close();
  if (sessions.get(session.dataDir) === session) sessions.delete(session.dataDir);
}

/** Best-effort `/channel/done` POST so busy clears if the session dies mid-run. */
function fallbackSignalDone(dataDir: string, serverPort: number): void {
  const secret = getProjectSecret(dataDir);
  void fetch(`http://localhost:${String(serverPort)}/api/channel/done`, {
    method: 'POST',
    headers: { 'X-Hotsheet-Secret': secret },
  }).catch(() => { /* best-effort — the agent likely already signaled done */ });
}

/** Best-effort `/channel/codex-transcript` POST — the Commands Log write happens in
 *  project request context (the standard `X-Hotsheet-Secret` auth resolves it). */
function fallbackTranscript(serverPort: number, secret: string, event: CodexTranscriptEvent): void {
  void fetch(`http://localhost:${String(serverPort)}/api/channel/codex-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
    body: JSON.stringify(event),
  }).catch(() => { /* best-effort — the transcript is observability, never load-bearing */ });
}

/** Best-effort `/channel/heartbeat` POST — the project is matched by `secret`. */
function fallbackHeartbeat(serverPort: number, secret: string, state: HeartbeatState): void {
  void fetch(`http://localhost:${String(serverPort)}/api/channel/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, secret }),
  }).catch(() => { /* best-effort */ });
}
