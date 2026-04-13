import { api } from './api.js';
import { clearProjectAttention, getProjectAttentionSecrets, isChannelBusy, markProjectAttention, setChannelBusy } from './channelUI.js';
import { toElement } from './dom.js';
import { getActiveProject, state } from './state.js';
import { requestAttention } from './tauriIntegration.js';

// --- Permission Overlay ---

export type PermissionData = { request_id: string; tool_name: string; description: string; input_preview?: string };

let permissionPollActive = false;
export let permissionVersion = 0;
export let currentOverlayRequestId: string | null = null;

// Track request IDs we've already responded to, so polling doesn't re-show them
export const respondedRequestIds = new Set<string>();

export function startPermissionPolling(channelBusyTimeout: ReturnType<typeof setTimeout> | null, setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void) {
  if (permissionPollActive) return;
  permissionPollActive = true;

  async function poll() {
    if (!permissionPollActive) return;
    try {
      const data = await api<{ permissions: Record<string, PermissionData | null>; v: number }>(`/projects/permissions?v=${permissionVersion}`);
      permissionVersion = data.v;
      const activeSecret = getActiveProject()?.secret;

      // Check the active project's permission state
      const activePerm = activeSecret !== undefined ? (data.permissions[activeSecret] ?? null) : null;

      // Auto-dismiss if the permission was handled elsewhere (e.g., in Claude Code)
      if (currentOverlayRequestId !== null && (activePerm === null || activePerm.request_id !== currentOverlayRequestId)) {
        dismissOverlay();
      }

      // Show/update overlay for the active project
      if (activePerm !== null) {
        showPermissionOverlay(activePerm, channelBusyTimeout, setChannelBusyTimeoutRef);
      }

      // Mark attention dots for projects with pending permissions, clear all others.
      // Must clear ALL tracked projects — not just ones in the response — otherwise
      // dots from a previous poll stick when the response is empty (e.g. channel
      // disabled, session ended, or the permissions map only includes a subset).
      const pendingSecrets = new Set<string>();
      for (const [secret, perm] of Object.entries(data.permissions)) {
        if (perm !== null) {
          pendingSecrets.add(secret);
          markProjectAttention(secret);
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

/** Dismiss the permission overlay without responding (e.g., permission handled elsewhere). */
export function dismissOverlay() {
  const overlay = document.getElementById('permission-overlay');
  if (overlay) overlay.style.display = 'none';
  currentOverlayRequestId = null;
}

function showPermissionOverlay(
  perm: PermissionData,
  channelBusyTimeout: ReturnType<typeof setTimeout> | null,
  setChannelBusyTimeoutRef: (t: ReturnType<typeof setTimeout> | null) => void,
) {
  const overlay = document.getElementById('permission-overlay');
  if (!overlay) return;
  if (respondedRequestIds.has(perm.request_id)) return;

  // A permission request is proof Claude is actively working — extend the busy timeout
  if (channelBusyTimeout) {
    clearTimeout(channelBusyTimeout);
    setChannelBusyTimeoutRef(setTimeout(() => {
      if (isChannelBusy()) setChannelBusy(false);
    }, 60000));
  }
  // If we're not marked busy but got a permission request, mark busy now
  if (!isChannelBusy()) setChannelBusy(true);

  // Already showing this exact permission
  if (currentOverlayRequestId === perm.request_id) return;
  // New permission replaces any currently shown one
  currentOverlayRequestId = perm.request_id;
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  const detail = document.getElementById('permission-overlay-detail');
  if (detail) {
    const content = toElement(
      <div>
        <div className="permission-tool">{perm.tool_name}: {perm.description}</div>
        {perm.input_preview !== undefined && perm.input_preview !== ''
          ? <pre className="permission-preview">{perm.input_preview}</pre>
          : ''}
      </div>
    );
    detail.innerHTML = '';
    // Append each child node instead of using the wrapper div
    while (content.firstChild) detail.appendChild(content.firstChild);
  }

  overlay.style.display = '';

  function respond(behavior: 'allow' | 'deny') {
    respondedRequestIds.add(perm.request_id);
    currentOverlayRequestId = null;
    void api('/channel/permission/respond', {
      method: 'POST',
      body: { request_id: perm.request_id, behavior },
    });
    overlay!.style.display = 'none';
    const activeSecret = getActiveProject()?.secret;
    if (activeSecret !== undefined && activeSecret !== '') clearProjectAttention(activeSecret);
  }

  function dismiss() {
    respondedRequestIds.add(perm.request_id);
    currentOverlayRequestId = null;
    void api('/channel/permission/dismiss', { method: 'POST' });
    overlay!.style.display = 'none';
    const activeSecret = getActiveProject()?.secret;
    if (activeSecret !== undefined && activeSecret !== '') clearProjectAttention(activeSecret);
  }

  // Use one-time click handlers via { once: true }
  document.getElementById('permission-allow-btn')?.addEventListener('click', () => respond('allow'), { once: true });
  document.getElementById('permission-deny-btn')?.addEventListener('click', () => respond('deny'), { once: true });
  document.getElementById('permission-dismiss-btn')?.addEventListener('click', dismiss, { once: true });
}
