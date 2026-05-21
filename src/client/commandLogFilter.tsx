import { commandLogStore } from './commandLogStore.js';
import { byIdOrNull, toElement } from './dom.js';
import { ICON_CHECK } from './icons.js';

// --- Multi-select filter (HS-2550) ---
//
// HS-8318 / §61 Phase 3b — `activeFilterTypes` now reads from + writes
// through `commandLogStore.state.value.filter.types`. The dropdown UI's
// click handlers go through `commandLogStore.actions.setFilterTypes()`,
// which fires the `filteredEntriesSignal` and re-renders via bindList in
// `commandLog.tsx`. Pre-fix this file owned the mutable `Set<string>`
// directly and the caller (`commandLog.tsx::renderEntries`) re-read it
// every render.

export const ALL_FILTER_TYPES = [
  { value: 'trigger', label: 'Triggers' },
  { value: 'done', label: 'Completions' },
  { value: 'permission_request', label: 'Permissions' },
  { value: 'shell_command', label: 'Shell Commands' },
];

/** Read the live `Set<string>` of selected filter types from the store. */
function getActiveFilterTypes(): ReadonlySet<string> {
  return commandLogStore.state.value.filter.types;
}

let filterDropdownOpen = false;

export function getFilterLabel(): string {
  const active = getActiveFilterTypes();
  if (active.size === ALL_FILTER_TYPES.length) return 'All types';
  if (active.size === 0) return 'None';
  if (active.size === 1) {
    const val = [...active][0];
    return ALL_FILTER_TYPES.find(t => t.value === val)?.label ?? val;
  }
  return `${active.size} types`;
}

export function dismissFilterDropdown() {
  filterDropdownOpen = false;
  document.querySelector('.command-log-filter-dropdown')?.remove();
  byIdOrNull('command-log-filter-btn')?.classList.remove('active');
}

function updateFilterButtonLabel() {
  const btn = byIdOrNull('command-log-filter-btn');
  if (!btn) return;
  const labelSpan = btn.querySelector('span');
  if (labelSpan) labelSpan.textContent = getFilterLabel();
}

/** Show the filter type dropdown. Calls `onFilterChange` when the selection changes. */
export function showFilterDropdown(onFilterChange: () => void) {
  const btn = byIdOrNull('command-log-filter-btn');
  if (!btn) return;

  if (filterDropdownOpen) {
    dismissFilterDropdown();
    return;
  }

  filterDropdownOpen = true;
  btn.classList.add('active');

  const dropdown = toElement(
    <div className="command-log-filter-dropdown">
      {ALL_FILTER_TYPES.map(t =>
        <div className="filter-option" data-type={t.value}>
          <span className="filter-check">{getActiveFilterTypes().has(t.value) ? ICON_CHECK : ''}</span>
          <span>{t.label}</span>
        </div>
      )}
      <div className="filter-separator"></div>
      <div className="filter-toggle-all"></div>
    </div>
  );

  // Set toggle text
  const toggleEl = dropdown.querySelector('.filter-toggle-all') as HTMLElement;
  const allSelected = getActiveFilterTypes().size === ALL_FILTER_TYPES.length;
  toggleEl.textContent = allSelected ? 'Deselect All' : 'Select All';

  // Bind option clicks
  for (const opt of dropdown.querySelectorAll('.filter-option')) {
    opt.addEventListener('click', () => {
      const type = (opt as HTMLElement).dataset.type!;
      const check = opt.querySelector('.filter-check') as HTMLElement;
      const cur = getActiveFilterTypes();
      const next = new Set(cur);
      if (cur.has(type)) {
        next.delete(type);
        check.replaceChildren();
      } else {
        next.add(type);
        check.replaceChildren(toElement(ICON_CHECK));
      }
      commandLogStore.actions.setFilterTypes(next);
      // Update toggle label
      const nowAll = next.size === ALL_FILTER_TYPES.length;
      toggleEl.textContent = nowAll ? 'Deselect All' : 'Select All';
      updateFilterButtonLabel();
      onFilterChange();
    });
  }

  // Toggle all / deselect all
  toggleEl.addEventListener('click', () => {
    const nowAll = getActiveFilterTypes().size === ALL_FILTER_TYPES.length;
    const next = nowAll
      ? new Set<string>()
      : new Set<string>(ALL_FILTER_TYPES.map(t => t.value));
    commandLogStore.actions.setFilterTypes(next);
    // Update checkmarks
    for (const opt of dropdown.querySelectorAll('.filter-option')) {
      const type = (opt as HTMLElement).dataset.type!;
      const check = opt.querySelector('.filter-check') as HTMLElement;
      if (next.has(type)) check.replaceChildren(toElement(ICON_CHECK));
      else check.replaceChildren();
    }
    toggleEl.textContent = next.size === ALL_FILTER_TYPES.length ? 'Deselect All' : 'Select All';
    updateFilterButtonLabel();
    onFilterChange();
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
