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
// codex UIs can watch the driven thread live; the private stdio child is the
// automatic fallback when the daemon can't be reached. Same JSON-RPC protocol
// either way, behind one `CodexTransport` interface.
//
// HS-9428/9429/9430 (docs/129, "model-B", default ON) — which thread gets driven:
// a Hot Sheet codex terminal launches daemon-hosted (`codex --remote … -C <proj>`)
// and OWNS a live thread, which this drive DISCOVERS by cwd and drives in place, so
// turns render in the window the user is watching. With nothing discoverable (no
// terminal open, headless cron/worker run, or the model-B toggle off) the drive
// resumes/starts its own thread — the "model-A" fallback.

import { type ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
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
  type LoadedThreadEntry,
  loadedThreadIdsFromResponse,
  pickThreadForCwd,
  rolloutPathFromThreadPayload,
  threadIdFromResponse,
  threadReadEntry,
  transcriptLineFromItem,
} from './codexAppServerMapping.js';
import {
  codexDaemonSocketPath,
  type CodexTransport,
  type CodexTransportHandlers,
  connectCodexDaemon,
  ensureCodexDaemonRunning,
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
 *  payloads' `thread.path`); `thread/resume` fails "no rollout found" until the
 *  first turn persists it, which is why adoption never depends on resume (§129.3a). */
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

/** HS-9447 — one overlay the drive is awaiting a decision on. `externallyResolved`
 *  flips when codex reports the request was answered elsewhere (the terminal TUI), so
 *  the awaiting handler skips writing a reply to a request that is already closed. */
interface PendingPermissionEntry {
  bridgeId: string;
  externallyResolved: boolean;
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
  /** HS-9438 — do we hold a `thread/resume` SUBSCRIPTION for `threadId`? True ⇒ the
   *  full `turn/*` + `item/*` stream arrives. False ⇒ an adopted live thread whose
   *  rollout doesn't exist yet: drivable via `turn/start`, but only
   *  `thread/status/changed` arrives, so that is what ends the turn. */
  subscribed: boolean;
  /** HS-9438 — the model-A thread id read from `codex-app-server.json` at boot,
   *  BEFORE any adoption. Excluded from every later discovery so a drive-owned
   *  thread (whose `recencyAt` its own driven turns keep bumping) can't out-recency
   *  the terminal's live thread. Null when the project had no persisted thread. */
  modelAThreadId: string | null;
  currentTurnId: string | null;
  /** HS-9439 — how the CURRENT turn ends, decided when it starts: true ⇒ from
   *  `thread/status/changed` idle (we were unsubscribed at turn start, so no
   *  `turn/completed` was coming). Deliberately a per-TURN snapshot rather than a
   *  live read of `subscribed`: the mid-turn resubscribe below can flip `subscribed`
   *  while this turn runs, and switching the ending rule mid-flight opens a window
   *  where the turn ends by neither rule (subscribed just after `turn/completed` was
   *  broadcast, but before the idle we'd then ignore) and busy sticks. */
  turnEndsOnStatus: boolean;
  /** HS-9439 — pending mid-turn `thread/resume` retry, cleared on teardown. */
  midTurnSubscribeTimer: ReturnType<typeof setTimeout> | null;
  /** HS-9448 — true from just before we send `turn/start` until its response lands.
   *  While set, a `thread/status/changed` idle is NOT ours to act on (see
   *  `handleNotification`). */
  turnStartPending: boolean;
  /** 'booting' until the handshake + thread setup completes; then idle/active. */
  phase: 'booting' | 'idle' | 'active';
  /** O1 — queued prompts; identical content coalesces (no duplicate entries). */
  queue: string[];
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Overlay request_ids currently pending for this session (dismissed on turn end / exit). */
  pendingPermissionIds: Set<string>;
  /** HS-9447 — codex request id → the overlay it opened, so a `serverRequest/resolved`
   *  (someone ELSE answered — see below) can dismiss the popup we're still showing. */
  pendingPermissionByCodexId: Map<string, PendingPermissionEntry>;
  finished: boolean;
}

/** dataDir → live session. Module-level (one per project per process). */
const sessions = new Map<string, Session>();

/** HS-9394/HS-9429 — injectables for the codex terminal-command resolvers
 *  (`codexTerminalRemoteCommand`, `codexTerminalNeedsDaemonEnsure`) and the
 *  daemon pre-start. Tests use temp paths. */
export interface CodexCommandDeps {
  fileExists?: (path: string) => boolean;
  socketPath?: string;
}

/** HS-9396 — injectables for `prestartCodexDaemonIfNeeded`. */
export interface PrestartDeps extends CodexCommandDeps {
  ensureDaemon?: () => Promise<boolean>;
}

/**
 * HS-9396 (docs/123 §123.5) — fire-and-forget daemon pre-start so a codex
 * terminal can launch DAEMON-HOSTED without waiting on a cold daemon start.
 * Called at project registration, on an `ai_tool` settings change, and on drive
 * re-enable. Acts when the model-B launch is one missing daemon away: model-B
 * on + drive enabled + `ai_tool=codex` + the daemon socket absent.
 *
 * HS-9430 — no longer requires a persisted rollout on disk. That was the model-A
 * precondition (the terminal RESUMED the drive's thread, which needs a rollout);
 * model-B's `codex --remote` only needs the socket, so a brand-new codex project
 * gets a warm daemon on its first terminal open. The resolver
 * (`codexTerminalRemoteCommand`) stays side-effect-free — this is the async
 * spawn-adjacent path, and `codexTerminalNeedsDaemonEnsure` still covers the
 * cold spawn if the pre-start hasn't finished.
 */
export function prestartCodexDaemonIfNeeded(dataDir: string, deps: PrestartDeps = {}): void {
  if (!codexDriveDiscoverEnabled() || !isCodexAppServerEnabled()) return;
  const tool = readFileSettings(dataDir).ai_tool;
  if (typeof tool !== 'string' || tool.trim().toLowerCase() !== 'codex') return;
  const fileExists = deps.fileExists ?? existsSync;
  if (fileExists(deps.socketPath ?? codexDaemonSocketPath())) return; // already up
  void (deps.ensureDaemon ?? ensureCodexDaemonRunning)().catch(() => { /* best-effort — plain codex fallback stands */ });
}

/**
 * HS-9428/HS-9430 (docs/129 model-B) — is model-B on? When ON, a codex terminal
 * launches daemon-hosted (`codex --remote`) and the drive DISCOVERS + joins that
 * thread by cwd, instead of the model-A "terminal chases the drive's thread" attach.
 *
 * **Default ON** (HS-9430) — verified end-to-end against real codex 0.145.0
 * (HS-9429/9431). Model-A survives as the HEADLESS fallback on the DRIVE side
 * (nothing discoverable for this cwd → the drive resumes/starts its own thread),
 * so cron/worker/no-UI runs never regress; the terminal falls back to plain
 * `codex` when the daemon is unavailable.
 *
 * Off (Settings → Experimental → "Codex terminals host the driven session", the
 * `codexModelBTerminals` global-config flag) means: terminals launch plain `codex`
 * and the drive always owns its own thread. `HOTSHEET_CODEX_DISCOVER_THREAD`
 * force-overrides either way (`1` on / `0` off) for tests + a quick revert.
 */
export function codexDriveDiscoverEnabled(): boolean {
  const env = process.env.HOTSHEET_CODEX_DISCOVER_THREAD;
  if (env === '1') return true;
  if (env === '0') return false;
  return readGlobalConfig().codexModelBTerminals !== false;
}

/**
 * HS-9428 (docs/121 model-B) — discover the live daemon thread the drive should join
 * for `cwd`: list the in-memory threads (`thread/loaded/list`), read each one's cwd,
 * and pick the match with the most recent `recencyAt` (`pickThreadForCwd`). Returns
 * null when nothing qualifies (no live terminal session for this project) so the
 * caller falls back to model-A. Never throws — a rejected/absent method resolves to
 * null. `excludeId` drops the drive's own model-A thread (HS-9438).
 */
async function discoverLiveThreadForCwd(session: Session, cwd: string, excludeId: string | null): Promise<LoadedThreadEntry | null> {
  try {
    const loaded = loadedThreadIdsFromResponse(await request(session, 'thread/loaded/list', {}, 10_000));
    if (loaded.length === 0) return null; // nothing live → model-A
    // HS-9431 — read each LOADED thread's cwd via `thread/read` (not `thread/list`,
    // which misses a fresh terminal thread that has no on-disk rollout yet). Compare
    // realpath-normalized so `/var/…` vs `/private/var/…` (and any symlinked project
    // path) still matches.
    const target = realpathOrSelf(cwd);
    const entries: LoadedThreadEntry[] = [];
    for (const id of loaded) {
      if (id === excludeId) continue; // no point reading a thread we won't pick
      const read = await request(session, 'thread/read', { threadId: id, includeTurns: false }, 10_000).catch(() => null);
      const entry = threadReadEntry(id, read);
      if (entry !== null) entries.push({ ...entry, cwd: entry.cwd !== null ? realpathOrSelf(entry.cwd) : null });
    }
    return pickThreadForCwd(entries, target, excludeId);
  } catch {
    return null;
  }
}

/**
 * HS-9438 (docs/129 §129.3a) — ADOPT a discovered live thread as the drive's own.
 *
 * `thread/resume` serves two purposes on the daemon: it loads a cold thread, and it
 * SUBSCRIBES this connection to the thread's `turn/*` + `item/*` notifications
 * (live-verified: without it only `thread/status/changed` arrives). A discovered
 * thread is by definition already loaded, so resume is only needed for the
 * subscription — and it **fails** (`-32600 no rollout found`) on a freshly launched
 * `codex --remote` session, because the rollout JSONL isn't written until that
 * session's first turn completes. That failure used to abandon the discovered thread
 * and fall back to the drive's own off-screen thread, which is exactly the model-B
 * cold start (HS-9403) this whole design exists to fix.
 *
 * So: try to subscribe, but adopt EITHER WAY. Unsubscribed, `turn/start` still drives
 * the thread (live-verified) and `thread/status/changed` carries the busy/idle
 * lifecycle; `maybeRejoinLiveThread` upgrades to the full stream at the next turn
 * boundary, by which point the first driven turn has persisted a rollout.
 */
async function adoptLiveThread(session: Session, entry: LoadedThreadEntry, config: unknown): Promise<void> {
  const resumed = await request(session, 'thread/resume', { threadId: entry.id, config }, 60_000).catch(() => null);
  session.threadId = entry.id;
  session.subscribed = resumed !== null;
  persistThreadState(session.dataDir, entry.id, resumed !== null ? rolloutPathFromThreadPayload(resumed) : entry.rolloutPath);
}

/** The per-thread MCP override the drive pins on threads it resumes/starts itself
 *  (daemon only — see `bootSession`). Undefined on the stdio transport, whose child
 *  already inherits our cwd + env.
 *
 *  NOT needed for an ADOPTED terminal thread: the daemon spawns a thread's MCP
 *  children with THAT THREAD's cwd (live-verified via `lsof` on the channel-server
 *  child), and the global `hotsheet-channel` entry resolves its data dir from cwd —
 *  so a terminal launched with `-C <projectDir>` already reaches the right project. */
function threadConfigOverride(session: Session): unknown {
  return session.transport?.kind === 'daemon'
    ? buildThreadMcpOverride(CODEX_MCP_KEY, getChannelServerPath(), session.dataDir)
    : undefined;
}

/**
 * HS-9438 — re-run model-B discovery at a turn boundary, so the drive joins the
 * terminal's thread even when the terminal was opened AFTER the first play (boot-time
 * discovery is a single shot, and the session lives for the whole server process).
 * Also upgrades an adopted-but-unsubscribed thread to the full event stream once its
 * rollout exists. Best-effort: any failure leaves the current thread in place.
 */
async function maybeRejoinLiveThread(session: Session): Promise<void> {
  if (!codexDriveDiscoverEnabled() || session.transport?.kind !== 'daemon') return;
  const entry = await discoverLiveThreadForCwd(session, dirname(session.dataDir), session.modelAThreadId).catch(() => null);
  if (entry === null) return;
  if (entry.id === session.threadId && session.subscribed) return; // already joined + subscribed
  await adoptLiveThread(session, entry, threadConfigOverride(session));
}

/** realpath a path, falling back to the input if it can't be resolved (e.g. it no
 *  longer exists). Used to canonicalize cwds before the model-B match (HS-9431). */
function realpathOrSelf(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}

/**
 * HS-9429 (docs/129 §129.4, model-B Phase 2) — the DAEMON-HOSTED terminal launch
 * for a codex project: `codex --remote 'unix://<sock>' -C '<projectDir>'`. This
 * launches a FRESH daemon-hosted session that OWNS its own live thread — the drive
 * then DISCOVERS it by cwd (HS-9428) and drives it in place.
 * `-C <projectDir>` pins the session cwd to the project (= `dirname(dataDir)`) so
 * the drive's `pickThreadForCwd` matches it.
 *
 * HS-9430 retired the model-A counterpart this replaced (`codexTerminalAttachCommand`
 * — `codex resume <driveThreadId> --remote`, where the terminal chased the drive's
 * thread at launch time and needed a "↻ Rejoin codex" affordance whenever that race
 * was lost). Under model-B there is nothing to chase: the terminal's own thread is
 * the driven one.
 *
 * Returns null (→ caller falls back to plain `codex`) when the model-B gate is off,
 * the drive is disabled, or the daemon socket isn't up yet. Sync — the daemon is
 * ensured BEFORE this resolves (see `codexTerminalNeedsDaemonEnsure` +
 * `spawnIntoSession`), so a null here means "daemon genuinely unavailable".
 *
 * Continuity is deliberately per-open FRESH (maintainer decision HS-9429): a new
 * conversation each terminal open; users run `/resume` inside codex to continue a
 * prior session.
 */
export function codexTerminalRemoteCommand(dataDir: string, deps: CodexCommandDeps = {}): string | null {
  if (!codexDriveDiscoverEnabled() || !isCodexAppServerEnabled()) return null;
  const socketPath = deps.socketPath ?? codexDaemonSocketPath();
  const fileExists = deps.fileExists ?? existsSync;
  if (!fileExists(socketPath)) return null; // daemon not up → plain codex fallback
  // Single-quote the URL + cwd — home/project dirs can contain spaces.
  return `codex --remote 'unix://${socketPath}' -C '${dirname(dataDir)}'`;
}

/**
 * HS-9429 (docs/129 §129.4) — should the terminal spawn AWAIT the daemon before
 * launching? True only when model-B is on for a codex project AND the daemon socket
 * isn't up yet — i.e. the one cold case where `codex --remote` would otherwise have
 * nothing to connect to. `spawnIntoSession` uses this to defer the (rare) cold spawn
 * behind `ensureCodexDaemonRunning`; every other spawn stays synchronous.
 */
export function codexTerminalNeedsDaemonEnsure(dataDir: string, deps: CodexCommandDeps = {}): boolean {
  // Env gate first (cheap) — short-circuits without the config/settings reads on the
  // default (gate-off) path, since this runs on every terminal spawn.
  if (!codexDriveDiscoverEnabled() || !isCodexAppServerEnabled()) return false;
  const tool = readFileSettings(dataDir).ai_tool;
  if (typeof tool !== 'string' || tool.trim().toLowerCase() !== 'codex') return false;
  const socketPath = deps.socketPath ?? codexDaemonSocketPath();
  const fileExists = deps.fileExists ?? existsSync;
  return !fileExists(socketPath); // only when the daemon isn't already up
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
    if (session.midTurnSubscribeTimer !== null) clearTimeout(session.midTurnSubscribeTimer);
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
    subscribed: false,
    modelAThreadId: readPersistedThreadId(dataDir),
    currentTurnId: null,
    turnEndsOnStatus: false,
    midTurnSubscribeTimer: null,
    turnStartPending: false,
    phase: 'booting',
    queue: [],
    heartbeatTimer: null,
    pendingPermissionIds: new Set(),
    pendingPermissionByCodexId: new Map(),
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
  const config = threadConfigOverride(session);
  let threadId: string | null = null;

  // HS-9428 (docs/121 model-B) — prefer an EXISTING live thread for this project's
  // cwd (the terminal's own daemon session), so driven turns land in the window the
  // user is watching instead of a separate drive-owned thread. Daemon-only (a stdio
  // child has no shared thread to discover). On any failure — older daemon without
  // the list methods, nothing live — fall through to model-A below, so the play
  // button always works. HS-9438: adoption no longer requires a successful
  // `thread/resume` (see `adoptLiveThread`).
  let adopted = false;
  if (codexDriveDiscoverEnabled() && session.transport?.kind === 'daemon') {
    const discovered = await discoverLiveThreadForCwd(session, dirname(session.dataDir), session.modelAThreadId).catch(() => null);
    if (discovered !== null) {
      await adoptLiveThread(session, discovered, config);
      threadId = session.threadId;
      adopted = true;
    }
  }

  const persisted = threadId === null ? session.modelAThreadId : null;
  if (persisted !== null) {
    // O3 — auto-fresh ONLY when resume fails (missing/corrupt rollout).
    const resumed = await request(session, 'thread/resume', { threadId: persisted, config }, 60_000).catch(() => null);
    if (resumed !== null) {
      threadId = persisted;
      session.subscribed = true;
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
    session.subscribed = true; // a thread we started ourselves is subscribed
    persistThreadState(session.dataDir, threadId, rolloutPathFromThreadPayload(started));
  }
  session.threadId = threadId;
  // HS-9438 — when boot fell back to model-A (resumed the persisted thread, or started
  // a fresh one), THAT thread is drive-owned: record it so later discoveries exclude
  // it. Without this a drive-started thread wins every rejoin on recency, since each
  // driven turn bumps its `recencyAt` past the terminal's. An ADOPTED thread is the
  // terminal's, not ours — leave the exclusion alone.
  if (!adopted) session.modelAThreadId = threadId;
  session.phase = 'idle';
  handshakeFailed.delete(session.dataDir); // a healthy boot clears any stale failure flag
  if (session.queue.length > 0) void startNextTurn(session);
}

/** Can a turn still be started? Read through a call deliberately: the checks straddle
 *  an `await`, and the narrowing from the caller's earlier guard would otherwise make
 *  them look statically dead — while a teardown really can land mid-turn. */
function isSessionDrivable(session: Session): boolean {
  return !session.finished && session.threadId !== null;
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
  // HS-9438 — re-check model-B discovery at the turn boundary (a terminal opened
  // after the first play; an adopted thread whose rollout now exists and can be
  // subscribed). Deliberately AFTER `phase = 'active'`: that assignment is what makes
  // a concurrent play queue instead of starting a second turn, so it must stay
  // synchronous with respect to this function's entry.
  await maybeRejoinLiveThread(session);
  if (!isSessionDrivable(session)) { onTurnEnded(session); return; }
  // HS-9439 — pin this turn's ending rule BEFORE sending it (see `turnEndsOnStatus`).
  session.turnEndsOnStatus = !session.subscribed;
  // HS-9448 — arm the guard before the send: until the ack lands, any `idle` we see
  // belongs to somebody else's turn, not ours (docs/129 §129.10).
  session.turnStartPending = true;
  // Spike finding: the response is an immediate ack (turn inProgress) — completion
  // arrives via `turn/completed`. A rejected turn/start (e.g. thread unloaded)
  // falls back to ending the "turn" so busy can't stick.
  const acked = await request(session, 'turn/start', {
    threadId: session.threadId,
    input: [{ type: 'text', text: content }],
  }, 120_000).then(() => true).catch(() => false);
  // Disarm BEFORE `onTurnEnded`: it can drain the queue straight back into
  // `startNextTurn`, and that re-entrant call must not have its own arm clobbered by
  // this one's disarm.
  session.turnStartPending = false;
  if (!acked) onTurnEnded(session);
  scheduleMidTurnSubscribe(session, 0);
}

/** HS-9439 — retry delays (ms after the `turn/start` ack) for the mid-turn subscribe.
 *  Measured once at ~1.06 s (docs/129 §129.9 fact 5); the later attempts cover a
 *  slower first turn without turning this into a poll. */
const MID_TURN_SUBSCRIBE_DELAYS_MS = [1_500, 3_000, 6_000];

/**
 * HS-9439 (docs/129 §129.9 fact 5) — subscribe to a turn that is ALREADY RUNNING.
 *
 * An adopted terminal thread can't be subscribed at adoption time: `thread/resume`
 * answers "no rollout found" until a rollout JSONL exists (§129.3a). But the rollout
 * is written ~1 s INTO the first turn, not at the end (measured: file at +1058 ms,
 * resume OK at +1063 ms, turn still running until +6069 ms) — and resuming mid-turn is
 * non-disruptive: the turn completes normally and we start receiving its `item/*`
 * stream. So instead of waiting for the next turn boundary, retry shortly after the
 * turn starts. That buys two things for the FIRST driven turn after a terminal opens:
 *  - per-item Commands Log transcript detail (this ticket), and
 *  - approvals, which codex routes by SUBSCRIPTION rather than to whoever started the
 *    turn (§129.9 fact 2) — unsubscribed, the §47 overlay never sees them and the
 *    `codex_interactive_permissions: false` auto-accept can't apply.
 *
 * `config` is deliberately omitted: HS-9438 established the per-thread MCP override
 * isn't needed for an adopted thread (the daemon spawns a thread's MCP children with
 * THAT thread's cwd), and re-sending it mid-turn provokes MCP server restarts while a
 * tool call may be in flight. Best-effort throughout — a failure just leaves the turn
 * ending the way it already was (`turnEndsOnStatus`).
 */
function scheduleMidTurnSubscribe(session: Session, attempt: number): void {
  if (session.midTurnSubscribeTimer !== null) { clearTimeout(session.midTurnSubscribeTimer); session.midTurnSubscribeTimer = null; }
  if (session.subscribed || session.finished || session.phase !== 'active') return;
  if (session.transport?.kind !== 'daemon') return; // stdio owns its own thread — always subscribed
  if (attempt >= MID_TURN_SUBSCRIBE_DELAYS_MS.length) return; // ladder exhausted — not a poll
  const delay = MID_TURN_SUBSCRIBE_DELAYS_MS[attempt];
  const timer = setTimeout(() => {
    session.midTurnSubscribeTimer = null;
    if (session.subscribed || session.finished || session.phase !== 'active' || session.threadId === null) return;
    const threadId = session.threadId;
    void request(session, 'thread/resume', { threadId }, 30_000)
      .then((resumed) => {
        // Guard again: the turn (or the session) can end while the resume is in flight.
        if (session.finished || session.threadId !== threadId) return;
        session.subscribed = true;
        persistThreadState(session.dataDir, threadId, rolloutPathFromThreadPayload(resumed));
      })
      .catch(() => { scheduleMidTurnSubscribe(session, attempt + 1); });
  }, delay);
  timer.unref();
  session.midTurnSubscribeTimer = timer;
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
  // HS-9447 — another client answered a shared approval; drop our popup for it.
  if (msg.method === 'serverRequest/resolved') {
    handleServerRequestResolved(session, msg.params);
    return;
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
    // HS-9439 — a turn already closed by the thread-status path (adopted-unsubscribed)
    // leaves `currentTurnId` null, and the daemon still delivers `turn/completed` for it
    // once a mid-turn resubscribe lands. The Commands Log entry is already closed, so
    // don't post a second 'end' for it (the server drops an unknown turn id anyway).
    // A FOREIGN turn (an attached TUI's) does have an id here and must still be posted.
    if (session.currentTurnId !== null) {
      session.deps.postTranscript(session.serverPort, session.secret, { phase: 'end', turnId: session.currentTurnId, status: event.status ?? 'completed' });
    }
    // HS-9388/HS-9394 — on a SHARED thread another client (an attached TUI) can run
    // turns too; those still stream to the transcript above, but only a turn WE
    // started (phase 'active') drives the busy/done lifecycle.
    if (session.phase === 'active') onTurnEnded(session);
    else session.currentTurnId = null;
  } else if (event.active) {
    // thread-status active — event-driven busy reassertion (spike finding).
    if (session.phase === 'active') session.deps.postHeartbeat(session.serverPort, session.secret, 'heartbeat');
  } else if (session.turnEndsOnStatus && session.phase === 'active' && !session.turnStartPending) {
    // HS-9438 — thread-status IDLE ends the turn on an adopted-but-unsubscribed
    // thread, where `turn/completed` never arrives (live-verified: without a
    // `thread/resume` subscription the daemon sends only `thread/status/changed`).
    // Gated because a SUBSCRIBED session gets idle-then-completed for the same turn,
    // and ending it twice would double-fire done/transcript.
    // HS-9439 — the gate is the per-turn `turnEndsOnStatus` snapshot, not a live
    // `!subscribed` read: a mid-turn resubscribe must not change how the turn already
    // in flight ends. (It does add a `turn/completed` for that turn, but idle arrives
    // first — measured — so this branch ends it and the later `turn-ended` sees
    // phase !== 'active' and no-ops.)
    // HS-9448 — `turnStartPending` closes the premature-idle race: between
    // `phase = 'active'` and our `turn/start` landing (the `maybeRejoinLiveThread`
    // discovery round-trip) a FOREIGN turn's idle would otherwise end a turn we
    // haven't even sent yet. Waiting on a response we always get, rather than on an
    // `active` transition codex may never emit, is why this guard can't stick busy —
    // the failure mode that got the HS-9438 candidate rejected (docs/129 §129.10).
    session.deps.postTranscript(session.serverPort, session.secret, { phase: 'end', turnId: session.currentTurnId ?? '', status: 'completed' });
    onTurnEnded(session);
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
    const entry = trackPendingPermission(session, id, request_id);
    try {
      const reply = await promise;
      if (!entry.externallyResolved) write(session, buildResponseLine(id, elicitationResponseFromReply(reply)));
    } finally {
      forgetPendingPermission(session, id, request_id);
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
  const entry = trackPendingPermission(session, id, request_id);
  try {
    const reply = await promise;
    if (!entry.externallyResolved) write(session, buildResponseLine(id, decisionFromReply(reply)));
  } finally {
    forgetPendingPermission(session, id, request_id);
  }
}

/** HS-9447 — register an open overlay under BOTH keys: the bridge id (for the
 *  dismiss-everything paths) and codex's request id (for the targeted dismissal). */
function trackPendingPermission(session: Session, codexId: number | string, bridgeId: string): PendingPermissionEntry {
  session.pendingPermissionIds.add(bridgeId);
  const entry: PendingPermissionEntry = { bridgeId, externallyResolved: false };
  session.pendingPermissionByCodexId.set(String(codexId), entry);
  return entry;
}

function forgetPendingPermission(session: Session, codexId: number | string, bridgeId: string): void {
  session.pendingPermissionIds.delete(bridgeId);
  session.pendingPermissionByCodexId.delete(String(codexId));
}

/**
 * HS-9447 (docs/129 §129.9 fact 2) — codex asks EVERY subscribed client about the same
 * approval, with the same request id, and broadcasts a `serverRequest/resolved`
 * notification (`{ threadId, requestId }`) as soon as one of them answers. Under model-B that other
 * client is the terminal TUI the user is looking at, so answering there used to leave
 * Hot Sheet's §47 overlay standing — asking about a decision already made, and sending
 * a reply for a request codex had closed.
 *
 * Dismiss the overlay and mark the entry so the awaiting handler skips its write. Our
 * OWN reply also produces this notification, but by then the entry is gone (the finally
 * block ran), so it is a no-op — no need to distinguish who answered.
 */
function handleServerRequestResolved(session: Session, params: Record<string, unknown>): void {
  const raw = params.requestId;
  if (typeof raw !== 'string' && typeof raw !== 'number') return;
  const entry = session.pendingPermissionByCodexId.get(String(raw));
  if (entry === undefined) return;
  entry.externallyResolved = true;
  dismissAcpPermission(entry.bridgeId);
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
  if (session.midTurnSubscribeTimer !== null) { clearTimeout(session.midTurnSubscribeTimer); session.midTurnSubscribeTimer = null; }
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
