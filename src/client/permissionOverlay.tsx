import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { clearProjectAttention, getProjectAttentionSecrets, isChannelBusy, markProjectAttention, setChannelBusy } from './channelUI.js';
import { toElement } from './dom.js';
import { renderEditDiffPreview } from './editDiffPreview.js';
import { formatEditDiff, formatInputPreview } from './permissionPreview.js';
import { state } from './state.js';
import { requestAttention } from './tauriIntegration.js';

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
      await new Promise(r => setTimeout(r, 5000));
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
    }, 60000));
  }
  if (!isChannelBusy()) setChannelBusy(true);

  // Find the tab element to position near and highlight. The active tab has
  // the same `.project-tab[data-secret=...]` selector — the popup renders
  // the same way regardless of which tab is active (HS-6536).
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
  const popup = toElement(
    <div className="permission-popup">
      <div className="permission-popup-body">
        <div className="permission-popup-header">
          <span className="permission-popup-tool">{perm.tool_name}</span>
          <span className="permission-popup-desc">{perm.description}</span>
        </div>
        {editDiff !== null
          ? <div className="permission-popup-diff-slot"></div>
          : (hasStringPreview ? <pre className="permission-popup-preview">{previewText}</pre> : '')}
        <div className="permission-popup-links">
          <a className="permission-popup-minimize-link" href="#">Minimize</a>
          <span className="permission-popup-links-sep">·</span>
          <a className="permission-popup-dismiss-link" href="#">No response needed</a>
        </div>
      </div>
      <div className="permission-popup-actions">
        <button className="permission-popup-allow" title="Allow">{raw(checkIcon)}</button>
        <button className="permission-popup-deny" title="Deny">{raw(xIcon)}</button>
      </div>
    </div>
  );

  // Mount the diff preview into its slot (after the popup has been built so
  // the slot exists). renderEditDiffPreview returns a fully-built DOM tree
  // that we drop into place.
  if (editDiff !== null) {
    const slot = popup.querySelector<HTMLElement>('.permission-popup-diff-slot');
    if (slot !== null) slot.replaceWith(renderEditDiffPreview(editDiff));
  }

  function clearPopupOnly() {
    popup.remove();
    activePopupRequestId = null;
    if (tab) tab.classList.remove('permission-highlight');
  }

  function cleanupAndDismiss() {
    dismissedRequestIds.add(perm.request_id);
    clearPopupOnly();
  }

  function cleanupAndMinimize() {
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
    void fetch('/api/channel/permission/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
      body: JSON.stringify({
        request_id: perm.request_id,
        behavior,
        tool_name: perm.tool_name,
        description: perm.description,
        input_preview: perm.input_preview ?? '',
      }),
    });
    clearProjectAttention(secret);
    // Also drop any minimized bookkeeping for this request.
    const rec = minimizedRequests.get(perm.request_id);
    if (rec) { clearTimeout(rec.timeoutId); minimizedRequests.delete(perm.request_id); syncMinimizedDots(); }
    clearPopupOnly();
  }

  popup.querySelector('.permission-popup-allow')!.addEventListener('click', (e) => {
    e.stopPropagation();
    respondToPermission('allow');
  });

  popup.querySelector('.permission-popup-deny')!.addEventListener('click', (e) => {
    e.stopPropagation();
    respondToPermission('deny');
  });

  popup.querySelector('.permission-popup-minimize-link')!.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cleanupAndMinimize();
  });

  popup.querySelector('.permission-popup-dismiss-link')!.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cleanupAndDismiss();
  });

  document.body.appendChild(popup);

  // Position below the tab (or at top-center if no tab found). After layout
  // the full popup width is known — clamp horizontally so it never overflows.
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - popupRect.width - 8);
    popup.style.top = `${tabRect.bottom + 4}px`;
    popup.style.left = `${Math.min(Math.max(8, tabRect.left), maxLeft)}px`;
  }

  // Notify via Tauri attention.
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  // HS-7266: no outside-click handler. The popup is non-modal and only
  // closes via Allow / Deny / Minimize / No-response-needed.
}
