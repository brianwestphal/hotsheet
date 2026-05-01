import { suppressAnimation } from './animate.js';
import { api } from './api.js';
import { applyDetailPosition, applyDetailSize, updateDetailCategory } from './detail.js';
import { toElement } from './dom.js';
import type { CategoryDef } from './state.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';

/** Load settings from the API and apply them to the app state and UI. */
export async function loadSettings() {
  try {
    const settings = await api<Record<string, string>>('/settings');
    if (settings.detail_position === 'side' || settings.detail_position === 'bottom') {
      state.settings.detail_position = settings.detail_position;
    }
    if (settings.detail_visible !== '') {
      state.settings.detail_visible = settings.detail_visible !== 'false';
    }
    if (settings.detail_width !== '') state.settings.detail_width = parseInt(settings.detail_width, 10) || 360;
    if (settings.detail_height !== '') state.settings.detail_height = parseInt(settings.detail_height, 10) || 300;
    if (settings.trash_cleanup_days !== '') state.settings.trash_cleanup_days = parseInt(settings.trash_cleanup_days, 10) || 3;
    if (settings.verified_cleanup_days !== '') state.settings.verified_cleanup_days = parseInt(settings.verified_cleanup_days, 10) || 30;
    if (settings.layout === 'list' || settings.layout === 'columns') state.layout = settings.layout;
    if (settings.notify_permission === 'none' || settings.notify_permission === 'once' || settings.notify_permission === 'persistent') {
      state.settings.notify_permission = settings.notify_permission;
    }
    if (settings.notify_completed === 'none' || settings.notify_completed === 'once' || settings.notify_completed === 'persistent') {
      state.settings.notify_completed = settings.notify_completed;
    }
    if (settings.auto_order !== '') {
      state.settings.auto_order = settings.auto_order !== 'false';
    }
    if (settings.hide_verified_column !== '') {
      state.settings.hide_verified_column = settings.hide_verified_column === 'true';
    }
    // HS-7269 — defaults to true when the key is absent, so users on upgraded
    // installs get the Phase 2 UI without touching settings.
    if (settings.shell_integration_ui !== '') {
      state.settings.shell_integration_ui = settings.shell_integration_ui !== 'false';
    }
    // HS-7988 — §52 Phase 4 master toggle. Default true so the detector is
    // on for everyone after upgrade; flipping false short-circuits the
    // detector before the parser registry runs.
    // HS-8093 — `!== undefined` half of the check was redundant with TS's
    // `Record<string, string>` typing of `settings`; matched the
    // surrounding `!== ''`-only pattern for boolean toggles. Behaviour
    // is unchanged: an absent key falls through to the `state.settings`
    // default the module already initialises.
    if (settings.terminal_prompt_detection_enabled !== '') {
      state.settings.terminal_prompt_detection_enabled = settings.terminal_prompt_detection_enabled !== 'false';
    }
    // HS-7984 — §53 Phase 4 streaming toggle. Default true (recommended in
    // §53.8 — change is small and reversible; default-on makes the
    // feature discoverable via the first-use toast).
    if (settings.shell_streaming_enabled !== '') {
      state.settings.shell_streaming_enabled = settings.shell_streaming_enabled !== 'false';
    }
    if (settings.sort_by) state.sortBy = settings.sort_by;
    if (settings.sort_dir) state.sortDir = settings.sort_dir;
  } catch { /* use defaults */ }

  // Sync sort dropdown UI to loaded state
  const sortSelect = document.getElementById('sort-select') as HTMLSelectElement | null;
  if (sortSelect) sortSelect.value = `${state.sortBy}:${state.sortDir}`;

  applyDetailPosition(state.settings.detail_position);
  applyDetailSize();
  // Apply detail panel visibility
  if (!state.settings.detail_visible) {
    const panel = document.getElementById('detail-panel');
    const handle = document.getElementById('detail-resize-handle');
    if (panel) panel.style.display = 'none';
    if (handle) handle.style.display = 'none';
  }
}

/** Load category definitions and rebuild the UI. */
export async function loadCategories(rebuildCategoryUI: () => void) {
  try {
    const categories = await api<CategoryDef[]>('/categories');
    if (categories.length > 0) state.categories = categories;
  } catch { /* use defaults */ }
  rebuildCategoryUI();
}

/** Rebuild the sidebar category buttons and refresh the detail panel category. */
export function rebuildCategoryUI() {
  const sidebarSection = document.getElementById('sidebar-categories');
  if (sidebarSection) {
    const label = sidebarSection.querySelector('.sidebar-label');
    sidebarSection.innerHTML = '';
    if (label) sidebarSection.appendChild(label);
    for (const cat of state.categories) {
      const btn = toElement(
        <button className={`sidebar-item${state.view === `category:${cat.id}` ? ' active' : ''}`} data-view={`category:${cat.id}`}>
          <span className="cat-dot" style={`background:${cat.color}`}></span> {cat.label}
        </button>
      );
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        btn.classList.add('active');
        state.view = `category:${cat.id}`;
        state.selectedIds.clear();
        restoreTicketList();
        suppressAnimation();
        void loadTickets();
      });
      sidebarSection.appendChild(btn);
    }
  }

  // Refresh detail panel category button if a ticket is active
  if (state.activeTicketId != null) {
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) updateDetailCategory(ticket.category);
  }
}

/** Load the app name from file-based settings and update the title bar. */
export async function loadAppName() {
  try {
    const fs = await api<{ appName?: string }>('/file-settings');
    if (fs.appName !== undefined && fs.appName !== '') {
      document.title = fs.appName;
      const h1 = document.querySelector('.app-title h1');
      if (h1) h1.textContent = fs.appName;
    }
  } catch { /* ignore */ }
}

// Callback for restoring ticket list view — set by dashboardMode
let _restoreTicketList: (() => void) | null = null;

export function setRestoreTicketListCallback(fn: () => void) {
  _restoreTicketList = fn;
}

function restoreTicketList() {
  _restoreTicketList?.();
}
