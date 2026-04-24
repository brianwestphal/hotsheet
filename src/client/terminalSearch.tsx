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
import { navigateHistory, pushHistory } from './terminalSearchHistory.js';

const SEARCH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const CHEVRON_UP = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
// HS-7426 — three Lucide icons for the toggle row, paths drawn from
// `lucide-icons.json` so they stay in sync with the rest of the app's
// iconography. Rendered at 12px to fit the existing toolbar button budget.
const CASE_SENSITIVE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"/><path d="M22 9v7"/><path d="M3.304 13h6.392"/><circle cx="18.5" cy="12.5" r="3.5"/></svg>';
const WHOLE_WORD_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="12" r="3"/><path d="M10 9v6"/><circle cx="17" cy="12" r="3"/><path d="M14 7v8"/><path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"/></svg>';
const REGEX_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/></svg>';

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

/** HS-7427 — per-xterm recent-query ring. Session-only: when an xterm is
 *  garbage-collected (PTY restart, drawer-tab destroy) the WeakMap entry
 *  is reclaimed automatically, so history naturally resets without an
 *  explicit teardown hook. See `docs/34-terminal-search.md` §34.9. */
const historyByTerm = new WeakMap<XTerm, string[]>();

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
      <span className="terminal-search-toggles" role="group" aria-label="Search options">
        <button type="button" className="terminal-search-btn terminal-search-toggle-btn" data-toggle="case" title="Match case" aria-label="Match case" aria-pressed="false">
          {raw(CASE_SENSITIVE_ICON)}
        </button>
        <button type="button" className="terminal-search-btn terminal-search-toggle-btn" data-toggle="word" title="Whole word" aria-label="Whole word" aria-pressed="false">
          {raw(WHOLE_WORD_ICON)}
        </button>
        <button type="button" className="terminal-search-btn terminal-search-toggle-btn" data-toggle="regex" title="Regular expression" aria-label="Regular expression" aria-pressed="false">
          {raw(REGEX_ICON)}
        </button>
      </span>
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

  // HS-7426 — match-mode toggles. Per-mount (not shared across widgets) so
  // turning regex on for the drawer terminal does not bleed into a freshly
  // opened dedicated-view search. Reset on closeBox.
  const activeSearchOptions = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };

  // HS-7427 — recent-query history. `cursor` walks the per-xterm history
  // ring; `currentDraft` snapshots the in-flight query the moment the user
  // first navigates away from draft mode so ArrowDown back to the tail
  // restores it. Both reset on Enter / × close / typing into the input.
  const getHistory = (): string[] => historyByTerm.get(term) ?? [];
  let cursor = getHistory().length;
  let currentDraft = '';
  const resetHistoryNav = (): void => {
    cursor = getHistory().length;
    currentDraft = '';
  };

  // HS-7426 — apply / reset the toggle UI so the buttons reflect
  // `activeSearchOptions` after every flip. Caller updates the option flag,
  // then calls this to keep the DOM in sync.
  const syncToggleButtons = (): void => {
    for (const btn of root.querySelectorAll<HTMLButtonElement>('.terminal-search-toggle-btn')) {
      const key = btn.dataset.toggle as 'case' | 'word' | 'regex' | undefined;
      const active = key === 'case' ? activeSearchOptions.caseSensitive
        : key === 'word' ? activeSearchOptions.wholeWord
          : key === 'regex' ? activeSearchOptions.regex
            : false;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    }
  };
  const resetToggles = (): void => {
    activeSearchOptions.caseSensitive = false;
    activeSearchOptions.wholeWord = false;
    activeSearchOptions.regex = false;
    syncToggleButtons();
  };
  const setInvalidRegex = (invalid: boolean): void => {
    input.classList.toggle('is-invalid', invalid);
    if (invalid) count.textContent = 'err';
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
    resetHistoryNav();
    resetToggles();
    setInvalidRegex(false);
    try { term.focus(); } catch { /* term disposed */ }
  };
  const doFind = (direction: 'next' | 'prev', incremental: boolean): void => {
    const q = input.value;
    if (q.length === 0) {
      try { addon.clearDecorations(); } catch { /* addon disposed */ }
      count.textContent = '';
      setInvalidRegex(false);
      return;
    }
    // HS-7426 — when regex mode is on, validate the pattern up-front so we
    // can render the `.is-invalid` state and `err` count chip without
    // depending on whether xterm's SearchAddon throws or silently no-ops on
    // bad input. (Both behaviours have shipped across xterm versions.)
    if (activeSearchOptions.regex) {
      try {
        new RegExp(q);
      } catch {
        try { addon.clearDecorations(); } catch { /* addon disposed */ }
        setInvalidRegex(true);
        return;
      }
    }
    setInvalidRegex(false);
    const sOpts = {
      ...searchOptions,
      incremental,
      caseSensitive: activeSearchOptions.caseSensitive,
      wholeWord: activeSearchOptions.wholeWord,
      regex: activeSearchOptions.regex,
    };
    try {
      if (direction === 'next') addon.findNext(q, sOpts);
      else addon.findPrevious(q, sOpts);
    } catch {
      // SearchAddon threw — most likely on a regex it disagrees with even
      // though `new RegExp` accepted it (xterm uses its own parser for some
      // flag combinations). Surface the same `.is-invalid` state.
      if (activeSearchOptions.regex) setInvalidRegex(true);
    }
  };

  toggle.addEventListener('click', () => {
    if (root.classList.contains('is-open')) closeBox(); else openBox();
  });
  input.addEventListener('input', () => {
    // Free-form typing exits history-navigation mode so the next ArrowUp
    // captures the new draft.
    resetHistoryNav();
    doFind('next', true);
  });
  input.addEventListener('focus', () => { lastActiveHandle = handle; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const submitted = input.value;
      const next = pushHistory(getHistory(), submitted);
      historyByTerm.set(term, next);
      resetHistoryNav();
      doFind(e.shiftKey ? 'prev' : 'next', false);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const history = getHistory();
      if (history.length === 0) return;
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      // Edge-position rule (readline-compatible): only navigate when the
      // caret is at the edge in the requested direction, or the input is
      // empty, *while in draft mode*. Once we're walking history, every
      // press should keep walking even though the caret sits at the end of
      // the just-pulled value.
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      const atStart = start === 0 && end === 0;
      const atEnd = start === input.value.length && end === input.value.length;
      const isEmpty = input.value.length === 0;
      const inDraftMode = cursor >= history.length;
      if (inDraftMode && !isEmpty) {
        if (direction === 'up' && !atStart) return;
        if (direction === 'down' && !atEnd) return;
      }
      e.preventDefault();
      if (inDraftMode) {
        currentDraft = input.value;
      }
      const result = navigateHistory(history, cursor, direction, currentDraft);
      input.value = result.value;
      cursor = result.cursor;
      input.setSelectionRange(input.value.length, input.value.length);
      // Re-run the search incrementally so highlights track the displayed
      // value, mirroring the typing-into-the-input path.
      doFind('next', true);
      return;
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

  // HS-7426 — match-mode toggle clicks. Each button flips its corresponding
  // boolean and immediately re-runs the current query so highlights + count
  // refresh without the user having to re-press Enter.
  for (const btn of root.querySelectorAll<HTMLButtonElement>('.terminal-search-toggle-btn')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle as 'case' | 'word' | 'regex' | undefined;
      if (key === 'case') activeSearchOptions.caseSensitive = !activeSearchOptions.caseSensitive;
      else if (key === 'word') activeSearchOptions.wholeWord = !activeSearchOptions.wholeWord;
      else if (key === 'regex') activeSearchOptions.regex = !activeSearchOptions.regex;
      else return;
      syncToggleButtons();
      // Re-run as a fresh non-incremental search so the addon re-evaluates
      // matches from scratch with the new options. (Incremental find can
      // skip the re-evaluation when the query string itself is unchanged,
      // leaving stale highlights.)
      doFind('next', false);
      input.focus();
    });
  }

  // SearchAddon fires onDidChangeResults after every find — update the count
  // chip so the user can see "1/27" etc. Guarded with null-check because
  // older xterm builds or partial-stub tests might not have it. Also skips
  // the update when the input is in the invalid-regex state (HS-7426) so
  // the `err` chip doesn't get overwritten by a `0/0` from xterm.
  const changeSub = typeof addon.onDidChangeResults === 'function'
    ? addon.onDidChangeResults((r) => {
      if (input.classList.contains('is-invalid')) return;
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
 *  cases. The per-xterm history `WeakMap` is naturally per-test (each test
 *  creates a fresh xterm stub object that's never seen again), so it
 *  doesn't need explicit clearing here. Not intended for production
 *  callers. */
export function _resetTerminalSearchForTests(): void {
  lastActiveHandle = null;
}
