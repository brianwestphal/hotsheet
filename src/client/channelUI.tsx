import { shouldShowDegradedBusy } from '../terminals/claudeSpinner.js';
import { api, apiWithSecret } from './api.js';
import { TIMERS } from './constants/timers.js';
import { toElement } from './dom.js';
import {
  startPermissionPolling, stopPermissionPolling,
} from './permissionOverlay.js';
import { getActiveProject, state } from './state.js';
import { requestAttention } from './tauriIntegration.js';

// --- Claude Channel ---

let channelAutoMode = false;
const autoModeByProject = new Map<string, boolean>();
let channelDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let channelBusy = false;
let shellBusyState = false;

// Spinner SVG shared by channel and shell indicator states (12x12)
const SPINNER_12 = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

/** HS-6702 — most-recent Claude busy-spinner timestamp across all alive
 *  terminals in the active project, polled every 2s while the channel is
 *  reporting busy. Null when we haven't polled yet or no spinner has been
 *  seen recently. The poll only runs while `isChannelBusy()` is true so
 *  it doesn't cost anything during idle periods. */
let mostRecentSpinnerAtMs: number | null = null;
let spinnerPollInterval: ReturnType<typeof setInterval> | null = null;

async function refreshSpinnerActivity(): Promise<void> {
  const project = getActiveProject();
  if (project === null) return;
  try {
    const data = await apiWithSecret<{
      configured: { lastSpinnerAtMs?: number | null }[];
      dynamic: { lastSpinnerAtMs?: number | null }[];
    }>(project.secret, '/terminal/list');
    let newest: number | null = null;
    for (const e of [...data.configured, ...data.dynamic]) {
      const t = e.lastSpinnerAtMs ?? null;
      if (t !== null && (newest === null || t > newest)) newest = t;
    }
    mostRecentSpinnerAtMs = newest;
  } catch { /* network blip — keep last value */ }
}

function startSpinnerPoll(): void {
  if (spinnerPollInterval !== null) return;
  // Fire once immediately so the indicator becomes accurate within a few
  // hundred ms of channel-busy flipping on, then continue every 2 s.
  void refreshSpinnerActivity().then(updateStatusIndicator);
  spinnerPollInterval = setInterval(() => {
    void refreshSpinnerActivity().then(updateStatusIndicator);
  }, 2000);
}

function stopSpinnerPoll(): void {
  if (spinnerPollInterval !== null) {
    clearInterval(spinnerPollInterval);
    spinnerPollInterval = null;
  }
  mostRecentSpinnerAtMs = null;
}

/** Unified status indicator renderer. Resolves channel vs. shell busy states
 *  into a single indicator to avoid conflicting innerHTML writes. */
function updateStatusIndicator() {
  const indicator = document.getElementById('channel-status-indicator');
  if (!indicator) return;
  const channelSection = document.getElementById('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') {
    indicator.style.display = 'none';
    return;
  }
  if (isChannelBusy()) {
    indicator.style.display = '';
    // HS-6702 — degraded-busy when the channel says busy but no Claude
    // spinner has been seen in the last 5 s. Different label + class so
    // the user knows the channel might be stuck.
    const degraded = shouldShowDegradedBusy(true, mostRecentSpinnerAtMs, Date.now());
    if (degraded) {
      indicator.className = 'channel-status-indicator busy degraded';
      indicator.innerHTML = `${SPINNER_12} Claude idle (channel busy)`;
    } else {
      indicator.className = 'channel-status-indicator busy';
      indicator.innerHTML = `${SPINNER_12} Claude working`;
    }
  } else if (shellBusyState) {
    indicator.style.display = '';
    indicator.className = 'channel-status-indicator busy';
    indicator.innerHTML = `${SPINNER_12} Shell running`;
  } else {
    // Both idle — hide the indicator
    indicator.style.display = 'none';
  }
}

/** Set shell busy state. Called from commandSidebar when shell commands run. */
export function setShellBusy(busy: boolean) {
  shellBusyState = busy;
  const indicator = document.getElementById('channel-status-indicator');
  if (!indicator) return;
  if (busy) {
    updateStatusIndicator();
  } else {
    // If channel is also idle, show "Shell done" briefly then hide
    if (!isChannelBusy()) {
      indicator.style.display = '';
      indicator.className = 'channel-status-indicator';
      indicator.innerHTML = '\u2713 Shell done';
      setTimeout(() => {
        if (!shellBusyState && !isChannelBusy()) indicator.style.display = 'none';
      }, TIMERS.CHANNEL_IDLE_INDICATOR_MS);
    } else {
      // Channel is still busy, just update to show channel state
      updateStatusIndicator();
    }
  }
}
let channelBusyTimeout: ReturnType<typeof setTimeout> | null = null;
let channelAutoRetryInterval: ReturnType<typeof setInterval> | null = null;
let channelAutoBackoff = 0; // consecutive triggers where Claude didn't become busy
let channelAutoVerifyTimeout: ReturnType<typeof setTimeout> | null = null;
const CHANNEL_AUTO_BASE_DELAY = TIMERS.POLL_RETRY_MS; // 5 s — same cadence as poll-retry; also the base for the auto-retry backoff
const CHANNEL_AUTO_MAX_DELAY = 120000; // 2 minutes

export function isChannelBusy(): boolean {
  // Check per-project busy state rather than global flag
  const secret = getActiveProject()?.secret;
  return secret !== undefined && secret !== '' ? busyProjects.has(secret) : channelBusy;
}
export function isChannelAlive(): boolean { return channelAliveLocal; }

let channelAliveLocal = false;

/** Update alive state — called from initChannel and checkChannelDone */
export function setChannelAlive(alive: boolean) {
  const wasAlive = channelAliveLocal;
  channelAliveLocal = alive;
  const warning = document.getElementById('channel-disconnected');
  if (!warning) return;
  const section = document.getElementById('channel-play-section');
  const enabled = section !== null && section.style.display !== 'none';
  warning.style.display = enabled && !alive ? '' : 'none';
  // If the channel server went down while we thought Claude was busy, clear busy state
  if (wasAlive && !alive && isChannelBusy()) {
    setChannelBusy(false);
    if (channelBusyTimeout) { clearTimeout(channelBusyTimeout); channelBusyTimeout = null; }
  }
}
/** Per-project busy/attention tracking for tab status dots.
 *  busyProjects: projects with active Claude work. Modified by markProjectBusy/clearProjectBusy.
 *  attentionProjects: projects with pending permissions. Modified by markProjectAttention/clearProjectAttention + permission poll. */
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

/** Per-project heartbeat timers. Each heartbeat extends the busy state for 30s.
 *  If no heartbeat arrives within 30s, the project is marked idle. */
const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Called when a heartbeat is received for a project (via PostToolUse hook).
 *  Sets the project as busy and resets the 30s idle timer. */
export function extendBusyForProject(secret: string) {
  markProjectBusy(secret);
  // Also set the global busy flag if this is the active project
  const activeSecret = getActiveProject()?.secret;
  if (secret === activeSecret) {
    channelBusy = true;
    // HS-6702 — start the spinner-activity poll while the channel is busy
    // for the active project so `updateStatusIndicator` can decide between
    // "Claude working" (recent spinner) and "Claude idle (channel busy)".
    startSpinnerPoll();
    updateStatusIndicator();
  }
  // Reset the 30s idle timer
  const existing = heartbeatTimers.get(secret);
  if (existing) clearTimeout(existing);
  heartbeatTimers.set(secret, setTimeout(() => {
    clearProjectBusy(secret);
    heartbeatTimers.delete(secret);
    if (secret === getActiveProject()?.secret) {
      channelBusy = false;
      stopSpinnerPoll();
      updateStatusIndicator();
    }
  }, TIMERS.CHANNEL_HEARTBEAT_STALE_MS));
}

/** Called when Claude stops processing (via Stop hook). Immediately clears busy. */
export function clearBusyForProject(secret: string) {
  // Clear the heartbeat timer
  const timer = heartbeatTimers.get(secret);
  if (timer) { clearTimeout(timer); heartbeatTimers.delete(secret); }
  clearProjectBusy(secret);
  const activeSecret = getActiveProject()?.secret;
  if (secret === activeSecret) {
    channelBusy = false;
    stopSpinnerPoll();
    updateStatusIndicator();
  }
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
  // Keep per-project busy tracking in sync with the indicator
  const activeSecret = getActiveProject()?.secret;
  if (activeSecret !== undefined && activeSecret !== '') {
    if (busy) markProjectBusy(activeSecret);
    else clearProjectBusy(activeSecret);
  }
  // HS-6702 — start/stop the spinner-activity poll alongside channel-busy.
  if (busy) startSpinnerPoll();
  else stopSpinnerPoll();
  const indicator = document.getElementById('channel-status-indicator');
  if (!indicator) return;
  const channelSection = document.getElementById('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') {
    indicator.style.display = 'none';
    return;
  }
  if (busy) {
    // Claude picked up work — reset exponential backoff (HS-2049)
    channelAutoBackoff = 0;
    if (channelAutoVerifyTimeout) { clearTimeout(channelAutoVerifyTimeout); channelAutoVerifyTimeout = null; }
    updateStatusIndicator();
  } else {
    if (state.settings.notify_completed !== 'none') {
      requestAttention(state.settings.notify_completed);
    }
    // If shell is also idle, show "Claude idle" briefly then hide
    if (!shellBusyState) {
      indicator.style.display = '';
      indicator.className = 'channel-status-indicator';
      indicator.innerHTML = '\u2713 Claude idle';
      // Auto-hide after 5 seconds
      setTimeout(() => {
        if (!isChannelBusy() && !shellBusyState) indicator.style.display = 'none';
      }, TIMERS.CHANNEL_IDLE_INDICATOR_MS);
    } else {
      // Shell is still busy, update indicator to show shell state
      updateStatusIndicator();
    }
    // In auto mode, check for more work when Claude becomes idle (HS-1453)
    // Reset backoff since Claude successfully completed a task
    if (channelAutoMode) {
      channelAutoBackoff = 0;
      channelAutoTrigger();
    }
  }
}

function triggerChannelAndMarkBusy(message?: string) {
  setChannelBusy(true);
  // Ensure AI tool skills are installed/up-to-date before triggering
  void api('/ensure-skills', { method: 'POST' });
  void api('/channel/trigger', { method: 'POST', body: { message } });
  // Timeout fallback: clear busy after 60s if Claude never calls /done
  if (channelBusyTimeout) clearTimeout(channelBusyTimeout);
  channelBusyTimeout = setTimeout(() => {
    if (isChannelBusy()) setChannelBusy(false);
  }, TIMERS.CHANNEL_BUSY_TIMEOUT_MS);
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
  let status: { enabled: boolean; alive: boolean; versionMismatch?: boolean } | null = null;
  try {
    status = await api<{ enabled: boolean; alive: boolean; versionMismatch?: boolean }>('/channel/status');
  } catch { /* endpoint may not exist yet */ }
  // If we couldn't reach the server, keep the previous state
  if (status === null) return;
  const section = document.getElementById('channel-play-section')!;
  const btn = document.getElementById('channel-play-btn')!;
  const playIcon = document.getElementById('channel-play-icon')!;
  const autoIcon = document.getElementById('channel-auto-icon')!;

  // Save auto-mode for the previous project, restore for the new one
  {
    // We don't have the previous project secret, so we rely on the current autoMode
    // being saved by toggleAutoMode when it changes. Just restore for the new project.
    const activeSecret = getActiveProject()?.secret ?? '';
    channelAutoMode = autoModeByProject.get(activeSecret) ?? false;
    if (channelDebounceTimeout) { clearTimeout(channelDebounceTimeout); channelDebounceTimeout = null; }
    // Update the play button UI to reflect the restored auto-mode state
    if (channelAutoMode) {
      playIcon.style.display = 'none';
      autoIcon.style.display = '';
      btn.classList.add('auto-mode');
    } else {
      playIcon.style.display = '';
      autoIcon.style.display = 'none';
      btn.classList.remove('auto-mode');
    }
  }
  // Re-render the status indicator for the active project's busy state
  updateStatusIndicator();

  // Reload custom commands for the active project and render
  const { renderChannelCommands, reloadCustomCommands, setChannelEnabledState } = await import('./experimentalSettings.js');
  setChannelEnabledState(status.enabled);
  await reloadCustomCommands();

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
  startPermissionPolling(channelBusyTimeout, (t) => { channelBusyTimeout = t; });

  // Warn if the running channel server is outdated
  const versionWarning = document.getElementById('channel-version-warning');
  if (versionWarning) {
    versionWarning.style.display = status.versionMismatch === true ? '' : 'none';
  }
  // Only bind the click handler once (initChannel is called on every project switch)
  if (btn.dataset.bound !== undefined && btn.dataset.bound !== '') return;
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
  // Persist per-project
  const secret = getActiveProject()?.secret ?? '';
  if (secret !== '') autoModeByProject.set(secret, channelAutoMode);
  if (channelAutoMode) {
    btn.classList.add('auto-mode');
    playIcon.style.display = 'none';
    autoIcon.style.display = '';
    channelAutoBackoff = 0;
    // Immediately trigger Claude when entering auto mode, then continue auto-monitoring
    triggerChannelAndMarkBusy();
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

  if (!isChannelBusy()) {
    // We think Claude is idle — trigger now
    if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }
    triggerChannelAndMarkBusy();

    // Verify Claude actually became busy after a short delay. If not, increase backoff.
    if (channelAutoVerifyTimeout) clearTimeout(channelAutoVerifyTimeout);
    channelAutoVerifyTimeout = setTimeout(() => {
      channelAutoVerifyTimeout = null;
      if (!isChannelBusy() && channelAutoMode) {
        // Claude didn't pick up — increase backoff for next attempt
        channelAutoBackoff++;
      }
    }, TIMERS.CHANNEL_AUTO_VERIFY_MS);
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

  api<{ done?: boolean; alive?: boolean; versionMismatch?: boolean }>('/channel/status').then(s => {
    // Update alive/disconnected warning
    if (s.alive !== undefined) setChannelAlive(s.alive);
    // Update version mismatch warning
    const versionWarning = document.getElementById('channel-version-warning');
    if (versionWarning) versionWarning.style.display = s.versionMismatch === true ? '' : 'none';
    // Check for done signal — always process it, even if we don't think we're busy
    // (the busy state may have been cleared by timeout or tab switch)
    if (s.done === true) {
      setChannelBusy(false); // Clears per-project busy tracking, updates dots, triggers auto-mode
      if (channelBusyTimeout) { clearTimeout(channelBusyTimeout); channelBusyTimeout = null; }
    }
  }).catch(() => {});
}
