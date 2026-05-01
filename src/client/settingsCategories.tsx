import { api } from './api.js';
import { toElement } from './dom.js';
import type { CategoryDef } from './state.js';
import { state } from './state.js';

let categorySyncTimeout: ReturnType<typeof setTimeout> | null = null;

export function renderCategoryList(rebuildCategoryUI: () => void) {
  const container = document.getElementById('category-list')!;
  container.innerHTML = '';

  for (let i = 0; i < state.categories.length; i++) {
    const cat = state.categories[i];
    const row = toElement(
      <div className="category-row">
        <input type="color" className="category-color-input" value={cat.color} title="Color" />
        <input type="text" className="category-label-input" value={cat.label} placeholder="Label" title="Display name" />
        <input type="text" className="category-short-input" value={cat.shortLabel} placeholder="ABR" title="Short label (3 chars)" maxlength="4" />
        <input type="text" className="category-key-input" value={cat.shortcutKey} placeholder="k" title="Keyboard shortcut" maxlength="1" />
        <input type="text" className="category-desc-input" value={cat.description} placeholder="Description..." title="Description (for AI tools)" />
        <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
      </div>
    );

    // HS-8088 — `querySelectorAll('input')` returns
    // `NodeListOf<HTMLInputElement>` which is iterable, so destructuring
    // works without the pre-fix `as unknown as HTMLInputElement[]` cast.
    const [colorInput, labelInput, shortInput, keyInput, descInput] = row.querySelectorAll('input');

    const scheduleSync = () => {
      debouncedCategorySync(rebuildCategoryUI);
    };

    colorInput.addEventListener('input', () => { state.categories[i].color = colorInput.value; scheduleSync(); });
    labelInput.addEventListener('input', () => {
      state.categories[i].label = labelInput.value;
      // Auto-generate ID from label for new categories
      if (!cat.id || cat.id === '') {
        state.categories[i].id = labelInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      }
      scheduleSync();
    });
    shortInput.addEventListener('input', () => { state.categories[i].shortLabel = shortInput.value.toUpperCase(); scheduleSync(); });
    keyInput.addEventListener('input', () => {
      const key = keyInput.value.toLowerCase().slice(0, 1);
      keyInput.value = key;
      state.categories[i].shortcutKey = key;
      checkShortcutConflicts();
      scheduleSync();
    });
    descInput.addEventListener('input', () => { state.categories[i].description = descInput.value; scheduleSync(); });

    row.querySelector('.category-delete-btn')!.addEventListener('click', () => {
      state.categories.splice(i, 1);
      renderCategoryList(rebuildCategoryUI);
      debouncedCategorySync(rebuildCategoryUI);
    });

    container.appendChild(row);
  }

  checkShortcutConflicts();
}

function checkShortcutConflicts() {
  const keyInputs = document.querySelectorAll('.category-key-input');
  const seen = new Map<string, number[]>();

  state.categories.forEach((cat, i) => {
    if (cat.shortcutKey) {
      const key = cat.shortcutKey.toLowerCase();
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(i);
    }
  });

  keyInputs.forEach((input, i) => {
    const key = state.categories[i]?.shortcutKey?.toLowerCase();
    if (key && seen.get(key)!.length > 1) {
      input.classList.add('category-key-conflict');
    } else {
      input.classList.remove('category-key-conflict');
    }
  });
}

function debouncedCategorySync(rebuildCategoryUI: () => void) {
  if (categorySyncTimeout) clearTimeout(categorySyncTimeout);
  categorySyncTimeout = setTimeout(async () => {
    await api('/categories', { method: 'PUT', body: state.categories });
    rebuildCategoryUI();
  }, 500);
}

export function bindCategorySettings(rebuildCategoryUI: () => void) {
  // Add button
  document.getElementById('category-add-btn')!.addEventListener('click', () => {
    state.categories.push({
      id: '',
      label: '',
      shortLabel: '',
      color: '#6b7280',
      shortcutKey: '',
      description: '',
    });
    renderCategoryList(rebuildCategoryUI);
    // Focus the label input of the new row
    const rows = document.querySelectorAll('.category-row');
    const last = rows[rows.length - 1];
    (last.querySelector('.category-label-input') as HTMLInputElement).focus();
  });

  // Preset selector
  const presetSelect = document.getElementById('category-preset-select') as HTMLSelectElement;
  void api<{ id: string; name: string }[]>('/category-presets').then(presets => {
    for (const p of presets) {
      presetSelect.appendChild(toElement(<option value={p.id}>{p.name}</option>));
    }
  });

  presetSelect.addEventListener('change', async () => {
    if (!presetSelect.value) return;
    const presets = await api<{ id: string; name: string; categories: CategoryDef[] }[]>('/category-presets');
    const preset = presets.find(p => p.id === presetSelect.value);
    if (preset) {
      state.categories = [...preset.categories];
      await api('/categories', { method: 'PUT', body: state.categories });
      renderCategoryList(rebuildCategoryUI);
      rebuildCategoryUI();
    }
    presetSelect.value = '';
  });

  // Render initial list when settings dialog opens
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => {
    renderCategoryList(rebuildCategoryUI);
  });
}
