// @vitest-environment happy-dom
/**
 * HS-7927 — drawer tab cycling now spans Commands Log + every terminal,
 * not just the terminal tabs (the original HS-6472 behaviour).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  findVisibleModalOverlay,
  isCommandsLogFocused,
  isEditableTarget,
  isElementInTerminal,
  isNewTerminalShortcut,
  MODAL_OVERLAY_SELECTORS,
  pickNextDrawerTabId,
  shouldBailForActiveModal,
  shouldEscapeBypassHotsheet,
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

  function panel(inner: string, displayNone = false): void {
    const styleAttr = displayNone ? ' style="display:none"' : '';
    document.body.innerHTML = `
      <div id="command-log-panel"${styleAttr}>
        ${inner}
      </div>
    `;
  }

  it('returns true when the panel is visible and the active drawer tab is commands-log (default activeTab)', () => {
    panel('<div id="drawer-panel-commands-log"></div>');
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns true regardless of which element has focus, so long as the panel is visible and commands-log is active', () => {
    panel(`
      <div id="drawer-panel-commands-log">
        <input id="command-log-search" />
      </div>
    `);
    (document.getElementById('command-log-search') as HTMLInputElement).focus();
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns true when focus is on body (the user-reported HS-7927 third-follow-up case)', () => {
    panel('<div id="drawer-panel-commands-log"></div>');
    // No element focused — activeElement === body. Pre-fix this returned
    // false and Cmd+Shift+Arrow fell through to project-tab cycling.
    (document.body).focus();
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns false when the drawer panel is hidden (display:none)', () => {
    panel('<div id="drawer-panel-commands-log"></div>', true);
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
    document.body.innerHTML = `<span contenteditable="true">Group name</span>`;
    const span = document.querySelector('span') as HTMLSpanElement;
    expect(isEditableTarget(span)).toBe(true);
  });

  it('returns true for a div nested under a contenteditable ancestor', () => {
    document.body.innerHTML = `
      <div contenteditable="true">
        <div id="nested">child</div>
      </div>
    `;
    const nested = document.getElementById('nested') as HTMLDivElement;
    // isContentEditable propagates to descendants in standard DOM semantics.
    expect(isEditableTarget(nested)).toBe(true);
  });

  it('returns false for a regular non-editable span', () => {
    document.body.innerHTML = `<span>Plain text</span>`;
    const span = document.querySelector('span') as HTMLSpanElement;
    expect(isEditableTarget(span)).toBe(false);
  });

  it('returns false for a button', () => {
    const btn = document.createElement('button');
    expect(isEditableTarget(btn)).toBe(false);
  });

  it('returns false for a contenteditable=false span (explicit opt-out beneath an editable ancestor)', () => {
    document.body.innerHTML = `
      <div contenteditable="true">
        <span id="opt-out" contenteditable="false">Pinned text</span>
      </div>
    `;
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
    document.body.innerHTML = `
      <div class="xterm">
        <textarea id="helper"></textarea>
      </div>
    `;
    const helper = document.getElementById('helper');
    expect(isElementInTerminal(helper)).toBe(true);
  });

  it('returns true for a target inside .drawer-terminal-pane', () => {
    document.body.innerHTML = `
      <div class="drawer-terminal-pane">
        <div id="inside"></div>
      </div>
    `;
    expect(isElementInTerminal(document.getElementById('inside'))).toBe(true);
  });

  it('returns true when the target itself is .xterm', () => {
    document.body.innerHTML = `<div class="xterm" id="root"></div>`;
    expect(isElementInTerminal(document.getElementById('root'))).toBe(true);
  });

  it('returns false for a target outside any terminal container', () => {
    document.body.innerHTML = `
      <div class="some-other-pane">
        <textarea id="t"></textarea>
      </div>
    `;
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
    document.body.innerHTML = `<div class="xterm"><textarea id="t"></textarea></div>`;
    return document.getElementById('t') as EventTarget;
  }
  function outsideTerminal(): EventTarget {
    document.body.innerHTML = `<div class="ticket-list"><input id="search" /></div>`;
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
    document.body.innerHTML = '<div class="ticket-list"></div>';
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('finds the settings overlay by id', () => {
    document.body.innerHTML = '<div id="settings-overlay" style="display:block"></div>';
    const found = findVisibleModalOverlay(document);
    expect(found?.id).toBe('settings-overlay');
  });

  it('finds the open-folder overlay by id', () => {
    document.body.innerHTML = '<div id="open-folder-overlay" style="display:flex"></div>';
    const found = findVisibleModalOverlay(document);
    expect(found?.id).toBe('open-folder-overlay');
  });

  it('skips an overlay whose inline display is "none"', () => {
    document.body.innerHTML = '<div id="settings-overlay" style="display:none"></div>';
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('finds class-based dialog backdrops (confirm-dialog-overlay)', () => {
    document.body.innerHTML = '<div class="confirm-dialog-overlay"></div>';
    const found = findVisibleModalOverlay(document);
    expect(found?.classList.contains('confirm-dialog-overlay')).toBe(true);
  });

  it('finds class-based dialog backdrops (feedback-dialog-overlay)', () => {
    document.body.innerHTML = '<div class="feedback-dialog-overlay"></div>';
    const found = findVisibleModalOverlay(document);
    expect(found?.classList.contains('feedback-dialog-overlay')).toBe(true);
  });

  it('finds class-based dialog backdrops (quit-confirm-overlay)', () => {
    document.body.innerHTML = '<div class="quit-confirm-overlay"></div>';
    const found = findVisibleModalOverlay(document);
    expect(found?.classList.contains('quit-confirm-overlay')).toBe(true);
  });

  it('skips a hidden element via the `hidden` attribute', () => {
    document.body.innerHTML = '<div class="confirm-dialog-overlay" hidden></div>';
    expect(findVisibleModalOverlay(document)).toBe(null);
  });

  it('does NOT match popups that are intentionally non-modal', () => {
    // Terminal-prompt overlay, permission popup, context menu — all
    // popups, not modals. They should NOT trigger the bail because they
    // don't take focus from the underlying surface.
    document.body.innerHTML = `
      <div class="terminal-prompt-overlay"></div>
      <div class="permission-popup"></div>
      <div class="context-menu"></div>
    `;
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
    document.body.innerHTML = '<div class="ticket-list"><div id="ticket-row"></div></div>';
    expect(shouldBailForActiveModal(document.getElementById('ticket-row'))).toBe(false);
  });

  it('returns true when a modal is open and the target is OUTSIDE it', () => {
    document.body.innerHTML = `
      <div class="ticket-list"><div id="ticket-row"></div></div>
      <div class="confirm-dialog-overlay"><button>OK</button></div>
    `;
    expect(shouldBailForActiveModal(document.getElementById('ticket-row'))).toBe(true);
  });

  it('returns true when a modal is open and the target is INSIDE it', () => {
    document.body.innerHTML = `
      <div class="confirm-dialog-overlay"><input id="cancel-input" /></div>
    `;
    // Bail either way — focus inside the modal still wants the modal's
    // own per-element handlers to win, not the global ones.
    expect(shouldBailForActiveModal(document.getElementById('cancel-input'))).toBe(true);
  });

  it('returns false for a null target with no modal open', () => {
    document.body.innerHTML = '';
    expect(shouldBailForActiveModal(null)).toBe(false);
  });

  it('returns true for a null target when a modal IS open (defensive bail)', () => {
    document.body.innerHTML = '<div class="confirm-dialog-overlay"></div>';
    expect(shouldBailForActiveModal(null)).toBe(true);
  });

  it('does NOT bail for a non-modal popup like .terminal-prompt-overlay', () => {
    document.body.innerHTML = `
      <div class="ticket-list"><div id="ticket-row"></div></div>
      <div class="terminal-prompt-overlay"><button>Allow</button></div>
    `;
    expect(shouldBailForActiveModal(document.getElementById('ticket-row'))).toBe(false);
  });
});
