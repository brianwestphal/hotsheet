import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { clearProjectAttention, getProjectAttentionSecrets, isChannelBusy, markProjectAttention, setChannelBusy } from './channelUI.js';
import { toElement } from './dom.js';
import { formatInputPreview } from './permissionPreview.js';
import { state } from './state.js';
import { requestAttention } from './tauriIntegration.js';

/**
 * Claude permission-request UI. Historically there were two variants: a
 * full-screen overlay for the active project and a compact popup for
 * non-active projects. HS-6536 unified them — every pending permission
 * (active or not) uses the same popup anchored to its project tab.
 */

export type PermissionData = { request_id: string; tool_name: string; description: string; input_preview?: string };

let permissionPollActive = false;
export let permissionVersion = 0;

// Track request IDs we've already responded to, so polling doesn't re-show them.
export const respondedRequestIds = new Set<string>();

// Track request IDs the user has explicitly dismissed (clicked outside the
// popup) so the next poll cycle doesn't immediately re-show the same popup
// while the channel server still has it pending. The user's intent in
// dismissing was "I see it, I'll handle it elsewhere or later" — re-asserting
// the popup every 100 ms produces a flickering-popup bug (HS-6436). Cleared
// implicitly when the channel server reports the request is no longer
// pending.
export const dismissedRequestIds = new Set<string>();

export function startPermissionPolling(channelBusyTimeout: ReturnType<typeof setTimeout> | null, setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void) {
  if (permissionPollActive) return;
  permissionPollActive = true;

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
          if (!respondedRequestIds.has(perm.request_id) && !dismissedRequestIds.has(perm.request_id)) {
            showPermissionPopup(secret, perm, channelBusyTimeout, setChannelBusyTimeoutRef);
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
      // Garbage-collect dismissed-request bookkeeping for requests the channel
      // server no longer reports — otherwise the set would grow unbounded.
      for (const id of [...dismissedRequestIds]) {
        if (!pendingRequestIds.has(id)) dismissedRequestIds.delete(id);
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

// --- Permission popup (single codepath for active + non-active projects) ---

let activePopupRequestId: string | null = null;

function showPermissionPopup(
  secret: string,
  perm: PermissionData,
  channelBusyTimeout: ReturnType<typeof setTimeout> | null,
  setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void,
) {
  // Already showing this exact request — no-op
  if (activePopupRequestId === perm.request_id) return;
  // Already responded to this request
  if (respondedRequestIds.has(perm.request_id)) return;
  // User explicitly dismissed (clicked outside) this request — don't re-show
  // until it disappears server-side (HS-6436).
  if (dismissedRequestIds.has(perm.request_id)) return;
  // Another popup is already showing — don't replace it (prevents bouncing).
  // The next poll cycle will show this one after the current is dismissed.
  if (activePopupRequestId !== null) return;

  document.querySelector('.permission-popup')?.remove();
  activePopupRequestId = perm.request_id;

  // A permission request is proof Claude is actively working — extend busy timeout.
  if (channelBusyTimeout) {
    clearTimeout(channelBusyTimeout);
    setChannelBusyTimeoutRef(setTimeout(() => {
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

  // Format Claude's raw `input_preview` into a human-readable preview — Bash
  // gets just the command line, other known tools get their primary field,
  // generic JSON gets flattened key/value lines (HS-6634).
  const previewText = perm.input_preview !== undefined ? formatInputPreview(perm.tool_name, perm.input_preview) : '';
  const hasPreview = previewText !== '';
  const popup = toElement(
    <div className="permission-popup">
      <div className="permission-popup-body">
        <div className="permission-popup-header">
          <span className="permission-popup-tool">{perm.tool_name}</span>
          <span className="permission-popup-desc">{perm.description}</span>
        </div>
        {hasPreview ? <pre className="permission-popup-preview">{previewText}</pre> : ''}
      </div>
      <div className="permission-popup-actions">
        <button className="permission-popup-allow" title="Allow">{raw(checkIcon)}</button>
        <button className="permission-popup-deny" title="Deny">{raw(xIcon)}</button>
      </div>
    </div>
  );

  function cleanup() {
    popup.remove();
    activePopupRequestId = null;
    if (tab) tab.classList.remove('permission-highlight');
    document.removeEventListener('click', outsideClick);
  }

  function outsideClick(e: MouseEvent) {
    if (!popup.contains(e.target as Node)) {
      // Record the dismissal so the next poll cycle doesn't immediately
      // re-show the same popup while the channel still has the request
      // pending (HS-6436).
      dismissedRequestIds.add(perm.request_id);
      cleanup();
    }
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
    cleanup();
  }

  popup.querySelector('.permission-popup-allow')!.addEventListener('click', (e) => {
    e.stopPropagation();
    respondToPermission('allow');
  });

  popup.querySelector('.permission-popup-deny')!.addEventListener('click', (e) => {
    e.stopPropagation();
    respondToPermission('deny');
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

  // Close on outside click (deferred so the current click doesn't immediately close).
  setTimeout(() => document.addEventListener('click', outsideClick), 0);
}
