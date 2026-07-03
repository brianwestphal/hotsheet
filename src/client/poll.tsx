import { getChannelHeartbeatStatus, pollVersion as pollVersionApi } from '../api/index.js';
import { resyncActiveDevice } from './activeDevice.js';
import { checkChannelDone, clearBusyForProject, extendBusyForProject } from './channelUI.js';
import { TIMERS } from './constants/timers.js';
import { refreshDetail } from './detail.js';
import { checkFeedbackState } from './feedbackDialog.js';
import { refreshGitStatusChip } from './gitStatusChip.js';
import { refreshProjectChannelStatus, refreshProjectFeedbackState, refreshProjectTabs } from './projectTabs.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';
import { isWsActive } from './wsSync.js';

let pollVersion = 0;
let pollDataVersion = 0;

// HS-9301 (docs/109 §109.5) — the `/api/poll` long-poll carries only version
// numbers, not bus events, so a client on the poll fallback (WS unavailable)
// wouldn't otherwise learn about `active-device-changed`. Rather than change the
// poll protocol to carry events, re-read the (small, idempotent) active-device
// holder periodically while the WS is down, so the multi-client terminal
// rendering (live↔placeholder, docs/109) stays correct off the poll path.
export const ACTIVE_DEVICE_POLL_THROTTLE_MS = 3000;
let lastActiveDeviceResyncAt = 0;

/** Pure gate: re-read the active-device holder only when the WS is NOT the live
 *  transport AND at most once per throttle window (the poll loop runs ~10×/s, but
 *  the active-device state changes rarely and its TTL is 15 s). */
export function shouldResyncActiveDeviceOnPoll(wsActive: boolean, now: number, lastAt: number, throttleMs = ACTIVE_DEVICE_POLL_THROTTLE_MS): boolean {
  if (wsActive) return false; // the WS delivers `active-device-changed` live
  return now - lastAt >= throttleMs;
}

export function startLongPoll() {
  async function poll() {
    try {
      const result = await pollVersionApi(pollVersion);
      if (result.version > pollVersion) {
        pollVersion = result.version;
        // HS-7972 — only run the expensive ticket-list + detail-panel rebuild
        // when ticket data actually changed. Heartbeats from Claude Code
        // hooks (PostToolUse fires every tool call — 5–10×/sec when claude
        // is busy) bump `version` for cheap UI wakes (channel status, tabs,
        // git chip) but DO NOT bump `dataVersion`. Pre-fix every heartbeat
        // re-rendered the whole list, flickering :hover state and the note
        // reader-button under the cursor at the heartbeat rate.
        const serverDataVersion = result.dataVersion;
        const dataChanged = serverDataVersion > pollDataVersion;
        pollDataVersion = serverDataVersion;
        // HS-8981 — while the `/ws/sync` socket is live it OWNS the ticket-data
        // refresh (pushed per mutation), so skip the poll's refetch to avoid
        // doing it twice. The poll still drives the cheaper UI wakes below
        // (tabs, channel, git chip, heartbeats) which don't ride the WS bus.
        if (dataChanged && state.backupPreview?.active !== true && !isWsActive()) {
          await loadTickets();
          refreshDetail();
          void checkFeedbackState();
        }
        checkChannelDone();
        void refreshProjectTabs();
        void refreshProjectChannelStatus();
        // HS-8378 — bulk per-project feedback-state refresh so the
        // purple-dot indicator on EVERY project tab stays live, not just
        // the active project's (which `checkFeedbackState` above already
        // handles inline via `state.tickets`).
        void refreshProjectFeedbackState();
        // HS-7954 — git status changes (.git/index / .git/HEAD writes
        // detected by `src/git/watcher.ts`) ride on the same poll-version
        // bump that ticket mutations use, so refresh the sidebar git chip
        // here.
        refreshGitStatusChip();
        // Check for heartbeats from Claude Code hooks
        void checkHeartbeats();
      }
      // HS-9301 — active-device changes don't bump the poll version, so this runs
      // OUTSIDE the version gate (throttled) whenever the WS isn't the live
      // transport, keeping the multi-client terminal rendering correct off the
      // poll fallback.
      const now = Date.now();
      if (shouldResyncActiveDeviceOnPoll(isWsActive(), now, lastActiveDeviceResyncAt)) {
        lastActiveDeviceResyncAt = now;
        resyncActiveDevice();
      }
    } catch {
      await new Promise(r => setTimeout(r, TIMERS.POLL_RETRY_MS));
    }
    setTimeout(poll, 100);
  }
  void poll();
}

// HS-9261 — per-client cursor into the server's heartbeat ring. Starts
// undefined so the first poll syncs to the latest seq without replaying history;
// thereafter we pass it back as `?since` so THIS client drains independently of
// any other tab/window (the old destructive drain let the first poller consume
// everyone's updates, leaving other clients stuck "working").
let lastHeartbeatSeq: number | undefined;

async function checkHeartbeats() {
  try {
    const data = await getChannelHeartbeatStatus(lastHeartbeatSeq);
    for (const update of data.updates) {
      if (update.state === 'idle') {
        clearBusyForProject(update.secret);
      } else {
        // 'busy' (UserPromptSubmit) or 'heartbeat' (PostToolUse) — both extend busy
        extendBusyForProject(update.secret);
      }
    }
    lastHeartbeatSeq = data.seq;
  } catch { /* ignore */ }
}
