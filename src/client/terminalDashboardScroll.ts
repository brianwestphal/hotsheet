/**
 * HS-9627 — best-effort save/restore of the terminal dashboard's scroll
 * position across a switch-away / switch-back.
 *
 * The dashboard scroll container (`#terminal-dashboard-root`, the
 * `.terminal-dashboard` element with `overflow-y: auto`) is fully torn down on
 * `exitDashboard` (`replaceChildren()` + `display:none`) and rebuilt on
 * re-enter, so its `scrollTop` naturally resets to 0. We remember the last
 * scroll offset when leaving and reapply it after the next paint.
 *
 * "Best effort" is deliberate: between leaving and returning the terminal
 * count can shrink (fewer tiles → less content) or the viewport can change
 * (window resized). We never overscroll — the remembered offset is clamped to
 * the currently-scrollable range, so a shorter grid lands at its new bottom
 * rather than snapping past it.
 */

/**
 * Clamp a remembered `scrollTop` to the range the (possibly changed) content
 * can actually scroll to.
 *
 * - Non-finite or non-positive remembered values collapse to `0` (top).
 * - Content that no longer overflows (`scrollHeight <= clientHeight`) clamps
 *   to `0`.
 * - A remembered offset past the new bottom clamps to the max scroll offset
 *   (`scrollHeight - clientHeight`).
 */
export function clampScrollTop(saved: number, scrollHeight: number, clientHeight: number): number {
  if (!Number.isFinite(saved) || saved <= 0) return 0;
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  return Math.min(saved, maxScroll);
}

/**
 * Reapply a remembered scroll offset to `el`, clamped to what the current
 * content allows. A `null` remembered value (nothing captured yet) is a no-op.
 * Returns the offset actually applied (the element's current `scrollTop` when
 * skipped), which the tests assert against.
 */
export function restoreScrollTop(el: HTMLElement, saved: number | null): number {
  if (saved === null) return el.scrollTop;
  const target = clampScrollTop(saved, el.scrollHeight, el.clientHeight);
  el.scrollTop = target;
  return target;
}
