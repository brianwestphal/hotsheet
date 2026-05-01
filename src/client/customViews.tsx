import { raw } from '../jsx-runtime.js';
import { suppressAnimation } from './animate.js';
import { api } from './api.js';
import { displayTag, hasTag, normalizeTag, parseTags } from './detail.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { ICON_INFO, ICON_PENCIL, ICON_TAG, ICON_TRASH_SIMPLE } from './icons.js';
import type { CustomView, CustomViewCondition } from './state.js';
import { allKnownTags, refreshAllKnownTags, state } from './state.js';
import { draggedTicketIds } from './ticketList.js';

let loadTicketsFn: () => void;
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
    const settings = await api<Record<string, string>>('/settings');
    if (settings.custom_views !== '') {
      const parsed: unknown = JSON.parse(settings.custom_views);
      if (Array.isArray(parsed)) state.customViews = parsed as typeof state.customViews;
    }
  } catch { /* use empty */ }
  renderSidebarViews();
}

export function renderSidebarViews() {
  const container = byIdOrNull('custom-views-container');
  if (!container) return;
  container.innerHTML = '';

  if (state.customViews.length === 0) return;

  // Add a separator before custom views
  container.appendChild(toElement(<div className="sidebar-divider"></div>));

  for (let i = 0; i < state.customViews.length; i++) {
    const view = state.customViews[i];
    const btn = toElement(
      <button
        className={`sidebar-item sidebar-custom-view${state.view === `custom:${view.id}` ? ' active' : ''}`}
        data-view={`custom:${view.id}`}
        data-cv-index={String(i)}
        draggable="true"
      >
        {view.tag !== undefined && view.tag !== '' ? <span className="sidebar-view-tag-icon">{raw(ICON_TAG)}</span> : null}
        {view.name}
      </button>
    );
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      state.view = `custom:${view.id}`;
      state.selectedIds.clear();
      suppressAnimation();
      loadTicketsFn();
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

      // Handle view reordering
      if (draggedViewIndex === null || draggedViewIndex === i) return;
      const [moved] = state.customViews.splice(draggedViewIndex, 1);
      state.customViews.splice(i, 0, moved);
      draggedViewIndex = null;
      void saveViews();
    });

    container.appendChild(btn);
  }
}

function showViewContextMenu(anchor: HTMLElement, view: CustomView) {
  closeAllMenus();
  const menu = createDropdown(anchor, [
    { label: 'Edit', key: 'e', icon: ICON_PENCIL, action: () => showViewEditor(view) },
    { label: 'Delete', key: 'd', icon: ICON_TRASH_SIMPLE, action: () => { void deleteView(view.id); } },
  ]);
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

async function saveViews() {
  await api('/settings', { method: 'PATCH', body: { custom_views: JSON.stringify(state.customViews) } });
  renderSidebarViews();
}

async function deleteView(id: string) {
  state.customViews = state.customViews.filter(v => v.id !== id);
  if (state.view === `custom:${id}`) {
    state.view = 'all';
    document.querySelectorAll('.sidebar-item').forEach(i => {
      i.classList.toggle('active', (i as HTMLElement).dataset.view === 'all');
    });
    loadTicketsFn();
  }
  await saveViews();
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
    await api(`/tickets/${id}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
    ticket.tags = JSON.stringify(updated);
  }
  if (!hasTag(allKnownTags, normalized)) allKnownTags.push(normalized);
  loadTicketsFn();
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
  input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 150); });
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

function showViewEditor(existing?: CustomView) {
  const isEdit = !!existing;
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
              Tag <span className="cv-tag-info" id="cv-tag-info-btn">{raw(ICON_INFO)}</span>
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

    if (isEdit) {
      const idx = state.customViews.findIndex(v => v.id === existing.id);
      if (idx >= 0) state.customViews[idx] = view;
      else state.customViews.push(view);
    } else {
      state.customViews.push(view);
    }

    await saveViews();
    // Select the new/edited view
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    state.view = `custom:${view.id}`;
    state.selectedIds.clear();
    renderSidebarViews();
    loadTicketsFn();
    close();
  });
}
