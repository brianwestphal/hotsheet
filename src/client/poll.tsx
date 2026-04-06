import { api } from './api.js';
import { checkChannelDone } from './channelUI.js';
import { refreshDetail } from './detail.js';
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
          void loadTickets();
          refreshDetail();
        }
        checkChannelDone();
        void refreshProjectTabs();
        // Channel connect/disconnect triggers notifyChange via /channel/notify,
        // so the long-poll returns immediately and we refresh status here.
        void refreshProjectChannelStatus();
      }
    } catch {
      await new Promise(r => setTimeout(r, 5000));
    }
    setTimeout(poll, 100);
  }
  void poll();
}
