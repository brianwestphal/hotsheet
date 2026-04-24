/**
 * Shared terminal search UI (HS-7331). Mounts a collapsible search box that
 * wraps xterm's SearchAddon so the drawer terminal, the dashboard dedicated
 * view, and any future xterm surface can share one expandable find widget.
 *
 * Layout (collapsed): a single `.terminal-search-toggle` button with a
 * magnifier icon. Layout (expanded): the same toggle + an input, a
 * prev/next pair, a result-count indicator, and an explicit close button.
 * Expansion is CSS-driven via `.is-open` (same pattern as the app header's
 * `.search-box` `.has-value` / `:focus-within` rules) so the transition can
 * be tuned without JS.
 *
 * The exported `mountTerminalSearch(term, addon, opts)` helper builds the
 * markup, attaches every handler, and returns a `TerminalSearchHandle` that
 * the caller places inside the terminal toolbar (drawer) or the app header
 * (dedicated view). Callers drive focus via `.focus()` (Cmd/Ctrl+F dispatch
 * reaches here through `focusActiveTerminalSearch()` below).
 *
 * A module-level `activeHandle` is kept in sync with the user's focus so
 * `focusActiveTerminalSearch()` can route Cmd/Ctrl+F to whichever terminal
 * search is currently relevant (drawer vs. dedicated) without the caller
 * having to know which xterm surface owns focus.
 */
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';

const SEARCH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const CHEVRON_UP = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export interface TerminalSearchHandle {
  root: HTMLElement;
  focus(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export interface MountTerminalSearchOptions {
  placeholder?: string;
}

/** Module-level tracker: the search handle whose terminal owns keyboard
 *  focus, or was most recently focused. Used by
 *  `focusActiveTerminalSearch()` to route Cmd/Ctrl+F to the right widget
 *  without the caller needing to know which xterm is in focus. Callers
 *  register themselves by passing their host xterm below. */
const handlesByTerm = new WeakMap<XTerm, TerminalSearchHandle>();
let lastActiveHandle: TerminalSearchHandle | null = null;

export function mountTerminalSearch(
  term: XTerm,
  addon: SearchAddon,
  opts: MountTerminalSearchOptions = {},
): TerminalSearchHandle {
  const placeholder = opts.placeholder ?? 'Search';
  const root = toElement(
    <div className="terminal-search-box" role="search">
      <button type="button" className="terminal-search-toggle" title="Search (Cmd/Ctrl+F)" aria-label="Open search">
        {raw(SEARCH_ICON)}
      </button>
      <input
        type="text"
        className="terminal-search-input"
        placeholder={placeholder}
        aria-label={placeholder}
        spellcheck="false"
        autocomplete="off"
      />
      <span className="terminal-search-count" aria-live="polite"></span>
      <button type="button" className="terminal-search-btn terminal-search-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">
        {raw(CHEVRON_UP)}
      </button>
      <button type="button" className="terminal-search-btn terminal-search-next" title="Next match (Enter)" aria-label="Next match">
        {raw(CHEVRON_DOWN)}
      </button>
      <button type="button" className="terminal-search-btn terminal-search-close" title="Close search" aria-label="Close search">
        {raw(CLOSE_ICON)}
      </button>
    </div>,
  );
  const toggle = root.querySelector<HTMLButtonElement>('.terminal-search-toggle');
  const input = root.querySelector<HTMLInputElement>('.terminal-search-input');
  const count = root.querySelector<HTMLSpanElement>('.terminal-search-count');
  const prev = root.querySelector<HTMLButtonElement>('.terminal-search-prev');
  const next = root.querySelector<HTMLButtonElement>('.terminal-search-next');
  const close = root.querySelector<HTMLButtonElement>('.terminal-search-close');
  if (toggle === null || input === null || count === null || prev === null || next === null || close === null) {
    throw new Error('terminal-search: failed to mount — missing expected elements');
  }

  // Match-highlight colours deliberately use amber / orange rather than the
  // app accent blue so matches remain distinct from the active-selection
  // highlight (HS-7330 selection uses `--accent` at 40/20 % alpha) when a
  // user has both a live selection and an ongoing search.
  const searchOptions = {
    decorations: {
      matchBackground: '#f59e0b66',
      matchBorder: '#f59e0b',
      matchOverviewRuler: '#f59e0b',
      activeMatchBackground: '#f97316cc',
      activeMatchBorder: '#ea580c',
      activeMatchColorOverviewRuler: '#ea580c',
    },
  };

  const openBox = (): void => {
    root.classList.add('is-open');
    requestAnimationFrame(() => { input.focus(); input.select(); });
    lastActiveHandle = handle;
  };
  const closeBox = (): void => {
    root.classList.remove('is-open');
    input.value = '';
    try { addon.clearDecorations(); } catch { /* addon may be already disposed */ }
    count.textContent = '';
    try { term.focus(); } catch { /* term disposed */ }
  };
  const doFind = (direction: 'next' | 'prev', incremental: boolean): void => {
    const q = input.value;
    if (q.length === 0) {
      try { addon.clearDecorations(); } catch { /* addon disposed */ }
      count.textContent = '';
      return;
    }
    const sOpts = { ...searchOptions, incremental };
    try {
      if (direction === 'next') addon.findNext(q, sOpts);
      else addon.findPrevious(q, sOpts);
    } catch { /* addon disposed between UI event and invocation */ }
  };

  toggle.addEventListener('click', () => {
    if (root.classList.contains('is-open')) closeBox(); else openBox();
  });
  input.addEventListener('input', () => { doFind('next', true); });
  input.addEventListener('focus', () => { lastActiveHandle = handle; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doFind(e.shiftKey ? 'prev' : 'next', false);
    }
    // HS-7393 — Esc used to `closeBox()` which also cleared the input. The
    // ticket requires Esc to only lose focus without clearing; the global
    // keydown handler in `shortcuts.tsx` blurs any focused input on Esc.
    // Users collapse / clear the widget explicitly via the close (×) button
    // or the magnifier toggle.
  });
  prev.addEventListener('click', () => { doFind('prev', false); input.focus(); });
  next.addEventListener('click', () => { doFind('next', false); input.focus(); });
  close.addEventListener('click', () => { closeBox(); });

  // SearchAddon fires onDidChangeResults after every find — update the count
  // chip so the user can see "1/27" etc. Guarded with null-check because
  // older xterm builds or partial-stub tests might not have it.
  const changeSub = typeof addon.onDidChangeResults === 'function'
    ? addon.onDidChangeResults((r) => {
      if (r.resultCount > 0) {
        count.textContent = `${r.resultIndex + 1}/${r.resultCount}`;
      } else if (input.value.length > 0) {
        count.textContent = '0/0';
      } else {
        count.textContent = '';
      }
    })
    : null;

  const handle: TerminalSearchHandle = {
    root,
    focus: () => { openBox(); },
    close: () => { closeBox(); },
    isOpen: () => root.classList.contains('is-open'),
    dispose: () => {
      try { changeSub?.dispose(); } catch { /* ignore */ }
      try { addon.clearDecorations(); } catch { /* ignore */ }
      handlesByTerm.delete(term);
      if (lastActiveHandle === handle) lastActiveHandle = null;
    },
  };
  handlesByTerm.set(term, handle);
  lastActiveHandle = handle;
  return handle;
}

/** Cmd/Ctrl+F dispatch target. Returns true if a terminal search was
 *  actually focused (so the global shortcut handler can skip the app-wide
 *  ticket search as a fall-through). */
export function focusActiveTerminalSearch(): boolean {
  if (lastActiveHandle === null) return false;
  if (!document.body.contains(lastActiveHandle.root)) {
    // The handle's host element was torn down (project switch, drawer
    // closed, dedicated view exited) without its `.dispose()` having run
    // — let subsequent calls fall back to the ticket search.
    lastActiveHandle = null;
    return false;
  }
  lastActiveHandle.focus();
  return true;
}

/** Test seam — exported so unit tests can reset module state between
 *  cases. Not intended for production callers. */
export function _resetTerminalSearchForTests(): void {
  lastActiveHandle = null;
}
