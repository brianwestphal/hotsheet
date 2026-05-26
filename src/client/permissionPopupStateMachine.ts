/**
 * Permission popup state machine — long-poll loop, dedup collections,
 * minimize/dismiss bookkeeping, and the popup-orchestration wrapper that
 * gates the singleton-mount semantics. Extracted out of `permissionOverlay.tsx`
 * per HS-8394 Phase 2 (option (a) — state-holder + state-machine pair).
 *
 * The shared state lives in `permissionPopupState.ts`; this module
 * imports it directly. The popup body construction (`showPermissionPopupBody`,
 * the 442-line DOM build) stays in `permissionOverlay.tsx` because it
 * pulls in many UI-rendering helpers (`formatEditDiff`,
 * `openPermissionDialogShell`, `buildAlwaysAllowAffordance`, etc.). To
 * avoid a circular import, the state machine takes a `mountPopupBody`
 * hook set at init time — this module's `showPermissionPopup` calls
 * the hook inside its try/catch wrapper.
 *
 * Owns:
 * - `processPermissionPollResponse` — per-poll bookkeeping + active-popup
 *   auto-dismiss + dedup-collection GC + pending-stack GC.
 * - `startPermissionPolling` / `stopPermissionPolling` — the poll loop.
 * - `showPermissionPopup` — singleton-mount orchestration with
 *   queue-onto-stack + partial-mount-throw recovery.
 * - `mountNextFromPendingStack` — drain-the-stack helper called from
 *   every popup-close path.
 * - `reopenMinimizedForSecret` — re-open a minimized popup on tab click.
 * - `syncMinimizedDots` — mirror the `minimizedRequests` Map keys into
 *   `channelStore.minimizedSecrets` for reactive consumers.
 * - `shouldSkipPermission`, `getQueuedPermissionRequestIds`,
 *   `getMinimizedPermissionSecrets` — dedup queries.
 * - `clearTabPermissionHighlight` — DOM helper for the active-popup
 *   tab-highlight pill.
 * - `PermissionPollResponse` type.
 */

import { pollProjectPermissions } from '../api/index.js';
import { channelStore } from './channelStore.js';
import { clearProjectAttention, getProjectAttentionSecrets, markProjectAttention } from './channelUI.js';
import { TIMERS } from './constants/timers.js';
import { releaseActiveCheckoutIfAny } from './permissionLiveCheckout.js';
import type { PermissionData } from './permissionOverlayHelpers.js';
import {
  AUTO_DISMISS_MISS_THRESHOLD,
  dismissedRequestIds,
  minimizedRequests,
  permissionState,
  respondedRequestIds,
} from './permissionPopupState.js';

interface StateMachineHooks {
  /** Mount the popup body DOM for the given permission. Called inside
   *  `showPermissionPopup`'s try/catch wrapper. The hook is set at
   *  init time; without it, `showPermissionPopup` throws. */
  mountPopupBody: (secret: string, perm: PermissionData) => void;
}

let hooks: StateMachineHooks | null = null;

/** Initialize the state machine with its popup-body mount hook. Called
 *  once at app startup from `permissionOverlay.tsx`. */
export function initPermissionPopupStateMachine(h: StateMachineHooks): void {
  hooks = h;
}

function requireHooks(): StateMachineHooks {
  if (hooks === null) throw new Error('initPermissionPopupStateMachine must be called before any popup mount fires');
  return hooks;
}

/** HS-8323 — strip the `.permission-highlight` class from a project's
 *  tab (the light-blue rounded-pill background applied while a permission
 *  popup is mounted). Looked up fresh by `data-secret` rather than via a
 *  closure-captured DOM ref so a tab strip re-render between popup-mount
 *  and popup-dismiss can't leave a stale node receiving the cleanup.
 *  No-op when `secret` is null or the matching tab isn't in the DOM (the
 *  removal target is the LIVE node, not the one captured at mount time). */
export function clearTabPermissionHighlight(secret: string | null): void {
  if (secret === null) return;
  const tab = document.querySelector<HTMLElement>(`.project-tab[data-secret="${secret}"]`);
  if (tab !== null) tab.classList.remove('permission-highlight');
}

export type PermissionPollResponse = { permissions: Record<string, PermissionData | null>; v: number };

/** Read-only view of which project secrets currently have a minimized popup. */
export function getMinimizedPermissionSecrets(): Set<string> {
  const secrets = new Set<string>();
  for (const rec of minimizedRequests.values()) secrets.add(rec.secret);
  return secrets;
}

/** HS-8219 — should `perm` be skipped entirely (already-handled / waiting
 *  for the user)? Pure helper, exported for unit-test isolation. Three
 *  "permanent" skip reasons (responded / dismissed / user-minimized);
 *  once skipped here the stack push path doesn't need to second-guess. */
export function shouldSkipPermission(requestId: string): boolean {
  if (respondedRequestIds.has(requestId)) return true;
  if (dismissedRequestIds.has(requestId)) return true;
  if (minimizedRequests.has(requestId)) return true;
  return false;
}

/** HS-8219 — read-only view of the queued permissions (top is the next
 *  to pop after the active is dismissed). Exported for tests + the
 *  status-dot updater. */
export function getQueuedPermissionRequestIds(): string[] {
  return channelStore.state.value.pendingPermissions.map(e => e.perm.request_id);
}

/** HS-8183 — extracted out of `startPermissionPolling`'s `poll()` so the
 *  per-poll bookkeeping is unit-testable without a real `api` round-trip
 *  or `setTimeout` advance. Pure side-effects on module state + DOM. */
export function processPermissionPollResponse(data: PermissionPollResponse): void {
  permissionState.permissionVersion = data.v;

  // Auto-dismiss an open popup if its backing permission was handled elsewhere.
  if (permissionState.activePopupRequestId !== null) {
    const stillPending = Object.values(data.permissions).some(
      p => p !== null && p.request_id === permissionState.activePopupRequestId,
    );
    // HS-8207 — when the popup's owning project is missing entirely from
    // `data.permissions` (vs. present-with-null), the per-project channel-
    // server fetch in `routes/projects.ts::checkAll` threw transiently
    // (restart, network blip, slow response cancelled). Treat as "no info
    // this poll" — don't tick the auto-dismiss counter. Two consecutive
    // such transients no longer tear the popup out from under the user;
    // the next successful poll will either confirm pending (reset) or
    // confirm not-pending (start ticking). Pre-HS-8207 the server returned
    // `null` on fetch failure, which collapsed transient-unreachable into
    // confirmed-not-pending and produced exactly the "popup disappears
    // entirely" tail of the HS-8207 repro.
    const ownerKnown = permissionState.activePopupOwnerSecret === null
      || permissionState.activePopupOwnerSecret in data.permissions;
    if (stillPending) {
      permissionState.autoDismissMissCount = 0;
    } else if (!ownerKnown) {
      // No state change — keep counter where it is. We don't reset it
      // either, so a chain of misses interleaved with unreachables still
      // eventually dismisses (slowly).
    } else {
      permissionState.autoDismissMissCount++;
      if (permissionState.autoDismissMissCount >= AUTO_DISMISS_MISS_THRESHOLD) {
        // HS-8182 — release the §54 checkout BEFORE removing the
        // popup DOM so the live xterm element reparents back into
        // the previous owner's `mountInto` rather than being
        // orphaned in the removed-from-document subtree. Without
        // this, the dashboard tile / drawer pane that was bumped
        // down stays stuck on the 'Terminal in use elsewhere'
        // placeholder when the permission times out.
        releaseActiveCheckoutIfAny();
        // HS-8219 — defensive querySelectorAll so any duplicate is
        // also removed (the active slot is the source of truth and
        // there should never be more than one in DOM, but cheap
        // insurance).
        document.querySelectorAll('.permission-popup').forEach(el => el.remove());
        // HS-8323 — strip the `.permission-highlight` class from the
        // owner tab BEFORE clearing `activePopupOwnerSecret`. Pre-fix
        // the auto-dismiss path released the checkout + removed the
        // popup DOM + cleared the state slots but never stripped the
        // tab's blue-pill background; symptom = the user comes back
        // to find a previously-active tab "stuck" looking active.
        clearTabPermissionHighlight(permissionState.activePopupOwnerSecret);
        permissionState.activePopupRequestId = null;
        permissionState.activePopupOwnerSecret = null;
        permissionState.autoDismissMissCount = 0;
        // HS-8219 — pop the next queued permission so the user sees
        // it immediately rather than waiting another poll cycle.
        mountNextFromPendingStack();
      }
    }
  } else {
    permissionState.autoDismissMissCount = 0;
  }

  // Mark attention dots and show popup for every project with a pending permission.
  const pendingSecrets = new Set<string>();
  const pendingRequestIds = new Set<string>();
  for (const [secret, perm] of Object.entries(data.permissions)) {
    if (perm !== null) {
      pendingSecrets.add(secret);
      pendingRequestIds.add(perm.request_id);
      markProjectAttention(secret);
      if (!respondedRequestIds.has(perm.request_id)
          && !dismissedRequestIds.has(perm.request_id)
          && !minimizedRequests.has(perm.request_id)) {
        showPermissionPopup(secret, perm);
      }
    } else {
      clearProjectAttention(secret);
    }
  }
  // Clear any attention dots for projects NOT in the response at all.
  for (const secret of [...getProjectAttentionSecrets()]) {
    if (!pendingSecrets.has(secret)) {
      clearProjectAttention(secret);
    }
  }
  // GC dismissed bookkeeping for requests the channel server no longer reports.
  for (const id of [...dismissedRequestIds]) {
    if (!pendingRequestIds.has(id)) dismissedRequestIds.delete(id);
  }
  // GC minimized bookkeeping likewise — if the server resolved the
  // request while minimized, drop the record and update the tab dot.
  for (const [id, rec] of [...minimizedRequests]) {
    if (!pendingRequestIds.has(id)) {
      clearTimeout(rec.timeoutId);
      minimizedRequests.delete(id);
      syncMinimizedDots();
    }
  }
  // HS-8219 — GC the pending-permission stack: drop entries whose
  // `request_id` is no longer in the channel server's response (e.g.
  // the user typed a response directly into the terminal, the channel
  // server aged it out, etc.). Keeps the stack from accumulating
  // entries across a long-running session and prevents a never-going-
  // to-be-shown popup from popping when the active is dismissed.
  channelStore.actions.retainPendingPermissions(pendingRequestIds);
}

export function startPermissionPolling(channelBusyTimeout: ReturnType<typeof setTimeout> | null, setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void) {
  if (permissionState.permissionPollActive) return;
  permissionState.permissionPollActive = true;
  permissionState.channelBusyTimeoutModule = channelBusyTimeout;
  permissionState.setChannelBusyTimeoutRefModule = (t) => { permissionState.channelBusyTimeoutModule = t; setChannelBusyTimeoutRef(t); };

  async function poll() {
    if (!permissionState.permissionPollActive) return;
    try {
      const data = await pollProjectPermissions(permissionState.permissionVersion);
      processPermissionPollResponse(data);
    } catch {
      await new Promise(r => setTimeout(r, TIMERS.POLL_RETRY_MS));
    }
    if (permissionState.permissionPollActive) setTimeout(poll, 100); // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- can be set false by stopPermissionPolling()
  }
  void poll();
}

export function stopPermissionPolling() {
  permissionState.permissionPollActive = false;
}

/** Re-open a minimized permission popup for the given project. Returns true
 *  if a popup was re-opened. Called from projectTabs after a tab click. */
export function reopenMinimizedForSecret(secret: string): boolean {
  for (const [reqId, rec] of minimizedRequests) {
    if (rec.secret === secret) {
      clearTimeout(rec.timeoutId);
      minimizedRequests.delete(reqId);
      syncMinimizedDots();
      showPermissionPopup(rec.secret, rec.perm);
      return true;
    }
  }
  return false;
}

export function syncMinimizedDots() {
  // HS-8320 — mirror the `Map<requestId, MinimizedRecord>` keys into
  // `channelStore.minimizedSecrets` as a Set<secret> projection so the
  // store's consumers (project-tab dot updater + future reactive
  // subscribers) read from one place. The Map stays the source of
  // truth for the per-request metadata (timer handles) — only the
  // secret projection is in the store.
  const secrets = new Set<string>();
  for (const rec of minimizedRequests.values()) secrets.add(rec.secret);
  channelStore.actions.setMinimizedSecrets(secrets);
  // Lazy import to avoid circular dep at module-init time.
  import('./projectTabs.js').then(m => m.updateStatusDots()).catch(() => {});
}

/**
 * HS-8219 — drain the stack from the top, popping responded /
 * dismissed / minimized entries that became stale while waiting in the
 * queue, and mount the next valid one (if any). Called from every
 * popup-close path AFTER the active-popup state slot is cleared so the
 * gate `if (permissionState.activePopupRequestId !== null)` doesn't
 * block the new mount. Idempotent — safe to call when the stack is
 * empty or when no popup was active.
 */
export function mountNextFromPendingStack(): void {
  while (channelStore.state.value.pendingPermissions.length > 0) {
    const top = channelStore.actions.popPendingPermission();
    if (top === null) return;
    if (shouldSkipPermission(top.perm.request_id)) continue;
    // The top entry was popped off the store BEFORE calling
    // showPermissionPopup so the activePopupRequestId !== null gate
    // inside showPermissionPopup doesn't re-enqueue it (which would
    // just yield a no-op duplicate-on-stack check).
    showPermissionPopup(top.secret, top.perm);
    return;
  }
}

/** HS-8219 — top-level mount entry. Gates against duplicate-mounts +
 *  queues onto the pending stack when an active popup is already up,
 *  and recovers from partial-mount throws inside the hooked body so
 *  `permissionState.activePopupRequestId` never gets stranded non-null. */
export function showPermissionPopup(secret: string, perm: PermissionData): void {
  // Already showing this exact request — no-op
  if (permissionState.activePopupRequestId === perm.request_id) return;
  // Already responded / dismissed / minimized — don't re-show.
  if (shouldSkipPermission(perm.request_id)) return;
  // HS-8219 — already queued on the pending stack? No-op (the active
  // popup will pop it when dismissed). Prevents the polling loop's
  // for-each from re-pushing the same request_id every 100 ms.
  // (Handled inside `channelStore.actions.pushPendingPermission` too —
  // the explicit check here is the early-return so callers can
  // distinguish "queued" from "active" cleanly.)
  if (channelStore.state.value.pendingPermissions.some(e => e.perm.request_id === perm.request_id)) return;
  // HS-8219 — another popup is already showing. Push onto the stack;
  // it'll mount when the active popup closes (any path —
  // respondToPermission / cleanupAndDismiss / cleanupAndMinimize /
  // auto-dismiss — calls `mountNextFromPendingStack`). Pre-HS-8219 we
  // simply returned and waited for the next 100 ms poll cycle to
  // re-introduce the permission via the for-each in
  // `processPermissionPollResponse`. The stack centralizes the queue
  // so the active popup is always the single source of truth +
  // surfaces the next permission immediately on dismiss without
  // waiting on a poll round-trip.
  if (permissionState.activePopupRequestId !== null) {
    channelStore.actions.pushPendingPermission({ secret, perm });
    return;
  }

  // HS-8183 — wrap the entire mount path in try/catch so a throw
  // partway through (e.g. xterm constructor failing under WebGL
  // unavailability, `term.open` failing on a detached parking sink,
  // `formatEditDiff` choking on malformed JSON the truncation gate
  // didn't pre-screen) doesn't leave `permissionState.activePopupRequestId`
  // stuck non-null. Pre-fix a partial-mount throw left it set without a
  // popup in the DOM, so every subsequent show-loop call in
  // `processPermissionPollResponse` early-returned at the
  // `activePopupRequestId !== null` gate — exactly the "first popup
  // briefly appears, no popups ever after" repro the user reported. The
  // catch resets state + rethrows so the poll loop's catch logs the
  // original error.
  // HS-8219 — defensive: `querySelectorAll(...).forEach(remove)` instead
  // of single `querySelector(...)?.remove()` so that even if a duplicate
  // popup somehow slipped through (a partial-mount throw in a prior
  // cycle, an unmount that didn't disconnect, etc.) only one
  // `.permission-popup` ever exists in the DOM at a time.
  document.querySelectorAll('.permission-popup').forEach(el => el.remove());
  permissionState.activePopupRequestId = perm.request_id;
  permissionState.activePopupOwnerSecret = secret;
  try {
    requireHooks().mountPopupBody(secret, perm);
  } catch (err) {
    // HS-8323 — strip the `.permission-highlight` class before clearing
    // the owner secret so a partial-mount throw (the body adds the
    // class before finishing the mount) doesn't strand the tab in the
    // blue-pill state. Mirrors the same defensive removal in the auto-
    // dismiss + `clearPopupOnly` paths.
    clearTabPermissionHighlight(permissionState.activePopupOwnerSecret);
    permissionState.activePopupRequestId = null;
    permissionState.activePopupOwnerSecret = null;
    releaseActiveCheckoutIfAny();
    document.querySelectorAll('.permission-popup').forEach(el => el.remove());
    // HS-8219 — try the next queued permission on partial-mount throw so
    // a malformed payload doesn't strand subsequent valid permissions.
    mountNextFromPendingStack();
    throw err;
  }
}
