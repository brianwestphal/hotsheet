import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { activeFilterTypes, ALL_FILTER_TYPES, dismissFilterDropdown, showFilterDropdown } from './commandLogFilter.js';
import { maybeFireShellStreamFirstUseToast, SHELL_PARTIAL_OUTPUT_EVENT,type ShellPartialOutputEvent } from './commandSidebar.js';
import { toElement } from './dom.js';
import { resolveDrawerTabForTauri } from './drawerTabGating.js';
import { state } from './state.js';
import { stripAnsi } from './stripAnsi.js';
import { getTauriInvoke } from './tauriIntegration.js';

let runningShellIds: number[] = [];
const cancelingShellIds = new Set<number>();

interface LogEntry {
  id: number;
  event_type: string;
  direction: string;
  summary: string;
  detail: string;
  created_at: string;
}

let panelOpen = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSeenId = 0;
let currentSearch = '';
/**
 * Active drawer tab id. `commands-log` selects the log pane; anything else is
 * interpreted as `terminal:<id>` and routed through the embedded terminal module.
 */
let activeTab: string = 'commands-log';

/** Read the id of the currently-visible drawer tab (`commands-log` or `terminal:<id>`). */
export function getActiveDrawerTab(): string {
  return activeTab;
}

// --- Selection state (HS-2544) ---

const selectedLogIds = new Set<number>();
let lastClickedId: number | null = null;
let currentEntries: LogEntry[] = [];
const expandedEntryIds = new Set<number>();

/**
 * HS-7983 — sticky-bottom auto-scroll threshold (px). When the scroll
 * container is within this many px of the bottom, the partial-output
 * listener counts the user as "pinned" and re-pins after appending the
 * new chunk. Once the user scrolls up past the threshold we stop
 * auto-following so a chatty command doesn't fight a manual review.
 *
 * Value chosen empirically: needs to be larger than typical sub-pixel
 * rounding (1–2 px) but smaller than a single line of text (~16 px) so
 * scrolling up by a single line definitively unpins. 8 px hits the
 * middle of that range.
 */
const STICKY_BOTTOM_THRESHOLD_PX = 8;

/** Pure: decide whether to auto-scroll the partial-output container to
 *  the bottom after appending a chunk. Exported for unit tests so
 *  happy-dom doesn't need to mount the whole drawer to verify the rule.
 *  Inputs match `Element.scrollTop` / `clientHeight` / `scrollHeight`
 *  semantics — caller pulls them off whatever scroller wraps the
 *  partial-output `<pre>`. */
export function shouldAutoScrollToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold: number = STICKY_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * HS-7983 — apply a single `hotsheet:shell-partial-output` event to the
 * Commands Log entries DOM. Exported so happy-dom unit tests can drive
 * the live-render path without bootstrapping `initCommandLog`'s full
 * suite of side-effects. The actual `window.addEventListener` wiring is
 * a one-liner inside `initCommandLog` that delegates here.
 *
 * Behaviour:
 * - No `#command-log-entries` container or no matching
 *   `data-shell-partial-id` `<pre>` → no-op (defensive; the entry might
 *   not be rendered yet, e.g. if a chunk arrives before `loadEntries`).
 * - Sticky-bottom auto-scroll: pinned-state is captured BEFORE the
 *   textContent swap because the text change grows `scrollHeight`,
 *   which would otherwise always make the post-write threshold look
 *   bigger than pre-write.
 */
export function applyShellPartialEvent(detail: ShellPartialOutputEvent): void {
  // HS-7984 — gate Commands Log live-render on the §53 Phase 4 setting.
  // Server still buffers + dispatches events; this consumer just
  // no-ops. Re-enabling mid-run picks up at the next chunk because the
  // server-side partial buffer survives the gate flip.
  if (!state.settings.shell_streaming_enabled) return;
  const container = document.getElementById('command-log-entries');
  if (container === null) return;
  const partialEl = container.querySelector<HTMLElement>(`pre.command-log-shell-partial[data-shell-partial-id="${detail.id}"]`);
  if (partialEl === null) return;
  // HS-8015 — sole survivor of the previous dual-render path. The
  // first-use discoverability toast used to fire from the (now-removed)
  // sidebar preview; relocated here so users still get the one-time
  // nudge that streaming exists, pointing them at the Commands Log.
  maybeFireShellStreamFirstUseToast();
  const wasPinned = shouldAutoScrollToBottom(container.scrollTop, container.clientHeight, container.scrollHeight);
  partialEl.textContent = stripAnsi(detail.partial);
  if (wasPinned) container.scrollTop = container.scrollHeight;
}

// --- Relative time helper ---

function relativeTime(iso: string): string {
  // Parse the timestamp — ensure it's treated as UTC
  let then: number;
  if (iso.endsWith('Z') || iso.includes('+') || iso.includes('T') && iso.match(/[+-]\d{2}:\d{2}$/)) {
    then = new Date(iso).getTime();
  } else {
    // No timezone indicator — append Z to force UTC interpretation
    then = new Date(iso + 'Z').getTime();
  }
  if (isNaN(then)) return iso; // fallback to raw string if unparseable

  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now'; // clock skew
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// --- Direction indicator ---

function directionIndicator(dir: string): { symbol: string; color: string } {
  switch (dir) {
    case 'outgoing': return { symbol: '\u2192', color: 'var(--accent)' };
    case 'incoming': return { symbol: '\u2190', color: '#22c55e' };
    default: return { symbol: '\u25CF', color: 'var(--text-muted)' };
  }
}

// --- Event type badge colors ---

function typeBadgeColor(eventType: string): string {
  switch (eventType) {
    case 'trigger': return '#3b82f6';
    case 'done': return '#22c55e';
    case 'permission_request': return '#f97316';
    case 'shell_command': return '#6b7280';
    default: return '#6b7280';
  }
}

function typeBadgeLabel(eventType: string): string {
  switch (eventType) {
    case 'trigger': return 'trigger';
    case 'done': return 'done';
    case 'permission_request': return 'permission';
    case 'shell_command': return 'shell';
    default: return eventType;
  }
}

// --- Shell command detail formatting (HS-2547) ---

function formatShellDetail(detail: string): { inputLine: string; output: string } | null {
  const sep = '\n---SHELL_OUTPUT---\n';
  const idx = detail.indexOf(sep);
  if (idx === -1) return null;
  return {
    inputLine: detail.slice(0, idx),
    output: detail.slice(idx + sep.length),
  };
}

// --- Context menu (HS-2546) ---

function dismissContextMenu() {
  document.querySelector('.command-log-context-menu')?.remove();
}

function getEntryText(entry: LogEntry): string {
  let text = entry.summary;
  if (entry.detail) text += '\n' + entry.detail;
  return text;
}

function showContextMenu(x: number, y: number, entries: LogEntry[]) {
  dismissContextMenu();
  // HS-7835 — consistent icon-row markup with the other context menus
  // (`.dropdown-icon` + `.context-menu-label` spans).
  const menu = toElement(
    <div className="command-log-context-menu" style={`left:${x}px;top:${y}px`}>
      <div className="context-menu-item" data-action="copy">
        <span className="dropdown-icon">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>')}</span>
        <span className="context-menu-label">Copy{entries.length > 1 ? ` (${entries.length} entries)` : ''}</span>
      </div>
    </div>
  );

  const copyItem = menu.querySelector('[data-action="copy"]') as HTMLElement;
  copyItem.addEventListener('click', () => {
    const text = entries.map(e => getEntryText(e)).join('\n\n---\n\n');
    void navigator.clipboard.writeText(text);
    dismissContextMenu();
  });

  document.body.appendChild(menu);

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  // Dismiss on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        dismissContextMenu();
        document.removeEventListener('click', close, true);
      }
    };
    document.addEventListener('click', close, true);
  }, 0);
}

// --- Selection helpers ---

function updateSelectionClasses() {
  const container = document.getElementById('command-log-entries');
  if (!container) return;
  for (const el of container.querySelectorAll('.command-log-entry')) {
    const id = parseInt((el as HTMLElement).dataset.id ?? '0', 10);
    el.classList.toggle('selected', selectedLogIds.has(id));
  }
}

// --- Render entries ---

/** Create the DOM element for a single log entry, including event handlers. */
function renderLogEntry(entry: LogEntry, filtered: LogEntry[]): HTMLElement {
  const dir = directionIndicator(entry.direction);
  const badgeColor = typeBadgeColor(entry.event_type);
  const badgeLabel = typeBadgeLabel(entry.event_type);
  const time = relativeTime(entry.created_at);

  // Shell command combined display (HS-2547)
  const shellParts = entry.event_type === 'shell_command' ? formatShellDetail(entry.detail) : null;
  const displayDetail = shellParts ? shellParts.output : entry.detail;

  // Truncate detail to first 3 lines for preview
  const detailLines = displayDetail.split('\n');
  const preview = detailLines.slice(0, 3).join('\n');
  const hasMore = detailLines.length > 3 || displayDetail.length > 300;

  const isRunningShell = entry.event_type === 'shell_command' && runningShellIds.includes(entry.id);
  const isCanceling = cancelingShellIds.has(entry.id);

  const el = toElement(
    <div className={`command-log-entry${selectedLogIds.has(entry.id) ? ' selected' : ''}`} data-id={String(entry.id)}>
      <div className="command-log-entry-header">
        <span className="command-log-direction" style={`color:${dir.color}`}>{dir.symbol}</span>
        <span className="command-log-type-badge" style={`background:${badgeColor}`}>{badgeLabel}</span>
        <span className="command-log-summary">{entry.summary}</span>
        {isRunningShell && isCanceling
          ? <span className="command-log-canceling">{'Canceling\u2026'}</span>
          : isRunningShell
          ? <button className="command-log-stop-btn" title="Stop process">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>')}</button>
          : null}
        <span className="command-log-time">{time}</span>
      </div>
      {shellParts ? (
        <div>
          <pre className="command-log-detail command-log-shell-input">{shellParts.inputLine}</pre>
          {displayDetail !== '' ? <hr className="command-log-shell-divider" /> : null}
          {displayDetail !== '' ? <pre className="command-log-detail">{preview}{hasMore ? '\u2026' : ''}</pre> : null}
          {hasMore ? <pre className="command-log-detail-full" style="display:none">{displayDetail}</pre> : null}
        </div>
      ) : isRunningShell ? (
        // HS-7983 \u2014 running shell entries don't carry the
        // `---SHELL_OUTPUT---` separator yet (server only writes the final
        // detail in `child.on('close')`), so `formatShellDetail` returned
        // null. Render the command-as-shell-input + a dedicated live
        // `<pre class="command-log-shell-partial" data-shell-partial-id>`
        // that the module-level `hotsheet:shell-partial-output` listener
        // targets. Visual mirrors the completed-shell-entry layout above
        // so the swap on completion doesn't reflow alarmingly.
        <div>
          <pre className="command-log-detail command-log-shell-input">{entry.detail}</pre>
          <hr className="command-log-shell-divider" />
          <pre className="command-log-detail command-log-shell-partial" data-shell-partial-id={String(entry.id)}></pre>
        </div>
      ) : (
        <div>
          {entry.detail !== '' ? <pre className="command-log-detail">{preview}{hasMore ? '\u2026' : ''}</pre> : null}
          {hasMore ? <pre className="command-log-detail-full" style="display:none">{entry.detail}</pre> : null}
        </div>
      )}
    </div>
  );

  // Stop button handler
  if (isRunningShell) {
    const stopBtn = el.querySelector('.command-log-stop-btn') as HTMLElement;
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelingShellIds.add(entry.id);
      void api('/shell/kill', { method: 'POST', body: { id: entry.id } });
      stopBtn.replaceWith(toElement(<span className="command-log-canceling">{'Canceling\u2026'}</span>));
    });
  }

  // Click: selection + expand/collapse (HS-2544)
  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.command-log-stop-btn')) return;

    if (e.metaKey || e.ctrlKey) {
      if (selectedLogIds.has(entry.id)) {
        selectedLogIds.delete(entry.id);
      } else {
        selectedLogIds.add(entry.id);
      }
      lastClickedId = entry.id;
      updateSelectionClasses();
      return;
    }

    if (e.shiftKey && lastClickedId !== null) {
      const ids = filtered.map(e2 => e2.id);
      const startIdx = ids.indexOf(lastClickedId);
      const endIdx = ids.indexOf(entry.id);
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        for (let idx = lo; idx <= hi; idx++) {
          selectedLogIds.add(ids[idx]);
        }
        updateSelectionClasses();
        return;
      }
    }

    selectedLogIds.clear();
    selectedLogIds.add(entry.id);
    lastClickedId = entry.id;
    updateSelectionClasses();

    if (hasMore) {
      const isExpanded = el.classList.toggle('expanded');
      if (isExpanded) expandedEntryIds.add(entry.id); else expandedEntryIds.delete(entry.id);
      const detailEls = el.querySelectorAll('.command-log-detail:not(.command-log-shell-input)');
      const fullEl = el.querySelector<HTMLElement>('.command-log-detail-full');
      if (isExpanded) {
        for (const d of detailEls) (d as HTMLElement).style.display = 'none';
        if (fullEl) fullEl.style.display = '';
      } else {
        for (const d of detailEls) (d as HTMLElement).style.display = '';
        if (fullEl) fullEl.style.display = 'none';
      }
    }
  });

  // Right-click context menu (HS-2546)
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    let entriesToCopy: LogEntry[];
    if (selectedLogIds.size > 0 && selectedLogIds.has(entry.id)) {
      entriesToCopy = filtered.filter(e2 => selectedLogIds.has(e2.id));
    } else {
      entriesToCopy = [entry];
    }
    showContextMenu(e.clientX, e.clientY, entriesToCopy);
  });

  return el;
}

function renderEntries(entries: LogEntry[]) {
  currentEntries = entries;
  const container = document.getElementById('command-log-entries');
  if (!container) return;

  // Apply client-side type filter
  const filtered = activeFilterTypes.size === ALL_FILTER_TYPES.length
    ? entries
    : entries.filter(e => activeFilterTypes.has(e.event_type));

  if (filtered.length === 0) {
    container.innerHTML = '';
    container.appendChild(toElement(
      <div className="command-log-empty">No log entries</div>
    ));
    return;
  }

  // Build new content in a fragment first, only clear container on success
  const fragment = document.createDocumentFragment();
  for (const entry of filtered) {
    fragment.appendChild(renderLogEntry(entry, filtered));
  }

  // Replace content atomically — if anything above threw, the old content remains
  container.innerHTML = '';
  container.appendChild(fragment);

  // Restore expanded state from previous render
  for (const id of expandedEntryIds) {
    const el = container.querySelector<HTMLElement>(`.command-log-entry[data-id="${id}"]`);
    if (el !== null) {
      el.classList.add('expanded');
      const detailEls = el.querySelectorAll('.command-log-detail:not(.command-log-shell-input)');
      const fullEl = el.querySelector<HTMLElement>('.command-log-detail-full');
      for (const d of detailEls) (d as HTMLElement).style.display = 'none';
      if (fullEl) fullEl.style.display = '';
    }
  }
}

// --- Load entries from API ---

async function loadEntries() {
  let entries: LogEntry[];
  try {
    const params = new URLSearchParams();
    params.set('limit', '100');
    if (currentSearch !== '') params.set('search', currentSearch);

    // Fetch entries and running shell processes in parallel
    const [fetchedEntries, running] = await Promise.all([
      api<LogEntry[]>(`/command-log?${params.toString()}`),
      api<{ ids: number[] }>('/shell/running').catch(() => ({ ids: [] as number[] })),
    ]);
    entries = fetchedEntries;
    runningShellIds = running.ids;
    // Clean up canceling state for processes that are no longer running
    for (const id of cancelingShellIds) {
      if (!running.ids.includes(id)) cancelingShellIds.delete(id);
    }
    renderEntries(entries);
  } catch {
    // Don't clear the display on load errors — keep showing the last entries
    return;
  }

  // Track latest seen ID for badge
  if (entries.length > 0 && entries[0].id > lastSeenId) {
    lastSeenId = entries[0].id;
  }
}

// --- Panel open/close ---

function updateToggleIcon(isOpen: boolean) {
  const btn = document.getElementById('command-log-btn');
  if (!btn) return;
  btn.classList.toggle('is-open', isOpen);
  btn.setAttribute('title', isOpen ? 'Close drawer' : 'Commands Log');
}

/** Switch which drawer tab is visible. Both tab contents remain mounted.
 *  tab id is `commands-log` or `terminal:<terminalId>`. */
export function switchDrawerTab(tab: string) {
  tab = resolveDrawerTabForTauri(tab, getTauriInvoke() !== null);
  const changed = tab !== activeTab;
  activeTab = tab;
  // HS-6311 — clicking a drawer tab while in grid mode exits grid mode first
  // (mirrors §25.3 rule 3). Import is synchronous-ish here; safe because the
  // grid module doesn't import commandLog back (no cycle).
  void import('./drawerTerminalGrid.js').then(({ isDrawerGridActive, exitDrawerGridMode }) => {
    if (isDrawerGridActive()) exitDrawerGridMode();
  });
  for (const btn of document.querySelectorAll<HTMLElement>('.drawer-tab')) {
    btn.classList.toggle('active', btn.dataset.drawerTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.drawer-tab-content')) {
    panel.style.display = panel.dataset.drawerPanel === tab ? '' : 'none';
  }
  if (tab === 'commands-log') {
    // Entering commands-log: refresh + mark as seen.
    updateBadge(false);
    void loadEntries();
  } else if (tab.startsWith('terminal:')) {
    const terminalId = tab.slice('terminal:'.length);
    void import('./terminal.js').then(({ activateTerminal }) => { activateTerminal(terminalId); });
  }
  if (changed) void saveDrawerState();
}

function openPanel() {
  const panel = document.getElementById('command-log-panel')!;
  panel.style.display = '';
  panelOpen = true;
  updateToggleIcon(true);
  startPolling();
  // Refresh the dynamic terminal tab list before restoring the active tab so
  // the previously-active terminal (if any) exists in the DOM before we
  // activate it.
  void import('./terminal.js').then(({ loadAndRenderTerminalTabs }) => loadAndRenderTerminalTabs())
    .finally(() => { switchDrawerTab(activeTab); });
  void saveDrawerState();
}

/**
 * Temporarily show a drawer tab and return a disposer that restores the prior
 * state. Used by Settings → Terminal delete flow (HS-6403) to reveal the
 * terminal the user is about to remove before the confirm appears.
 */
export function previewDrawerTab(tab: string): () => void {
  const prevOpen = panelOpen;
  const prevTab = activeTab;
  if (!panelOpen) openPanel();
  switchDrawerTab(tab);
  return () => {
    if (!prevOpen) {
      closePanel();
    } else if (prevTab !== tab) {
      switchDrawerTab(prevTab);
    }
  };
}

/** Refresh the command log contents (e.g., after switching projects). */
export function refreshCommandLog() {
  const panel = document.getElementById('command-log-panel');
  if (panel && panel.style.display !== 'none') {
    void loadEntries();
  }
  void refreshLogBadge();
}

// --- Per-project drawer state persistence (HS-6309) ---
//
// The open/closed state of the drawer and the id of the active tab are stored
// in file-settings under `drawer_open` and `drawer_active_tab`. Both are
// project-scoped so switching projects restores whatever the user last had
// in view for that project (including which terminal tab was focused).

/** True while applyPerProjectDrawerState is restoring state — prevents feedback loops. */
let suspendSave = false;

async function saveDrawerState(): Promise<void> {
  if (suspendSave) return;
  try {
    await api('/file-settings', {
      method: 'PATCH',
      body: {
        drawer_open: panelOpen ? 'true' : 'false',
        drawer_active_tab: activeTab,
        drawer_expanded: isDrawerExpanded() ? 'true' : 'false',
      },
    });
  } catch { /* ignore — the user will open the drawer themselves next time */ }
}

// HS-6312: full-height drawer toggle. `.app.drawer-expanded` hides the ticket
// area so the drawer claims everything below the header. Persisted per-project
// alongside the existing drawer_open / drawer_active_tab keys.

/** HS-7660 — exposed so the drawer-grid module's enlarge / shrink callbacks
 *  can save the drawer's pre-enlarge expanded state. */
export function isDrawerExpanded(): boolean {
  return document.querySelector('.app')?.classList.contains('drawer-expanded') === true;
}

/** HS-7660 — exposed so the drawer-grid module can force the drawer to full
 *  height when a tile is centered / opened in dedicated view, then restore on
 *  shrink. The expand button + slider visibility flips alongside the class
 *  via the existing CSS rules. */
export function setDrawerExpanded(expanded: boolean): void {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('drawer-expanded', expanded);
  const btn = document.getElementById('drawer-expand-btn');
  if (btn !== null) {
    btn.title = expanded ? 'Restore tickets view' : 'Expand drawer to full height';
    const up = btn.querySelector<HTMLElement>('.drawer-expand-icon-up');
    const down = btn.querySelector<HTMLElement>('.drawer-expand-icon-down');
    if (up !== null) up.style.display = expanded ? 'none' : '';
    if (down !== null) down.style.display = expanded ? '' : 'none';
  }
}

function toggleDrawerExpanded(): void {
  const next = !isDrawerExpanded();
  // Expanding makes no sense unless the drawer is visible; open it first.
  if (next && !panelOpen) openPanel();
  setDrawerExpanded(next);
  void saveDrawerState();
}

/**
 * Called by the app on project switch (see app.tsx `reloadAppState`). Tears down
 * the old project's terminal instances, reloads the new project's terminal tabs,
 * then applies the saved drawer state (visibility + active tab).
 */
export async function applyPerProjectDrawerState(): Promise<void> {
  const { onProjectSwitch, loadAndRenderTerminalTabs } = await import('./terminal.js');
  onProjectSwitch();

  let fs: { drawer_open?: string | boolean; drawer_active_tab?: string; drawer_expanded?: string | boolean };
  try {
    fs = await api<{ drawer_open?: string | boolean; drawer_active_tab?: string; drawer_expanded?: string | boolean }>('/file-settings');
  } catch {
    fs = {};
  }
  const wantOpen = fs.drawer_open === true || fs.drawer_open === 'true';
  const wantExpanded = fs.drawer_expanded === true || fs.drawer_expanded === 'true';
  const savedTab = typeof fs.drawer_active_tab === 'string' && fs.drawer_active_tab !== ''
    ? fs.drawer_active_tab
    : 'commands-log';

  suspendSave = true;
  try {
    // Close the panel first so the subsequent open (or no-op close) lands in a
    // predictable state regardless of where we came from. Also collapse the
    // expand state before reapplying so we never leave a stale full-height
    // layout from the previous project.
    if (panelOpen) closePanel();
    setDrawerExpanded(false);

    // Rebuild tabs from the new project before choosing the active tab so we
    // can check whether the saved terminal:<id> still exists.
    await loadAndRenderTerminalTabs();

    const exists = savedTab === 'commands-log'
      || document.querySelector(`.drawer-tab[data-drawer-tab="${CSS.escape(savedTab)}"]`) !== null;
    activeTab = exists ? savedTab : 'commands-log';

    if (wantOpen) openPanel(); // this will honor the pre-set activeTab
    if (wantOpen && wantExpanded) setDrawerExpanded(true);
  } finally {
    suspendSave = false;
  }
}

export function showLogEntryById(logId: number) {
  if (!panelOpen) openPanel();
  // The drawer may currently be on a terminal tab — the user opted into "Show
  // log on completion" precisely to see the entry, so switch to commands-log
  // so it's actually visible (HS-6636).
  if (activeTab !== 'commands-log') switchDrawerTab('commands-log');
  // Wait for entries to load, then scroll to and expand the entry
  setTimeout(() => {
    const entry = document.querySelector<HTMLElement>(`.command-log-entry[data-id="${logId}"]`);
    if (entry !== null) {
      entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Auto-expand if not already
      if (!entry.classList.contains('expanded')) {
        entry.click();
      }
      // Highlight briefly
      entry.classList.add('selected');
      selectedLogIds.clear();
      selectedLogIds.add(logId);
    }
  }, 500);
}

function closePanel() {
  const panel = document.getElementById('command-log-panel')!;
  panel.style.display = 'none';
  panelOpen = false;
  // A collapsed drawer cannot be "expanded" in any meaningful sense — clear
  // the flag so reopening starts in the saved/default non-expanded layout
  // unless the user explicitly re-expands it.
  setDrawerExpanded(false);
  updateToggleIcon(false);
  stopPolling();
  dismissContextMenu();
  dismissFilterDropdown();
  void saveDrawerState();
}

function togglePanel() {
  if (panelOpen) {
    closePanel();
  } else {
    openPanel();
  }
}

// --- Polling ---

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (panelOpen) void loadEntries();
  }, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Badge ---

function updateBadge(hasNew: boolean) {
  const badge = document.getElementById('command-log-badge');
  if (!badge) return;
  badge.style.display = hasNew ? '' : 'none';
}

/** Refresh the unread count badge. Call after channel events. */
export async function refreshLogBadge() {
  if (panelOpen) return; // No badge when panel is open
  try {
    if (lastSeenId === 0) {
      // First load: set baseline without showing badge
      const entries = await api<LogEntry[]>('/command-log?limit=1');
      if (entries.length > 0) lastSeenId = entries[0].id;
      return;
    }
    // We approximate unread by total count vs. a stored count.
    // For simplicity, just show total count if there are new entries.
    const entries = await api<LogEntry[]>('/command-log?limit=1');
    if (entries.length > 0 && entries[0].id > lastSeenId) {
      updateBadge(true);
    }
  } catch { /* ignore */ }
}

// --- Resize handle ---

function initResize() {
  const handle = document.getElementById('command-log-resize')!;
  const panel = document.getElementById('command-log-panel')!;
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    startY = e.clientY;
    startHeight = panel.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = e.clientY - startY;
    const newHeight = Math.max(150, Math.min(600, startHeight - delta));
    panel.style.height = `${newHeight}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// --- Search debounce ---

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

function onSearchInput(value: string) {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentSearch = value;
    void loadEntries();
  }, 300);
}

// --- Clear log ---

async function clearLogEntries() {
  await api('/command-log', { method: 'DELETE' });
  selectedLogIds.clear();
  void loadEntries();
}


// --- Init ---

/** Initialize the command log panel. Call from app.tsx init(). */
export function initCommandLog() {
  // Button click — toggles drawer open/closed
  document.getElementById('command-log-btn')?.addEventListener('click', togglePanel);

  // HS-7983 — module-level subscription to the streaming-shell-output
  // event. Delegated to `applyShellPartialEvent` (exported for tests) so
  // the listener wire-up is one line and the DOM-mutation logic stays
  // unit-testable in happy-dom without bootstrapping the full drawer.
  window.addEventListener(SHELL_PARTIAL_OUTPUT_EVENT, (e: Event) => {
    applyShellPartialEvent((e as CustomEvent<ShellPartialOutputEvent>).detail);
  });

  // HS-6312: expand drawer to full height (hides ticket area).
  document.getElementById('drawer-expand-btn')?.addEventListener('click', toggleDrawerExpanded);

  // Clear button
  document.getElementById('command-log-clear')?.addEventListener('click', () => { void clearLogEntries(); });

  // Filter button (HS-2550)
  document.getElementById('command-log-filter-btn')?.addEventListener('click', () => { showFilterDropdown(() => renderEntries(currentEntries)); });

  // Search input
  const searchEl = document.getElementById('command-log-search') as HTMLInputElement | null;
  searchEl?.addEventListener('input', () => { onSearchInput(searchEl.value); });

  // Drawer tab switching — supports `commands-log` and dynamic `terminal:<id>` ids.
  document.getElementById('command-log-panel')?.addEventListener('click', (e) => {
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>('.drawer-tab');
    if (!tabEl) return;
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;  // close button handled by terminal module
    const t = tabEl.dataset.drawerTab;
    if (typeof t === 'string' && t !== '') switchDrawerTab(t);
  });

  // Resize handle
  initResize();

  // Initialize badge baseline
  void refreshLogBadge();

  // Drawer init must be sequential: visibility first (shows the terminal tabs
  // wrap container so subsequent renders land in a visible parent), then the
  // per-project drawer state (which spawns/teardowns terminal instances + picks
  // the active tab). Running these in parallel raced loadAndRenderTerminalTabs
  // calls against each other, sometimes leaving the tab strip empty (HS-6342).
  void (async () => {
    await applyTerminalTabVisibility();
    await applyPerProjectDrawerState();
  })();
}

/**
 * Show or hide the terminal tab strip. Gating is Tauri-only (HS-6437,
 * HS-6337) — there is no per-user toggle anymore, the feature is simply on
 * when the desktop app is running and off when a plain browser connects.
 * Exported so settings can refresh the terminal strip after the user edits
 * the configured list.
 */
export async function applyTerminalTabVisibility() {
  try {
    const enabled = getTauriInvoke() !== null;
    const tabsContainer = document.getElementById('drawer-terminal-tabs-wrap');
    if (tabsContainer) tabsContainer.style.display = enabled ? '' : 'none';
    // HS-6475: hide the divider alongside the terminal tab strip so it doesn't
    // dangle next to a lone Commands Log icon when terminals are unavailable.
    const divider = document.querySelector<HTMLElement>('.drawer-tabs-divider');
    if (divider) divider.style.display = enabled ? '' : 'none';
    if (!enabled && activeTab.startsWith('terminal:')) switchDrawerTab('commands-log');
    if (enabled) {
      const mod = await import('./terminal.js');
      await mod.loadAndRenderTerminalTabs();
    }
  } catch { /* ignore */ }
}
