import { copyTickets, hasClipboardTickets, pasteTickets } from './clipboard.js';
import { formatTicketForClipboard } from './clipboardUtil.js';
import { getActiveDrawerTab } from './commandLog.js';
import { showOpenFolderDialog } from './openFolder.js';
import { showPrintDialog } from './print.js';
import { closeActiveTab, switchTabByOffset } from './projectTabs.js';
import { state } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { isFindShortcut, isTerminalViewToggleShortcut } from './terminalKeybindings.js';
import { focusActiveTerminalSearch } from './terminalSearch.js';
import { cancelPendingSave, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { performRedo, performUndo, toggleUpNext, trackedBatch } from './undo/actions.js';

let detailSaveTimeout: ReturnType<typeof setTimeout> | null = null;

/** Set the detail save timeout reference — called from bindDetailPanel to share the timeout */
export function setDetailSaveTimeout(timeout: ReturnType<typeof setTimeout> | null) {
  detailSaveTimeout = timeout;
}

/** Get the current detail save timeout */
export function getDetailSaveTimeout(): ReturnType<typeof setTimeout> | null {
  return detailSaveTimeout;
}

function triggerUndo() {
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  void performUndo();
}

function triggerRedo() {
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  void performRedo();
}

export function bindKeyboardShortcuts() {
  // Tauri menu events
  window.addEventListener('app:undo', triggerUndo);
  window.addEventListener('app:redo', triggerRedo);
  window.addEventListener('app:preferences', () => document.getElementById('settings-btn')?.click());
  window.addEventListener('app:open-folder', () => showOpenFolderDialog());

  // Keyboard fallback for browser mode (non-Tauri) — capture phase
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      // HS-8033 — bail when any modal is open so Cmd+Z reaches the native
      // input-level undo inside the dialog instead of undoing a ticket
      // operation behind the modal.
      if (shouldBailForActiveModal(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        triggerRedo();
      } else {
        triggerUndo();
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input/textarea (except specific shortcuts)
    const isInput = isEditableTarget(e.target);

    // Close any open dialog on Escape
    if (e.key === 'Escape') {
      // HS-8011 — let plain Esc fall through to the focused terminal so
      // programs running there (claude code, vim, less, …) can interrupt /
      // dismiss / cancel. Opt+Esc still routes to Hot Sheet.
      if (shouldEscapeBypassHotsheet(e.target, e.altKey)) return;
      for (const id of ['open-folder-overlay', 'settings-overlay']) {
        const dlg = document.getElementById(id);
        if (dlg && dlg.style.display !== 'none') {
          dlg.style.display = 'none';
          return;
        }
      }
    }

    // HS-8033 — when any modal dialog is mounted + visible, bail out of
    // every global shortcut. Pre-fix Cmd+A while the settings / feedback /
    // confirm dialog was open silently selected every ticket behind the
    // backdrop, and a fast Cmd+A → Backspace deleted them. Modals own the
    // keyboard until they're dismissed (Esc above still works because we
    // bail AFTER the Esc handler so the user can always close the modal).
    // Modal-internal shortcuts (e.g. Cmd+Enter to submit) are wired on the
    // input elements directly, so they fire before this document-level
    // listener and aren't affected by the bail.
    if (shouldBailForActiveModal(e.target)) return;

    // Tab switching: Cmd+Shift+[/] (works even in inputs) or Cmd+Shift+Left/Right (not in text fields)
    // HS-6472: when a terminal is focused, Cmd+Shift+Left/Right switches terminal
    // tabs instead, and adding Alt/Option bubbles the shortcut back up to project
    // tabs. The xterm helper textarea is still a TEXTAREA, so this block has to
    // run before the isInput guard below; terminal focus is detected by walking
    // up from the active element to a .drawer-terminal-pane or .xterm container.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      if (e.key === '[') {
        e.preventDefault();
        switchTabByOffset(-1);
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        switchTabByOffset(1);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const offset = e.key === 'ArrowLeft' ? -1 : 1;
        // HS-7927 follow-up: focus inside the commands-log pane is treated
        // the same as focus inside a terminal pane — Cmd+Shift+Arrow cycles
        // drawer tabs, Opt+Cmd+Shift+Arrow escapes back to project tabs.
        // The search input inside the commands-log pane is otherwise
        // indistinguishable from any other text input, so without this gate
        // Cmd+Shift+Arrow on the search field would just no-op.
        const inDrawer = isTerminalFocused() || isCommandsLogFocused();
        if (e.altKey) {
          if (!isInput || inDrawer) {
            e.preventDefault();
            switchTabByOffset(offset);
          }
          return;
        }
        if (inDrawer) {
          e.preventDefault();
          switchTerminalTabByOffset(offset);
          return;
        }
        if (!isInput) {
          e.preventDefault();
          switchTabByOffset(offset);
          return;
        }
      }
    }

    // Close tab: Opt+Cmd+W (macOS) / Ctrl+Alt+W (other)
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeActiveTab();
      return;
    }

    // HS-7926 — Cmd+T (macOS) / Ctrl+T (Windows/Linux) opens a new dynamic
    // terminal. Mirrors Terminal.app / iTerm2 / VS Code's "new tab" shortcut.
    // Fires regardless of focus context (including inside an xterm helper
    // textarea or an INPUT) — Cmd+T is reserved by every macOS app for "new
    // tab" so users expect it to work everywhere. The "+" add-terminal
    // button at `#drawer-add-terminal-btn` lives inside
    // `#drawer-terminal-tabs-wrap` which is `display:none` when no
    // configured terminals exist; clicking a hidden button still fires the
    // handler so the shortcut works in every state.
    if (isNewTerminalShortcut(e)) {
      const btn = document.getElementById('drawer-add-terminal-btn');
      if (btn !== null) {
        e.preventDefault();
        btn.click();
        return;
      }
    }

    // Cmd/Ctrl+O: Open Folder (browser mode — Tauri handles via menu)
    if ((e.metaKey || e.ctrlKey) && e.key === 'o' && !getTauriInvoke()) {
      e.preventDefault();
      showOpenFolderDialog();
      return;
    }

    // Cmd/Ctrl+,: Settings (browser mode — Tauri handles via menu)
    if ((e.metaKey || e.ctrlKey) && e.key === ',' && !getTauriInvoke()) {
      e.preventDefault();
      document.getElementById('settings-btn')?.click();
      return;
    }

    if (e.key === 'Escape') {
      // HS-8011 — when a terminal owns keyboard focus, plain Esc must reach
      // the program running inside it. Pre-fix this branch unconditionally
      // blurred xterm's helper-textarea (which {@link isEditableTarget}
      // matches) — claude code / vim / less never saw the keystroke. Opt+Esc
      // still falls through to Hot Sheet's blur-and-deselect behaviour.
      if (shouldEscapeBypassHotsheet(e.target, e.altKey)) return;
      // HS-7393 — any focused INPUT / TEXTAREA should blur on Esc without
      // also clearing ticket selection or the input's value. Previously this
      // branch only covered detail-panel inputs, so Esc in the app search or
      // a terminal search widget blurred-and-deselected at the same time.
      // The app-level search and terminal-search Esc-clear-and-close
      // behaviours have also been removed (sidebar.tsx, terminalSearch.tsx)
      // so Esc is now consistently just "lose focus" across every input.
      const active = document.activeElement as HTMLElement | null;
      if (active && isEditableTarget(active)) {
        active.blur();
        return;
      }
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
      return;
    }

    // Arrow keys in column view: navigate between cards
    // Skip if an attachment item is focused — let the attachment handler navigate between attachments
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isInput && state.layout === 'columns'
      && !(document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('attachment-item'))) {
      const allCards = Array.from(document.querySelectorAll<HTMLElement>('.column-card[data-id]'));
      if (allCards.length > 0 && state.selectedIds.size > 0) {
        e.preventDefault();
        // Find the currently selected card
        const currentId = state.lastClickedId ?? Array.from(state.selectedIds)[0];
        const currentIdx = allCards.findIndex(c => c.dataset.id === String(currentId));
        const nextIdx = e.key === 'ArrowDown' ? currentIdx + 1 : currentIdx - 1;
        if (nextIdx >= 0 && nextIdx < allCards.length) {
          const nextCard = allCards[nextIdx];
          const nextId = parseInt(nextCard.dataset.id!, 10);
          if (e.shiftKey) {
            state.selectedIds.add(nextId);
          } else {
            state.selectedIds.clear();
            state.selectedIds.add(nextId);
          }
          state.lastClickedId = nextId;
          nextCard.scrollIntoView({ block: 'nearest' });
          renderTicketList();
        }
        return;
      }
    }

    // Cmd/Ctrl+A: select all visible tickets
    if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInput) {
      e.preventDefault();
      state.selectedIds.clear();
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
      renderTicketList();
      return;
    }

    // Cmd/Ctrl+D: toggle up next for all selected tickets
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
      if (state.selectedIds.size > 0) {
        e.preventDefault();
        const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
        void toggleUpNext(selectedTickets).then(() => void loadTickets());
      }
      return;
    }

    // Cmd/Ctrl+C: copy selected ticket(s) info to clipboard
    // Opt+Cmd/Ctrl+C: force ticket copy even when in a text field
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && state.selectedIds.size > 0) {
      // Let native copy work in text fields (unless Alt/Option forces ticket copy)
      if (isInput && !e.altKey) { /* native copy */ }
      else {
        // Also let native copy work when text is selected on the page
        const sel = !e.altKey ? window.getSelection() : null;
        if (sel !== null && !sel.isCollapsed && sel.toString().trim() !== '') { /* native copy */ }
        else {
          e.preventDefault();
          const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
          // Store structured data in internal clipboard for cross-project paste
          copyTickets(selected, false);
          // Also write text to system clipboard for external paste
          const text = selected.map(formatTicketForClipboard).join('\n\n');
          void navigator.clipboard.writeText(text);
          return;
        }
      }
    }

    // Cmd/Ctrl+X: cut selected tickets (copy + mark for deletion on paste)
    if ((e.metaKey || e.ctrlKey) && e.key === 'x' && state.selectedIds.size > 0) {
      if (isInput && !e.altKey) { /* native cut */ }
      else {
        const sel = !e.altKey ? window.getSelection() : null;
        if (sel !== null && !sel.isCollapsed && sel.toString().trim() !== '') { /* native cut */ }
        else {
          e.preventDefault();
          const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
          copyTickets(selected, true);
          const text = selected.map(formatTicketForClipboard).join('\n\n');
          void navigator.clipboard.writeText(text);
          return;
        }
      }
    }

    // Cmd/Ctrl+V: paste tickets from internal clipboard
    if ((e.metaKey || e.ctrlKey) && e.key === 'v' && !isInput && hasClipboardTickets()) {
      e.preventDefault();
      void pasteTickets();
      return;
    }

    // Cmd/Ctrl+N: focus draft input (works everywhere)
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      focusDraftInput();
      return;
    }

    // Cmd/Ctrl+P: print
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      showPrintDialog();
      return;
    }

    // Cmd/Ctrl+F: focus search. HS-7331 — when a terminal has focus, route
    // to the in-terminal SearchAddon widget; otherwise fall through to the
    // ticket-list search in the app header.
    // HS-7460 — when a terminal is focused, only the platform-correct
    // modifier (Cmd on macOS / Ctrl elsewhere) hijacks the shortcut. The
    // wrong-platform variant (e.g. Ctrl+F on macOS) passes through entirely
    // so xterm forwards it to the shell as readline's `forward-char`.
    // Outside a terminal both modifiers continue to focus the ticket search
    // — the ticket-list has no conflicting use of Ctrl+F.
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      if (isTerminalFocused()) {
        if (!isFindShortcut(e)) return;
        e.preventDefault();
        if (focusActiveTerminalSearch()) return;
        (document.getElementById('search-input') as HTMLInputElement).focus();
        return;
      }
      e.preventDefault();
      (document.getElementById('search-input') as HTMLInputElement).focus();
      return;
    }

    // HS-7594 — Cmd+` (macOS) / Ctrl+` (Linux/Windows) toggles a terminal-view
    // surface based on where focus is:
    //   - In a drawer terminal → toggle §36 drawer terminal grid view
    //   - Anywhere else → toggle §25 global Terminal Dashboard
    // Opt+Cmd+` always toggles the global Terminal Dashboard (lets the user
    // jump to the dashboard from inside a drawer terminal without leaving).
    // Implementation: dispatch a click on the relevant toggle button so we
    // reuse its existing enable/disable + state-machine logic instead of
    // re-implementing the lifecycle here.
    {
      const toggleMatch = isTerminalViewToggleShortcut(e);
      if (toggleMatch !== null) {
        e.preventDefault();
        const inTerminal = isTerminalFocused();
        const target = toggleMatch.alt
          ? 'dashboard'
          : (inTerminal ? 'drawer-grid' : 'dashboard');
        if (target === 'drawer-grid') {
          const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement | null;
          if (btn !== null && !btn.disabled) btn.click();
          // If the drawer-grid toggle is disabled (≤1 terminal), silently
          // ignore — matches the click behaviour of the disabled button.
        } else {
          // Dashboard toggle is unconditionally enabled (when Tauri-stubbed
          // visible at all). Click it whether dashboard is currently open or
          // not — the toggle's own click handler flips the state.
          const btn = document.getElementById('terminal-dashboard-toggle') as HTMLButtonElement | null;
          if (btn !== null && btn.style.display !== 'none') btn.click();
        }
        return;
      }
    }

    // N: focus draft input (when not in an input)
    if (e.key === 'n' && !isInput) {
      e.preventDefault();
      focusDraftInput();
      return;
    }

    // Delete/Backspace: delete selected tickets (when not in an input)
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput && state.selectedIds.size > 0) {
      e.preventDefault();
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      void trackedBatch(affected, { ids, action: 'delete' }, 'Delete').then(() => {
        state.selectedIds.clear();
        void loadTickets();
      });
      return;
    }
  });
}

/**
 * HS-7978 — true when the event target is something the user is editing:
 * a real form input/textarea/select, OR any element with `contentEditable`
 * (e.g. the custom-command-group name span uses `contentEditable="true"`).
 * Pre-fix the gate only checked tag names, so Cmd+A inside a contenteditable
 * span fell through to "select all tickets" and a fast Cmd+A → Backspace
 * deleted the user's tickets instead of clearing the field text.
 *
 * Exported so unit tests can verify the predicate directly without driving
 * the full keydown handler.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * HS-8033 — selectors that identify the *backdrop* element of a modal
 * dialog. When any of these is mounted + visible, global keyboard
 * shortcuts (Cmd+A, Delete, Cmd+C/V/X, Tab cycling, etc.) MUST NOT fire
 * unless the keystroke originated inside that modal — otherwise typing
 * Cmd+A while the settings dialog is open silently selects every ticket
 * in the background, and a fast Cmd+A → Backspace deletes them. The
 * user's HS-8033 ask: "treat dialogs as if they're first-class citizens".
 *
 * The list covers every modal overlay surface in `src/client/`:
 * - Server-rendered overlays (IDs): `open-folder-overlay`, `settings-overlay`.
 * - Client-mounted dialog backdrops (classes): the `*-overlay` half of
 *   each dialog component. Non-modal popups (`.terminal-prompt-overlay`,
 *   `.permission-popup`, `.context-menu`, etc.) are deliberately
 *   excluded — they don't take focus from the underlying surface so
 *   global shortcuts should still work alongside them.
 *
 * Exported so unit tests can verify the registry directly.
 */
export const MODAL_OVERLAY_SELECTORS: readonly string[] = [
  '#open-folder-overlay',
  '#settings-overlay',
  '.confirm-dialog-overlay',
  '.cmd-editor-overlay',
  '.custom-view-editor-overlay',
  '.feedback-dialog-overlay',
  '.grouping-prompt-overlay',
  '.hide-terminal-dialog-overlay',
  '.print-dialog-overlay',
  '.quit-confirm-overlay',
  '.reader-mode-overlay',
  '.tags-dialog-overlay',
  '.quicklook-overlay',
];

/** True when an element is rendered + visible (not display:none / hidden). */
function isElementVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  // The server-rendered overlays toggle `style.display` directly; cheap
  // inline check first so we don't pay for a getComputedStyle round-trip
  // on every keystroke when nothing is open.
  if (el.style.display === 'none') return false;
  if (!el.isConnected) return false;
  const computed = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (computed === undefined) return true;
  return computed.display !== 'none' && computed.visibility !== 'hidden';
}

/**
 * HS-8033 — locate the topmost visible modal-overlay element, or null
 * when no modal is currently mounted. Walks `MODAL_OVERLAY_SELECTORS` in
 * order and returns the first visible match. Exported so unit tests can
 * drive the predicate.
 */
export function findVisibleModalOverlay(root: ParentNode = document): HTMLElement | null {
  for (const selector of MODAL_OVERLAY_SELECTORS) {
    const matches = root.querySelectorAll<HTMLElement>(selector);
    for (const el of matches) {
      if (isElementVisible(el)) return el;
    }
  }
  return null;
}

/**
 * HS-8033 — true when a modal dialog is open AND the keyboard event did
 * NOT originate inside it. Global shortcuts bail in this state so they
 * can't reach the underlying ticket list / project tabs / drawer. When
 * focus is *inside* the modal, the modal's own input handlers run first
 * (target-element listeners fire before this document-level handler);
 * the global handler then bails so Cmd+A inside an `<input>` only selects
 * the input's text rather than every ticket behind the modal.
 */
export function shouldBailForActiveModal(target: EventTarget | null): boolean {
  const modal = findVisibleModalOverlay();
  if (modal === null) return false;
  if (target instanceof Node && modal.contains(target)) {
    // Focus is inside the modal — let the modal's own keyboard handlers
    // (which are wired on the input elements directly) own the keystroke;
    // bail out of every global shortcut so we don't double-handle.
    return true;
  }
  // Focus is outside the modal — the modal is still capturing user
  // attention, so global shortcuts shouldn't fire either.
  return true;
}

/**
 * True when keyboard focus is inside an embedded terminal — either the
 * xterm helper textarea or its surrounding pane. xterm mounts its I/O
 * surface as a TEXTAREA element, so we can't use the plain "isInput" test
 * to gate terminal-targeted shortcuts (HS-6472).
 */
export function isTerminalFocused(): boolean {
  return isElementInTerminal(document.activeElement);
}

/**
 * Pure variant of {@link isTerminalFocused} that takes the element under
 * test directly. Exported so unit tests can drive the predicate without
 * having to manipulate `document.activeElement`.
 */
export function isElementInTerminal(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('.drawer-terminal-pane, .xterm') !== null;
}

/**
 * HS-8011 — Plain Escape inside a focused terminal must reach the running
 * program (claude code, vim, less, …) instead of being consumed by Hot
 * Sheet's global handlers. Returns `true` when the global handler should
 * bail out and let xterm see the keystroke. Opt/Alt+Esc still routes to
 * Hot Sheet so the user can blur inputs / exit dashboard / etc. without
 * having to click out of the terminal first.
 */
export function shouldEscapeBypassHotsheet(target: EventTarget | null, altKey: boolean): boolean {
  if (altKey) return false;
  return isElementInTerminal(target);
}

/**
 * HS-7927 follow-up — true when keyboard focus is inside the drawer's
 * commands-log pane (its search input is the realistic case). Used to make
 * Cmd+Shift+Arrow cycle drawer tabs from within commands-log just like it
 * does from within a terminal pane, treating commands-log as a peer drawer
 * tab rather than a "regular" input that swallows the shortcut.
 *
 * Exported so the unit test can verify the focus check against a mounted
 * DOM without having to drive the live keyboard handler.
 *
 * HS-7927 second follow-up — also returns true when the active drawer tab
 * is `commands-log` AND focus is anywhere within `#command-log-panel`
 * (e.g. on the Commands Log tab button itself). After clicking the tab to
 * switch to it, the Commands Log pane often has no focused element of its
 * own — focus stays briefly on the tab button or reverts to `<body>`.
 * Without this broader check, Cmd+Shift+Arrow in that state would fall
 * through to project-tab cycling, which is exactly what the user reported.
 *
 * HS-7927 third follow-up — earlier passes still failed when focus was on
 * `<body>` and the drawer chrome didn't `contain(<body>)`. The user clicks
 * inside the Commands Log content (often onto a non-focusable span / row)
 * which sends focus back to `<body>`; both prior gates returned false and
 * Cmd+Shift+Arrow fell through to project-tab cycling. The robust signal
 * is `getActiveDrawerTab() === 'commands-log'` AND the drawer panel being
 * visible — that's what the user actually means by "in commands log",
 * regardless of which DOM element happens to have focus.
 */
export function isCommandsLogFocused(): boolean {
  const drawerPanel = document.getElementById('command-log-panel');
  // Drawer not in the DOM, or hidden via display:none → not "in" commands-log.
  if (drawerPanel === null || drawerPanel.style.display === 'none') return false;
  // The active drawer tab is the source of truth — set by `selectDrawerTab`
  // and persisted in the per-project drawer state.
  if (getActiveDrawerTab() === 'commands-log') return true;
  // Defensive fallback for the rare case where `getActiveDrawerTab()` is
  // stale (e.g. a user-script switched panels via DOM mutation): cross-check
  // the visibly-active tab button.
  const activeTabBtn = drawerPanel.querySelector<HTMLElement>('.drawer-tab.active');
  return activeTabBtn?.dataset.drawerTab === 'commands-log';
}

/**
 * HS-7926 — Cmd+T (macOS) / Ctrl+T (Windows/Linux) shortcut predicate. Pure
 * helper so the conditional in the keydown handler is testable. Excludes
 * Shift (Cmd+Shift+T = "reopen closed tab") and Alt to leave room for any
 * future variant. Case-insensitive on the letter for keyboard-layout
 * tolerance.
 */
export function isNewTerminalShortcut(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string }): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === 't';
}

/**
 * Pure helper: given a list of `.drawer-tab[data-drawer-tab]` elements + an
 * offset, return the `data-drawer-tab` id of the wrap-around target, or
 * `null` if there are fewer than two cyclable tabs.
 *
 * HS-7927 broadens the cycle from "terminal tabs only" (HS-6472) to "every
 * cyclable drawer tab" — Commands Log + every terminal. The
 * `[data-drawer-tab]` filter excludes the "+" add-terminal button (which
 * has the `drawer-tab` class but no `data-drawer-tab`).
 *
 * Exported so the unit test can pin down the selection + wrap-around
 * behaviour without running the live keyboard handler.
 */
export function pickNextDrawerTabId(
  tabs: ReadonlyArray<{ active: boolean; tabId: string }>,
  offset: number,
): string | null {
  if (tabs.length < 2) return null;
  const currentIdx = tabs.findIndex(t => t.active);
  const start = currentIdx === -1 ? 0 : currentIdx;
  const nextIdx = ((start + offset) % tabs.length + tabs.length) % tabs.length;
  return tabs[nextIdx].tabId;
}

function switchTerminalTabByOffset(offset: number): void {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('.drawer-tab[data-drawer-tab]'));
  const tabSummaries = tabs.map(el => ({
    active: el.classList.contains('active'),
    tabId: el.dataset.drawerTab ?? '',
  }));
  const targetId = pickNextDrawerTabId(tabSummaries, offset);
  if (targetId === null || targetId === '') return;
  void import('./commandLog.js').then(({ switchDrawerTab }) => { switchDrawerTab(targetId); });
}
