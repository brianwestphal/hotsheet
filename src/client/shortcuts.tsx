import { formatTicketForClipboard } from './clipboardUtil.js';
import { showPrintDialog } from './print.js';
import { state } from './state.js';
import { cancelPendingSave, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { canRedo, canUndo, performRedo, performUndo, trackedBatch, trackedCompoundBatch } from './undo/actions.js';

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
  console.log('[undo] triggerUndo called, canUndo:', canUndo());
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  performUndo().then(() => console.log('[undo] performUndo completed')).catch((e: unknown) => console.error('[undo] performUndo error:', e));
}

function triggerRedo() {
  console.log('[undo] triggerRedo called, canRedo:', canRedo());
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  performRedo().then(() => console.log('[undo] performRedo completed')).catch((e: unknown) => console.error('[undo] performRedo error:', e));
}

export function bindKeyboardShortcuts() {
  // Tauri menu events for Undo/Redo (native menu captures Cmd+Z before the WebView)
  window.addEventListener('app:undo', triggerUndo);
  window.addEventListener('app:redo', triggerRedo);

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

    // Close settings dialog on Escape
    const overlay = document.getElementById('settings-overlay')!;
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
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
          const text = selected.map(formatTicketForClipboard).join('\n\n');
          void navigator.clipboard.writeText(text);
          return;
        }
      }
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
