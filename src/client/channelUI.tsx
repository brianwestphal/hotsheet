import { api } from './api.js';
import { toElement } from './dom.js';
import { getActiveProject, state } from './state.js';
import { requestAttention } from './tauriIntegration.js';

// --- Permission Overlay ---

let permissionPollInterval: ReturnType<typeof setInterval> | null = null;

function startPermissionPolling() {
  if (permissionPollInterval) return;
  permissionPollInterval = setInterval(async () => {
    try {
      const data = await api<{ pending: { request_id: string; tool_name: string; description: string; input_preview?: string } | null }>('/channel/permission');
      if (data.pending) {
        showPermissionOverlay(data.pending);
      }
    } catch { /* ignore */ }
  }, 2000);
}

function stopPermissionPolling() {
  if (permissionPollInterval) { clearInterval(permissionPollInterval); permissionPollInterval = null; }
}

// Track request IDs we've already responded to, so polling doesn't re-show them
const respondedRequestIds = new Set<string>();

function showPermissionOverlay(perm: { request_id: string; tool_name: string; description: string; input_preview?: string }) {
  const overlay = document.getElementById('permission-overlay');
  if (!overlay || overlay.style.display !== 'none') return;
  if (respondedRequestIds.has(perm.request_id)) return;
  // Track which project needs attention for tab dots
  const secret = getActiveProject()?.secret;
  if (secret) markProjectAttention(secret);
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  const detail = document.getElementById('permission-overlay-detail');
  if (detail) {
    let html = `<div class="permission-tool">${perm.tool_name}: ${perm.description}</div>`;
    if (perm.input_preview !== undefined && perm.input_preview !== '') {
      html += `<pre class="permission-preview">${perm.input_preview.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    }
    detail.innerHTML = html;
  }

  overlay.style.display = '';

  function respond(behavior: 'allow' | 'deny') {
    respondedRequestIds.add(perm.request_id);
    void api('/channel/permission/respond', {
      method: 'POST',
      body: { request_id: perm.request_id, behavior },
    });
    overlay!.style.display = 'none';
    if (secret) clearProjectAttention(secret);
  }

  function dismiss() {
    respondedRequestIds.add(perm.request_id);
    void api('/channel/permission/dismiss', { method: 'POST' });
    overlay!.style.display = 'none';
    if (secret) clearProjectAttention(secret);
  }

  // Use one-time click handlers via { once: true }
  document.getElementById('permission-allow-btn')?.addEventListener('click', () => respond('allow'), { once: true });
  document.getElementById('permission-deny-btn')?.addEventListener('click', () => respond('deny'), { once: true });
  document.getElementById('permission-dismiss-btn')?.addEventListener('click', dismiss, { once: true });
}

// --- Claude Channel ---

let channelAutoMode = false;
let channelDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let channelBusy = false;
let channelBusyTimeout: ReturnType<typeof setTimeout> | null = null;
let channelAutoRetryInterval: ReturnType<typeof setInterval> | null = null;
let channelAutoBackoff = 0; // consecutive triggers where Claude didn't become busy
let channelAutoVerifyTimeout: ReturnType<typeof setTimeout> | null = null;
const CHANNEL_AUTO_BASE_DELAY = 5000;
const CHANNEL_AUTO_MAX_DELAY = 120000; // 2 minutes

export function isChannelBusy(): boolean { return channelBusy; }
export function isChannelAlive(): boolean { return channelAliveLocal; }

let channelAliveLocal = false;

/** Update alive state — called from initChannel and checkChannelDone */
export function setChannelAlive(alive: boolean) {
  channelAliveLocal = alive;
  const warning = document.getElementById('channel-disconnected');
  if (!warning) return;
  const section = document.getElementById('channel-play-section');
  const enabled = section !== null && section.style.display !== 'none';
  warning.style.display = enabled && !alive ? '' : 'none';
}
export function isPermissionPending(): boolean {
  const overlay = document.getElementById('permission-overlay');
  return overlay !== null && overlay.style.display !== 'none';
}

// Per-project busy/attention tracking for tab status dots
const busyProjects = new Set<string>();
const attentionProjects = new Set<string>();

export function getProjectBusySecrets(): ReadonlySet<string> { return busyProjects; }
export function getProjectAttentionSecrets(): ReadonlySet<string> { return attentionProjects; }

function syncDots() {
  // Lazy import to avoid circular dependency at module init time
  const dots = document.querySelectorAll('.project-tab-dot');
  if (dots.length === 0) return;
  import('./projectTabs.js').then(m => m.updateStatusDots()).catch(() => {});
}

function markProjectBusy(secret: string) {
  busyProjects.add(secret);
  syncDots();
}

function clearProjectBusy(secret: string) {
  busyProjects.delete(secret);
  syncDots();
}

export function markProjectAttention(secret: string) {
  attentionProjects.add(secret);
  syncDots();
}

export function clearProjectAttention(secret: string) {
  attentionProjects.delete(secret);
  syncDots();
}

export function setChannelBusy(busy: boolean) {
  channelBusy = busy;
  const indicator = document.getElementById('channel-status-indicator');
  if (!indicator) return;
  const channelSection = document.getElementById('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') {
    indicator.style.display = 'none';
    return;
  }
  if (busy) {
    indicator.style.display = '';
    indicator.className = 'channel-status-indicator busy';
    indicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Claude working';
    // Claude picked up work — reset exponential backoff (HS-2049)
    channelAutoBackoff = 0;
    if (channelAutoVerifyTimeout) { clearTimeout(channelAutoVerifyTimeout); channelAutoVerifyTimeout = null; }
  } else {
    indicator.style.display = '';
    indicator.className = 'channel-status-indicator';
    indicator.innerHTML = '\u2713 Claude idle';
    if (state.settings.notify_completed !== 'none') {
      requestAttention(state.settings.notify_completed);
    }
    // Auto-hide after 5 seconds
    setTimeout(() => {
      if (!channelBusy) indicator.style.display = 'none';
    }, 5000);
    // In auto mode, check for more up-next items when Claude becomes idle (HS-1453)
    if (channelAutoMode) {
      channelAutoTrigger();
    }
  }
}

function triggerChannelAndMarkBusy(message?: string) {
  setChannelBusy(true);
  // Track which project is busy for tab status dots
  const secret = getActiveProject()?.secret;
  if (secret) markProjectBusy(secret);
  // Ensure AI tool skills are installed/up-to-date before triggering
  void api('/ensure-skills', { method: 'POST' });
  void api('/channel/trigger', { method: 'POST', body: { message } });
  // Timeout fallback: clear busy after 120s if Claude never calls /done
  if (channelBusyTimeout) clearTimeout(channelBusyTimeout);
  channelBusyTimeout = setTimeout(() => {
    if (channelBusy) setChannelBusy(false);
    if (secret) clearProjectBusy(secret);
  }, 120000);
}

// Exported so experimentalSettings can call it for custom command buttons
export { triggerChannelAndMarkBusy };

async function checkAndTrigger(btn: HTMLElement) {
  // Check if Claude is connected before triggering
  if (!isChannelAlive()) {
    showDisconnectedAlert();
    return;
  }
  try {
    const stats = await api<{ up_next: number }>('/stats');
    if (stats.up_next === 0 && !state.settings.auto_order) {
      showNoUpNextAlert();
      return;
    }
  } catch { /* proceed anyway if stats fail */ }
  btn.classList.add('pulsing');
  setTimeout(() => btn.classList.remove('pulsing'), 600);
  triggerChannelAndMarkBusy();
}

function showDisconnectedAlert() {
  const existing = document.getElementById('channel-disconnected-alert');
  if (existing) existing.remove();
  const alert = toElement(
    <div id="channel-disconnected-alert" className="no-upnext-alert">
      <span>Claude is not connected. Launch Claude Code with channel support first.</span>
      <button className="no-upnext-dismiss">{'\u00d7'}</button>
    </div>
  );
  alert.querySelector('.no-upnext-dismiss')!.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), 6000);
  const playSection = document.getElementById('channel-play-section');
  if (playSection) playSection.after(alert);
}

function showNoUpNextAlert() {
  const existing = document.getElementById('no-upnext-alert');
  if (existing) existing.remove();
  const alert = toElement(
    <div id="no-upnext-alert" className="no-upnext-alert">
      <span>No Up Next items to process</span>
      <button className="no-upnext-dismiss">{'\u00d7'}</button>
    </div>
  );
  alert.querySelector('.no-upnext-dismiss')!.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), 4000);
  const playSection = document.getElementById('channel-play-section');
  if (playSection) playSection.after(alert);
}

export async function initChannel() {
  let status: { enabled: boolean; alive: boolean } | null = null;
  try {
    status = await api<{ enabled: boolean; alive: boolean }>('/channel/status');
  } catch { /* endpoint may not exist yet */ }
  // If we couldn't reach the server, keep the previous state
  if (status === null) return;
  const section = document.getElementById('channel-play-section')!;
  const btn = document.getElementById('channel-play-btn')!;
  const playIcon = document.getElementById('channel-play-icon')!;
  const autoIcon = document.getElementById('channel-auto-icon')!;

  // Always render custom commands (shell commands work without channel)
  const { renderChannelCommands, setChannelEnabledState } = await import('./experimentalSettings.js');
  setChannelEnabledState(status.enabled);

  if (!status.enabled) {
    section.style.display = 'none';
    setChannelAlive(false);
    stopPermissionPolling();
    renderChannelCommands(); // Still render shell commands
    return;
  }
  section.style.display = '';
  setChannelAlive(status.alive);
  renderChannelCommands();
  startPermissionPolling();

  // Only bind the click handler once (initChannel is called on every project switch)
  if (btn.dataset.bound) return;
  btn.dataset.bound = 'true';

  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  btn.addEventListener('click', () => {
    if (clickTimer) {
      // Double click detected
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleAutoMode(btn, playIcon, autoIcon);
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (channelAutoMode) {
          // Single click while in auto mode: turn off
          toggleAutoMode(btn, playIcon, autoIcon);
        } else {
          // Single click: on-demand trigger — check for up-next items first
          void checkAndTrigger(btn);
        }
      }, 250);
    }
  });
}

function toggleAutoMode(btn: HTMLElement, playIcon: HTMLElement, autoIcon: HTMLElement) {
  channelAutoMode = !channelAutoMode;
  if (channelAutoMode) {
    btn.classList.add('auto-mode');
    playIcon.style.display = 'none';
    autoIcon.style.display = '';
    channelAutoBackoff = 0;
    // Start initial 5-second debounce when entering auto mode (HS-1453)
    channelAutoTrigger();
  } else {
    btn.classList.remove('auto-mode');
    playIcon.style.display = '';
    autoIcon.style.display = 'none';
    // Clear pending debounce and retry when leaving auto mode
    if (channelDebounceTimeout) { clearTimeout(channelDebounceTimeout); channelDebounceTimeout = null; }
    if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }
    if (channelAutoVerifyTimeout) { clearTimeout(channelAutoVerifyTimeout); channelAutoVerifyTimeout = null; }
    channelAutoBackoff = 0;
  }
}

/** Returns the current auto-trigger delay with exponential backoff.
 *  Base: 5s. Doubles with each consecutive failed trigger. Max: 2 minutes. */
function autoTriggerDelay(): number {
  if (channelAutoBackoff === 0) return CHANNEL_AUTO_BASE_DELAY;
  return Math.min(CHANNEL_AUTO_BASE_DELAY * Math.pow(2, channelAutoBackoff), CHANNEL_AUTO_MAX_DELAY);
}

/** Called when entering auto mode or when a ticket's up_next changes.
 *  Debounces, then attempts to trigger. Restarts debounce on new up-next items. (HS-1453)
 *  Uses exponential backoff if triggers don't result in Claude becoming busy. (HS-2049) */
export function channelAutoTrigger() {
  if (!channelAutoMode) return;
  // Restart the debounce (new up-next items restart the timer and reset backoff)
  if (channelDebounceTimeout) clearTimeout(channelDebounceTimeout);
  // Clear any existing retry interval — fresh debounce takes priority
  if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }

  channelDebounceTimeout = setTimeout(() => {
    channelDebounceTimeout = null;
    void attemptAutoTrigger();
  }, autoTriggerDelay());
}

/** After debounce, try to trigger Claude. If busy, retry with backoff until idle. (HS-1453, HS-2049) */
async function attemptAutoTrigger() {
  if (!channelAutoMode) return;

  // Check if there are up-next items (skip check if auto-prioritize will handle it)
  try {
    const stats = await api<{ up_next: number }>('/stats');
    if (stats.up_next === 0 && !state.settings.auto_order) return;
  } catch { /* proceed anyway */ }

  if (!channelBusy) {
    // Claude is idle — trigger now
    if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }
    triggerChannelAndMarkBusy();

    // Verify Claude actually became busy after a short delay. If not, increase backoff.
    if (channelAutoVerifyTimeout) clearTimeout(channelAutoVerifyTimeout);
    channelAutoVerifyTimeout = setTimeout(() => {
      channelAutoVerifyTimeout = null;
      if (!channelBusy && channelAutoMode) {
        // Claude didn't pick up — increase backoff for next attempt
        channelAutoBackoff++;
      }
    }, 10000);
  } else if (!channelAutoRetryInterval) {
    // Claude is busy — start retrying with current backoff delay
    const delay = autoTriggerDelay();
    channelAutoRetryInterval = setInterval(() => {
      if (!channelAutoMode) {
        clearInterval(channelAutoRetryInterval!);
        channelAutoRetryInterval = null;
        return;
      }
      void attemptAutoTrigger();
    }, delay);
  }
}

/** Check if Claude signaled done and refresh alive status — called from long polling */
export function checkChannelDone() {
  const section = document.getElementById('channel-play-section');
  const enabled = section !== null && section.style.display !== 'none';
  if (!enabled) return;

  api<{ done?: boolean; alive?: boolean }>('/channel/status').then(s => {
    if (!s) return;
    // Update alive/disconnected warning
    if (s.alive !== undefined) setChannelAlive(s.alive);
    // Check for done signal
    if (channelBusy && s.done === true) {
      setChannelBusy(false);
      if (channelBusyTimeout) { clearTimeout(channelBusyTimeout); channelBusyTimeout = null; }
      const secret = getActiveProject()?.secret;
      if (secret) clearProjectBusy(secret);
    }
  }).catch(() => {});
}
