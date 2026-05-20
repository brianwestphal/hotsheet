// @vitest-environment happy-dom
/**
 * HS-7927 — drawer tab cycling now spans Commands Log + every terminal,
 * not just the terminal tabs (the original HS-6472 behavior).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { toElement } from './dom.js';
import type { KeyContext } from './shortcuts.js';
import {
  decideShiftArrowTabAction,
  findVisibleModalOverlay,
  isCommandsLogFocused,
  isEditableTarget,
  isElementInTerminal,
  isNewTerminalShortcut,
  MODAL_OVERLAY_SELECTORS,
  pickNextDrawerTabId,
  shouldBailForActiveModal,
  shouldEscapeBypassHotsheet,
  shouldPreventHistoryBackKey,
} from './shortcuts.js';

describe('isNewTerminalShortcut (HS-7926)', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 't' };

  it('matches Cmd+T (macOS)', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true })).toBe(true);
  });

  it('matches Ctrl+T (Windows/Linux)', () => {
    expect(isNewTerminalShortcut({ ...base, ctrlKey: true })).toBe(true);
  });

  it('is case-insensitive on the T letter', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, key: 'T' })).toBe(true);
  });

  it('rejects Cmd+Shift+T (reserved by browsers for "reopen closed tab")', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, shiftKey: true })).toBe(false);
  });

  it('rejects Cmd+Alt+T (reserved for future variant)', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, altKey: true })).toBe(false);
  });

  it('rejects bare T (no modifier — would steal typing)', () => {
    expect(isNewTerminalShortcut(base)).toBe(false);
  });

  it('rejects other letters even with the right modifier', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, key: 'r' })).toBe(false);
  });
});

describe('pickNextDrawerTabId (HS-7927)', () => {
  it('cycles forward through every drawer tab including commands-log', () => {
    const tabs = [
      { active: true, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
      { active: false, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, 1)).toBe('terminal:a');
  });

  it('cycles backward and wraps from commands-log to the last terminal', () => {
    const tabs = [
      { active: true, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
      { active: false, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, -1)).toBe('terminal:b');
  });

  it('forward-wraps from the last terminal back to commands-log', () => {
    const tabs = [
      { active: false, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
      { active: true, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, 1)).toBe('commands-log');
  });

  it('lands on commands-log when stepping back from the first terminal — the HS-7927 user-reported gap', () => {
    // Pre-fix this configuration would have wrapped 'terminal:a' → 'terminal:b'
    // because commands-log was excluded from the cycle.
    const tabs = [
      { active: false, tabId: 'commands-log' },
      { active: true, tabId: 'terminal:a' },
      { active: false, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, -1)).toBe('commands-log');
  });

  it('returns null when there are fewer than two cyclable tabs (single-tab no-op)', () => {
    expect(pickNextDrawerTabId([{ active: true, tabId: 'commands-log' }], 1)).toBeNull();
    expect(pickNextDrawerTabId([], 1)).toBeNull();
  });

  it('starts from tab 0 when nothing is currently active', () => {
    const tabs = [
      { active: false, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
    ];
    expect(pickNextDrawerTabId(tabs, 1)).toBe('terminal:a');
  });
});

// HS-7927 third follow-up — predicate is now keyed on `getActiveDrawerTab()`
// + drawer panel visibility, not on which DOM element happens to have focus.
// `getActiveDrawerTab()` defaults to `'commands-log'` (the initial value in
// `commandLog.tsx::activeTab`), which is what we exploit in the visible-panel
// tests below; the negative cases mark a different drawer tab as `.active`
// to drive the fallback path that disagrees with `getActiveDrawerTab()`.
describe('isCommandsLogFocused (HS-7927 follow-up)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // HS-8467 — panel() takes a JSX child instead of an HTML string so the
  // entire fixture is typed.
  function panel(inner: HTMLElement, displayNone = false): void {
    const root = displayNone
      ? toElement(<div id="command-log-panel" style="display:none"></div>)
      : toElement(<div id="command-log-panel"></div>);
    root.appendChild(inner);
    document.body.replaceChildren(root);
  }

  it('returns true when the panel is visible and the active drawer tab is commands-log (default activeTab)', () => {
    panel(toElement(<div id="drawer-panel-commands-log"></div>));
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns true regardless of which element has focus, so long as the panel is visible and commands-log is active', () => {
    panel(toElement(
      <div id="drawer-panel-commands-log">
        <input id="command-log-search" />
      </div>
    ));
    (document.getElementById('command-log-search') as HTMLInputElement).focus();
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns true when focus is on body (the user-reported HS-7927 third-follow-up case)', () => {
    panel(toElement(<div id="drawer-panel-commands-log"></div>));
    // No element focused — activeElement === body. Pre-fix this returned
    // false and Cmd+Shift+Arrow fell through to project-tab cycling.
    (document.body).focus();
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns false when the drawer panel is hidden (display:none)', () => {
    panel(toElement(<div id="drawer-panel-commands-log"></div>), true);
    expect(isCommandsLogFocused()).toBe(false);
  });

  it('returns false when the drawer panel is missing entirely', () => {
    document.body.innerHTML = '';
    expect(isCommandsLogFocused()).toBe(false);
  });
});

// HS-7978 — Cmd+A inside a contenteditable span (e.g. the custom-command-group
// name) used to fall through to "select all tickets" because the isInput gate
// only checked tag names. The user did Cmd+A → Backspace and accidentally
// deleted every ticket in the project. The fix extracts an `isEditableTarget`
// helper that also returns true for any element with `isContentEditable`.
describe('isEditableTarget (HS-7978)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true for INPUT elements', () => {
    const input = document.createElement('input');
    expect(isEditableTarget(input)).toBe(true);
  });

  it('returns true for TEXTAREA elements', () => {
    const ta = document.createElement('textarea');
    expect(isEditableTarget(ta)).toBe(true);
  });

  it('returns true for SELECT elements', () => {
    const sel = document.createElement('select');
    expect(isEditableTarget(sel)).toBe(true);
  });

  it('returns true for a contenteditable=true span (the custom-command-group rename case)', () => {
    document.body.replaceChildren(toElement(<span contenteditable="true">Group name</span>));
    const span = document.querySelector('span') as HTMLSpanElement;
    expect(isEditableTarget(span)).toBe(true);
  });

  it('returns true for a div nested under a contenteditable ancestor', () => {
    document.body.replaceChildren(toElement(
      <div contenteditable="true">
        <div id="nested">child</div>
      </div>
    ));
    const nested = document.getElementById('nested') as HTMLDivElement;
    // isContentEditable propagates to descendants in standard DOM semantics.
    expect(isEditableTarget(nested)).toBe(true);
  });

  it('returns false for a regular non-editable span', () => {
    document.body.replaceChildren(toElement(<span>Plain text</span>));
    const span = document.querySelector('span') as HTMLSpanElement;
    expect(isEditableTarget(span)).toBe(false);
  });

  it('returns false for a button', () => {
    const btn = document.createElement('button');
    expect(isEditableTarget(btn)).toBe(false);
  });

  it('returns false for a contenteditable=false span (explicit opt-out beneath an editable ancestor)', () => {
    document.body.replaceChildren(toElement(
      <div contenteditable="true">
        <span id="opt-out" contenteditable="false">Pinned text</span>
      </div>
    ));
    const span = document.getElementById('opt-out') as HTMLSpanElement;
    expect(isEditableTarget(span)).toBe(false);
  });

  it('returns false for null target (no event target)', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('returns false for non-HTMLElement targets (e.g. window, document)', () => {
    expect(isEditableTarget(window as unknown as EventTarget)).toBe(false);
  });
});

// HS-8011 — plain Esc inside a focused terminal must bypass Hot Sheet's
// global Esc handlers so the running program (claude code, vim, less, …)
// receives the keystroke. Opt+Esc still routes to Hot Sheet so the user
// can blur / exit dashboard / etc. without first clicking out of xterm.
describe('isElementInTerminal (HS-8011)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true for a target inside a .xterm container', () => {
    document.body.replaceChildren(toElement(
      <div className="xterm">
        <textarea id="helper"></textarea>
      </div>
    ));
    const helper = document.getElementById('helper');
    expect(isElementInTerminal(helper)).toBe(true);
  });

  it('returns true for a target inside .drawer-terminal-pane', () => {
    document.body.replaceChildren(toElement(
      <div className="drawer-terminal-pane">
        <div id="inside"></div>
      </div>
    ));
    expect(isElementInTerminal(document.getElementById('inside'))).toBe(true);
  });

  it('returns true when the target itself is .xterm', () => {
    document.body.replaceChildren(toElement(<div className="xterm" id="root"></div>));
    expect(isElementInTerminal(document.getElementById('root'))).toBe(true);
  });

  it('returns false for a target outside any terminal container', () => {
    document.body.replaceChildren(toElement(
      <div className="some-other-pane">
        <textarea id="t"></textarea>
      </div>
    ));
    expect(isElementInTerminal(document.getElementById('t'))).toBe(false);
  });

  it('returns false for a non-HTMLElement target (e.g. document, window)', () => {
    expect(isElementInTerminal(document as unknown as EventTarget)).toBe(false);
    expect(isElementInTerminal(window as unknown as EventTarget)).toBe(false);
  });

  it('returns false for null target', () => {
    expect(isElementInTerminal(null)).toBe(false);
  });
});

describe('shouldEscapeBypassHotsheet (HS-8011)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function inTerminal(): EventTarget {
    document.body.replaceChildren(toElement(<div className="xterm"><textarea id="t"></textarea></div>));
    return document.getElementById('t') as EventTarget;
  }
  function outsideTerminal(): EventTarget {
    document.body.replaceChildren(toElement(<div className="ticket-list"><input id="search" /></div>));
    return document.getElementById('search') as EventTarget;
  }

  it('returns true when terminal is focused and Alt is NOT pressed (plain Esc → terminal)', () => {
    expect(shouldEscapeBypassHotsheet(inTerminal(), false)).toBe(true);
  });

  it('returns false when terminal is focused but Alt IS pressed (Opt+Esc → Hot Sheet)', () => {
    expect(shouldEscapeBypassHotsheet(inTerminal(), true)).toBe(false);
  });

  it('returns false when terminal is NOT focused, regardless of Alt (Hot Sheet handles)', () => {
    expect(shouldEscapeBypassHotsheet(outsideTerminal(), false)).toBe(false);
    expect(shouldEscapeBypassHotsheet(outsideTerminal(), true)).toBe(false);
  });

  it('returns false for a null target (defensive — no element to check)', () => {
    expect(shouldEscapeBypassHotsheet(null, false)).toBe(false);
  });
});

// HS-8033 — when a modal dialog is open, Cmd+A (and friends) used to fall
// through to the global "select all tickets" handler because the isInput
// gate only checked for input/textarea/select/contenteditable. Focus
// outside a modal's text input — for example clicking a Save button in a
// confirm dialog — left the document.activeElement on the dialog backdrop
// instead, so isEditableTarget returned false and Cmd+A grabbed every
// ticket behind the modal. The fix: bail every global shortcut when ANY
// modal overlay is mounted + visible.
describe('findVisibleModalOverlay (HS-8033)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns null when no modal overlay is mounted', () => {
    document.body.replaceChildren(toElement(<div className="ticket-list"></div>));
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('finds the settings overlay by id', () => {
    document.body.replaceChildren(toElement(<div id="settings-overlay" style="display:block"></div>));
    const found = findVisibleModalOverlay(document);
    expect(found?.id).toBe('settings-overlay');
  });

  it('finds the open-folder overlay by id', () => {
    document.body.replaceChildren(toElement(<div id="open-folder-overlay" style="display:flex"></div>));
    const found = findVisibleModalOverlay(document);
    expect(found?.id).toBe('open-folder-overlay');
  });

  it('skips an overlay whose inline display is "none"', () => {
    document.body.replaceChildren(toElement(<div id="settings-overlay" style="display:none"></div>));
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('finds class-based dialog backdrops (confirm-dialog-overlay)', () => {
    document.body.replaceChildren(toElement(<div className="confirm-dialog-overlay"></div>));
    const found = findVisibleModalOverlay(document);
    expect(found?.classList.contains('confirm-dialog-overlay')).toBe(true);
  });

  it('finds class-based dialog backdrops (feedback-dialog-overlay)', () => {
    document.body.replaceChildren(toElement(<div className="feedback-dialog-overlay"></div>));
    const found = findVisibleModalOverlay(document);
    expect(found?.classList.contains('feedback-dialog-overlay')).toBe(true);
  });

  it('finds class-based dialog backdrops (quit-confirm-overlay)', () => {
    document.body.replaceChildren(toElement(<div className="quit-confirm-overlay"></div>));
    const found = findVisibleModalOverlay(document);
    expect(found?.classList.contains('quit-confirm-overlay')).toBe(true);
  });

  it('skips a hidden element via the `hidden` attribute', () => {
    document.body.replaceChildren(toElement(<div className="confirm-dialog-overlay" hidden></div>));
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('does NOT match popups that are intentionally non-modal', () => {
    // Terminal-prompt overlay, permission popup, context menu — all
    // popups, not modals. They should NOT trigger the bail because they
    // don't take focus from the underlying surface.
    document.body.replaceChildren(
      toElement(<div className="terminal-prompt-overlay"></div>),
      toElement(<div className="permission-popup"></div>),
      toElement(<div className="context-menu"></div>),
    );
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('exposes a non-empty selectors registry', () => {
    expect(MODAL_OVERLAY_SELECTORS.length).toBeGreaterThanOrEqual(10);
    // At minimum we need the two server-rendered overlays + confirm + feedback.
    expect(MODAL_OVERLAY_SELECTORS).toContain('#settings-overlay');
    expect(MODAL_OVERLAY_SELECTORS).toContain('#open-folder-overlay');
    expect(MODAL_OVERLAY_SELECTORS).toContain('.confirm-dialog-overlay');
    expect(MODAL_OVERLAY_SELECTORS).toContain('.feedback-dialog-overlay');
  });
});

describe('shouldBailForActiveModal (HS-8033)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns false when no modal is open', () => {
    document.body.replaceChildren(toElement(<div className="ticket-list"><div id="ticket-row"></div></div>));
    expect(shouldBailForActiveModal(document.getElementById('ticket-row'))).toBe(false);
  });

  it('returns true when a modal is open and the target is OUTSIDE it', () => {
    document.body.replaceChildren(
      toElement(<div className="ticket-list"><div id="ticket-row"></div></div>),
      toElement(<div className="confirm-dialog-overlay"><button>OK</button></div>),
    );
    expect(shouldBailForActiveModal(document.getElementById('ticket-row'))).toBe(true);
  });

  it('returns true when a modal is open and the target is INSIDE it', () => {
    document.body.replaceChildren(toElement(
      <div className="confirm-dialog-overlay"><input id="cancel-input" /></div>
    ));
    // Bail either way — focus inside the modal still wants the modal's
    // own per-element handlers to win, not the global ones.
    expect(shouldBailForActiveModal(document.getElementById('cancel-input'))).toBe(true);
  });

  it('returns false for a null target with no modal open', () => {
    document.body.innerHTML = '';
    expect(shouldBailForActiveModal(null)).toBe(false);
  });

  it('returns true for a null target when a modal IS open (defensive bail)', () => {
    document.body.replaceChildren(toElement(<div className="confirm-dialog-overlay"></div>));
    expect(shouldBailForActiveModal(null)).toBe(true);
  });

  it('does NOT bail for a non-modal popup like .terminal-prompt-overlay', () => {
    document.body.replaceChildren(
      toElement(<div className="ticket-list"><div id="ticket-row"></div></div>),
      toElement(<div className="terminal-prompt-overlay"><button>Allow</button></div>),
    );
    expect(shouldBailForActiveModal(document.getElementById('ticket-row'))).toBe(false);
  });
});

describe('decideShiftArrowTabAction (HS-8366)', () => {
  // HS-8366 — pre-fix the commands-log search input (a regular text
  // input that happens to live inside a panel where
  // `isCommandsLogFocused()` returns true) had Cmd+Shift+Arrow stolen
  // for drawer-tab cycling instead of being used for text-selection
  // extension. This describe block pins every cell of the decision
  // matrix so a future refactor of the carve-out is caught.

  const base = { isInput: false, isTerminalFocused: false, isCommandsLogFocused: false, isAlt: false };

  describe('no Alt modifier (Cmd+Shift+Arrow)', () => {
    it('returns "fallthrough" for a regular input outside any drawer (e.g. ticket title input)', () => {
      expect(decideShiftArrowTabAction({ ...base, isInput: true })).toBe('fallthrough');
    });

    it('returns "fallthrough" for the commands-log SEARCH INPUT — the HS-8366 regression target', () => {
      // The exact bug shape: focus is on a regular input (`isInput`
      // true) AND `isCommandsLogFocused` returns true (because the
      // active drawer tab is commands-log). Pre-fix this returned
      // "drawer-tab" and stole Cmd+Shift+Arrow from the search field;
      // post-fix the regular-input check wins and the browser handles
      // the chord for line-boundary selection.
      expect(decideShiftArrowTabAction({
        ...base,
        isInput: true,
        isCommandsLogFocused: true,
      })).toBe('fallthrough');
    });

    it('returns "drawer-tab" for the xterm helper-textarea (isInput=true AND isTerminalFocused=true — terminal wins)', () => {
      // The xterm helper-textarea is a TEXTAREA so `isInput` is true,
      // BUT xterm doesn't use Cmd+Shift+Arrow for text selection — we
      // want the existing drawer-tab cycling behavior. The
      // `isTerminalFocused` check takes precedence over the regular-
      // input fallthrough.
      expect(decideShiftArrowTabAction({
        ...base,
        isInput: true,
        isTerminalFocused: true,
      })).toBe('drawer-tab');
    });

    it('returns "drawer-tab" for a non-input element inside the commands-log pane (e.g. focus on <body> after a click on a log row)', () => {
      expect(decideShiftArrowTabAction({
        ...base,
        isInput: false,
        isCommandsLogFocused: true,
      })).toBe('drawer-tab');
    });

    it('returns "project" when no input has focus and no drawer signal is set', () => {
      expect(decideShiftArrowTabAction(base)).toBe('project');
    });
  });

  describe('Alt modifier held (Opt+Cmd+Shift+Arrow)', () => {
    it('returns "project" when no input is focused', () => {
      expect(decideShiftArrowTabAction({ ...base, isAlt: true })).toBe('project');
    });

    it('returns "project" when focus is in a terminal (Opt-escape from xterm to project tabs)', () => {
      expect(decideShiftArrowTabAction({
        ...base,
        isAlt: true,
        isInput: true,
        isTerminalFocused: true,
      })).toBe('project');
    });

    it('returns "project" when focus is in a non-input commands-log element (Opt-escape from drawer to project tabs)', () => {
      expect(decideShiftArrowTabAction({
        ...base,
        isAlt: true,
        isCommandsLogFocused: true,
      })).toBe('project');
    });

    it('returns "fallthrough-alt" for a regular input + Alt — browser handles word-by-word selection', () => {
      // HS-8366 — Opt+Cmd+Shift+Arrow on macOS extends selection by
      // word. Pre-fix this case fell into the same drawer-tab hijack
      // as plain Cmd+Shift+Arrow for the commands-log search input;
      // post-fix the chord falls through to the browser.
      expect(decideShiftArrowTabAction({
        ...base,
        isAlt: true,
        isInput: true,
      })).toBe('fallthrough-alt');
    });

    it('returns "fallthrough-alt" for the commands-log search input + Alt (mirror of the plain-Cmd+Shift+Arrow case)', () => {
      expect(decideShiftArrowTabAction({
        ...base,
        isAlt: true,
        isInput: true,
        isCommandsLogFocused: true,
      })).toBe('fallthrough-alt');
    });
  });
});

// HS-8418 — Backspace / Delete with no editable surface focused triggers the
// WebView's default `history.back()` action, unloading the Tauri shell back
// to its loading screen. The catch-all shortcut at the end of
// KEYBOARD_SHORTCUTS consumes the keystroke when no other handler claims it;
// this describe block pins the truth table for the gating predicate so a
// future refactor that splits the helper apart can't silently regress the
// guard.
describe('shouldPreventHistoryBackKey (HS-8418)', () => {
  const noFocusCtx: KeyContext = { isInput: false, isTerminalFocused: false, isCommandsLogFocused: false };
  const inputCtx: KeyContext = { isInput: true, isTerminalFocused: false, isCommandsLogFocused: false };
  const terminalCtx: KeyContext = { isInput: false, isTerminalFocused: true, isCommandsLogFocused: false };

  function ev(key: string): KeyboardEvent {
    return new KeyboardEvent('keydown', { key });
  }

  it('returns true for Backspace with no editable focus and no terminal focus', () => {
    expect(shouldPreventHistoryBackKey(ev('Backspace'), noFocusCtx)).toBe(true);
  });

  it('returns true for Delete with no editable focus and no terminal focus', () => {
    expect(shouldPreventHistoryBackKey(ev('Delete'), noFocusCtx)).toBe(true);
  });

  it('returns false for Backspace when an editable element owns focus (the user is typing)', () => {
    expect(shouldPreventHistoryBackKey(ev('Backspace'), inputCtx)).toBe(false);
  });

  it('returns false for Delete when an editable element owns focus', () => {
    expect(shouldPreventHistoryBackKey(ev('Delete'), inputCtx)).toBe(false);
  });

  it('returns false when a terminal is focused so xterm receives the keystroke unchanged', () => {
    expect(shouldPreventHistoryBackKey(ev('Backspace'), terminalCtx)).toBe(false);
    expect(shouldPreventHistoryBackKey(ev('Delete'), terminalCtx)).toBe(false);
  });

  it('returns false for keys other than Backspace / Delete', () => {
    expect(shouldPreventHistoryBackKey(ev('a'), noFocusCtx)).toBe(false);
    expect(shouldPreventHistoryBackKey(ev('Enter'), noFocusCtx)).toBe(false);
    expect(shouldPreventHistoryBackKey(ev('ArrowLeft'), noFocusCtx)).toBe(false);
    expect(shouldPreventHistoryBackKey(ev('Escape'), noFocusCtx)).toBe(false);
  });
});
