/**
 * HS-8553 — extracted from `src/client/app.tsx`. File upload via input
 * button + drag-and-drop onto the detail panel. Both paths route
 * through `apiUpload` and the detail re-opens after upload so the new
 * attachment row appears.
 */
import { apiUpload } from '../api.js';
import { openDetail } from '../detail.js';
import { byId } from '../dom.js';
import { state } from '../state.js';
import { loadTickets } from '../ticketList.js';

export function bindDetailFileUpload(): void {
  // File upload (supports multiple files)
  byId('detail-file-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0 || state.activeTicketId == null) return;
    for (const file of Array.from(files)) {
      await apiUpload(`/tickets/${state.activeTicketId}/attachments`, file);
    }
    input.value = '';
    openDetail(state.activeTicketId);
    void loadTickets();
  });

  // Drag-and-drop file upload onto detail panel
  const detailBody = byId('detail-body');
  let dragCounter = 0; // Track nested enter/leave to avoid flicker

  detailBody.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files') !== true) return;
    dragCounter++;
    if (dragCounter === 1) detailBody.classList.add('drop-active');
  });

  detailBody.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  detailBody.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter === 0) detailBody.classList.remove('drop-active');
  });

  detailBody.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    detailBody.classList.remove('drop-active');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0 || state.activeTicketId == null) return;
    for (const file of Array.from(files)) {
      await apiUpload(`/tickets/${state.activeTicketId}/attachments`, file);
    }
    openDetail(state.activeTicketId);
    void loadTickets();
  });
}
