/**
 * Shared module-level state for the permission popup, extracted out of
 * `permissionOverlay.tsx` per HS-8394 Phase 2 (option (a) — state-holder
 * + state-machine pair, mirroring the HS-8395 dashboard state-holder
 * pattern). The state slot lives here so both `permissionPopupStateMachine.ts`
 * (polling + dedup) and `permissionOverlay.tsx` (popup body mount) can
 * read + write it directly — no cross-module accessor boilerplate.
 *
 * Owns:
 * - `PermissionData` type re-export so consumers don't have to know
 *   about `permissionOverlayHelpers.ts`.
 * - `MinimizedRecord` type.
 * - `PermissionOverlayState` interface + `freshPermissionOverlayState()`
 *   + the mutable `permissionState` slot.
 * - The three dedup collections — `respondedRequestIds`,
 *   `dismissedRequestIds`, `minimizedRequests`.
 * - `MINIMIZED_TIMEOUT_MS` and `AUTO_DISMISS_MISS_THRESHOLD` constants.
 * - `setPermissionState(next)` so cross-module reset code can swap the
 *   slot (ES module `export let` bindings are read-only at the import
 *   site).
 *
 * No popup-mount or polling logic lives here — this is pure state +
 * type definitions, peer to `permissionLiveCheckout.ts`.
 */

import type { PermissionData } from './permissionOverlayHelpers.js';

export type { PermissionData };

/**
 * HS-8190 — every long-lived mutable lifecycle ref this surface owns lives
 * inside a single named container so a future audit can spot stale handles
 * immediately.
 *
 * HS-8394 Phase 1 — the three live-checkout slots
 * (`activeCheckoutHandle`, `activeLiveTermResizeObserver`,
 * `liveTermFitRetryTimer`) moved to `permissionLiveCheckout.ts`. HS-8394
 * Phase 2 (this module) — the state slot itself moved out of
 * `permissionOverlay.tsx`; the popup-mount + state-machine modules both
 * import it directly.
 *
 * The `respondedRequestIds` / `dismissedRequestIds` / `minimizedRequests`
 * collections stay separate const Set/Map containers — they're long-lived
 * dedup/lifecycle stores, not single-slot mutable refs, and they have
 * their own GC paths inside `processPermissionPollResponse`.
 *
 * **HS-8320 / §61 Phase 3d.** The pending-permission stack and the
 * `Set<string>` projection of `minimizedRequests` moved to
 * `channelStore` (`pendingPermissions` / `minimizedSecrets`). The
 * underlying `minimizedRequests` Map stays here as the source of truth
 * for per-request metadata (timer handles); the store mirrors only the
 * secret-projection slice so reactive consumers (project-tab dots,
 * future subscribers) have one place to read from.
 */
export interface PermissionOverlayState {
  /** True while the long-poll loop in `startPermissionPolling` is running. */
  permissionPollActive: boolean;
  /** Long-poll change-version cursor — sent as `?v=N` and updated from each response. */
  permissionVersion: number;
  /** HS-8183 — number of consecutive polls in which `permissionState.activePopupRequestId`
   *  has been missing from `data.permissions`. Auto-dismiss fires at threshold. */
  autoDismissMissCount: number;
  /** Module-level channel-busy timeout slot, captured at poll start so the popup's
   *  reopen path can extend the timeout from anywhere. */
  channelBusyTimeoutModule: ReturnType<typeof setTimeout> | null;
  /** Setter callback paired with `channelBusyTimeoutModule` so a remote caller
   *  can update the live ref through the same slot. */
  setChannelBusyTimeoutRefModule: (t: ReturnType<typeof setTimeout> | null) => void;
  /** Active popup's `request_id`. Null when no popup is mounted. */
  activePopupRequestId: string | null;
  /** HS-8207 — the project secret the active popup belongs to. Tracked so the
   *  auto-dismiss path can distinguish "owner project absent from poll response =
   *  channel server unreachable" from "owner project present with null = no
   *  permission pending". */
  activePopupOwnerSecret: string | null;
}

export function freshPermissionOverlayState(): PermissionOverlayState {
  return {
    permissionPollActive: false,
    permissionVersion: 0,
    autoDismissMissCount: 0,
    channelBusyTimeoutModule: null,
    setChannelBusyTimeoutRefModule: () => {},
    activePopupRequestId: null,
    activePopupOwnerSecret: null,
  };
}

/** Mutable module-level state slot. Both `permissionPopupStateMachine.ts`
 *  and `permissionOverlay.tsx` read + write field-level here. */
export let permissionState: PermissionOverlayState = freshPermissionOverlayState();

/** Replace the slot wholesale — required for the test reset path because
 *  ES module `export let` bindings are read-only at the import site, so
 *  consumers can't do `permissionState = freshPermissionOverlayState()`
 *  themselves. */
export function setPermissionState(next: PermissionOverlayState): void {
  permissionState = next;
}

// Track request IDs we've already responded to, so polling doesn't re-show them.
export const respondedRequestIds = new Set<string>();

// Request IDs the user has explicitly dismissed ("No response needed" link, or
// auto-expired minimized popups). The channel-server request is still pending;
// polling will not re-show the popup until it disappears server-side (HS-6436).
export const dismissedRequestIds = new Set<string>();

// Minimized popups — user clicked outside (or on the owning tab) without
// responding. Indexed by request_id. The pulsating blue dot on the owning
// project tab signals there is a waiting permission; clicking the tab
// re-opens the popup (see `reopenMinimizedForSecret`). HS-6637.
export type MinimizedRecord = {
  secret: string;
  perm: PermissionData;
  timeoutId: ReturnType<typeof setTimeout>;
};
export const minimizedRequests = new Map<string, MinimizedRecord>();

/** Two-minute timeout on minimized popups — after that they auto-dismiss. */
export const MINIMIZED_TIMEOUT_MS = 2 * 60 * 1000;

/** HS-8183 — number of consecutive polls in which `permissionState.activePopupRequestId`
 *  must be missing from `data.permissions` before the auto-dismiss path
 *  fires. Pre-fix the auto-dismiss fired on the first missed poll, which
 *  meant a single transient channel-server fetch failure (the per-project
 *  `fetch` in `routes/projects.ts::checkAll` returns `null` on any throw —
 *  network blip, brief restart, slow response getting cancelled) ripped
 *  the popup out from under the user. With Claude unable to ever surface
 *  the same `request_id` again, the user saw "first popup briefly appears
 *  then disappears, no popups ever after" exactly per the HS-8183 repro.
 *  Two consecutive misses keeps the dismiss responsive (≤ ~6s end-to-end
 *  given the 3s long-poll cap + 100ms reschedule) while ignoring the
 *  single-poll transient. */
export const AUTO_DISMISS_MISS_THRESHOLD = 2;
