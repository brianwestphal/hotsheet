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
