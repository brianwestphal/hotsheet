import { api } from './api.js';
import { checkChannelDone } from './channelUI.js';
import { refreshDetail } from './detail.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';

let pollVersion = 0;

export function startLongPoll() {
  async function poll() {
    try {
      const result = await api<{ version: number }>(`/poll?version=${pollVersion}`);
      if (result.version > pollVersion) {
        pollVersion = result.version;
        if (!state.backupPreview?.active) {
          void loadTickets();
          refreshDetail();
        }
        // Check if Claude signaled done via /channel/done
        checkChannelDone();
      }
    } catch {
      // Server down — wait longer before retry
      await new Promise(r => setTimeout(r, 5000));
    }
    // Continue polling
    setTimeout(poll, 100);
  }
  void poll();
}
