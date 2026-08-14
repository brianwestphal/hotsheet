// HS-7945 / HS-8981 — client side of the WebSocket push channel (docs/93
// §93.5/§93.6). Connects to `/ws/sync`, and while connected it OWNS the
// ticket-data refresh (the long-poll in `poll.tsx` skips its data branch via
// `isWsActive()`), so a mutation on any client lands here as a push.
//
// HS-8984 — a pushed mutation is applied to the in-memory `ticketsStore` IN
// PLACE where possible (`reduceMutation` → `optimisticUpdate` / `removeTicket`),
// avoiding a full `loadTickets` refetch (the §93.5 bandwidth win). When a change
// could transition a NOT-loaded ticket into the active view, or is otherwise
// placement-sensitive, it falls back to a coalesced refetch — correct, not a
// guess. The store + `filteredTickets` re-render the affected rows.
//
// Reconnect: exponential backoff (1s→30s). Fallback: if the socket can't hold
// (drops twice within 30s, or never connects), surface a "live updates
// unavailable" hint and let the long-poll carry data until the WS recovers.

import type { PartitionAssignment } from '../api/workers.js';
import { httpOriginToWs } from './remoteOrigin.js';
import { getActiveProject, shouldResetStatusOnUpNext } from './state.js';
import { ticketsStore } from './ticketsStore.js';

const FALLBACK_WINDOW_MS = 30_000;
const FALLBACK_DROP_THRESHOLD = 2;

/** Exponential backoff: 1s, 2s, 4s, … capped at 30s. */
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/** Fall back to polling once the socket has dropped `FALLBACK_DROP_THRESHOLD`
 *  times inside the trailing `FALLBACK_WINDOW_MS`. */
export function shouldFallback(dropTimestamps: readonly number[], now: number): boolean {
  const recent = dropTimestamps.filter((t) => now - t <= FALLBACK_WINDOW_MS);
  return recent.length >= FALLBACK_DROP_THRESHOLD;
}

export type FrameAction = 'data' | 'detail' | 'claims' | 'active-device' | 'partition-proposed' | 'pong' | 'connected' | 'resync' | 'ignore';

/** Classify an inbound frame `type` into the action the client takes.
 *  Mutation events → a full data refresh; attachment events → a detail-panel
 *  refresh (they don't change a list row); claim changes → a claims refresh;
 *  control frames handled by name. */
export function frameAction(type: unknown): FrameAction {
  switch (type) {
    case 'ping': return 'pong';
    case 'pong': return 'ignore';
    case 'connected': return 'connected';
    case 'resync': return 'resync';
    case 'claims-changed': return 'claims';
    // HS-9191 — the active-device lease changed (docs/109 §109.5); the client
    // flips its terminals live↔placeholder based on whether it's the holder.
    case 'active-device-changed': return 'active-device';
    // HS-9112 — the agent proposed a worker partition for review (docs/101 §101.7);
    // the client opens the partition editor with the proposed plan.
    case 'worker-partition-proposed': return 'partition-proposed';
    case 'attachment-added':
    case 'attachment-deleted': return 'detail';
    case 'ticket-created':
    case 'ticket-updated':
    case 'ticket-deleted':
    case 'note-added':
    case 'note-deleted':
    case 'category-changed':
    case 'priority-changed':
    case 'status-changed':
    case 'settings-changed':
    case 'batch-operation': return 'data';
    default: return 'ignore';
  }
}

/** The in-memory store operations a mutation frame reduces to. */
export interface MutationApply {
  remove: number[];
  optimistic: { id: number; patch: Record<string, unknown> }[];
  refetch: boolean;
}

function toIdList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}
function toRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** HS-9191 — the holder id off an `active-device-changed` frame (null = freed). */
function activeDeviceIdOf(frame: Record<string, unknown>): string | null {
  return typeof frame.deviceId === 'string' && frame.deviceId !== '' ? frame.deviceId : null;
}

/** HS-9112 — the proposed assignment off a `worker-partition-proposed` frame. The
 *  frame was server-validated against the sync schema, so this narrows the shape
 *  defensively and returns [] on anything unexpected. */
function proposedAssignmentsOf(frame: Record<string, unknown>): PartitionAssignment[] {
  const raw = frame.assignments;
  if (!Array.isArray(raw)) return [];
  const out: PartitionAssignment[] = [];
  for (const a of raw) {
    if (a === null || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    const ids = Array.isArray(rec.ticketIds) ? rec.ticketIds.filter((x): x is number => typeof x === 'number') : [];
    const nums = Array.isArray(rec.ticketNumbers) ? rec.ticketNumbers.filter((x): x is string => typeof x === 'string') : [];
    out.push({
      worker: typeof rec.worker === 'string' ? rec.worker : '',
      label: typeof rec.label === 'string' ? rec.label : '',
      ticketIds: ids,
      ticketNumbers: nums,
    });
  }
  return out;
}

/**
 * HS-8984 — reduce a sequenced mutation frame to in-place store ops, so the
 * common cases don't trigger a full `loadTickets` refetch (the §93.5 bandwidth
 * win). Loaded tickets are mutated in place — the store + `filteredTickets`
 * already re-render the row, move it between columns, and add/drop it from the
 * active view correctly. **But** if an affected ticket ISN'T loaded, a remote
 * change might transition it INTO the active view, which an in-place update
 * can't represent — so we refetch (correct, not a guess). Placement-sensitive
 * events (`ticket-created` / batch `restore`), `settings-changed`, note events,
 * and anything unrecognized also refetch.
 */
export function reduceMutation(frame: Record<string, unknown>, hasTicket: (id: number) => boolean): MutationApply {
  const REFETCH: MutationApply = { remove: [], optimistic: [], refetch: true };
  const inPlace = (patches: { id: number; patch: Record<string, unknown> }[]): MutationApply =>
    patches.every(p => hasTicket(p.id)) ? { remove: [], optimistic: patches, refetch: false } : REFETCH;

  switch (frame.type) {
    case 'ticket-deleted':
      return { remove: [Number(frame.id)], optimistic: [], refetch: false };
    case 'ticket-updated':
      return inPlace([{ id: Number(frame.id), patch: toRecord(frame.changes) }]);
    case 'category-changed':
      return inPlace(toIdList(frame.ticketIds).map(id => ({ id, patch: { category: frame.to } })));
    case 'priority-changed':
      return inPlace(toIdList(frame.ticketIds).map(id => ({ id, patch: { priority: frame.to } })));
    case 'status-changed': {
      // HS-9043 — a "done/parked" status (completed / verified / backlog / archive)
      // also clears up_next server-side; mirror that here so the batch status path's
      // UI matches the DB (otherwise the up-next star lingers until a full poll).
      const to = typeof frame.to === 'string' ? frame.to : '';
      const clearsUpNext = shouldResetStatusOnUpNext(to);
      return inPlace(toIdList(frame.ticketIds).map(id => ({
        id, patch: clearsUpNext ? { status: to, up_next: false } : { status: to },
      })));
    }
    case 'batch-operation': {
      const ids = toIdList(frame.ids);
      if (frame.op === 'delete' || frame.op === 'empty-trash') return { remove: ids, optimistic: [], refetch: false };
      if (frame.op === 'up_next') return inPlace(ids.map(id => ({ id, patch: { up_next: toRecord(frame.changes).up_next } })));
      return REFETCH; // restore (+ anything else) is placement-sensitive
    }
    default:
      return REFETCH; // ticket-created, settings-changed, note-*, unknown
  }
}

/** Minimal WebSocket surface the module uses (real `WebSocket` satisfies it). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface WsSyncDeps {
  createSocket: (url: string) => WsLike;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Schedule a full ticket-data refresh (coalesced by the caller). */
  refreshData: () => void;
  /** Refresh the open detail panel (attachment changes). */
  refreshDetail: () => void;
  /** HS-9176 — refresh the server-fetched status-bar stats + sidebar count
   *  badges. In-place applies update the rows reactively, but the bar's
   *  "Z up next" / "Y open" counts and the sidebar badges come from
   *  `/api/stats` + `/api/sidebar-counts`, so they go stale without this. */
  refreshStats: () => void;
  /** Refresh the distributed-execution claim set (claimed-by chip). */
  refreshClaims: () => void;
  /** HS-9244 — recompute the active project's feedback state (tab purple dot +
   *  feedback dialog). The refetch path already does this; the in-place apply
   *  path must call it too when a `notes` change arrives, or a live
   *  FEEDBACK-NEEDED note leaves the tab dot stale until a project switch. */
  refreshFeedback: () => void;
  /** HS-8984 — is a ticket currently in the in-memory list? (drives in-place
   *  apply vs refetch). */
  hasTicket: (id: number) => boolean;
  /** Remove a ticket from the in-memory list (no-op if absent). */
  removeTicket: (id: number) => void;
  /** Merge a patch into a loaded ticket (no-op if absent). */
  optimisticUpdate: (id: number, patch: Record<string, unknown>) => void;
  /** Show / hide the "live updates unavailable" hint. */
  showHint: (show: boolean) => void;
  /** The active project's secret (the bus key), or null when none. */
  getSecret: () => string | null;
  /** Build the `/ws/sync` URL for a secret + optional `?since`. */
  buildUrl: (secret: string, since: number | undefined) => string;
  /** HS-9191 — an `active-device-changed` event arrived: the current holder's
   *  device id, or null when the slot is now free. Drives the terminal
   *  live↔placeholder flip. */
  onActiveDeviceChanged: (deviceId: string | null) => void;
  /** HS-9112 — a `worker-partition-proposed` event arrived: the agent's proposed
   *  assignment. Opens the partition editor for owner review. */
  onWorkerPartitionProposed: (assignments: PartitionAssignment[]) => void;
  /** HS-9305 — report the connection state for a project's `/ws/sync` (docs/112
   *  §112.8) so a remote project's tab can show connected/reconnecting/unreachable. */
  setConnectivity: (secret: string, state: 'connected' | 'reconnecting' | 'unreachable') => void;
}

export interface WsSync {
  start(): void;
  stop(): void;
  /** True while a live socket is connected (the poll skips its data branch). */
  isActive(): boolean;
  /** Reconnect for the (possibly changed) active project — call on project switch. */
  reconnectForActiveProject(): void;
  /** TEST hook — feed a raw frame object as if received. */
  _receive(frame: unknown): void;
}

/**
 * HS-9658 — client liveness deadline. The server pings every 20s
 * (`routes/wsSync.ts` HEARTBEAT_INTERVAL_MS), so if NO frame (ping or mutation)
 * arrives for this long the socket is half-open: the `onclose` that flips
 * `active=false` never fired, so the poll fallback stays suppressed and nothing
 * refetches (a big contributor to the HS-9653 "excessively long" staleness for
 * non-acting clients). On timeout we tear the socket down and reconnect. 2.5× the
 * ping interval so a couple of dropped pings don't false-trip it.
 */
export const LIVENESS_TIMEOUT_MS = 50_000;

export function createWsSync(deps: WsSyncDeps): WsSync {
  let socket: WsLike | null = null;
  let active = false;
  let fallback = false;
  let lastSeq: number | undefined;
  let connectedSecret: string | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown = null;
  let livenessTimer: unknown = null;
  let stopped = true;
  const drops: number[] = [];

  function clearReconnect(): void {
    if (reconnectTimer !== null) { deps.clearTimer(reconnectTimer); reconnectTimer = null; }
  }

  // HS-9658 — (re)arm the liveness deadline. Called on connect + on every frame,
  // so any server activity (ping or mutation) keeps the socket "alive". If it fires,
  // no frame arrived for LIVENESS_TIMEOUT_MS → the socket is half-open (no `onclose`),
  // so treat it as a disconnect: tear down and reconnect, which flips `active=false`
  // and lets the poll fallback resume.
  function clearLiveness(): void {
    if (livenessTimer !== null) { deps.clearTimer(livenessTimer); livenessTimer = null; }
  }
  function armLiveness(): void {
    clearLiveness();
    livenessTimer = deps.setTimer(() => {
      livenessTimer = null;
      teardownSocket(); // removes onclose, so it won't also fire onDisconnect
      onDisconnect();
    }, LIVENESS_TIMEOUT_MS);
  }

  function teardownSocket(): void {
    clearLiveness();
    if (socket !== null) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch { /* ignore */ }
      socket = null;
    }
  }

  function connect(): void {
    if (stopped) return;
    const secret = deps.getSecret();
    if (secret === null || secret === '') return; // no project yet — wait for a switch
    connectedSecret = secret;
    const url = deps.buildUrl(secret, lastSeq);
    const ws = deps.createSocket(url);
    socket = ws;
    ws.onopen = () => { armLiveness(); /* `connected` frame confirms; nothing else yet */ };
    ws.onmessage = (ev) => {
      armLiveness(); // HS-9658 — any received frame proves the socket is alive
      let frame: unknown;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      handleFrame(frame);
    };
    ws.onclose = () => onDisconnect();
    ws.onerror = () => { /* a close follows; handle there */ };
  }

  function handleFrame(frame: unknown): void {
    if (frame === null || typeof frame !== 'object') return;
    const f = frame as { type?: unknown; seq?: unknown };
    const action = frameAction(f.type);
    if (action === 'pong') { sendPong(); return; }
    if (action === 'ignore') return;
    if (action === 'connected') {
      if (typeof f.seq === 'number') lastSeq = f.seq;
      markConnected();
      return;
    }
    if (action === 'resync') { deps.refreshData(); return; }
    // A sequenced mutation event — dedup by seq (refresh is idempotent, but this
    // tracks `lastSeq` for the next reconnect's `?since`).
    if (typeof f.seq === 'number') {
      if (lastSeq !== undefined && f.seq <= lastSeq) return;
      lastSeq = f.seq;
    }
    if (action === 'detail') deps.refreshDetail();
    else if (action === 'claims') deps.refreshClaims();
    else if (action === 'active-device') deps.onActiveDeviceChanged(activeDeviceIdOf(f));
    else if (action === 'partition-proposed') deps.onWorkerPartitionProposed(proposedAssignmentsOf(f));
    else applyMutation(f);
  }

  // HS-8984 — apply a ticket mutation in place where possible, else refetch.
  function applyMutation(frame: Record<string, unknown>): void {
    const plan = reduceMutation(frame, deps.hasTicket);
    if (plan.refetch) { deps.refreshData(); return; }
    for (const id of plan.remove) deps.removeTicket(id);
    for (const p of plan.optimistic) deps.optimisticUpdate(p.id, p.patch);
    // HS-9244 — a note append (e.g. a live FEEDBACK-NEEDED note) changes whether
    // the ticket + active-project tab should show the purple dot; the in-place
    // path otherwise never recomputes feedback state (only the refetch/poll path
    // does), so the tab dot stays stale until a project switch.
    if (plan.optimistic.some(p => 'notes' in p.patch)) deps.refreshFeedback();
    deps.refreshDetail(); // keep the open detail panel current
    // HS-9176 — the rows update reactively via the store, but the status-bar
    // counts + sidebar badges are server-fetched and aren't subscribed to it,
    // so refresh them too (e.g. a channel/AI or other-device up_next toggle
    // otherwise left "Z up next" stale until a project switch).
    deps.refreshStats();
  }

  function sendPong(): void {
    if (socket !== null && socket.readyState === 1) {
      try { socket.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
    }
  }

  function markConnected(): void {
    active = true;
    reconnectAttempt = 0;
    if (fallback) { fallback = false; deps.showHint(false); }
    // HS-9305 — per-project connectivity (docs/112 §112.8): this project's socket
    // is live → 'connected'.
    if (connectedSecret !== null) deps.setConnectivity(connectedSecret, 'connected');
  }

  function onDisconnect(): void {
    socket = null;
    active = false;
    drops.push(deps.now());
    if (!fallback && shouldFallback(drops, deps.now())) {
      fallback = true;
      deps.showHint(true);
    }
    // HS-9305 — repeated drops within the window ⇒ 'unreachable'; a first/transient
    // drop while the backoff retries ⇒ 'reconnecting'.
    if (connectedSecret !== null) deps.setConnectivity(connectedSecret, fallback ? 'unreachable' : 'reconnecting');
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    clearReconnect();
    const delay = backoffDelay(reconnectAttempt);
    reconnectAttempt++;
    reconnectTimer = deps.setTimer(() => { reconnectTimer = null; connect(); }, delay);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearReconnect();
      teardownSocket();
      active = false;
    },
    isActive() {
      return active;
    },
    reconnectForActiveProject() {
      const secret = deps.getSecret();
      if (secret === connectedSecret && socket !== null) return; // already on it
      // Different project → a different per-project seq line; start fresh.
      lastSeq = undefined;
      reconnectAttempt = 0;
      clearReconnect();
      teardownSocket();
      active = false;
      connect();
    },
    _receive(frame) { handleFrame(frame); },
  };
}

// --- Production instance ----------------------------------------------------

function buildWsUrl(secret: string, since: number | undefined): string {
  // HS-9302 (docs/112 §112.4) — a REMOTE project's `/ws/sync` targets its origin
  // (`wss://host`); a local project stays same-origin as today. `secret` is the
  // active project's, so resolve its origin from the active project.
  const ap = getActiveProject();
  const origin = ap?.secret === secret ? ap.origin : undefined;
  const base = origin !== undefined && origin !== ''
    ? httpOriginToWs(origin)
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  const sinceQuery = since !== undefined ? `&since=${String(since)}` : '';
  return `${base}/ws/sync?project=${encodeURIComponent(secret)}${sinceQuery}`;
}

function toggleHintBanner(show: boolean): void {
  const el = document.getElementById('live-updates-banner');
  if (el !== null) el.style.display = show ? '' : 'none';
}

let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce a burst of pushed events into one refresh (a batch import or a
 *  fast editor can fire many events back-to-back). */
function scheduleCoalescedRefresh(): void {
  if (coalesceTimer !== null) return;
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    void runDataRefresh();
  }, 30);
}

async function runDataRefresh(): Promise<void> {
  // Lazy imports avoid a static import cycle (poll.ts ↔ wsSync.ts both reach
  // into ticketList/detail/feedback).
  const [{ loadTickets }, { refreshDetail }, { checkFeedbackState }, { state }] = await Promise.all([
    import('./ticketList.js'),
    import('./detail.js'),
    import('./feedbackDialog.js'),
    import('./state.js'),
  ]);
  if (state.backupPreview?.active === true) return;
  await loadTickets();
  refreshDetail();
  void checkFeedbackState();
}

function runDetailRefresh(): void {
  void import('./detail.js').then(({ refreshDetail }) => refreshDetail());
}

let statsCoalesceTimer: ReturnType<typeof setTimeout> | null = null;

/** HS-9176 — coalesce a burst of in-place applies into one status-bar +
 *  sidebar-count refresh (`updateStats` re-fetches `/api/stats` and kicks the
 *  already-debounced `refreshSidebarCounts`). */
function scheduleCoalescedStats(): void {
  if (statsCoalesceTimer !== null) return;
  statsCoalesceTimer = setTimeout(() => {
    statsCoalesceTimer = null;
    void import('./detail.js').then(({ updateStats }) => { void updateStats(); });
  }, 30);
}

function runClaimsRefresh(): void {
  void import('./claimsStore.js').then(({ refreshClaims }) => refreshClaims());
}

const wsSync = createWsSync({
  createSocket: (url) => new WebSocket(url) as unknown as WsLike,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  refreshData: scheduleCoalescedRefresh,
  refreshDetail: runDetailRefresh,
  refreshStats: scheduleCoalescedStats,
  refreshClaims: runClaimsRefresh,
  refreshFeedback: () => { void import('./feedbackDialog.js').then(({ checkFeedbackState }) => { void checkFeedbackState(); }); },
  hasTicket: (id) => ticketsStore.state.value.tickets.some(t => t.id === id),
  removeTicket: (id) => { ticketsStore.actions.removeTicket(id); },
  // The patch fields come from the server's validated ticket-update payload —
  // they ARE Ticket fields; the cast just bridges the loose wire Record.
  optimisticUpdate: (id, patch) => { ticketsStore.actions.optimisticUpdate(id, patch); },
  showHint: toggleHintBanner,
  getSecret: () => getActiveProject()?.secret ?? null,
  buildUrl: buildWsUrl,
  onActiveDeviceChanged: (deviceId) => {
    void import('./activeDevice.js').then(({ onActiveDeviceChangedEvent }) => onActiveDeviceChangedEvent(deviceId));
  },
  onWorkerPartitionProposed: (assignments) => {
    void import('./agentPartitionProposal.js').then(({ onWorkerPartitionProposed }) => onWorkerPartitionProposed(assignments));
  },
  setConnectivity: (secret, state) => {
    void import('./remoteConnectivity.js').then(({ setConnectivity }) => setConnectivity(secret, state));
  },
});

export function startWsSync(): void { wsSync.start(); }
export function isWsActive(): boolean { return wsSync.isActive(); }
export function reconnectWsForActiveProject(): void { wsSync.reconnectForActiveProject(); }
