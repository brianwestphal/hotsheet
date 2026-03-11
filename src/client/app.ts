import { api, apiUpload } from './api.js';
import { applyDetailPosition, applyDetailSize, closeDetail, initResize, openDetail, updateStats } from './detail.js';
import type { AppSettings, Ticket } from './state.js';
import { state } from './state.js';
import { focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';

async function init() {
  await loadSettings();
  await loadTickets();
  bindSidebar();
  bindSortControls();
  bindSearchInput();
  bindBatchToolbar();
  bindDetailPanel();
  bindKeyboardShortcuts();
  bindSettingsDialog();
  bindCopyPrompt();
  initResize();
  startLongPoll();
  // Re-render when detail panel dispatches close event
  document.addEventListener('hotsheet:render', () => renderTicketList());
  // Auto-focus the draft input on load
  focusDraftInput();
}

// --- Settings ---

async function loadSettings() {
  try {
    const settings = await api<Record<string, string>>('/settings');
    if (settings.detail_position === 'side' || settings.detail_position === 'bottom') {
      state.settings.detail_position = settings.detail_position;
    }
    if (settings.detail_width) state.settings.detail_width = parseInt(settings.detail_width, 10) || 360;
    if (settings.detail_height) state.settings.detail_height = parseInt(settings.detail_height, 10) || 300;
    if (settings.trash_cleanup_days) state.settings.trash_cleanup_days = parseInt(settings.trash_cleanup_days, 10) || 3;
    if (settings.verified_cleanup_days) state.settings.verified_cleanup_days = parseInt(settings.verified_cleanup_days, 10) || 30;
  } catch { /* use defaults */ }

  applyDetailPosition(state.settings.detail_position);
  applyDetailSize();
}

function bindSettingsDialog() {
  const overlay = document.getElementById('settings-overlay')!;
  const closeBtn = document.getElementById('settings-close')!;
  const settingsBtn = document.getElementById('settings-btn')!;

  settingsBtn.addEventListener('click', () => {
    // Populate fields with current values
    (document.getElementById('settings-detail-position') as HTMLSelectElement).value = state.settings.detail_position;
    (document.getElementById('settings-trash-days') as HTMLInputElement).value = String(state.settings.trash_cleanup_days);
    (document.getElementById('settings-verified-days') as HTMLInputElement).value = String(state.settings.verified_cleanup_days);
    overlay.style.display = 'flex';
  });

  closeBtn.addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.style.display = 'none';
    }
  });

  // Detail position
  const posSelect = document.getElementById('settings-detail-position') as HTMLSelectElement;
  posSelect.addEventListener('change', () => {
    state.settings.detail_position = posSelect.value as AppSettings['detail_position'];
    applyDetailPosition(state.settings.detail_position);
    applyDetailSize();
    void api('/settings', { method: 'PATCH', body: { detail_position: posSelect.value } });
  });

  // Trash cleanup days
  const trashInput = document.getElementById('settings-trash-days') as HTMLInputElement;
  let trashTimeout: ReturnType<typeof setTimeout> | null = null;
  trashInput.addEventListener('input', () => {
    if (trashTimeout) clearTimeout(trashTimeout);
    trashTimeout = setTimeout(() => {
      const val = Math.max(1, parseInt(trashInput.value, 10) || 3);
      trashInput.value = String(val);
      state.settings.trash_cleanup_days = val;
      void api('/settings', { method: 'PATCH', body: { trash_cleanup_days: String(val) } });
    }, 500);
  });

  // Verified cleanup days
  const verifiedInput = document.getElementById('settings-verified-days') as HTMLInputElement;
  let verifiedTimeout: ReturnType<typeof setTimeout> | null = null;
  verifiedInput.addEventListener('input', () => {
    if (verifiedTimeout) clearTimeout(verifiedTimeout);
    verifiedTimeout = setTimeout(() => {
      const val = Math.max(1, parseInt(verifiedInput.value, 10) || 30);
      verifiedInput.value = String(val);
      state.settings.verified_cleanup_days = val;
      void api('/settings', { method: 'PATCH', body: { verified_cleanup_days: String(val) } });
    }, 500);
  });
}

// --- Copy AI prompt ---

function bindCopyPrompt() {
  const section = document.getElementById('copy-prompt-section')!;
  const btn = document.getElementById('copy-prompt-btn')!;
  const label = document.getElementById('copy-prompt-label')!;
  const icon = document.getElementById('copy-prompt-icon')!;
  let prompt = '';

  void api<{ prompt: string; skillCreated: boolean }>('/worklist-info').then((info) => {
    prompt = info.prompt;
    section.style.display = '';
    if (info.skillCreated) {
      console.log('Hot Sheet: Created /hotsheet skill in .claude/skills/hotsheet/');
    }
  });

  btn.addEventListener('click', () => {
    if (prompt === '') return;
    void navigator.clipboard.writeText(prompt).then(() => {
      label.textContent = 'Copied!';
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
      setTimeout(() => {
        label.textContent = 'Copy AI prompt';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    });
  });
}

// --- Sidebar navigation ---

function bindSidebar() {
  const items = document.querySelectorAll('.sidebar-item[data-view]');
  items.forEach(item => {
    item.addEventListener('click', () => {
      items.forEach(i => { i.classList.remove('active'); });
      item.classList.add('active');
      state.view = (item as HTMLElement).dataset.view!;
      state.selectedIds.clear();
      void loadTickets();
    });
  });
}

// --- Sort controls ---

function bindSortControls() {
  const select = document.getElementById('sort-select') as HTMLSelectElement;
  select.addEventListener('change', () => {
    const [sortBy, sortDir] = select.value.split(':');
    state.sortBy = sortBy;
    state.sortDir = sortDir;
    void loadTickets();
  });
}

// --- Search ---

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

function bindSearchInput() {
  const input = document.getElementById('search-input') as HTMLInputElement;
  input.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = input.value;
      void loadTickets();
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.search = '';
      void loadTickets();
    }
  });
}

// --- Batch toolbar ---

function bindBatchToolbar() {
  const batchCategory = document.getElementById('batch-category') as HTMLSelectElement;
  batchCategory.addEventListener('change', async () => {
    if (!batchCategory.value) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'category', value: batchCategory.value },
    });
    batchCategory.value = '';
    void loadTickets();
  });

  const batchPriority = document.getElementById('batch-priority') as HTMLSelectElement;
  batchPriority.addEventListener('change', async () => {
    if (!batchPriority.value) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'priority', value: batchPriority.value },
    });
    batchPriority.value = '';
    void loadTickets();
  });

  const batchStatus = document.getElementById('batch-status') as HTMLSelectElement;
  batchStatus.addEventListener('change', async () => {
    if (!batchStatus.value) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'status', value: batchStatus.value },
    });
    batchStatus.value = '';
    void loadTickets();
  });

  document.getElementById('batch-upnext')!.addEventListener('click', async () => {
    const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
    // Toggle: if any selected ticket is NOT up_next, set all to true; otherwise set all to false
    const allUpNext = selectedTickets.every(t => t.up_next);
    const settingUpNext = !allUpNext;

    if (settingUpNext) {
      const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
      if (doneTickets.length > 0) {
        if (!confirm('Some selected tickets are already done. Would you like to reopen them and add them to Up Next?')) return;
        // Reopen the done tickets
        await api('/tickets/batch', {
          method: 'POST',
          body: { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
        });
      }
    }

    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'up_next', value: settingUpNext },
    });
    void loadTickets();
  });

  document.getElementById('batch-delete')!.addEventListener('click', async () => {
    const count = state.selectedIds.size;
    if (!confirm(`Delete ${count} ticket(s)?`)) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'delete' },
    });
    state.selectedIds.clear();
    void loadTickets();
  });

  // Select-all checkbox
  document.getElementById('batch-select-all')!.addEventListener('change', (e) => {
    const checkbox = e.target as HTMLInputElement;
    if (checkbox.checked) {
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
    } else {
      state.selectedIds.clear();
    }
    renderTicketList();
  });
}

// --- Detail panel ---

let detailSaveTimeout: ReturnType<typeof setTimeout> | null = null;

function bindDetailPanel() {
  document.getElementById('detail-close')!.addEventListener('click', closeDetail);

  // Auto-save detail fields
  const fields = ['detail-title', 'detail-details'];
  for (const fieldId of fields) {
    const el = document.getElementById(fieldId) as HTMLInputElement | HTMLTextAreaElement;
    el.addEventListener('input', () => {
      if (detailSaveTimeout) clearTimeout(detailSaveTimeout);
      detailSaveTimeout = setTimeout(() => {
        if (state.activeTicketId == null) return;
        const key = fieldId.replace('detail-', '');
        void api(`/tickets/${state.activeTicketId}`, {
          method: 'PATCH',
          body: { [key]: el.value },
        }).then(() => void loadTickets());
      }, 300);
    });
  }

  // Dropdowns save immediately
  const selects = ['detail-category', 'detail-priority', 'detail-status'];
  for (const selId of selects) {
    const el = document.getElementById(selId) as HTMLSelectElement;
    el.addEventListener('change', async () => {
      if (state.activeTicketId == null) return;
      const key = selId.replace('detail-', '');
      await api(`/tickets/${state.activeTicketId}`, {
        method: 'PATCH',
        body: { [key]: el.value },
      });
      void loadTickets();
    });
  }

  // Up Next checkbox
  document.getElementById('detail-upnext')!.addEventListener('change', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    const checkbox = document.getElementById('detail-upnext') as HTMLInputElement;
    // If trying to add a completed/verified ticket to Up Next, confirm reopening
    if (checkbox.checked && ticket && (ticket.status === 'completed' || ticket.status === 'verified')) {
      if (!confirm('This ticket is already done. Would you like to reopen it and add it to Up Next?')) {
        checkbox.checked = false;
        return;
      }
      await api(`/tickets/${state.activeTicketId}`, {
        method: 'PATCH',
        body: { status: 'not_started', up_next: true },
      });
    } else {
      await api(`/tickets/${state.activeTicketId}/up-next`, { method: 'POST' });
    }
    void loadTickets();
    openDetail(state.activeTicketId);
  });

  // File upload
  document.getElementById('detail-file-input')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || state.activeTicketId == null) return;
    await apiUpload(`/tickets/${state.activeTicketId}/attachments`, file);
    input.value = '';
    openDetail(state.activeTicketId);
    void loadTickets();
  });

  // Attachment delete (event delegation)
  document.getElementById('detail-attachments')!.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const btn: HTMLElement | null = target.closest('.attachment-delete');
    if (btn === null) return;
    const attId = btn.dataset['attId'];
    if (attId === undefined || attId === '') return;
    await api(`/attachments/${attId}`, { method: 'DELETE' });
    if (state.activeTicketId != null) {
      openDetail(state.activeTicketId);
    }
  });
}

// --- Clipboard formatting ---

function parseNotes(raw: string): { text: string; created_at: string }[] {
  if (!raw || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  if (raw.trim()) return [{ text: raw, created_at: '' }];
  return [];
}

function formatTicketForClipboard(ticket: Ticket): string {
  const lines: string[] = [];
  lines.push(`${ticket.ticket_number}: ${ticket.title}`);

  if (ticket.details.trim()) {
    lines.push('');
    lines.push(ticket.details.trim());
  }

  const notes = parseNotes(ticket.notes);
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`- ${note.text}`);
    }
  }

  return lines.join('\n');
}

// --- Global keyboard shortcuts ---

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input/textarea (except specific shortcuts)
    const tag = (e.target as HTMLElement).tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Close settings dialog on Escape
    const overlay = document.getElementById('settings-overlay')!;
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      return;
    }

    if (e.key === 'Escape') {
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
      return;
    }

    // Cmd/Ctrl+A: select all visible tickets
    if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInput) {
      e.preventDefault();
      state.selectedIds.clear();
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
      renderTicketList();
      return;
    }

    // Cmd/Ctrl+D: toggle up next for all selected tickets
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
      if (state.selectedIds.size > 0) {
        e.preventDefault();
        const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
        const allUpNext = selectedTickets.every(t => t.up_next);
        const settingUpNext = !allUpNext;
        if (settingUpNext) {
          const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
          if (doneTickets.length > 0) {
            if (!confirm('Some selected tickets are already done. Would you like to reopen them and add them to Up Next?')) return;
            void api('/tickets/batch', {
              method: 'POST',
              body: { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
            }).then(() =>
              api('/tickets/batch', {
                method: 'POST',
                body: { ids: Array.from(state.selectedIds), action: 'up_next', value: true },
              })
            ).then(() => void loadTickets());
            return;
          }
        }
        void api('/tickets/batch', {
          method: 'POST',
          body: { ids: Array.from(state.selectedIds), action: 'up_next', value: settingUpNext },
        }).then(() => void loadTickets());
      }
      return;
    }

    // Cmd/Ctrl+C: copy selected ticket(s) formatted for git commit messages
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && state.selectedIds.size > 0) {
      // Only intercept if no text is selected in an input
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
        e.preventDefault();
        const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
        const text = selected.map(formatTicketForClipboard).join('\n\n');
        void navigator.clipboard.writeText(text);
        return;
      }
    }

    // Cmd/Ctrl+N: focus draft input (works everywhere)
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      focusDraftInput();
      return;
    }

    // Cmd/Ctrl+F: focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      (document.getElementById('search-input') as HTMLInputElement).focus();
      return;
    }

    // N: focus draft input (when not in an input)
    if (e.key === 'n' && !isInput) {
      e.preventDefault();
      focusDraftInput();
      return;
    }
  });
}

// --- Long polling for live updates ---

let pollVersion = 0;

function startLongPoll() {
  async function poll() {
    try {
      const result = await api<{ version: number }>(`/poll?version=${pollVersion}`);
      if (result.version > pollVersion) {
        pollVersion = result.version;
        void loadTickets();
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

void init();
