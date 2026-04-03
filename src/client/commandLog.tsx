import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';

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

// --- Selection state (HS-2544) ---

const selectedLogIds = new Set<number>();
let lastClickedId: number | null = null;
let currentEntries: LogEntry[] = [];

// --- Multi-select filter (HS-2550) ---

const ALL_FILTER_TYPES = [
  { value: 'trigger', label: 'Triggers' },
  { value: 'done', label: 'Completions' },
  { value: 'permission_request', label: 'Permission Requests' },
  { value: 'permission_response', label: 'Permission Responses' },
  { value: 'custom_command', label: 'Custom Commands' },
  { value: 'shell_command', label: 'Shell Commands' },
  { value: 'error', label: 'Errors' },
];

const activeFilterTypes = new Set<string>(ALL_FILTER_TYPES.map(t => t.value));
let filterDropdownOpen = false;

function getFilterLabel(): string {
  if (activeFilterTypes.size === ALL_FILTER_TYPES.length) return 'All types';
  if (activeFilterTypes.size === 0) return 'None';
  if (activeFilterTypes.size === 1) {
    const val = [...activeFilterTypes][0];
    return ALL_FILTER_TYPES.find(t => t.value === val)?.label ?? val;
  }
  return `${activeFilterTypes.size} types`;
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
    case 'permission_response': return '#a855f7';
    case 'custom_command': return '#14b8a6';
    case 'shell_command': return '#6b7280';
    case 'shell_output': return '#6b7280';
    case 'error': return '#ef4444';
    default: return '#6b7280';
  }
}

function typeBadgeLabel(eventType: string): string {
  switch (eventType) {
    case 'trigger': return 'trigger';
    case 'done': return 'done';
    case 'permission_request': return 'permission';
    case 'permission_response': return 'response';
    case 'custom_command': return 'command';
    case 'shell_command': return 'shell';
    case 'shell_output': return 'output';
    case 'error': return 'error';
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
  const menu = toElement(
    <div className="command-log-context-menu" style={`left:${x}px;top:${y}px`}>
      <div className="context-menu-item" data-action="copy">
        {raw('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>')}
        Copy{entries.length > 1 ? ` (${entries.length} entries)` : ''}
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

function renderEntries(entries: LogEntry[]) {
  currentEntries = entries;
  const container = document.getElementById('command-log-entries');
  if (!container) return;

  // Build new content in a fragment first, only clear container on success
  const fragment = document.createDocumentFragment();

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

  for (const entry of filtered) {
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
        // Immediately replace stop button with "Canceling..." label
        stopBtn.replaceWith(toElement(<span className="command-log-canceling">{'Canceling\u2026'}</span>));
      });
    }

    // Click: selection + expand/collapse (HS-2544)
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // Ignore clicks on stop button
      if (target.closest('.command-log-stop-btn')) return;

      if (e.metaKey || e.ctrlKey) {
        // Toggle individual selection
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
        // Range select
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

      // Normal click: select this entry, toggle expand
      selectedLogIds.clear();
      selectedLogIds.add(entry.id);
      lastClickedId = entry.id;
      updateSelectionClasses();

      if (hasMore) {
        el.classList.toggle('expanded');
        // For shell entries, handle the output detail expand separately
        const detailEls = el.querySelectorAll('.command-log-detail:not(.command-log-shell-input)');
        const fullEl = el.querySelector<HTMLElement>('.command-log-detail-full');
        if (el.classList.contains('expanded')) {
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

    fragment.appendChild(el);
  }

  // Replace content atomically — if anything above threw, the old content remains
  container.innerHTML = '';
  container.appendChild(fragment);
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

function openPanel() {
  const panel = document.getElementById('command-log-panel')!;
  panel.style.display = '';
  panelOpen = true;
  void loadEntries();
  startPolling();
  // Mark all as seen
  updateBadge(0);
}

function closePanel() {
  const panel = document.getElementById('command-log-panel')!;
  panel.style.display = 'none';
  panelOpen = false;
  stopPolling();
  dismissContextMenu();
  dismissFilterDropdown();
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

function updateBadge(count: number) {
  const badge = document.getElementById('command-log-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count > 99 ? '99+' : count);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/** Refresh the unread count badge. Call after channel events. */
export async function refreshLogBadge() {
  if (panelOpen) return; // No badge when panel is open
  try {
    const { count } = await api<{ count: number }>('/command-log/count');
    // Count entries newer than last seen
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
      // Count how many are new
      updateBadge(count);
    }
  } catch { /* ignore */ }
}

// --- Resize handle ---

function initResize() {
  const handle = document.getElementById('command-log-resize')!;
  const panel = document.getElementById('command-log-panel')!;
  let isResizing = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newHeight = Math.max(150, Math.min(600, window.innerHeight - e.clientY));
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

// --- Filter dropdown (HS-2550) ---

function dismissFilterDropdown() {
  filterDropdownOpen = false;
  document.querySelector('.command-log-filter-dropdown')?.remove();
  document.getElementById('command-log-filter-btn')?.classList.remove('active');
}

function updateFilterButtonLabel() {
  const btn = document.getElementById('command-log-filter-btn');
  if (!btn) return;
  const labelSpan = btn.querySelector('span');
  if (labelSpan) labelSpan.textContent = getFilterLabel();
}

function showFilterDropdown() {
  const btn = document.getElementById('command-log-filter-btn');
  if (!btn) return;

  if (filterDropdownOpen) {
    dismissFilterDropdown();
    return;
  }

  filterDropdownOpen = true;
  btn.classList.add('active');

  const dropdown = toElement(
    <div className="command-log-filter-dropdown">
      {raw(ALL_FILTER_TYPES.map(t => `
        <div class="filter-option" data-type="${t.value}">
          <span class="filter-check">${activeFilterTypes.has(t.value) ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>
          <span>${t.label}</span>
        </div>
      `).join(''))}
      <div class="filter-separator"></div>
      <div class="filter-toggle-all"></div>
    </div>
  );

  // Set toggle text
  const toggleEl = dropdown.querySelector('.filter-toggle-all') as HTMLElement;
  const allSelected = activeFilterTypes.size === ALL_FILTER_TYPES.length;
  toggleEl.textContent = allSelected ? 'Deselect All' : 'Select All';

  // Bind option clicks
  for (const opt of dropdown.querySelectorAll('.filter-option')) {
    opt.addEventListener('click', () => {
      const type = (opt as HTMLElement).dataset.type!;
      const check = opt.querySelector('.filter-check') as HTMLElement;
      if (activeFilterTypes.has(type)) {
        activeFilterTypes.delete(type);
        check.innerHTML = '';
      } else {
        activeFilterTypes.add(type);
        check.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      }
      // Update toggle label
      const nowAll = activeFilterTypes.size === ALL_FILTER_TYPES.length;
      toggleEl.textContent = nowAll ? 'Deselect All' : 'Select All';
      updateFilterButtonLabel();
      // Re-render with current entries (client-side filter)
      renderEntries(currentEntries);
    });
  }

  // Toggle all / deselect all
  toggleEl.addEventListener('click', () => {
    const nowAll = activeFilterTypes.size === ALL_FILTER_TYPES.length;
    if (nowAll) {
      activeFilterTypes.clear();
    } else {
      for (const t of ALL_FILTER_TYPES) activeFilterTypes.add(t.value);
    }
    // Update checkmarks
    for (const opt of dropdown.querySelectorAll('.filter-option')) {
      const type = (opt as HTMLElement).dataset.type!;
      const check = opt.querySelector('.filter-check') as HTMLElement;
      check.innerHTML = activeFilterTypes.has(type) ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
    }
    toggleEl.textContent = activeFilterTypes.size === ALL_FILTER_TYPES.length ? 'Deselect All' : 'Select All';
    updateFilterButtonLabel();
    renderEntries(currentEntries);
  });

  // Position below button
  const rect = btn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(dropdown);

  // Clamp to viewport
  const dRect = dropdown.getBoundingClientRect();
  if (dRect.right > window.innerWidth) dropdown.style.left = `${window.innerWidth - dRect.width - 4}px`;
  if (dRect.bottom > window.innerHeight) dropdown.style.top = `${rect.top - dRect.height - 4}px`;

  // Close on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) {
        dismissFilterDropdown();
        document.removeEventListener('click', close, true);
      }
    };
    document.addEventListener('click', close, true);
  }, 0);
}

// --- Init ---

/** Initialize the command log panel. Call from app.tsx init(). */
export function initCommandLog() {
  // Button click
  document.getElementById('command-log-btn')?.addEventListener('click', togglePanel);

  // Close button
  document.getElementById('command-log-close')?.addEventListener('click', closePanel);

  // Clear button
  document.getElementById('command-log-clear')?.addEventListener('click', () => { void clearLogEntries(); });

  // Filter button (HS-2550)
  document.getElementById('command-log-filter-btn')?.addEventListener('click', () => { showFilterDropdown(); });

  // Search input
  const searchEl = document.getElementById('command-log-search') as HTMLInputElement | null;
  searchEl?.addEventListener('input', () => { onSearchInput(searchEl.value); });

  // Resize handle
  initResize();

  // Initialize badge baseline
  void refreshLogBadge();
}
