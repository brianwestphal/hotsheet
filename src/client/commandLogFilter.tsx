import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { ICON_CHECK } from './icons.js';

// --- Multi-select filter (HS-2550) ---

export const ALL_FILTER_TYPES = [
  { value: 'trigger', label: 'Triggers' },
  { value: 'done', label: 'Completions' },
  { value: 'permission_request', label: 'Permissions' },
  { value: 'shell_command', label: 'Shell Commands' },
];

export const activeFilterTypes = new Set<string>(ALL_FILTER_TYPES.map(t => t.value));
let filterDropdownOpen = false;

export function getFilterLabel(): string {
  if (activeFilterTypes.size === ALL_FILTER_TYPES.length) return 'All types';
  if (activeFilterTypes.size === 0) return 'None';
  if (activeFilterTypes.size === 1) {
    const val = [...activeFilterTypes][0];
    return ALL_FILTER_TYPES.find(t => t.value === val)?.label ?? val;
  }
  return `${activeFilterTypes.size} types`;
}

export function dismissFilterDropdown() {
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

/** Show the filter type dropdown. Calls `onFilterChange` when the selection changes. */
export function showFilterDropdown(onFilterChange: () => void) {
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
      {ALL_FILTER_TYPES.map(t =>
        <div className="filter-option" data-type={t.value}>
          <span className="filter-check">{activeFilterTypes.has(t.value) ? raw(ICON_CHECK) : ''}</span>
          <span>{t.label}</span>
        </div>
      )}
      <div className="filter-separator"></div>
      <div className="filter-toggle-all"></div>
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
        check.innerHTML = ICON_CHECK;
      }
      // Update toggle label
      const nowAll = activeFilterTypes.size === ALL_FILTER_TYPES.length;
      toggleEl.textContent = nowAll ? 'Deselect All' : 'Select All';
      updateFilterButtonLabel();
      onFilterChange();
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
      check.innerHTML = activeFilterTypes.has(type) ? ICON_CHECK : '';
    }
    toggleEl.textContent = activeFilterTypes.size === ALL_FILTER_TYPES.length ? 'Deselect All' : 'Select All';
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
