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

export interface BellStateEntry {
  anyTerminalPending: boolean;
  terminalIds: string[];
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

function toMap(obj: Record<string, BellStateEntry>): BellStateMap {
  const m: BellStateMap = new Map();
  for (const [secret, entry] of Object.entries(obj)) {
    m.set(secret, entry);
  }
  return m;
}
