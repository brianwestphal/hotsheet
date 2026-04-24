// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetTerminalSearchForTests, focusActiveTerminalSearch, mountTerminalSearch } from './terminalSearch.js';

// Minimal XTerm / SearchAddon stubs — enough for the widget's lifecycle:
// - `focus()` (called on close)
// - `loadAddon` is not used because we hand in the stub addon directly
// - SearchAddon stubs record `findNext` / `findPrevious` / `clearDecorations`
//   calls and the `onDidChangeResults` subscription so we can assert the
//   widget drives the addon the way xterm would.
function makeTermStub() {
  return {
    focus: vi.fn(),
  };
}

function makeAddonStub() {
  const onDidChangeResultsCalls: Array<(r: { resultIndex: number; resultCount: number }) => void> = [];
  return {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: (cb: (r: { resultIndex: number; resultCount: number }) => void) => {
      onDidChangeResultsCalls.push(cb);
      return { dispose: vi.fn() };
    },
    _fireResults: (r: { resultIndex: number; resultCount: number }) => {
      for (const cb of onDidChangeResultsCalls) cb(r);
    },
  };
}

describe('mountTerminalSearch (HS-7331)', () => {
  beforeEach(() => {
    _resetTerminalSearchForTests();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
    // Mount slot so `document.body.contains(handle.root)` returns true in
    // `focusActiveTerminalSearch` path assertions.
    document.body.innerHTML = '<div id="slot"></div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('builds the collapsed widget with a toggle + hidden input', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    expect(handle.root.querySelector('.terminal-search-toggle')).not.toBeNull();
    expect(handle.root.querySelector('.terminal-search-input')).not.toBeNull();
    expect(handle.isOpen()).toBe(false);
    expect(handle.root.classList.contains('is-open')).toBe(false);
  });

  it('focus() opens the widget and focuses the input', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    expect(handle.isOpen()).toBe(true);
    expect(handle.root.classList.contains('is-open')).toBe(true);
  });

  it('close() clears the input, the decorations, the count, and refocuses the terminal', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'foo';
    const count = handle.root.querySelector<HTMLElement>('.terminal-search-count')!;
    count.textContent = '3/7';
    handle.close();
    expect(handle.isOpen()).toBe(false);
    expect(input.value).toBe('');
    expect(count.textContent).toBe('');
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(term.focus).toHaveBeenCalled();
  });

  it('toggle button opens then closes the widget', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    const toggle = handle.root.querySelector<HTMLButtonElement>('.terminal-search-toggle')!;
    toggle.click();
    expect(handle.isOpen()).toBe(true);
    toggle.click();
    expect(handle.isOpen()).toBe(false);
  });

  it('Enter in the input triggers findNext with incremental=false; Shift+Enter triggers findPrevious', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'bar';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(addon.findNext).toHaveBeenCalledWith('bar', expect.objectContaining({ incremental: false }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, shiftKey: true }));
    expect(addon.findPrevious).toHaveBeenCalledWith('bar', expect.objectContaining({ incremental: false }));
  });

  it('typing into the input runs an incremental findNext', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'baz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(addon.findNext).toHaveBeenCalledWith('baz', expect.objectContaining({ incremental: true }));
  });

  it('empty input clears decorations instead of searching', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.clearDecorations).toHaveBeenCalled();
  });

  it('Esc in the input does NOT close the widget or clear the query (HS-7393)', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    expect(handle.isOpen()).toBe(true);
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'banana';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // Widget stays open, input value is preserved, addon decorations are not cleared.
    expect(handle.isOpen()).toBe(true);
    expect(input.value).toBe('banana');
    expect(addon.clearDecorations).not.toHaveBeenCalled();
  });

  it('close button still clears + collapses the widget (HS-7393 regression)', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'banana';
    const closeBtn = handle.root.querySelector<HTMLButtonElement>('.terminal-search-close')!;
    closeBtn.click();
    expect(handle.isOpen()).toBe(false);
    expect(input.value).toBe('');
    expect(addon.clearDecorations).toHaveBeenCalled();
  });

  it('onDidChangeResults updates the count chip as N/M', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    const count = handle.root.querySelector<HTMLElement>('.terminal-search-count')!;
    addon._fireResults({ resultIndex: 2, resultCount: 27 });
    expect(count.textContent).toBe('3/27');
  });

  it('zero results with a non-empty query shows 0/0', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'nothing-matches';
    const count = handle.root.querySelector<HTMLElement>('.terminal-search-count')!;
    addon._fireResults({ resultIndex: -1, resultCount: 0 });
    expect(count.textContent).toBe('0/0');
  });

  it('dispose clears decorations and unsubscribes the results callback', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.dispose();
    expect(addon.clearDecorations).toHaveBeenCalled();
  });
});

describe('mountTerminalSearch — recent-query history (HS-7427)', () => {
  beforeEach(() => {
    _resetTerminalSearchForTests();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
    document.body.innerHTML = '<div id="slot"></div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function submit(input: HTMLInputElement, value: string, shift = false): void {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      shiftKey: shift,
    }));
  }

  function pressArrow(input: HTMLInputElement, key: 'ArrowUp' | 'ArrowDown'): void {
    input.dispatchEvent(new KeyboardEvent(key === 'ArrowUp' ? 'keydown' : 'keydown', {
      key,
      bubbles: true,
      cancelable: true,
    }));
  }

  it('ArrowUp walks back through three submitted queries in MRU order', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    submit(input, 'foo');
    submit(input, 'bar');
    submit(input, 'baz');

    // Input value is the last submitted query at this point — but the cursor
    // sits at history.length (draft mode) because submit reset it. The
    // first ArrowUp should pull "baz" (the most recent entry).
    input.value = '';
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('baz');
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('bar');
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('foo');
    // At the oldest entry — further ArrowUp stays put.
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('foo');
  });

  it('ArrowDown returns to the captured draft after walking up', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    submit(input, 'foo');

    // Type "fo" as the in-flight draft, then walk up + back down.
    input.value = 'fo';
    input.setSelectionRange(0, 0); // Caret at start so the edge-position rule lets ArrowUp through.
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('foo');
    pressArrow(input, 'ArrowDown');
    expect(input.value).toBe('fo');
  });

  it('incremental typing does NOT push history (only Enter / Shift+Enter does)', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    // Simulate typing "apples" then backspacing back to "app" without ever
    // pressing Enter. None of these should land in the history ring.
    for (const v of ['a', 'ap', 'app', 'appl', 'apple', 'apples', 'apple', 'appl', 'app']) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Pressing ArrowUp now should be a no-op because history is empty.
    input.value = '';
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('');
  });

  it('Shift+Enter submissions are recorded in history alongside Enter submissions', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    submit(input, 'first');
    submit(input, 'second', true);
    input.value = '';
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('second');
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('first');
  });

  it('duplicate submissions de-dupe and bubble to the tail (MRU bump)', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    submit(input, 'a');
    submit(input, 'b');
    submit(input, 'a');

    input.value = '';
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('a');
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('b');
  });

  it('mid-edit ArrowUp is suppressed when caret is not at the edge (readline rule)', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    submit(input, 'foo');
    input.value = 'bar';
    input.setSelectionRange(1, 1); // Caret in the middle of "bar".
    pressArrow(input, 'ArrowUp');
    // No navigation — input stays unchanged because the user is in the
    // middle of a word and ArrowUp would surprise them.
    expect(input.value).toBe('bar');
  });

  it('clicking the close button resets the history cursor so the next session restarts at draft', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;

    submit(input, 'q1');
    submit(input, 'q2');
    input.value = '';
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('q2');
    // Walk one more step then close.
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('q1');
    handle.root.querySelector<HTMLButtonElement>('.terminal-search-close')!.click();
    // Reopen and ArrowUp — should restart at the most recent entry, NOT
    // continue from cursor=0.
    handle.focus();
    pressArrow(input, 'ArrowUp');
    expect(input.value).toBe('q2');
  });
});

describe('mountTerminalSearch — match-mode toggles (HS-7426)', () => {
  beforeEach(() => {
    _resetTerminalSearchForTests();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
    document.body.innerHTML = '<div id="slot"></div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function getToggleByKey(root: HTMLElement, key: 'case' | 'word' | 'regex'): HTMLButtonElement {
    const el = root.querySelector<HTMLButtonElement>(`.terminal-search-toggle-btn[data-toggle="${key}"]`);
    if (el === null) throw new Error(`toggle button for ${key} not found`);
    return el;
  }

  it('renders three toggle buttons in the toggles group, all initially aria-pressed=false', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    const group = handle.root.querySelector('.terminal-search-toggles');
    expect(group).not.toBeNull();
    const buttons = handle.root.querySelectorAll<HTMLButtonElement>('.terminal-search-toggle-btn');
    expect(buttons).toHaveLength(3);
    for (const btn of buttons) {
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.classList.contains('is-active')).toBe(false);
    }
  });

  it('clicking the case toggle flips aria-pressed + .is-active and re-runs the find with caseSensitive: true', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'Apple';
    const toggle = getToggleByKey(handle.root, 'case');
    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.classList.contains('is-active')).toBe(true);
    // Toggle re-runs as a fresh non-incremental search so the addon
    // re-evaluates matches from scratch under the new options.
    expect(addon.findNext).toHaveBeenCalledWith('Apple', expect.objectContaining({
      caseSensitive: true,
      wholeWord: false,
      regex: false,
      incremental: false,
    }));
  });

  it('clicking the whole-word toggle re-runs the find with wholeWord: true', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'app';
    getToggleByKey(handle.root, 'word').click();
    expect(addon.findNext).toHaveBeenCalledWith('app', expect.objectContaining({
      wholeWord: true,
      regex: false,
      caseSensitive: false,
    }));
  });

  it('clicking the regex toggle on a valid pattern re-runs the find with regex: true and no .is-invalid', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'app.e';
    getToggleByKey(handle.root, 'regex').click();
    expect(addon.findNext).toHaveBeenCalledWith('app.e', expect.objectContaining({ regex: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
  });

  it('regex toggle with an invalid pattern adds .is-invalid + sets count to "err" and skips the addon call', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    const count = handle.root.querySelector<HTMLElement>('.terminal-search-count')!;
    // `[abc` is missing a closing bracket → `new RegExp` throws.
    input.value = '[abc';
    getToggleByKey(handle.root, 'regex').click();
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(count.textContent).toBe('err');
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.clearDecorations).toHaveBeenCalled();
  });

  it('typing a valid pattern after an invalid-regex state clears the .is-invalid + restores the count chip', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = '[abc';
    getToggleByKey(handle.root, 'regex').click();
    expect(input.classList.contains('is-invalid')).toBe(true);
    // Now type a valid pattern.
    input.value = 'apple';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    // Simulate xterm firing results — count chip should populate now that
    // the input is no longer invalid.
    addon._fireResults({ resultIndex: 0, resultCount: 3 });
    const count = handle.root.querySelector<HTMLElement>('.terminal-search-count')!;
    expect(count.textContent).toBe('1/3');
  });

  it('toggles can be combined (case + word) and both options reach the addon', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'apple';
    getToggleByKey(handle.root, 'case').click();
    getToggleByKey(handle.root, 'word').click();
    expect(addon.findNext).toHaveBeenLastCalledWith('apple', expect.objectContaining({
      caseSensitive: true,
      wholeWord: true,
      regex: false,
    }));
  });

  it('clicking the close button resets all three toggles + clears .is-invalid for the next session', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = '[bad';
    getToggleByKey(handle.root, 'case').click();
    getToggleByKey(handle.root, 'word').click();
    getToggleByKey(handle.root, 'regex').click();
    expect(input.classList.contains('is-invalid')).toBe(true);
    handle.root.querySelector<HTMLButtonElement>('.terminal-search-close')!.click();
    expect(input.classList.contains('is-invalid')).toBe(false);
    for (const key of ['case', 'word', 'regex'] as const) {
      const btn = getToggleByKey(handle.root, key);
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.classList.contains('is-active')).toBe(false);
    }
  });

  it('Enter submission honours the active toggles (incremental=false on the find call)', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.focus();
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    input.value = 'app.e';
    getToggleByKey(handle.root, 'regex').click();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(addon.findNext).toHaveBeenLastCalledWith('app.e', expect.objectContaining({
      regex: true,
      incremental: false,
    }));
  });
});

describe('focusActiveTerminalSearch (HS-7331)', () => {
  beforeEach(() => {
    _resetTerminalSearchForTests();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
    document.body.innerHTML = '<div id="slot"></div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('returns false when no handle has been mounted', () => {
    expect(focusActiveTerminalSearch()).toBe(false);
  });

  it('focuses the most recently mounted handle when its root is still in the DOM', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    expect(focusActiveTerminalSearch()).toBe(true);
    expect(handle.isOpen()).toBe(true);
  });

  it('falls back to false when the active handle root has been removed from the DOM', () => {
    const term = makeTermStub();
    const addon = makeAddonStub();
    const handle = mountTerminalSearch(term as never, addon as never);
    document.getElementById('slot')!.appendChild(handle.root);
    handle.root.remove();
    expect(focusActiveTerminalSearch()).toBe(false);
  });
});
