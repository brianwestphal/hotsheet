import { raw } from '../jsx-runtime.js';
import { extractPrimaryValue } from '../permissionAllowRules.js';
import { api, apiWithSecret } from './api.js';
import { clearProjectAttention, getProjectAttentionSecrets, isChannelBusy, markProjectAttention, setChannelBusy } from './channelUI.js';
import { TIMERS } from './constants/timers.js';
import { toElement } from './dom.js';
import { renderEditDiffPreview } from './editDiffPreview.js';
import { buildAlwaysAllowAffordance } from './permissionAllowListUI.js';
import { openPermissionDialogShell } from './permissionDialogShell.js';
import { formatEditDiff, formatInputPreview } from './permissionPreview.js';
import { state } from './state.js';
import { requestAttention } from './tauriIntegration.js';
import { checkout, type CheckoutHandle } from './terminalCheckout.js';

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

let permissionPollActive = false;
export let permissionVersion = 0;

// Track request IDs we've already responded to, so polling doesn't re-show them.
export const respondedRequestIds = new Set<string>();

// Request IDs the user has explicitly dismissed ("No response needed" link, or
// auto-expired minimized popups). The channel-server request is still pending;
// polling will not re-show the popup until it disappears server-side (HS-6436).
export const dismissedRequestIds = new Set<string>();

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

/** Module-level channel-busy-timeout refs, captured at poll start so the
 *  popup's reopen path can extend the timeout from anywhere. */
let channelBusyTimeoutModule: ReturnType<typeof setTimeout> | null = null;
let setChannelBusyTimeoutRefModule: (t: ReturnType<typeof setTimeout> | null) => void = () => {};

export function startPermissionPolling(channelBusyTimeout: ReturnType<typeof setTimeout> | null, setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void) {
  if (permissionPollActive) return;
  permissionPollActive = true;
  channelBusyTimeoutModule = channelBusyTimeout;
  setChannelBusyTimeoutRefModule = (t) => { channelBusyTimeoutModule = t; setChannelBusyTimeoutRef(t); };

  async function poll() {
    if (!permissionPollActive) return;
    try {
      const data = await api<{ permissions: Record<string, PermissionData | null>; v: number }>(`/projects/permissions?v=${permissionVersion}`);
      permissionVersion = data.v;

      // Auto-dismiss an open popup if its backing permission was handled elsewhere.
      if (activePopupRequestId !== null) {
        const stillPending = Object.values(data.permissions).some(
          p => p !== null && p.request_id === activePopupRequestId,
        );
        if (!stillPending) {
          // HS-8182 — release the §54 checkout BEFORE removing the
          // popup DOM so the live xterm element reparents back into
          // the previous owner's `mountInto` rather than being
          // orphaned in the removed-from-document subtree. Without
          // this, the dashboard tile / drawer pane that was bumped
          // down stays stuck on the 'Terminal in use elsewhere'
          // placeholder when the permission times out.
          releaseActiveCheckoutIfAny();
          document.querySelector('.permission-popup')?.remove();
          activePopupRequestId = null;
        }
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

    } catch {
      await new Promise(r => setTimeout(r, TIMERS.POLL_RETRY_MS));
    }
    if (permissionPollActive) setTimeout(poll, 100); // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- can be set false by stopPermissionPolling()
  }
  void poll();
}

export function stopPermissionPolling() {
  permissionPollActive = false;
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

let activePopupRequestId: string | null = null;

/** HS-8171 v2 / HS-8182 — module-level handle for the live-terminal
 *  checkout the active popup may have taken. Hoisted out of
 *  `showPermissionPopup`'s closure so the polling-loop's auto-dismiss
 *  path (which fires when the channel server stops reporting the
 *  permission as pending — e.g. the user typed a response directly
 *  into the terminal, or the long-text popup timed out at the channel
 *  server) can release the checkout too. Pre-HS-8182 the auto-dismiss
 *  path only removed the popup DOM, leaving the §54 stack with a
 *  consumer whose `mountInto` was now in a detached subtree — the
 *  previous owner (dashboard tile, drawer pane) stayed stuck on the
 *  'Terminal in use elsewhere' placeholder forever. */
let activeCheckoutHandle: CheckoutHandle | null = null;

function releaseActiveCheckoutIfAny(): void {
  if (activeCheckoutHandle === null) return;
  try { activeCheckoutHandle.release(); } catch { /* swallow — entry may already be torn down */ }
  activeCheckoutHandle = null;
}

function showPermissionPopup(secret: string, perm: PermissionData) {
  // Already showing this exact request — no-op
  if (activePopupRequestId === perm.request_id) return;
  // Already responded to this request
  if (respondedRequestIds.has(perm.request_id)) return;
  // User explicitly dismissed this request — don't re-show until it
  // disappears server-side (HS-6436).
  if (dismissedRequestIds.has(perm.request_id)) return;
  // Another popup is already showing — don't replace it (prevents bouncing).
  // The next poll cycle will show this one after the current is dismissed.
  if (activePopupRequestId !== null) return;

  document.querySelector('.permission-popup')?.remove();
  activePopupRequestId = perm.request_id;

  // A permission request is proof Claude is actively working — extend busy timeout.
  if (channelBusyTimeoutModule) {
    clearTimeout(channelBusyTimeoutModule);
    setChannelBusyTimeoutRefModule(setTimeout(() => {
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

  // HS-8171 v2 — when a truncation indicator fires, the popup body
  // becomes the LIVE project terminal via the §54 checkout mechanism
  // instead of a one-shot serialized mirror. The user can scroll
  // through the real PTY scrollback AND interact with the running
  // `claude` directly from inside the popup. When the popup is
  // dismissed / minimized / responded to, the checkout releases and
  // the previous owner (drawer pane, dashboard tile, etc.) gets the
  // terminal back via the LIFO stack. Pre-fix iterations (HS-7999
  // / HS-8139 / HS-8158 / HS-8171 v1) tried to mount a serialized
  // snapshot — the user reported repeated cases where the snapshot
  // sampled stale or empty content. A real checkout sidesteps the
  // sampling problem entirely. Two truncation shapes (HS-7999 + HS-8139):
  //   1. `previewText` ending in `…` (flat-string preview that
  //      `formatInputPreview`'s fallback recovered from a truncated JSON).
  //   2. `editDiff.truncated === true` (Edit/Write diff that
  //      `formatEditDiff` recovered from a truncated payload).
  const flatTruncated = hasStringPreview && previewText.endsWith('…');
  const diffTruncated = editDiff !== null && editDiff.truncated;
  const useLiveCheckout = perm.input_preview !== undefined && (flatTruncated || diffTruncated);

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
  // scope (`activeCheckoutHandle`) so the polling-loop's auto-dismiss
  // path can release it too. Every popup-close path inside this scope
  // routes through `releaseActiveCheckoutIfAny()` so the release is
  // idempotent + single-source-of-truth.

  function clearPopupOnly() {
    activePopupRequestId = null;
    if (tab) tab.classList.remove('permission-highlight');
  }

  function cleanupAndDismiss() {
    releaseActiveCheckoutIfAny();
    dismissedRequestIds.add(perm.request_id);
    clearPopupOnly();
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
    // stale handle first keeps `activeCheckoutHandle` the single
    // source of truth for "the popup currently owning the live xterm".
    releaseActiveCheckoutIfAny();
    activeCheckoutHandle = checkout({
      projectSecret: secret,
      terminalId: 'default',
      cols: 100,
      rows: 30,
      mountInto: liveTermContainer,
    });
    // Defer the fit one frame so the container has computed layout
    // dimensions before `proposeDimensions` measures it.
    requestAnimationFrame(() => {
      if (activeCheckoutHandle === null) return;
      const dims = activeCheckoutHandle.fit.proposeDimensions();
      if (dims === undefined) return;
      activeCheckoutHandle.resize(dims.cols, dims.rows);
    });
  }

  // Notify via Tauri attention.
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  // HS-7266: no outside-click handler. The popup is non-modal and only
  // closes via Allow / Deny / Minimize / No-response-needed / X.
}

