/**
 * Cross-project bell indicator long-poll (HS-6603 Phase 2, docs/24-cross-project-bell.md §24.4.1).
 *
 * The companion server endpoint is `GET /api/projects/bell-state?v=<version>`,
 * which mirrors `/api/projects/permissions`: it aggregates the per-terminal
 * `bellPending` flag for every registered project and returns in one of two
 * ways — immediately when the client's `v` cursor is already behind the
 * server's `bellVersion`, or after a short server-side timeout when no state
 * has changed. We just loop and hand the latest snapshot to every subscriber.
 *
 * Two kinds of subscribers:
 *   - The project-tab indicator (`updateProjectBellIndicators` in projectTabs.tsx).
 *     Rendered from scratch inside this module on every tick so a new tab that
 *     missed earlier ticks still picks up current state.
 *   - Arbitrary consumers registered via `subscribeToBellState`. HS-6640 uses
 *     this to keep the in-drawer per-terminal indicator in sync when bells
 *     arrive while the user is inside the same project.
 */
import { api } from './api.js';
import { updateProjectBellIndicators } from './projectTabs.js';
import { getActiveProject } from './state.js';
import { fireNativeNotification, isAppBackgrounded } from './tauriIntegration.js';
import { showToast } from './toast.js';

export interface BellStateEntry {
  anyTerminalPending: boolean;
  terminalIds: string[];
  /** HS-7264 — map of terminalId → OSC 9 message for terminals whose shell
   *  pushed `\x1b]9;<message>\x07`. Only populated for entries with a message;
   *  bell-only entries (plain `\x07`) are absent from this map even though
   *  their id is in `terminalIds`. */
  notifications?: Record<string, string>;
}

export type BellStateMap = Map<string, BellStateEntry>;

type Subscriber = (state: BellStateMap) => void;

const subscribers = new Set<Subscriber>();
let currentState: BellStateMap = new Map();
let active = false;
let version = 0;

/** Start the long-poll loop (idempotent). Called once from app.tsx boot. */
export function startBellPolling(): void {
  if (active) return;
  active = true;
  void loop();
}

/** Stop the loop — only used by tests / teardown. */
export function stopBellPolling(): void {
  active = false;
}

/** Latest known bell state. Useful for modules that need a one-shot read
 *  rather than subscribing (e.g., a newly-rendered tab strip). */
export function getBellState(): BellStateMap {
  return currentState;
}

/** Register a callback that runs on every poll tick with the latest state.
 *  Returns an unsubscribe function. Also fires immediately with the current
 *  snapshot so late subscribers don't miss the already-known state. */
export function subscribeToBellState(cb: Subscriber): () => void {
  subscribers.add(cb);
  cb(currentState);
  return () => { subscribers.delete(cb); };
}

interface BellStateResponse {
  bells: Record<string, BellStateEntry>;
  v: number;
}

async function loop(): Promise<void> {
  while (active) {
    try {
      const data = await api<BellStateResponse>(`/projects/bell-state?v=${version}`);
      version = data.v;
      currentState = toMap(data.bells);
      dispatchOsc9Toasts(currentState);
      updateProjectBellIndicators(currentState);
      for (const cb of subscribers) {
        try { cb(currentState); } catch { /* subscriber errors shouldn't kill the loop */ }
      }
    } catch {
      // Network hiccup / server restart — pause before retrying to match the
      // permissions-poll pattern. Keeps the browser quiet during real outages.
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

/**
 * HS-7264 — fire a transient toast for each NEW OSC 9 desktop-notification
 * payload that arrives in a tick. Dedupe key is `{secret}::{terminalId}::{message}`
 * so a static unchanging message doesn't re-toast every 3-second long-poll
 * cycle, but repeated-but-different messages from the same terminal DO surface
 * (build server emits successive "stage X done" updates).
 *
 * Scope for v1: active project only. Cross-project notifications still set
 * the project-tab bell glyph so the user knows which project wanted attention;
 * the message surfaces in a toast the moment they switch projects (via
 * `fireToastsForActiveProject()` below, invoked from loadAndRenderTerminalTabs
 * on the /terminal/list seed). Rationale: an OSC 9 fired from a background
 * project should not yank the user out of what they're doing with a toast
 * unless they've chosen to look at that project.
 */
const recentlyToasted = new Map<string, string>();

function dispatchOsc9Toasts(state: BellStateMap): void {
  const active = getActiveProject();
  if (active === null) return;
  const entry = state.get(active.secret);
  const notes = entry?.notifications ?? {};
  for (const [terminalId, message] of Object.entries(notes)) {
    maybeFireNotificationToast(active.secret, terminalId, message);
  }
  gcRecentlyToasted(state);
}

/** Called from `terminal.tsx` on /terminal/list seed (project switch / first
 *  drawer open / settings save) so OSC 9 messages set while the client was
 *  disconnected or viewing another project still surface on return. */
export function fireToastsForActiveProject(
  entries: Array<{ id: string; notificationMessage?: string | null }>,
): void {
  const active = getActiveProject();
  if (active === null) return;
  for (const e of entries) {
    const msg = e.notificationMessage;
    if (typeof msg !== 'string' || msg === '') continue;
    maybeFireNotificationToast(active.secret, e.id, msg);
  }
}

function maybeFireNotificationToast(secret: string, terminalId: string, message: string): void {
  const key = `${secret}::${terminalId}`;
  if (recentlyToasted.get(key) === message) return;
  recentlyToasted.set(key, message);
  // 6 s default — OSC 9 messages are user-readable ("Build done", "Tests passed",
  // "Deploy failed — see logs"), longer than the 3 s plugin-action toast.
  showToast(message, { durationMs: 6000 });
  // HS-7272 — also surface a native OS notification when the Hot Sheet window
  // is backgrounded (hidden tab or another app focused). The toast is enough
  // when the user is already looking at Hot Sheet; when they aren't, the toast
  // will auto-fade before they return and they'd never see it. In a browser
  // context `fireNativeNotification` silently resolves false — the toast
  // alone carries the message. Dedupe is shared with the toast via the
  // `recentlyToasted` check above so a build server emitting the same message
  // on every long-poll tick doesn't spam the Notification Center either.
  if (isAppBackgrounded()) {
    const projectName = getActiveProject()?.name ?? 'Hot Sheet';
    void fireNativeNotification(projectName, message);
  }
}

/** Drop dedupe entries for terminals whose OSC 9 was cleared (bell ack) so a
 *  subsequent notification with the same text fires a fresh toast. */
function gcRecentlyToasted(state: BellStateMap): void {
  for (const key of [...recentlyToasted.keys()]) {
    const sep = key.indexOf('::');
    if (sep < 0) { recentlyToasted.delete(key); continue; }
    const secret = key.slice(0, sep);
    const terminalId = key.slice(sep + 2);
    const entry = state.get(secret);
    const stillPending = entry?.notifications?.[terminalId] === recentlyToasted.get(key);
    if (!stillPending) recentlyToasted.delete(key);
  }
}

function toMap(obj: Record<string, BellStateEntry>): BellStateMap {
  const m: BellStateMap = new Map();
  for (const [secret, entry] of Object.entries(obj)) {
    m.set(secret, entry);
  }
  return m;
}
