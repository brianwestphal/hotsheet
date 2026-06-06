import { createTicket } from '../api/index.js';
import { extractBracketTags, hasTag, syncDetailPanel } from './detail.js';
import { byIdOrNull, toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
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
      <input type="text" className="ticket-title-input draft-input" placeholder="New ticket..." value={draftTitle} spellCheck="true" />
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
    // Cmd/Ctrl + <category-shortcut-key> while typing the title — mirrors the
    // post-submit shortcut handled in `ticketRow.tsx`, so the user can pick
    // the type at the moment they're filling in the title without reaching
    // for the mouse. Skipped in category views (the badge is locked there to
    // match the click-to-change path above).
    if ((e.metaKey || e.ctrlKey) && !e.altKey
        && getCategoryShortcuts().some(s => s.key === e.key)
        && !state.view.startsWith('category:')) {
      e.preventDefault();
      const cat = getCategoryShortcuts().find(s => s.key === e.key)!;
      setDraftCategory(cat.value);
      syncDraftBadge(cat.value);
      callRenderTicketList();
      return;
    }
    if (e.key === 'Enter' && titleInput.value.trim()) {
      e.preventDefault();
      const rawTitle = titleInput.value.trim();
      const { title, tags } = extractBracketTags(rawTitle);
      if (!title && tags.length === 0) return;
      setDraftTitle('');
      titleInput.value = '';
      const defaults: Record<string, unknown> = getDefaultsFromView();
      if (draftCategory !== null && draftCategory !== '' && !state.view.startsWith('category:')) {
        defaults.category = draftCategory;
      }
      // Auto-tag from tag-associated custom view (HS-1590)
      if (state.view.startsWith('custom:')) {
        const viewId = state.view.slice(7);
        const view = state.customViews.find(v => v.id === viewId);
        const viewTag = view?.tag;
        if (viewTag !== undefined && viewTag !== '' && !hasTag(tags, viewTag)) {
          tags.push(viewTag);
        }
      }
      if (tags.length > 0) {
        defaults.tags = JSON.stringify(tags);
      }
      const created = await createTicket({ title: title || rawTitle, defaults });
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

/**
 * HS-8796 — the "New ticket…" draft row lives in a host element ABOVE the
 * batch (selected-ticket) toolbar (`#new-ticket-host`), not inside `#ticket-list`,
 * so it sits above the toolbar instead of below it. Populated for the default
 * list view; cleared for every other surface that takes over the inline content
 * area (trash/preview list variants, column view, the analytics dashboard) so no
 * stray input lingers. An existing draft row is preserved (keeps in-progress
 * text + focus across list re-renders). The fixed-position overlays (terminal
 * dashboard §25, cross-project stats §70) occlude the header and don't
 * participate, so they need no handling here.
 */
export function syncNewTicketHost(showDraft: boolean): void {
  const host = byIdOrNull('new-ticket-host');
  if (host === null) return;
  if (showDraft) {
    if (host.querySelector(':scope > .draft-row') === null) host.replaceChildren(createDraftRow());
  } else {
    host.replaceChildren();
  }
}

/** HS-8796 — clear the new-ticket host. Called by surfaces that take over the
 *  inline content area (column view + the analytics dashboard). */
export function clearNewTicketHost(): void {
  syncNewTicketHost(false);
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
  if (draftCategory !== null && draftCategory !== '') return draftCategory;
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
      // HS-8375 \u2014 the badge needs to repaint in place. Pre-HS-833 the
      // list re-render rebuilt the draft row every time, picking the new
      // category up via `getDraftCategory()` inside `createDraftRow`. After
      // the bindList refactor (HS-8332 onward) `ensureBindListMount` keeps
      // the draft row mount-once for the lifetime of the list view \u2014
      // calling `callRenderTicketList()` no longer touches the draft row
      // at all. Sync the badge directly so the user sees their selection
      // reflected. `callRenderTicketList()` is kept downstream so any
      // ticket-list dependencies on `draftCategory` (the auto-tag /
      // create-with-category path reads `draftCategory` on Enter) stay
      // consistent.
      syncDraftBadge(s.value);
      callRenderTicketList();
      callFocusDraftInput();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

/** HS-8375 - repaint the draft row's category badge in place. Used by the
 *  category-dropdown action so a type switch is visible without a list
 *  re-render. Exported for unit tests. No-op when no draft row is
 *  mounted (e.g. in column view where the draft row lives elsewhere). */
export function syncDraftBadge(category: string): void {
  const badge = document.querySelector<HTMLElement>('.draft-row .ticket-category-badge');
  if (badge === null) return;
  badge.style.backgroundColor = getCategoryColor(category);
  badge.textContent = getCategoryLabel(category);
}
