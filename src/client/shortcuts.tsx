import { copyTickets, hasClipboardTickets, pasteTickets } from './clipboard.js';
import { formatTicketForClipboard } from './clipboardUtil.js';
import { getActiveDrawerTab } from './commandLog.js';
import { byId, byIdOrNull } from './dom.js';
import { showOpenFolderDialog } from './openFolder.js';
import { showPrintDialog } from './print.js';
import { projectsStore } from './projectsStore.js';
import { closeActiveTab, switchTabByOffset } from './projectTabs.js';
import { getActiveProject, state } from './state.js';
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

/**
 * Per-event focus context derived once per keydown so each shortcut entry
 * can read pre-computed booleans rather than re-querying the DOM in its
 * `match` predicate.
 */
export interface KeyContext {
  readonly isInput: boolean;
  readonly isTerminalFocused: boolean;
  readonly isCommandsLogFocused: boolean;
}

/** A shortcut's `run` callback returns `'handled'` to stop dispatch (and
 *  implicitly calls `preventDefault` if it wants to consume the chord) or
 *  `'continue'` to let the table keep matching subsequent entries — used
 *  by chords with native-passthrough semantics like Cmd+C / Cmd+X. */
type ShortcutResult = 'handled' | 'continue';

interface KeyboardShortcut {
  /** Human-readable label — appears in dev tools / logs, never user-facing. */
  readonly label: string;
  /** Predicate matching the chord. Should cover key + modifiers but stop
   *  short of state-dependent gates that belong in `run`. */
  readonly match: (e: KeyboardEvent, ctx: KeyContext) => boolean;
  /** Side-effect handler. Must call `preventDefault()` itself when the
   *  chord is being consumed — keeps each entry honest about its own
   *  native-passthrough semantics. */
  readonly run: (e: KeyboardEvent, ctx: KeyContext) => ShortcutResult;
}

/**
 * The full keyboard-shortcut table. Order matters: entries are matched
 * top-to-bottom; the first whose `match` returns true runs, and unless
 * its `run` returns `'continue'` the dispatch halts. New chords go here.
 *
 * The capture-phase Cmd+Z / Cmd+Shift+Z handler is NOT in this table —
 * it has to fire before any document-level keydown listener (so the
 * dispatch table never sees it) and lives in its own listener below.
 *
 * The early Escape-closes-server-modal handler and the HS-8033 modal-bail
 * are also kept inline in {@link bindKeyboardShortcuts} because they must
 * run before any chord entry.
 */

/**
 * HS-8418 — true when a Backspace / Delete keystroke is unclaimed by any
 * Hot Sheet editable surface and would otherwise reach the WebView's
 * default handler, where it triggers `history.back()` and exits the
 * Tauri shell back to its loading screen. The catch-all matcher uses
 * this predicate to consume the keystroke without side effects.
 *
 * Exported so unit tests can pin the truth table directly without
 * driving the full keydown dispatch.
 */
export function shouldPreventHistoryBackKey(e: KeyboardEvent, ctx: KeyContext): boolean {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
  if (ctx.isInput) return false;
  if (ctx.isTerminalFocused) return false;
  return true;
}

const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    // HS-8656 — Cmd/Ctrl+Shift+[ / ] cycle tabs, matching macOS Terminal.app
    // (which supports both the brackets AND the arrows). These are ALIASES for
    // the Cmd/Ctrl+Shift+Arrow entry below — terminal-aware via
    // `decideShiftArrowTabAction`: when a terminal (or the commands-log, non-
    // input) is focused they cycle the DRAWER/terminal tab; otherwise they cycle
    // the PROJECT tab (the pre-HS-8656 bracket behavior). Unlike the arrows,
    // brackets are never a text-selection chord, so there's no input-
    // fallthrough — a regular-input focus still cycles the project tab.
    label: 'Cmd/Ctrl+Shift+[: previous tab (terminal-aware)',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '[',
    run: (e, ctx) => { e.preventDefault(); cycleTabForBracket(-1, e, ctx); return 'handled'; },
  },
  {
    label: 'Cmd/Ctrl+Shift+]: next tab (terminal-aware)',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ']',
    run: (e, ctx) => { e.preventDefault(); cycleTabForBracket(1, e, ctx); return 'handled'; },
  },
  {
    // HS-6472 + HS-8366 — terminal-aware project/drawer tab cycling. The
    // pure decision function {@link decideShiftArrowTabAction} owns every
    // cell of the (input × terminal × commands-log × alt) decision matrix.
    label: 'Cmd/Ctrl+Shift+Arrow: project or drawer tab cycle',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'),
    run: (e, ctx) => {
      const offset = e.key === 'ArrowLeft' ? -1 : 1;
      const decision = decideShiftArrowTabAction({
        isInput: ctx.isInput,
        isTerminalFocused: ctx.isTerminalFocused,
        isCommandsLogFocused: ctx.isCommandsLogFocused,
        isAlt: e.altKey,
      });
      if (decision === 'project') {
        e.preventDefault();
        switchTabByOffset(offset);
        return 'handled';
      }
      if (decision === 'drawer-tab') {
        e.preventDefault();
        switchTerminalTabByOffset(offset);
        return 'handled';
      }
      // 'fallthrough' or 'fallthrough-alt' — both mean "let the browser
      // handle it for text-selection extension." 'fallthrough-alt' is a
      // hard stop (the original handler explicitly returned without
      // firing later entries); 'fallthrough' is a soft stop with the
      // same end-state because no later entry matches Cmd+Shift+Arrow.
      return 'handled';
    },
  },
  {
    label: 'Opt+Cmd+W / Ctrl+Alt+W: close active tab',
    match: (e) => (e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'w',
    run: (e) => {
      e.preventDefault();
      closeActiveTab();
      return 'handled';
    },
  },
  {
    // HS-7926 — Cmd+T (macOS) / Ctrl+T (Win/Linux) opens a new dynamic
    // terminal. Fires regardless of focus (including inside xterm helper
    // textarea / INPUT) — every macOS app reserves Cmd+T for "new tab".
    label: 'Cmd/Ctrl+T: new dynamic terminal (HS-7926)',
    match: (e) => isNewTerminalShortcut(e),
    run: (e) => {
      const btn = byIdOrNull('drawer-add-terminal-btn');
      if (btn === null) return 'continue';
      e.preventDefault();
      btn.click();
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+O: open folder (non-Tauri only)',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'o' && getTauriInvoke() === null,
    run: (e) => {
      e.preventDefault();
      showOpenFolderDialog();
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+,: open settings (non-Tauri only)',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === ',' && getTauriInvoke() === null,
    run: (e) => {
      e.preventDefault();
      byIdOrNull('settings-btn')?.click();
      return 'handled';
    },
  },
  {
    // HS-8011 / HS-7393 — second Escape branch. Blurs the focused input
    // or clears ticket selection. The earlier server-modal-close pass
    // already ran above and didn't consume the keystroke if there was
    // no modal to close.
    label: 'Escape: blur focused input or clear ticket selection',
    match: (e) => e.key === 'Escape',
    run: (e) => {
      if (shouldEscapeBypassHotsheet(e.target, e.altKey)) return 'handled';
      const active = document.activeElement as HTMLElement | null;
      if (active && isEditableTarget(active)) {
        active.blur();
        return 'handled';
      }
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
      return 'handled';
    },
  },
  {
    // Column-view card navigation. Attachment-item focus delegates to
    // the attachment handler so attachment row arrow keys still work.
    label: 'ArrowDown/ArrowUp: navigate column-view cards',
    match: (e, ctx) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !ctx.isInput && state.layout === 'columns'
      && !(document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('attachment-item')),
    run: (e) => {
      const allCards = Array.from(document.querySelectorAll<HTMLElement>('.column-card[data-id]'));
      if (allCards.length === 0 || state.selectedIds.size === 0) return 'continue';
      e.preventDefault();
      const currentId = state.lastClickedId ?? Array.from(state.selectedIds)[0];
      const currentIdx = allCards.findIndex(c => c.dataset.id === String(currentId));
      const nextIdx = e.key === 'ArrowDown' ? currentIdx + 1 : currentIdx - 1;
      if (nextIdx < 0 || nextIdx >= allCards.length) return 'handled';
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
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+A: select all visible tickets',
    match: (e, ctx) => (e.metaKey || e.ctrlKey) && e.key === 'a' && !ctx.isInput,
    run: (e) => {
      e.preventDefault();
      state.selectedIds.clear();
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
      renderTicketList();
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+D: toggle up_next on selected tickets',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'd',
    run: (e) => {
      if (state.selectedIds.size === 0) return 'handled';
      e.preventDefault();
      const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
      void toggleUpNext(selectedTickets).then(() => void loadTickets());
      return 'handled';
    },
  },
  {
    // Cmd/Ctrl+C with selection: copy tickets. Native copy still wins
    // inside an input (unless Alt forces ticket-copy) and when text is
    // selected on the page.
    label: 'Cmd/Ctrl+C: copy selected tickets to clipboard',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'c' && state.selectedIds.size > 0,
    run: (e, ctx) => {
      if (ctx.isInput && !e.altKey) return 'continue';
      const sel = !e.altKey ? window.getSelection() : null;
      if (sel !== null && !sel.isCollapsed && sel.toString().trim() !== '') return 'continue';
      e.preventDefault();
      const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
      copyTickets(selected, false);
      const text = selected.map(formatTicketForClipboard).join('\n\n');
      void navigator.clipboard.writeText(text);
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+X: cut selected tickets',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'x' && state.selectedIds.size > 0,
    run: (e, ctx) => {
      if (ctx.isInput && !e.altKey) return 'continue';
      const sel = !e.altKey ? window.getSelection() : null;
      if (sel !== null && !sel.isCollapsed && sel.toString().trim() !== '') return 'continue';
      e.preventDefault();
      const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
      copyTickets(selected, true);
      const text = selected.map(formatTicketForClipboard).join('\n\n');
      void navigator.clipboard.writeText(text);
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+V: paste tickets from internal clipboard',
    match: (e, ctx) => (e.metaKey || e.ctrlKey) && e.key === 'v' && !ctx.isInput && hasClipboardTickets(),
    run: (e) => {
      e.preventDefault();
      void pasteTickets();
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+N: focus draft input',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'n',
    run: (e) => {
      e.preventDefault();
      focusDraftInput();
      return 'handled';
    },
  },
  {
    label: 'Cmd/Ctrl+P: print',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'p',
    run: (e) => {
      e.preventDefault();
      showPrintDialog();
      return 'handled';
    },
  },
  {
    // HS-7331 / HS-7460 — Cmd/Ctrl+F. Routes to in-terminal SearchAddon
    // when a terminal is focused (only on the platform-correct modifier,
    // so the wrong-platform variant reaches the shell as readline
    // forward-char); otherwise focuses the ticket-list search input.
    label: 'Cmd/Ctrl+F: focus terminal-or-ticket search',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'f',
    run: (e, ctx) => {
      if (ctx.isTerminalFocused) {
        if (!isFindShortcut(e)) return 'handled';
        e.preventDefault();
        if (focusActiveTerminalSearch()) return 'handled';
        byId<HTMLInputElement>('search-input').focus();
        return 'handled';
      }
      e.preventDefault();
      byId<HTMLInputElement>('search-input').focus();
      return 'handled';
    },
  },
  {
    // HS-7594 — Cmd+` toggles drawer-grid or dashboard depending on
    // focus; Opt+Cmd+` always toggles dashboard.
    label: 'Cmd/Ctrl+`: toggle drawer-grid or terminal dashboard',
    match: (e) => isTerminalViewToggleShortcut(e) !== null,
    run: (e, ctx) => {
      const toggleMatch = isTerminalViewToggleShortcut(e);
      if (toggleMatch === null) return 'continue';
      e.preventDefault();
      const target = toggleMatch.alt ? 'dashboard' : (ctx.isTerminalFocused ? 'drawer-grid' : 'dashboard');
      if (target === 'drawer-grid') {
        const btn = byIdOrNull<HTMLButtonElement>('drawer-grid-toggle');
        if (btn !== null && !btn.disabled) btn.click();
      } else {
        const btn = byIdOrNull<HTMLButtonElement>('terminal-dashboard-toggle');
        if (btn !== null && btn.style.display !== 'none') btn.click();
      }
      return 'handled';
    },
  },
  {
    label: 'n: focus draft input (when not editing)',
    match: (e, ctx) => e.key === 'n' && !ctx.isInput,
    run: (e) => {
      e.preventDefault();
      focusDraftInput();
      return 'handled';
    },
  },
  {
    label: 'Delete/Backspace: delete selected tickets',
    match: (e, ctx) => (e.key === 'Delete' || e.key === 'Backspace') && !ctx.isInput && state.selectedIds.size > 0,
    run: (e) => {
      e.preventDefault();
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      void trackedBatch(affected, { ids, action: 'delete' }, 'Delete').then(() => {
        state.selectedIds.clear();
        void loadTickets();
      });
      return 'handled';
    },
  },
  {
    // HS-8418 — guard against browser history-back navigation. In Tauri's
    // WKWebView (and stock browsers) the default action for Backspace /
    // Delete when no editable element owns focus is `history.back()` —
    // which in the Tauri shell unloads the SPA back to the original
    // loading screen, exiting the user out of their session entirely.
    // The "delete selected tickets" entry above already prevents default
    // when selection is non-empty, so this catch-all only kicks in for
    // the no-editable-focus + no-selection case: the keystroke has no
    // app-level meaning, but we must still consume it so the WebView
    // doesn't navigate. Terminal-focused state already routes through
    // xterm directly (xterm's own keydown handler claims the event
    // before this listener) so the gate on `!ctx.isTerminalFocused`
    // here is defensive — it lets the keystroke pass through unchanged
    // if xterm somehow loses its claim mid-event.
    label: 'Delete/Backspace: prevent WebView history-back (HS-8418)',
    match: shouldPreventHistoryBackKey,
    run: (e) => {
      e.preventDefault();
      return 'handled';
    },
  },
];

export function bindKeyboardShortcuts() {
  // Tauri menu events
  window.addEventListener('app:undo', triggerUndo);
  window.addEventListener('app:redo', triggerRedo);
  window.addEventListener('app:preferences', () => byIdOrNull('settings-btn')?.click());
  window.addEventListener('app:open-folder', () => showOpenFolderDialog());
  // HS-8655 — ⌘W (Tauri menu) closes the focused terminal or active project
  // tab, never the OS window. Browser ⌘W can't be intercepted by JS, so this
  // path is Tauri-only; the browser keeps its native close-tab behavior.
  window.addEventListener('app:close-tab', () => { void closeFocusedTabOrProjectTab(); });

  // Keyboard fallback for browser mode (non-Tauri) — capture phase. Kept
  // outside the dispatch table because it has to fire BEFORE the
  // document-level keydown listener (the table) so it can hijack Cmd+Z
  // from a focused input element that has its own undo handling.
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
    // Close any open server-rendered dialog on Escape. Has to run before
    // the HS-8033 modal-bail because that bail returns true for these
    // overlays too — without the early pass they'd never close.
    if (e.key === 'Escape') {
      // HS-8011 — let plain Esc fall through to the focused terminal so
      // programs running there (claude code, vim, less, …) can interrupt
      // / dismiss / cancel. Opt+Esc still routes to Hot Sheet.
      if (shouldEscapeBypassHotsheet(e.target, e.altKey)) return;
      for (const id of ['open-folder-overlay', 'settings-overlay']) {
        const dlg = byIdOrNull(id);
        if (dlg && dlg.style.display !== 'none') {
          dlg.style.display = 'none';
          return;
        }
      }
    }

    // HS-8033 — when any modal dialog is mounted + visible, bail out of
    // every global shortcut. Modals own the keyboard until they're
    // dismissed. Esc above still works because it bails AFTER the
    // server-modal-close pass. Modal-internal shortcuts (e.g. Cmd+Enter
    // to submit) are wired on the input elements directly, so they fire
    // before this document-level listener and aren't affected.
    if (shouldBailForActiveModal(e.target)) return;

    const ctx: KeyContext = {
      isInput: isEditableTarget(e.target),
      isTerminalFocused: isTerminalFocused(),
      isCommandsLogFocused: isCommandsLogFocused(),
    };
    for (const sc of KEYBOARD_SHORTCUTS) {
      if (!sc.match(e, ctx)) continue;
      if (sc.run(e, ctx) === 'handled') return;
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
/**
 * HS-8366 — pure decision function for Cmd/Ctrl+Shift+Arrow when the
 * focused element is determined. Routes the chord to one of four
 * outcomes:
 *
 * - `'project'` — switch project tabs (Opt/Alt variant OR no input
 *   focus, no drawer focus).
 * - `'drawer-tab'` — switch drawer tabs (Cmd+Shift+Arrow when focus is
 *   inside the xterm helper-textarea OR a non-input element of the
 *   commands-log pane).
 * - `'fallthrough'` — no preventDefault, let the chord through. Used
 *   when focus is on a regular text input + no Alt — the browser
 *   handles Cmd+Shift+Arrow for text-selection extension (per macOS
 *   conventions: select to line start / end). Pre-HS-8366 this case
 *   was hijacked into drawer-tab cycling when focus was on the
 *   commands-log search input.
 * - `'fallthrough-alt'` — same outcome as `'fallthrough'` but for the
 *   Opt+Cmd+Shift+Arrow chord on a regular input. The browser handles
 *   it for word-by-word selection extension.
 *
 * Exported so unit tests can pin every cell of the decision matrix
 * without driving the full keyboard handler + projectTabs imports.
 *
 * The xterm helper-textarea is captured by `isTerminalFocused` (matches
 * via the `.xterm` ancestor), NOT by `isInput` alone — so a
 * `isTerminalFocused === true` overrides the regular-input fallthrough:
 * xterm doesn't use Cmd+Shift+Arrow for text selection, and the user
 * expects the chord to cycle drawer tabs from inside the terminal.
 */
export type ShiftArrowTabDecision = 'project' | 'drawer-tab' | 'fallthrough' | 'fallthrough-alt';

export interface ShiftArrowTabContext {
  /** True when focus is on a generic text input (`<input>`, `<textarea>`,
   *  `<select>`, or a `contenteditable` element). The xterm helper-
   *  textarea is ALSO an input by this definition, but
   *  `isTerminalFocused` takes precedence for it (see below). */
  readonly isInput: boolean;
  /** True when focus is inside a `.drawer-terminal-pane` or `.xterm`
   *  subtree — i.e., the xterm helper-textarea or a sibling chrome
   *  element. */
  readonly isTerminalFocused: boolean;
  /** True when the active drawer tab is `commands-log` and the drawer
   *  panel is visible. Set even when focus is on `<body>` inside the
   *  drawer (see `isCommandsLogFocused` JSDoc for the broader contract). */
  readonly isCommandsLogFocused: boolean;
  /** True when the Alt / Option modifier is held alongside Cmd/Ctrl+Shift. */
  readonly isAlt: boolean;
}

export function decideShiftArrowTabAction(ctx: ShiftArrowTabContext): ShiftArrowTabDecision {
  // The xterm helper-textarea is both an "input" AND a terminal-focused
  // surface; xterm doesn't use Cmd+Shift+Arrow for text selection, so
  // it routes to drawer-tab cycling (or project cycling under Alt) just
  // like a non-input focus inside the drawer.
  const inDrawerNonInput = ctx.isTerminalFocused || (ctx.isCommandsLogFocused && !ctx.isInput);
  if (ctx.isAlt) {
    // Opt+Cmd+Shift+Arrow: escape back to project tabs from the drawer,
    // OR switch projects when no input has focus.
    if (!ctx.isInput || inDrawerNonInput) return 'project';
    // Otherwise (Alt held + regular input) — let the browser handle the
    // chord for word-by-word text selection on macOS.
    return 'fallthrough-alt';
  }
  if (inDrawerNonInput) return 'drawer-tab';
  if (!ctx.isInput) return 'project';
  // Regular text input + no Alt — let the browser handle the chord for
  // line-boundary text selection on macOS. This is the HS-8366 carve-
  // out: pre-fix the commands-log search input case fell through to
  // drawer-tab cycling because `isCommandsLogFocused()` returned true
  // for it; now it correctly returns 'fallthrough'.
  return 'fallthrough';
}

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
  // TS6's DOM lib widened `hidden` to `boolean | "until-found"`; `false` is the
  // only "visible" value, so `!== false` means hidden (true or until-found).
  if (el.hidden !== false) return false;
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
  const drawerPanel = byIdOrNull('command-log-panel');
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
 * behavior without running the live keyboard handler.
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

/** HS-8656 — Cmd/Ctrl+Shift+[ / ] tab cycling. Reuses the Cmd+Shift+Arrow
 *  decision (`decideShiftArrowTabAction`) so the brackets behave identically —
 *  drawer/terminal tab when a terminal is focused, project tab otherwise — but
 *  brackets are never a text-selection chord, so a regular-input focus cycles
 *  the project tab rather than falling through to the browser. */
export function cycleTabForBracket(offset: number, e: KeyboardEvent, ctx: KeyContext): void {
  const decision = decideShiftArrowTabAction({
    isInput: ctx.isInput,
    isTerminalFocused: ctx.isTerminalFocused,
    isCommandsLogFocused: ctx.isCommandsLogFocused,
    isAlt: e.altKey,
  });
  if (decision === 'drawer-tab') switchTerminalTabByOffset(offset);
  else switchTabByOffset(offset); // 'project' | 'fallthrough' | 'fallthrough-alt'
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

/**
 * HS-8655 — the target ⌘W should act on. ⌘W must NEVER close the OS window
 * (the Tauri menu routes it here via the `app:close-tab` event instead of the
 * predefined Close-Window item):
 *
 * - `terminal` — a dynamic (closeable) terminal owns focus → close it.
 * - `project`  — no terminal is focused and there's more than one project tab
 *   → close the active one.
 * - `none`     — nothing safely closeable: a configured (persistent) terminal
 *   is focused, or the only project tab would be closed (which would close the
 *   app). ⌘W is a no-op.
 *
 * Pure + injectable so unit tests can pin every cell without a live terminal
 * registry or project store.
 */
export type CloseTabTarget =
  | { readonly kind: 'terminal'; readonly id: string }
  | { readonly kind: 'project' }
  | { readonly kind: 'none' };

export interface CloseTabContext {
  readonly isTerminalFocused: boolean;
  /** `getActiveDrawerTab()` output — `'commands-log'` or `'terminal:<id>'`. */
  readonly activeDrawerTab: string;
  /** `isDynamic(id)` from the terminal registry — only dynamic terminals close. */
  readonly isDynamicTerminal: (id: string) => boolean;
  readonly projectCount: number;
}

export function decideCloseTabTarget(ctx: CloseTabContext): CloseTabTarget {
  if (ctx.isTerminalFocused) {
    // A terminal owns focus → close THAT terminal, but only when it's a
    // dynamic (closeable) one. Configured terminals are persistent and can't
    // be closed (matching the context-menu "Close Tab" gate), so ⌘W is a
    // no-op rather than falling through to close the project tab.
    const prefix = 'terminal:';
    if (ctx.activeDrawerTab.startsWith(prefix)) {
      const id = ctx.activeDrawerTab.slice(prefix.length);
      if (id !== '' && ctx.isDynamicTerminal(id)) return { kind: 'terminal', id };
    }
    return { kind: 'none' };
  }
  // No terminal focused → close the active project tab, but never the last one
  // (closing it would leave no project open — effectively closing the app).
  if (ctx.projectCount > 1) return { kind: 'project' };
  return { kind: 'none' };
}

/**
 * HS-8655 — handler for the Tauri `app:close-tab` event (⌘W). Closes the
 * focused dynamic terminal (its own confirm fires when the PTY is alive) or,
 * when no terminal is focused, the active project tab behind an unconditional
 * confirm. Never closes the OS window.
 */
export async function closeFocusedTabOrProjectTab(): Promise<void> {
  const { isDynamic } = await import('./terminalTabContextMenu.js');
  const target = decideCloseTabTarget({
    isTerminalFocused: isTerminalFocused(),
    activeDrawerTab: getActiveDrawerTab(),
    isDynamicTerminal: isDynamic,
    projectCount: projectsStore.state.value.projects.length,
  });
  if (target.kind === 'terminal') {
    // closeDynamicTerminal shows its own confirm dialog when the PTY is alive.
    const { closeDynamicTerminal } = await import('./terminalInstanceLifecycle.js');
    await closeDynamicTerminal(target.id);
    return;
  }
  if (target.kind === 'project') {
    const active = getActiveProject();
    if (active === null) return;
    const { confirmDialog } = await import('./confirm.js');
    const ok = await confirmDialog({
      title: 'Close Tab?',
      message: `Close the "${active.name}" project tab? Its terminals will be stopped.`,
      confirmLabel: 'Close Tab',
      cancelLabel: 'Cancel',
      danger: true,
    });
    // skipConfirm — we already confirmed here, so removeProject must not
    // re-prompt with its §37 running-terminal confirm.
    if (ok) closeActiveTab(true);
  }
}
