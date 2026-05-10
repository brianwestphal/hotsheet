/**
 * §61 Phase 3d / HS-8320 — `channelStore` consolidating the Claude
 * channel + permission-overlay reactive state spread across
 * `channelUI.tsx` (11 module-level lets/maps) and `permissionOverlay.tsx`
 * (the `pendingPermissionStack` array + the `Set<string>` projection of
 * `minimizedRequests`).
 *
 * Per the FEEDBACK NEEDED design call on the ticket: scope = both files'
 * real reactive state. Lifecycle handles (timers, intervals, ResizeObserver,
 * checkout handles) stay where they are as plain refs — they are NOT state
 * in the kerf-store sense and have GC paths the store can't model.
 *
 * Two stores stay separate by design:
 *
 *   - `projectAttentionStore` in `channelUI.tsx` (HS-8238 Phase 1 trial) —
 *     keeps its own kerf store + getters to avoid disturbing the working
 *     trial. Read via `getProjectAttentionSecrets()`.
 *   - `permissionState` in `permissionOverlay.tsx` (HS-8190 single-slot
 *     bundle) — 80%+ lifecycle handles. Stays imperative.
 *
 * **Does NOT reset on project switch** — `busySecrets` /
 * `autoModeByProject` / `pendingPermissions` / `minimizedSecrets` are
 * intentionally cross-project. When production wires `resetAllStores()`
 * into a project-switch hook, this store must opt out (same constraint
 * as `projectsStore`).
 */
import type { PermissionData } from './permissionOverlay.js';
import { defineStore } from './reactive.js';

/** Pending-permission entry — request waiting for the active popup to clear. */
export interface PendingPermission {
  secret: string;
  perm: PermissionData;
}

export interface ChannelStoreState {
  /** Channel-server alive flag. Mirror of `/channel/status::alive`. */
  alive: boolean;
  /** Active project's busy flag. Mirrors `busySecrets.has(active.secret)`
   *  for the common single-project case but stays a separate slot so a
   *  setChannelBusy(false) on the boot path (no active project yet) is
   *  still meaningful. */
  busy: boolean;
  /** Shell-command-running flag — distinct from `busy` so the status
   *  indicator can show "Shell running" without conflicting with a
   *  simultaneous Claude busy state. */
  shellBusy: boolean;
  /** Per-project busy state. Cross-project — `extendBusyForProject` /
   *  `clearBusyForProject` mutate this, and the project-tab status dots
   *  read from it. */
  busySecrets: ReadonlySet<string>;
  /** Auto-mode toggle for the active project. */
  channelAutoMode: boolean;
  /** Per-project auto-mode memory. When the active project switches,
   *  `initChannel` reads from this map to restore the toggle for the
   *  new active project. Cross-project by design. */
  autoModeByProject: ReadonlyMap<string, boolean>;
  /** Exponential-backoff counter — consecutive auto-triggers that didn't
   *  result in Claude becoming busy. Resets to 0 on each successful
   *  busy-flip or on `toggleAutoMode`. */
  channelAutoBackoff: number;
  /** HS-6702 — most-recent Claude busy-spinner timestamp across all
   *  alive terminals in the active project. Polled every 2s while busy;
   *  null when no spinner has been seen recently. */
  mostRecentSpinnerAtMs: number | null;
  /** HS-8219 — stack of permissions queued behind the active popup.
   *  LIFO; the most recently arrived pops next when the active popup
   *  clears. Empty when no permissions are queued. */
  pendingPermissions: readonly PendingPermission[];
  /** Set of project secrets that currently have a minimized permission
   *  popup. Projection of `permissionOverlay.tsx::minimizedRequests`
   *  (the underlying `Map<requestId, MinimizedRecord>` carries timer
   *  handles + per-request metadata; the store holds only the secret
   *  projection so the project-tab dot updater can read it reactively). */
  minimizedSecrets: ReadonlySet<string>;
}

export const channelStore = defineStore({
  initial: (): ChannelStoreState => ({
    alive: false,
    busy: false,
    shellBusy: false,
    busySecrets: new Set<string>(),
    channelAutoMode: false,
    autoModeByProject: new Map<string, boolean>(),
    channelAutoBackoff: 0,
    mostRecentSpinnerAtMs: null,
    pendingPermissions: [],
    minimizedSecrets: new Set<string>(),
  }),
  actions: (set, get) => ({
    setAlive: (alive: boolean) => { set({ ...get(), alive }); },
    setBusy: (busy: boolean) => { set({ ...get(), busy }); },
    setShellBusy: (shellBusy: boolean) => { set({ ...get(), shellBusy }); },
    markBusySecret: (secret: string) => {
      const cur = get();
      if (cur.busySecrets.has(secret)) return;
      const next = new Set(cur.busySecrets);
      next.add(secret);
      set({ ...cur, busySecrets: next });
    },
    clearBusySecret: (secret: string) => {
      const cur = get();
      if (!cur.busySecrets.has(secret)) return;
      const next = new Set(cur.busySecrets);
      next.delete(secret);
      set({ ...cur, busySecrets: next });
    },
    setChannelAutoMode: (channelAutoMode: boolean) => { set({ ...get(), channelAutoMode }); },
    setAutoModeForProject: (secret: string, auto: boolean) => {
      const cur = get();
      const next = new Map(cur.autoModeByProject);
      next.set(secret, auto);
      set({ ...cur, autoModeByProject: next });
    },
    setChannelAutoBackoff: (channelAutoBackoff: number) => { set({ ...get(), channelAutoBackoff }); },
    incrementChannelAutoBackoff: () => {
      const cur = get();
      set({ ...cur, channelAutoBackoff: cur.channelAutoBackoff + 1 });
    },
    setMostRecentSpinnerAt: (mostRecentSpinnerAtMs: number | null) => {
      set({ ...get(), mostRecentSpinnerAtMs });
    },
    /** Append a pending-permission entry. No-op if a same-request_id entry
     *  is already on the stack (matches HS-8219's `pendingPermissionStack.some(...)` gate). */
    pushPendingPermission: (entry: PendingPermission) => {
      const cur = get();
      if (cur.pendingPermissions.some(e => e.perm.request_id === entry.perm.request_id)) return;
      set({ ...cur, pendingPermissions: [...cur.pendingPermissions, entry] });
    },
    /** Pop the top entry (LIFO). Returns the popped entry or null when empty. */
    popPendingPermission: (): PendingPermission | null => {
      const cur = get();
      if (cur.pendingPermissions.length === 0) return null;
      const top = cur.pendingPermissions[cur.pendingPermissions.length - 1];
      set({ ...cur, pendingPermissions: cur.pendingPermissions.slice(0, -1) });
      return top;
    },
    /** Drop entries whose `request_id` is NOT in the given set. Used by the
     *  poll-response GC pass to drop stack entries the channel server no
     *  longer reports as pending. */
    retainPendingPermissions: (keepRequestIds: ReadonlySet<string>) => {
      const cur = get();
      const next = cur.pendingPermissions.filter(e => keepRequestIds.has(e.perm.request_id));
      if (next.length === cur.pendingPermissions.length) return;
      set({ ...cur, pendingPermissions: next });
    },
    setMinimizedSecrets: (minimizedSecrets: ReadonlySet<string>) => {
      set({ ...get(), minimizedSecrets });
    },
  }),
});

/** **HS-8320 — TEST ONLY.** Direct handle on the underlying store for
 *  unit tests to call `.reset()` between cases. Production code goes
 *  through the named actions above. */
export const _channelStoreForTesting = channelStore;
