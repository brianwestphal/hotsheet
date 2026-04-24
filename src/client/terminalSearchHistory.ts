/**
 * Pure helpers for the terminal-search recent-query history (HS-7427,
 * docs/34-terminal-search.md §34.9). The mount-time integration (per-xterm
 * `WeakMap`, ArrowUp/Down keydown wiring, draft preservation) lives in
 * `terminalSearch.tsx`; this module owns the cursor / push semantics so they
 * can be unit-tested without a DOM.
 */

const DEFAULT_CAP = 10;

/**
 * Push `query` onto `history` with MRU-at-tail order. Any existing copy of
 * the same query is removed first so the cap-N window always contains N
 * distinct queries. Empty / whitespace-only queries are not recorded.
 * Returns a new array; the input is not mutated.
 */
export function pushHistory(history: readonly string[], query: string, cap: number = DEFAULT_CAP): string[] {
  if (query.trim() === '') return [...history];
  if (cap <= 0) return [];
  const filtered = history.filter((q) => q !== query);
  filtered.push(query);
  while (filtered.length > cap) filtered.shift();
  return filtered;
}

export type HistoryDirection = 'up' | 'down';

export interface NavigateResult {
  /** New value to display in the input. */
  readonly value: string;
  /** New cursor position in the [0, history.length] range. */
  readonly cursor: number;
}

/**
 * Walk the history with readline / browser-Find-bar semantics:
 *   - cursor === history.length → "draft mode", display `currentDraft`
 *   - cursor === history.length - 1 → most recent (MRU) entry
 *   - cursor === 0 → oldest entry
 *
 * `'up'` moves towards the oldest entry; `'down'` moves towards the draft.
 * Both stay in place when already at their respective boundary. Empty
 * history is a no-op (returns the draft and a clamped 0 cursor).
 *
 * The caller is responsible for capturing `currentDraft` *before* the first
 * navigation away from draft mode — `navigateHistory` only reads it.
 */
export function navigateHistory(
  history: readonly string[],
  cursor: number,
  direction: HistoryDirection,
  currentDraft: string,
): NavigateResult {
  if (history.length === 0) {
    return { value: currentDraft, cursor: 0 };
  }
  let c = Math.max(0, Math.min(history.length, cursor));
  if (direction === 'up') {
    if (c > 0) c -= 1;
  } else {
    if (c < history.length) c += 1;
  }
  const value = c === history.length ? currentDraft : history[c];
  return { value, cursor: c };
}
