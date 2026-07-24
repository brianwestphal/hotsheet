import { getCategories, getLayeredFileSettings, getSettings } from '../api/index.js';
import { suppressAnimation } from './animate.js';
import { setAppTitleFromActiveProject } from './appTitle.js';
import { applyDetailPosition, applyDetailSize, updateDetailCategory } from './detail.js';
import { applyDevFeatureGates, hydrateDevFeatures } from './devFeatures.js';
import { byIdOrNull, toElement } from './dom.js';
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS, DEFAULT_SORT_BY, DEFAULT_SORT_DIR, state } from './state.js';
import { loadTickets } from './ticketList.js';

/** Load settings from the API and apply them to the app state and UI. */
export async function loadSettings() {
  try {
    const settings = await getSettings();
    // HS-9170 — these 6 are local-only FILE settings (settings.local.json), but
    // are read here client-side. Overlay the resolved file-layer value (local
    // wins) when present; fall back to the DB for legacy/unmigrated values. (The
    // server-read SCOPED_FIELDS — appName, telemetry_*, … — don't pass through
    // here, so they're unaffected.)
    try {
      const fileResolved = (await getLayeredFileSettings()).resolved;
      for (const k of ['notify_permission', 'notify_completed', 'auto_order', 'hide_verified_column', 'shell_integration_ui']) {
        const v = fileResolved[k];
        if (typeof v === 'string') settings[k] = v;
        else if (typeof v === 'boolean' || typeof v === 'number') settings[k] = String(v);
      }
      // HS-9313 — `ai_tool` is a shared file setting; hydrate it for the channel
      // busy-indicator label (agentDisplayName) and the command editor's "AI
      // agent" target button.
      //
      // HS-9406 — ALWAYS assign, falling back to 'auto' when the project leaves
      // the setting unset. Pre-fix this only wrote when the new project's file
      // settings actually carried an `ai_tool`, so `loadSettings()` on a project
      // switch (`reloadAppState`) left the PREVIOUS project's value in state —
      // the exact stale-carryover class as HS-8451's frozen app title. Symptom:
      // after visiting a `codex` project, every subsequent project's command
      // editor segmented control (and busy indicator) said "Codex" until reload.
      state.settings.ai_tool = typeof fileResolved.ai_tool === 'string' && fileResolved.ai_tool !== ''
        ? fileResolved.ai_tool
        : 'auto';
      // HS-9411 (docs/124) — hydrate the In Development gates for this project.
      // `hydrateDevFeatures` REPLACES the cache (every gate defaults to false), so
      // a project that never enabled one can't inherit the previous project's
      // `true` — the HS-9407 rule applied to the newest per-project state.
      hydrateDevFeatures(fileResolved);
      applyDevFeatureGates();
    } catch { /* file-settings fetch failed — keep DB values */ }
    // HS-9407 — every per-project value below is assigned UNCONDITIONALLY,
    // falling back to its `DEFAULT_SETTINGS` (or `DEFAULT_LAYOUT` / `DEFAULT_SORT_*`)
    // value when THIS project has none. `loadSettings()` runs on every project
    // switch (`reloadAppState`), so the pre-fix `if (settings.X !== '') …` shape
    // silently left the PREVIOUS project's value in state for any project that
    // never persisted its own — the same stale-carryover class as HS-8451 (app
    // title) and HS-9406 (`ai_tool`). `unset()` is the single "this project has
    // no value" test; anything present but unparseable also falls back.
    const unset = (v: string | undefined): boolean => v === undefined || v === '';
    state.settings.detail_position = settings.detail_position === 'side' || settings.detail_position === 'bottom'
      ? settings.detail_position
      : DEFAULT_SETTINGS.detail_position;
    state.settings.detail_visible = unset(settings.detail_visible)
      ? DEFAULT_SETTINGS.detail_visible
      : settings.detail_visible !== 'false';
    state.settings.detail_width = parseInt(settings.detail_width, 10) || DEFAULT_SETTINGS.detail_width;
    state.settings.detail_height = parseInt(settings.detail_height, 10) || DEFAULT_SETTINGS.detail_height;
    state.settings.trash_cleanup_days = parseInt(settings.trash_cleanup_days, 10) || DEFAULT_SETTINGS.trash_cleanup_days;
    state.settings.verified_cleanup_days = parseInt(settings.verified_cleanup_days, 10) || DEFAULT_SETTINGS.verified_cleanup_days;
    state.layout = settings.layout === 'list' || settings.layout === 'columns' ? settings.layout : DEFAULT_LAYOUT;
    state.settings.notify_permission = settings.notify_permission === 'none' || settings.notify_permission === 'once' || settings.notify_permission === 'persistent'
      ? settings.notify_permission
      : DEFAULT_SETTINGS.notify_permission;
    state.settings.notify_completed = settings.notify_completed === 'none' || settings.notify_completed === 'once' || settings.notify_completed === 'persistent'
      ? settings.notify_completed
      : DEFAULT_SETTINGS.notify_completed;
    state.settings.auto_order = unset(settings.auto_order)
      ? DEFAULT_SETTINGS.auto_order
      : settings.auto_order !== 'false';
    state.settings.hide_verified_column = unset(settings.hide_verified_column)
      ? DEFAULT_SETTINGS.hide_verified_column
      : settings.hide_verified_column === 'true';
    // HS-7269 / HS-9188 — an explicit stored value wins; absent falls back to
    // the opt-in default (OFF) rather than the previous project's choice.
    state.settings.shell_integration_ui = unset(settings.shell_integration_ui)
      ? DEFAULT_SETTINGS.shell_integration_ui
      : settings.shell_integration_ui !== 'false';
    state.sortBy = unset(settings.sort_by) ? DEFAULT_SORT_BY : settings.sort_by;
    state.sortDir = unset(settings.sort_dir) ? DEFAULT_SORT_DIR : settings.sort_dir;
  } catch { /* use defaults */ }

  // Sync sort dropdown UI to loaded state
  const sortSelect = byIdOrNull<HTMLSelectElement>('sort-select');
  if (sortSelect) sortSelect.value = `${state.sortBy}:${state.sortDir}`;

  applyDetailPosition(state.settings.detail_position);
  applyDetailSize();
  // Apply detail panel visibility. HS-9407 — SYMMETRIC: this used to only ever
  // hide, so switching from a project with the panel hidden to one that never
  // persisted `detail_visible` left the panel hidden even though state now says
  // visible (the DOM half of the same carryover). `'flex'` / `''` match what
  // `updateDetailPanel` (detail.tsx) uses for the shown state.
  const panel = byIdOrNull('detail-panel');
  const handle = byIdOrNull('detail-resize-handle');
  if (panel) panel.style.display = state.settings.detail_visible ? 'flex' : 'none';
  if (handle) handle.style.display = state.settings.detail_visible ? '' : 'none';
}

/** Load category definitions and rebuild the UI. */
export async function loadCategories(rebuildCategoryUI: () => void) {
  try {
    const categories = await getCategories();
    if (categories.length > 0) state.categories = categories;
  } catch { /* use defaults */ }
  rebuildCategoryUI();
}

/** Rebuild the sidebar category buttons and refresh the detail panel category. */
export function rebuildCategoryUI() {
  const sidebarSection = byIdOrNull('sidebar-categories');
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

/** HS-8451 — sync the visible app title (browser tab + sidebar `<h1>` + native
 *  Tauri window title) to the active project's display name. Pre-fix this
 *  fetched `/file-settings` and ONLY updated the title when `appName` was a
 *  non-empty string, so switching from a project-with-appName to one without
 *  left the title frozen at the previous project's name — the user-reported
 *  "title is always the first project" symptom. The `ProjectInfo.name` field
 *  on the active project already carries the right value (appName or folder
 *  fallback per `src/projects.ts`), so we delegate to the shared
 *  `setAppTitleFromActiveProject` helper in `appTitle.tsx` and drop the
 *  redundant `/file-settings` round-trip. */
export function loadAppName() {
  setAppTitleFromActiveProject();
}

// Callback for restoring ticket list view — set by dashboardMode
let _restoreTicketList: (() => void) | null = null;

export function setRestoreTicketListCallback(fn: () => void) {
  _restoreTicketList = fn;
}

function restoreTicketList() {
  _restoreTicketList?.();
}
