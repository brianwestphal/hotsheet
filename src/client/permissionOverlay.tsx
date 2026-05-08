import { raw } from '../jsx-runtime.js';
import { extractPrimaryValue } from '../permissionAllowRules.js';
import { api, apiWithSecret } from './api.js';
import { hasAiTerminalPromptForSecret } from './bellPoll.js';
import { clearProjectAttention, getProjectAttentionSecrets, isChannelBusy, markProjectAttention, setChannelBusy } from './channelUI.js';
import { TIMERS } from './constants/timers.js';
import { toElement } from './dom.js';
import { renderEditDiffPreview } from './editDiffPreview.js';
import { buildAlwaysAllowAffordance } from './permissionAllowListUI.js';
import { openPermissionDialogShell } from './permissionDialogShell.js';
import { type EditDiffShape, formatEditDiff, formatInputPreview } from './permissionPreview.js';
import { state } from './state.js';
import { requestAttention } from './tauriIntegration.js';
import { checkout, type CheckoutHandle, peekEntryDims } from './terminalCheckout.js';

/**
 * Claude permission-request UI. Historically there were two variants: a
 * full-screen overlay for the active project and a compact popup for
 * non-active projects. HS-6536 unified them — every pending permission
 * (active or not) uses the same popup anchored to its project tab.
 *
 * HS-6637: Minimizing the popup drops it into a pulsating blue dot on the
 * owning project's tab; clicking the tab re-shows the same popup. The "No
 * response needed" link at the popup's bottom-left dismisses outright (for
 * cases where the user wants to respond via Claude directly). A minimized
 * popup auto-dismisses after 2 minutes so it can't linger forever.
 *
 * HS-7266: the popup is non-modal — it does NOT dismiss or minimize on
 * outside clicks. Users can interact with the rest of the UI while it is
 * visible. Minimize is an explicit action via the popup's own Minimize link.
 */

export type PermissionData = { request_id: string; tool_name: string; description: string; input_preview?: string };

/**
 * HS-8217 — single-line flat preview length above which the popup
 * borrows the live terminal instead of rendering a static `<pre>`. Tuned
 * so that short bash one-liners (`ls -la`, `git status`) stay on the
 * tight static path while pipelines / longer commands surface the rich
 * TUI output. 80 chars matches the conventional "fits on one terminal
 * line" cap.
 */
export const LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD = 80;

/**
 * HS-8217 — pure heuristic: should the popup borrow the live terminal
 * via §54 checkout instead of rendering a static `<pre>` / DOM diff?
 *
 * Triggers (any one — short-circuit OR):
 *   - **Edit / Write parseable** — `editDiff !== null`. Edit/Write diffs
 *     are inherently multi-line and benefit substantially from the real
 *     claude TUI's coloured rendering (file-name header + dim-faded
 *     unchanged context + green added rows + red removed rows + the
 *     numbered choices list directly below) over the static
 *     `renderEditDiffPreview` HTML diff. User report HS-8217: "the text
 *     is hard to follow. in the terminal, the edits are color coded so
 *     it's easier to see what's being added / removed".
 *   - **Truncation** — flat preview ends in `…` (HS-7999) OR
 *     `editDiff.truncated === true` (HS-8139). Pre-HS-8217 these were
 *     the only triggers — the static body would otherwise be
 *     ambiguous.
 *   - **Multi-line flat** — `previewText.includes('\n')` for non-Edit
 *     tools (e.g. WebFetch with a multi-line body, generic key/value
 *     dumps from `formatInputPreview`'s flat fallback).
 *   - **Long single-line flat** — `previewText.length > 80` (the
 *     `LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD` constant). Long single-line
 *     bash pipelines benefit from seeing the actual claude prompt's
 *     wrapping + surrounding context.
 *
 * Stays static for: short single-line bash / `git status` / one-line
 * `Read` previews, where the `<pre>` is tight and the live terminal
 * would surround the value with noise that adds no scanning value AND
 * would pay the noSpawn-fallback round-trip if `'default'` isn't live.
 *
 * Pure helper, no DOM / module state. Exported for unit-test isolation.
 */
export function shouldUseLiveCheckout(
  editDiff: EditDiffShape | null,
  previewText: string,
): boolean {
  if (editDiff !== null) return true;
  if (previewText === '') return false;
  if (previewText.endsWith('…')) return true;
  if (previewText.includes('\n')) return true;
  if (previewText.length > LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD) return true;
  return false;
}

/**
 * HS-8190 — every long-lived mutable lifecycle ref this module owns lives
 * inside a single named container so a future audit can spot stale handles
 * immediately. Pre-fix the file carried 10 separately-declared module-level
 * `let`s scattered across ~300 lines of prose; the HS-8171 v2 / HS-8180 /
 * HS-8182 / HS-8183 / HS-8206 / HS-8207 / HS-8217 / HS-8218 / HS-8219
 * regression family was fed by exactly this kind of "where does that handle
 * actually get cleared?" confusion. Now: read `state.foo` everywhere; reset
 * via `_resetStateForTesting()` (assigns `freshState()` after running the
 * disposers).
 *
 * The `respondedRequestIds` / `dismissedRequestIds` / `minimizedRequests` /
 * `pendingPermissionStack` collections stay separate const Set/Map/Arrays —
 * they're long-lived containers, not single-slot mutable refs, and they have
 * their own GC paths inside `processPermissionPollResponse`.
 */
interface PermissionOverlayState {
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
  /** HS-8171 v2 / HS-8182 — the §54 live-terminal checkout handle the popup
   *  may have taken. Hoisted out of the popup's closure so the polling loop's
   *  auto-dismiss path can `release()` it too. */
  activeCheckoutHandle: CheckoutHandle | null;
  /** HS-8206 — ResizeObserver that keeps the borrowed live-terminal sized
   *  to fit the popup's `liveTermContainer`. */
  activeLiveTermResizeObserver: ResizeObserver | null;
  /** HS-8206 v2 — pending retry timeout id so a re-run from the
   *  ResizeObserver doesn't stack up parallel retry chains. */
  liveTermFitRetryTimer: ReturnType<typeof setTimeout> | null;
}

function freshPermissionOverlayState(): PermissionOverlayState {
  return {
    permissionPollActive: false,
    permissionVersion: 0,
    autoDismissMissCount: 0,
    channelBusyTimeoutModule: null,
    setChannelBusyTimeoutRefModule: () => {},
    activePopupRequestId: null,
    activePopupOwnerSecret: null,
    activeCheckoutHandle: null,
    activeLiveTermResizeObserver: null,
    liveTermFitRetryTimer: null,
  };
}

let permissionState: PermissionOverlayState = freshPermissionOverlayState();

// Track request IDs we've already responded to, so polling doesn't re-show them.
export const respondedRequestIds = new Set<string>();

// Request IDs the user has explicitly dismissed ("No response needed" link, or
// auto-expired minimized popups). The channel-server request is still pending;
// polling will not re-show the popup until it disappears server-side (HS-6436).
export const dismissedRequestIds = new Set<string>();

/**
 * HS-8294 — per-project map of the most recently observed pending channel-
 * permission `request_id`, updated every `processPermissionPollResponse`
 * tick. Read by `dismissChannelPermissionForSecret` so a §52 AI-prompt
 * answer can mark the equivalent §47 request as dismissed without having
 * to plumb the `request_id` through the bellPoll dispatcher.
 *
 * Pre-fix the user reported seeing TWO permission popups for one Claude
 * decision (e.g. `mkdir -p /tmp/claude-permission-test` from
 * /test-permission-write): §52 fires for the in-terminal prompt, the user
 * picks Yes via TUI keystroke, Claude proceeds — but the channel server's
 * MCP `permission_request` from the SAME decision was never explicitly
 * answered (Claude doesn't propagate TUI answers back to the MCP server
 * within the 2-min `PERMISSION_TTL_MS`), so the next channel-permission
 * poll re-mounts §47 for the already-resolved decision.
 *
 * Recording the request_id per secret here lets `bellPoll.tsx`'s onSend
 * path (when an AI parser numbered choice was picked) call
 * `dismissChannelPermissionForSecret(secret)` which adds the latest
 * pending request_id to `dismissedRequestIds` so subsequent polls don't
 * re-mount it.
 */
const lastSeenPendingBySecret = new Map<string, string>();

// Minimized popups — user clicked outside (or on the owning tab) without
// responding. Indexed by request_id. The pulsating blue dot on the owning
// project tab signals there is a waiting permission; clicking the tab
// re-opens the popup (see reopenMinimizedForSecret). HS-6637.
type MinimizedRecord = {
  secret: string;
  perm: PermissionData;
  timeoutId: ReturnType<typeof setTimeout>;
};
const minimizedRequests = new Map<string, MinimizedRecord>();

/** Two-minute timeout on minimized popups — after that they auto-dismiss. */
const MINIMIZED_TIMEOUT_MS = 2 * 60 * 1000;

/** Read-only view of which project secrets currently have a minimized popup. */
export function getMinimizedPermissionSecrets(): Set<string> {
  const secrets = new Set<string>();
  for (const rec of minimizedRequests.values()) secrets.add(rec.secret);
  return secrets;
}

/**
 * HS-8245 — tear down any §47 channel-permission popup belonging to
 * `secret` without responding to the underlying MCP request. Called
 * from `bellPoll.tsx`'s dispatcher when an AI-parser §52 overlay is
 * about to mount for the same project — the two surfaces describe the
 * same Claude decision and the §52 overlay (which answers via
 * keystrokes the TUI is already listening for) is the authoritative
 * one. The MCP request stays alive on the channel server; if the AI
 * prompt clears without resolving the MCP side, the next
 * `processPermissionPollResponse` for-each iteration will re-mount §47
 * naturally because `hasAiTerminalPromptForSecret(secret)` will then
 * return false. Inverts the HS-8228 `dismissTerminalPromptOverlayForSecret`
 * direction (which let §47 win — the user reported that was the wrong
 * choice for AI prompts).
 *
 * "Tear down" = remove the popup DOM, release the §54 checkout (so
 * the borrowed live xterm reparents back into its previous owner),
 * and clear `activePopupRequestId` / `activePopupOwnerSecret` so the
 * next mount can proceed. Idempotent — no-op when no popup is active
 * for `secret`. Minimized popups (DOM-not-present) are explicitly
 * preserved; the user already chose to defer that one.
 */
export function dismissPermissionPopupForSecret(secret: string): void {
  if (permissionState.activePopupOwnerSecret !== secret) return;
  if (permissionState.activePopupRequestId === null) return;
  // Release checkout BEFORE removing the popup DOM so the live xterm
  // reparents back into the previous owner's `mountInto` rather than
  // being orphaned in the removed-from-document subtree (HS-8182).
  releaseActiveCheckoutIfAny();
  document.querySelectorAll('.permission-popup').forEach(el => el.remove());
  permissionState.activePopupRequestId = null;
  permissionState.activePopupOwnerSecret = null;
  permissionState.autoDismissMissCount = 0;
}

/**
 * HS-8294 — when the user answers an AI-parser §52 in-terminal prompt
 * (e.g. picks "1. Yes" on Claude's "Do you want to proceed?"), the same
 * Claude decision's MCP `permission_request` stays alive on the channel
 * server (Claude doesn't auto-cancel it within the 2-min
 * `PERMISSION_TTL_MS`). Without this, the next channel-permission poll
 * re-mounts §47 for the already-resolved decision and the user sees a
 * second popup for the same Claude prompt — the exact symptom reported
 * in HS-8294.
 *
 * "Mark dismissed" = add the latest seen pending request_id for `secret`
 * to `dismissedRequestIds` so future `processPermissionPollResponse`
 * iterations skip the mount, AND tear down any currently-mounted §47
 * popup for the same project (idempotent — no-op when no popup is up).
 *
 * Idempotent for the no-pending case (returns early when
 * `lastSeenPendingBySecret` has no entry for `secret`). The MCP request
 * itself stays alive on the channel server until either Claude responds
 * via MCP (typical for ALLOW paths where claude propagates the TUI
 * answer back) or the 2-min TTL expires — we just stop showing it.
 */
export function dismissChannelPermissionForSecret(secret: string): void {
  const requestId = lastSeenPendingBySecret.get(secret);
  if (requestId !== undefined) {
    dismissedRequestIds.add(requestId);
  }
  // Tear down the popup if it happens to be currently mounted for this
  // project (race where §52 dispatched after §47 mounted and the user
  // answered §52 immediately — at this point the dispatcher's own
  // `dismissPermissionPopupForSecret` may have already fired, in which
  // case this call is a no-op).
  dismissPermissionPopupForSecret(secret);
}

/** HS-8183 — number of consecutive polls in which `state.permissionState.activePopupRequestId`
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
const AUTO_DISMISS_MISS_THRESHOLD = 2;

export type PermissionPollResponse = { permissions: Record<string, PermissionData | null>; v: number };

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
      // HS-8294 — record the per-secret pending request_id so a §52
      // AI-prompt answer can mark the equivalent §47 request as
      // dismissed via `dismissChannelPermissionForSecret(secret)`.
      lastSeenPendingBySecret.set(secret, perm.request_id);
      markProjectAttention(secret);
      if (!respondedRequestIds.has(perm.request_id)
          && !dismissedRequestIds.has(perm.request_id)
          && !minimizedRequests.has(perm.request_id)) {
        showPermissionPopup(secret, perm);
      }
    } else {
      clearProjectAttention(secret);
      // HS-8294 — server reports null for this project (no pending
      // permission). Drop from the per-secret tracker so a future
      // dismiss call doesn't add a stale request_id to dismissedRequestIds.
      lastSeenPendingBySecret.delete(secret);
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
  for (let i = pendingPermissionStack.length - 1; i >= 0; i--) {
    if (!pendingRequestIds.has(pendingPermissionStack[i].perm.request_id)) {
      pendingPermissionStack.splice(i, 1);
    }
  }
}

export function startPermissionPolling(channelBusyTimeout: ReturnType<typeof setTimeout> | null, setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void) {
  if (permissionState.permissionPollActive) return;
  permissionState.permissionPollActive = true;
  permissionState.channelBusyTimeoutModule = channelBusyTimeout;
  permissionState.setChannelBusyTimeoutRefModule = (t) => { permissionState.channelBusyTimeoutModule = t; setChannelBusyTimeoutRef(t); };

  async function poll() {
    if (!permissionState.permissionPollActive) return;
    try {
      const data = await api<PermissionPollResponse>(`/projects/permissions?v=${permissionState.permissionVersion}`);
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

function syncMinimizedDots() {
  // Lazy import to avoid circular dep at module-init time.
  import('./projectTabs.js').then(m => m.updateStatusDots()).catch(() => {});
}

// --- Permission popup (single codepath for active + non-active projects) ---

/**
 * HS-8219 — stack of permissions waiting for the active popup to clear.
 * The TOP of the stack pops next when the active popup is dismissed /
 * responded / minimized / auto-dismissed. Pre-HS-8219 a new permission
 * arriving while one was showing was simply dropped at the gate in
 * `showPermissionPopup`; the polling loop re-introduced it ~100 ms
 * later via `processPermissionPollResponse`'s for-each. That worked in
 * the steady-state but offered no resilience against a transient where
 * two `.permission-popup` elements somehow ended up in the DOM at once
 * (the user reported "it's sometimes showing multiple permissions
 * popups at once -- it should only show one at a time -- using a stack
 * data structure"). The stack centralises the "next to show" queue so
 * the active popup is always the single source of truth, AND every
 * popup-close path pops the next directly without waiting for the
 * 100 ms poll reschedule. Combined with the `querySelectorAll`
 * defensive cleanup below, no path can mount a second popup while one
 * is already alive.
 *
 * Literal stack semantics (LIFO) — the most recently arrived permission
 * pops first. Per HS-8219 the user explicitly asked for a "stack data
 * structure".
 *
 * Stale entries are GC'd at the end of every `processPermissionPollResponse`
 * so a permission resolved on the channel server (e.g. user typed a
 * response directly into the terminal) is dropped from the stack
 * without ever being shown.
 */
type StackedPermission = { secret: string; perm: PermissionData };
const pendingPermissionStack: StackedPermission[] = [];

function releaseActiveCheckoutIfAny(): void {
  disconnectActiveLiveTermResizeObserver();
  clearLiveTermFitRetryTimer();
  if (permissionState.activeCheckoutHandle === null) return;
  try { permissionState.activeCheckoutHandle.release(); } catch { /* swallow — entry may already be torn down */ }
  permissionState.activeCheckoutHandle = null;
}

function disconnectActiveLiveTermResizeObserver(): void {
  if (permissionState.activeLiveTermResizeObserver === null) return;
  try { permissionState.activeLiveTermResizeObserver.disconnect(); } catch { /* swallow */ }
  permissionState.activeLiveTermResizeObserver = null;
}

/** HS-8206 v2 — total retry budget for the live-term fit. xterm's
 *  renderer typically measures cell dims within a couple of frames after
 *  reparenting; the budget is generous enough to cover slow first paints
 *  on cold startup (heavy theme load, lots of scrollback to replay) but
 *  not so long that a genuinely-broken environment hangs the fit forever. */
const LIVE_TERM_FIT_RETRY_INTERVAL_MS = 16;
const LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS = 30;

function clearLiveTermFitRetryTimer(): void {
  if (permissionState.liveTermFitRetryTimer === null) return;
  clearTimeout(permissionState.liveTermFitRetryTimer);
  permissionState.liveTermFitRetryTimer = null;
}

/** HS-8206 v2 — drive `fit.proposeDimensions()` to a successful resize,
 *  retrying up to {@link LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS} times with
 *  {@link LIVE_TERM_FIT_RETRY_INTERVAL_MS} between attempts. Bails if
 *  the active checkout handle changes (popup closed / replaced) or the
 *  popup is dismissed mid-retry. Idempotent: a re-entry while a retry
 *  chain is in flight cancels the pending timer and starts fresh, so
 *  the ResizeObserver firing during a retry doesn't produce overlapping
 *  chains. */
function runLiveTermFitWithRetry(forHandle: CheckoutHandle): void {
  clearLiveTermFitRetryTimer();
  let attempts = 0;
  function attempt(): void {
    permissionState.liveTermFitRetryTimer = null;
    if (permissionState.activeCheckoutHandle !== forHandle) return; // popup closed or re-checked-out.
    attempts++;
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = forHandle.fit.proposeDimensions();
    } catch { /* term disposed mid-flight */ return; }
    if (proposed === undefined) {
      if (attempts >= LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS) return;
      permissionState.liveTermFitRetryTimer = setTimeout(attempt, LIVE_TERM_FIT_RETRY_INTERVAL_MS);
      return;
    }
    if (proposed.cols === forHandle.term.cols && proposed.rows === forHandle.term.rows) {
      return; // already at the right dims — break the fit/observe loop.
    }
    try { forHandle.resize(proposed.cols, proposed.rows); } catch { /* term disposed */ }
  }
  // First attempt on the next animation frame so the popup overlay's
  // initial layout has settled before we read CSS dims.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(attempt);
  } else {
    permissionState.liveTermFitRetryTimer = setTimeout(attempt, 0);
  }
}

/**
 * HS-8219 — should `perm` be skipped entirely (already-handled / waiting
 * for the user)? Pure helper, exported for unit-test isolation. Three
 * "permanent" skip reasons (responded / dismissed / user-minimized);
 * once skipped here the stack push path doesn't need to second-guess.
 */
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
  return pendingPermissionStack.map(e => e.perm.request_id);
}

/**
 * HS-8219 — drain the stack from the top, popping responded /
 * dismissed / minimized entries that became stale while waiting in the
 * queue, and mount the next valid one (if any). Called from every
 * popup-close path AFTER `clearPopupOnly()` (or equivalent state
 * reset) so the gate `if (permissionState.activePopupRequestId !== null)` doesn't
 * block the new mount. Idempotent — safe to call when the stack is
 * empty or when no popup was active.
 */
function mountNextFromPendingStack(): void {
  while (pendingPermissionStack.length > 0) {
    const next = pendingPermissionStack[pendingPermissionStack.length - 1];
    if (shouldSkipPermission(next.perm.request_id)) {
      pendingPermissionStack.pop();
      continue;
    }
    // Pop the entry off the stack BEFORE calling showPermissionPopup
    // so the permissionState.activePopupRequestId !== null gate doesn't re-enqueue
    // it (which would just yield a no-op duplicate-on-stack check).
    pendingPermissionStack.pop();
    showPermissionPopup(next.secret, next.perm);
    return;
  }
}

function showPermissionPopup(secret: string, perm: PermissionData) {
  // Already showing this exact request — no-op
  if (permissionState.activePopupRequestId === perm.request_id) return;
  // Already responded / dismissed / minimized — don't re-show.
  if (shouldSkipPermission(perm.request_id)) return;
  // HS-8245 — when an AI tool's in-terminal prompt is detected for this
  // project (Claude / Codex / etc., per `AI_PARSER_IDS`), suppress the
  // §47 channel-permission popup entirely. The §52 in-terminal overlay
  // is the authoritative surface — its borrow-terminal interaction
  // sends keystrokes the AI's TUI is already listening for. The MCP
  // request stays alive on the channel server; the next
  // `processPermissionPollResponse` for-each iteration will re-call
  // `showPermissionPopup` (every 100ms) and naturally surface §47 if
  // the AI prompt clears without resolving the MCP side. We don't
  // push onto `pendingPermissionStack` because that's for "popup is
  // already up, queue this one" — here no popup mounted at all.
  if (hasAiTerminalPromptForSecret(secret)) return;
  // HS-8219 — already queued on the pending stack? No-op (the active
  // popup will pop it when dismissed). Prevents the polling loop's
  // for-each from re-pushing the same request_id every 100 ms.
  if (pendingPermissionStack.some(e => e.perm.request_id === perm.request_id)) return;
  // HS-8219 — another popup is already showing. Push onto the stack;
  // it'll mount when the active popup closes (any path —
  // respondToPermission / cleanupAndDismiss / cleanupAndMinimize /
  // auto-dismiss — calls `mountNextFromPendingStack`). Pre-HS-8219 we
  // simply returned and waited for the next 100 ms poll cycle to
  // re-introduce the permission via the for-each in
  // `processPermissionPollResponse`. The stack centralises the queue
  // so the active popup is always the single source of truth +
  // surfaces the next permission immediately on dismiss without
  // waiting on a poll round-trip.
  if (permissionState.activePopupRequestId !== null) {
    pendingPermissionStack.push({ secret, perm });
    return;
  }

  // HS-8183 — wrap the entire mount path in try/catch so a throw
  // partway through (e.g. xterm constructor failing under WebGL
  // unavailability, `term.open` failing on a detached parking sink,
  // `formatEditDiff` choking on malformed JSON the truncation gate
  // didn't pre-screen) doesn't leave `permissionState.activePopupRequestId` stuck
  // non-null. Pre-fix a partial-mount throw left `permissionState.activePopupRequestId`
  // set without a popup in the DOM, so every subsequent show-loop
  // call in `processPermissionPollResponse` early-returned at the
  // `if (permissionState.activePopupRequestId !== null) return;` gate — exactly the
  // "first popup briefly appears, no popups ever after" repro
  // ` user reported. The catch resets state + rethrows so the poll
  // loop's catch logs the original error.
  // HS-8219 — defensive: `querySelectorAll(...).forEach(remove)` instead
  // of single `querySelector(...)?.remove()` so that even if a duplicate
  // popup somehow slipped through (a partial-mount throw in a prior
  // cycle, an unmount that didn't disconnect, etc.) only one
  // `.permission-popup` ever exists in the DOM at a time.
  document.querySelectorAll('.permission-popup').forEach(el => el.remove());
  permissionState.activePopupRequestId = perm.request_id;
  permissionState.activePopupOwnerSecret = secret;
  try {
    showPermissionPopupBody(secret, perm);
  } catch (err) {
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

function showPermissionPopupBody(secret: string, perm: PermissionData) {
  // HS-8245 — the precedence is now reversed from HS-8228: §52 (in-
  // terminal overlay for AI prompts) wins, and §47 is suppressed at the
  // gate in `showPermissionPopup` when `hasAiTerminalPromptForSecret`
  // is true. There's no longer a `dismissTerminalPromptOverlayForSecret`
  // call here — by the time we reach this body, the AI gate has
  // already passed.

  // A permission request is proof Claude is actively working — extend busy timeout.
  if (permissionState.channelBusyTimeoutModule) {
    clearTimeout(permissionState.channelBusyTimeoutModule);
    permissionState.setChannelBusyTimeoutRefModule(setTimeout(() => {
      if (isChannelBusy()) setChannelBusy(false);
    }, TIMERS.CHANNEL_BUSY_TIMEOUT_MS));
  }
  if (!isChannelBusy()) setChannelBusy(true);

  // Find the tab element to highlight. Anchor positioning happens inside
  // the shared shell (HS-8066 / HS-8069); we still toggle the tab's
  // `.permission-highlight` class for the existing visual cue.
  const tab = document.querySelector<HTMLElement>(`.project-tab[data-secret="${secret}"]`);
  if (tab) tab.classList.add('permission-highlight');

  const checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const xIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  // HS-7951 — when the permission is for an Edit / Write tool with parseable
  // `old_string` / `new_string`, render a colour-coded inline unified diff
  // instead of the flat-JSON dump. Falls back to the existing string preview
  // for every other tool + for malformed Edit/Write payloads.
  const editDiff = perm.input_preview !== undefined
    ? formatEditDiff(perm.tool_name, perm.input_preview)
    : null;
  // Format Claude's raw `input_preview` into a human-readable preview — Bash
  // gets just the command line, other known tools get their primary field,
  // generic JSON gets flattened key/value lines (HS-6634).
  const previewText = editDiff === null && perm.input_preview !== undefined
    ? formatInputPreview(perm.tool_name, perm.input_preview)
    : '';
  const hasStringPreview = previewText !== '';

  // HS-8171 v2 + HS-8217 — when the preview is non-trivial the popup
  // body becomes the LIVE project terminal via the §54 checkout
  // mechanism instead of a static `<pre>` / DOM diff. The user can
  // scroll through the real PTY scrollback AND interact with the
  // running `claude` directly from inside the popup. When the popup
  // is dismissed / minimized / responded to, the checkout releases
  // and the previous owner (drawer pane, dashboard tile, etc.) gets
  // the terminal back via the LIFO stack. Pre-fix iterations (HS-7999
  // / HS-8139 / HS-8158 / HS-8171 v1) tried to mount a serialized
  // snapshot — the user reported repeated cases where the snapshot
  // sampled stale or empty content. A real checkout sidesteps the
  // sampling problem entirely. See `shouldUseLiveCheckout` for the
  // pure heuristic — pre-HS-8217 only truncation triggered live; the
  // user reported (HS-8217) that the static colour-coded HTML diff
  // was still hard to follow vs the actual claude TUI's coloured
  // output, so the gate now also fires for any non-trivial preview
  // (Edit/Write tool with parseable diff, multi-line flat preview,
  // long single-line flat preview).
  const useLiveCheckout = perm.input_preview !== undefined && shouldUseLiveCheckout(editDiff, previewText);

  // HS-8069 — body slot: live-terminal checkout container (HS-8171 v2)
  // when truncation fired, else the diff DOM (HS-7951), else the
  // flat-JSON pre-tag preview, else nothing. Build the element first so
  // we can pass it to the shell as a slot.
  let bodyElement: HTMLElement | undefined;
  let liveTermContainer: HTMLElement | null = null;
  if (useLiveCheckout) {
    liveTermContainer = toElement(<div className="permission-popup-live-terminal"></div>);
    bodyElement = liveTermContainer;
  } else if (editDiff !== null) {
    bodyElement = renderEditDiffPreview(editDiff);
  } else if (hasStringPreview) {
    bodyElement = toElement(<pre className="permission-popup-preview">{previewText}</pre>);
  }

  // HS-8069 — actions slot: Allow / Deny icon buttons.
  const actions = toElement(
    <div className="permission-popup-actions">
      <button className="permission-popup-allow" title="Allow">{raw(checkIcon)}</button>
      <button className="permission-popup-deny" title="Deny">{raw(xIcon)}</button>
    </div>
  );

  // HS-7953 / HS-8069 — "Always allow this" affordance. Skipped for
  // non-allow-listable tools (Edit / Write / unknown) and when the
  // primary-field value is empty. Confirming a new rule writes to
  // settings.json then immediately invokes the allow-current-request path.
  const primaryValue = perm.input_preview !== undefined
    ? extractPrimaryValue(perm.tool_name, perm.input_preview)
    : null;
  let alwaysAffordance: HTMLElement | null = null;
  if (primaryValue !== null) {
    alwaysAffordance = buildAlwaysAllowAffordance({
      toolName: perm.tool_name,
      primaryValue,
      onCommit: () => { respondToPermission('allow'); },
    });
  }

  // HS-8171 v2 / HS-8182 — the checkout handle (if any) lives at module
  // scope (`permissionState.activeCheckoutHandle`) so the polling-loop's auto-dismiss
  // path can release it too. Every popup-close path inside this scope
  // routes through `releaseActiveCheckoutIfAny()` so the release is
  // idempotent + single-source-of-truth.

  /**
   * HS-8218 — fired from the checkout's `onNoLiveSession` callback when
   * the server returned `noSession: true` (no live PTY existed for
   * `terminalId: 'default'` and `noSpawn: true` prevented a fresh
   * spawn). Release the checkout and swap the popup body from the
   * empty live-terminal container to the same flat / diff preview the
   * non-live code path would have rendered.
   *
   * Pre-fix the popup checked out `terminalId: 'default'` regardless;
   * if the project's claude was running under a different terminal id
   * (and `'default'` had never been started), the server's `attach`
   * spawned a brand-new `claude --dangerously-load-development-channels`
   * PTY into the popup body, which stole the channel-server's MCP
   * connection from the user's actual claude session.
   */
  function fallbackToNonLivePreview(): void {
    if (liveTermContainer === null) return;
    releaseActiveCheckoutIfAny();
    let fallback: HTMLElement;
    if (editDiff !== null) {
      fallback = renderEditDiffPreview(editDiff);
    } else if (hasStringPreview) {
      fallback = toElement(<pre className="permission-popup-preview">{previewText}</pre>);
    } else {
      // Neither preview was buildable — show a minimal explainer so the
      // popup body isn't empty.
      fallback = toElement(
        <pre className="permission-popup-preview">{'(no preview — terminal not live)'}</pre>,
      );
    }
    liveTermContainer.replaceWith(fallback);
    liveTermContainer = null;
  }

  function clearPopupOnly() {
    permissionState.activePopupRequestId = null;
    permissionState.activePopupOwnerSecret = null;
    if (tab) tab.classList.remove('permission-highlight');
  }

  function cleanupAndDismiss() {
    releaseActiveCheckoutIfAny();
    dismissedRequestIds.add(perm.request_id);
    clearPopupOnly();
    // HS-8219 — pop the next queued permission off the stack now that
    // the active slot is free. Without this the user would have to
    // wait up to ~100 ms for the next poll cycle to surface the next
    // pending permission.
    mountNextFromPendingStack();
  }

  function cleanupAndMinimize() {
    releaseActiveCheckoutIfAny();
    clearPopupOnly();
    const timeoutId = setTimeout(() => {
      const rec = minimizedRequests.get(perm.request_id);
      if (!rec) return;
      minimizedRequests.delete(perm.request_id);
      dismissedRequestIds.add(perm.request_id);
      syncMinimizedDots();
    }, MINIMIZED_TIMEOUT_MS);
    minimizedRequests.set(perm.request_id, { secret, perm, timeoutId });
    syncMinimizedDots();
    // HS-8219 — same as cleanupAndDismiss: pop the next queued
    // permission immediately so the user sees it without waiting on a
    // poll round-trip.
    mountNextFromPendingStack();
  }

  function respondToPermission(behavior: 'allow' | 'deny') {
    respondedRequestIds.add(perm.request_id);
    // Send with the OWNING project's secret — not the active project's — so a
    // response initiated from a background-project popup still routes.
    // Include tool/description/input_preview the client already has so that
    // the server-side command-log entry has useful detail even when the
    // respond races ahead of the original permission_request log (HS-6477).
    // HS-8085 — `apiWithSecret` is the correct helper for cross-project
    // background-popup responses; sets `X-Hotsheet-Secret` to the
    // owning project's secret rather than the active project's.
    void apiWithSecret('/channel/permission/respond', secret, {
      method: 'POST',
      body: {
        request_id: perm.request_id,
        behavior,
        tool_name: perm.tool_name,
        description: perm.description,
        input_preview: perm.input_preview ?? '',
      },
    }).catch(() => { /* network blip — overlay UI already torn down by clearPopupOnly() below */ });
    clearProjectAttention(secret);
    // Also drop any minimized bookkeeping for this request.
    const rec = minimizedRequests.get(perm.request_id);
    if (rec) { clearTimeout(rec.timeoutId); minimizedRequests.delete(perm.request_id); syncMinimizedDots(); }
    clearPopupOnly();
    // HS-8171 v2 — release the live-terminal checkout BEFORE
    // tearing down the popup DOM so the xterm element reparents
    // cleanly into the previous owner's mountInto rather than being
    // momentarily orphaned in the removed-from-document subtree.
    releaseActiveCheckoutIfAny();
    handle.tearDownDom();
    // HS-8219 — surface the next queued permission immediately
    // (before the next ~100 ms poll tick).
    mountNextFromPendingStack();
  }

  // HS-8069 — chrome (header / anchor / footer-link row / close X) is now
  // owned by `permissionDialogShell.tsx`. Body / actions / always-affordance
  // slots carry the consumer-specific content. The shell's close button maps
  // to "No response needed" semantics (the existing §47 popup didn't have a
  // close X — adding the shell adds one, and the cleanest mapping is "user
  // dismissed without responding").
  const handle = openPermissionDialogShell({
    rootClassName: 'permission-popup',
    ariaLabel: `Permission request: ${perm.tool_name} — ${perm.description}`,
    toolChip: perm.tool_name,
    title: perm.description,
    bodyElement,
    actions,
    alwaysAffordance,
    onClose: () => { cleanupAndDismiss(); },
    onMinimize: () => { cleanupAndMinimize(); },
    onNoResponseNeeded: () => { cleanupAndDismiss(); },
    projectSecret: secret,
  });

  handle.overlay.querySelector('.permission-popup-allow')!.addEventListener('click', (e) => {
    e.stopPropagation();
    respondToPermission('allow');
  });
  handle.overlay.querySelector('.permission-popup-deny')!.addEventListener('click', (e) => {
    e.stopPropagation();
    respondToPermission('deny');
  });

  // HS-8171 v2 — check out the live project terminal into the popup
  // body container. The checkout is synchronous: `checkout()` reparents
  // the live xterm element into `liveTermContainer` in the same JS
  // task as the popup mount, so there is no intermediate render of any
  // truncated preview. The container is already DOM-connected at this
  // point because `openPermissionDialogShell` did `document.body.appendChild`
  // synchronously above. After reparenting, we propose dimensions from
  // the rendered container and resize to fit so Claude's TUI redraws
  // for the popup geometry; on `release()` (popup close / dismiss /
  // respond) the previous owner re-takes the top of the stack and
  // gets its own dims back.
  if (useLiveCheckout && liveTermContainer !== null) {
    // HS-8182 — defensive: if a stale handle survives from a prior
    // popup (e.g. the polling loop's auto-dismiss path was never
    // exercised), release it before claiming a new one. The `checkout`
    // call itself bumps the previous owner down, but releasing the
    // stale handle first keeps `permissionState.activeCheckoutHandle` the single
    // source of truth for "the popup currently owning the live xterm".
    releaseActiveCheckoutIfAny();
    // HS-8207 — pass through the EXISTING entry's dims (when there is
    // one — drawer pane / dashboard tile already mounted) so the
    // checkout's swap-time `applyResizeIfChanged` is a no-op (no
    // SIGWINCH, no TUI redraw). Pre-fix the popup hardcoded
    // `cols: 100, rows: 30`, which fired one redraw at checkout, and
    // then the fit-retry below resized to popup-fit dims firing a
    // second redraw back-to-back. The user perceived the two
    // back-to-back claude TUI redraws as the "shows some content →
    // shows completely different content" multi-phase symptom.
    // Post-fix, only the fit-retry's resize causes a redraw — single
    // visible state change. When NO existing entry exists (popup is
    // first consumer of this terminal), default to (80, 24): a
    // sensible TUI baseline that's closer to popup-fit than (100, 30)
    // so the fit-retry's resize is small or no-op.
    const existingDims = peekEntryDims(secret, 'default');
    const startCols = existingDims?.cols ?? 80;
    const startRows = existingDims?.rows ?? 24;
    permissionState.activeCheckoutHandle = checkout({
      projectSecret: secret,
      terminalId: 'default',
      cols: startCols,
      rows: startRows,
      mountInto: liveTermContainer,
      // HS-8218 — never spawn a fresh PTY for the popup. Pre-fix when
      // the project's claude was running under a NON-`'default'`
      // terminal id (and `'default'` had no live session), the
      // popup's `attach` call on the server side spawned a brand-new
      // `claude --dangerously-load-development-channels` PTY which
      // stole the channel-server's MCP connection from the user's
      // actual claude session. Symptom (HS-8218 repro): popup briefly
      // shows blank → channel-approval prompt → fresh claude REPL →
      // permission popup auto-dismisses (because the original
      // claude's MCP request was orphaned). With `noSpawn: true` the
      // server returns `noSession: true` instead of spawning, and we
      // fall back to the flat / diff preview via the
      // `onNoLiveSession` callback below.
      noSpawn: true,
      onNoLiveSession: () => { fallbackToNonLivePreview(); },
    });
    // HS-8206 v2 — `proposeDimensions()` returns undefined when xterm's
    // renderer hasn't measured cell dims for the new layout
    // (`renderService.dimensions.css.cell` is 0×0). Right after the term
    // reparents out of the offscreen 1×1 parking sink, the renderer
    // hasn't yet rendered a frame in the popup container, so cell dims
    // are 0. The HS-8206 v1 ResizeObserver fired once on initial observe
    // + bailed if dims were undefined; with a fixed-CSS-size popup
    // container no further size-change events ever fire, so the term
    // stayed at the initial 100×30 forever. Fix: kick a retry loop that
    // polls `proposeDimensions()` until it returns valid dims (cell
    // metrics measured) or we exhaust the retry budget. The
    // ResizeObserver still installs in case a window resize / DPR change
    // shifts the popup CSS layout mid-popup; same retry path runs from
    // the observer's callback. `pendingFit` coalesces overlapping fit
    // attempts; the proposed-vs-current short-circuit prevents the
    // well-known fit/observe feedback loop.
    disconnectActiveLiveTermResizeObserver();
    runLiveTermFitWithRetry(permissionState.activeCheckoutHandle);
    if (typeof ResizeObserver !== 'undefined') {
      permissionState.activeLiveTermResizeObserver = new ResizeObserver(() => {
        if (permissionState.activeCheckoutHandle === null) return;
        runLiveTermFitWithRetry(permissionState.activeCheckoutHandle);
      });
      permissionState.activeLiveTermResizeObserver.observe(liveTermContainer);
    }
  }

  // Notify via Tauri attention.
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  // HS-7266: no outside-click handler. The popup is non-modal and only
  // closes via Allow / Deny / Minimize / No-response-needed / X.
}

// --- Test-only exports (HS-8183) -------------------------------------------

/** **TEST ONLY** — reset every module-level state slot back to its boot
 *  default so consecutive tests don't leak. Mirrors the convention in
 *  `terminalCheckout.tsx::_resetForTesting` + `bellPoll.ts::_resetDispatchStateForTesting`.
 *  Stops any in-flight polling loop too.
 *
 *  HS-8190 — runs disposers BEFORE assigning a fresh state so an in-flight
 *  resize observer or fit-retry timer doesn't leak past the swap. The
 *  collection-typed state (responded / dismissed / minimized / pending
 *  stack) is cleared explicitly because those are separate const Set/Map/
 *  Array containers, not part of the bundled state object. */
export function _resetStateForTesting(): void {
  disconnectActiveLiveTermResizeObserver();
  clearLiveTermFitRetryTimer();
  respondedRequestIds.clear();
  dismissedRequestIds.clear();
  for (const rec of minimizedRequests.values()) clearTimeout(rec.timeoutId);
  minimizedRequests.clear();
  pendingPermissionStack.length = 0;
  lastSeenPendingBySecret.clear();
  permissionState = freshPermissionOverlayState();
}

/** **TEST ONLY** (HS-8294) — read-only snapshot of the per-secret pending
 *  request_id tracker so unit tests can assert the right entries land. */
export function _lastSeenPendingForTesting(): ReadonlyMap<string, string> {
  return new Map(lastSeenPendingBySecret);
}

/** **TEST ONLY** — read-only snapshot of the module-level bookkeeping for
 *  assertions. Returns a plain object so test code can spread / compare
 *  without holding live references. */
export function _inspectStateForTesting(): {
  activePopupRequestId: string | null;
  activePopupOwnerSecret: string | null;
  activeCheckoutHandle: boolean;
  activeLiveTermResizeObserver: boolean;
  respondedRequestIds: string[];
  dismissedRequestIds: string[];
  minimizedRequestIds: string[];
  /** HS-8219 — request_ids of permissions queued behind the active popup. */
  pendingPermissionStackIds: string[];
  permissionVersion: number;
  autoDismissMissCount: number;
} {
  return {
    activePopupRequestId: permissionState.activePopupRequestId,
    activePopupOwnerSecret: permissionState.activePopupOwnerSecret,
    activeCheckoutHandle: permissionState.activeCheckoutHandle !== null,
    activeLiveTermResizeObserver: permissionState.activeLiveTermResizeObserver !== null,
    respondedRequestIds: [...respondedRequestIds],
    dismissedRequestIds: [...dismissedRequestIds],
    minimizedRequestIds: [...minimizedRequests.keys()],
    pendingPermissionStackIds: pendingPermissionStack.map(e => e.perm.request_id),
    permissionVersion: permissionState.permissionVersion,
    autoDismissMissCount: permissionState.autoDismissMissCount,
  };
}
