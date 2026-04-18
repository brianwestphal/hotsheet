import { raw } from '../jsx-runtime.js';
import { api, apiUpload } from './api.js';
import { setSuppressAutoRead } from './detail.js';
import { toElement } from './dom.js';
import { ICON_ARCHIVE, ICON_CALENDAR, ICON_COPY, ICON_EYE, ICON_EYE_OFF, ICON_TAG, ICON_TRASH } from './icons.js';
import { getPluginContextMenuItems } from './pluginUI.js';
import type { Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, state, STATUS_ITEMS, syncedTicketMap, VERIFIED_SVG } from './state.js';
import { loadTickets, renderTicketList } from './ticketList.js';
import { trackedBatch, trackedDelete, trackedPatch } from './undo/actions.js';

export function showTicketContextMenu(e: MouseEvent, ticket: Ticket) {
  e.preventDefault();
  closeContextMenu();

  // Ensure the ticket is selected
  if (!state.selectedIds.has(ticket.id)) {
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    renderTicketList();
  }

  const menu = toElement(<div className="context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}></div>);

  // Completed ticket actions: Verified and Not Working
  const allCompleted = Array.from(state.selectedIds).every(id => {
    const t = state.tickets.find(tk => tk.id === id);
    return t?.status === 'completed';
  });
  if (allCompleted && state.selectedIds.size > 0) {
    addActionItem(menu, 'Verified', () => applyToSelected('status', 'verified'), {
      icon: VERIFIED_SVG,
    });

    const notWorkingItem = toElement(
      <div className={`context-menu-item${state.selectedIds.size > 1 ? ' disabled' : ''}`}>
        <span className="dropdown-icon">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>')}</span>
        <span className="context-menu-label">Not Working</span>
      </div>
    );
    if (state.selectedIds.size === 1) {
      notWorkingItem.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeContextMenu();
        showNotWorkingDialog(ticket);
      });
    }
    menu.appendChild(notWorkingItem);

    addSeparator(menu);
  }

  // Category submenu
  addSubmenuItem(menu, 'Category', state.categories.map(c => ({
    label: c.label,
    icon: `<span class="dropdown-dot" style="background-color:${c.color}"></span>`,
    active: ticket.category === c.id,
    action: () => applyToSelected('category', c.id),
  })));

  // Priority submenu
  addSubmenuItem(menu, 'Priority', PRIORITY_ITEMS.map(p => ({
    label: p.label,
    icon: getPriorityIcon(p.value),
    iconColor: getPriorityColor(p.value),
    active: ticket.priority === p.value,
    action: () => applyToSelected('priority', p.value),
  })));

  // Status submenu (context menu only shows the 4 main statuses)
  const contextStatuses = STATUS_ITEMS.filter(s =>
    s.value === 'not_started' || s.value === 'started' || s.value === 'completed' || s.value === 'verified'
  );
  addSubmenuItem(menu, 'Status', contextStatuses.map(s => ({
    label: s.label,
    icon: getStatusIcon(s.value),
    active: ticket.status === s.value,
    action: () => applyToSelected('status', s.value),
  })));

  // Up Next toggle
  addActionItem(menu, ticket.up_next ? '\u2605 Up Next' : '\u2606 Up Next', () => {
    void applyToSelected('up_next', !ticket.up_next);
  });

  addSeparator(menu);

  // Tags
  addActionItem(menu, 'Tags...', () => {
    document.dispatchEvent(new CustomEvent('hotsheet:show-tags-dialog'));
  }, { icon: ICON_TAG });

  // Duplicate
  addActionItem(menu, 'Duplicate', async () => {
    const ids = Array.from(state.selectedIds);
    const created = await api<Ticket[]>('/tickets/duplicate', { method: 'POST', body: { ids } });
    state.selectedIds.clear();
    for (const t of created) state.selectedIds.add(t.id);
    void loadTickets();
  }, { icon: ICON_COPY });

  // Mark as Read / Unread
  const hasUnread = Array.from(state.selectedIds).some(id => {
    const t = state.tickets.find(tk => tk.id === id);
    return t != null && t.last_read_at != null && t.updated_at > t.last_read_at;
  });
  if (hasUnread) {
    addActionItem(menu, 'Mark as Read', async () => {
      setSuppressAutoRead(false);
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      const readAt = new Date().toISOString();
      for (const t of affected) t.last_read_at = readAt;
      await trackedBatch(affected, { ids, action: 'mark_read' }, 'Mark as Read');
      renderTicketList();
    }, { icon: ICON_EYE });
  } else {
    addActionItem(menu, 'Mark as Unread', async () => {
      setSuppressAutoRead(true);
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      // Use epoch date instead of null so updated_at > last_read_at is true (shows blue dot)
      const epoch = '1970-01-01T00:00:00Z';
      for (const t of affected) t.last_read_at = epoch;
      await trackedBatch(affected, { ids, action: 'mark_unread' }, 'Mark as Unread');
      renderTicketList();
    }, { icon: ICON_EYE_OFF });
  }

  // Push to remote backend (only for unsynced single-ticket selection)
  if (state.selectedIds.size === 1 && !(ticket.id in syncedTicketMap)) {
    void api<{ id: string; name: string; icon?: string }[]>('/backends').then(backends => {
      if (backends.length === 0) return;
      // Insert before the backlog separator (find the right position)
      const separators = menu.querySelectorAll('.context-menu-separator');
      const insertBefore = separators.length >= 2 ? separators[1] : null;
      const pushSep = toElement(<div className="context-menu-separator"></div>);
      if (insertBefore) menu.insertBefore(pushSep, insertBefore);
      else menu.appendChild(pushSep);
      for (const b of backends) {
        const item = toElement(
          <div className="context-menu-item">
            {b.icon != null && b.icon !== '' ? <span className="dropdown-icon">{raw(b.icon)}</span> : null}
            <span className="context-menu-label">Push to {b.name}</span>
          </div>
        );
        item.addEventListener('click', async () => {
          closeContextMenu();
          try {
            const result = await api<{ ok: boolean; remoteId: string; remoteUrl: string | null }>(
              `/plugins/${b.id}/push-ticket/${ticket.id}`, { method: 'POST' },
            );
            if (result.remoteUrl != null && result.remoteUrl !== '') window.open(result.remoteUrl, '_blank');
            void loadTickets();
          } catch (e) {
            console.error('Failed to push ticket:', e);
          }
        });
        if (insertBefore) menu.insertBefore(item, insertBefore);
        else menu.appendChild(item);
      }
    });
  }

  addSeparator(menu);

  // Move to Backlog
  addActionItem(menu, 'Move to Backlog', () => applyToSelected('status', 'backlog'), {
    icon: ICON_CALENDAR,
  });
  // Archive
  addActionItem(menu, 'Archive', () => applyToSelected('status', 'archive'), {
    icon: ICON_ARCHIVE,
  });

  // Plugin context menu items
  const pluginItems = getPluginContextMenuItems(Array.from(state.selectedIds));
  if (pluginItems.length > 0) {
    addSeparator(menu);
    for (const item of pluginItems) {
      addActionItem(menu, item.label, () => { item.action(); }, {
        icon: item.icon,
      });
    }
  }

  addSeparator(menu);

  // Delete
  addActionItem(menu, 'Delete', async () => {
    if (state.selectedIds.size === 1) {
      await trackedDelete(ticket);
    } else {
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      await trackedBatch(affected, { ids, action: 'delete' }, 'Delete');
    }
    state.selectedIds.clear();
    void loadTickets();
  }, { danger: true, icon: ICON_TRASH });

  document.body.appendChild(menu);
  clampToViewport(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('contextmenu', closeContextMenu);
  }, 0);
}

function closeContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  document.removeEventListener('click', closeContextMenu);
  document.removeEventListener('contextmenu', closeContextMenu);
}

function clampToViewport(menu: HTMLElement) {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

async function applyToSelected(action: string, value: unknown) {
  const ids = Array.from(state.selectedIds);
  const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
  if (ids.length === 1) {
    const ticket = affected[0];
    await trackedPatch(ticket, { [action]: value }, `Change ${action}`);
  } else {
    await trackedBatch(affected, { ids, action, value }, `Change ${action}`);
  }
  void loadTickets();
}

interface SubItem {
  label: string;
  icon?: string;
  iconColor?: string;
  active?: boolean;
  action: () => void;
}

function addSubmenuItem(menu: HTMLElement, label: string, items: SubItem[]) {
  const item = toElement(
    <div className="context-menu-item has-submenu">
      <span className="context-menu-label">{label}</span>
      <span className="context-menu-arrow">{'\u25B8'}</span>
    </div>
  );

  const submenu = toElement(<div className="context-submenu"></div>);
  for (const sub of items) {
    const subItem = toElement(
      <div className={`context-menu-item${sub.active === true ? ' active' : ''}`}>
        {sub.icon !== undefined && sub.icon !== '' ? <span className="dropdown-icon" style={sub.iconColor !== undefined && sub.iconColor !== '' ? `color:${sub.iconColor}` : ''}>{raw(sub.icon)}</span> : null}
        <span className="context-menu-label">{sub.label}</span>
      </div>
    );
    subItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      sub.action();
      closeContextMenu();
    });
    submenu.appendChild(subItem);
  }

  item.appendChild(submenu);
  menu.appendChild(item);
}

function addActionItem(menu: HTMLElement, label: string, action: () => void, options?: { danger?: boolean; icon?: string }) {
  const item = toElement(
    <div className={`context-menu-item${options?.danger === true ? ' danger' : ''}`}>
      {options?.icon !== undefined ? <span className="dropdown-icon">{raw(options.icon)}</span> : null}
      <span className="context-menu-label">{label}</span>
    </div>
  );
  item.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeContextMenu();
    action();
  });
  menu.appendChild(item);
}

function addSeparator(menu: HTMLElement) {
  menu.appendChild(toElement(<div className="context-menu-separator"></div>));
}

// --- Not Working dialog ---

function showNotWorkingDialog(ticket: Ticket) {
  const overlay = toElement(
    <div className="custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor" style="width:480px">
        <div className="custom-view-editor-header">
          <span>Not Working — {ticket.ticket_number}</span>
          <button className="detail-close" id="not-working-close">{'\u00d7'}</button>
        </div>
        <div className="custom-view-editor-body">
          <div className="settings-field">
            <label>What's wrong?</label>
            <textarea id="not-working-text" className="settings-textarea" rows={4} placeholder="Describe the issue..." style="width:100%;resize:vertical"></textarea>
          </div>
          <div className="settings-field" style="margin-top:12px">
            <label>Attachments</label>
            <div id="not-working-files" className="not-working-file-list"></div>
            <button className="btn btn-sm" id="not-working-add-file" style="margin-top:6px">Add File...</button>
            <input type="file" id="not-working-file-input" multiple={true} style="display:none" />
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
            <button className="btn btn-sm" id="not-working-cancel">Cancel</button>
            <button className="btn btn-sm btn-danger" id="not-working-submit">Report Not Working</button>
          </div>
        </div>
      </div>
    </div>
  );

  const pendingFiles: File[] = [];
  const fileListEl = overlay.querySelector('#not-working-files')!;
  const fileInput = overlay.querySelector('#not-working-file-input') as HTMLInputElement;

  function renderFileList() {
    fileListEl.innerHTML = '';
    for (let i = 0; i < pendingFiles.length; i++) {
      const file = pendingFiles[i];
      const row = toElement(
        <div className="not-working-file-row">
          <span>{file.name}</span>
          <button className="category-delete-btn" data-idx={String(i)}>{'\u00d7'}</button>
        </div>
      );
      row.querySelector('button')!.addEventListener('click', () => {
        pendingFiles.splice(i, 1);
        renderFileList();
      });
      fileListEl.appendChild(row);
    }
  }

  overlay.querySelector('#not-working-add-file')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) pendingFiles.push(f);
      renderFileList();
    }
    fileInput.value = '';
  });

  // Drag-and-drop file support on the entire overlay
  overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      for (const f of Array.from(e.dataTransfer.files)) pendingFiles.push(f);
      renderFileList();
    }
  });

  const close = () => overlay.remove();
  overlay.querySelector('#not-working-close')!.addEventListener('click', close);
  overlay.querySelector('#not-working-cancel')!.addEventListener('click', close);
  // Intentionally no click-outside-to-dismiss — this dialog has form data
  // (text + attachments) that would be lost on accidental clicks.

  overlay.querySelector('#not-working-submit')!.addEventListener('click', async () => {
    const text = (overlay.querySelector('#not-working-text') as HTMLTextAreaElement).value.trim();
    if (!text) {
      (overlay.querySelector('#not-working-text') as HTMLTextAreaElement).focus();
      return;
    }

    const submitBtn = overlay.querySelector('#not-working-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      // Add note
      await api(`/tickets/${ticket.id}`, {
        method: 'PATCH',
        body: { notes: `Not working: ${text}`, status: 'not_started', up_next: true },
      });

      // Upload attachments
      for (const file of pendingFiles) {
        await apiUpload(`/tickets/${ticket.id}/attachments`, file);
      }

      close();
      void loadTickets();
    } catch {
      submitBtn.textContent = 'Report Not Working';
      submitBtn.disabled = false;
    }
  });

  document.body.appendChild(overlay);
  (overlay.querySelector('#not-working-text') as HTMLTextAreaElement).focus();
}
