import { api } from './api.js';
import { extractBracketTags, hasTag, syncDetailPanel } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import type { CustomView, Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, state } from './state.js';
import {
  callFocusDraftInput, callLoadTickets, callRenderTicketList,
  callUpdateColumnSelectionClasses, callUpdateSelectionClasses,
  draftCategory, draftTitle,   getCategoryShortcuts,
setDraftCategory, setDraftTitle,
} from './ticketListState.js';

// --- Draft row ---

export function createDraftRow(): HTMLElement {
  const draftCat = getDraftCategory();
  const inCategoryView = state.view.startsWith('category:');

  const row = toElement(
    <div className="ticket-row draft-row">
      <span className="ticket-checkbox-spacer"></span>
      <span className="ticket-status-btn draft-placeholder">{'\u25CB'}</span>
      <span
        className="ticket-category-badge draft-badge"
        style={`background-color:${getCategoryColor(draftCat)}${!inCategoryView ? ';cursor:pointer;opacity:1' : ''}`}
      >
        {getCategoryLabel(draftCat)}
      </span>
      <span className="ticket-number draft-number"></span>
      <input type="text" className="ticket-title-input draft-input" placeholder="New ticket..." value={draftTitle} />
      <span className="ticket-priority-indicator draft-placeholder"></span>
      <span className="ticket-star draft-placeholder"></span>
    </div>
  );

  if (!inCategoryView) {
    const catBadge = row.querySelector('.ticket-category-badge') as HTMLElement;
    catBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      showDraftCategoryMenu(catBadge);
    });
  }

  const titleInput = row.querySelector('.draft-input') as HTMLInputElement;
  titleInput.addEventListener('input', () => {
    setDraftTitle(titleInput.value);
  });
  // Clear ticket selection when focusing draft input so Delete/Backspace
  // can't accidentally delete a previously-selected ticket (HS-2113, HS-2179)
  titleInput.addEventListener('focus', () => {
    if (state.selectedIds.size > 0) {
      state.selectedIds.clear();
      callUpdateSelectionClasses();
      callUpdateColumnSelectionClasses();
      syncDetailPanel();
    }
  });
  titleInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && titleInput.value.trim()) {
      e.preventDefault();
      const rawTitle = titleInput.value.trim();
      const { title, tags } = extractBracketTags(rawTitle);
      if (!title && tags.length === 0) return;
      setDraftTitle('');
      titleInput.value = '';
      const defaults: Record<string, unknown> = getDefaultsFromView();
      if (draftCategory !== '' && !state.view.startsWith('category:')) {
        defaults.category = draftCategory;
      }
      // Auto-tag from tag-associated custom view (HS-1590)
      if (state.view.startsWith('custom:')) {
        const viewId = state.view.slice(7);
        const view = state.customViews.find(v => v.id === viewId);
        const viewTag = (view as CustomView & { tag?: string })?.tag;
        if (viewTag !== undefined && viewTag !== '' && !hasTag(tags, viewTag)) {
          tags.push(viewTag);
        }
      }
      if (tags.length > 0) {
        defaults.tags = JSON.stringify(tags);
      }
      const created = await api<Ticket>('/tickets', { method: 'POST', body: { title: title || rawTitle, defaults } });
      // Auto-select the newly created ticket (HS-202)
      state.selectedIds.clear();
      state.selectedIds.add(created.id);
      await callLoadTickets();
      callFocusDraftInput();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.tickets.length > 0) {
        const el = document.querySelector<HTMLElement>(`.ticket-row[data-id="${state.tickets[0].id}"] .ticket-title-input`);
        el?.focus();
      }
    }
  });

  return row;
}

export function focusDraftInput() {
  const input = document.querySelector<HTMLInputElement>('.draft-row .draft-input');
  input?.focus();
}

function getDefaultsFromView(): Record<string, unknown> {
  const view = state.view;
  if (view === 'up-next') return { up_next: true };
  if (view === 'open') return {};
  if (view === 'completed') return { status: 'completed' };
  if (view === 'backlog') return { status: 'backlog' };
  if (view === 'archive') return { status: 'archive' };
  if (view.startsWith('category:')) return { category: view.split(':')[1] };
  if (view.startsWith('priority:')) return { priority: view.split(':')[1] };
  return {};
}

function getDraftCategory(): string {
  if (draftCategory !== '') return draftCategory;
  const view = state.view;
  if (view.startsWith('category:')) return view.split(':')[1];
  return 'issue';
}

function showDraftCategoryMenu(anchor: HTMLElement) {
  closeAllMenus();
  const isMac = navigator.userAgent.includes('Mac');
  const mod = isMac ? '\u2318' : 'Ctrl+';
  const currentCat = getDraftCategory();
  const menu = createDropdown(anchor, getCategoryShortcuts().map(s => ({
    label: s.label,
    key: s.key,
    shortcut: `${mod}${s.key.toUpperCase()}`,
    color: getCategoryColor(s.value),
    active: currentCat === s.value,
    action: () => {
      setDraftCategory(s.value);
      callRenderTicketList();
      callFocusDraftInput();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}
