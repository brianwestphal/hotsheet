import type { SafeHtml } from 'kerfjs';
import { raw } from 'kerfjs';

import { duplicateTickets, getBackends, pushTicketToBackend, releaseTicket, updateTicket, uploadAttachment } from '../api/index.js';
import { isSystemStatusNote } from '../systemNotes.js';
import { claimForTicket } from './claimsStore.js';
import { toElement } from './dom.js';
import { buildFeedbackNav, getTicketFeedbackState, openFeedbackDialogForNote, suppressNextAutoShowFeedback } from './feedbackDialog.js';
import { ICON_ARCHIVE, ICON_CALENDAR, ICON_COPY, ICON_EXTERNAL_LINK, ICON_EYE, ICON_EYE_OFF, ICON_INBOX, ICON_STAR, ICON_STAR_FILLED, ICON_TAG, ICON_TRASH, ICON_X_CIRCLE } from './icons.js';
import { parseNotesJson } from './noteRenderer.js';
import { getPluginContextMenuItems } from './pluginUI.js';
import { openLatestNoteReader } from './readLatestNote.js';
import type { Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, state, STATUS_ITEMS, syncedTicketMap, VERIFIED_SVG } from './state.js';
import { openExternalUrl } from './tauriIntegration.js';
import { loadTickets, renderTicketList } from './ticketList.js';
import { hasPendingFeedback } from './ticketRow.js';
import { getTicketSignals } from './ticketsStore.js';
import { showToast } from './toast.js';
import { toggleReadState, trackedBatch, trackedDelete, trackedPatch } from './undo/actions.js';

const LUCIDE_14 = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '14',
  height: '14',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;

const MEGAPHONE_SVG: SafeHtml = <svg {...LUCIDE_14}><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>;

/** HS-8401 — Lucide `book-open-text` glyph for the Read Latest Note
 *  menu item. Same icon the §49 reader-overlay trigger uses on note
 *  rows + the Details label, so users learn one affordance for the
 *  reader entry-point. */
const BOOK_OPEN_TEXT_SVG: SafeHtml = <svg {...LUCIDE_14}><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/></svg>;

/** HS-8401 / HS-8415 — collect every non-empty note in display order plus
 *  the index of the most recent one. The Read Latest Note menu item opens
 *  the reader anchored on the latest non-empty note (HS-8401) and now also
 *  passes a `navigation` slot built from the full list so the user can
 *  chevron-up / ArrowUp back through earlier notes without re-opening the
 *  menu (HS-8415 — matches the per-note reader trigger in `noteRenderer`).
 *  Empty / whitespace-only notes are skipped so the reader can't surface
 *  the §49 "(empty)" placeholder. Returns `null` when no non-empty note
 *  exists. */

/**
 * HS-9552 — insert `node` at the menu's backlog-separator anchor.
 *
 * Both async sections below (push-to-backend, dispatch-to-worker) resolve AFTER the
 * menu is built, so they cannot simply append — they have to land above the
 * backlog/archive group. Anchored on the `.context-menu-separator-backlog` marker
 * class rather than a positional index: HS-8414 added a separator higher up the menu
 * and shifted `separators[1]`, which silently misplaced the Push items between Status
 * and Up Next. Falls back to appending if the anchor is gone.
 */
function insertAtBacklogAnchor(menu: HTMLElement, node: HTMLElement): void {
  const anchor = menu.querySelector<HTMLElement>('.context-menu-separator-backlog');
  if (anchor) menu.insertBefore(node, anchor);
  else menu.appendChild(node);
}

/**
 * HS-8339 — Provide Feedback, for a ticket whose most recent note is a FEEDBACK
 * NEEDED / IMMEDIATE FEEDBACK NEEDED prompt. Mirrors the inline link button in the
 * detail panel's notes list, so the dialog can be opened from the list without first
 * selecting the ticket and scrolling to the bottom of its notes.
 *
 * Single-selection only — the dialog targets one ticket. Deliberately adds NO
 * trailing separator: the megaphone icon already anchors the item visually, and the
 * separator count feeds the Push-to-backend insertion below.
 */
function addFeedbackItem(menu: HTMLElement, ticket: Ticket): void {
  if (state.selectedIds.size !== 1 || !hasPendingFeedback(ticket)) return;
  const notes = parseNotesJson(ticket.notes);
  const feedback = getTicketFeedbackState(notes);
  if (feedback === null) return;
  addActionItem(menu, 'Provide Feedback', () => {
    // HS-8603 — auto-load the saved draft for this note (if any) rather than opening
    // a blank form. HS-8836 — same prev/next context nav as the reader.
    const nav = feedback.noteId === '' ? undefined : buildFeedbackNav(
      { ticketNumber: ticket.ticket_number, ticketTitle: ticket.title, detailsMarkdown: ticket.details, notes },
      feedback.noteId,
    );
    void openFeedbackDialogForNote(ticket.id, ticket.ticket_number, feedback.prompt, feedback.noteId, nav);
  }, { icon: MEGAPHONE_SVG });
}

/**
 * HS-8401 — Read Latest Note, opening the §49 reader on the most recent note.
 * Single-selection only; the overlay targets one note at a time.
 *
 * Two refinements are load-bearing and easy to undo by accident:
 * - **HS-8841** — with no non-empty note it falls back to reading the Details and
 *   relabels to "Read Description", so the label matches what actually opens. It is
 *   disabled only when there is NEITHER a note nor a description.
 * - **HS-9526** — system/status notes (a claim-lease reclaim) are filtered out. They
 *   are bookkeeping, not content: surfacing one as "the latest note" would read the
 *   user a line about lease state instead of the note they wanted.
 *
 * The open itself goes through `openLatestNoteReader` so this item and the spacebar
 * shortcut cannot diverge (HS-8830), and the nav list is the combined
 * [Details, ...notes] one so the chevrons reach the Details too (HS-8415 / HS-8598).
 */
function addReadNoteItem(menu: HTMLElement, ticket: Ticket): void {
  if (state.selectedIds.size !== 1) return;
  const parsedNotes = parseNotesJson(ticket.notes);
  const nonEmptyNotes = parsedNotes.filter((n) => n.text.trim() !== '' && !isSystemStatusNote(n.text));
  const latestNote = nonEmptyNotes.length > 0 ? nonEmptyNotes[nonEmptyNotes.length - 1] : null;
  const hasDescription = ticket.details.trim() !== '';
  const readTarget: 'note' | 'details' | null =
    latestNote !== null ? 'note' : (hasDescription ? 'details' : null);
  const label = readTarget === 'details' ? 'Read Description' : 'Read Latest Note';
  addActionItem(menu, label, () => {
    openLatestNoteReader(ticket);
  }, { icon: BOOK_OPEN_TEXT_SVG, disabled: readTarget === null });
}

/**
 * A `Push to <backend>` row per configured backend, for an unsynced single-ticket selection.
 *
 * Async: the backends list is fetched after the menu is already on screen, so the
 * rows land at the backlog anchor. Fire-and-forget on failure — `api()` already
 * surfaces a network-error popup, and swallowing here stops a transient `/backends`
 * miss on right-click from leaking as an unhandled rejection (which also trips
 * vitest's unhandled-error guard in tests that open the menu with no server).
 */
function addPushToBackendItems(menu: HTMLElement, ticket: Ticket): void {
  if (state.selectedIds.size !== 1 || ticket.id in syncedTicketMap) return;
  void getBackends().then(backends => {
    if (backends.length === 0) return;
    insertAtBacklogAnchor(menu, toElement(<div className="context-menu-separator"></div>));
    for (const b of backends) {
      // A fixed external-link glyph rather than the plugin-provided manifest icon:
      // the row used to `raw(b.icon)` a string from the manifest, and splicing
      // arbitrary plugin HTML into the menu is an unnecessary injection surface for
      // what is a uniform "open external" action.
      const item = toElement(
        <div className="context-menu-item">
          <span className="dropdown-icon">{ICON_EXTERNAL_LINK}</span>
          <span className="context-menu-label">Push to {b.name}</span>
        </div>
      );
      item.addEventListener('click', async () => {
        closeContextMenu();
        try {
          const result = await pushTicketToBackend(b.id, ticket.id);
          // HS-8094 — `openExternalUrl`, not `window.open`, which silently no-ops
          // under Tauri's WKWebView while still passing Playwright/Chromium tests.
          if (result.remoteUrl != null && result.remoteUrl !== '') openExternalUrl(result.remoteUrl);
          void loadTickets();
        } catch (e) {
          console.error('Failed to push ticket:', e);
        }
      });
      insertAtBacklogAnchor(menu, item);
    }
  }).catch(() => { /* see the doc comment — deliberately swallowed */ });
}

/**
 * HS-8974 — Recall claim (docs/92 §92.7): force-release selected tickets currently
 * held by a worker, back into the self-claimable pool. Shown only when at least one
 * selected ticket is claimed, per the ≤5 s claims poll.
 */
function addRecallClaimItem(menu: HTMLElement): void {
  const claimed = Array.from(state.selectedIds).filter(id => claimForTicket(id) !== undefined);
  if (claimed.length === 0) return;
  const label = claimed.length === 1 ? 'Recall claim' : `Recall ${String(claimed.length)} claims`;
  addActionItem(menu, label, () => {
    void Promise.all(claimed.map(id => releaseTicket(id))).then(() => {
      showToast(claimed.length === 1 ? 'Recalled — back in the pool' : `Recalled ${String(claimed.length)} tickets`);
      void loadTickets();
    });
  }, { icon: ICON_X_CIRCLE });
}

export function showTicketContextMenu(e: MouseEvent, ticketArg: Ticket) {
  e.preventDefault();
  closeContextMenu();

  // HS-8400 — re-read the latest ticket from the store. The
  // contextmenu listener in `ticketRow.tsx` / `columnView.tsx`
  // captures the original ticket at row-creation time; per-ticket
  // signal updates (e.g., a new `FEEDBACK NEEDED` note arriving via
  // the channel mid-session) update the row's purple-dot + label via
  // per-row effects but don't touch the listener closure. Without
  // this lookup the menu's `hasPendingFeedback(ticket)` check ran
  // against stale notes and dropped the Provide Feedback item even
  // when the purple dot was showing. Fresh value from the store
  // restores parity between the dot indicator and the menu item.
  const sig = getTicketSignals(ticketArg.id);
  const ticket = sig?.ticket.value ?? ticketArg;

  // Ensure the ticket is selected
  if (!state.selectedIds.has(ticket.id)) {
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    // HS-8416 — `renderTicketList` cascades into
    // `updateBatchToolbar → syncDetailPanel`, which auto-opens the
    // feedback dialog whenever the just-selected ticket has a pending
    // FEEDBACK NEEDED note. Pre-fix, right-clicking a feedback ticket
    // popped the form on top of the menu and stole the user's intent
    // (the user wanted the context menu's items, not the dialog).
    // Suppress the auto-show for the cascade triggered by this
    // selection update only; a later normal click on the ticket still
    // auto-shows on first arrival.
    suppressNextAutoShowFeedback();
    renderTicketList();
  }

  const menu = toElement(<div className="context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}></div>);

  addFeedbackItem(menu, ticket);
  addReadNoteItem(menu, ticket);

  // HS-8414 — separator under the read / feedback inspection block when
  // either item was rendered. Visually groups the two top affordances
  // away from the configuration submenus (Category / Priority / Status /
  // Up Next) below — pre-change the menu flowed straight from Read
  // Latest Note into Category which looked cluttered. The Read Latest
  // Note item is single-selection only, and Provide Feedback only
  // appears when the ticket has a pending FEEDBACK NEEDED note, so this
  // separator is gated on single-selection — the only case where either
  // item could have been added. On the multi-select path the menu still
  // opens straight into Category submenu (no top items, no trailing
  // separator).
  if (state.selectedIds.size === 1) {
    addSeparator(menu);
  }

  // Completed ticket actions: Verified and Not Working
  const allCompleted = Array.from(state.selectedIds).every(id => {
    const t = state.tickets.find(tk => tk.id === id);
    return t?.status === 'completed';
  });
  if (allCompleted && state.selectedIds.size > 0) {
    addActionItem(menu, 'Verified', () => applyToSelected('status', 'verified'), {
      icon: VERIFIED_SVG,
    });

    const notWorkingItem = toElement(
      <div className={`context-menu-item${state.selectedIds.size > 1 ? ' disabled' : ''}`}>
        <span className="dropdown-icon">{ICON_X_CIRCLE}</span>
        <span className="context-menu-label">Not Working</span>
      </div>
    );
    if (state.selectedIds.size === 1) {
      notWorkingItem.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeContextMenu();
        showNotWorkingDialog(ticket);
      });
    }
    menu.appendChild(notWorkingItem);

    addSeparator(menu);
  }

  // Category submenu
  addSubmenuItem(menu, 'Category', state.categories.map(c => ({
    label: c.label,
    icon: `<span class="dropdown-dot" style="background-color:${c.color}"></span>`,
    active: ticket.category === c.id,
    action: () => applyToSelected('category', c.id),
  })));

  // Priority submenu
  addSubmenuItem(menu, 'Priority', PRIORITY_ITEMS.map(p => ({
    label: p.label,
    icon: getPriorityIcon(p.value),
    iconColor: getPriorityColor(p.value),
    active: ticket.priority === p.value,
    action: () => applyToSelected('priority', p.value),
  })));

  // Status submenu (context menu only shows the 4 main statuses)
  const contextStatuses = STATUS_ITEMS.filter(s =>
    s.value === 'not_started' || s.value === 'started' || s.value === 'completed' || s.value === 'verified'
  );
  addSubmenuItem(menu, 'Status', contextStatuses.map(s => ({
    label: s.label,
    icon: getStatusIcon(s.value),
    active: ticket.status === s.value,
    action: () => applyToSelected('status', s.value),
  })));

  // Up Next toggle (HS-7835 \u2014 Lucide star icon replaces the unicode prefix.
  // Filled variant when the ticket is already up_next so the user sees the
  // current state at a glance, same affordance as the original `\u2605`/`\u2606`.).
  addActionItem(menu, 'Up Next', () => {
    void applyToSelected('up_next', !ticket.up_next);
  }, { icon: ticket.up_next ? ICON_STAR_FILLED : ICON_STAR });

  addSeparator(menu);

  // Tags
  addActionItem(menu, 'Tags...', () => {
    document.dispatchEvent(new CustomEvent('hotsheet:show-tags-dialog'));
  }, { icon: ICON_TAG });

  // Duplicate
  addActionItem(menu, 'Duplicate', async () => {
    const ids = Array.from(state.selectedIds);
    const created = await duplicateTickets(ids);
    state.selectedIds.clear();
    for (const t of created) state.selectedIds.add(t.id);
    void loadTickets();
  }, { icon: ICON_COPY });

  // Mark as Read / Unread
  const hasUnread = Array.from(state.selectedIds).some(id => {
    const t = state.tickets.find(tk => tk.id === id);
    return t != null && t.last_read_at != null && t.updated_at > t.last_read_at;
  });
  if (hasUnread) {
    addActionItem(menu, 'Mark as Read', () => { void toggleReadState(Array.from(state.selectedIds)); }, { icon: ICON_EYE });
  } else {
    addActionItem(menu, 'Mark as Unread', () => { void toggleReadState(Array.from(state.selectedIds)); }, { icon: ICON_EYE_OFF });
  }

  addPushToBackendItems(menu, ticket);

  addRecallClaimItem(menu);

  // Anchor for the Push-to-backend insertion below. The marker class
  // lets the async backends-fetch find this separator by name instead
  // of by index (see HS-8414 comment above the Push block).
  addSeparator(menu, 'context-menu-separator-backlog');

  // HS-8408 — Move to Open (the inverse of Move to Backlog). Appears
  // only when EVERY selected ticket is currently in backlog; sets
  // status back to `not_started` so the ticket re-enters the active
  // work pile that the sidebar's Open view exposes. Label is "Move to
  // Open" rather than "Move to Inbox" per user direction (Hot Sheet
  // doesn't use "inbox" terminology — the active-work view is called
  // "Open" in the sidebar). The item is rendered before Move to
  // Backlog so a backlog ticket's "out of backlog" affordance leads
  // the stash group, with Archive following as the other forward
  // stash action. (Archive tickets don't get the symmetric item per
  // the user's scope decision — strict reading of the ticket; if the
  // user wants the same for archive later, the gate just adds an OR.)
  const allBacklog = state.selectedIds.size > 0 && Array.from(state.selectedIds).every(id => {
    const t = state.tickets.find(tk => tk.id === id);
    return t?.status === 'backlog';
  });
  if (allBacklog) {
    addActionItem(menu, 'Move to Open', () => applyToSelected('status', 'not_started'), {
      icon: ICON_INBOX,
    });
  }

  // Move to Backlog
  addActionItem(menu, 'Move to Backlog', () => applyToSelected('status', 'backlog'), {
    icon: ICON_CALENDAR,
  });
  // Archive
  addActionItem(menu, 'Archive', () => applyToSelected('status', 'archive'), {
    icon: ICON_ARCHIVE,
  });

  // Plugin context menu items
  const pluginItems = getPluginContextMenuItems(Array.from(state.selectedIds));
  if (pluginItems.length > 0) {
    addSeparator(menu);
    for (const item of pluginItems) {
      addActionItem(menu, item.label, () => { item.action(); }, {
        icon: item.icon,
      });
    }
  }

  addSeparator(menu);

  // Delete
  addActionItem(menu, 'Delete', async () => {
    if (state.selectedIds.size === 1) {
      await trackedDelete(ticket);
    } else {
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      await trackedBatch(affected, { ids, action: 'delete' }, 'Delete');
    }
    state.selectedIds.clear();
    void loadTickets();
  }, { danger: true, icon: ICON_TRASH });

  document.body.appendChild(menu);
  clampToViewport(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('contextmenu', closeContextMenu);
  }, 0);
}

/** HS-9441 — exported so `transientOverlays.ts` can dismiss an open menu on a
 *  project switch (a keyboard switch fires no outside `click`, so the
 *  document-level handler below never runs and the menu is orphaned). */
export function closeContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  document.removeEventListener('click', closeContextMenu);
  document.removeEventListener('contextmenu', closeContextMenu);
}

function clampToViewport(menu: HTMLElement) {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

async function applyToSelected(action: string, value: unknown) {
  const ids = Array.from(state.selectedIds);
  const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
  if (ids.length === 1) {
    const ticket = affected[0];
    await trackedPatch(ticket, { [action]: value }, `Change ${action}`);
  } else {
    await trackedBatch(affected, { ids, action, value }, `Change ${action}`);
  }
  void loadTickets();
}

interface SubItem {
  label: string;
  /** Icon as JSX (`SafeHtml`) or legacy HTML string — same union the
   *  `DropdownItem` carries; the renderer picks the right path. */
  icon?: string | SafeHtml;
  iconColor?: string;
  active?: boolean;
  action: () => void;
}

function addSubmenuItem(menu: HTMLElement, label: string, items: SubItem[], icon?: string | SafeHtml) {
  menu.appendChild(buildSubmenuItem(label, items, icon));
}

/** HS-8964 - build (but don't append) a submenu item, so async callers can
 *  insert it at a specific anchor (the "Dispatch to worker" block fetches the
 *  live worker pool after the menu is already positioned). An optional leading
 *  `icon` (HS-9037) renders the same `dropdown-icon` glyph the action items use,
 *  so an icon'd submenu header lines up with its neighbors. */
function buildSubmenuItem(label: string, items: SubItem[], icon?: string | SafeHtml): HTMLElement {
  const item = toElement(
    <div className="context-menu-item has-submenu">
      {icon !== undefined && icon !== '' ? <span className="dropdown-icon">{
        // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- string-icon callers still pass HTML strings here; JSX-icon callers pass `SafeHtml` which renders through the JSX child path.
        typeof icon === 'string' ? raw(icon) : icon
      }</span> : null}
      <span className="context-menu-label">{label}</span>
      <span className="context-menu-arrow">{'\u25B8'}</span>
    </div>
  );

  const submenu = toElement(<div className="context-submenu"></div>);
  for (const sub of items) {
    const subItem = toElement(
      <div className={`context-menu-item${sub.active === true ? ' active' : ''}`}>
        {sub.icon !== undefined && sub.icon !== '' ? <span className="dropdown-icon" style={sub.iconColor !== undefined && sub.iconColor !== '' ? `color:${sub.iconColor}` : ''}>{
          // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- string-icon callers still pass HTML strings here; JSX-icon callers pass `SafeHtml` which renders through the JSX child path.
          typeof sub.icon === 'string' ? raw(sub.icon) : sub.icon
        }</span> : null}
        <span className="context-menu-label">{sub.label}</span>
      </div>
    );
    subItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      sub.action();
      closeContextMenu();
    });
    submenu.appendChild(subItem);
  }

  item.appendChild(submenu);
  return item;
}

function addActionItem(menu: HTMLElement, label: string, action: () => void, options?: { danger?: boolean; icon?: string | SafeHtml; disabled?: boolean }) {
  const disabled = options?.disabled === true;
  const item = toElement(
    <div className={`context-menu-item${options?.danger === true ? ' danger' : ''}${disabled ? ' disabled' : ''}`}>
      {options?.icon !== undefined ? <span className="dropdown-icon">{
        // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- string-icon callers still pass HTML strings here; JSX-icon callers pass `SafeHtml` which renders through the JSX child path.
        typeof options.icon === 'string' ? raw(options.icon) : options.icon
      }</span> : null}
      <span className="context-menu-label">{label}</span>
    </div>
  );
  if (!disabled) {
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeContextMenu();
      action();
    });
  }
  menu.appendChild(item);
}

function addSeparator(menu: HTMLElement, extraClass?: string) {
  const className = extraClass === undefined
    ? 'context-menu-separator'
    : `context-menu-separator ${extraClass}`;
  menu.appendChild(toElement(<div className={className}></div>));
}

// --- Not Working dialog ---

function showNotWorkingDialog(ticket: Ticket) {
  const overlay = toElement(
    <div className="custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor" style="width:480px">
        <div className="custom-view-editor-header">
          <span>Not Working — {ticket.ticket_number}</span>
          <button className="detail-close" id="not-working-close">{'\u00d7'}</button>
        </div>
        <div className="custom-view-editor-body">
          <div className="settings-field">
            <label>What's wrong?</label>
            <textarea id="not-working-text" className="settings-textarea" rows={4} placeholder="Describe the issue..." style="width:100%;resize:vertical" spellcheck="true"></textarea>
          </div>
          <div className="settings-field" style="margin-top:12px">
            <label>Attachments</label>
            <div id="not-working-files" className="not-working-file-list"></div>
            <button className="btn btn-sm" id="not-working-add-file" style="margin-top:6px">Add File...</button>
            <input type="file" id="not-working-file-input" multiple={true} style="display:none" />
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
            <button className="btn btn-sm" id="not-working-cancel">Cancel</button>
            <button className="btn btn-sm btn-danger" id="not-working-submit">Report Not Working</button>
          </div>
        </div>
      </div>
    </div>
  );

  const pendingFiles: File[] = [];
  const fileListEl = overlay.querySelector('#not-working-files')!;
  const fileInput = overlay.querySelector('#not-working-file-input') as HTMLInputElement;

  function renderFileList() {
    fileListEl.innerHTML = '';
    for (let i = 0; i < pendingFiles.length; i++) {
      const file = pendingFiles[i];
      const row = toElement(
        <div className="not-working-file-row">
          <span>{file.name}</span>
          <button className="category-delete-btn" data-idx={String(i)}>{'\u00d7'}</button>
        </div>
      );
      row.querySelector('button')!.addEventListener('click', () => {
        pendingFiles.splice(i, 1);
        renderFileList();
      });
      fileListEl.appendChild(row);
    }
  }

  overlay.querySelector('#not-working-add-file')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) pendingFiles.push(f);
      renderFileList();
    }
    fileInput.value = '';
  });

  // Drag-and-drop file support on the entire overlay
  overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      for (const f of Array.from(e.dataTransfer.files)) pendingFiles.push(f);
      renderFileList();
    }
  });

  const close = () => overlay.remove();
  overlay.querySelector('#not-working-close')!.addEventListener('click', close);
  overlay.querySelector('#not-working-cancel')!.addEventListener('click', close);
  // Intentionally no click-outside-to-dismiss — this dialog has form data
  // (text + attachments) that would be lost on accidental clicks.

  overlay.querySelector('#not-working-submit')!.addEventListener('click', async () => {
    const text = (overlay.querySelector('#not-working-text') as HTMLTextAreaElement).value.trim();
    if (!text) {
      (overlay.querySelector('#not-working-text') as HTMLTextAreaElement).focus();
      return;
    }

    const submitBtn = overlay.querySelector('#not-working-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      // Add note
      await updateTicket(ticket.id, { notes: `Not working: ${text}`, status: 'not_started', up_next: true });

      // Upload attachments
      for (const file of pendingFiles) {
        await uploadAttachment(ticket.id, file);
      }

      close();
      void loadTickets();
    } catch {
      submitBtn.textContent = 'Report Not Working';
      submitBtn.disabled = false;
    }
  });

  document.body.appendChild(overlay);
  (overlay.querySelector('#not-working-text') as HTMLTextAreaElement).focus();
}
