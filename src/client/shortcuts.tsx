import { copyTickets, hasClipboardTickets, pasteTickets } from './clipboard.js';
import { formatTicketForClipboard } from './clipboardUtil.js';
import { showOpenFolderDialog } from './openFolder.js';
import { showPrintDialog } from './print.js';
import { closeActiveTab, switchTabByOffset } from './projectTabs.js';
import { state } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { cancelPendingSave, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { performRedo, performUndo, trackedBatch, trackedCompoundBatch } from './undo/actions.js';

let detailSaveTimeout: ReturnType<typeof setTimeout> | null = null;

/** Set the detail save timeout reference — called from bindDetailPanel to share the timeout */
export function setDetailSaveTimeout(timeout: ReturnType<typeof setTimeout> | null) {
  detailSaveTimeout = timeout;
}

/** Get the current detail save timeout */
export function getDetailSaveTimeout(): ReturnType<typeof setTimeout> | null {
  return detailSaveTimeout;
}

function triggerUndo() {
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  void performUndo();
}

function triggerRedo() {
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  void performRedo();
}

export function bindKeyboardShortcuts() {
  // Tauri menu events
  window.addEventListener('app:undo', triggerUndo);
  window.addEventListener('app:redo', triggerRedo);
  window.addEventListener('app:preferences', () => document.getElementById('settings-btn')?.click());
  window.addEventListener('app:open-folder', () => showOpenFolderDialog());

  // Keyboard fallback for browser mode (non-Tauri) — capture phase
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        triggerRedo();
      } else {
        triggerUndo();
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input/textarea (except specific shortcuts)
    const tag = (e.target as HTMLElement).tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Close any open dialog on Escape
    if (e.key === 'Escape') {
      for (const id of ['open-folder-overlay', 'settings-overlay']) {
        const dlg = document.getElementById(id);
        if (dlg && dlg.style.display !== 'none') {
          dlg.style.display = 'none';
          return;
        }
      }
    }

    // Tab switching: Cmd+Shift+[/] (works even in inputs) or Cmd+Shift+Left/Right (not in text fields)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      if (e.key === '[') {
        e.preventDefault();
        switchTabByOffset(-1);
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        switchTabByOffset(1);
        return;
      }
      if (!isInput && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        switchTabByOffset(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
    }

    // Close tab: Opt+Cmd+W (macOS) / Ctrl+Alt+W (other)
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeActiveTab();
      return;
    }

    // Cmd/Ctrl+O: Open Folder (browser mode — Tauri handles via menu)
    if ((e.metaKey || e.ctrlKey) && e.key === 'o' && !getTauriInvoke()) {
      e.preventDefault();
      showOpenFolderDialog();
      return;
    }

    // Cmd/Ctrl+,: Settings (browser mode — Tauri handles via menu)
    if ((e.metaKey || e.ctrlKey) && e.key === ',' && !getTauriInvoke()) {
      e.preventDefault();
      document.getElementById('settings-btn')?.click();
      return;
    }

    if (e.key === 'Escape') {
      // If editing a field in the detail panel, just blur it
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.closest('.detail-panel, .detail-body')) {
        active.blur();
        return;
      }
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
      return;
    }

    // Arrow keys in column view: navigate between cards
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isInput && state.layout === 'columns') {
      const allCards = Array.from(document.querySelectorAll<HTMLElement>('.column-card[data-id]'));
      if (allCards.length > 0 && state.selectedIds.size > 0) {
        e.preventDefault();
        // Find the currently selected card
        const currentId = state.lastClickedId ?? Array.from(state.selectedIds)[0];
        const currentIdx = allCards.findIndex(c => c.dataset.id === String(currentId));
        const nextIdx = e.key === 'ArrowDown' ? currentIdx + 1 : currentIdx - 1;
        if (nextIdx >= 0 && nextIdx < allCards.length) {
          const nextCard = allCards[nextIdx];
          const nextId = parseInt(nextCard.dataset.id!, 10);
          if (e.shiftKey) {
            state.selectedIds.add(nextId);
          } else {
            state.selectedIds.clear();
            state.selectedIds.add(nextId);
          }
          state.lastClickedId = nextId;
          nextCard.scrollIntoView({ block: 'nearest' });
          renderTicketList();
        }
        return;
      }
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
        const ids = Array.from(state.selectedIds);
        if (settingUpNext) {
          const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
          if (doneTickets.length > 0) {
            void trackedCompoundBatch(selectedTickets, [
              { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
              { ids, action: 'up_next', value: true },
            ], 'Toggle up next').then(() => void loadTickets());
            return;
          }
        }
        void trackedBatch(
          selectedTickets,
          { ids, action: 'up_next', value: settingUpNext },
          'Toggle up next',
        ).then(() => void loadTickets());
      }
      return;
    }

    // Cmd/Ctrl+C: copy selected ticket(s) info to clipboard
    // Opt+Cmd/Ctrl+C: force ticket copy even when in a text field
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && state.selectedIds.size > 0) {
      // Let native copy work in text fields (unless Alt/Option forces ticket copy)
      if (isInput && !e.altKey) { /* native copy */ }
      else {
        // Also let native copy work when text is selected on the page
        const sel = !e.altKey ? window.getSelection() : null;
        if (sel !== null && !sel.isCollapsed && sel.toString().trim() !== '') { /* native copy */ }
        else {
          e.preventDefault();
          const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
          // Store structured data in internal clipboard for cross-project paste
          copyTickets(selected, false);
          // Also write text to system clipboard for external paste
          const text = selected.map(formatTicketForClipboard).join('\n\n');
          void navigator.clipboard.writeText(text);
          return;
        }
      }
    }

    // Cmd/Ctrl+X: cut selected tickets (copy + mark for deletion on paste)
    if ((e.metaKey || e.ctrlKey) && e.key === 'x' && state.selectedIds.size > 0) {
      if (isInput && !e.altKey) { /* native cut */ }
      else {
        const sel = !e.altKey ? window.getSelection() : null;
        if (sel !== null && !sel.isCollapsed && sel.toString().trim() !== '') { /* native cut */ }
        else {
          e.preventDefault();
          const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
          copyTickets(selected, true);
          const text = selected.map(formatTicketForClipboard).join('\n\n');
          void navigator.clipboard.writeText(text);
          return;
        }
      }
    }

    // Cmd/Ctrl+V: paste tickets from internal clipboard
    if ((e.metaKey || e.ctrlKey) && e.key === 'v' && !isInput && hasClipboardTickets()) {
      e.preventDefault();
      void pasteTickets();
      return;
    }

    // Cmd/Ctrl+N: focus draft input (works everywhere)
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      focusDraftInput();
      return;
    }

    // Cmd/Ctrl+P: print
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      showPrintDialog();
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

    // Delete/Backspace: delete selected tickets (when not in an input)
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput && state.selectedIds.size > 0) {
      e.preventDefault();
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      void trackedBatch(affected, { ids, action: 'delete' }, 'Delete').then(() => {
        state.selectedIds.clear();
        void loadTickets();
      });
      return;
    }
  });
}
