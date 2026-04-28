import { api } from './api.js';
import { checkChannelDone, clearBusyForProject, extendBusyForProject } from './channelUI.js';
import { refreshDetail } from './detail.js';
import { checkFeedbackState } from './feedbackDialog.js';
import { refreshGitStatusChip } from './gitStatusChip.js';
import { refreshProjectChannelStatus, refreshProjectTabs } from './projectTabs.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';

let pollVersion = 0;

export function startLongPoll() {
  async function poll() {
    try {
      const result = await api<{ version: number }>(`/poll?version=${pollVersion}`);
      if (result.version > pollVersion) {
        pollVersion = result.version;
        if (state.backupPreview?.active !== true) {
          await loadTickets();
          refreshDetail();
          void checkFeedbackState();
        }
        checkChannelDone();
        void refreshProjectTabs();
        void refreshProjectChannelStatus();
        // HS-7954 — git status changes (.git/index / .git/HEAD writes
        // detected by `src/git/watcher.ts`) ride on the same poll-version
        // bump that ticket mutations use, so refresh the sidebar git chip
        // here.
        refreshGitStatusChip();
        // Check for heartbeats from Claude Code hooks
        void checkHeartbeats();
      }
    } catch {
      await new Promise(r => setTimeout(r, 5000));
    }
    setTimeout(poll, 100);
  }
  void poll();
}

async function checkHeartbeats() {
  try {
    const data = await api<{ updates: { secret: string; state: string }[] }>('/channel/heartbeat-status');
    for (const update of data.updates) {
      if (update.state === 'idle') {
        clearBusyForProject(update.secret);
      } else {
        // 'busy' (UserPromptSubmit) or 'heartbeat' (PostToolUse) — both extend busy
        extendBusyForProject(update.secret);
      }
    }
  } catch { /* ignore */ }
}
