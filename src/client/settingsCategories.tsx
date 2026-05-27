import { getCategoryPresets, updateCategories } from '../api/index.js';
import { byId, toElement } from './dom.js';
import { delegate } from './reactive.js';
import { state } from './state.js';

/** Read the row index a delegated handler should act on. Each `.category-row`
 *  carries a `data-index` stamped at render time (HS-8614); the handler reads
 *  it off `closest('.category-row')` rather than closing over a per-row `i`
 *  that goes stale when the list is rebuilt. */
function rowIndex(el: Element): number {
  return Number(el.closest('.category-row')?.getAttribute('data-index') ?? -1);
}

let categorySyncTimeout: ReturnType<typeof setTimeout> | null = null;

/** Persist the current category list. `state.categories` is the closed
 *  `CategoryDef[]` interface; the typed caller's request type is the
 *  `.loose()` schema shape (carries an index signature). The spread-map
 *  produces fresh plain objects that satisfy that wire shape without a
 *  cast. */
function persistCategories(): Promise<unknown> {
  return updateCategories(state.categories.map(c => ({ ...c })));
}

export function renderCategoryList(_rebuildCategoryUI: () => void) {
  // HS-8614 — rows are pure markup now; the per-field `input` listeners and
  // the delete-button `click` are delegated once at the stable `#category-list`
  // container in `bindCategorySettings`, reading the row index from the
  // `data-index` attribute stamped here. Pre-fix this loop re-attached 6
  // closure-captured-index listeners per row on every rebuild (delete / edit /
  // settings-open). The `_rebuildCategoryUI` param is retained for the existing
  // call-site signature; the delegated handlers close over the instance passed
  // to `bindCategorySettings`.
  const container = byId('category-list');
  const rows: Element[] = [];

  for (let i = 0; i < state.categories.length; i++) {
    const cat = state.categories[i];
    rows.push(toElement(
      <div className="category-row" data-index={i}>
        <input type="color" className="category-color-input" value={cat.color} title="Color" />
        <input type="text" className="category-label-input" value={cat.label} placeholder="Label" title="Display name" />
        <input type="text" className="category-short-input" value={cat.shortLabel} placeholder="ABR" title="Short label (3 chars)" maxlength="4" />
        <input type="text" className="category-key-input" value={cat.shortcutKey} placeholder="k" title="Keyboard shortcut" maxlength="1" />
        <input type="text" className="category-desc-input" value={cat.description} placeholder="Description..." title="Description (for AI tools)" />
        <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
      </div>
    ));
  }

  container.replaceChildren(...rows);
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
    await persistCategories();
    rebuildCategoryUI();
  }, 500);
}

export function bindCategorySettings(rebuildCategoryUI: () => void) {
  // HS-8614 — delegate every per-row interaction once at the stable
  // `#category-list` container (page-lifetime; the settings dialog is
  // server-rendered into the page, not created per-open). The handlers read
  // the row index from the `data-index` attribute `renderCategoryList` stamps,
  // so a rebuild swaps the rows without touching listeners. Each handler is
  // page-lifetime so the disposer is intentionally discarded (kerf hard rule
  // #5 — root is attached once at startup, never torn down).
  const list = byId('category-list');
  const scheduleSync = () => { debouncedCategorySync(rebuildCategoryUI); };

  // These delegates are page-lifetime (root attached once at boot, never torn
  // down), so the disposer is intentionally discarded via `void` — the kerf
  // `require-delegate-disposer` opt-out for genuinely page-lifetime roots.
  void delegate<HTMLInputElement>(list, 'input', '.category-color-input', (_e, input) => {
    const i = rowIndex(input);
    if (i < 0) return;
    state.categories[i].color = input.value;
    scheduleSync();
  });
  void delegate<HTMLInputElement>(list, 'input', '.category-label-input', (_e, input) => {
    const i = rowIndex(input);
    if (i < 0) return;
    const cat = state.categories[i];
    cat.label = input.value;
    // Auto-generate ID from label for new categories.
    if (!cat.id || cat.id === '') {
      cat.id = input.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    }
    scheduleSync();
  });
  void delegate<HTMLInputElement>(list, 'input', '.category-short-input', (_e, input) => {
    const i = rowIndex(input);
    if (i < 0) return;
    state.categories[i].shortLabel = input.value.toUpperCase();
    scheduleSync();
  });
  void delegate<HTMLInputElement>(list, 'input', '.category-key-input', (_e, input) => {
    const i = rowIndex(input);
    if (i < 0) return;
    const key = input.value.toLowerCase().slice(0, 1);
    input.value = key;
    state.categories[i].shortcutKey = key;
    checkShortcutConflicts();
    scheduleSync();
  });
  void delegate<HTMLInputElement>(list, 'input', '.category-desc-input', (_e, input) => {
    const i = rowIndex(input);
    if (i < 0) return;
    state.categories[i].description = input.value;
    scheduleSync();
  });
  void delegate(list, 'click', '.category-delete-btn', (_e, btn) => {
    const i = rowIndex(btn);
    if (i < 0) return;
    state.categories.splice(i, 1);
    renderCategoryList(rebuildCategoryUI);
    debouncedCategorySync(rebuildCategoryUI);
  });

  // Add button
  byId('category-add-btn').addEventListener('click', () => {
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
  const presetSelect = byId<HTMLSelectElement>('category-preset-select');
  void getCategoryPresets().then(presets => {
    for (const p of presets) {
      presetSelect.appendChild(toElement(<option value={p.id}>{p.name}</option>));
    }
  });

  presetSelect.addEventListener('change', async () => {
    if (!presetSelect.value) return;
    const presets = await getCategoryPresets();
    const preset = presets.find(p => p.id === presetSelect.value);
    if (preset) {
      state.categories = [...preset.categories];
      await persistCategories();
      renderCategoryList(rebuildCategoryUI);
      rebuildCategoryUI();
    }
    presetSelect.value = '';
  });

  // Render initial list when settings dialog opens
  const settingsBtn = byId('settings-btn');
  settingsBtn.addEventListener('click', () => {
    renderCategoryList(rebuildCategoryUI);
  });
}
