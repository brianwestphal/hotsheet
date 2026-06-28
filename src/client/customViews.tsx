import { clearLocalSettingOverride, getLayeredFileSettings, updateFileSettingsLayer, updateTicket } from '../api/index.js';
import { type ArrayDelta, isArrayDelta } from '../settingsDelta.js';
import { suppressAnimation } from './animate.js';
import {
  addLocalView,
  addSharedView,
  deleteLocalView,
  editView,
  hideSharedView,
  isSharedView as isSharedViewIn,
  moveViewToLocal,
  moveViewToShared,
  reorderViews,
  resolveViews,
  unhideSharedView,
  type ViewLayers,
} from './customViewsLayers.js';
import { displayTag, hasTag, normalizeTag, parseTags } from './detail.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { ICON_ARROW_DOWN, ICON_ARROW_UP, ICON_EYE, ICON_EYE_OFF, ICON_INFO, ICON_PENCIL, ICON_TAG, ICON_TRASH_SIMPLE } from './icons.js';
import { refreshSidebarCounts } from './sidebarCounts.js';
import type { CustomView, CustomViewCondition } from './state.js';
import { allKnownTags, refreshAllKnownTags, state } from './state.js';
import { draggedTicketIds } from './ticketList.js';
import { showToast } from './toast.js';
import { BLUR_DEBOUNCE_MS } from './uiTimings.js';

// HS-9092 (docs/107) — the shared/local layer pair for `custom_views`. The
// sidebar surface has no scope-mode toggle; each action targets a specific layer
// (add → local; edit → the view's own layer; hide-shared → local hidden), via
// the pure helpers in `customViewsLayers.ts`. `state.customViews` stays the
// RESOLVED (effective) list that the ticket filters read.
let viewLayers: ViewLayers = { shared: [], delta: {} };

/** Coerce a layered `custom_views` value into a flat view array. */
function asViewArray(v: unknown): CustomView[] {
  if (Array.isArray(v)) return v as CustomView[];
  if (typeof v === 'string' && v !== '') {
    try { const p: unknown = JSON.parse(v); if (Array.isArray(p)) return p as CustomView[]; } catch { /* not JSON */ }
  }
  return [];
}

/**
 * HS-9092 — write the layers that changed back to their files: the shared array
 * to `settings.json` only when it actually changed (so a local-only action never
 * touches the committed file), and the local delta to `settings.local.json`
 * (clearing the key when the delta is empty so an empty `{}` can't blank views).
 * Updates `state.customViews` (resolved) + re-renders the sidebar.
 */
async function persistViews(next: ViewLayers): Promise<void> {
  const sharedChanged = JSON.stringify(next.shared) !== JSON.stringify(viewLayers.shared);
  const deltaChanged = JSON.stringify(next.delta) !== JSON.stringify(viewLayers.delta);
  viewLayers = next;
  state.customViews = resolveViews(next);
  renderSidebarViews();
  renderViewsTab(); // HS-9093 — keep the Settings "Views" tab in sync if it's open
  if (sharedChanged) await updateFileSettingsLayer('shared', { custom_views: next.shared });
  if (deltaChanged) {
    if (Object.keys(next.delta).length === 0) await clearLocalSettingOverride(['custom_views']);
    else await updateFileSettingsLayer('local', { custom_views: next.delta });
  }
}

// HS-8102 — typed `(() => void) | null` (was `() => void` with no `| undefined`).
// Pre-fix the type lied: the variable was implicitly undefined until
// `initCustomViews` ran at app boot, but every call site invoked it without
// null-checking. Any reorder that fired a call site before init would have
// crashed with `loadTicketsFn is not a function` while TypeScript happily
// green-lit the code. Matches the `settingsLoader.tsx::_restoreTicketList`
// pattern.
let loadTicketsFn: (() => void) | null = null;
let draggedViewIndex: number | null = null;

export function initCustomViews(loadTickets: () => void) {
  loadTicketsFn = loadTickets;
  void refreshAllKnownTags();
  byId('add-custom-view-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    showViewEditor();
  });
}

export async function loadCustomViews() {
  try {
    // HS-9092 — load the shared array + local delta separately so the sidebar
    // can show origin badges + route each action to the right layer.
    const layered = await getLayeredFileSettings();
    const shared = asViewArray(layered.shared.custom_views);
    const localVal = layered.local.custom_views;
    const delta: ArrayDelta<CustomView> = isArrayDelta(localVal) ? (localVal as ArrayDelta<CustomView>) : {};
    viewLayers = { shared, delta };
    state.customViews = resolveViews(viewLayers);
  } catch { /* use empty */ }
  renderSidebarViews();
}

/** Whether the view with `id` lives in the shared (committed) layer. */
function isSharedView(id: string): boolean {
  return isSharedViewIn(viewLayers, id);
}

export function renderSidebarViews() {
  const container = byIdOrNull('custom-views-container');
  if (!container) return;
  container.innerHTML = '';

  if (state.customViews.length === 0) return;

  // Add a separator before custom views
  container.appendChild(toElement(<div className="sidebar-divider"></div>));

  // HS-9122 — the sidebar no longer shows shared/local origin badges on custom
  // views (noise; the Shared/Local distinction is managed on the Views settings
  // tab). The layer info still drives the context-menu actions below.
  for (let i = 0; i < state.customViews.length; i++) {
    const view = state.customViews[i];
    const btn = toElement(
      <button
        className={`sidebar-item sidebar-custom-view${state.view === `custom:${view.id}` ? ' active' : ''}`}
        data-view={`custom:${view.id}`}
        data-cv-index={String(i)}
        draggable="true"
      >
        {view.tag !== undefined && view.tag !== '' ? <span className="sidebar-view-tag-icon">{ICON_TAG}</span> : null}
        <span className="sidebar-view-name">{view.name}</span>
      </button>
    );
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      state.view = `custom:${view.id}`;
      state.selectedIds.clear();
      suppressAnimation();
      loadTicketsFn?.();
    });
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      showViewEditor(view);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showViewContextMenu(btn, view);
    });

    // Drag-and-drop reordering
    btn.addEventListener('dragstart', (e) => {
      draggedViewIndex = i;
      e.dataTransfer!.setData('text/plain', String(i));
      e.dataTransfer!.effectAllowed = 'move';
      setTimeout(() => btn.classList.add('dragging'), 0);
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      draggedViewIndex = null;
    });
    btn.addEventListener('dragover', (e) => {
      // Allow both view reordering and ticket drop-to-tag
      if (draggedViewIndex === null && !(view.tag !== undefined && view.tag !== '' && draggedTicketIds.length > 0)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      btn.classList.add('drop-target');
    });
    btn.addEventListener('dragleave', () => { btn.classList.remove('drop-target'); });
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drop-target');

      // Handle ticket drop-to-tag: add the view's tag to dropped tickets
      if (view.tag !== undefined && view.tag !== '' && draggedTicketIds.length > 0 && draggedViewIndex === null) {
        void addTagToTickets(view.tag, draggedTicketIds);
        return;
      }

      // Handle view reordering. HS-9092 — reorder is per-layer (the local layer
      // can't reorder shared views); `reorderViews` no-ops a cross-layer drag.
      if (draggedViewIndex === null || draggedViewIndex === i) return;
      const fromId = state.customViews[draggedViewIndex].id;
      draggedViewIndex = null;
      void persistViews(reorderViews(viewLayers, fromId, view.id));
    });

    container.appendChild(btn);
  }
  // HS-8511 — newly (re)rendered custom-view rows need their count badges; the
  // built-in rows keep theirs across this rebuild (this only touches
  // #custom-views-container).
  refreshSidebarCounts();
}

function showViewContextMenu(anchor: HTMLElement, view: CustomView) {
  closeAllMenus();
  // HS-9092 — a SHARED view can be "hidden on this machine" (local hidden delta,
  // non-destructive + undo); a LOCAL view is truly deleted (drops the local
  // addition). Deleting a shared view from the sidebar would edit the committed
  // file — that promote/demote lives in the Settings "Views" tab (HS-9093).
  const shared = isSharedView(view.id);
  const menu = createDropdown(anchor, [
    { label: 'Edit', key: 'e', icon: ICON_PENCIL, action: () => showViewEditor(view) },
    shared
      ? { label: 'Hide on this machine', key: 'h', icon: ICON_EYE_OFF, action: () => { void hideView(view); } }
      : { label: 'Delete', key: 'd', icon: ICON_TRASH_SIMPLE, action: () => { void deleteView(view.id); } },
  ]);
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

/** If the deleted/hidden view is the active one, fall back to the "all" view. */
function resetViewIfActive(id: string) {
  if (state.view !== `custom:${id}`) return;
  state.view = 'all';
  document.querySelectorAll('.sidebar-item').forEach(i => {
    i.classList.toggle('active', (i as HTMLElement).dataset.view === 'all');
  });
  loadTicketsFn?.();
}

/** HS-9092 — delete a LOCAL view (drops it from the local `added` delta). */
async function deleteView(id: string) {
  resetViewIfActive(id);
  await persistViews(deleteLocalView(viewLayers, id));
}

/** HS-9092 — hide a SHARED view on this machine (local `hidden` delta), with an
 *  undo toast that restores it (`unhideSharedView`). */
async function hideView(view: CustomView) {
  resetViewIfActive(view.id);
  await persistViews(hideSharedView(viewLayers, view.id));
  showToast(`Hid "${view.name}" on this machine.`, {
    durationMs: 7000,
    action: { label: 'Undo', onClick: () => { void persistViews(unhideSharedView(viewLayers, view.id)); } },
  });
}

// --- HS-9093 — Settings "Views" management tab ---

/** Bind the Views tab's add buttons + initial render (called once at dialog bind). */
export function bindViewsTab() {
  byIdOrNull('settings-views-add-local-btn')?.addEventListener('click', () => showViewEditor(undefined, { addLayer: 'local' }));
  byIdOrNull('settings-views-add-shared-btn')?.addEventListener('click', () => showViewEditor(undefined, { addLayer: 'shared' }));
  byId('settings-btn').addEventListener('click', () => { renderViewsTab(); });
}

/** One management row in the Views tab. `hidden` only applies to shared views. */
function renderViewsTabRow(view: CustomView, layer: 'shared' | 'local', hidden: boolean): HTMLElement {
  const row = toElement(
    <div className={`settings-view-row${hidden ? ' settings-view-hidden' : ''}`}>
      <span className={`cv-layer-badge ${layer === 'shared' ? 'cv-layer-shared' : 'cv-layer-local'}`}>{layer === 'shared' ? 'Shared' : 'Local'}</span>
      <span className="settings-view-name">{view.name}{hidden ? ' (hidden here)' : ''}</span>
      <div className="settings-view-actions"></div>
    </div>
  );
  const actions = row.querySelector('.settings-view-actions')!;
  const addBtn = (label: string, icon: typeof ICON_PENCIL, title: string, onClick: () => void) => {
    const b = toElement(<button className="cmd-outline-edit-btn" title={title}>{icon}</button>);
    void label;
    b.addEventListener('click', onClick);
    actions.appendChild(b);
  };

  addBtn('Edit', ICON_PENCIL, 'Edit', () => showViewEditor(view));
  if (layer === 'shared') {
    if (hidden) {
      addBtn('Unhide', ICON_EYE, 'Unhide on this machine', () => { void persistViews(unhideSharedView(viewLayers, view.id)); });
    } else {
      addBtn('Hide', ICON_EYE_OFF, 'Hide on this machine', () => { void hideView(view); });
    }
    addBtn('Move to Local', ICON_ARROW_DOWN, 'Move to Local (this machine only)', () => { void persistViews(moveViewToLocal(viewLayers, view.id)); });
  } else {
    addBtn('Move to Shared', ICON_ARROW_UP, 'Move to Shared (commit for the team)', () => { void persistViews(moveViewToShared(viewLayers, view.id)); });
    const del = toElement(<button className="cmd-outline-delete-btn" title="Delete">{ICON_TRASH_SIMPLE}</button>);
    del.addEventListener('click', () => { void deleteView(view.id); });
    actions.appendChild(del);
  }
  return row;
}

/** Render the Views tab list: every shared view (kept + hidden) then every local
 *  addition, each with layer-appropriate actions. No-op when the panel is absent. */
function renderViewsTab() {
  const list = byIdOrNull('settings-views-list');
  if (!list) return;
  const hiddenSet = new Set(viewLayers.delta.hidden ?? []);
  const localViews = viewLayers.delta.added ?? [];
  const rows: HTMLElement[] = [];
  for (const v of viewLayers.shared) rows.push(renderViewsTabRow(v, 'shared', hiddenSet.has(v.id)));
  for (const v of localViews) rows.push(renderViewsTabRow(v, 'local', false));
  if (rows.length === 0) {
    list.replaceChildren(toElement(<div className="settings-view-empty">No custom views yet. Add one above, or with the + next to “Views” in the sidebar.</div>));
    return;
  }
  list.replaceChildren(...rows);
}

/** Add a tag to one or more tickets (used by drop-to-tag). */
async function addTagToTickets(tag: string, ticketIds: number[]) {
  const normalized = normalizeTag(tag);
  if (!normalized) return;
  for (const id of ticketIds) {
    const ticket = state.tickets.find(t => t.id === id);
    if (!ticket) continue;
    const current = parseTags(ticket.tags);
    if (hasTag(current, normalized)) continue;
    const updated = [...current, normalized];
    await updateTicket(id, { tags: JSON.stringify(updated) });
    ticket.tags = JSON.stringify(updated);
  }
  if (!hasTag(allKnownTags, normalized)) allKnownTags.push(normalized);
  loadTicketsFn?.();
}

// --- Field/operator configuration ---

type FieldDef = { value: CustomViewCondition['field']; label: string; type: 'select' | 'ordinal' | 'text' | 'boolean' };

const FIELDS: FieldDef[] = [
  { value: 'category', label: 'Category', type: 'select' },
  { value: 'priority', label: 'Priority', type: 'ordinal' },
  { value: 'status', label: 'Status', type: 'ordinal' },
  { value: 'title', label: 'Title', type: 'text' },
  { value: 'details', label: 'Details', type: 'text' },
  { value: 'up_next', label: 'Up Next', type: 'boolean' },
  { value: 'tags', label: 'Tags', type: 'text' },
];

function getOperators(fieldType: string): { value: CustomViewCondition['operator']; label: string }[] {
  if (fieldType === 'ordinal') return [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '\u2260' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '\u2264' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '\u2265' },
  ];
  if (fieldType === 'select') return [
    { value: 'equals', label: 'is' },
    { value: 'not_equals', label: 'is not' },
  ];
  if (fieldType === 'boolean') return [
    { value: 'equals', label: 'is' },
  ];
  return [
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
  ];
}

const PRIORITY_OPTIONS = ['highest', 'high', 'default', 'low', 'lowest'];
const STATUS_OPTIONS = ['not_started', 'started', 'completed', 'verified', 'backlog', 'archive'];

function getValueOptions(field: string): string[] | null {
  if (field === 'category') return state.categories.map(c => c.id);
  if (field === 'priority') return PRIORITY_OPTIONS;
  if (field === 'status') return STATUS_OPTIONS;
  if (field === 'up_next') return ['true', 'false'];
  return null;
}

function getValueLabel(field: string, value: string): string {
  if (field === 'category') {
    const cat = state.categories.find(c => c.id === value);
    return cat?.label ?? value;
  }
  if (field === 'status') return value.replace(/_/g, ' ');
  if (field === 'up_next') return value === 'true' ? 'Yes' : 'No';
  return value;
}

// --- Tag autocomplete helper ---

function setupTagAutocomplete(input: HTMLInputElement, dropdown: HTMLElement, onSelect: (value: string) => void) {
  let acIndex = -1;

  // Use fixed positioning to escape overflow:auto parents
  dropdown.style.position = 'fixed';

  function showAc() {
    const query = input.value.trim().toLowerCase();
    dropdown.innerHTML = '';
    acIndex = -1;
    const matches = query
      ? allKnownTags.filter(t => t.toLowerCase().includes(query))
      : allKnownTags.slice(0, 100);
    if (matches.length === 0) { dropdown.style.display = 'none'; return; }
    for (const tag of matches) {
      const item = toElement(<div className="tag-autocomplete-item" data-tag={tag}>{displayTag(tag)}</div>);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = tag;
        onSelect(tag);
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(item);
    }
    // Position as fixed relative to the input
    const rect = input.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.width = `${rect.width}px`;
    dropdown.style.display = 'block';
  }

  input.addEventListener('input', showAc);
  input.addEventListener('focus', showAc);
  input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, BLUR_DEBOUNCE_MS); });
  input.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.tag-autocomplete-item');
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acIndex = Math.min(acIndex + 1, items.length - 1);
      items.forEach((el, j) => el.classList.toggle('active', j === acIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acIndex = Math.max(acIndex - 1, 0);
      items.forEach((el, j) => el.classList.toggle('active', j === acIndex));
    } else if (e.key === 'Enter' && acIndex >= 0) {
      e.preventDefault();
      const selected = (items[acIndex] as HTMLElement).dataset.tag ?? items[acIndex].textContent;
      input.value = selected;
      onSelect(selected);
      dropdown.style.display = 'none';
    }
  });
}

// --- View editor dialog ---

function showViewEditor(existing?: CustomView, opts: { addLayer?: 'local' | 'shared' } = {}) {
  const isEdit = !!existing;
  const addLayer = opts.addLayer ?? 'local';
  const conditions: CustomViewCondition[] = existing ? existing.conditions.map(c => ({ ...c })) : [];
  let logic: 'all' | 'any' = existing?.logic ?? 'all';
  let name = existing?.name ?? '';
  let tag = existing?.tag ?? '';
  let includeArchived = existing?.includeArchived ?? false;

  void refreshAllKnownTags();

  const overlay = toElement(
    <div className="custom-view-editor-overlay">
      <div className="custom-view-editor">
        <div className="custom-view-editor-header">
          <span>{isEdit ? 'Edit Custom View' : 'New Custom View'}</span>
          <button className="detail-close" id="cv-editor-close">{'\u00d7'}</button>
        </div>
        <div className="custom-view-editor-body">
          <div className="settings-field">
            <label>Name</label>
            <input type="text" id="cv-name" value={name} placeholder="View name..." />
          </div>
          <div className="settings-field cv-tag-field">
            <label>
              Tag <span className="cv-tag-info" id="cv-tag-info-btn">{ICON_INFO}</span>
            </label>
            <div className="cv-tag-help" id="cv-tag-help" style="display:none">
              Associate this view with a tag. The view will show a tag icon in the sidebar and you can drag tickets onto it to add the tag. Tickets with this tag are automatically included in the view.
            </div>
            <div className="cv-tag-input-wrapper">
              <input type="text" id="cv-tag" value={tag} placeholder="Optional tag..." autocomplete="off" />
              <div className="cv-tag-autocomplete" id="cv-tag-ac"></div>
            </div>
          </div>
          <div className="cv-logic-row">
            <label><input type="checkbox" id="cv-include-archived" checked={includeArchived} /> Include archived tickets</label>
          </div>
          <div className="cv-logic-row">
            <span>Match</span>
            <label><input type="radio" name="cv-logic" value="all" checked={logic === 'all'} /> All of</label>
            <label><input type="radio" name="cv-logic" value="any" checked={logic === 'any'} /> Any of</label>
          </div>
          <div id="cv-conditions"></div>
          <button className="btn btn-sm" id="cv-add-condition" style="margin-top:8px">+ Add Condition</button>
        </div>
        <div className="custom-view-editor-footer">
          <button className="btn btn-sm" id="cv-cancel">Cancel</button>
          <button className="btn btn-sm btn-accent" id="cv-save">Save</button>
        </div>
      </div>
    </div>
  );

  function renderConditions() {
    const container = overlay.querySelector('#cv-conditions')!;
    container.innerHTML = '';
    conditions.forEach((cond, i) => {
      const fieldDef = FIELDS.find(f => f.value === cond.field) || FIELDS[0];
      const operators = getOperators(fieldDef.type);
      const valueOpts = getValueOptions(cond.field);

      const row = toElement(
        <div className="cv-condition-row">
          <select className="cv-field-select">
            {FIELDS.map(f => <option value={f.value} selected={f.value === cond.field}>{f.label}</option>)}
          </select>
          <select className="cv-op-select">
            {operators.map(o => <option value={o.value} selected={o.value === cond.operator}>{o.label}</option>)}
          </select>
          {valueOpts
            ? <select className="cv-value-select">
                {valueOpts.map(v => <option value={v} selected={v === cond.value}>{getValueLabel(cond.field, v)}</option>)}
              </select>
            : <div className="cv-value-input-wrapper">
                <input type="text" className="cv-value-input" value={cond.value} placeholder="Value..." autocomplete="off" />
                {cond.field === 'tags' ? <div className="cv-tag-autocomplete cv-rule-tag-ac"></div> : null}
              </div>
          }
          <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
        </div>
      );

      const fieldSelect = row.querySelector('.cv-field-select') as HTMLSelectElement;
      const opSelect = row.querySelector('.cv-op-select') as HTMLSelectElement;
      const valueEl = (row.querySelector('.cv-value-select') || row.querySelector('.cv-value-input')) as HTMLSelectElement | HTMLInputElement;

      fieldSelect.addEventListener('change', () => {
        const newField = fieldSelect.value as CustomViewCondition['field'];
        const newFieldDef = FIELDS.find(f => f.value === newField)!;
        const newOps = getOperators(newFieldDef.type);
        conditions[i].field = newField;
        conditions[i].operator = newOps[0].value;
        const opts = getValueOptions(newField);
        conditions[i].value = opts ? opts[0] : '';
        renderConditions();
      });
      opSelect.addEventListener('change', () => { conditions[i].operator = opSelect.value as CustomViewCondition['operator']; });
      valueEl.addEventListener('change', () => { conditions[i].value = valueEl.value; });
      if (valueEl.tagName === 'INPUT') {
        valueEl.addEventListener('input', () => { conditions[i].value = valueEl.value; });
        // Autocomplete for tags field in rules editor
        const ruleTagAc = row.querySelector('.cv-rule-tag-ac');
        if (ruleTagAc) {
          setupTagAutocomplete(valueEl as HTMLInputElement, ruleTagAc as HTMLElement, (v) => { conditions[i].value = v; (valueEl as HTMLInputElement).value = v; });
        }
      }
      row.querySelector('.category-delete-btn')!.addEventListener('click', () => {
        conditions.splice(i, 1);
        renderConditions();
      });

      container.appendChild(row);
    });
  }

  renderConditions();
  document.body.appendChild(overlay);

  // Focus name input
  (overlay.querySelector('#cv-name') as HTMLInputElement).focus();

  // Tag info button toggle
  const tagHelp = overlay.querySelector('#cv-tag-help') as HTMLElement;
  overlay.querySelector('#cv-tag-info-btn')!.addEventListener('click', () => {
    tagHelp.style.display = tagHelp.style.display === 'none' ? '' : 'none';
  });

  // Tag autocomplete
  const tagInput = overlay.querySelector('#cv-tag') as HTMLInputElement;
  const tagAc = overlay.querySelector('#cv-tag-ac') as HTMLElement;
  setupTagAutocomplete(tagInput, tagAc, (v) => { tag = v; });

  // Include archived checkbox
  const archivedCheckbox = overlay.querySelector('#cv-include-archived') as HTMLInputElement;
  archivedCheckbox.addEventListener('change', () => { includeArchived = archivedCheckbox.checked; });

  // Logic radio
  overlay.querySelectorAll('input[name="cv-logic"]').forEach(r => {
    r.addEventListener('change', () => { logic = (r as HTMLInputElement).value as 'all' | 'any'; });
  });

  // Add condition
  overlay.querySelector('#cv-add-condition')!.addEventListener('click', () => {
    conditions.push({ field: 'category', operator: 'equals', value: state.categories[0]?.id || 'issue' });
    renderConditions();
  });

  // Close/cancel
  const close = () => overlay.remove();
  overlay.querySelector('#cv-editor-close')!.addEventListener('click', close);
  overlay.querySelector('#cv-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Save
  overlay.querySelector('#cv-save')!.addEventListener('click', async () => {
    name = (overlay.querySelector('#cv-name') as HTMLInputElement).value.trim();
    if (!name) { (overlay.querySelector('#cv-name') as HTMLInputElement).focus(); return; }
    tag = (overlay.querySelector('#cv-tag') as HTMLInputElement).value.trim();

    const view: CustomView = {
      id: existing?.id ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `view-${Date.now()}`),
      name,
      ...(tag !== '' ? { tag } : {}),
      ...(includeArchived ? { includeArchived } : {}),
      logic,
      conditions: conditions.filter(c => c.value !== ''),
    };

    // HS-9092/9093 — route by action: an EDIT writes the layer the view lives in
    // (shared view → the shared array; local view → its `added` entry); a NEW
    // view adds to `addLayer` (the sidebar "+" defaults to local; the Views tab
    // passes 'shared' for its "+ Add Shared" button).
    const next = isEdit
      ? editView(viewLayers, view)
      : (addLayer === 'shared' ? addSharedView(viewLayers, view) : addLocalView(viewLayers, view));
    await persistViews(next);
    // Select the new/edited view
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    state.view = `custom:${view.id}`;
    state.selectedIds.clear();
    renderSidebarViews();
    loadTicketsFn?.();
    close();
  });
}
