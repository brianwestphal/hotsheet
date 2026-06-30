import { type ChannelTriggerTarget, cleanupChannelConnections, ensureSkills, getChannelStatus, getStats, listTerminals, triggerChannel } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { shouldShowDegradedBusy } from '../terminals/claudeSpinner.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { channelStore } from './channelStore.js';
import { TIMERS } from './constants/timers.js';
import { isDemoMode } from './demoMode.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import {
  startPermissionPolling, stopPermissionPolling,
} from './permissionOverlay.js';
import { defineStore } from './reactive.js';
import { getActiveProject, state } from './state.js';
import { requestAttention } from './tauriIntegration.js';
import { showToast } from './toast.js';
import { TOAST_AUTOHIDE_MS } from './uiTimings.js';

// --- Claude Channel ---
//
// HS-8320 / §61 Phase 3d — `alive` / `busy` / `shellBusy` / `busySecrets` /
// `channelAutoMode` / `autoModeByProject` / `channelAutoBackoff` /
// `mostRecentSpinnerAtMs` migrated to `channelStore`. Lifecycle timer
// handles (debounce / busy / auto-retry / auto-verify / heartbeat /
// spinner-poll) stay as plain module-level refs — they're not reactive
// state and have their own GC paths (`clearTimeout` / `clearInterval`).

let channelDebounceTimeout: ReturnType<typeof setTimeout> | null = null;

// Spinner SVG shared by channel and shell indicator states (12x12).
const SPINNER_12: SafeHtml =
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>;

/** HS-6702 — `mostRecentSpinnerAtMs` lives in `channelStore` (HS-8320).
 *  Polled every 2s while the channel is reporting busy. The poll only
 *  runs while `isChannelBusy()` is true so it doesn't cost anything during
 *  idle periods. */
let spinnerPollInterval: ReturnType<typeof setInterval> | null = null;

async function refreshSpinnerActivity(): Promise<void> {
  const project = getActiveProject();
  if (project === null) return;
  try {
    // HS-8141 — args are `(path, secret, opts?)`, NOT `(secret, path)`.
    // Pre-fix the swap produced a URL of `/api${secret}` (no slash, no
    // path) which 404'd on every spinner-poll tick — visible in the
    // browser console as repeated `Failed to load resource: …
    // /api<hex-secret>` errors.
    const data = await listTerminals(project.secret);
    let newest: number | null = null;
    for (const e of [...data.configured, ...data.dynamic]) {
      const t = e.lastSpinnerAtMs ?? null;
      if (t !== null && (newest === null || t > newest)) newest = t;
    }
    channelStore.actions.setMostRecentSpinnerAt(newest);
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
  channelStore.actions.setMostRecentSpinnerAt(null);
}

/** Unified status indicator renderer. Resolves channel vs. shell busy states
 *  into a single indicator to avoid conflicting innerHTML writes. */
function updateStatusIndicator() {
  const indicator = byIdOrNull('channel-status-indicator');
  if (!indicator) return;
  const channelSection = byIdOrNull('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') {
    indicator.style.display = 'none';
    return;
  }
  if (isChannelBusy()) {
    indicator.style.display = '';
    // HS-6702 — degraded-busy when the channel says busy but no Claude
    // spinner has been seen in the last 5 s. Different label + class so
    // the user knows the channel might be stuck.
    const degraded = shouldShowDegradedBusy(true, channelStore.state.value.mostRecentSpinnerAtMs, Date.now());
    if (degraded) {
      indicator.className = 'channel-status-indicator busy degraded';
      indicator.replaceChildren(toElement(SPINNER_12), ' Claude idle (channel busy)');
    } else {
      indicator.className = 'channel-status-indicator busy';
      indicator.replaceChildren(toElement(SPINNER_12), ' Claude working');
    }
  } else if (channelStore.state.value.shellBusy) {
    indicator.style.display = '';
    indicator.className = 'channel-status-indicator busy';
    indicator.replaceChildren(toElement(SPINNER_12), ' Shell running');
  } else {
    // Both idle — hide the indicator
    indicator.style.display = 'none';
  }
}

/** Set shell busy state. Called from commandSidebar when shell commands run. */
export function setShellBusy(busy: boolean) {
  channelStore.actions.setShellBusy(busy);
  const indicator = byIdOrNull('channel-status-indicator');
  if (!indicator) return;
  if (busy) {
    updateStatusIndicator();
  } else {
    // If channel is also idle, show "Shell done" briefly then hide
    if (!isChannelBusy()) {
      indicator.style.display = '';
      indicator.className = 'channel-status-indicator';
      // HS-8554 \u2014 `textContent` is safer + faster + unambiguously not HTML.
      indicator.textContent = '\u2713 Shell done';
      setTimeout(() => {
        if (!channelStore.state.value.shellBusy && !isChannelBusy()) indicator.style.display = 'none';
      }, TIMERS.CHANNEL_IDLE_INDICATOR_MS);
    } else {
      // Channel is still busy, just update to show channel state
      updateStatusIndicator();
    }
  }
}
let channelBusyTimeout: ReturnType<typeof setTimeout> | null = null;
let channelAutoRetryInterval: ReturnType<typeof setInterval> | null = null;
let channelAutoVerifyTimeout: ReturnType<typeof setTimeout> | null = null;
const CHANNEL_AUTO_BASE_DELAY = TIMERS.POLL_RETRY_MS; // 5 s — same cadence as poll-retry; also the base for the auto-retry backoff
const CHANNEL_AUTO_MAX_DELAY = 120000; // 2 minutes

export function isChannelBusy(): boolean {
  // Check per-project busy state rather than global flag
  const secret = getActiveProject()?.secret;
  return secret !== undefined && secret !== '' ? channelStore.state.value.busySecrets.has(secret) : channelStore.state.value.busy;
}
export function isChannelAlive(): boolean { return channelStore.state.value.alive; }

/** Update alive state — called from initChannel and checkChannelDone */
export function setChannelAlive(alive: boolean) {
  const wasAlive = channelStore.state.value.alive;
  channelStore.actions.setAlive(alive);
  const warning = byIdOrNull('channel-disconnected');
  if (!warning) return;
  const section = byIdOrNull('channel-play-section');
  const enabled = section !== null && section.style.display !== 'none';
  // HS-8688 — the "Claude not connected" strip is intentionally suppressed
  // under `--demo:N`. The scenario-9 demo enables `channel_enabled: 'true'`
  // (so the play-section renders) but has no real Claude process to attach
  // to, which would normally surface the warning and pollute the marketing
  // screenshot. Per the ticket: "make sure the 'claude not connected'
  // warning isn't showing. it should never show during demos".
  warning.style.display = enabled && !alive && !isDemoMode() ? '' : 'none';
  // If the channel server went down while we thought Claude was busy, clear busy state
  if (wasAlive && !alive && isChannelBusy()) {
    setChannelBusy(false);
    if (channelBusyTimeout) { clearTimeout(channelBusyTimeout); channelBusyTimeout = null; }
  }
}
/** Per-project busy/attention tracking for tab status dots.
 *  busySecrets: projects with active Claude work — now lives in
 *  `channelStore.state.value.busySecrets` (HS-8320 / §61 Phase 3d).
 *  attentionSecrets: projects with pending permissions — kept here in
 *  `projectAttentionStore` (HS-8238 Phase 1 trial) to avoid disturbing
 *  the working trial; the two stores are kept deliberately separate
 *  per the HS-8320 FEEDBACK NEEDED design decision.
 *
 *  **HS-8238 (2026-05-09) — §61 Phase 1 trial.** Attention state moved
 *  to a kerf `defineStore` to validate the §61 store API on a small,
 *  contained piece of state (markAttention / clearAttention are the
 *  only two named actions). `getProjectAttentionSecrets()` keeps its
 *  existing `ReadonlySet<string>` shape so consumers
 *  (`projectTabs.tsx::updateStatusDots`) don't need to change.
 *
 *  **HS-8320 (2026-05-11) — §61 Phase 3d.** `busyProjects` rolled into
 *  `channelStore.busySecrets` alongside the rest of the channel-state
 *  bundle. The 30 s heartbeat-timer machinery (`extendBusyForProject`)
 *  remains imperative — timer handles aren't reactive state. */
const projectAttentionStore = defineStore({
  initial: () => ({ secrets: new Set<string>() }),
  actions: (set, get) => ({
    markAttention: (secret: string) => {
      const next = new Set(get().secrets);
      next.add(secret);
      set({ secrets: next });
    },
    clearAttention: (secret: string) => {
      const next = new Set(get().secrets);
      next.delete(secret);
      set({ secrets: next });
    },
  }),
});

export function getProjectBusySecrets(): ReadonlySet<string> { return channelStore.state.value.busySecrets; }
export function getProjectAttentionSecrets(): ReadonlySet<string> { return projectAttentionStore.state.value.secrets; }

/** **HS-8238 — TEST ONLY.** Direct read of the underlying store + reset
 *  hook. Production code goes through `getProjectAttentionSecrets()` /
 *  `markProjectAttention` / `clearProjectAttention`. */
export const _projectAttentionStoreForTesting = projectAttentionStore;

function syncDots() {
  // Lazy import to avoid circular dependency at module init time
  const dots = document.querySelectorAll('.project-tab-dot');
  if (dots.length === 0) return;
  import('./projectTabs.js').then(m => m.updateStatusDots()).catch(() => {});
}

function markProjectBusy(secret: string) {
  channelStore.actions.markBusySecret(secret);
  syncDots();
}

function clearProjectBusy(secret: string) {
  channelStore.actions.clearBusySecret(secret);
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
    channelStore.actions.setBusy(true);
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
      channelStore.actions.setBusy(false);
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
    channelStore.actions.setBusy(false);
    stopSpinnerPoll();
    updateStatusIndicator();
  }
}

export function markProjectAttention(secret: string) {
  projectAttentionStore.actions.markAttention(secret);
  syncDots();
}

export function clearProjectAttention(secret: string) {
  projectAttentionStore.actions.clearAttention(secret);
  syncDots();
}

export function setChannelBusy(busy: boolean) {
  channelStore.actions.setBusy(busy);
  // Keep per-project busy tracking in sync with the indicator
  const activeSecret = getActiveProject()?.secret;
  if (activeSecret !== undefined && activeSecret !== '') {
    if (busy) markProjectBusy(activeSecret);
    else clearProjectBusy(activeSecret);
  }
  // HS-6702 — start/stop the spinner-activity poll alongside channel-busy.
  if (busy) startSpinnerPoll();
  else stopSpinnerPoll();
  const indicator = byIdOrNull('channel-status-indicator');
  if (!indicator) return;
  const channelSection = byIdOrNull('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') {
    indicator.style.display = 'none';
    return;
  }
  if (busy) {
    // Claude picked up work — reset exponential backoff (HS-2049)
    channelStore.actions.setChannelAutoBackoff(0);
    if (channelAutoVerifyTimeout) { clearTimeout(channelAutoVerifyTimeout); channelAutoVerifyTimeout = null; }
    updateStatusIndicator();
  } else {
    if (state.settings.notify_completed !== 'none') {
      requestAttention(state.settings.notify_completed);
    }
    // If shell is also idle, show "Claude idle" briefly then hide
    if (!channelStore.state.value.shellBusy) {
      indicator.style.display = '';
      indicator.className = 'channel-status-indicator';
      // HS-8554 \u2014 see the parallel `textContent` swap above.
      indicator.textContent = '\u2713 Claude idle';
      // Auto-hide after 5 seconds
      setTimeout(() => {
        if (!isChannelBusy() && !channelStore.state.value.shellBusy) indicator.style.display = 'none';
      }, TIMERS.CHANNEL_IDLE_INDICATOR_MS);
    } else {
      // Shell is still busy, update indicator to show shell state
      updateStatusIndicator();
    }
    // In auto mode, check for more work when Claude becomes idle (HS-1453)
    // Reset backoff since Claude successfully completed a task
    if (channelStore.state.value.channelAutoMode) {
      channelStore.actions.setChannelAutoBackoff(0);
      channelAutoTrigger();
    }
  }
}

/**
 * HS-8152 / HS-8151 Option 3 — prepend a hotsheet-ticket marker to
 * channel-triggered prompts when there's an active ticket. The marker
 * rides into `claude_code.user_prompt`'s body verbatim; the per-ticket
 * rollup query in `src/db/otelQueries.ts::getPerTicketRollup` parses
 * it out to attribute cost/tokens/duration back to a ticket.
 *
 * Format: `<!-- hotsheet:ticket=HS-NNNN -->\n\n<original message>`.
 * HTML-comment shape so the marker is invisible to Claude's logic but
 * preserved as raw bytes through every prompt rewrite.
 *
 * HS-8537 — even when the caller didn't pass a message (the common
 * play-button flow), inject the marker as a standalone string when
 * there's an active ticket. The channel server appends its default
 * "Process the Hot Sheet worklist..." instructions, so the marker
 * still lands at the head of the prompt body Claude receives.
 *
 * Returns `undefined` only when both the caller's message is empty
 * AND there's no active ticket — the trigger is genuinely contextless.
 */
function tagMessageWithActiveTicket(message: string | undefined): string | undefined {
  const activeId = state.activeTicketId;
  const ticket = activeId === null ? undefined : state.tickets.find(t => t.id === activeId);
  const marker = ticket === undefined ? null : `<!-- hotsheet:ticket=${ticket.ticket_number} -->`;
  if (message === undefined || message === '') {
    return marker === null ? message : marker;
  }
  return marker === null ? message : `${marker}\n\n${message}`;
}

function triggerChannelAndMarkBusy(message?: string, target?: ChannelTriggerTarget) {
  setChannelBusy(true);
  // Ensure AI tool skills are installed/up-to-date before triggering
  void ensureSkills();
  // HS-8152 — tag the message with the active ticket (when present)
  // so the per-ticket cost rollup can attribute downstream OTel events
  // back to the ticket via the marker in `claude_code.user_prompt`.
  const tagged = tagMessageWithActiveTicket(message);
  // HS-9083 — `target` routes to a worker / all workers (omitted ⇒ main leader).
  void triggerChannel(tagged, target);
  // Timeout fallback: clear busy after 60s if Claude never calls /done
  if (channelBusyTimeout) clearTimeout(channelBusyTimeout);
  channelBusyTimeout = setTimeout(() => {
    if (isChannelBusy()) setChannelBusy(false);
  }, TIMERS.CHANNEL_BUSY_TIMEOUT_MS);
}

// Exported so experimentalSettings can call it for custom command buttons
export { triggerChannelAndMarkBusy };

/** HS-8537 — exported for tests of the per-ticket marker injection. */
export const _testing = { tagMessageWithActiveTicket };

async function checkAndTrigger(btn: HTMLElement) {
  // Check if Claude is connected before triggering
  if (!isChannelAlive()) {
    showDisconnectedAlert();
    return;
  }
  try {
    const stats = await getStats();
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
  const existing = byIdOrNull('channel-disconnected-alert');
  if (existing) existing.remove();
  const alert = toElement(
    <div id="channel-disconnected-alert" className="no-upnext-alert">
      <span>Claude is not connected. Launch Claude Code with channel support first.</span>
      <button className="no-upnext-dismiss">{'\u00d7'}</button>
    </div>
  );
  alert.querySelector('.no-upnext-dismiss')!.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), TOAST_AUTOHIDE_MS);
  const playSection = byIdOrNull('channel-play-section');
  if (playSection) playSection.after(alert);
}

function showNoUpNextAlert() {
  const existing = byIdOrNull('no-upnext-alert');
  if (existing) existing.remove();
  const alert = toElement(
    <div id="no-upnext-alert" className="no-upnext-alert">
      <span>No Up Next items to process</span>
      <button className="no-upnext-dismiss">{'\u00d7'}</button>
    </div>
  );
  alert.querySelector('.no-upnext-dismiss')!.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), 4000);
  const playSection = byIdOrNull('channel-play-section');
  if (playSection) playSection.after(alert);
}

/** HS-8948 / HS-9225 — disconnect ALL main Claude connections, then tell the
 *  user to reconnect the instance they want via `/mcp`. We disconnect every main
 *  rather than guessing which one to keep — the kept "leader" wasn't reliably
 *  the connection the user was actually using. */
async function handleCleanupConnections(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const { killed } = await cleanupChannelConnections();
    showToast(killed > 0
      ? `Disconnected ${String(killed)} Claude connection${killed === 1 ? '' : 's'} — run /mcp in the Claude you want to use to reconnect`
      : 'No Claude connections to disconnect');
    await initChannel(); // re-fetch status → the warning hides once the mains are gone
  } catch (e) {
    showToast(`Disconnect failed: ${getErrorMessage(e)}`);
    btn.disabled = false;
  }
}

export async function initChannel() {
  let status: { enabled: boolean; alive: boolean; versionMismatch?: boolean; aliveCount?: number } | null = null;
  try {
    status = await getChannelStatus();
  } catch { /* endpoint may not exist yet */ }
  // If we couldn't reach the server, keep the previous state
  if (status === null) return;
  const section = byId('channel-play-section');
  const btn = byId('channel-play-btn');
  const playIcon = byId('channel-play-icon');
  const autoIcon = byId('channel-auto-icon');

  // Save auto-mode for the previous project, restore for the new one
  {
    // We don't have the previous project secret, so we rely on the current autoMode
    // being saved by toggleAutoMode when it changes. Just restore for the new project.
    const activeSecret = getActiveProject()?.secret ?? '';
    const restoredAuto = channelStore.state.value.autoModeByProject.get(activeSecret) ?? false;
    channelStore.actions.setChannelAutoMode(restoredAuto);
    if (channelDebounceTimeout) { clearTimeout(channelDebounceTimeout); channelDebounceTimeout = null; }
    // Update the play button UI to reflect the restored auto-mode state
    if (restoredAuto) {
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

  // HS-9039 — the "Auto worker pool" switch lives just above the play button and
  // follows the same visibility (workers need a connected Claude to do anything).
  // HS-9068 — the worker-pool + in-flight-work buttons share that same gate.
  const autoRow = byIdOrNull('sidebar-worker-auto');
  const workerActionsRow = byIdOrNull('sidebar-worker-actions');
  if (!status.enabled) {
    section.style.display = 'none';
    if (autoRow) autoRow.style.display = 'none';
    if (workerActionsRow) workerActionsRow.style.display = 'none';
    setChannelAlive(false);
    stopPermissionPolling();
    renderChannelCommands(); // Still render shell commands
    return;
  }
  section.style.display = '';
  if (autoRow) autoRow.style.display = '';
  if (workerActionsRow) workerActionsRow.style.display = '';
  setChannelAlive(status.alive);
  renderChannelCommands();
  startPermissionPolling(channelBusyTimeout, (t) => { channelBusyTimeout = t; });

  // Warn if the running channel server is outdated
  const versionWarning = byIdOrNull('channel-version-warning');
  if (versionWarning) {
    versionWarning.style.display = status.versionMismatch === true ? '' : 'none';
  }
  // HS-8460 — multi-connection warning. When > 1 channel server is
  // alive for this dataDir (e.g. user has two Claude Code instances
  // open in the same project), surface a banner so the silent-failure
  // user experience is replaced with "I see; the trigger is going
  // somewhere else." Triggers route to the FIFO leader (oldest by
  // startedAt); when it disconnects the next-oldest takes over within
  // ~5 s. Hidden when count <= 1.
  const multiWarning = byIdOrNull('channel-multi-warning');
  if (multiWarning) {
    const count = typeof status.aliveCount === 'number' ? status.aliveCount : 0;
    if (count > 1) {
      // HS-8948 / HS-9225 — alongside the warning text, offer a "Disconnect all"
      // button that tears down every main channel server. The user then runs
      // `/mcp` in the Claude they want, reconnecting it as the sole connection —
      // more reliable than the server guessing which one to keep.
      const cleanupBtn = toElement(<button type="button" className="channel-multi-cleanup-btn">Disconnect all</button>);
      if (cleanupBtn instanceof HTMLButtonElement) {
        cleanupBtn.addEventListener('click', () => { void handleCleanupConnections(cleanupBtn); });
      }
      multiWarning.replaceChildren(
        toElement(<span>{`${String(count)} Claude connections active — triggers route to the oldest one. Disconnect all, then /mcp to reconnect the one you want.`}</span>),
        cleanupBtn,
      );
      multiWarning.style.display = '';
    } else {
      multiWarning.replaceChildren();
      multiWarning.style.display = 'none';
    }
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
        if (channelStore.state.value.channelAutoMode) {
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
  const next = !channelStore.state.value.channelAutoMode;
  channelStore.actions.setChannelAutoMode(next);
  // Persist per-project
  const secret = getActiveProject()?.secret ?? '';
  if (secret !== '') channelStore.actions.setAutoModeForProject(secret, next);
  if (next) {
    btn.classList.add('auto-mode');
    playIcon.style.display = 'none';
    autoIcon.style.display = '';
    channelStore.actions.setChannelAutoBackoff(0);
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
    channelStore.actions.setChannelAutoBackoff(0);
  }
}

/** Returns the current auto-trigger delay with exponential backoff.
 *  Base: 5s. Doubles with each consecutive failed trigger. Max: 2 minutes. */
function autoTriggerDelay(): number {
  const backoff = channelStore.state.value.channelAutoBackoff;
  if (backoff === 0) return CHANNEL_AUTO_BASE_DELAY;
  return Math.min(CHANNEL_AUTO_BASE_DELAY * Math.pow(2, backoff), CHANNEL_AUTO_MAX_DELAY);
}

/** Called when entering auto mode or when a ticket's up_next changes.
 *  Debounces, then attempts to trigger. Restarts debounce on new up-next items. (HS-1453)
 *  Uses exponential backoff if triggers don't result in Claude becoming busy. (HS-2049) */
export function channelAutoTrigger() {
  if (!channelStore.state.value.channelAutoMode) return;
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
  if (!channelStore.state.value.channelAutoMode) return;

  // Check if there are up-next items (skip check if auto-prioritize will handle it)
  try {
    const stats = await getStats();
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
      if (!isChannelBusy() && channelStore.state.value.channelAutoMode) {
        // Claude didn't pick up — increase backoff for next attempt
        channelStore.actions.incrementChannelAutoBackoff();
      }
    }, TIMERS.CHANNEL_AUTO_VERIFY_MS);
  } else if (!channelAutoRetryInterval) {
    // Claude is busy — start retrying with current backoff delay
    const delay = autoTriggerDelay();
    channelAutoRetryInterval = setInterval(() => {
      if (!channelStore.state.value.channelAutoMode) {
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
  const section = byIdOrNull('channel-play-section');
  const enabled = section !== null && section.style.display !== 'none';
  if (!enabled) return;

  getChannelStatus().then(s => {
    // Update alive/disconnected warning
    setChannelAlive(s.alive);
    // Update version mismatch warning
    const versionWarning = byIdOrNull('channel-version-warning');
    if (versionWarning) versionWarning.style.display = s.versionMismatch ? '' : 'none';
    // Check for done signal — always process it, even if we don't think we're busy
    // (the busy state may have been cleared by timeout or tab switch)
    if (s.done) {
      setChannelBusy(false); // Clears per-project busy tracking, updates dots, triggers auto-mode
      if (channelBusyTimeout) { clearTimeout(channelBusyTimeout); channelBusyTimeout = null; }
    }
  }).catch(() => {});
}
